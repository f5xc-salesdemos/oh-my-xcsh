import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, AssistantMessagePhase, ImageContent } from "@f5-sales-demo/pi-ai";
import { parseModelString } from "../config/model-resolver";
import { settings } from "../config/settings";
import { DEFAULT_MODEL_ROLE } from "../config/settings-schema";
import { toSkillSummaries } from "../extensibility/skills";
import { expandSlashCommand, toSlashCommandSummaries } from "../extensibility/slash-commands";
import {
	isRpcHostToolResult,
	isRpcHostToolUpdate,
	normalizeHostToolDefinitions,
	RpcHostToolBridge,
} from "../host-tools";
import {
	extractMediaDescriptorFromToolResult,
	listMediaDescriptors,
	projectMediaDescriptorForTransport,
	readMediaAssetChunk,
} from "../media/transport";
import { LITELLM_LOGIN_MODEL_CHOICES } from "../modes/controllers/login-model";
import { extractReferences } from "../references";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { EXTENSION_CAPABILITIES } from "./capabilities.generated";
import {
	type ChatDelta,
	type ChatDone,
	type ChatError,
	type ChatErrorReason,
	type ChatKeepalive,
	type ChatMedia,
	type ChatMessageEnd,
	type ChatMessageStart,
	type ChatRequest,
	type Configure,
	type ConfigureAck,
	type ConfigureError,
	type HostToolResult,
	type HostToolUpdate,
	type InteractionMode,
	isBrowserChatRequest,
	isChatStop,
	isConfigure,
	isListCommands,
	isListModels,
	isListSkills,
	isMediaAssetRead,
	isSetHostTools,
	isTransportChatRequest,
	type MediaAssetChunkMessage,
	type MediaAssetError,
	type MediaAssetRead,
	type ModelsList,
	type PageContextSnapshot,
	type SetHostTools,
	type SetHostToolsAck,
	type SetHostToolsError,
	type SkillsList,
	type SlashCommandsList,
} from "./chat-protocol";
import { CONSOLE_ROUTES } from "./console-routes.generated";
import type { BridgeServer } from "./extension-bridge";
import { type ClientHost, hostProfile } from "./host-profiles";
import { interpretPageState } from "./page-state-interpreter";
import { chatSpans } from "./ttft-spans";

/** Minimum spacing between chat_keepalive liveness frames during a long think.
 * Far below the panel's first-token timeout (120s) so a couple of missed frames
 * never trip a false abort, yet sparse enough to not spam the wire on rapid
 * thinking deltas. */
export const KEEPALIVE_INTERVAL_MS = 10_000;

/** Throttle gate for chat_keepalive: send when at least KEEPALIVE_INTERVAL_MS has
 * elapsed since the last one (lastKeepaliveAt = 0 means none yet → always true, so
 * the first thinking delta immediately proves liveness to the panel). */
export function shouldSendKeepalive(nowMs: number, lastKeepaliveAt: number): boolean {
	return nowMs - lastKeepaliveAt >= KEEPALIVE_INTERVAL_MS;
}

interface ActiveChat {
	id: string;
	items: Map<number, { itemId: string; phase: AssistantMessagePhase; seq: number }>;
	nextItem: number;
	terminalSent: boolean;
	unsubscribe: () => void;
	entryAt: number;
	promptAt: number | null;
	spanEmitted: boolean;
	/** Wall-clock of the last chat_keepalive sent, to throttle liveness frames during
	 * a long pre-first-token think (0 = none sent yet). */
	lastKeepaliveAt: number;
}

export class ChatHandler {
	#server: BridgeServer;
	#session: AgentSession;
	#activeChats = new Map<string, ActiveChat>();
	#activeHistoryHint: string | undefined;
	#onTurnStart: (() => void) | undefined;
	// Queued next request: when the session is busy (a turn is in flight), the next
	// prompt is stashed here and replayed automatically when the current turn finishes.
	// Only one pending request at a time (newest wins — a third prompt while one is
	// queued replaces it, so the user's latest intent always runs next).
	#pendingRequest: ChatRequest | null = null;
	// A request can arrive after chat_done but before AgentSession clears its short
	// prompt-in-flight tail. There is then no active chat whose finally block can
	// replay the queue, so that orphaned queue needs its own idle drain.
	#pendingReplayScheduled = false;
	#disposed = false;
	// Transport-neutral host-tool bridge (A1): maps `set_host_tools` definitions to
	// AgentTools whose execute() round-trips a `host_tool_call` back to the WS client
	// and awaits the correlated `host_tool_result`. Reused verbatim from the stdio RPC
	// driver — the only WS-specific wiring is the `send()` output sink below.
	#hostToolBridge: RpcHostToolBridge;

	constructor(server: BridgeServer, session: AgentSession) {
		this.#server = server;
		this.#session = session;
		this.#hostToolBridge = new RpcHostToolBridge(frame => this.#server.send(frame));
	}

	/** Register a callback fired when a chat turn is accepted (used by the worker's
	 * manager keepalive to refresh lastSeen at turn start). */
	onTurnStart(cb: () => void): void {
		this.#onTurnStart = cb;
	}

	attach(): void {
		this.#server.onMessage(msg => {
			if (this.#server.serveKind === "browser" && isBrowserChatRequest(msg)) this.#handleChatRequest(msg);
			else if (this.#server.serveKind === "office" && isTransportChatRequest(msg)) this.#handleChatRequest(msg);
			else if (isChatStop(msg)) this.#handleChatStop(msg as unknown as { id: string });
			else if (isMediaAssetRead(msg)) void this.#handleMediaAssetRead(msg as unknown as MediaAssetRead);
			// Host-tool channel (#2046): register client tools, then route the client's
			// result/update frames back to the correlated pending call in the bridge.
			else if (isSetHostTools(msg)) this.#handleSetHostTools(msg as unknown as SetHostTools);
			// Office-only provider configuration channel (#2095): swap the LLM
			// provider/model in session memory at runtime (never persisted), then ack
			// or nack. Contract-2 Chrome clients cannot configure credentials.
			else if (this.#server.serveKind === "office" && isConfigure(msg)) {
				this.#handleConfigure(msg as unknown as Configure);
			}
			// Skills enumeration (#2311): the pane asks for the loaded skills to populate
			// the composer's Skills submenu.
			else if (isListSkills(msg)) this.#handleListSkills();
			// Model enumeration is separate from credential configuration: the pane can
			// select among models xcsh already knows without asking for another token.
			else if (isListModels(msg)) this.#handleListModels();
			// Slash-command enumeration: the pane asks for the session's file-based
			// commands to populate the composer's `/` menu.
			else if (isListCommands(msg)) this.#handleListCommands();
			else if (isRpcHostToolResult(msg)) this.#hostToolBridge.handleResult(msg as unknown as HostToolResult);
			else if (isRpcHostToolUpdate(msg)) this.#hostToolBridge.handleUpdate(msg as unknown as HostToolUpdate);
		});

		this.#server.onDisconnected(() => {
			this.#disposed = true;
			this.#pendingRequest = null; // abandon any queued prompt — the bridge is gone
			// Fail any in-flight host-tool call — the client that would answer it is gone.
			this.#hostToolBridge.rejectAllPending("bridge disconnected before host tool completed");
			for (const chat of this.#activeChats.values()) {
				this.#sendTerminal(chat, {
					type: "chat_error",
					id: chat.id,
					reason: "bridge-disconnected",
				});
				chat.unsubscribe();
			}
			this.#activeChats.clear();
		});
	}

	async #handleMediaAssetRead(req: MediaAssetRead): Promise<void> {
		try {
			const chunk = await readMediaAssetChunk(
				this.#session.sessionManager.getBlobStore(),
				listMediaDescriptors(this.#session.sessionManager.getEntries()),
				req,
			);
			this.#server.send({
				type: "media_asset_chunk",
				requestId: req.requestId,
				chunk,
			} satisfies MediaAssetChunkMessage);
		} catch {
			this.#server.send({
				type: "media_asset_error",
				requestId: req.requestId,
				error: "asset-unavailable",
			} satisfies MediaAssetError);
		}
	}

	async #handleChatRequest(req: ChatRequest): Promise<void> {
		const { id } = req;

		if (this.#session.isStreaming || this.#activeChats.size > 0) {
			// Queue instead of reject: stash this request and replay it automatically
			// when the current turn finishes. Newest wins (a third prompt while one is
			// queued replaces it, so the user's latest intent always runs next). Send a
			// tool-notice so the panel clears its timeout and shows "queued."
			this.#pendingRequest = req;
			this.#server.send({
				type: "chat_tool_notice",
				id,
				tool: "queue",
				ok: true,
				detail: "xcsh is finishing the current request — yours is queued and will run next.",
			});
			this.#scheduleOrphanedPendingReplay();
			return;
		}

		if (req.history_hint && req.history_hint !== this.#activeHistoryHint) {
			this.#session.agent.replaceMessages([]);
			this.#activeHistoryHint = req.history_hint;
		}

		const chat: ActiveChat = {
			id,
			items: new Map(),
			nextItem: 0,
			terminalSent: false,
			unsubscribe: () => {},
			entryAt: Date.now(),
			promptAt: null,
			spanEmitted: false,
			lastKeepaliveAt: 0,
		};
		this.#activeChats.set(id, chat);
		this.#onTurnStart?.();

		const unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			this.#handleSessionEvent(chat, event);
		});
		chat.unsubscribe = unsubscribe;

		// Sanitize the attached paths (absolute, `..`-collapsed, confined to the user's
		// own space, no control chars) — the engine must not blindly widen its sandbox to
		// a client-supplied path. Grant the safe set BEFORE composing the prompt so the
		// model's read/grep/bash calls pass the gate. Session-scoped, in-memory, deduped.
		const contextPaths = Array.isArray(req.contextPaths) ? sanitizeContextPaths(req.contextPaths) : [];
		if (contextPaths.length > 0) grantSandboxPaths(contextPaths);
		// Expand a file-based slash command HERE, on the user's raw text, before it is
		// composed. Two reasons it cannot live in `AgentSession.prompt` for this surface:
		// we call `prompt` with `expandPromptTemplates: false`, and `composeChatPrompt`
		// appends the user's text last, so by then the string no longer starts with `/`.
		// A `/name` that matches nothing is returned unchanged, which is what keeps the
		// skill convention (same spelling, handled by the system prompt) working.
		const text = expandSlashCommand(req.text, [...this.#session.slashCommands]);
		const prompt = composeChatPrompt(text, req.context, req.mode, this.#server.clientHost, contextPaths);
		// Photo/image attachments ride as base64 vision blocks (the model is
		// vision-capable); text attachments are already folded into req.text upstream.
		const images: ImageContent[] | undefined = req.images?.map(img => ({
			type: "image",
			data: img.data,
			mimeType: img.mimeType,
		}));
		try {
			// Select the native provider-side descriptor from the ACTIVE model on every
			// turn. This must happen after a model switch and before prompt() transmits a
			// payload; an unsupported API is rejected locally instead of receiving another
			// provider's raw tool shape.
			const serverTools = req.web_search
				? officeWebSearchServerTools(this.#session.model?.api ?? "unconfigured")
				: undefined;
			chat.promptAt = Date.now();
			await this.#session.prompt(prompt, { expandPromptTemplates: false, synthetic: false, images, serverTools });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "unknown error";
			this.#sendTerminal(chat, { type: "chat_error", id, reason: classifyChatErrorReason(message) });
		} finally {
			if (!chat.terminalSent) {
				this.#sendTerminal(chat, { type: "chat_done", id });
			}
			chat.unsubscribe();
			this.#activeChats.delete(id);
			// Replay a queued request now that this turn is done: the session is free,
			// so the pending prompt runs immediately (no user re-send needed).
			const pending = this.#pendingRequest;
			if (pending) {
				this.#pendingRequest = null;
				void this.#handleChatRequest(pending);
			}
		}
	}

	/**
	 * Drain a queue created during AgentSession's terminal streaming tail. Normal
	 * mid-turn queues are replayed by the active chat's finally block; this path is
	 * only scheduled when no active chat exists to own that replay.
	 */
	#scheduleOrphanedPendingReplay(): void {
		if (this.#pendingReplayScheduled || this.#disposed || !this.#pendingRequest || this.#activeChats.size > 0) {
			return;
		}
		this.#pendingReplayScheduled = true;
		void this.#replayPendingAfterIdle();
	}

	async #replayPendingAfterIdle(): Promise<void> {
		try {
			await this.#session.waitForIdle();
			// waitForIdle can resolve in AgentSession's prompt finally just before its
			// prompt-in-flight counter is decremented. Yield one task so isStreaming is
			// the settled state rather than that terminal edge.
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		} catch {
			// A disposing session can reject its idle wait. Teardown owns any terminal
			// frame and clears the pending request; never replay into that session.
			this.#pendingReplayScheduled = false;
			return;
		}
		this.#pendingReplayScheduled = false;
		if (this.#disposed || !this.#pendingRequest || this.#activeChats.size > 0) return;
		if (this.#session.isStreaming) {
			this.#scheduleOrphanedPendingReplay();
			return;
		}
		const pending = this.#pendingRequest;
		this.#pendingRequest = null;
		void this.#handleChatRequest(pending);
	}

	#handleSessionEvent(chat: ActiveChat, event: AgentSessionEvent): void {
		if (chat.terminalSent) return;

		// TOOL-ACTIVITY STREAMING: forward tool execution events as chat_tool_notice
		// so the panel shows inline activity cards ("catalog_workflow_runner: running…")
		// instead of eternal "● ● ● thinking" during multi-step tool use.
		if (event.type === "tool_execution_start" && "toolName" in event) {
			this.#server.send({
				type: "chat_tool_notice",
				id: chat.id,
				tool: String(event.toolName),
				ok: true,
				detail: `${event.toolName}: running…`,
			});
			return;
		}
		if (event.type === "tool_execution_end" && "toolName" in event) {
			const descriptor = extractMediaDescriptorFromToolResult(event.result);
			if (descriptor) {
				this.#server.send({
					type: "chat_media",
					id: chat.id,
					media: projectMediaDescriptorForTransport(descriptor),
				} satisfies ChatMedia);
			}
			// ToolExecutionEndEvent carries `isError` (NOT `error`) — checking the wrong
			// field made this always ok:true, so errored tools rendered ✓ and "failed"
			// never fired. Read the real field.
			const failed = "isError" in event && Boolean(event.isError);
			this.#server.send({
				type: "chat_tool_notice",
				id: chat.id,
				tool: String(event.toolName),
				ok: !failed,
				detail: `${event.toolName}: ${failed ? "failed" : "done"}`,
			});
			return;
		}

		if (event.type === "message_update" && "assistantMessageEvent" in event) {
			const ame = event.assistantMessageEvent;
			if (ame.type === "text_start") {
				const item = {
					itemId: `${chat.id}:assistant:${chat.nextItem++}`,
					phase: ame.phase ?? "final_answer",
					seq: 0,
				};
				chat.items.set(ame.contentIndex, item);
				this.#server.send({
					type: "chat_message_start",
					id: chat.id,
					itemId: item.itemId,
					phase: item.phase,
				} satisfies ChatMessageStart);
			} else if (ame.type === "text_delta") {
				let item = chat.items.get(ame.contentIndex);
				if (!item) {
					// Legacy/synthetic streams can omit text_start (and older test or proxy
					// emitters can omit partial entirely). Keep that compatibility path
					// deterministic: missing metadata has final-answer semantics.
					const content = ame.partial?.content?.[ame.contentIndex];
					item = {
						itemId: `${chat.id}:assistant:${chat.nextItem++}`,
						phase: content?.type === "text" && content.phase === "commentary" ? "commentary" : "final_answer",
						seq: 0,
					};
					chat.items.set(ame.contentIndex, item);
					this.#server.send({
						type: "chat_message_start",
						id: chat.id,
						itemId: item.itemId,
						phase: item.phase,
					} satisfies ChatMessageStart);
				}
				this.#server.send({
					type: "chat_delta",
					id: chat.id,
					itemId: item.itemId,
					seq: item.seq++,
					delta: ame.delta,
				} satisfies ChatDelta);
				// TTFT Phase 2: first token out — emit the chat-segment spans once, keyed by
				// the c- turn id. chat.promptAt is set (prompt() was awaited before any event);
				// guard against re-emit on later deltas.
				if (!chat.spanEmitted && chat.promptAt !== null) {
					chat.spanEmitted = true;
					for (const s of chatSpans(chat.id, chat.entryAt, chat.promptAt, Date.now())) {
						this.#server.send(s);
					}
				}
			} else if (ame.type === "text_end") {
				const item = chat.items.get(ame.contentIndex);
				if (item) {
					item.phase = ame.phase ?? item.phase;
					this.#server.send({
						type: "chat_message_end",
						id: chat.id,
						itemId: item.itemId,
						phase: item.phase,
					} satisfies ChatMessageEnd);
					chat.items.delete(ame.contentIndex);
				}
			} else if (ame.type === "thinking_delta") {
				// LIVENESS: the model is streaming extended thinking before any visible
				// token. Emit a throttled chat_keepalive so the panel re-arms its
				// first-token timer — a long legitimate think must not be mistaken for a
				// dead worker (#1994). Throttled so a burst of thinking deltas doesn't spam
				// the wire; the interval is far below the panel's first-token timeout.
				const nowMs = Date.now();
				if (shouldSendKeepalive(nowMs, chat.lastKeepaliveAt)) {
					chat.lastKeepaliveAt = nowMs;
					this.#server.send({ type: "chat_keepalive", id: chat.id } satisfies ChatKeepalive);
				}
			} else if (ame.type === "server_tool_start") {
				// PROVIDER-SIDE ACTIVITY (#2340): the provider runs web search itself, which takes
				// seconds before any token streams. This notice is the only feedback in that window —
				// without it the panel shows a bare "Thinking…" and looks hung. It doubles as a
				// liveness signal, since the panel re-arms its first-token timer on a tool notice.
				const label = serverToolLabels(ame.toolName);
				this.#server.send({
					type: "chat_tool_notice",
					id: chat.id,
					tool: ame.toolName,
					ok: true,
					detail: ame.query ? `${label.running}: ${ame.query}` : `${label.running}…`,
				});
			} else if (ame.type === "server_tool_end") {
				const label = serverToolLabels(ame.toolName);
				const failed = ame.errorCode !== undefined;
				const count = ame.resultCount ?? 0;
				this.#server.send({
					type: "chat_tool_notice",
					id: chat.id,
					tool: ame.toolName,
					ok: !failed,
					detail: failed
						? `${label.done} failed: ${ame.errorCode}`
						: `${label.done}: ${count} result${count === 1 ? "" : "s"}`,
				});
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "error") {
				const errorMsg = msg.errorMessage ?? "assistant error";
				this.#sendTerminal(chat, {
					type: "chat_error",
					id: chat.id,
					reason: classifyChatErrorReason(errorMsg),
				});
			} else if (msg.stopReason === "toolUse" || msg.content.some(part => part.type === "toolCall")) {
				// INTERMEDIATE tool-use step: the agent loop emits message_end for this
				// assistant message BEFORE running the tool. Do NOT terminate the turn here
				// — that would drop the tool notices, the tool round-trip, and the post-tool
				// narration under the terminalSent guard. The single chat_done fires on the
				// FINAL assistant message_end below (normal completion), with the finally
				// backstop in #handleChatRequest guaranteeing exactly-once terminal semantics.
				return;
			} else {
				const references = extractReferences(msg);
				this.#sendTerminal(chat, {
					type: "chat_done",
					id: chat.id,
					...(references.length > 0 ? { references } : {}),
				});
			}
		}
	}

	/** Register the client's host tools with the session, then ack so the client can
	 * await registration before its first prompt. Mirrors the stdio `set_host_tools`
	 * command handler (rpc-mode.ts): normalize → bridge.setTools → refreshRpcHostTools. */
	async #handleSetHostTools(msg: SetHostTools): Promise<void> {
		try {
			const tools = normalizeHostToolDefinitions(msg.tools);
			const rpcTools = this.#hostToolBridge.setTools(tools);
			await this.#session.refreshRpcHostTools(rpcTools);
			this.#server.send({
				type: "set_host_tools_ack",
				toolNames: tools.map(tool => tool.name),
			} satisfies SetHostToolsAck);
		} catch {
			// Nack instead of throwing (stdio parity — rpc-mode nacks): a client
			// awaiting set_host_tools_ack would otherwise hang on malformed input.
			this.#server.send({
				type: "set_host_tools_error",
				reason: "host-tools-rejected",
			} satisfies SetHostToolsError);
		}
	}

	/** Configure the LLM provider at runtime from a bridge client (#2095), then ack
	 * with the selected model so the client can await it before its first prompt.
	 * SESSION/RUNTIME MEMORY ONLY — the token is never written to models.yml or the
	 * SQLite credential store. Mirrors #handleSetHostTools's try/ack-or-nack shape;
	 * never throws out of the handler (a nack keeps a waiting client from hanging).
	 *
	 * A curated model route identifies the concrete provider, model, effort, and
	 * provider-specific gateway path. The pane supplies only a gateway root. */
	async #handleConfigure(msg: Configure): Promise<void> {
		try {
			const registry = this.#session.modelRegistry;
			const defaultModel = parseModelString(DEFAULT_MODEL_ROLE);
			if (!defaultModel) {
				throw new Error("Invalid baked default model selector");
			}
			// An omitted model means the baked Office default, never whichever model a
			// previous CLI/global session happened to leave active. An explicit pane
			// selection still wins through msg.model.
			const modelId = msg.model ?? defaultModel.id;
			const choice = LITELLM_LOGIN_MODEL_CHOICES.find(candidate => candidate.modelId === modelId);
			const matchingProviders = (["anthropic", "litellm"] as const).filter(candidate =>
				registry.find(candidate, modelId),
			);
			const provider = choice?.provider ?? (matchingProviders.length === 1 ? matchingProviders[0] : undefined);
			if (!provider) {
				throw new Error(`No unambiguous Office model route for ${modelId}`);
			}
			const thinkingLevel = choice?.thinkingLevel ?? defaultModel.thinkingLevel;

			if (msg.baseUrl && msg.token) {
				// SSRF guard: only an `https:` gateway URL may be dialed. Validate BEFORE
				// registerProvider so a bad URL becomes a configure_error nack (never a
				// silently-ignored frame that hangs the client). We deliberately do NOT
				// block loopback/RFC-1918 targets: an operator-chosen INTERNAL gateway is
				// the whole point (the F5 LiteLLM gateway, and the claude-office CORS proxy
				// at https://127-0-0-1.local-ip.sh:8443 are legitimate targets).
				//
				// Accepted residual (user-requested tradeoff): the operator points xcsh at
				// THEIR OWN gateway with THEIR OWN token over a loopback-only, TLS,
				// Origin-checked bridge (extension-bridge `isAllowedBridgeOrigin`), https is
				// enforced here, and the token is session-only (never persisted to disk).
				const gatewayRoot = requireHttpsUrl(msg.baseUrl);
				const baseUrl = providerGatewayBaseUrl(gatewayRoot, provider);

				// baseUrl + apiKey, no models[] → sets the in-memory runtime API key AND
				// overrides the existing provider models' baseUrl/headers (reusing their
				// metadata). Nothing is persisted to disk.
				registry.authStorage.setRuntimeApiKey(provider, msg.token);
				registry.registerProvider(
					provider,
					{
						baseUrl,
						apiKey: msg.token,
					},
					"office-configure",
				);
			} else if (msg.token) {
				// Key-only: reuse the baked F5 gateway; set just the non-persistent runtime key.
				registry.authStorage.setRuntimeApiKey(provider, msg.token);
			}

			const model = registry.find(provider, modelId);
			if (!model) {
				throw new Error(`No model ${provider}/${modelId} available`);
			}
			// setModel validates the API key and throws if missing → becomes configure_error.
			await this.#session.setModel(model, "default", {
				selector: `${provider}/${modelId}`,
				thinkingLevel,
			});
			if (thinkingLevel) {
				this.#session.setThinkingLevel(thinkingLevel);
			}

			this.#server.send({ type: "configure_ack", model: model.id } satisfies ConfigureAck);
		} catch {
			// Collapse provider and validation details at the runtime boundary. The
			// Office pane needs only a stable recovery signal and must never receive
			// identity-bearing upstream error text.
			// Nack instead of throwing (set_host_tools parity): a client awaiting
			// configure_ack would otherwise hang on a bad frame or missing key.
			this.#server.send({
				type: "configure_error",
				reason: "configuration-rejected",
			} satisfies ConfigureError);
		}
	}

	#handleChatStop(stop: { id: string }): void {
		const chat = this.#activeChats.get(stop.id);
		if (!chat) return;
		this.#session.agent.abort();
	}

	/** Reply to `list_skills` with the session's live skills (name + description) so
	 *  the pane can populate the composer's Skills submenu. Pure read — skills are
	 *  already loaded on the session; the model actions them via the read tool + the
	 *  system prompt (Phase 2A enabled `read`), so this is enumeration only. */
	#handleListSkills(): void {
		// Shared projection: one place decides what crosses to a client (never paths).
		this.#server.send({ type: "skills", skills: toSkillSummaries(this.#session.skills) } satisfies SkillsList);
	}

	/** Reply with the curated Office models that resolve in the live registry. */
	#handleListModels(): void {
		const models = LITELLM_LOGIN_MODEL_CHOICES.filter(choice =>
			this.#session.modelRegistry.find(choice.provider, choice.modelId),
		).map(choice => ({ id: choice.modelId, label: choice.label }));
		const current = this.#session.model?.id;
		// A ready Office session normally always has an active model. During an
		// unconfigured startup there is no truthful `current` value to advertise, so
		// leave the selector empty until the next connection instead of inventing one.
		if (!current) return;
		this.#server.send({
			type: "models",
			current,
			models,
		} satisfies ModelsList);
	}

	/** Reply to `list_commands` with the session's file-based slash commands (name +
	 *  description) so the pane can populate the composer's `/` menu. Pure read — the
	 *  commands are already discovered; the template bodies never cross the wire. */
	#handleListCommands(): void {
		this.#server.send({
			type: "commands",
			commands: toSlashCommandSummaries(this.#session.slashCommands),
		} satisfies SlashCommandsList);
	}

	#sendTerminal(chat: ActiveChat, frame: ChatDone | ChatError): void {
		if (chat.terminalSent) return;
		chat.terminalSent = true;
		this.#server.send(frame);
	}

	/** True while a chat turn is in flight (streaming or an active request). Used by
	 * the worker's SIGTERM drain to let a running turn finish before teardown (#1874). */
	get busy(): boolean {
		return this.#activeChats.size > 0 || this.#session.isStreaming;
	}

	dispose(): void {
		this.#disposed = true;
		this.#pendingRequest = null; // abandon any queued prompt — don't replay into a dead session
		// Fail any in-flight host-tool call — the session is going away.
		this.#hostToolBridge.rejectAllPending("bridge disconnected before host tool completed");
		for (const chat of this.#activeChats.values()) {
			this.#sendTerminal(chat, {
				type: "chat_error",
				id: chat.id,
				reason: "session-disposed",
			});
			chat.unsubscribe();
		}
		this.#activeChats.clear();
	}
}

/** Native provider-side web-search descriptors supported by the Office surface.
 * Ordinary xcsh and Office host tools do not use this seam; they remain function
 * tools and are preserved by the agent's payload composer. */
export function officeWebSearchServerTools(modelApi: string): Record<string, unknown>[] {
	switch (modelApi) {
		case "anthropic-messages":
			return [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
		case "openai-completions":
			return [{ type: "web_search_preview" }];
		default:
			throw new Error(`Office web search is unsupported for model API ${modelApi}`);
	}
}

const OFFICE_GATEWAY_PROVIDER_PATHS = {
	anthropic: "/anthropic",
	litellm: "/api/v1",
} as const;

/** Derive the selected provider's API base from a normalized gateway root. */
export function providerGatewayBaseUrl(
	gatewayRoot: string,
	provider: keyof typeof OFFICE_GATEWAY_PROVIDER_PATHS,
): string {
	return `${gatewayRoot}${OFFICE_GATEWAY_PROVIDER_PATHS[provider]}`;
}

/** SSRF guard and backward-compatible root normalizer for the `configure` frame's
 * optional gateway URL. Saved full-path URLs are reduced to their HTTPS origin;
 * the selected model then determines the provider path. Loopback/private hosts are
 * intentionally allowed because the target is an operator-chosen internal gateway. */
export function requireHttpsUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`configure baseUrl is not a valid URL: ${raw}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`configure baseUrl must use https (got "${parsed.protocol}")`);
	}
	return parsed.origin;
}

/** Classify an upstream/provider error into the closed public reason vocabulary.
 * Token checks run before the generic 4xx check; unknown failures fail closed to
 * provider-5xx instead of crossing the runtime boundary as raw text. */
export function classifyChatErrorReason(message: string): ChatErrorReason {
	const m = message.toLowerCase();
	if (/\btoken\b[^.]*\b(expir|invalid)|\b(expir|invalid)[^.]*\btoken\b|aws sso|\/context (create|validate)/.test(m)) {
		return "token-expired";
	}
	if (
		/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|econnreset|etimedout|socket hang up|network error/.test(
			m,
		)
	) {
		return "provider-5xx";
	}
	if (/\b(?:401|403)\b|\bunauthorized\b|\bforbidden\b|\bapi key\b|\bauthentication\b|\bcredentials?\b/.test(m)) {
		return "provider-auth";
	}
	if (/\b4\d\d\b|forbidden|unauthorized|invalid model|bad request|not found|too many requests|rate limit/.test(m)) {
		return "provider-4xx";
	}
	return "provider-5xx";
}

/** Bases a user-attached context path must fall under. Confines grants to the user's
 *  own space (home, the project cwd, temp, external volumes, /opt) and thereby blocks
 *  a client from widening the sandbox to system/credential dirs (`/etc`, `/var`,
 *  `/usr`, `/System`, other users' homes, `/`). */
function contextPathAllowedBases(): string[] {
	const bases = [process.cwd(), "/tmp", "/private/tmp", "/Volumes", "/opt"];
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (home) bases.push(home);
	// Canonicalize with realpath so BOTH sides of the containment check are symlink-free
	// (a symlink base like /tmp→/private/tmp must compare against the real target).
	return bases.map(b => {
		try {
			return fs.realpathSync(b);
		} catch {
			return path.resolve(b);
		}
	});
}

/**
 * Canonicalize + validate the user-attached context paths BEFORE they widen the
 * sandbox or are named in the prompt. Rejects anything that isn't an absolute path
 * confined to {@link contextPathAllowedBases} (after collapsing `..`), and anything
 * carrying control characters (a prompt-injection vector). Deduped. This is the trust
 * boundary: the engine must not blindly grant a client-supplied path to its own
 * filesystem sandbox.
 */
export function sanitizeContextPaths(paths: string[]): string[] {
	const bases = contextPathAllowedBases();
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		if (typeof p !== "string" || p.length === 0 || /[\n\r\0]/.test(p) || !path.isAbsolute(p)) continue;
		// realpathSync resolves symlinks — a link INSIDE an allowed base that points out to
		// /etc canonicalizes to /etc and fails the containment check — AND requires the
		// path to exist, so a non-existent (typo'd/spoofed) attachment is skipped.
		let real: string;
		try {
			real = fs.realpathSync(p);
		} catch {
			continue;
		}
		const within = bases.some(base => real === base || real.startsWith(base + path.sep));
		if (!within || seen.has(real)) continue;
		seen.add(real);
		out.push(real);
	}
	return out;
}

/**
 * Append absolute context paths to the session's sandbox read-allowlist. In-memory
 * (`override`, never persisted) and deduped, so re-attaching a path is a no-op. The
 * sandbox-guard keys its policy cache on the allow-list, so the grant takes effect on
 * the model's next file tool call. Best-effort: a pre-init settings proxy is tolerated.
 * Callers MUST pass paths through {@link sanitizeContextPaths} first.
 */
export function grantSandboxPaths(paths: string[]): void {
	try {
		const current = (settings.get("sandbox.allowRead") as string[] | undefined) ?? [];
		const merged = Array.from(new Set([...current, ...paths]));
		if (merged.length !== current.length) settings.override("sandbox.allowRead", merged);
	} catch {
		/* settings not initialized (some SDK/test contexts) — the grant is best-effort */
	}
}

export function composeChatPrompt(
	text: string,
	context: PageContextSnapshot | null,
	mode: InteractionMode,
	host: ClientHost | null,
	contextPaths?: string[],
): string {
	const parts: string[] = [];

	// Host-aware self-awareness: the Chrome extension gets the browser panel prompt;
	// an Office add-in (excel/powerpoint/word) gets its document-assistant prompt. A
	// null/unannounced host falls back to the Chrome profile.
	const profile = hostProfile(host);
	parts.push(profile.systemPrompt);

	const promptHints = EXTENSION_CAPABILITIES.features.chat.promptHints;

	// Browser hosts ALSO get an interaction mode + the page-context block. Document
	// hosts get NEITHER: Office sends no page context and has no browser modes; its
	// tools + document state arrive at runtime via set_host_tools.
	if (profile.kind === "browser") {
		parts.push(
			[
				"[Published extension chat contract]",
				promptHints.role,
				promptHints.grounding,
				promptHints.referenceLinks,
				promptHints.toolUse,
			].join("\n"),
		);
		parts.push(`[Chat mode: ${mode}] ${promptHints.modes[mode]}`);
		if (context) composeBrowserPageContext(parts, context);
	}

	// User-attached local context paths (files/folders). They're granted to the
	// sandbox alongside this, so the model may read them on demand — tell it they exist.
	if (contextPaths && contextPaths.length > 0) {
		parts.push("");
		// JSON.stringify each path: an unambiguous, escaped boundary so a path can't
		// blur into surrounding prompt text (belt-and-suspenders — they're pre-sanitized).
		parts.push(
			`The user attached these local paths as context; read them with your tools (read/grep/bash) as needed:\n${contextPaths.map(p => `- ${JSON.stringify(p)}`).join("\n")}`,
		);
	}

	parts.push("");
	parts.push(text);
	return parts.join("\n");
}

/** Append the Chrome-only page-context block (interpreted page state + API body +
 * accessibility tree) to `parts`. Browser hosts only — Office sends no context. */
function composeBrowserPageContext(parts: string[], context: PageContextSnapshot): void {
	// Interpret the raw URL into structured page state (workspace, resource,
	// CRUD operation, namespace) using deterministic route-pattern matching
	// against console_ui.yaml — the LLM sees "origin_pool LIST in demo" not a
	// raw URL it must guess about.
	const pageState = interpretPageState(context.url, null, CONSOLE_ROUTES);

	parts.push("");
	parts.push(`[Page context — captured at ${new Date(context.capturedAt).toISOString()}]`);

	// Tenant + environment (the LLM knows WHICH tenant on WHICH environment).
	if (pageState.tenant || pageState.environment) {
		parts.push(`Tenant: ${pageState.tenant ?? "unknown"} (${pageState.environment ?? "unknown"} environment)`);
	}

	// Structured page state (the interpreted context the LLM acts on).
	if (pageState.operation === "login") {
		parts.push("Page: LOGIN — session expired or first login. The user is on the Keycloak authentication page.");
		parts.push(
			"Ask the user to authenticate directly in the browser. Never request, accept, or enter their username, password, token, or other authentication secret.",
		);
	} else if (pageState.resource) {
		const opLabel = pageState.operation.toUpperCase();
		const nsLabel = pageState.namespace ? ` in namespace "${pageState.namespace}"` : "";
		const nameLabel = pageState.resourceName ? ` — instance "${pageState.resourceName}"` : "";
		parts.push(`Page: ${pageState.resource} ${opLabel}${nameLabel} (workspace: ${pageState.workspace}${nsLabel})`);
	} else {
		parts.push(`Page: ${context.title} (unrecognized resource)`);
	}
	if (pageState.modalBlocking) {
		parts.push(`⚠ Modal blocking: ${pageState.modalText ?? "unknown overlay"}`);
	}
	parts.push(`URL: ${context.url}`);
	parts.push(`Title: ${context.title}`);

	if (context.api) {
		parts.push(
			`API resource (${context.api.resourceType ?? "unknown"}, status ${context.api.status}): ${context.api.url}`,
		);
		if (context.api.body) {
			const body =
				typeof context.api.body === "string" ? context.api.body : JSON.stringify(context.api.body, null, 2);
			parts.push(body);
		}
		if (context.api.truncated) {
			parts.push("[API body was truncated]");
		}
	}

	if (context.ax) {
		const ax = typeof context.ax === "string" ? context.ax : JSON.stringify(context.ax);
		parts.push(`Accessibility tree: ${ax}`);
	}

	if (context.truncated) {
		parts.push("[Page context was truncated]");
	}

	parts.push("---");
}

/** Panel-facing labels for provider-side tools, used for the activity rows (#2340). */
function serverToolLabels(toolName: string): { running: string; done: string } {
	switch (toolName) {
		case "web_search":
			return { running: "Searching the web", done: "Web search" };
		case "web_fetch":
			return { running: "Fetching a page", done: "Page fetch" };
		default:
			return { running: `${toolName}: running`, done: toolName };
	}
}
