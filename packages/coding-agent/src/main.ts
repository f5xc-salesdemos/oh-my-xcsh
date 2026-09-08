/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import type { ImageContent } from "@f5-sales-demo/pi-ai";
import {
	$env,
	APP_NAME,
	getConfigDirName,
	getProjectDir,
	getXCSHConfigDir,
	logger,
	postmortem,
	setProjectDir,
	VERSION,
} from "@f5-sales-demo/pi-utils";
import chalk from "chalk";
import { LOCALIP_HOST, resolveBridgeTls } from "./browser/bridge-cert";
import { ChatHandler } from "./browser/chat-handler";
import { type BridgeServer, startBridgeServer } from "./browser/extension-bridge";
import { setSharedBridgeServer } from "./browser/provider";
import { invalidate as invalidateFsCache } from "./capability/fs";
import { type Args, resolveLaunchArgs } from "./cli/args";
import { processFileArguments } from "./cli/file-processor";
import { LAUNCH_FLAGS } from "./cli/flag-spec";
import { buildInitialMessage } from "./cli/initial-message";
import { listModels } from "./cli/list-models";
import { selectSession } from "./cli/session-picker";
import { findConfigFile } from "./config";
import { ModelRegistry, ModelsConfigFile } from "./config/model-registry";
import { resolveCliModel, resolveModelRoleValue, resolveModelScope, type ScopedModel } from "./config/model-resolver";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import {
	clearXcshPluginRootsCache,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
} from "./discovery/helpers";
import { exportFromFile } from "./export/html";
import { discoverAndLoadExtensions, loadExtensions } from "./extensibility/extensions";
import type { ExtensionFlag, ExtensionUIContext, LoadExtensionsResult } from "./extensibility/extensions/types";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "./extensibility/plugins/marketplace";
import type { MCPManager } from "./mcp";
import { InteractiveMode, runAcpMode, runPrintMode, runRpcMode } from "./modes";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "./sdk";
import { ContextService } from "./services/xcsh-context";
import { deriveTenantEnv } from "./services/xcsh-env";
import type { AgentSession } from "./session/agent-session";
import { resolveResumableSession, type SessionInfo, SessionManager } from "./session/session-manager";
import { profileDump, profileMark } from "./startup-profile";
import { resolvePromptInput } from "./system-prompt";
import type { LspStartupServerInfo } from "./tools";
import { EventBus } from "./utils/event-bus";
import { fuzzyFilter } from "./utils/fuzzy";

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return;
	}
	try {
		const response = await fetch("https://registry.npmjs.org/@f5-sales-demo/xcsh/latest");
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && Bun.semver.order(latestVersion, currentVersion) > 0) {
			return latestVersion;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

const RPC_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"todo.enabled",
	"todo.reminders",
	"todo.reminders.max",
	"todo.eager",
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
	"task.isolation.mode",
	"task.isolation.merge",
	"task.isolation.commits",
	"task.eager",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.disabledAgents",
	"task.agentModelOverrides",
];

function applyRpcDefaultSettingOverrides(): void {
	for (const settingPath of RPC_DEFAULTED_SETTING_PATHS) {
		settings.override(settingPath, getDefault(settingPath));
	}
}

async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY !== false) return undefined;
	try {
		const text = await Bun.stdin.text();
		if (text.trim().length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

export interface InteractiveModeNotify {
	kind: "warn" | "error" | "info";
	message: string;
}

export async function submitInteractiveInput(
	mode: Pick<InteractiveMode, "markPendingSubmissionStarted" | "finishPendingSubmission" | "showError">,
	session: Pick<AgentSession, "prompt">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		// Continue shortcuts submit an already-started empty prompt with no optimistic user message.
		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		await session.prompt(input.text, { images: input.images });
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
	}
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	notifs: (InteractiveModeNotify | null)[],
	versionCheckPromise: Promise<string | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: LspStartupServerInfo[] | undefined,
	mcpManager: MCPManager | undefined,
	eventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
): Promise<void> {
	profileMark("interactive: enter runInteractiveMode");

	const mode = new InteractiveMode(session, version, setExtensionUIContext, lspServers, mcpManager, eventBus);

	await mode.init();
	profileMark("interactive: mode.init() done");

	// Update notice: fully non-blocking. Startup never waits on the network version
	// check; surface the notice whenever it resolves (typically after the prompt is
	// already up). If it never resolves, the update is available on demand via /plugins.
	if (settings.get("startup.checkUpdate")) {
		void versionCheckPromise
			.then(latest => {
				if (latest) mode.showStatus(`Update available: v${latest} — run: xcsh update`, { dim: true });
			})
			.catch(() => {});
	}

	mode.renderInitialMessages();
	profileMark("interactive: initial render requested");

	for (const notify of notifs) {
		if (!notify) {
			continue;
		}
		if (notify.kind === "warn") {
			mode.showWarning(notify.message);
		} else if (notify.kind === "error") {
			mode.showError(notify.message);
		} else if (notify.kind === "info") {
			mode.showStatus(notify.message);
		}
	}

	if (initialMessage !== undefined) {
		try {
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		try {
			await session.prompt(message);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	profileMark("interactive: READY — awaiting first input");
	profileDump();
	while (true) {
		const input = await mode.getUserInput();
		await submitInteractiveInput(mode, session, input);
	}
}

function normalizePathForComparison(value: string): string {
	const resolved = path.resolve(value);
	let realPath = resolved;
	try {
		realPath = realpathSync(resolved);
	} catch {}
	return process.platform === "win32" ? realPath.toLowerCase() : realPath;
}

async function promptForkSession(session: SessionInfo): Promise<boolean> {
	if (!process.stdin.isTTY) {
		return false;
	}
	const message = `Session found in different project: ${session.cwd}. Fork into current directory? [y/N] `;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function createSessionManager(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new Error("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		if (forkSource.includes("/") || forkSource.includes("\\") || forkSource.endsWith(".jsonl")) {
			return await SessionManager.forkFrom(forkSource, cwd, parsed.sessionDir);
		}
		const match = await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!match) {
			throw new Error(`Session "${forkSource}" not found.`);
		}
		return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			return await SessionManager.open(sessionArg, parsed.sessionDir);
		}
		const match = await resolveResumableSession(sessionArg, cwd, parsed.sessionDir);
		if (!match) {
			throw new Error(`Session "${sessionArg}" not found.`);
		}
		if (match.scope === "global") {
			const normalizedCwd = normalizePathForComparison(cwd);
			const normalizedMatchCwd = normalizePathForComparison(match.session.cwd || cwd);
			if (normalizedCwd !== normalizedMatchCwd) {
				const shouldFork = await promptForkSession(match.session);
				if (!shouldFork) {
					throw new Error(`Session "${sessionArg}" is in another project (${match.session.cwd}).`);
				}
				return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
			}
		}
		return await SessionManager.open(match.session.path, parsed.sessionDir);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Auto-resume: behave like --continue if the setting is enabled and a prior
	// session exists. When a prior session is resumed, mark parsed.continue so
	// buildSessionOptions restores the session's model/thinking instead of
	// overriding them with CLI defaults.
	if (settings.get("autoResume")) {
		const manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

async function maybeAutoChdir(parsed: Pick<Args, "allowHome" | "cwd">): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	// A nested xcsh process may inherit a profile that permits named home access but withholds parent
	// metadata. Comparison is advisory auto-chdir logic, so an unavailable realpath must fall back to
	// the resolved spelling instead of crashing before command dispatch (#2817).
	const cwd = normalizePathForComparison(getProjectDir());
	const normalizedHome = normalizePathForComparison(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const isDirectory = async (p: string) => {
		try {
			const s = await fs.stat(p);
			return s.isDirectory();
		} catch {
			return false;
		}
	};

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await isDirectory(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePathForComparison(fallback) !== cwd && (await isDirectory(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

/** Discover SYSTEM.md file if no CLI system prompt was provided */
function discoverSystemPromptFile(): string | undefined {
	// Check project-local first (.omp/SYSTEM.md, .pi/SYSTEM.md legacy)
	const projectPath = findConfigFile("SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	// If not found, check SYSTEM.md file in the global directory.
	const globalPath = findConfigFile("SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Discover APPEND_SYSTEM.md file if no CLI append system prompt was provided */
function discoverAppendSystemPromptFile(): string | undefined {
	const projectPath = findConfigFile("APPEND_SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("APPEND_SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
): Promise<{ options: CreateAgentSessionOptions }> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
		contextName: parsed.context,
	};

	// Auto-discover SYSTEM.md if no CLI system prompt provided
	const systemPromptSource = parsed.systemPrompt ?? discoverSystemPromptFile();
	const resolvedSystemPrompt = await resolvePromptInput(systemPromptSource, "system prompt");
	const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();
	const resolvedAppendPrompt = await resolvePromptInput(appendPromptSource, "append system prompt");

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	if (parsed.model) {
		// Both branches below originate from --model, including the deferred modelPattern path.
		options.modelResolutionSource = "launch-flag";
		let resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			preferences: modelMatchPreferences,
		});
		if (resolved.error) {
			await logger.time("awaitExplicitModelDiscovery", () => modelRegistry.awaitBackgroundRefresh());
			resolved = resolveCliModel({
				cliProvider: parsed.provider,
				cliModel: parsed.model,
				modelRegistry,
				preferences: modelMatchPreferences,
			});
		}
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error) {
			if (!parsed.provider && !parsed.model.includes(":")) {
				// Model not found in built-in registry — defer resolution to after extensions load
				// (extensions may register additional providers/models via registerProvider)
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(1);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			settings.overrideModelRoles({
				default: resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		const remembered = settings.getModelRole("default");
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings,
					matchPreferences: modelMatchPreferences,
					modelRegistry,
				},
			);
			const rememberedResolvedModel = rememberedSpec.model;
			const rememberedModel = rememberedResolvedModel
				? scopedModels.find(
						scopedModel =>
							scopedModel.model.provider === rememberedResolvedModel.provider &&
							scopedModel.model.id === rememberedResolvedModel.id,
					)
				: scopedModels.find(scopedModel => scopedModel.model.id.toLowerCase() === remembered.toLowerCase());
			if (rememberedModel) {
				options.model = rememberedModel.model;
				// Apply explicit thinking level from remembered role value
				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
				}
			}
		}
		if (!options.model) options.model = scopedModels[0].model;
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		!parsed.continue &&
		!parsed.resume
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	// Scoped models for Ctrl+P cycling - fill in default thinking levels when not explicit
	if (scopedModels.length > 0) {
		const defaultThinkingLevel = settings.get("defaultThinkingLevel");
		options.scopedModels = scopedModels.map(scopedModel => ({
			model: scopedModel.model,
			thinkingLevel: scopedModel.explicitThinkingLevel
				? (scopedModel.thinkingLevel ?? defaultThinkingLevel)
				: defaultThinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	if (resolvedSystemPrompt && resolvedAppendPrompt) {
		options.systemPrompt = `${resolvedSystemPrompt}\n\n${resolvedAppendPrompt}`;
	} else if (resolvedSystemPrompt) {
		options.systemPrompt = resolvedSystemPrompt;
	} else if (resolvedAppendPrompt) {
		options.systemPrompt = defaultPrompt => `${defaultPrompt}\n\n${resolvedAppendPrompt}`;
	}

	// Tools
	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	if (parsed.noTools || parsed.noMcp) {
		options.enableMCP = false;
	}

	if (parsed.noLsp) {
		options.enableLsp = false;
	}

	// Skills
	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.skills && parsed.skills.length > 0) {
		// Override includeSkills for this session
		settings.override("skills.includeSkills", parsed.skills as string[]);
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	// Additional extension paths from CLI
	const cliExtensionPaths = parsed.noExtensions ? [] : [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
	if (cliExtensionPaths.length > 0) {
		options.additionalExtensionPaths = cliExtensionPaths;
	}

	if (parsed.noExtensions) {
		options.disableExtensionDiscovery = true;
		options.additionalExtensionPaths = [];
	}

	return { options };
}

/**
 * Reject flags nothing claimed, with a non-zero exit.
 *
 * Unrecognized flags used to be dropped in silence, so `xcsh --model=opus` ran the configured
 * default and any misspelled flag did nothing at all (#2469). `parseArgs` only collects them,
 * because during the bootstrap parse the extension flag registry does not exist yet — pass
 * `extensionFlags` once it does, and anything still unclaimed is a real typo.
 */
function reportUnrecognizedFlags(
	parsed: Args,
	extensionFlags?: ReadonlyMap<string, { type: "boolean" | "string" }>,
): void {
	const unclaimed = parsed.unrecognizedFlags.filter(flag => !extensionFlags?.has(flag.name));
	if (unclaimed.length === 0) return;

	const known = [...Object.keys(LAUNCH_FLAGS), ...(extensionFlags?.keys() ?? [])];
	for (const flag of unclaimed) {
		process.stderr.write(`${chalk.red(`Error: Unknown flag ${flag.token}`)}\n`);
		const suggestion = fuzzyFilter(known, flag.name, name => name)[0];
		if (suggestion) {
			process.stderr.write(`  Did you mean --${suggestion}?\n`);
		}
	}
	process.stderr.write(`\nRun ${APP_NAME} --help to see available flags, or pass -- to send text as a prompt.\n`);
	process.exit(1);
}

function collectExtensionFlags(result: LoadExtensionsResult): {
	flags: Map<string, ExtensionFlag>;
	registeredNames: Map<string, string>;
} {
	const flags = new Map<string, ExtensionFlag>();
	const registeredNames = new Map<string, string>();
	for (const extension of result.extensions) {
		for (const [registeredName, flag] of extension.flags) {
			const cliName = registeredName.replace(/^--/, "");
			flags.set(cliName, flag);
			registeredNames.set(cliName, registeredName);
		}
	}
	return { flags, registeredNames };
}

export async function runRootCommand(rawArgs: string[]): Promise<void> {
	logger.startTiming();
	profileMark("entry: runtime + module-graph loaded (pre-main)");

	// Initialize theme early with defaults (CLI commands need symbols)
	// Will be re-initialized with user preferences later
	await logger.time("initTheme:initial", initTheme);

	let preloadedExtensions: LoadExtensionsResult | undefined;
	let extensionEventBus: EventBus | undefined;
	let registeredFlagNames = new Map<string, string>();
	const resolved = await resolveLaunchArgs(rawArgs, async bootstrap => {
		await logger.time("maybeAutoChdir", maybeAutoChdir, bootstrap);
		const cwd = getProjectDir();
		const sandboxOverrides: Partial<Record<SettingPath, unknown>> = {};
		if (bootstrap.noSandbox) sandboxOverrides["sandbox.enabled"] = false;
		if (bootstrap.noMemories) sandboxOverrides["memories.enabled"] = false;
		if (bootstrap.allowPath.length > 0) {
			sandboxOverrides["sandbox.allowRead"] = bootstrap.allowPath;
			sandboxOverrides["sandbox.allowWrite"] = bootstrap.allowPath;
		}
		await logger.time("settings:init", Settings.init, {
			cwd,
			overrides: Object.keys(sandboxOverrides).length > 0 ? sandboxOverrides : undefined,
		});
		initializeWithSettings(settings);

		const home = os.homedir();
		if (bootstrap.pluginDirs.length > 0) {
			await logger.time("injectPluginDirRoots", injectPluginDirRoots, home, bootstrap.pluginDirs, cwd);
		} else {
			await logger.time("preloadPluginRoots", preloadPluginRoots, home, cwd);
		}

		const configuredPaths = [...bootstrap.extensions, ...bootstrap.hooks];
		extensionEventBus = new EventBus();
		preloadedExtensions = bootstrap.noExtensions
			? await logger.time("loadExtensions", loadExtensions, configuredPaths, cwd, extensionEventBus)
			: await logger.time(
					"discoverAndLoadExtensions",
					discoverAndLoadExtensions,
					[...configuredPaths, ...(settings.get("extensions") ?? [])],
					cwd,
					extensionEventBus,
					settings.get("disabledExtensions") ?? [],
				);
		for (const { path: extensionPath, error } of preloadedExtensions.errors) {
			logger.error("Failed to load extension", { path: extensionPath, error });
		}
		const collected = collectExtensionFlags(preloadedExtensions);
		registeredFlagNames = collected.registeredNames;
		return collected.flags;
	});
	const parsedArgs = resolved.parsed;
	if (resolved.bootstrap.preExtensionExit) {
		await logger.time("maybeAutoChdir", maybeAutoChdir, parsedArgs);
	} else {
		reportUnrecognizedFlags(parsedArgs, resolved.extensionFlags);
		for (const [flagName, value] of parsedArgs.unknownFlags) {
			preloadedExtensions?.runtime.flagValues.set(registeredFlagNames.get(flagName) ?? flagName, value);
		}
	}

	const notifs: (InteractiveModeNotify | null)[] = [];

	// Create AuthStorage and ModelRegistry upfront
	const authStorage = await logger.time("discoverModels", discoverAuthStorage);
	const registrySettings = await Settings.init({ cwd: getProjectDir() });
	const modelRegistry = new ModelRegistry(authStorage, undefined, {
		getProviderOrder: () => registrySettings.get("modelProviderOrder"),
	});

	// The three early exits below return before extensions load, so no extension flag could ever be
	// legal on them: anything unrecognized on those paths is a typo and is reported now. Every other
	// invocation waits until the extension registry exists, or a registered flag would be rejected
	// before the extension that defines it has had a chance to load.
	if (parsedArgs.version || parsedArgs.listModels !== undefined || parsedArgs.export) {
		reportUnrecognizedFlags(parsedArgs);
	}

	if (parsedArgs.version) {
		process.stdout.write(`${VERSION}\n`);
		process.exit(0);
	}

	if (parsedArgs.listModels !== undefined) {
		await logger.time("settings:init:list-models", Settings.init, { cwd: getProjectDir() });
		await modelRegistry.refresh("online");
		const searchPattern = typeof parsedArgs.listModels === "string" ? parsedArgs.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	if (parsedArgs.export) {
		let result: string;
		try {
			const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
			result = await exportFromFile(parsedArgs.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}
		process.stdout.write(`Exported to: ${result}\n`);
		process.exit(0);
	}

	if (parsedArgs.mode === "rpc" && parsedArgs.fileArgs.length > 0) {
		process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
		process.exit(1);
	}

	const cwd = getProjectDir();

	// F5 XC context is session-scoped: nothing loads at startup. We still init the
	// ContextService singleton so /context commands and the session bootstrap work.
	try {
		const contextService = ContextService.init(getXCSHConfigDir());
		if (parsedArgs.context) {
			await contextService.activate(parsedArgs.context);
		}
	} catch (error) {
		if (parsedArgs.context) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}
		// ContextService remains optional for SDK consumers and tests.
	}

	if (parsedArgs.mode === "rpc") {
		applyRpcDefaultSettingOverrides();
	}
	if (parsedArgs.noPty) {
		Bun.env.PI_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "rpc") {
		Bun.env.PI_NO_TITLE = "1";
	}
	const { pipedInput, fileText, fileImages } = await logger.time("prepareInitialMessage", async () => {
		const pipedInput = await readPipedInput();
		if (parsedArgs.fileArgs.length === 0) {
			return { pipedInput, fileText: undefined, fileImages: undefined };
		}
		const processed = await processFileArguments(parsedArgs.fileArgs, {
			autoResizeImages: settings.get("images.autoResize"),
		});
		return { pipedInput, fileText: processed.text, fileImages: processed.images };
	});
	const { initialMessage, initialImages } = buildInitialMessage({
		parsed: parsedArgs,
		fileText,
		fileImages,
		stdinContent: pipedInput,
	});
	const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
	const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;
	const mode = parsedArgs.mode || "text";

	modelRegistry.refreshInBackground();

	// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
	const smolModel = parsedArgs.smol ?? $env.PI_SMOL_MODEL;
	const slowModel = parsedArgs.slow ?? $env.PI_SLOW_MODEL;
	const planModel = parsedArgs.plan ?? $env.PI_PLAN_MODEL;
	if (smolModel || slowModel || planModel) {
		settings.overrideModelRoles({
			smol: smolModel,
			slow: slowModel,
			plan: planModel,
		});
	}

	await logger.time(
		"initTheme:final",
		initTheme,
		isInteractive,
		settings.get("symbolPreset"),
		settings.get("colorBlindMode"),
		settings.get("theme.dark"),
		settings.get("theme.light"),
		settings.get("theme.forceSlot"),
	);

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsedArgs.models ?? settings.get("enabledModels");
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await logger.time(
			"resolveModelScope",
			resolveModelScope,
			modelPatterns,
			modelRegistry,
			modelMatchPreferences,
		);
	}

	// Create session manager based on CLI flags
	let sessionManager = await logger.time("createSessionManager", createSessionManager, parsedArgs, cwd);

	// Handle --resume (no value): show session picker
	if (parsedArgs.resume === true && !parsedArgs.fork) {
		const sessions = await logger.time("SessionManager.list", SessionManager.list, cwd, parsedArgs.sessionDir);
		if (sessions.length === 0) {
			process.stdout.write(`${chalk.dim("No sessions found")}\n`);
			return;
		}
		const selectedPath = await logger.time("selectSession", selectSession, sessions);
		if (!selectedPath) {
			process.stdout.write(`${chalk.dim("No session selected")}\n`);
			return;
		}
		sessionManager = await SessionManager.open(selectedPath);
	}

	// Refresh stale marketplace clones in the background so startup never blocks on
	// git/network. Upgraded plugin code applies on the next launch (same trade-off as
	// the "notify" branch below). Offline/corrupt data is tolerated by the try/catch.
	const autoUpdate = settings.get("marketplace.autoUpdate");
	if (autoUpdate !== "off") {
		void (async () => {
			try {
				const startupMgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: (extraPaths?: readonly string[]) => {
						const h = os.homedir();
						invalidateFsCache(path.join(h, getConfigDirName(), "plugins", "installed_plugins.json"));
						for (const p of extraPaths ?? []) invalidateFsCache(p);
						clearXcshPluginRootsCache();
					},
				});
				await startupMgr.refreshStaleMarketplaces();
				if (autoUpdate === "auto") {
					const updates = await startupMgr.checkForUpdates();
					if (updates.length > 0) {
						await startupMgr.upgradeAllPlugins();
						logger.debug(`Auto-upgraded ${updates.length} marketplace plugin(s) at startup`);
					}
				}
			} catch {
				// Network failure, corrupt data, offline — proceed with cached plugins.
			}
		})();
	}

	// Background marketplace update notification (non-blocking).
	if (autoUpdate === "notify") {
		void (async () => {
			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: (extraPaths?: readonly string[]) => {
						const h = os.homedir();
						invalidateFsCache(path.join(h, getConfigDirName(), "plugins", "installed_plugins.json"));
						for (const p of extraPaths ?? []) invalidateFsCache(p);
						clearXcshPluginRootsCache();
					},
				});
				const updates = await mgr.checkForUpdates();
				if (updates.length > 0) {
					logger.debug(`${updates.length} marketplace plugin update(s) available \u2014 /plugin upgrade`);
				}
			} catch {
				// Silently ignore — network failure, corrupt data, offline.
			}
		})();
	}

	const { options: sessionOptions } = await logger.time(
		"buildSessionOptions",
		buildSessionOptions,
		parsedArgs,
		scopedModels,
		sessionManager,
		modelRegistry,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.hasUI = isInteractive;
	if (preloadedExtensions && extensionEventBus) {
		sessionOptions.preloadedExtensions = preloadedExtensions;
		sessionOptions.eventBus = extensionEventBus;
	}

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsedArgs.apiKey) {
		if (!sessionOptions.model && !sessionOptions.modelPattern) {
			process.stderr.write(
				`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
			);
			process.exit(1);
		}
		if (sessionOptions.model) {
			authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsedArgs.apiKey);
		}
	}

	// INSTANT-ON: start the bridge BEFORE the heavy session init so the Chrome
	// extension can connect in <200ms (vs 1-4s waiting for MCP/plugins to load).
	// Chat messages that arrive before the session is ready get a "warming up" response.
	let bridgeServer: BridgeServer | null = null;
	let sessionReady = false;
	if (process.env.XCSH_BROWSER_PROVIDER?.toLowerCase() === "extension") {
		const sessionId = process.env.XCSH_SESSION_ID;
		if (!sessionId) {
			throw new Error("The extension bridge requires a manager-bound browser session.");
		}
		const readInfo = () => {
			let apiUrl: string | null = null;
			let contextBound = false;
			try {
				apiUrl = ContextService.instance.activeApiUrl;
				contextBound = ContextService.instance.getStatus().activeContextName != null;
			} catch {
				/* ContextService not initialized */
			}
			apiUrl = apiUrl ?? process.env.XCSH_API_URL ?? null;
			const tenantKey = process.env.XCSH_SESSION_TENANT ?? null;
			const { tenant, env } = deriveTenantEnv(apiUrl, tenantKey);
			return { tenant, env, contextBound, sessionId };
		};
		// Provision the wss cert before binding (network path is provision-once-cached).
		// `undefined` (offline / local-ip.sh unreachable) → the bridge starts ws-only.
		const tls = await resolveBridgeTls();
		bridgeServer = await startBridgeServer(undefined, {
			serveKind: "browser",
			sessionInfo: readInfo,
			...(tls ? { tls } : {}),
		});
		console.error(
			`[xcsh] extension bridge listening on ws://127.0.0.1:${bridgeServer.port}` +
				(bridgeServer.wssPort ? ` + wss://${LOCALIP_HOST}:${bridgeServer.wssPort}` : ""),
		);
		// Make the bridge globally available so ALL selectProvider() calls reuse it
		// (prevents starting a conflicting second bridge on the same port).
		setSharedBridgeServer(bridgeServer);
		ContextService.onContextChange(() => bridgeServer?.broadcastTenantChanged());
		// Warm-up handler: respond to early chat_request before the session loads.
		// Deactivates once sessionReady=true (the real ChatHandler takes over).
		bridgeServer.onMessage(msg => {
			if (sessionReady) return; // real ChatHandler handles it now
			if (msg.type === "chat_request" && typeof msg.id === "string") {
				bridgeServer!.send({
					type: "chat_error",
					id: msg.id,
					reason: "session-busy",
				});
			}
		});
	}

	// CHAT-BACKEND OPTIMIZATIONS: when serving the Chrome extension chat, suppress
	// heavy front-loaded startup that blocks the session. Plugins still load — they
	// just don't block with interactive prompts or welcome-screen network calls.
	if (bridgeServer) {
		// startup.quiet skips the welcome screen + plugin status checks (which do
		// network calls + can show blocking "Fix now?" TUI prompts like AWS SSO).
		settings.override("startup.quiet", true);

		// TOOL SCOPING: restrict the tool set to browser-automation tools only.
		// Without this, the LLM has bash/read/write/todo/spec-reader and orchestrates
		// complex multi-step tool chains instead of calling catalog_workflow_runner
		// directly. With scoped tools, the ONLY way to create a resource is the
		// form-driven workflow runner — exactly what the human watching the browser wants.
		sessionOptions.toolNames = [
			"catalog_workflow_runner",
			"navigate",
			"click",
			"click_element",
			"fill",
			"type_text",
			"screenshot",
			"login",
			"read_ax",
			"get_page_context",
			"query_dom",
			"find",
			"wait_for",
			"key_press",
			"select_option",
			"label_select",
			"scroll_to",
			"annotate",
			"set_explain_mode",
		];
	}

	// YAGNI: skip MCP server discovery (500-3000ms) — not used in our workflow.
	sessionOptions.enableMCP = false;

	const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager, eventBus } = await logger.time(
		"createAgentSession",
		createAgentSession,
		sessionOptions,
	);
	logger.time("main:afterCreateSession");
	profileMark("createAgentSession done");
	if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
		authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
	}

	if (modelFallbackMessage) {
		notifs.push({ kind: "warn", message: modelFallbackMessage });
	}

	const modelRegistryError = modelRegistry.getError();
	if (modelRegistryError) {
		notifs.push({ kind: "error", message: modelRegistryError.message });
	}

	if (!isInteractive && !session.model) {
		if (modelFallbackMessage) {
			process.stderr.write(`${chalk.red(modelFallbackMessage)}\n`);
		} else {
			process.stderr.write(`${chalk.red("No models available.")}\n`);
		}
		process.stderr.write(`${chalk.yellow("\nSet an API key environment variable:")}\n`);
		process.stderr.write("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n");
		process.stderr.write(`${chalk.yellow(`\nOr create ${ModelsConfigFile.path()}`)}\n`);
		process.exit(1);
	}

	const extensionFlagValues = session.extensionRunner?.getFlagValues() ?? new Map<string, boolean | string>();
	const createAcpSession = async (cwd: string) => {
		const nextSettings = await session.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, parsedArgs.sessionDir);
		const nextSessionOptions = { ...sessionOptions };
		delete nextSessionOptions.preloadedExtensions;
		delete nextSessionOptions.eventBus;
		const { session: nextSession } = await createAgentSession({
			...nextSessionOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage,
			modelRegistry,
			hasUI: false,
		});
		if (nextSession.extensionRunner) {
			for (const [flagName, value] of extensionFlagValues) {
				nextSession.extensionRunner.setFlagValue(flagName, value);
			}
		}
		return nextSession;
	};

	// Wire the chat handler + browser provider into the ALREADY-running bridge.
	// The browser provider uses the SAME bridge the chat handler communicates on,
	// so when the LLM calls catalog_workflow_runner, the runner drives the browser
	// through the bridge → the extension → the console tab the user is watching.
	if (bridgeServer) {
		sessionReady = true; // deactivate the warm-up handler

		const chatHandler = new ChatHandler(bridgeServer, session);
		chatHandler.attach();
		session.addDisposeHook(() => {
			chatHandler.dispose();
			return bridgeServer!.close();
		});
	}

	if (mode === "rpc") {
		await runRpcMode(session);
	} else if (mode === "acp") {
		await runAcpMode(session, createAcpSession);
	} else if (isInteractive) {
		const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);

		const scopedModelsForDisplay = sessionOptions.scopedModels ?? scopedModels;
		if (scopedModelsForDisplay.length > 0) {
			const modelList = scopedModelsForDisplay
				.map(scopedModel => {
					const thinkingStr = !scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
					return `${scopedModel.model.id}${thinkingStr}`;
				})
				.join(", ");
			process.stdout.write(`${chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`)}\n`);
		}

		if ($env.PI_TIMING) {
			logger.printTimings();
			if ($env.PI_TIMING === "x") {
				process.exit(0);
			}
		}

		logger.endTiming();
		await runInteractiveMode(
			session,
			VERSION,
			notifs,
			versionCheckPromise,
			parsedArgs.messages,
			setToolUIContext,
			lspServers,
			mcpManager,
			eventBus,
			initialMessage,
			initialImages,
		);
	} else {
		// Non-interactive (--print, piped, --mode json): force temperature=0 for
		// deterministic HCL generation. Interactive mode keeps its configured value.
		session.agent.temperature = 0;
		const exitCode = await runPrintMode(session, {
			mode,
			messages: parsedArgs.messages,
			initialMessage,
			initialImages,
		});
		await session.dispose();
		stopThemeWatcher();
		await postmortem.quit(exitCode);
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
