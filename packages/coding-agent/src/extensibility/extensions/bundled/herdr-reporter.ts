import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import type { ExtensionAPI, ExtensionContext, UserPromptKind } from "@f5-sales-demo/xcsh";
import { HerdrClient } from "../../../herdr/client";
import { finalAnswerText } from "../../../session/final-answer";

/**
 * herdr integration (bundled, default-on).
 *
 * Reports xcsh's live agent state to the herdr terminal multiplexer so an xcsh
 * pane shows up as a first-class "xcsh" assistant with an idle / working /
 * blocked indicator.
 *
 * Transport: herdr injects `HERDR_SOCKET_PATH` into every pane, so state is
 * reported over Herdr's supported JSONL socket protocol via the shared `HerdrClient`
 * (see `../../../herdr/client`) — the same client `herdr-terminal` uses. Each
 * request reconnects independently, validates the `ping` protocol version
 * before the first real request, and awaits herdr's typed response before
 * resolving. This is PATH-independent — unlike shelling out to the `herdr`
 * CLI, which silently no-ops when herdr runs as a launchd/`brew services`
 * server and spawns panes without `/opt/homebrew/bin` on PATH. If
 * `HERDR_SOCKET_PATH` is somehow unset, we fall back to the `herdr` CLI.
 *
 * xcsh is a fork of pi; a user may have both installed, so this reporter always
 * identifies the agent as "xcsh" (never "pi"). It claims pane authority via the
 * `source: "herdr:xcsh"` convention that herdr uses for first-class lifecycle
 * authorities, which also lets herdr resume the pane after a server restart.
 *
 * Session identity: on session start (and each agent turn) the reporter sends a
 * `pane.report_agent_session` frame carrying the absolute session file path (or
 * the session id when the session is not persisted). herdr stores that reference
 * and, on restore, resumes the pane with `xcsh --resume=<session>`.
 *
 * The extension is completely inert unless it is running inside a herdr pane
 * (detected via `HERDR_PANE_ID`), so it has zero effect for users who do not run
 * xcsh under herdr.
 *
 * Sequencing contract with herdr — do not regress. herdr keeps one monotonic
 * `seq` per *source*, shared across every method, and silently discards any frame
 * whose `seq` is not greater than the last it accepted for `herdr:xcsh`. Two
 * consequences drive the design below, and both previously cost panes their
 * resume reference:
 *
 *   1. `seq` is seeded from the wall clock, not 0, so a restarted xcsh always
 *      outranks its predecessor in the same pane. With a per-process counter from
 *      0, every frame from the second xcsh in a pane looks stale and is dropped.
 *   2. Frames go out one at a time through `enqueue`, awaiting herdr's response
 *      before the next frame is sent, so ordering is never left to chance.
 *   3. The state frame is always sent *before* the session frame. herdr discards a
 *      `pane.report_agent_session` for a pane whose agent it does not yet own, so
 *      the state frame has to establish `herdr:xcsh` as the pane's agent first.
 *      Verified against a live herdr: session-then-state (even with a correctly
 *      ascending `seq`) leaves `agent_session` null, while state-then-session
 *      records it.
 */

const HERDR_AGENT_LABEL = "xcsh";
// herdr keys its official lifecycle-authority and session-resume plumbing on the
// `herdr:<agent>` source convention, so report as "herdr:xcsh" (not bare "xcsh").
const HERDR_SOURCE = "herdr:xcsh";
const PHASE_SOURCE = "xcsh:phase";
const REPORT_METHOD = "pane.report_agent";
const METADATA_METHOD = "pane.report_metadata";
const SESSION_METHOD = "pane.report_agent_session";
const HEARTBEAT_METHOD = "pane.report_agent_heartbeat";
const RELEASE_METHOD = "pane.release_agent";
const TURN_REPORT_METHOD = "agent.turn.report";
const SOCKET_TIMEOUT_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PHASE_LABEL_TTL_MS = 60_000;
const RESULT_MAX_CHARS = 80;
const SEMANTIC_RESULT_MAX_BYTES = 8_000;
const TURN_ENTRY_TYPE = "herdr.semantic-turn";
const EXECUTION_GENERATION_ENV = "HERDR_EXECUTION_GENERATION";
const SETTLED_TURN_RECONCILE_DELAY_MS = 25;
const PROMPT_BLOCKED_REASONS = {
	select: "selection required",
	confirm: "confirmation required",
	input: "text input required",
} satisfies Record<UserPromptKind, string>;

function getPromptBlockedReason(kind: unknown): string {
	if (typeof kind === "string" && Object.hasOwn(PROMPT_BLOCKED_REASONS, kind)) {
		return PROMPT_BLOCKED_REASONS[kind as UserPromptKind];
	}
	return "user input required";
}

function boundedResult(message: AssistantMessage | undefined): string | undefined {
	if (message?.stopReason !== "stop") return undefined;
	const result = finalAnswerText(message).replaceAll(/\s+/g, " ").trim().slice(0, RESULT_MAX_CHARS).trim();
	return result || undefined;
}

function boundedSemanticResult(message: AssistantMessage | undefined): string {
	if (message?.stopReason !== "stop") return "";
	let result = finalAnswerText(message).trim();
	while (Buffer.byteLength(result) > SEMANTIC_RESULT_MAX_BYTES) result = result.slice(0, -1);
	return result;
}

interface PersistedTurn {
	executionId: string;
	paneId: string;
	sessionId: string;
	turnId: string;
	generation: number;
	eventRevision?: number;
	state?: "starting" | "working" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted";
	result?: string;
	reason?: string;
	resultDigest?: string;
	delivered?: boolean;
}

/**
 * A journal event is authenticated to one execution generation. The execution
 * backend, rather than the reporter, owns that value: guessing a generation
 * would let an old process write into a continuation's journal. Keep ordinary
 * pane reporting available when it is absent, but do not start semantic
 * tracking until the backend has supplied a safe integer generation.
 */
function executionGeneration(): number | undefined {
	const raw = process.env[EXECUTION_GENERATION_ENV];
	if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return undefined;
	const generation = Number(raw);
	return Number.isSafeInteger(generation) ? generation : undefined;
}

function executionBinding(paneId: string): { executionId: string; paneId: string; generation: number } | undefined {
	const executionId = process.env.HERDR_EXECUTION_ID;
	const generation = executionGeneration();
	if (!executionId || generation === undefined) return undefined;
	return { executionId, paneId, generation };
}

function persistedTurns(ctx: ExtensionContext): PersistedTurn[] {
	try {
		const entries = ctx.sessionManager?.getEntries?.() as unknown[] | undefined;
		return (entries ?? []).flatMap(entry => {
			if (typeof entry !== "object" || entry === null) return [];
			const record = entry as Record<string, unknown>;
			if (record.type !== "custom" || record.customType !== TURN_ENTRY_TYPE) return [];
			if (typeof record.data !== "object" || record.data === null) return [];
			const turn = record.data as Record<string, unknown>;
			if (
				typeof turn.executionId !== "string" ||
				typeof turn.paneId !== "string" ||
				typeof turn.sessionId !== "string" ||
				typeof turn.turnId !== "string" ||
				!Number.isSafeInteger(turn.generation) ||
				(turn.generation as number) < 0
			)
				return [];
			return [
				{
					executionId: turn.executionId,
					paneId: turn.paneId,
					sessionId: turn.sessionId,
					turnId: turn.turnId,
					generation: turn.generation as number,
					eventRevision: typeof turn.eventRevision === "number" ? turn.eventRevision : undefined,
					state: typeof turn.state === "string" ? (turn.state as PersistedTurn["state"]) : undefined,
					result: typeof turn.result === "string" ? turn.result : undefined,
					reason: typeof turn.reason === "string" ? turn.reason : undefined,
					resultDigest: typeof turn.resultDigest === "string" ? turn.resultDigest : undefined,
					delivered: turn.delivered === true,
				},
			];
		});
	} catch {
		return [];
	}
}

// Reused across calls for the life of the extension so `ensureProtocol()`'s
// `ping` validation happens at most once per socket path, not once per frame.
let cachedClient: HerdrClient | undefined;

function getHerdrClient(socketPath: string): HerdrClient {
	if (!cachedClient || cachedClient.socketPath !== socketPath) {
		cachedClient = new HerdrClient(socketPath, SOCKET_TIMEOUT_MS);
	}
	return cachedClient;
}

/**
 * Send one JSON-RPC request to Herdr over its negotiated socket and await the
 * typed response. Every failure path (transport error, timeout, protocol
 * mismatch) is reported via `onError` without throwing, so a dead or
 * incompatible herdr never disturbs the agent.
 *
 * Resolves once herdr has responded (or the attempt failed or timed out),
 * which is what lets callers order frames relative to one another.
 */
async function sendToHerdrSocket(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	onError: (err: unknown) => void,
): Promise<void> {
	try {
		await getHerdrClient(socketPath).request<Record<string, unknown>>(method, params);
	} catch (err) {
		onError(err);
	}
}

/** Translate a JSON-RPC report/release into `herdr` CLI arguments (fallback). */
function toCliArgs(method: string, params: Record<string, unknown>): string[] {
	const subcommand = method === REPORT_METHOD ? "report-agent" : "release-agent";
	const args = [
		"pane",
		subcommand,
		String(params.pane_id),
		"--source",
		String(params.source),
		"--agent",
		String(params.agent),
	];
	if (params.state !== undefined) {
		args.push("--state", String(params.state));
	}
	if (params.message !== undefined) {
		args.push("--message", String(params.message));
	}
	args.push("--seq", String(params.seq));
	return args;
}

export default function herdrReporter(pi: ExtensionAPI): void {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) {
		// Not running under herdr — do not register anything.
		return;
	}

	// Seeded from the wall clock at microsecond scale rather than 0 so a new xcsh
	// process in a pane always starts above whatever the previous process reached.
	// Matches the pi/omp reporters and stays well inside Number.MAX_SAFE_INTEGER.
	let seq = Date.now() * 1000;
	// Separate monotonic sequence for metadata frames (keyed by source in Herdr).
	let phaseSeq = Date.now() * 1000;
	// Retains the fixed reason while an interactive prompt awaits the user, so an
	// agent_end duplicate cannot erase herdr's stored blocked message.
	let promptBlockedReason: string | undefined;
	// Once the normalized contract is observed it is authoritative. The legacy
	// event mappings remain only for older hosts that load this bundled extension.
	let normalizedPhasesObserved = false;
	let currentTurnId = 0;
	let lastNormalizedEventKey: string | undefined;
	let pendingSuccessfulResult: string | undefined;
	let pendingSemanticResult = "";
	let activeSemanticTurn: PersistedTurn | undefined;
	let semanticRevision = 0;
	// Last session ref already delivered, so repeated lifecycle events do not
	// re-send an unchanged ref every turn.
	let lastSessionRefKey: string | undefined;
	// Herdr only anchors a new full-lifecycle authority after the first session
	// reference identifies how the session began. XCSH creates that reference
	// lazily, so retain the startup marker until there is a concrete ref to send.
	let pendingSessionStartSource: "startup" | "new" | "resume" | "fork" | undefined = "startup";
	// `agent_end` is the primary completion signal. Keep one deferred check from
	// `turn_end` as well: some interactive UI paths render the completed response
	// before their agent-end extension callback has drained. The check consults
	// XCSH's own streaming state, so a tool boundary cannot be mistaken for idle.
	let settledTurnReconcileTimer: ReturnType<typeof setTimeout> | undefined;
	// Heartbeats are session-scoped liveness signals. They have no lifecycle state
	// or metadata payload, so Herdr can refresh the authoritative reporter without
	// changing the pane's lifecycle state, state_change_seq, phase labels, or
	// session anchor.
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatActive = false;
	// Serializes frames: herdr compares `seq` across all methods for this source,
	// so frames must reach it in the order they were generated.
	let queue: Promise<void> = Promise.resolve();
	let latestContext: ExtensionContext | undefined;
	let trackingWarningShown = false;

	pi.setLabel(HERDR_AGENT_LABEL);

	const onError = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		pi.logger.debug("herdr report failed", {
			error: message,
		});
		const ui = (latestContext as { ui?: ExtensionContext["ui"] } | undefined)?.ui;
		ui?.setStatus("herdr-tracking", "Herdr tracking degraded");
		if (!trackingWarningShown) {
			trackingWarningShown = true;
			ui?.notify(`Herdr semantic tracking is degraded: ${message}`, "warning");
		}
	};

	/** Chain a frame onto the tail of the send queue. Never rejects. */
	const enqueue = (task: () => Promise<void>): Promise<void> => {
		queue = queue.then(task, task).catch(onError);
		return queue;
	};

	const send = (method: string, params: Record<string, unknown>): Promise<void> => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (socketPath) {
			return enqueue(() => sendToHerdrSocket(socketPath, method, params, onError));
		}
		// Fallback for the rare case herdr did not inject a socket path.
		return enqueue(() =>
			pi
				.exec("herdr", toCliArgs(method, params))
				.then(() => undefined)
				.catch(onError),
		);
	};

	const reportSemanticTurn = (
		state: "starting" | "working" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted",
		options: { result?: string; reason?: string } = {},
	): Promise<void> => {
		if (!executionBinding(paneId) || !activeSemanticTurn) return Promise.resolve();
		const revision = ++semanticRevision;
		const event: PersistedTurn = {
			...activeSemanticTurn,
			eventRevision: revision,
			state,
			...(options.result === undefined
				? {}
				: { result: options.result, resultDigest: createHash("sha256").update(options.result).digest("hex") }),
			...(options.reason === undefined ? {} : { reason: options.reason }),
		};
		pi.appendEntry(TURN_ENTRY_TYPE, { ...event, delivered: false });
		return deliverSemanticEvent(event);
	};

	const deliverSemanticEvent = (event: PersistedTurn): Promise<void> => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		const binding = executionBinding(paneId);
		if (
			!socketPath ||
			!binding ||
			event.executionId !== binding.executionId ||
			event.paneId !== binding.paneId ||
			event.generation !== binding.generation ||
			event.eventRevision === undefined ||
			event.state === undefined
		) {
			return Promise.resolve();
		}
		const frame = {
			execution_id: event.executionId,
			pane_id: event.paneId,
			producer: HERDR_AGENT_LABEL,
			session_id: event.sessionId,
			turn_id: event.turnId,
			generation: event.generation,
			event_revision: event.eventRevision,
			state: event.state,
			...(event.result === undefined ? {} : { result: event.result, result_digest: event.resultDigest }),
			...(event.reason === undefined ? {} : { reason: event.reason }),
		};
		return enqueue(async () => {
			const client = getHerdrClient(socketPath);
			try {
				await client.ensureProtocol();
				if (!client.hasCapability("agent_turn_journal")) {
					onError(new Error("Herdr does not advertise agent_turn_journal; semantic tracking is degraded"));
					return;
				}
				await client.request<Record<string, unknown>>(TURN_REPORT_METHOD, frame);
				pi.appendEntry(TURN_ENTRY_TYPE, { ...event, delivered: true });
				(latestContext as { ui?: ExtensionContext["ui"] } | undefined)?.ui?.setStatus("herdr-tracking", undefined);
			} catch (err) {
				onError(err);
			}
		});
	};

	const beginSemanticTurn = async (ctx: ExtensionContext): Promise<void> => {
		const binding = executionBinding(paneId);
		if (!binding) return;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId !== "string" || !sessionId) return;
		activeSemanticTurn = { ...binding, sessionId, turnId: randomUUID() };
		semanticRevision = 0;
		pendingSemanticResult = "";
		pi.appendEntry(TURN_ENTRY_TYPE, { ...activeSemanticTurn, eventRevision: 0 });
		await reportSemanticTurn("starting");
	};

	const finishSemanticTurn = async (
		state: "completed" | "failed" | "cancelled" | "interrupted",
		options: { result?: string; reason?: string } = {},
	): Promise<void> => {
		if (!activeSemanticTurn) return;
		await reportSemanticTurn(state, options);
		activeSemanticTurn = undefined;
	};

	const report = (state: "idle" | "working" | "blocked", message?: string): Promise<void> =>
		send(REPORT_METHOD, {
			pane_id: paneId,
			source: HERDR_SOURCE,
			agent: HERDR_AGENT_LABEL,
			state,
			...(message === undefined ? {} : { message }),
			seq: seq++,
		});

	// Heartbeat is deliberately socket-only. Older Herdr CLIs do not expose this
	// new typed frame, while an unavailable socket remains nonfatal just like the
	// lifecycle socket reports above.
	const reportHeartbeat = (): Promise<void> => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (!socketPath) return Promise.resolve();
		// Allocate before enqueueing: another lifecycle callback can run before this
		// task reaches the queue head, but must still receive a later sequence.
		const frame = {
			pane_id: paneId,
			source: HERDR_SOURCE,
			agent: HERDR_AGENT_LABEL,
			seq: seq++,
		};
		return enqueue(() => sendToHerdrSocket(socketPath, HEARTBEAT_METHOD, frame, onError));
	};

	const startHeartbeat = (): void => {
		if (heartbeatActive) return;
		heartbeatActive = true;
		heartbeatTimer = setInterval(() => {
			// A callback already queued when shutdown starts must not report after
			// the release frame has relinquished this authority.
			if (heartbeatActive) void reportHeartbeat();
		}, HEARTBEAT_INTERVAL_MS);
		// Do not keep an otherwise completed process alive if its host skips an
		// orderly session_shutdown callback.
		(heartbeatTimer as { unref?: () => void }).unref?.();
	};

	const stopHeartbeat = (): void => {
		heartbeatActive = false;
		if (heartbeatTimer !== undefined) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	};

	const reportMetadata = (params: Record<string, unknown>): Promise<void> => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (!socketPath) {
			return Promise.resolve();
		}
		const frame = {
			pane_id: paneId,
			source: PHASE_SOURCE,
			applies_to_source: HERDR_SOURCE,
			seq: phaseSeq++,
			...params,
		};
		return enqueue(() => sendToHerdrSocket(socketPath, METADATA_METHOD, frame, onError));
	};

	const setPhaseLabel = (label: string, state: "idle" | "working" | "blocked" = "working"): Promise<void> =>
		reportMetadata({
			state_labels: { [state]: label },
			ttl_ms: PHASE_LABEL_TTL_MS,
		});

	const clearPhaseLabel = (): Promise<void> =>
		reportMetadata({
			clear_state_labels: true,
		});

	// Report the current session's identity so herdr can resume this pane
	// (`xcsh --resume=<session>`) after a server restart. This is sent only over
	// the socket; if herdr did not inject a socket path we skip it (state still
	// reports via the CLI fallback). Prefer the absolute session file path, which
	// herdr resumes directly; fall back to the session id for non-persisted
	// sessions (e.g. print/RPC mode, where getSessionFile() is undefined).
	//
	// Called from every lifecycle handler because xcsh creates the session file
	// lazily: getSessionFile() can still be undefined at session_start and even at
	// agent_start, and a ref missed there would otherwise be lost until the next
	// turn — long enough for a restart to lose the pane. Unchanged refs are
	// suppressed, so the extra call sites cost nothing on the wire.
	const reportSession = (ctx: ExtensionContext, sessionStartSource?: "new" | "resume" | "fork"): Promise<void> => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (!socketPath) {
			return Promise.resolve();
		}
		if (sessionStartSource !== undefined) pendingSessionStartSource = sessionStartSource;
		let sessionRef: Record<string, unknown> | undefined;
		try {
			const file = ctx.sessionManager?.getSessionFile?.();
			if (typeof file === "string" && path.isAbsolute(file)) {
				sessionRef = { agent_session_path: file };
			} else {
				const id = ctx.sessionManager?.getSessionId?.();
				if (typeof id === "string" && id.length > 0) {
					sessionRef = { agent_session_id: id };
				}
			}
		} catch (err) {
			onError(err);
			return Promise.resolve();
		}
		if (!sessionRef) {
			return Promise.resolve();
		}
		const refKey = JSON.stringify(sessionRef);
		if (refKey === lastSessionRefKey && sessionStartSource === undefined) {
			return Promise.resolve();
		}
		lastSessionRefKey = refKey;
		const frame = {
			pane_id: paneId,
			source: HERDR_SOURCE,
			agent: HERDR_AGENT_LABEL,
			seq: seq++,
			...(pendingSessionStartSource === undefined ? {} : { session_start_source: pendingSessionStartSource }),
			...sessionRef,
		};
		pendingSessionStartSource = undefined;
		return enqueue(() => sendToHerdrSocket(socketPath, SESSION_METHOD, frame, onError));
	};

	const clearSettledTurnReconcile = (): void => {
		if (settledTurnReconcileTimer !== undefined) {
			clearTimeout(settledTurnReconcileTimer);
			settledTurnReconcileTimer = undefined;
		}
	};

	const scheduleSettledTurnReconcile = (ctx: ExtensionContext): void => {
		if (settledTurnReconcileTimer !== undefined) return;
		settledTurnReconcileTimer = setTimeout(() => {
			settledTurnReconcileTimer = undefined;
			if (promptBlockedReason || !ctx.isIdle()) return;
			void report("idle").then(() => reportSession(ctx));
		}, SETTLED_TURN_RECONCILE_DELAY_MS);
	};

	// Announce presence and session identity as soon as the session is initialized.
	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		startHeartbeat();
		await report("idle");
		await reportSession(ctx);
		// An argv prompt can enter before_agent_start while the asynchronous
		// session_start extension callback is still draining.  In that case the
		// reporter has already appended this process's revision-0/starting entries;
		// treating those in-memory entries as restart residue would immediately
		// interrupt the live turn.  Startup replay is only for a process that has
		// not begun a semantic turn of its own.
		if (activeSemanticTurn) return;
		const persisted = persistedTurns(ctx);
		const byRevision = new Map<string, PersistedTurn>();
		for (const event of persisted) {
			if (event.eventRevision !== undefined && event.state !== undefined) {
				byRevision.set(`${event.sessionId}:${event.turnId}:${event.generation}:${event.eventRevision}`, event);
			}
		}
		const binding = executionBinding(paneId);
		if (!binding) return;
		const events = [...byRevision.values()].filter(event => {
			if (
				event.executionId === binding.executionId &&
				event.paneId === binding.paneId &&
				event.generation === binding.generation
			)
				return true;
			onError(new Error("Persisted Herdr turn binding does not match this execution"));
			return false;
		});
		for (const event of events.filter(event => !event.delivered)) await deliverSemanticEvent(event);
		const last = events.at(-1);
		const terminal = last && ["completed", "failed", "cancelled", "interrupted"].includes(last.state ?? "");
		if (last && !terminal) {
			activeSemanticTurn = last;
			semanticRevision = last.eventRevision ?? 0;
			await finishSemanticTurn("interrupted", { reason: "XCSH restarted before semantic settlement" });
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		latestContext = ctx;
		if (!activeSemanticTurn) await beginSemanticTurn(ctx);
	});

	pi.on("session_before_switch", async () => {
		await finishSemanticTurn("interrupted", { reason: "XCSH switched sessions before semantic settlement" });
	});

	pi.on("session_before_branch", async () => {
		await finishSemanticTurn("interrupted", { reason: "XCSH forked before semantic settlement" });
	});

	pi.on("session_switch", async (event, ctx) => {
		latestContext = ctx;
		currentTurnId = 0;
		lastNormalizedEventKey = undefined;
		await reportSession(ctx, event.reason);
	});

	pi.on("session_branch", async (_event, ctx) => {
		latestContext = ctx;
		currentTurnId = 0;
		lastNormalizedEventKey = undefined;
		await reportSession(ctx, "fork");
	});

	// Busy while the agent loop is streaming a response. Re-report session identity
	// in case the active session file changed (e.g. after /new, /resume, or /fork).
	pi.on("agent_start", async (_event, ctx) => {
		clearSettledTurnReconcile();
		if (!normalizedPhasesObserved) await report("working");
		await reportSession(ctx);
	});

	// Back to idle when the loop ends — unless we are waiting on a user prompt.
	// This is also the first point where a lazily-created session file is certain
	// to exist, so it is the backstop for capturing the resume ref.
	pi.on("agent_end", async (_event, ctx) => {
		const messages = _event.messages;
		const lastAssistant = [...messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		pendingSuccessfulResult = boundedResult(lastAssistant);
		pendingSemanticResult = boundedSemanticResult(lastAssistant);
		if (!normalizedPhasesObserved) await report(promptBlockedReason ? "blocked" : "idle", promptBlockedReason);
		await reportSession(ctx);
	});

	// Reconcile completion after the UI has had a chance to clear its streaming
	// flag. This is deliberately non-blocking so it cannot delay the next turn.
	pi.on("turn_end", (_event, ctx) => {
		if (!normalizedPhasesObserved) scheduleSettledTurnReconcile(ctx);
	});

	// An interactive prompt (permission gate, ask tool, confirm/input) is
	// awaiting the user: that is herdr's "needs attention" (blocked) state.
	pi.on("user_prompt_start", async event => {
		promptBlockedReason = getPromptBlockedReason(event.kind);
		if (!normalizedPhasesObserved) {
			void report("blocked", promptBlockedReason);
			await clearPhaseLabel();
		}
	});

	pi.on("user_prompt_end", async (_event, ctx) => {
		promptBlockedReason = undefined;
		if (!normalizedPhasesObserved) await report(ctx.isIdle() ? "idle" : "working");
		await reportSession(ctx);
		if (!normalizedPhasesObserved && !ctx.isIdle()) {
			await setPhaseLabel("tool");
		}
	});

	pi.on("turn_phase", async (event, ctx) => {
		normalizedPhasesObserved = true;
		if (event.turnId < currentTurnId) return;
		const eventKey = `${event.turnId}:${event.phase}`;
		if (eventKey === lastNormalizedEventKey) return;
		if (event.turnId > currentTurnId) {
			currentTurnId = event.turnId;
			pendingSuccessfulResult = undefined;
		}
		lastNormalizedEventKey = eventKey;
		const state =
			event.phase === "awaiting_user"
				? "blocked"
				: event.phase === "submitting" || event.phase === "thinking" || event.phase === "tool_call"
					? "working"
					: "idle";
		await report(state, event.phase === "awaiting_user" ? "user input required" : undefined);
		const turnStatus =
			event.phase === "idle"
				? "completed"
				: event.phase === "error"
					? "failed"
					: event.phase === "cancelled"
						? "cancelled"
						: event.phase === "awaiting_user"
							? "waiting_input"
							: "working";
		await reportMetadata({
			state_labels: { [state]: event.phase },
			tokens: {
				xcsh_turn_id: String(event.turnId),
				xcsh_turn_status: turnStatus,
				xcsh_result: event.phase === "idle" ? (pendingSuccessfulResult ?? null) : null,
			},
			ttl_ms: PHASE_LABEL_TTL_MS,
		});
		if (event.phase === "idle") {
			await finishSemanticTurn("completed", { result: pendingSemanticResult });
		} else if (event.phase === "error") {
			await finishSemanticTurn("failed", { reason: "XCSH turn failed" });
		} else if (event.phase === "cancelled") {
			await finishSemanticTurn("cancelled", { reason: "XCSH turn cancelled" });
		} else if (event.phase === "awaiting_user") {
			await reportSemanticTurn("waiting_input", { reason: "user input required" });
		} else {
			await reportSemanticTurn("working");
		}
		if (event.phase === "idle" || event.phase === "error" || event.phase === "cancelled") {
			pendingSuccessfulResult = undefined;
		}
		await reportSession(ctx);
	});

	// Transient phase-label metadata (thinking / tool / retry / cleanup):
	pi.on("message_update", async event => {
		if (normalizedPhasesObserved) return;
		if (event.assistantMessageEvent.type === "thinking_start") {
			await setPhaseLabel("thinking");
		} else if (event.assistantMessageEvent.type === "thinking_end") {
			await clearPhaseLabel();
		}
	});

	pi.on("tool_execution_start", async () => {
		if (normalizedPhasesObserved) return;
		await setPhaseLabel("tool");
	});

	pi.on("tool_execution_end", async () => {
		if (normalizedPhasesObserved) return;
		await clearPhaseLabel();
	});

	pi.on("auto_retry_start", async () => {
		if (normalizedPhasesObserved) return;
		await setPhaseLabel("retry");
	});

	pi.on("auto_retry_end", async () => {
		if (normalizedPhasesObserved) return;
		await clearPhaseLabel();
	});

	pi.on("auto_compaction_start", async () => {
		if (normalizedPhasesObserved) return;
		await setPhaseLabel("cleanup");
	});

	pi.on("auto_compaction_end", async () => {
		if (normalizedPhasesObserved) return;
		await clearPhaseLabel();
	});

	// Relinquish pane authority so herdr stops showing xcsh once we exit.
	pi.on("session_shutdown", async () => {
		stopHeartbeat();
		await finishSemanticTurn("interrupted", { reason: "XCSH shut down before semantic settlement" });
		await send(RELEASE_METHOD, {
			pane_id: paneId,
			source: HERDR_SOURCE,
			agent: HERDR_AGENT_LABEL,
			seq: seq++,
		});
	});
}
