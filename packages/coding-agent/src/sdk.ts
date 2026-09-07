import * as os from "node:os";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	INTENT_FIELD,
	type ThinkingLevel,
} from "@f5-sales-demo/pi-agent-core";
import { type Message, type Model, streamSimple } from "@f5-sales-demo/pi-ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@f5-sales-demo/pi-ai/providers/openai-codex-responses";
import type { Component } from "@f5-sales-demo/pi-tui";
import {
	$env,
	$flag,
	getAgentDbPath,
	getAgentDir,
	getLocale,
	getLocaleDisplayName,
	getProjectDir,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@f5-sales-demo/pi-utils";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "./async";
import { createAutoresearchExtension } from "./autoresearch";
import { getBundledRules } from "./bundled-rules";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability } from "./capability/rule";
import { hasLiteLLMEnv } from "./config/auto-config";
import { ModelRegistry } from "./config/model-registry";
import {
	defaultModelPerProvider,
	formatModelString,
	parseModelPattern,
	parseModelString,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { Settings, type SkillsSettings } from "./config/settings";
import { ContextProfileCollector } from "./context/profile";
import { CursorExecHandlers } from "./cursor";
import "./discovery";
import { resolveConfigValue } from "./config/resolve-config-value";
import { initializeWithSettings } from "./discovery";
import { listXcshPluginRoots } from "./discovery/helpers";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverAndLoadCustomTools } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import { CustomToolAdapter } from "./extensibility/custom-tools/wrapper";
import {
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	InternalDocsProtocolHandler,
	InternalUrlRouter,
	JobsProtocolHandler,
	LocalProtocolHandler,
	McpProtocolHandler,
	MemoryProtocolHandler,
	RuleProtocolHandler,
	SkillProtocolHandler,
} from "./internal-urls";
import { createLiveCwdGetter } from "./internal-urls/fleet-resolve";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./ipy/executor";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp";
import {
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableMCPTools,
} from "./mcp/discoverable-tool-metadata";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot, startMemoryStartupTask } from "./memories";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import { containmentStatus } from "./sandbox/containment";
import { resolveSessionFence } from "./sandbox/session-fence";
import {
	builtinCredentialSecretEntries,
	collectEnvSecrets,
	deobfuscateSessionContext,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	SECRET_ENV_PATTERNS,
	type SecretEntry,
	SecretObfuscator,
} from "./secrets";
import { createContextEnv } from "./services/context-env";
import { buildActiveModelSnapshot, type ModelResolutionSource } from "./session/active-model";
import { AgentSession } from "./session/agent-session";
import { AuthStorage } from "./session/auth-storage";
import { convertToLlm } from "./session/messages";
import { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	buildAgentsMdSearch,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	discoverStartupLspServers,
	EditTool,
	FindTool,
	GrepTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isSearchProviderPreference,
	type LspStartupServerInfo,
	loadSshTool,
	PythonTool,
	ReadTool,
	ResolveTool,
	renderSearchToolBm25Description,
	SearchToolBm25Tool,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { ToolContextStore } from "./tools/context";
import { getGeminiImageTools } from "./tools/gemini-image";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { queueResolveHandler } from "./tools/resolve";
import { EventBus } from "./utils/event-bus";
import { buildNamedToolChoice } from "./utils/tool-choice";

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Named F5 XC context to bind explicitly for this session. */
	contextName?: string;
	/** Manager-provided tenant binding. Default: XCSH_SESSION_TENANT. */
	sessionTenant?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** How `model` was chosen, reported by xcsh://about. Default: "config". */
	modelResolutionSource?: ModelResolutionSource;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** System prompt. String replaces default, function receives default and returns final. */
	systemPrompt?: string | ((defaultPrompt: string) => string);
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Bundled extensions to load even when discovery is disabled (e.g.
	 * `["sandbox-guard"]`). Lets a headless session keep the CLI's filesystem
	 * safety net without paying for full discovery.
	 */
	bundledExtensions?: string[];
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (XCSH.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip Python kernel availability check and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Force Python prelude warmup even when test env would normally skip it */
	forcePythonWarmup?: boolean;

	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/** Environment values scanned for automatic secret masking. Default: process.env. */
	secretEnvironment?: Readonly<Record<string, string | undefined>>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;

	/** Opaque fuzzy-search database handle (fork-specific). */
	searchDb?: unknown;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	FindTool,
	GrepTool,
	HIDDEN_TOOLS,
	loadSshTool,
	PythonTool,
	ReadTool,
	ResolveTool,
	type ToolSession,
	WriteTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .codex).
 */
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const dbPath = getAgentDbPath(agentDir);
	logger.debug("discoverAuthStorage", { agentDir, dbPath });

	const storage = await AuthStorage.create(dbPath, { configValueResolver: resolveConfigValue });
	await storage.reload();
	return storage;
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (XCSH.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	appendPrompt?: string;
	repeatToolDescriptions?: boolean;
}

/**
 * Build the default system prompt.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		repeatToolDescriptions: options.repeatToolDescriptions,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@f5-sales-demo/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: 'You are helpful.',
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerPythonCleanup();

	const settings = options.settings ?? (await logger.time("settings", Settings.init, { cwd, agentDir }));

	// Use provided or create AuthStorage and ModelRegistry
	const authStorage = options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir));
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(authStorage, undefined, { getProviderOrder: () => settings.get("modelProviderOrder") });

	const configuredContextLoadingMode = settings.get("context.loadingMode");
	const resolveContextLoadingMode = (candidate: Model | undefined): "eager" | "progressive" =>
		configuredContextLoadingMode === "progressive" ||
		(options.toolNames === undefined && candidate?.provider === "anthropic" && modelRegistry.isUsingOAuth(candidate))
			? "progressive"
			: "eager";
	let contextLoadingMode = resolveContextLoadingMode(options.model);
	logger.time("initializeWithSettings");
	initializeWithSettings(settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? discoverSkills(cwd, agentDir, { ...skillsSettings, disabledExtensions: disabledExtensionIds })
			: undefined;

	// Initialize provider preferences from settings
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (imageProvider === "auto" || imageProvider === "gemini" || imageProvider === "openrouter") {
		setPreferredImageProvider(imageProvider);
	}

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const modelApiKeyAvailability = new Map<string, boolean>();
	const getModelAvailabilityKey = (candidate: Model): string =>
		`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
	const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
		const availabilityKey = getModelAvailabilityKey(candidate);
		const cached = modelApiKeyAvailability.get(availabilityKey);
		if (cached !== undefined) {
			return cached;
		}

		const hasKey = !!(await modelRegistry.getApiKey(candidate, providerSessionId));
		modelApiKeyAvailability.set(availabilityKey, hasKey);
		return hasKey;
	};

	// Load and create secret obfuscator early so resumed session state and prompt warnings
	// reflect actual loaded secrets, not just the setting toggle.
	// Env-based secrets are always collected (hardcoded masking — no opt-in required).
	// File-based secrets (secrets.yml) remain opt-in behind the secrets.enabled setting.
	let obfuscator: SecretObfuscator | undefined;
	{
		// Collect context-sensitive values (context loads before session in main.ts).
		let contextSensitiveValues: string[] | undefined;
		try {
			const { ContextService } = await import("./services/xcsh-context");
			contextSensitiveValues = ContextService.getSensitiveContextValues();
		} catch {
			// ContextService not initialized — skip (SDK consumers, tests, etc.)
		}
		// Scan both process.env AND bash.environment (context-injected values)
		// for env vars matching sensitive name patterns.
		const bashEnv = (settings.get("bash.environment") ?? {}) as Record<string, string>;
		const envEntries = collectEnvSecrets({
			environment: options.secretEnvironment,
			additionalEnv: bashEnv,
			additionalValues: contextSensitiveValues,
		});
		let fileEntries: SecretEntry[] = [];
		if (settings.get("secrets.enabled")) {
			fileEntries = await logger.time("loadSecrets", loadSecrets, cwd, agentDir);
		}
		// File entries MUST come first to preserve placeholder index stability
		// for resumed sessions that persisted #HASH# tokens from secrets.yml.
		const builtinEntries = settings.get("secrets.enabled") ? builtinCredentialSecretEntries() : [];
		const allEntries = [...fileEntries, ...envEntries, ...builtinEntries];
		if (allEntries.length > 0) {
			obfuscator = new SecretObfuscator(allEntries);
		}
	}
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	// Capture ContextService reference for sync consumers (e.g., InternalDocsProtocolHandler's
	// getContextStatus getter below). Null when ContextService isn't available (SDK consumers, tests).
	let contextServiceRef: typeof import("./services/xcsh-context").ContextService | null = null;
	let knowledgeServiceRef: typeof import("./services/xcsh-knowledge").KnowledgeService | null = null;

	// Capture ContextService reference for sync consumers (rebuildSystemPrompt context resolution,
	// InternalDocsProtocolHandler getContextStatus). The context-change listener itself is
	// registered later, atomically with its addDisposeHook cleanup, AFTER session construction
	// succeeds — registering it here would leak on createAgentSession failures.
	try {
		const { ContextService } = await import("./services/xcsh-context");
		contextServiceRef = ContextService;
	} catch {
		// ContextService not available (SDK consumers, tests). Skip.
	}
	try {
		const { KnowledgeService } = await import("./services/xcsh-knowledge");
		const { getXCSHConfigDir } = await import("@f5-sales-demo/pi-utils");
		knowledgeServiceRef = KnowledgeService;
		if (!KnowledgeService._hasInstance()) {
			KnowledgeService.init(getXCSHConfigDir());
			KnowledgeService.instance.loadCache();
		}
	} catch {
		// KnowledgeService not available — skip.
	}

	// Check if session has existing data to restore
	const existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);

	// --- Session-scoped context bootstrap ------------------------------------
	// No context is auto-loaded at startup. The session decides: a RESUMED session
	// re-activates the context recorded in its context_change log; a NEW session
	// smart-auto-binds (folder-local, else the single context, else ask). Loading
	// is via the existing activate(); auth is validated but never blocks resume.
	try {
		const { ContextService } = await import("./services/xcsh-context");
		const { resolveAutoBind, chooseSessionContext, activateTenantContext, shouldRunSessionContextBootstrap } =
			await import("./services/session-context-binding");
		const svc = ContextService.instance; // inited in main.ts (throws for SDK/tests → caught)
		// A pre-warmed spare (XCSH_WORKER_SPARE=1) skips the bootstrap entirely and
		// stays contextless until its IPC bind activates the correct tenant — see
		// shouldRunSessionContextBootstrap. Cold workers and interactive CLI are
		// unchanged (they have no spare marker).
		if (
			shouldRunSessionContextBootstrap({
				XCSH_API_URL: process.env.XCSH_API_URL,
				XCSH_WORKER_SPARE: process.env.XCSH_WORKER_SPARE,
			})
		) {
			const bound = existingSession.activeContextName; // resumed binding, if any
			const tenantKey = options.sessionTenant ?? process.env.XCSH_SESSION_TENANT;
			if (options.contextName) {
				await svc.activate(options.contextName); // fires onContextChange → records context_change
				await svc.validateToken();
			} else if (tenantKey) {
				// Extension worker: match a context to this worker's tenant (shared with pool late-bind).
				try {
					await activateTenantContext(tenantKey, bound);
				} catch (err) {
					// Context deleted since last use, or auth failed → surface, never block.
					logger.warn("XCSH: session context bootstrap could not fully activate", {
						tenantKey,
						error: String(err),
					});
				}
			} else {
				const contexts = await svc.listContexts();
				const available = contexts.map(c => c.name);
				const folderContext = await svc.resolveFolderContextName(cwd);
				const autoBind = resolveAutoBind({ kind: "cli", availableContexts: available, folderContext });
				const choice = chooseSessionContext(bound, autoBind);
				if ("activate" in choice) {
					try {
						await svc.activate(choice.activate); // fires onContextChange → records context_change
						await svc.validateToken(); // authenticate; non-blocking
					} catch (err) {
						// Context deleted since last use, or auth failed → surface, never block.
						logger.warn("XCSH: session context bootstrap could not fully activate", {
							context: choice.activate,
							error: String(err),
						});
					}
				}
				// choice.needsSelection / choice.none → leave unbound; the /context status
				// line and tools already prompt "run /context activate".
			}
		}
	} catch (error) {
		if (options.contextName) throw error;
		// ContextService not initialized (SDK consumers / tests) — skip bootstrap.
	}

	const existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	// When LiteLLM is configured and no model cache exists yet (first run),
	// await the background refresh so model discovery from the proxy completes
	// before we select a default model. Bounded by the 3s probe timeout.
	if (!options.modelRegistry && hasLiteLLMEnv() && modelRegistry.hasUncachedDiscoverableProviders()) {
		await logger.time("awaitLiteLLMDiscovery", () => modelRegistry.awaitBackgroundRefresh());
	}

	const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), modelRegistry.getAvailable(), {
			settings,
			matchPreferences: modelMatchPreferences,
			modelRegistry,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	// If session has data, try to restore model from it.
	// Skip restore when an explicit model was requested.
	const defaultModelStr = existingSession.models.default;
	if (!hasExplicitModel && !model && hasExistingSession && defaultModelStr) {
		await logger.time("restoreSessionModel", async () => {
			const parsedModel = parseModelString(defaultModelStr);
			if (parsedModel) {
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && (await hasModelApiKey(restoredModel))) {
					model = restoredModel;
				}
			}
			if (!model) {
				modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	let thinkingLevel = options.thinkingLevel;

	// If session has data and includes a thinking entry, restore it
	if (thinkingLevel === undefined && hasExistingSession && hasThinkingEntry) {
		thinkingLevel = parseThinkingLevel(existingSession.thinkingLevel);
	}

	if (thinkingLevel === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
		thinkingLevel = defaultRoleSpec.thinkingLevel;
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settings.get("defaultThinkingLevel");
	}
	if (model) {
		const resolvedModel = model;
		thinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			resolveThinkingLevelForModel(resolvedModel, thinkingLevel),
		);
	}
	contextLoadingMode = resolveContextLoadingMode(model);
	const toolSettings = new Proxy(settings, {
		get(target, property) {
			if (property === "get") {
				return (path: Parameters<typeof settings.get>[0]) =>
					path === "context.loadingMode" ? contextLoadingMode : settings.get(path);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await logger.time(
			"discoverSkills",
			() => discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }),
		);
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const { ttsrManager, rulebookRules, alwaysApplyRules } = await logger.time("discoverTtsrRules", async () => {
		const ttsrSettings = settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings);
		const rulesResult =
			options.rules !== undefined
				? { items: options.rules, warnings: undefined }
				: await loadCapability<Rule>(ruleCapability.id, { cwd });
		const rulebookRules: Rule[] = [];
		const alwaysApplyRules: Rule[] = [];
		for (const rule of rulesResult.items) {
			const isTtsrRule = rule.condition && rule.condition.length > 0 ? ttsrManager.addRule(rule) : false;
			if (isTtsrRule) {
				continue;
			}
			if (rule.alwaysApply === true) {
				alwaysApplyRules.push(rule);
				continue;
			}
			if (rule.description) {
				rulebookRules.push(rule);
			}
		}
		if (existingSession.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
		}
		return { ttsrManager, rulebookRules, alwaysApplyRules };
	});

	const contextFiles = await logger.time(
		"discoverContextFiles",
		async () => options.contextFiles ?? (await discoverContextFiles(cwd, agentDir)),
	);

	// Walk the CWD for nested XCSH.md ONCE per session — the walk is bounded but not
	// free, so hoisting it here keeps every tool-refresh prompt rebuild off the tree
	// (a large cwd like $HOME must never re-stall on set_host_tools). #2245.
	const agentsMdSearch = await logger.time("buildAgentsMdSearch", buildAgentsMdSearch, cwd);

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	// LSP is opt-in: a language server initialized against a very large workspace
	// (e.g. terraform-ls on a multi-repo tree) can stream unbounded output that is
	// buffered without limit and exhausts process memory (OOM). `lsp.enabled` is
	// the master switch — it gates the startup warmup and write/edit diagnostics.
	const enableLsp = options.enableLsp ?? settings.get("lsp.enabled") ?? false;
	const backgroundJobsEnabled = isBackgroundJobSupportEnabled(settings);
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	const asyncJobManager = backgroundJobsEnabled
		? new AsyncJobManager({
				maxRunningJobs: asyncMaxJobs,
				onJobComplete: async (jobId, result, job) => {
					if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
					const formattedResult = await formatAsyncResultForFollowUp(result);
					if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

					const message = prompt.render(asyncResultTemplate, { jobId, result: formattedResult });
					const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
					await session.sendCustomMessage(
						{
							customType: "async-result",
							content: message,
							display: true,
							attribution: "agent",
							details: {
								jobId,
								type: job?.type,
								label: job?.label,
								durationMs,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			})
		: undefined;

	const pythonKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		const toolSession: ToolSession = {
			cwd,
			hasUI: options.hasUI ?? false,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames
					? [...new Set(options.toolNames.map(name => name.toLowerCase()))]
					: undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			forcePythonWarmup: options.forcePythonWarmup,
			contextFiles,
			skills,
			eventBus,
			outputSchema: options.outputSchema,
			requireSubmitResultTool: options.requireSubmitResultTool,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			mediaBlobStore: sessionManager.getBlobStore(),
			appendMediaMessage: message => {
				agent.appendMessage(message);
				sessionManager.appendMessage(message);
			},
			getPythonKernelOwnerId: () => pythonKernelOwnerId,
			assertPythonExecutionAllowed: () => session?.assertPythonExecutionAllowed(),
			trackPythonExecution: (execution, abortController) =>
				session ? session.trackPythonExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getPlanModeState: () => session.getPlanModeState(),
			getCompactContext: () => session.formatCompactContext(),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
			getDiscoverableMCPTools: () => session.getDiscoverableMCPTools(),
			getDiscoverableMCPSearchIndex: () => session.getDiscoverableMCPSearchIndex(),
			getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
			activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
			getActiveTools: () => session.getActiveToolNames(),
			getDiscoverableTools: () => session.getDiscoverableTools(),
			getDiscoverableToolSearchIndex: () => session.getDiscoverableToolSearchIndex(),
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			settings: toolSettings,
			authStorage,
			modelRegistry,
			asyncJobManager,
		};

		// Initialize internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, local://)
		const internalRouter = new InternalUrlRouter();
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		internalRouter.register(new AgentProtocolHandler({ getArtifactsDir }));
		internalRouter.register(new ArtifactProtocolHandler({ getArtifactsDir }));
		internalRouter.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => getMemoryRoot(agentDir, settings.getCwd()),
			}),
		);
		internalRouter.register(
			new LocalProtocolHandler({
				getArtifactsDir,
				getSessionId: () => sessionManager.getSessionId(),
			}),
		);
		internalRouter.register(
			new SkillProtocolHandler({
				getSkills: () => skills,
			}),
		);
		internalRouter.register(
			new RuleProtocolHandler({
				getRules: () => [...getBundledRules(), ...rulebookRules, ...alwaysApplyRules],
			}),
		);
		internalRouter.register(
			new InternalDocsProtocolHandler({
				getContextStatus: () => {
					try {
						return contextServiceRef?.instance?.getStatus() ?? null;
					} catch {
						// ContextService.instance throws if not initialized; ignore.
						return null;
					}
				},
				// Read live rather than captured, for the same reason as the model: `--no-sandbox` and
				// `sandbox.enabled` are per-session, so the answer must reflect this session (#2554).
				getContainment: () => {
					const fence = resolveSessionFence(process.cwd(), settings);
					return containmentStatus(fence !== undefined, process.platform, undefined, fence);
				},
				// Read live rather than captured: `session.model` is a read-through to agent state, so a
				// mid-session Ctrl+P switch shows up on the next xcsh://about read (#2459).
				getActiveModel: () =>
					buildActiveModelSnapshot({
						model: session?.model,
						resolutionSource: session?.modelResolutionSource ?? "config",
						roles: {
							smol: settings.getModelRole("smol"),
							slow: settings.getModelRole("slow"),
							plan: settings.getModelRole("plan"),
						},
					}),
				getPluginRoots: () => listXcshPluginRoots(os.homedir(), cwd).then(r => r.roots),
				// Classification follows explicit session relocation events, not command-local `cd` and not the
				// process cwd. Model bash calls reset to this session root on every invocation (#2724).
				fleetDeps: { cwd: createLiveCwdGetter(cwd, eventBus) },
			}),
		);
		internalRouter.register(new JobsProtocolHandler({ getAsyncJobManager: () => asyncJobManager }));
		internalRouter.register(new McpProtocolHandler({ getMcpManager: () => mcpManager }));
		toolSession.internalRouter = internalRouter;
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);
		const providerToolPolicyAvailable =
			options.toolNames === undefined &&
			configuredContextLoadingMode === "eager" &&
			(modelRegistry.authStorage?.hasOAuth("anthropic") ?? false);
		const injectedProviderDiscoveryTool =
			providerToolPolicyAvailable && !builtinTools.some(tool => tool.name === "search_tool_bm25");
		if (injectedProviderDiscoveryTool) {
			builtinTools.push(new SearchToolBm25Tool(toolSession));
		}

		// Discover MCP tools from .mcp.json files
		let mcpManager: MCPManager | undefined;
		const enableMCP = options.enableMCP ?? true;
		const customTools: CustomTool[] = [];
		if (enableMCP) {
			const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
				onConnecting: serverNames => {
					if (serverNames.length > 0) {
						logger.debug("Connecting to MCP servers", { servers: serverNames });
					}
				},
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				// Always filter Exa - we have native integration
				filterExa: true,
				// Filter browser MCP servers when builtin browser tool is active
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			});
			mcpManager = mcpResult.manager;
			toolSession.mcpManager = mcpManager;

			if (settings.get("mcp.notifications")) {
				mcpManager.setNotificationsEnabled(true);
			}
			// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
			if (mcpResult.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
				Bun.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
			}

			// Log MCP errors
			for (const { path, error } of mcpResult.errors) {
				logger.error("MCP tool load failed", { path, error });
			}

			if (mcpResult.tools.length > 0) {
				// MCP tools are LoadedCustomTool, extract the tool property
				customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
			}
		}

		// This is a bundled capability, so an explicit tool scope must govern it just
		// like createTools() governs the built-ins. In particular, --no-tools passes
		// an empty list and must not expose generate_image merely because credentials exist.
		const imageToolRequested =
			options.toolNames === undefined || options.toolNames.some(name => name.toLowerCase() === "generate_image");
		if (imageToolRequested) {
			const geminiImageTools = await logger.time("getGeminiImageTools", getGeminiImageTools);
			if (geminiImageTools.length > 0) {
				customTools.push(...(geminiImageTools as unknown as CustomTool[]));
			}
		}

		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			customTools.push(...getSearchTools());
		}

		// Discover and load custom tools from .omp/tools/, .xcsh/tools/, etc.
		const builtInToolNames = builtinTools.map(t => t.name);
		const discoveredCustomTools = await logger.time(
			"discoverAndLoadCustomTools",
			discoverAndLoadCustomTools,
			[],
			cwd,
			builtInToolNames,
			action => queueResolveHandler(toolSession, action),
		);
		for (const { path, error } of discoveredCustomTools.errors) {
			logger.error("Custom tool load failed", { path, error });
		}
		if (discoveredCustomTools.tools.length > 0) {
			customTools.push(...discoveredCustomTools.tools.map(loaded => loaded.tool));
		}

		const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
		inlineExtensions.push(createAutoresearchExtension);
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}

		// Load extensions (discovers from standard locations + configured paths)
		let extensionsResult: LoadExtensionsResult;
		if (options.preloadedExtensions) {
			extensionsResult = options.preloadedExtensions;
		} else if (options.disableExtensionDiscovery) {
			const configuredPaths = options.additionalExtensionPaths ?? [];
			extensionsResult = await logger.time(
				"loadExtensions",
				loadExtensions,
				configuredPaths,
				cwd,
				eventBus,
				options.bundledExtensions ?? [],
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			// Merge CLI extension paths with settings extension paths
			const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
			const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
			extensionsResult = await logger.time(
				"discoverAndLoadExtensions",
				discoverAndLoadExtensions,
				configuredPaths,
				cwd,
				eventBus,
				disabledExtensionIds,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}

		// Load inline extensions from factories
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}

		// Resolve deferred --model pattern now that extension models are registered.
		if (!model && options.modelPattern) {
			await logger.time("awaitExplicitModelDiscovery", () => modelRegistry.awaitBackgroundRefresh());
			const availableModels = modelRegistry.getAll();
			const matchPreferences = {
				usageOrder: settings.getStorage()?.getModelUsageOrder(),
			};
			const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences, {
				modelRegistry,
			});
			if (resolved) {
				model = resolved;
				modelFallbackMessage = undefined;
			} else {
				modelFallbackMessage = `Model "${options.modelPattern}" not found`;
			}
		}

		// Fall back to first available model with a valid API key.
		// Skip fallback if the user explicitly requested a model via --model that wasn't found.
		if (!model && !options.modelPattern) {
			// Scope automatic selection to providers the user has actually configured
			// in models.yml. This keeps a stray credential for an unconfigured provider
			// (e.g. an expired AWS_PROFILE that makes Bedrock look "authenticated") from
			// ever being selected, and stops us probing the entire bundled catalog. A
			// fresh install (nothing configured) falls straight through to /login guidance
			// instead of walking legacy catalog entries the proxy can't serve.
			const configuredProviders = modelRegistry.getConfiguredProviderIds();
			const candidates =
				configuredProviders.size > 0
					? modelRegistry.getAll().filter(candidate => configuredProviders.has(candidate.provider))
					: [];
			// Within a configured provider, prefer its designated default model over raw
			// catalog order (which begins at legacy ids like claude-3-5-sonnet-20240620).
			const isProviderDefault = (candidate: Model): boolean =>
				defaultModelPerProvider[candidate.provider as keyof typeof defaultModelPerProvider] === candidate.id;
			const orderedCandidates = [
				...candidates.filter(isProviderDefault),
				...candidates.filter(candidate => !isProviderDefault(candidate)),
			];
			for (const candidate of orderedCandidates) {
				if (await hasModelApiKey(candidate)) {
					model = candidate;
					break;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				modelFallbackMessage =
					"No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		// Discover custom commands (TypeScript slash commands)
		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		let extensionRunner: ExtensionRunner | undefined;
		if (extensionsResult.extensions.length > 0) {
			extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort();
			},
			settings,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
		let wrappedExtensionTools: Tool[];

		if (extensionRunner) {
			// With extension runner: convert CustomTools to ToolDefinitions and wrap all together
			const allCustomTools = [
				...registeredTools,
				...(options.customTools?.map(tool => {
					const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
					return { definition, extensionPath: "<sdk>" };
				}) ?? []),
			];
			wrappedExtensionTools = wrapRegisteredTools(allCustomTools, extensionRunner);
		} else {
			// Without extension runner: wrap CustomTools directly with CustomToolAdapter
			// ToolDefinition items require ExtensionContext and cannot be used without a runner
			const customToolContext = (): CustomToolContext => ({
				sessionManager,
				modelRegistry,
				model: agent?.state.model,
				isIdle: () => !session?.isStreaming,
				hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
				abort: () => session?.abort(),
				settings,
			});
			wrappedExtensionTools = (options.customTools ?? [])
				.filter(isCustomTool)
				.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const toolRegistry = new Map<string, Tool>();
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (extensionRunner) {
			for (const tool of toolRegistry.values()) {
				toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
			}
		}
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
		}

		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		if (!hasDeferrableTools) {
			toolRegistry.delete("resolve");
		} else if (!toolRegistry.has("resolve")) {
			const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
			if (resolveTool) {
				toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
			}
		}

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		const repeatToolDescriptions = settings.get("repeatToolDescriptions");
		const contextProfileCollector = new ContextProfileCollector(contextLoadingMode);
		const eagerTasks = settings.get("task.eager");
		const intentField = settings.get("tools.intentTracing") || $flag("PI_INTENT_TRACING") ? INTENT_FIELD : undefined;
		const rebuildSystemPrompt = async (toolNames: string[], tools: Map<string, AgentTool>): Promise<string> => {
			toolContextStore.setToolNames(toolNames);
			const discoverableMCPTools = mcpDiscoveryEnabled ? collectDiscoverableMCPTools(tools.values()) : [];
			const discoverableMCPSummary = summarizeDiscoverableMCPTools(discoverableMCPTools);
			const hasDiscoverableMCPTools =
				mcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableMCPTools.length > 0;
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: {
					description: renderSearchToolBm25Description(discoverableMCPTools, contextLoadingMode === "progressive"),
				},
			});
			const memoryInstructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);

			// Resolve F5 XC context for the prompt. Read fresh each rebuild so tool-triggered
			// rebuilds reflect the most recent /context activate. Mid-session context changes without a
			// tool change are handled via custom_message injection in the onContextChange listener.
			let contextForPrompt:
				| {
						tenant: string;
						namespace: string;
						credentialSource: string;
						authStatus: string;
						apiUrl?: string;
						envVars?: Record<string, string>;
				  }
				| undefined;
			try {
				const status = contextServiceRef?.instance?.getStatus();
				// The LLM needs to anchor on tenant + namespace regardless of whether credentials
				// come from a named context or from XCSH_API_URL/XCSH_API_TOKEN env vars. For the
				// env-only path, activeContextName is null but activeContextTenant (derived from
				// XCSH_API_URL) is still set and credentialSource is "environment". Guard on
				// tenant, not name, so env-backed deployments also get the prompt anchor.
				if (status?.isConfigured && status.activeContextTenant) {
					contextForPrompt = {
						tenant: status.activeContextTenant,
						namespace: status.activeContextNamespace ?? "default",
						credentialSource: status.credentialSource,
						authStatus: status.authStatus,
						apiUrl: status.activeContextUrl ?? undefined,
					};
					const sensitiveKeys = contextServiceRef?.instance?.getActiveSensitiveKeys();
					const ctxEnv = createContextEnv(settings, sensitiveKeys?.size ? { sensitiveKeys } : undefined);
					const envVars = ctxEnv.getNonSensitiveVars();
					if (Object.keys(envVars).length > 0) {
						contextForPrompt.envVars = envVars;
					}
				}
			} catch {
				// ContextService not available or not initialized — leave contextForPrompt undefined.
			}

			let knowledgeTopics: string | undefined;
			try {
				if (knowledgeServiceRef) {
					const svc = knowledgeServiceRef.instance;
					let cached = svc.getIndex();
					if (!cached) {
						await svc.getOrRefreshIndex();
						cached = svc.getIndex();
					} else {
						void svc.getOrRefreshIndex();
					}
					if (cached) {
						knowledgeTopics = svc.getTopicSummary() || undefined;
					}
				}
			} catch {
				// KnowledgeService not available — leave undefined.
			}

			let contextSkillDirs: string[] | undefined;
			let contextIncludeSkills: string[] | undefined;
			let contextExcludeSkills: string[] | undefined;
			try {
				if (contextServiceRef?.instance) {
					const skillConfig = contextServiceRef.instance.getActiveContextSkillConfig();
					if (skillConfig.skillDirs.length > 0) contextSkillDirs = skillConfig.skillDirs;
					if (skillConfig.includeSkills.length > 0) contextIncludeSkills = skillConfig.includeSkills;
					if (skillConfig.excludeSkills.length > 0) contextExcludeSkills = skillConfig.excludeSkills;
				}
			} catch {
				// ContextService not available — leave undefined.
			}

			// Build combined append prompt: memory instructions + MCP server instructions
			const serverInstructions = mcpManager?.getServerInstructions();
			let appendPrompt: string | undefined = memoryInstructions ?? undefined;
			if (serverInstructions && serverInstructions.size > 0) {
				const MAX_INSTRUCTIONS_LENGTH = 4000;
				const parts: string[] = [];
				if (appendPrompt) parts.push(appendPrompt);
				parts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					parts.push(`### ${srvName}\n${truncated}`);
				}
				appendPrompt = parts.join("\n\n");
			}
			const currentLocale = getLocale();
			const localeName = currentLocale !== "en" ? getLocaleDisplayName(currentLocale) : undefined;
			const localeForPrompt = localeName ? { code: currentLocale, name: localeName } : undefined;

			const defaultPrompt = await buildSystemPromptInternal({
				loadingMode: contextLoadingMode,
				onProfileComponents: components => contextProfileCollector.setAttributedComponents(components),
				cwd,
				skills,
				contextFiles,
				agentsMdSearch,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				skillsSettings: settings.getGroup("skills"),
				appendSystemPrompt: appendPrompt,
				repeatToolDescriptions,
				intentField,
				mcpDiscoveryMode: hasDiscoverableMCPTools,
				mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
				eagerTasks,
				secretsEnabled,
				context: contextForPrompt,
				locale: localeForPrompt,
				knowledgeTopics,
				contextSkillDirs,
				contextIncludeSkills,
				contextExcludeSkills,
				transformPrompt: typeof options.systemPrompt === "function" ? options.systemPrompt : undefined,
			});

			if (options.systemPrompt === undefined || typeof options.systemPrompt === "function") {
				return defaultPrompt;
			}
			return await buildSystemPromptInternal({
				loadingMode: contextLoadingMode,
				onProfileComponents: components => contextProfileCollector.setAttributedComponents(components),
				cwd,
				skills,
				contextFiles,
				agentsMdSearch,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				skillsSettings: settings.getGroup("skills"),
				customPrompt: options.systemPrompt,
				appendSystemPrompt: appendPrompt,
				repeatToolDescriptions,
				intentField,
				mcpDiscoveryMode: hasDiscoverableMCPTools,
				mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
				eagerTasks,
				secretsEnabled,
				context: contextForPrompt,
				locale: localeForPrompt,
				knowledgeTopics,
				contextSkillDirs,
				contextIncludeSkills,
				contextExcludeSkills,
			});
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const requestedToolNames =
			(options.toolNames ? [...new Set(options.toolNames.map(name => name.toLowerCase()))] : undefined) ??
			toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const includeExitPlanMode = requestedToolNames.includes("exit_plan_mode");
		const progressiveLoading = contextLoadingMode === "progressive";
		const mcpDiscoveryEnabled = (settings.get("mcp.discoveryMode") ?? false) || progressiveLoading;
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = includeExitPlanMode
			? normalizedRequested
			: normalizedRequested.filter(name => name !== "exit_plan_mode");
		const progressiveCoreToolNames = [
			"read",
			"grep",
			"find",
			"bash",
			"python",
			"edit",
			"write",
			"xcsh_api",
			"search_tool_bm25",
		];
		const eagerRequestedActiveToolNames = requestedActiveToolNames.filter(
			name => !(providerToolPolicyAvailable && !settings.get("mcp.discoveryMode") && name === "search_tool_bm25"),
		);
		const eagerToolNames = eagerRequestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: progressiveLoading
				? progressiveCoreToolNames.filter(name => toolRegistry.has(name))
				: eagerToolNames;
		const restoredProgressiveToolNames = existingSession.hasPersistedToolSelection
			? [
					...progressiveCoreToolNames.filter(name => toolRegistry.has(name)),
					...(existingSession.selectedToolNames ?? []).filter(name => toolRegistry.has(name)),
				]
			: [
					...initialRequestedActiveToolNames,
					...existingSession.selectedMCPToolNames.filter(name => toolRegistry.has(name)),
				];
		const explicitlyRequestedMCPToolNames = options.toolNames
			? requestedActiveToolNames.filter(name => name.startsWith("mcp_"))
			: [];
		const discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
			? selectDiscoverableMCPToolNamesByServer(
					collectDiscoverableMCPTools(toolRegistry.values()),
					discoveryDefaultServers,
				)
			: [];
		let initialSelectedMCPToolNames: string[] = [];
		let defaultSelectedMCPToolNames: string[] = [];
		let initialToolNames =
			progressiveLoading && options.toolNames === undefined
				? [...new Set(restoredProgressiveToolNames)]
				: [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames.filter(name =>
				toolRegistry.has(name),
			);
			defaultSelectedMCPToolNames = [
				...new Set([...discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
			];
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
			initialToolNames = [
				...new Set([...initialToolNames.filter(name => !name.startsWith("mcp_")), ...initialSelectedMCPToolNames]),
			];
		}

		// Without an explicit scope, custom and default-active extension tools join the
		// built-ins. When toolNames is present, it is authoritative for every tool source.
		const alwaysInclude: string[] =
			options.toolNames === undefined && !progressiveLoading
				? [
						...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
						...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
					]
				: [];
		for (const name of alwaysInclude) {
			if (mcpDiscoveryEnabled && name.startsWith("mcp_")) {
				continue;
			}
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}
		for (const name of alwaysInclude) {
			if (toolRegistry.has(name) && !eagerToolNames.includes(name)) eagerToolNames.push(name);
		}

		const systemPrompt = await logger.time("buildSystemPrompt", rebuildSystemPrompt, initialToolNames, toolRegistry);

		const promptTemplates =
			options.promptTemplates ??
			(await logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir));
		toolSession.promptTemplates = promptTemplates;

		const slashCommands =
			options.slashCommands ?? (await logger.time("discoverSlashCommands", discoverSlashCommands, cwd));

		// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			// Check setting dynamically so mid-session changes take effect
			if (!settings.get("images.blockImages")) {
				return converted;
			}
			// Filter out ImageContent from all messages, replacing with text placeholder
			return converted.map(msg => {
				if (msg.role === "user" || msg.role === "toolResult") {
					const content = msg.content;
					if (Array.isArray(content)) {
						const hasImages = content.some(c => c.type === "image");
						if (hasImages) {
							const filteredContent = content
								.map(c =>
									c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
								)
								.filter((c, i, arr) => {
									// Dedupe consecutive "Image reading is disabled." texts
									if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
									const prev = arr[i - 1];
									return !(prev.type === "text" && prev.text === "Image reading is disabled.");
								});
							return { ...msg, content: filteredContent };
						}
					}
				}
				return msg;
			});
		};

		// Final convertToLlm: chain block-images filter with secret obfuscation
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlmWithBlockImages(messages);
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};
		const transformContext = extensionRunner
			? async (messages: AgentMessage[], _signal?: AbortSignal) => {
					return await extensionRunner.emitContext(messages);
				}
			: undefined;
		const onPayload = extensionRunner
			? async (payload: unknown, _model?: Model) => {
					return await extensionRunner.emitBeforeProviderRequest(payload);
				}
			: undefined;

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		contextProfileCollector.setPrompt(systemPrompt, initialTools);
		contextProfileCollector.setDeferredTools(
			Array.from(toolRegistry.values()).filter(tool => !initialToolNames.includes(tool.name)),
		);

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const serviceTierSetting = settings.get("serviceTier");

		const initialServiceTier = hasServiceTierEntry
			? existingSession.serviceTier
			: serviceTierSetting === "none"
				? undefined
				: serviceTierSetting;

		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(thinkingLevel),
				tools: initialTools,
			},
			convertToLlm: convertToLlmFinal,
			onPayload,
			onFinalPayload: (payload, payloadModel) => {
				if (payloadModel) contextProfileCollector.captureProviderPayload(payload, payloadModel);
			},
			sessionId: providerSessionId,
			transformContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "wait",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			serviceTier: initialServiceTier,
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: async provider => {
				// Use the provider-facing session id for sticky credential selection so cache keys
				// and provider auth affinity stay aligned across fresh benchmark sessions.
				const key = await modelRegistry.getApiKeyForProvider(provider, providerSessionId);
				if (!key) {
					throw new Error(`No API key found for provider "${provider}"`);
				}
				return key;
			},
			streamFn: (requestModel, context, requestOptions) => {
				const providerContext = obfuscateProviderContext(obfuscator, context);
				if (requestModel.provider !== "google-vertex") {
					return streamSimple(requestModel, providerContext, requestOptions);
				}
				const project = settings.get("providers.vertexProject");
				if (!project) {
					throw new Error("Corporate Vertex requires a confirmed project. Run /login google-vertex.");
				}
				return streamSimple(requestModel, providerContext, {
					...requestOptions,
					project,
					location: "global",
				});
			},
			cursorExecHandlers,
			transformToolCallArguments: (args, _toolName) => {
				let result = args;
				const maxTimeout = settings.get("tools.maxTimeout");
				if (maxTimeout > 0 && typeof result.timeout === "number") {
					result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
				}
				if (obfuscator?.hasSecrets()) {
					result = obfuscator.deobfuscateObject(result);
				}
				return result;
			},
			intentTracing: !!intentField,
			getToolChoice: () => session?.nextToolChoice(),
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
		} else {
			// Save initial model and thinking level for new sessions so they can be restored on resume
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			sessionManager.appendThinkingLevelChange(thinkingLevel);
			// Save active context (if any) so resumed sessions know their platform context.
			try {
				const { ContextService } = await import("./services/xcsh-context");
				const status = ContextService.instance?.getStatus();
				if (status?.isConfigured && status.activeContextName && status.activeContextTenant) {
					sessionManager.appendContextChange(
						status.activeContextName,
						status.activeContextTenant,
						status.activeContextNamespace ?? "default",
					);
				}
			} catch {
				// ContextService not available (SDK consumers, tests). Skip.
			}
		}

		session = new AgentSession({
			agent,
			thinkingLevel,
			modelResolutionSource: options.modelResolutionSource,
			sessionManager,
			settings,
			pythonKernelOwnerId,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			resolveToolPolicyForModel: providerToolPolicyAvailable
				? candidate => {
						const previousLoadingMode = contextLoadingMode;
						contextLoadingMode = resolveContextLoadingMode(candidate);
						const progressive = contextLoadingMode === "progressive";
						return {
							toolNames:
								previousLoadingMode === contextLoadingMode
									? undefined
									: progressive
										? progressiveCoreToolNames.filter(name => toolRegistry.has(name))
										: eagerToolNames,
							mcpDiscoveryEnabled: (settings.get("mcp.discoveryMode") ?? false) || progressive,
						};
					}
				: undefined,
			contextProfileCollector,
			toolRegistry,
			transformContext,
			onPayload,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			mcpDiscoveryEnabled,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: [...discoveryDefaultServers],
			ttsrManager,
			obfuscator,
			asyncJobManager,
		});
		hasSession = true;

		// Register the context-change listener now that the session exists. Registering here
		// (atomically with addDisposeHook below) means a failed createAgentSession leaves no
		// leaked listener, and the listener closes over a fully-constructed session.
		//
		// The listener fires on every #applyToSettings call in ContextService (activate,
		// setNamespace, setEnvVars, unsetEnvVars, loadActive). It serves two roles:
		//   1. Refresh the secret obfuscator when context env/token changes.
		//   2. Notify the LLM when context the prompt block mirrors (name OR namespace)
		//      changes — settings-only events (env var mutations) do not emit the notice.
		//
		// Wrapped in try so that tests and SDK consumers that never initialize ContextService
		// don't trip on .instance throwing. In those paths we skip listener registration
		// entirely — there's no context to track.
		try {
			if (!contextServiceRef) throw new Error("no ContextService");
			const service = contextServiceRef;

			// Track both name and namespace — they both appear in the system-prompt anchor block
			// and both affect F5 XC operation targeting, so either changing is an LLM-visible event.
			// Seed from current state so re-activating the same context, or firing for env-only
			// mutations, does not produce a spurious "Context switched" directive.
			const seedStatus = service.instance.getStatus();
			let lastEmittedContext: { name: string; namespace: string } | undefined =
				seedStatus.activeContextName && seedStatus.activeContextTenant
					? {
							name: seedStatus.activeContextName,
							namespace: seedStatus.activeContextNamespace ?? "default",
						}
					: undefined;

			const listener: (ctx: import("./services/xcsh-context").XCSHContext) => void = ctx => {
				// Role 1: obfuscator refresh on credential change.
				const newValues: string[] = [ctx.apiToken];
				if (ctx.sensitiveKeys && ctx.env) {
					for (const key of ctx.sensitiveKeys) {
						const v = ctx.env[key];
						if (v) newValues.push(v);
					}
				}
				const bashEnv = (settings.get("bash.environment") ?? {}) as Record<string, string>;
				for (const [name, value] of Object.entries(bashEnv)) {
					if (value && SECRET_ENV_PATTERNS.test(name)) newValues.push(value);
				}
				if (obfuscator) {
					obfuscator.addPlainSecrets(newValues);
				} else {
					// Obfuscator was undefined at session start (no secrets detected).
					// Create one now so late context activations are still masked.
					const entries: SecretEntry[] = newValues
						.filter(v => v.length > 0)
						.map(v => ({ type: "plain" as const, content: v, mode: "obfuscate" as const }));
					if (entries.length > 0) {
						obfuscator = new SecretObfuscator(entries);
					}
				}

				// Role 2: notify the LLM when name OR namespace changes. Read
				// ContextService.getStatus() (not the callback arg) to honor the XCSH_NAMESPACE
				// env override consistently with session-start emission.
				try {
					const currentStatus = service.instance?.getStatus();
					const currentName = currentStatus?.activeContextName ?? undefined;
					const currentTenant = currentStatus?.activeContextTenant ?? undefined;
					if (!currentName || !currentTenant) return;
					const currentNamespace = currentStatus.activeContextNamespace ?? "default";

					const changed =
						!lastEmittedContext ||
						currentName !== lastEmittedContext.name ||
						currentNamespace !== lastEmittedContext.namespace;
					if (!changed) return;

					// Append the context_change entry for replay/resume state reconstruction.
					sessionManager.appendContextChange(currentName, currentTenant, currentNamespace);

					// Push a custom_message into BOTH agent.state.messages AND the session log so
					// the LLM sees the directive on its next turn. sendCustomMessage handles
					// streaming vs non-streaming correctly (queues via steer/followUp/nextTurn
					// when a turn is in flight).
					const nameChanged = !lastEmittedContext || currentName !== lastEmittedContext.name;
					const prefix = nameChanged
						? `[Context switched to ${currentName}]`
						: `[F5 XC namespace changed to ${currentNamespace}]`;
					void session.sendCustomMessage({
						customType: "context_change_notice",
						content:
							`${prefix} Tenant: ${currentTenant}, ` +
							`namespace: ${currentNamespace}. Target this tenant and namespace ` +
							`for subsequent F5 XC operations.`,
						display: true,
						attribution: "agent",
					});
					lastEmittedContext = { name: currentName, namespace: currentNamespace };
					void session.refreshBaseSystemPrompt();
					// Role 3: background-validate credentials after context switch so the
					// LLM knows whether the new context is usable. Fire-and-forget — do
					// not block the context change notification.
					void (async () => {
						try {
							const { status: authStatus, latencyMs } = await service.instance.validateToken({
								timeoutMs: 5000,
							});
							const qualifier =
								authStatus === "connected"
									? `connected${latencyMs ? ` (${latencyMs}ms)` : ""}`
									: authStatus === "auth_error"
										? "credential error -- token may be invalid or expired"
										: "unreachable -- network error or tenant offline";
							void session.sendCustomMessage({
								customType: "context_validation_result",
								content: `[Auth status: ${authStatus}] Credentials for ${currentTenant}: ${qualifier}.`,
								display: true,
								attribution: "agent",
							});
						} catch {
							// Validation failed (e.g., no credentials configured) -- skip silently.
						}
					})();
				} catch {
					// ContextService.instance throws if not initialized; skip.
				}
			};

			service.onContextChange(listener);
			session.addDisposeHook(() => service.offContextChange(listener));
			const authListener = (prev: string, current: string) => {
				if (prev === current) return;
				const isDegradation = current === "auth_error" || current === "offline";
				if (!isDegradation && prev === "unknown") return;
				const content = isDegradation
					? `[Auth status: ${prev} → ${current}] F5 XC credentials may be stale. Run /context validate to check.`
					: `[Auth status: ${current}] F5 XC credentials are valid again.`;
				void session.sendCustomMessage({
					customType: "auth_status_change",
					content,
					display: true,
					attribution: "agent",
				});
			};
			service.onAuthStatusChange(authListener);
			session.addDisposeHook(() => service.offAuthStatusChange(authListener));
			const tokenHealthListener = (_prev: string, current: string) => {
				if (current === "expiring") {
					void session.sendCustomMessage({
						customType: "token_health_change",
						content: "[Token expiring] F5 XC API token expires soon. Run /context create to rotate.",
						display: true,
						attribution: "agent",
					});
				} else if (current === "expired") {
					void session.sendCustomMessage({
						customType: "token_health_change",
						content: "[Token expired] F5 XC API token has expired. Run /context create to replace it.",
						display: true,
						attribution: "agent",
					});
				}
			};
			service.onTokenHealthChange(tokenHealthListener);
			session.addDisposeHook(() => service.offTokenHealthChange(tokenHealthListener));
		} catch {
			// ContextService not initialized — skip listener registration entirely.
			// Tests and SDK consumers that don't use contexts won't reach this branch.
		}

		if (model?.api === "openai-codex-responses") {
			const codexModel = model;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && settings.get("lsp.diagnosticsOnWrite")) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		logger.time("startMemoryStartupTask", () =>
			startMemoryStartupTask({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
			}),
		);

		// Wire MCP manager callbacks to session for reactive tool updates
		if (mcpManager) {
			mcpManager.setOnToolsChanged(tools => {
				void session.refreshMCPTools(tools);
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						void session.followUp(
							`[MCP notification] Server "${serverName}" reports resource \`${uri}\` was updated. Use read(path="mcp://${uri}") to inspect if relevant.`,
						);
					}, debounceMs),
				);
			});
		}

		logger.time("createAgentSession:return");
		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				await disposeKernelSessionsByOwner(pythonKernelOwnerId);
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}
