/**
 * useChatSession — React hook that wires a Transport to accumulated TurnState.
 *
 * Browser-safe: no node:* imports, no Office.js.
 * The hook does not import any concrete transport — callers inject one.
 */

import type { ChatMediaContent } from "@f5-sales-demo/xcsh-chat-ui";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	type ChatErrorReason,
	type ChatImageMsg,
	type InteractionMode,
	initTurn,
	isChatMedia,
	isMediaAssetChunk,
	isMediaAssetError,
	isModelsList,
	isPathPicked,
	isSkillsList,
	isSlashCommandsList,
	type MediaAssetChunkMsg,
	type ModelInfo,
	type PathPickedMsg,
	reduceChatTurn,
	type SkillInfo,
	type SlashCommandInfo,
	type Transport,
	type TurnState,
} from "../core";
import { mediaAssetRefs, type TransportMediaDescriptor, toChatMediaContent } from "./media";
import { foldToolNotice, settleActivities, type ToolActivity } from "./tool-activity";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The single chat mode the Office pane sends. The interaction modes are a
 * Chrome browser-automation concept (they steer on-page overlays/annotations),
 * so the Office pane exposes NO mode toggle and fixes the mode to `educational`
 * ("Explain concepts… help the user understand") — the least-wrong fit for a
 * document assistant, matching the Explain/Improve/Summarize starters.
 */
export const DEFAULT_INTERACTION_MODE: InteractionMode = "educational";

/**
 * Post-connect lifecycle hooks. `provision` points xcsh's provider at the saved
 * gateway (the `configure` round-trip) and runs BEFORE `onConnected`; the session
 * sequences connect → provision → onConnected and gates chat until it resolves.
 */
export interface ChatSessionHooks {
	provision?: () => Promise<void>;
	onConnected?: () => void;
	selectModel?: (model: string) => Promise<string>;
}

/**
 * Provisioning lifecycle, distinct from the chat `status`:
 * - `connecting`  — awaiting `transport.connect()`
 * - `configuring` — connected, running `provision()` (the gateway `configure`)
 * - `ready`       — provisioned; chat is enabled and host tools are advertised
 * - `error`       — `provision()` rejected (configure_error / mid-configure drop)
 */
export type Provisioning = "connecting" | "configuring" | "ready" | "error";

export interface UserTurn {
	kind: "user";
	id: string;
	text: string;
}

export interface AssistantTurn {
	kind: "assistant";
	state: TurnState;
	/** Live tool-activity rows for this turn, folded from `chat_tool_notice`
	 *  (both host and engine tools), in call order. */
	activities: ToolActivity[];
	media?: ChatMediaContent[];
}

export type Turn = UserTurn | AssistantTurn;

/**
 * A conversation banked by {@link ChatSessionResult.newChat}, for READ-BACK only.
 *
 * `newChat` bumps the `history_hint` that tells the bridge to reset the engine's
 * message array, so by the time a chat is in here the engine has already forgotten
 * it. Reopening one shows the transcript; it does NOT resume the conversation
 * (see {@link ChatSessionResult.viewHistory}).
 *
 * In-memory and session-scoped: closing or reloading the pane loses these. `Turn`
 * is plain JSON-serializable data, so a durable store could drop in unchanged.
 */
export interface ChatHistoryEntry {
	id: string;
	/** Derived from the first user turn, for the history menu. */
	title: string;
	turns: Turn[];
}

/** Longest history-menu title before ellipsis (a 320px pane is narrow). */
const HISTORY_TITLE_MAX = 48;

/**
 * Freeze a conversation on its way into {@link ChatHistoryEntry}.
 *
 * `newChat` is deliberately usable mid-stream (it is the wedge-recovery path) and
 * `transport.stop()` only sends `chat_stop` — it does not settle the local turn. The
 * terminal frame then arrives AFTER the bank and maps over the live turns, so it can
 * never reach the snapshot (turns are immutable). Left alone, the archive would read
 * back as permanently "streaming": a read-only past chat stuck on "Thinking…".
 *
 * A turn with text settles to `done`, matching what pressing Stop produces — and
 * NOT to `error`, which `turnsToMessages` renders as the error message ALONE,
 * discarding the very text the archive exists to preserve. A turn stopped before its
 * first token has no answer to keep, so it says so rather than leaving an empty row.
 */
function settleForArchive(turns: Turn[]): Turn[] {
	return turns.map(turn => {
		if (turn.kind !== "assistant" || turn.state.status !== "streaming") return turn;
		const settled: TurnState = turn.state.text
			? { ...turn.state, status: "done" }
			: { ...turn.state, status: "done", text: "Stopped before a response arrived." };
		return { kind: "assistant", state: settled, activities: settleActivities(turn.activities), media: turn.media };
	});
}

function historyTitle(turns: Turn[]): string {
	const first = turns.find((t): t is UserTurn => t.kind === "user");
	const text = first?.text.trim().replace(/\s+/g, " ") ?? "";
	if (!text) return "Untitled chat"; // an images-only opening turn has no text
	return text.length > HISTORY_TITLE_MAX ? `${text.slice(0, HISTORY_TITLE_MAX - 1)}…` : text;
}

/** Optional per-send extras. `mode` overrides the fixed Office mode (retry only);
 *  `images` are photo/image attachments sent as vision blocks. */
export interface SendOptions {
	mode?: InteractionMode;
	images?: ChatImageMsg[];
	/** Absolute local paths (files/folders) attached as context for this turn. */
	contextPaths?: string[];
	/** Enable Anthropic server-side web search for this turn ("Search the web" toggle). */
	webSearch?: boolean;
}

export interface ChatSessionResult {
	/** The transcript to render: the live conversation, or — while
	 *  {@link viewingId} is set — the archived one being read back. */
	turns: Turn[];
	send(text: string, opts?: SendOptions): void;
	stop(): void;
	retry(): void;
	/** Start a fresh conversation: bank the outgoing one in {@link history}, clear
	 *  the transcript and reset the engine's history (the next turn carries a new
	 *  `history_hint`, which the bridge maps to `replaceMessages([])`). Also leaves
	 *  history-viewing mode. */
	newChat(): void;
	/** Conversations banked by {@link newChat} this session, newest first. */
	history: ChatHistoryEntry[];
	/** The archived conversation currently being read back, or null for the live one. */
	viewingId: string | null;
	/**
	 * Read back an archived conversation. READ-ONLY: the engine's context was reset
	 * when this chat was banked, so {@link send} refuses while viewing rather than
	 * answering a follow-up without the conversation on screen. The live chat is
	 * untouched — {@link exitHistory} returns to it.
	 */
	viewHistory(id: string): void;
	/** Return to the live conversation. */
	exitHistory(): void;
	status: "idle" | "streaming" | "done" | "error";
	/** Populated when status is 'error'; mirrors TurnState.reason for turn errors
	 *  and is set to 'bridge-disconnected' for transport.connect() failures. */
	reason?: ChatErrorReason;
	/** Provisioning lifecycle — chat is gated until this is 'ready'. */
	provisioning: Provisioning;
	/** Set when provisioning is 'error' (a rejected provider `configure`); the
	 *  panel renders it as a non-silent, recoverable error rather than proceeding. */
	provisionError?: string;
	/** The engine's loaded skills, requested on connect — powers the composer's
	 *  Skills submenu. Empty until the `skills` reply arrives (or if none load). */
	skills: SkillInfo[];
	/** The engine's file-based slash commands, requested on connect — powers the
	 *  composer's `/` menu. Includes an installed plugin's commands, prefixed
	 *  `<plugin>:<name>`. Empty until the `commands` reply arrives. */
	slashCommands: SlashCommandInfo[];
	/** Models reported by xcsh and the active model id. */
	models: ModelInfo[];
	model: string | null;
	/** Select a model and update the displayed id only after xcsh acknowledges it. */
	selectModel(model: string): Promise<void>;
	/** Open a native OS file/folder picker on the bridge machine and resolve the
	 *  chosen path (or a canceled/unsupported result). Backs the "Add a file/folder"
	 *  composer categories. */
	pickPath(mode: "file" | "folder"): Promise<PathPickedMsg>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatSession(transport: Transport, hooks?: ChatSessionHooks): ChatSessionResult {
	// The LIVE conversation. Streaming frames only ever land here, so reading an
	// archive never interferes with a turn in flight.
	const [turns, setTurns] = useState<Turn[]>([]);
	const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
	const [viewingId, setViewingId] = useState<string | null>(null);
	// Mirrors `viewingId` for send()'s refusal guard, so the guard can't be defeated
	// by a handler captured in an earlier render. Written only via setViewing.
	const viewingIdRef = useRef<string | null>(null);
	// Mirrors the live turns so newChat() can bank them without taking `turns` as a
	// dependency (keeping its identity stable) or side-effecting in a state updater.
	const turnsRef = useRef<Turn[]>(turns);
	turnsRef.current = turns;
	// Holds a connect() rejection; reset whenever transport changes.
	const [connectErr, setConnectErr] = useState<ChatErrorReason | null>(null);
	const [provisioning, setProvisioning] = useState<Provisioning>("connecting");
	const [provisionError, setProvisionError] = useState<string | undefined>(undefined);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [model, setModel] = useState<string | null>(null);
	// Resolver for an in-flight pickPath() — settled by the next `path_picked` frame.
	const pendingPickRef = useRef<((r: PathPickedMsg) => void) | null>(null);
	const pendingMediaRef = useRef(
		new Map<string, { resolve: (chunk: MediaAssetChunkMsg["chunk"]) => void; reject: () => void }>(),
	);
	const mediaRequestCounterRef = useRef(0);
	const mediaObjectUrlsRef = useRef(new Set<string>());
	const counterRef = useRef(0);
	const activeTurnIdRef = useRef<string | null>(null);
	const lastUserTextRef = useRef<string>("");
	const lastUserModeRef = useRef<InteractionMode>(DEFAULT_INTERACTION_MODE);
	const lastUserImagesRef = useRef<ChatImageMsg[] | undefined>(undefined);
	// Conversation boundary: sent on every chat_request; a NEW value tells the
	// bridge to reset the engine's history (replaceMessages([])). Bumped by newChat().
	const historyHintRef = useRef(1);
	// Held in a ref so a changing callback identity doesn't re-run the connect effect.
	const hooksRef = useRef(hooks);
	hooksRef.current = hooks;

	const readMediaChunk = useCallback(
		(ref: string, offset: number): Promise<MediaAssetChunkMsg["chunk"]> => {
			const requestId = `media-${++mediaRequestCounterRef.current}`;
			return new Promise((resolve, reject) => {
				const timeout = window.setTimeout(() => {
					pendingMediaRef.current.delete(requestId);
					reject(new Error("media unavailable"));
				}, 30_000);
				pendingMediaRef.current.set(requestId, {
					resolve: chunk => {
						window.clearTimeout(timeout);
						resolve(chunk);
					},
					reject: () => {
						window.clearTimeout(timeout);
						reject(new Error("media unavailable"));
					},
				});
				try {
					transport.send({ type: "media_asset_read", requestId, ref, offset });
				} catch {
					pendingMediaRef.current.delete(requestId);
					reject(new Error("media unavailable"));
				}
			});
		},
		[transport],
	);

	const loadMedia = useCallback(
		async (descriptor: TransportMediaDescriptor): Promise<ChatMediaContent> => {
			const urls = new Map<string, string>();
			await Promise.all(
				mediaAssetRefs(descriptor).map(async ref => {
					const parts: BlobPart[] = [];
					let offset = 0;
					let mimeType = "application/octet-stream";
					let eof = false;
					while (!eof) {
						const chunk = await readMediaChunk(ref, offset);
						if (chunk.ref !== ref || chunk.offset !== offset || chunk.nextOffset <= offset) {
							throw new Error("invalid media chunk");
						}
						mimeType = chunk.mimeType;
						const binary = atob(chunk.data);
						if (binary.length !== chunk.bytes) throw new Error("invalid media chunk size");
						parts.push(Uint8Array.from(binary, char => char.charCodeAt(0)).buffer as ArrayBuffer);
						offset = chunk.nextOffset;
						eof = chunk.eof;
					}
					const url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
					mediaObjectUrlsRef.current.add(url);
					urls.set(ref, url);
				}),
			);
			return toChatMediaContent(descriptor, urls);
		},
		[readMediaChunk],
	);

	useEffect(() => {
		let mounted = true;
		// Reset lifecycle state when the transport instance changes.
		setConnectErr(null);
		setProvisioning("connecting");
		setProvisionError(undefined);
		setModels([]);
		setModel(null);
		transport
			.connect()
			.then(async () => {
				if (!mounted) return;
				// Connected → point xcsh's provider at the gateway before enabling chat.
				setProvisioning("configuring");
				try {
					await hooksRef.current?.provision?.();
				} catch {
					// A rejected provider configure is surfaced (never swallowed): chat
					// stays gated and host tools are NOT advertised. #2134.
					console.error("[useChatSession] provider configuration failed");
					if (mounted) {
						setProvisionError("Provider configuration failed. Review the gateway settings and retry.");
						setProvisioning("error");
					}
					return;
				}
				if (!mounted) return;
				// Provisioned → enable chat, then advertise host tools (needs an open socket).
				setProvisioning("ready");
				hooksRef.current?.onConnected?.();
				// Ask the engine for its loaded skills to populate the composer's Skills
				// submenu. Best-effort: a failure just leaves the submenu empty.
				try {
					transport.send({ type: "list_skills" });
					// …and for its slash commands, which populate the composer's `/` menu.
					transport.send({ type: "list_commands" });
					transport.send({ type: "list_models" });
				} catch {
					/* transport already gone — skip; the submenu stays empty */
				}
			})
			.catch(() => {
				console.error("[useChatSession] transport connection failed");
				if (mounted) {
					setConnectErr("bridge-disconnected");
				}
			});
		const unsub = transport.onMessage(msg => {
			if (isMediaAssetChunk(msg)) {
				const pending = pendingMediaRef.current.get(msg.requestId);
				pendingMediaRef.current.delete(msg.requestId);
				pending?.resolve(msg.chunk);
				return;
			}
			if (isMediaAssetError(msg)) {
				const pending = pendingMediaRef.current.get(msg.requestId);
				pendingMediaRef.current.delete(msg.requestId);
				pending?.reject();
				return;
			}
			if (isChatMedia(msg)) {
				void loadMedia(msg.media)
					.then(media => {
						if (!mounted) return;
						setTurns(prev =>
							prev.map(turn =>
								turn.kind === "assistant" && turn.state.id === msg.id
									? { ...turn, media: [...(turn.media ?? []), media] }
									: turn,
							),
						);
					})
					.catch(() => {
						if (!mounted) return;
						const media = toChatMediaContent(msg.media, new Map());
						media.degradation = media.degradation ?? "Media asset unavailable.";
						setTurns(prev =>
							prev.map(turn =>
								turn.kind === "assistant" && turn.state.id === msg.id
									? { ...turn, media: [...(turn.media ?? []), media] }
									: turn,
							),
						);
					});
				return;
			}
			// Narrow to ChatStreamMsg via the discriminated union on `type`.
			if (
				msg.type === "chat_message_start" ||
				msg.type === "chat_delta" ||
				msg.type === "chat_message_end" ||
				msg.type === "chat_done" ||
				msg.type === "chat_error"
			) {
				const terminal = msg.type === "chat_done" || msg.type === "chat_error";
				setTurns(prev =>
					prev.map(turn => {
						if (turn.kind === "assistant" && turn.state.id === msg.id) {
							// A terminal frame settles any activity still marked running.
							const activities = terminal ? settleActivities(turn.activities) : turn.activities;
							return {
								kind: "assistant",
								state: reduceChatTurn(turn.state, msg),
								activities,
								media: turn.media,
							};
						}
						return turn;
					}),
				);
			} else if (isSkillsList(msg)) {
				// The engine's loaded skills — cache them for the composer's Skills submenu.
				setSkills(msg.skills);
			} else if (isSlashCommandsList(msg)) {
				// The engine's slash commands — cache them for the composer's `/` menu.
				setSlashCommands(msg.commands);
			} else if (isModelsList(msg)) {
				setModels(msg.models);
				setModel(msg.current);
			} else if (isPathPicked(msg)) {
				// Settle the in-flight pickPath() with the picker result.
				pendingPickRef.current?.(msg);
				pendingPickRef.current = null;
			} else if (msg.type === "chat_tool_notice") {
				// Live tool activity: fold the notice into its turn's activity list so
				// the transcript shows "Reading data…" while xcsh works (Claude parity).
				setTurns(prev =>
					prev.map(turn =>
						turn.kind === "assistant" && turn.state.id === msg.id
							? {
									kind: "assistant",
									state: turn.state,
									activities: foldToolNotice(turn.activities, msg),
									media: turn.media,
								}
							: turn,
					),
				);
			}
		});
		// Unsubscribe on unmount — do not dispose, the transport outlives this hook.
		return () => {
			mounted = false;
			unsub();
			for (const pending of pendingMediaRef.current.values()) pending.reject();
			pendingMediaRef.current.clear();
			for (const url of mediaObjectUrlsRef.current) URL.revokeObjectURL(url);
			mediaObjectUrlsRef.current.clear();
		};
	}, [loadMedia, transport]);

	const setViewing = useCallback((id: string | null) => {
		viewingIdRef.current = id;
		setViewingId(id);
	}, []);

	const send = useCallback(
		(text: string, opts?: SendOptions) => {
			// Reading back an archived chat is READ-ONLY. The engine's message array was
			// reset when that chat was banked, so a follow-up here would be answered
			// WITHOUT the conversation the user is looking at. Refuse in the hook, not
			// just by disabling the composer, so no UI path can produce that answer.
			if (viewingIdRef.current) return;
			const mode = opts?.mode ?? DEFAULT_INTERACTION_MODE;
			const images = opts?.images;
			const contextPaths = opts?.contextPaths;
			const webSearch = opts?.webSearch;
			counterRef.current += 1;
			const id = `c-${counterRef.current}`;
			lastUserTextRef.current = text;
			lastUserModeRef.current = mode;
			lastUserImagesRef.current = images;
			activeTurnIdRef.current = id;

			const userTurn: UserTurn = { kind: "user", id: `u-${counterRef.current}`, text };
			const assistantTurn: AssistantTurn = { kind: "assistant", state: initTurn(id), activities: [], media: [] };

			setTurns(prev => [...prev, userTurn, assistantTurn]);

			try {
				transport.send({
					type: "chat_request",
					id,
					text,
					context: null,
					mode,
					history_hint: `conv-${historyHintRef.current}`,
					// Only attach optional fields when present so a plain turn stays a clean frame.
					...(images && images.length > 0 ? { images } : {}),
					...(contextPaths && contextPaths.length > 0 ? { contextPaths } : {}),
					...(webSearch ? { web_search: true } : {}),
				});
			} catch {
				// A closed/failed transport throws synchronously (e.g. "Cannot send in
				// state 'closed'"). Without this guard the optimistic assistant turn
				// above would stay in 'streaming' forever (a perpetual spinner). Fold it
				// into a terminal error so the failure is never silent; the transport is
				// gone, so this is reported as bridge-disconnected (no dead-end Retry).
				console.error("[useChatSession] transport send failed");
				setTurns(prev =>
					prev.map(turn =>
						turn.kind === "assistant" && turn.state.id === id
							? {
									kind: "assistant",
									state: { ...turn.state, status: "error", reason: "bridge-disconnected" },
									activities: turn.activities,
									media: turn.media,
								}
							: turn,
					),
				);
			}
		},
		[transport],
	);

	const stop = useCallback(() => {
		if (activeTurnIdRef.current) {
			transport.stop(activeTurnIdRef.current);
		}
	}, [transport]);

	const selectModel = useCallback(async (modelId: string): Promise<void> => {
		const select = hooksRef.current?.selectModel;
		if (!select) return;
		const selected = await select(modelId);
		setModel(selected);
	}, []);

	const pickPath = useCallback(
		(mode: "file" | "folder") =>
			new Promise<PathPickedMsg>(resolve => {
				// Only one picker at a time; a new request supersedes any stale resolver
				// (resolve the old one as canceled so its caller doesn't hang).
				pendingPickRef.current?.({ type: "path_picked", canceled: true });
				pendingPickRef.current = resolve;
				try {
					transport.send({ type: "pick_path", mode });
				} catch {
					pendingPickRef.current = null;
					resolve({ type: "path_picked", unsupported: true });
				}
			}),
		[transport],
	);

	const retry = useCallback(() => {
		// Retry re-sends the last prompt AND its images (an image-only turn has empty
		// text, so guard on either being present).
		if (lastUserTextRef.current || (lastUserImagesRef.current?.length ?? 0) > 0) {
			send(lastUserTextRef.current, { mode: lastUserModeRef.current, images: lastUserImagesRef.current });
		}
	}, [send]);

	const newChat = useCallback(() => {
		// Abort any in-flight turn on the SERVER first (chat_stop). Otherwise a turn
		// that's still running (or wedged waiting on an unanswered host tool) keeps
		// going after the reset, and the next send queues behind it forever — the
		// "spins on Thinking… until a worker restart" trap. A closed transport throws
		// on send; the reset below still clears the UI regardless.
		if (activeTurnIdRef.current) {
			try {
				transport.stop(activeTurnIdRef.current);
			} catch {
				/* transport gone — nothing to abort; fall through to the local reset */
			}
		}
		// Bank the outgoing conversation for read-back before clearing it. Keyed by the
		// history_hint it ran under — the same value the engine is about to forget.
		// Nothing to bank for an empty transcript (no blank entries), and it is always
		// the LIVE turns, never an archive being viewed.
		const outgoing = turnsRef.current;
		if (outgoing.length > 0) {
			const entry: ChatHistoryEntry = {
				id: `conv-${historyHintRef.current}`,
				title: historyTitle(outgoing),
				// Settle first: the chat_stop above lands too late to reach this snapshot.
				turns: settleForArchive(outgoing),
			};
			setHistory(prev => [entry, ...prev]);
		}
		setViewing(null);
		// Bump the conversation boundary so the NEXT send resets the engine's history,
		// clear the transcript, and forget the last prompt (nothing to retry into the
		// fresh chat). Ids stay monotonic (counterRef is not reset) to avoid collisions.
		historyHintRef.current += 1;
		activeTurnIdRef.current = null;
		lastUserTextRef.current = "";
		lastUserImagesRef.current = undefined;
		setTurns([]);
	}, [transport, setViewing]);

	const viewHistory = useCallback(
		(id: string) => {
			setViewing(id);
		},
		[setViewing],
	);

	const exitHistory = useCallback(() => {
		setViewing(null);
	}, [setViewing]);

	// What the transcript shows: the archive being read back, else the live chat. A
	// missing id can't happen (entries are never removed) but falls back to live
	// rather than blanking the pane.
	const viewedTurns = viewingId ? history.find(h => h.id === viewingId)?.turns : undefined;
	const visibleTurns = viewedTurns ?? turns;

	// Status describes what is ON SCREEN, so an archived (settled) chat never shows a
	// streaming caret for a turn still running in the live conversation behind it.
	const lastAssistant = visibleTurns.findLast((t): t is AssistantTurn => t.kind === "assistant");

	// connect() failures take precedence; fall back to the last assistant turn's status.
	// Design note: we expose `reason` directly on ChatSessionResult (same field name/type
	// as TurnState.reason) rather than injecting a synthetic turn, to avoid rendering a
	// spurious chat bubble for a connection-level error.
	let status: ChatSessionResult["status"];
	let reason: ChatErrorReason | undefined;
	if (connectErr) {
		status = "error";
		reason = connectErr;
	} else if (lastAssistant) {
		status = lastAssistant.state.status;
		reason = lastAssistant.state.reason;
	} else {
		status = "idle";
	}

	return {
		turns: visibleTurns,
		send,
		stop,
		retry,
		newChat,
		history,
		viewingId,
		viewHistory,
		exitHistory,
		status,
		reason,
		provisioning,
		provisionError,
		skills,
		slashCommands,
		models,
		model,
		selectModel,
		pickPath,
	};
}
