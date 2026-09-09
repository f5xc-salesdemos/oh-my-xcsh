import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { type PtyRunResult, PtySession, sanitizeText } from "@f5-sales-demo/pi-natives";
import { buildXcshCommand } from "../commands/herdr";
import { NATIVE_LIFECYCLE_CONTROL_FLAG } from "../extensibility/extensions/bundled/native-lifecycle-control";
import {
	NATIVE_LIFECYCLE_DRIVER_VERSION,
	NATIVE_LIFECYCLE_SCENARIOS,
	type NativeLifecycleScenario,
	nativeLifecycleChildArgv,
} from "./native-acceptance";

export type { NativeLifecycleScenario };
export { NATIVE_LIFECYCLE_SCENARIOS };

interface TurnAttempt {
	ordinal: number;
	params: Record<string, unknown>;
	replyLost: boolean;
}

interface ActionAttempt {
	ordinal: number;
	method: "agent.turn.action.get" | "agent.turn.action.ack";
	params: Record<string, unknown>;
}

interface ReporterTransport {
	socketPath: string;
	attempts: TurnAttempt[];
	actionAttempts: ActionAttempt[];
	requests: string[];
	requestCancel: () => void;
	waitFor: (predicate: (attempt: TurnAttempt) => boolean, afterOrdinal?: number) => Promise<TurnAttempt>;
	close: () => Promise<void>;
}

interface RunningChild {
	pty: PtySession;
	finished: Promise<PtyRunResult>;
	outputTail: () => string;
}

export interface NativeLifecycleDriverOptions {
	scenario: NativeLifecycleScenario;
	model: string;
	sessionDir: string;
	timeoutMs?: number;
	continuation?: string;
	fixturePath?: string;
	fixtureValue?: string;
}

export interface NativeLifecycleReceipt {
	version: number;
	scenario: NativeLifecycleScenario;
	status: "passed";
	evidenceClass: "source_native_child";
	fixture: { path: string; value: string };
	session: { id: string; path: string; headerSha256: string };
	childRuns: Array<{ exitCode?: number; cancelled: boolean; timedOut: boolean }>;
	turnAttempts: TurnAttempt[];
	actionAttempts: ActionAttempt[];
	control: Record<string, unknown>;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameTurnFrame(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function redactNativeLifecycleRequest(params: Record<string, unknown>): Record<string, unknown> {
	const { native_capability: _nativeCapability, ...safe } = params;
	return safe;
}

export function currentXcshCommand(args: string[], argv = process.argv, execPath = process.execPath): string {
	const script = argv[1];
	const executable = path.basename(execPath).toLowerCase();
	const prefix =
		executable.startsWith("bun") && script && /\.(?:ts|js|mjs)$/u.test(script) ? [path.resolve(script)] : [];
	return buildXcshCommand(execPath, [...prefix, ...args]);
}

async function startReporterTransport(
	directory: string,
	options: { loseFirstTurnReply: boolean; managedCancel: boolean },
): Promise<ReporterTransport> {
	const socketPath = path.join(directory, `.native-lifecycle-${randomUUID()}.sock`);
	const attempts: TurnAttempt[] = [];
	const requests: string[] = [];
	const actionAttempts: ActionAttempt[] = [];
	const sockets = new Set<net.Socket>();
	const waiters = new Set<{
		predicate: (attempt: TurnAttempt) => boolean;
		afterOrdinal: number;
		resolve: (attempt: TurnAttempt) => void;
		reject: (error: Error) => void;
	}>();
	let handshakeComplete = false;
	let lostReply = false;
	let cancellationRequested = false;
	let cancellationAcknowledged = false;
	let registeredTurnId: string | undefined;
	const cancelAction = () => ({
		backend_execution_id: "native-lifecycle-backend",
		action_id: "cancel",
		action_revision: 1,
		state: cancellationAcknowledged ? "safe_point" : "requested",
		requested_at_unix_ms: 1,
		...(cancellationAcknowledged ? { acknowledged_at_unix_ms: 2, turn_id: registeredTurnId } : {}),
	});

	const publish = (attempt: TurnAttempt): void => {
		for (const waiter of waiters) {
			if (attempt.ordinal <= waiter.afterOrdinal || !waiter.predicate(attempt)) continue;
			waiters.delete(waiter);
			waiter.resolve(attempt);
		}
	};

	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				const request = JSON.parse(line) as { id: string; method: string; params?: unknown };
				requests.push(request.method);
				if (request.method === "ping") {
					handshakeComplete = true;
					socket.end(
						`${JSON.stringify({ id: request.id, result: { type: "pong", protocol: options.managedCancel ? 22 : 20, version: "native-lifecycle", capabilities: { agent_turn_journal: true } } })}\n`,
					);
					continue;
				}
				if (!handshakeComplete) {
					socket.end(
						`${JSON.stringify({ id: request.id, error: { code: "handshake_required", message: "ping required" } })}\n`,
					);
					continue;
				}
				if (request.method === "agent.turn.report" && isRecord(request.params)) {
					if (request.params.state === "starting" && typeof request.params.turn_id === "string") {
						registeredTurnId = request.params.turn_id;
					}
					const replyLost = options.loseFirstTurnReply && !lostReply;
					lostReply ||= replyLost;
					const attempt = { ordinal: attempts.length + 1, params: request.params, replyLost };
					attempts.push(attempt);
					publish(attempt);
					if (replyLost) {
						socket.destroy();
						continue;
					}
					if (options.managedCancel) {
						socket.end(
							`${JSON.stringify({ id: request.id, result: { type: "agent_turn", turn: {}, admitted: true } })}\n`,
						);
						continue;
					}
				}
				if (options.managedCancel && request.method === "agent.turn.action.get" && isRecord(request.params)) {
					actionAttempts.push({
						ordinal: actionAttempts.length + 1,
						method: request.method,
						params: request.params,
					});
					socket.end(
						`${JSON.stringify({ id: request.id, result: { type: "agent_turn_action_list", actions: cancellationRequested ? [cancelAction()] : [] } })}\n`,
					);
					continue;
				}
				if (options.managedCancel && request.method === "agent.turn.action.ack" && isRecord(request.params)) {
					actionAttempts.push({
						ordinal: actionAttempts.length + 1,
						method: request.method,
						params: request.params,
					});
					cancellationAcknowledged = true;
					socket.end(
						`${JSON.stringify({ id: request.id, result: { type: "agent_turn_action", action: cancelAction(), admitted: true } })}\n`,
					);
					continue;
				}
				socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		socketPath,
		attempts,
		actionAttempts,
		requests,
		requestCancel: () => {
			cancellationRequested = true;
		},
		waitFor: (predicate, afterOrdinal = 0) => {
			const existing = attempts.find(attempt => attempt.ordinal > afterOrdinal && predicate(attempt));
			if (existing) return Promise.resolve(existing);
			return new Promise<TurnAttempt>((resolve, reject) => {
				waiters.add({ predicate, afterOrdinal, resolve, reject });
			});
		},
		close: async () => {
			for (const waiter of waiters) waiter.reject(new Error("reporter transport closed"));
			waiters.clear();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(socketPath, { force: true });
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function startChild(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): RunningChild {
	const pty = new PtySession();
	let tail = "";
	const finished = pty.start(
		{
			command: currentXcshCommand(args),
			cwd,
			env,
			timeoutMs,
			cols: 120,
			rows: 40,
		},
		(_error, chunk) => {
			tail = `${tail}${chunk ?? ""}`.slice(-8000);
		},
	);
	return { pty, finished, outputTail: () => tail };
}

async function stopInteractiveChild(child: RunningChild, timeoutMs: number): Promise<PtyRunResult> {
	try {
		await Bun.sleep(100);
		child.pty.write("\x04");
		return await withTimeout(child.finished, Math.min(timeoutMs, 5000), "native child shutdown");
	} catch {
		try {
			child.pty.kill();
		} catch {}
		return await withTimeout(child.finished, Math.min(timeoutMs, 5000), "forced native child shutdown");
	}
}

async function prepareFixture(options: NativeLifecycleDriverOptions): Promise<{ path: string; value: string }> {
	if (options.fixturePath !== undefined || options.fixtureValue !== undefined) {
		if (!options.fixturePath || options.fixtureValue === undefined) {
			throw new Error("fixturePath and fixtureValue must be supplied together");
		}
		const actual = (await fs.readFile(options.fixturePath, "utf8")).replace(/\n$/u, "");
		if (actual !== options.fixtureValue) throw new Error("fixture value does not match the supplied file");
		return { path: path.resolve(options.fixturePath), value: actual };
	}
	const value = `xcsh-native-${randomBytes(24).toString("base64url")}`;
	const fixturePath = path.join(options.sessionDir, `fixture-${randomBytes(8).toString("hex")}.txt`);
	await fs.writeFile(fixturePath, `${value}\n`, { mode: 0o600, flag: "wx" });
	return { path: fixturePath, value };
}

async function readCanonicalSession(sessionDir: string): Promise<{ id: string; path: string; headerSha256: string }> {
	const entries = await fs.readdir(sessionDir, { withFileTypes: true });
	const candidates: Array<{ id: string; path: string; headerSha256: string }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const sessionPath = path.join(sessionDir, entry.name);
		const contents = await fs.readFile(sessionPath);
		const newline = contents.indexOf(0x0a);
		if (newline < 0) continue;
		const firstBytes = contents.subarray(0, newline + 1);
		const first = firstBytes.subarray(0, -1).toString("utf8");
		if (!first) continue;
		const header = JSON.parse(first) as Record<string, unknown>;
		if (header.type === "session" && typeof header.id === "string" && /^[0-9a-f]{16}$/u.test(header.id)) {
			candidates.push({
				id: header.id,
				path: sessionPath,
				headerSha256: createHash("sha256").update(firstBytes).digest("hex"),
			});
		}
	}
	if (candidates.length !== 1) throw new Error(`Expected exactly one canonical session, found ${candidates.length}`);
	return candidates[0]!;
}

function sessionProbeArgs(options: NativeLifecycleDriverOptions): string[] {
	return [
		"--model",
		options.model,
		"--mode",
		"json",
		"--session-dir",
		options.sessionDir,
		"--no-memories",
		"--no-skills",
		"--no-rules",
		"--no-mcp",
		"--no-lsp",
		"--no-tools",
	];
}

function baseChildArgs(
	options: NativeLifecycleDriverOptions,
	fixture: { path: string; value: string },
	sessionPath: string,
): string[] {
	const prompt = `Use the read tool to read ${fixture.path}. Return only its exact contents without the trailing newline.`;
	return nativeLifecycleChildArgv({
		model: options.model,
		sessionDir: options.sessionDir,
		prompt,
		tools: "read",
		resume: sessionPath,
		interactive: true,
	});
}

function stateIs(state: string): (attempt: TurnAttempt) => boolean {
	return attempt => attempt.params.state === state;
}

function terminal(attempt: TurnAttempt): boolean {
	return typeof attempt.params.state === "string" && TERMINAL_STATES.has(attempt.params.state);
}

export async function runNativeLifecycleAcceptance(
	options: NativeLifecycleDriverOptions,
): Promise<NativeLifecycleReceipt> {
	const timeoutMs = options.timeoutMs ?? 90_000;
	await fs.mkdir(options.sessionDir, { recursive: true, mode: 0o700 });
	const fixture = await prepareFixture(options);
	const transport = await startReporterTransport(options.sessionDir, {
		loseFirstTurnReply: options.scenario === "reply-loss-replay",
		managedCancel: options.scenario === "managed-cancel" || options.scenario === "managed-working-cancel",
	});
	const executionId = `xcsh-native-${randomUUID()}`;
	const paneId = `native:${randomUUID()}`;
	const environment = {
		HERDR_PANE_ID: paneId,
		HERDR_SOCKET_PATH: transport.socketPath,
		HERDR_EXECUTION_ID: executionId,
		HERDR_EXECUTION_GENERATION: "0",
		...(options.scenario === "managed-cancel" || options.scenario === "managed-working-cancel"
			? { HERDR_NATIVE_CAPABILITY: randomBytes(32).toString("hex") }
			: {}),
	};
	const childRuns: NativeLifecycleReceipt["childRuns"] = [];
	const control: Record<string, unknown> = {};
	let active: RunningChild | undefined;

	try {
		const probe = startChild(sessionProbeArgs(options), path.dirname(fixture.path), {}, timeoutMs);
		const probeResult = await withTimeout(probe.finished, timeoutMs, "canonical JSON session probe");
		if (probeResult.timedOut || probeResult.exitCode !== 0) {
			throw new Error(`Canonical JSON session probe failed: ${sanitizeText(probe.outputTail()).trim()}`);
		}
		childRuns.push(probeResult);
		const session = await readCanonicalSession(options.sessionDir);

		let args = baseChildArgs(options, fixture, session.path);
		if (
			options.scenario === "await-continue" ||
			options.scenario === "cancel" ||
			options.scenario === "managed-cancel"
		) {
			args = [...args, NATIVE_LIFECYCLE_CONTROL_FLAG, "await-user"];
		}
		if (options.scenario === "failure") args = [...args, "--api-key", "native-lifecycle-invalid-credential"];
		active = startChild(args, path.dirname(fixture.path), environment, timeoutMs);
		if (options.scenario === "managed-working-cancel") {
			const working = await withTimeout(transport.waitFor(stateIs("working")), timeoutMs, "working");
			control.workingOrdinal = working.ordinal;
			transport.requestCancel();
			control.cancellation = "protocol22_cooperative_working_action";
		}

		if (
			options.scenario === "await-continue" ||
			options.scenario === "cancel" ||
			options.scenario === "managed-cancel"
		) {
			const waiting = await withTimeout(transport.waitFor(stateIs("waiting_input")), timeoutMs, "waiting_input");
			control.waitingOrdinal = waiting.ordinal;
			if (options.scenario === "await-continue") {
				active.pty.write(options.continuation ?? "continue");
				await Bun.sleep(25);
				active.pty.write("\r");
				control.continuation = "pty_input";
			} else if (options.scenario === "cancel") {
				active.pty.interrupt();
				control.cancellation = "pty_process_group_sigint";
			} else {
				transport.requestCancel();
				control.cancellation = "protocol22_cooperative_action";
			}
		}

		const terminalAttempt = await withTimeout(transport.waitFor(terminal), timeoutMs, "terminal turn report");
		control.terminalOrdinal = terminalAttempt.ordinal;
		const expectedTerminal =
			options.scenario === "failure"
				? "failed"
				: options.scenario === "cancel" ||
						options.scenario === "managed-cancel" ||
						options.scenario === "managed-working-cancel"
					? "cancelled"
					: "completed";
		if (terminalAttempt.params.state !== expectedTerminal) {
			throw new Error(
				`Native child settled ${String(terminalAttempt.params.state)} instead of ${expectedTerminal}: ${active.outputTail()}`,
			);
		}
		if (expectedTerminal === "completed") {
			if (terminalAttempt.params.result !== fixture.value) {
				throw new Error("Native child completed without returning the exact randomized fixture value");
			}
			const digest = createHash("sha256").update(fixture.value).digest("hex");
			if (terminalAttempt.params.result_digest !== digest) {
				throw new Error("Native child completed with an invalid result digest");
			}
		}
		childRuns.push(await stopInteractiveChild(active, timeoutMs));
		active = undefined;

		if (terminalAttempt.params.session_id !== session.id) {
			throw new Error("Reporter session identity does not match the persisted SessionHeader");
		}

		if (options.scenario === "reply-loss-replay") {
			const lost = transport.attempts.find(attempt => attempt.replyLost);
			if (!lost) throw new Error("Reporter transport did not lose the configured reply");
			const beforeRestart = transport.attempts.length;
			active = startChild(
				nativeLifecycleChildArgv({
					model: options.model,
					sessionDir: options.sessionDir,
					prompt: "",
					tools: "read",
					resume: session.path,
					interactive: true,
				}),
				path.dirname(fixture.path),
				environment,
				timeoutMs,
			);
			const replay = await withTimeout(
				transport.waitFor(attempt => sameTurnFrame(attempt.params, lost.params), beforeRestart),
				timeoutMs,
				"exact persisted reporter redelivery",
			);
			control.replyLossOrdinal = lost.ordinal;
			control.redeliveryOrdinal = replay.ordinal;
			control.exactRedelivery = true;
			control.resumePath = session.path;
			childRuns.push(await stopInteractiveChild(active, timeoutMs));
			active = undefined;
		}

		return {
			version: NATIVE_LIFECYCLE_DRIVER_VERSION,
			scenario: options.scenario,
			status: "passed",
			evidenceClass: "source_native_child",
			fixture,
			session,
			childRuns,
			turnAttempts: transport.attempts.map(attempt => ({
				...attempt,
				params: redactNativeLifecycleRequest(attempt.params),
			})),
			actionAttempts: transport.actionAttempts.map(attempt => ({
				...attempt,
				params: redactNativeLifecycleRequest(attempt.params),
			})),
			control,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const tail = active ? sanitizeText(active.outputTail()).trim().slice(-2000) : "";
		const diagnostic = `Reporter requests: ${transport.requests.join(", ") || "none"}; turn states: ${transport.attempts.map(attempt => String(attempt.params.state)).join(", ") || "none"}`;
		throw new Error(
			tail ? `${message}\n${diagnostic}\nNative child output tail:\n${tail}` : `${message}\n${diagnostic}`,
		);
	} finally {
		if (active) {
			try {
				active.pty.kill();
			} catch {}
			await active.finished.catch(() => undefined);
		}
		await transport.close();
	}
}
