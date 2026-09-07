// Gateway config surface (single-engine provider-configure flow)
export type { GatewayConfig, GatewayConfigInput, GatewayConfigStore } from "./gateway/config";
export {
	GatewayConfigError,
	MemoryGatewayConfigStore,
	normalizeGatewayConfig,
} from "./gateway/config";
// Host-tool dispatcher surface
export type { HostToolContext, HostToolHandler, HostToolRegistration } from "./host-tools";
export { HostToolDispatcher } from "./host-tools";
// Protocol surface (wire types re-homed onto the native xcsh contract)
export type {
	AgentToolResult,
	AssistantTurnItem,
	ChatDeltaMsg,
	ChatDoneMsg,
	ChatErrorMsg,
	ChatErrorReason,
	ChatImageMsg,
	ChatInboundMsg,
	ChatKeepaliveMsg,
	ChatMediaMsg,
	ChatMessageEndMsg,
	ChatMessageStartMsg,
	ChatRefWire,
	ChatRequestMsg,
	ChatStopMsg,
	ChatStreamMsg,
	ChatToolNoticeMsg,
	ConfigureAckMsg,
	ConfigureErrorMsg,
	ConfigureMsg,
	HostToolCallMsg,
	HostToolCancelMsg,
	HostToolDefinition,
	HostToolResultMsg,
	HostToolUpdateMsg,
	InteractionMode,
	ListCommandsMsg,
	ListModelsMsg,
	ListSkillsMsg,
	MediaAssetChunkMsg,
	MediaAssetErrorMsg,
	MediaAssetReadMsg,
	ModelInfo,
	ModelsListMsg,
	PathPickedMsg,
	PickPathMsg,
	SetHostToolsMsg,
	SkillInfo,
	SkillsListMsg,
	SlashCommandInfo,
	SlashCommandsListMsg,
	TurnState,
} from "./protocol";
export {
	CHAT_ERROR_REASONS,
	INTERACTION_MODES,
	initTurn,
	isChatDelta,
	isChatDone,
	isChatError,
	isChatKeepalive,
	isChatMedia,
	isChatMessageEnd,
	isChatMessageStart,
	isChatToolNotice,
	isConfigureAck,
	isConfigureError,
	isMediaAssetChunk,
	isMediaAssetError,
	isModelsList,
	isPathPicked,
	isSkillsList,
	isSlashCommandsList,
	reduceChatTurn,
} from "./protocol";
// Transport surface
export type {
	ChatInbound,
	ChatOutbound,
	ConfigurableTransport,
	LoopbackBridgeOptions,
	ProviderConfigure,
	Transport,
	WebSocketFactory,
} from "./transport";
export { LoopbackBridgeTransport, MockTransport } from "./transport";
export { CORE_CONTRACT_VERSION } from "./version";
