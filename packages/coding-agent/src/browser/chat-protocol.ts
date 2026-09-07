/**
 * Wire protocol types for the Chrome extension chat side window.
 * Contract source of truth: capabilities.json v2.2.0.
 */

import type { AssistantMessagePhase } from "@f5-sales-demo/pi-ai";
// Import the guards + wire types from the PURE leaf modules (not the `../host-tools`
// barrel), so this browser-safe contract can be consumed by a lib.dom (React)
// TypeScript program without pulling the RpcHostToolBridge's theme/tool-proxy graph.
import { isRpcHostToolResult, isRpcHostToolUpdate } from "../host-tools/guards";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "../host-tools/types";
import type { MediaAssetChunk, MediaAssetReadRequest } from "../media/transport";
import type { MediaDescriptorV1 } from "../media/types";

// The client host announced on the `hello` handshake (contract 1.10.0). Re-exported
// (type-only, fully erased) so browser-safe consumers — the office-pane bundle —
// can share the wire vocabulary without importing the host-profiles prompt data.
export type { ClientHost } from "./host-profiles";

// ---------------------------------------------------------------------------
// Page context snapshot (auto-attached by extension to every chat_request)
// ---------------------------------------------------------------------------

export interface PageContextApi {
	url: string;
	status: number;
	resourceType: string | null;
	body: unknown;
	truncated: boolean;
}

export interface PageContextSnapshot {
	v: 1;
	capturedAt: number;
	tabId: number;
	url: string;
	path: string;
	title: string;
	ax: unknown | null;
	api: PageContextApi | null;
	truncated: boolean;
}

// ---------------------------------------------------------------------------
// Interaction modes
// ---------------------------------------------------------------------------

export type InteractionMode = "educational" | "presentation" | "configuration" | "screenshot" | "annotation";

const VALID_MODES = new Set<string>(["educational", "presentation", "configuration", "screenshot", "annotation"]);

// ---------------------------------------------------------------------------
// References (attached to chat_done)
// ---------------------------------------------------------------------------

export interface ChatReference {
	kind: "doc" | "console";
	title: string;
	url: string;
}

// ---------------------------------------------------------------------------
// Inbound messages (extension → xcsh)
// ---------------------------------------------------------------------------

/** A photo/image attachment on a chat turn (Office `+` → "Add files or photos").
 *  Base64 vision content; the handler maps it to an `ImageContent` block fed to the
 *  vision-capable model. */
export interface ChatImage {
	/** Base64-encoded image bytes (no `data:` URL prefix). */
	data: string;
	/** MIME type — image/png | image/jpeg | image/gif | image/webp. */
	mimeType: string;
}

interface ChatRequestBase {
	type: "chat_request";
	id: string;
	text: string;
	context: PageContextSnapshot | null;
	mode: InteractionMode;
	history_hint?: string;
	/** Optional photo/image attachments, sent to the model as vision blocks. */
	images?: ChatImage[];
	/** Absolute local paths (files/folders) the user attached as context. The engine
	 *  grants them to the filesystem sandbox for the session and tells the model they
	 *  are available to read on demand. */
	contextPaths?: string[];
	/** When true, the engine adds the active model API's native server-side
	 *  web-search tool to this turn (the "Search the web" composer toggle). */
	web_search?: boolean;
}

/** Chrome contract 2 request. Routing is explicit and cannot be omitted. */
export interface BrowserChatRequest extends ChatRequestBase {
	tabId: number;
	sessionKey: string;
}

/** Office request. Identity and routing belong to the authenticated transport. */
export interface TransportChatRequest extends ChatRequestBase {}

export type ChatRequest = BrowserChatRequest | TransportChatRequest;

/** Client → engine: open a native OS file/folder picker on the machine running the
 *  bridge and return the chosen absolute path. */
export interface PickPath {
	type: "pick_path";
	mode: "file" | "folder";
}

/** Engine → client: the picker result. `path` is set on success; `canceled` when the
 *  user dismissed the dialog; `unsupported` when the platform has no native picker
 *  (the pane then falls back to manual path entry). */
export interface PathPicked {
	type: "path_picked";
	path?: string;
	canceled?: boolean;
	unsupported?: boolean;
}

/** Client → engine: enumerate the session's loaded skills for the composer's
 *  Skills submenu. Sent once after the pane connects. */
export interface ListSkills {
	type: "list_skills";
}

/** Client → engine: enumerate the curated models available to the Office pane. */
export interface ListModels {
	type: "list_models";
}

/** One model option surfaced in the Office composer's model selector. */
export interface ModelInfo {
	id: string;
	label: string;
}

/** Engine → client: available Office models and the active model id. */
export interface ModelsList {
	type: "models";
	current: string;
	models: ModelInfo[];
}

/** One skill surfaced to the pane's Skills submenu (name + human description). */
export interface SkillInfo {
	name: string;
	description: string;
}

/** Engine → client: the session's live skills, in load order. */
export interface SkillsList {
	type: "skills";
	skills: SkillInfo[];
}

/** Client → engine: enumerate the session's file-based slash commands for the
 *  composer's `/` menu. Sent once after the pane connects, beside `list_skills`. */
export interface ListCommands {
	type: "list_commands";
}

/**
 * One slash command surfaced to the pane's `/` menu.
 *
 * Deliberately NOT the command's `content`: that body is a prompt template which can run
 * to hundreds of lines, and the menu needs a label. It also keeps the plugin author's
 * instructions off the wire, where nothing reads them.
 */
export interface SlashCommandInfo {
	name: string;
	description: string;
}

/** Engine → client: the session's live slash commands, in load order. */
export interface SlashCommandsList {
	type: "commands";
	commands: SlashCommandInfo[];
}

export interface ChatStop {
	type: "chat_stop";
	id: string;
}

export interface MediaAssetRead extends MediaAssetReadRequest {
	type: "media_asset_read";
	requestId: string;
}

// ---------------------------------------------------------------------------
// Outbound messages (xcsh → extension)
// ---------------------------------------------------------------------------

export type { AssistantMessagePhase };

export interface ChatMessageStart {
	type: "chat_message_start";
	id: string;
	itemId: string;
	phase: AssistantMessagePhase;
}

export interface ChatDelta {
	type: "chat_delta";
	id: string;
	itemId: string;
	seq: number;
	delta: string;
}

export interface ChatMessageEnd {
	type: "chat_message_end";
	id: string;
	itemId: string;
	phase: AssistantMessagePhase;
}

export interface ChatDone {
	type: "chat_done";
	id: string;
	references?: ChatReference[];
}

/** Machine-readable cause of a terminal chat_error. Raw provider error text is
 * deliberately absent because it can carry identity-bearing response content. */
export const CHAT_ERROR_REASONS = [
	"bridge-disconnected", // the worker's bridge closed mid-turn
	"bridge-unresponsive", // the socket looked open but the worker never answered
	"no-worker", // no worker is running for this tab
	"session-busy", // a turn is already in flight for this session
	"session-disposed", // the worker session was torn down
	"token-expired", // F5 XC API token expired
	"token-expiring", // F5 XC API token is about to expire
	"provider-auth", // upstream provider rejected its credential
	"provider-4xx", // upstream provider rejected the request (client error)
	"provider-5xx", // upstream provider failed (server error) — retryable
] as const;

export type ChatErrorReason = (typeof CHAT_ERROR_REASONS)[number];

export interface ChatError {
	type: "chat_error";
	id: string;
	reason: ChatErrorReason;
}

/** Liveness signal: the worker is actively working the turn — e.g.
 * streaming model thinking — before any visible token. The panel treats it as
 * proof-of-life to re-arm its first-token timer, so a long legitimate think isn't
 * mistaken for a dead worker. Carries no renderable content. */
export interface ChatKeepalive {
	type: "chat_keepalive";
	id: string;
}

export interface ChatMedia {
	type: "chat_media";
	id: string;
	media: MediaDescriptorV1;
}

export interface MediaAssetChunkMessage {
	type: "media_asset_chunk";
	requestId: string;
	chunk: MediaAssetChunk;
}

export interface MediaAssetError {
	type: "media_asset_error";
	requestId: string;
	error: "asset-unavailable";
}

// ---------------------------------------------------------------------------
// Host-tool channel
//
// The host-tool channel lets the agent delegate a registered tool's execution
// to whatever host is driving the WS bridge (the chrome extension, an Office
// add-in, etc.). The frames are FIELD-IDENTICAL to the transport-neutral
// `RpcHostTool*` vocabulary (`src/host-tools/`), so they are re-exported here
// rather than redeclared — one vocabulary across every transport, no drift.
//
// CRITICAL: `host_tool_result.result` and `host_tool_update.partialResult` are
// `AgentToolResult` values — a `content[]` array — NOT a `{ data }` object. The
// guards below delegate to the neutral `isRpcHostToolResult`/`isRpcHostToolUpdate`,
// which require `content` to be an array.
// ---------------------------------------------------------------------------

/** A host-tool definition advertised by the client via `set_host_tools`. */
export type HostToolDefinition = RpcHostToolDefinition;

/** Inbound: the client registers the host tools it can execute. */
export interface SetHostTools {
	type: "set_host_tools";
	tools: HostToolDefinition[];
}

/** Outbound: the agent asks the client to execute a registered host tool. */
export type HostToolCall = RpcHostToolCallRequest;

/** Outbound: the agent aborts a pending host-tool call. */
export type HostToolCancel = RpcHostToolCancelRequest;

/** Inbound: the client streams a partial `AgentToolResult` for a pending call. */
export type HostToolUpdate = RpcHostToolUpdate;

/** Inbound: the client completes a pending call with an `AgentToolResult`. */
export type HostToolResult = RpcHostToolResult;

/** Outbound: acks a `set_host_tools` registration so the client can await it
 * before sending its first prompt. Carries the names actually registered. */
export interface SetHostToolsAck {
	type: "set_host_tools_ack";
	toolNames: string[];
}

/** Outbound: nacks a `set_host_tools` registration that failed to normalize (bad
 * definition, name conflict). Emitted instead of the ack so a client awaiting
 * registration gets a clear error rather than hanging (stdio-parity nack). */
export interface SetHostToolsError {
	type: "set_host_tools_error";
	reason: "host-tools-rejected";
}

// ---------------------------------------------------------------------------
// Office provider configuration channel
//
// Lets the office-xcsh add-in configure xcsh's LLM provider at runtime after the
// socket is connected, without restarting the worker or persisting the token.
// Contract-2 Chrome clients have no credential-configuration interface. Single
// config in-flight, so — like `set_host_tools` — there is no `id` correlation
// field. Mirrors the set_host_tools ack/nack shape exactly.
// ---------------------------------------------------------------------------

/** Inbound: the client configures credentials, selects a model, or both.
 * `baseUrl` is a gateway root and requires a non-empty `token`; xcsh derives its
 * provider path from `model`. A model-only frame reuses xcsh's existing provider
 * credentials. Runtime credentials are never written to disk. */
export interface Configure {
	type: "configure";
	baseUrl?: string;
	token?: string;
	model?: string;
}

/** Outbound: acks a `configure` with the model id actually selected, so the
 * client can await configuration before its first prompt. */
export interface ConfigureAck {
	type: "configure_ack";
	model: string;
}

/** Outbound: nacks a `configure` that failed (bad frame, unknown model, missing
 * API key). The fixed reason prevents provider text from crossing the bridge. */
export interface ConfigureError {
	type: "configure_error";
	reason: "configuration-rejected";
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function hasChatIdPrefix(id: unknown): id is string {
	return typeof id === "string" && id.startsWith("c-");
}

/** Optional `images` must be absent or an array of `{ data:string; mimeType:string }`. */
function isValidChatImages(v: unknown): boolean {
	if (v === undefined) return true;
	if (!Array.isArray(v)) return false;
	return v.every(x => {
		if (typeof x !== "object" || x === null) return false;
		const img = x as Record<string, unknown>;
		return typeof img.data === "string" && typeof img.mimeType === "string";
	});
}

function isChatRequestBase(msg: unknown): msg is ChatRequestBase {
	if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
	const candidate = msg as Record<string, unknown>;
	return (
		candidate.type === "chat_request" &&
		hasChatIdPrefix(candidate.id) &&
		typeof candidate.text === "string" &&
		typeof candidate.mode === "string" &&
		VALID_MODES.has(candidate.mode) &&
		isValidChatImages(candidate.images)
	);
}

export function isBrowserChatRequest(msg: unknown): msg is BrowserChatRequest {
	return (
		isChatRequestBase(msg) &&
		"tabId" in msg &&
		typeof msg.tabId === "number" &&
		Number.isFinite(msg.tabId) &&
		"sessionKey" in msg &&
		typeof msg.sessionKey === "string" &&
		msg.sessionKey.length > 0
	);
}

export function isTransportChatRequest(msg: unknown): msg is TransportChatRequest {
	return isChatRequestBase(msg) && !("tabId" in msg) && !("sessionKey" in msg);
}

export function isChatStop(msg: Record<string, unknown>): boolean {
	return msg.type === "chat_stop" && hasChatIdPrefix(msg.id);
}

export function isMediaAssetRead(msg: Record<string, unknown>): msg is Record<string, unknown> & MediaAssetRead {
	return (
		msg.type === "media_asset_read" &&
		typeof msg.requestId === "string" &&
		msg.requestId.length > 0 &&
		typeof msg.ref === "string" &&
		(msg.offset === undefined || (Number.isSafeInteger(msg.offset) && Number(msg.offset) >= 0)) &&
		(msg.length === undefined || (Number.isSafeInteger(msg.length) && Number(msg.length) > 0))
	);
}

export function isListSkills(msg: Record<string, unknown>): boolean {
	return msg.type === "list_skills";
}

export function isListCommands(msg: Record<string, unknown>): boolean {
	return msg.type === "list_commands";
}

export function isPickPath(msg: Record<string, unknown>): boolean {
	return msg.type === "pick_path" && (msg.mode === "file" || msg.mode === "folder");
}

export function isSetHostTools(msg: Record<string, unknown>): boolean {
	return msg.type === "set_host_tools" && Array.isArray(msg.tools);
}

export function isListModels(msg: Record<string, unknown>): boolean {
	return msg.type === "list_models";
}

/** True for a well-formed `configure` frame. At least a non-empty token or model is
 * required, and a gateway root may never be sent without its token. */
export function isConfigure(msg: Record<string, unknown>): boolean {
	const hasToken = typeof msg.token === "string" && msg.token.trim().length > 0;
	const hasModel = typeof msg.model === "string" && msg.model.trim().length > 0;
	return (
		msg.type === "configure" &&
		(hasToken || hasModel) &&
		(msg.token === undefined || typeof msg.token === "string") &&
		(msg.baseUrl === undefined || typeof msg.baseUrl === "string") &&
		(msg.model === undefined || typeof msg.model === "string") &&
		(msg.baseUrl === undefined || hasToken)
	);
}

/** Delegates to the neutral guard, which requires `result.content` to be an array. */
export function isHostToolResult(msg: Record<string, unknown>): boolean {
	return isRpcHostToolResult(msg);
}

/** Delegates to the neutral guard, which requires `partialResult.content` to be an array. */
export function isHostToolUpdate(msg: Record<string, unknown>): boolean {
	return isRpcHostToolUpdate(msg);
}
