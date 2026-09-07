import * as os from "node:os";
import * as path from "node:path";

import type { AutocompleteItem } from "@f5-sales-demo/pi-tui";
import { getConfigDirName, isEnoent, t } from "@f5-sales-demo/pi-utils";
import { invalidate as invalidateFsCache } from "../capability/fs";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearXcshPluginRootsCache,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import {
	formatMarketplaceRefreshWarning,
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { parseMarketplaceCatalog } from "../extensibility/plugins/marketplace/fetcher";
import { setupTool } from "../extensibility/plugins/marketplace/prerequisites";
import { getLoginOptions } from "../modes/controllers/login-options";
import type { InteractiveModeContext } from "../modes/types";
import { ContextService } from "../services/xcsh-context";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function tryGetContextService(): ContextService | null {
	try {
		return ContextService.instance;
	} catch (err) {
		// Expected only when the service hasn't been init()'d yet. Any other error
		// is surfaced by rethrowing so the TUI's unhandled-rejection path logs it.
		if (err instanceof Error && err.message.includes("not initialized")) {
			return null;
		}
		throw err;
	}
}

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
}

/** Declarative subcommand definition for commands like /mcp. */
export interface SubcommandDef {
	name: string;
	description: string;
	/** Usage hint shown as dim ghost text, e.g. "<name> [--scope project|user]". */
	usage?: string;
	/**
	 * Optional sync provider for dynamic completions of this subcommand's arguments.
	 *
	 * `argumentPrefix` is the text after the subcommand name and its trailing space.
	 * For multi-token arguments (e.g. `/context unset KEY1 KEY2`), the provider
	 * receives the full tail (`"KEY1 KEY2"`) and must return items whose `value`
	 * contains the complete replacement for that tail — including any already-typed
	 * tokens the user should keep. The infrastructure prepends `<subcommand> ` to
	 * each returned `value` before handing items to `applyCompletion`.
	 *
	 * Return `null` or `[]` to signal "no dropdown"; both are treated identically.
	 */
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

/** Declarative builtin slash command definition used by autocomplete and help UI. */
export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/** Subcommands for dropdown completion (e.g. /mcp add, /mcp list). */
	subcommands?: SubcommandDef[];
	/** Static inline hint when command takes a simple argument (no subcommands). */
	inlineHint?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

interface ParsedBuiltinSlashCommand {
	name: string;
	args: string;
	text: string;
}

interface BuiltinSlashCommandSpec extends BuiltinSlashCommand {
	aliases?: string[];
	allowArgs?: boolean;
	/**
	 * Handle the command. Return a string to pass remaining text through as prompt input.
	 * Return void/undefined to consume the input entirely.
	 */
	handle: (
		command: ParsedBuiltinSlashCommand,
		runtime: BuiltinSlashCommandRuntime,
		// biome-ignore lint/suspicious/noConfusingVoidType: void needed so handlers returning nothing are assignable
	) => Promise<string | undefined> | string | void;
}

export interface BuiltinSlashCommandRuntime {
	ctx: InteractiveModeContext;
	handleBackgroundCommand: () => void;
}

function parseBuiltinSlashCommand(text: string): ParsedBuiltinSlashCommand | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;

	const firstWhitespace = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const firstSeparator =
		firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);

	if (firstSeparator === -1) {
		return {
			name: body,
			args: "",
			text,
		};
	}

	return {
		name: body.slice(0, firstSeparator),
		args: body.slice(firstSeparator + 1).trim(),
		text,
	};
}

const shutdownHandler = (_command: ParsedBuiltinSlashCommand, runtime: BuiltinSlashCommandRuntime): void => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
};

const CONTEXT_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "list", description: t("commands.context.sub.list.description") },
	{
		name: "activate",
		description: t("commands.context.sub.activate.description"),
		usage: "<name>",
		getArgumentCompletions(prefix: string) {
			if (prefix.includes(" ")) return null;
			const svc = tryGetContextService();
			if (!svc) return null;
			const lower = prefix.toLowerCase();
			const items = svc
				.listContextNamesCached()
				.filter(n => n.toLowerCase().startsWith(lower))
				.map(n => {
					const hint = svc.getContextHint(n);
					const parts: string[] = [];
					if (hint?.apiUrl) parts.push(hint.apiUrl);
					if (hint?.incompatible && hint.schemaVersion !== undefined) {
						parts.push(`incompatible: v${hint.schemaVersion}`);
					}
					return {
						value: n,
						label: n,
						description: parts.length > 0 ? parts.join(" · ") : undefined,
					};
				});
			return items.length > 0 ? items : null;
		},
	},
	{
		name: "validate",
		description: t("commands.context.sub.validate.description"),
		usage: "<name>",
		getArgumentCompletions(prefix: string) {
			if (prefix.includes(" ")) return null;
			const svc = tryGetContextService();
			if (!svc) return null;
			const lower = prefix.toLowerCase();
			const items = svc
				.listContextNamesCached()
				.filter(n => n.toLowerCase().startsWith(lower))
				.map(n => {
					const hint = svc.getContextHint(n);
					const parts: string[] = [];
					if (hint?.apiUrl) parts.push(hint.apiUrl);
					if (hint?.incompatible && hint.schemaVersion !== undefined) {
						parts.push(`incompatible: v${hint.schemaVersion}`);
					}
					return {
						value: n,
						label: n,
						description: parts.length > 0 ? parts.join(" · ") : undefined,
					};
				});
			return items.length > 0 ? items : null;
		},
	},
	{ name: "show", description: t("commands.context.sub.show.description"), usage: "[name]" },
	{ name: "status", description: t("commands.context.sub.status.description") },
	{
		name: "create",
		description: t("commands.context.sub.create.description"),
		usage: "<name> <url> <token> [namespace]",
	},
	{ name: "delete", description: t("commands.context.sub.delete.description"), usage: "<name> --confirm" },
	{
		name: "rename",
		description: t("commands.context.sub.rename.description"),
		usage: "<old> <new>",
		getArgumentCompletions(prefix: string) {
			if (prefix.includes(" ")) return null;
			const svc = tryGetContextService();
			if (!svc) return null;
			const lower = prefix.toLowerCase();
			const items = svc
				.listContextNamesCached()
				.filter(n => n.toLowerCase().startsWith(lower))
				.map(n => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
	},
	{
		name: "export",
		description: t("commands.context.sub.export.description"),
		usage: "[name] [--include-token]",
		getArgumentCompletions(prefix: string) {
			const svc = tryGetContextService();
			if (!svc) return null;
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const hasIncludeToken = tokens.includes("--include-token");
			const positionalsTyped = tokens.filter(t => !t.startsWith("--"));
			// Last token is "in-progress" if the prefix does not end with space.
			const trailingSpace = prefix.endsWith(" ") || prefix === "";
			const typedPositionalCount = trailingSpace
				? positionalsTyped.length
				: Math.max(0, positionalsTyped.length - 1);
			const completingToken = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
			// `head` is every already-typed token EXCEPT the one being
			// completed. getArgumentCompletions.value replaces the whole
			// argument tail, so value must carry every token the user
			// should keep — otherwise accepting a suggestion silently
			// drops the other args. Contract: see SubcommandDef JSDoc
			// above (line ~58).
			const headTokens = trailingSpace ? tokens : tokens.slice(0, -1);
			const head = headTokens.length > 0 ? `${headTokens.join(" ")} ` : "";

			const items: { value: string; label: string; description?: string }[] = [];

			// Offer context names only if no positional has been filled yet.
			// No startsWith("--") guard: context names legitimately allow
			// leading dashes (the regex is /^[a-zA-Z0-9_-]{1,64}$/), and
			// the handler's splitArgs uses a known-flags allowlist that
			// treats only --include-token as a flag. So a context like
			// `--prod` is valid; the completion filters by prefix and
			// matches it naturally. When the user types `--in`, the
			// flag-completion branch below matches `--include-token` by
			// prefix; if there's ALSO a context starting with `--in` it
			// is offered here. Both lists are disjoint by filter so
			// there's no double-offer of the same token.
			if (typedPositionalCount === 0) {
				const lower = completingToken.toLowerCase();
				for (const n of svc.listContextNamesCached()) {
					if (!n.toLowerCase().startsWith(lower)) continue;
					const hint = svc.getContextHint(n);
					items.push({
						value: `${head}${n}`,
						label: n,
						description: hint?.apiUrl,
					});
				}
			}

			// Offer --include-token unless already present. Match is
			// case-sensitive because the handler's flag check uses
			// exact-match `flags.has("--include-token")` — offering
			// the suggestion for mis-cased prefixes (e.g. `--INCLUDE`)
			// would produce a suggestion the handler then ignores.
			if (!hasIncludeToken && "--include-token".startsWith(completingToken)) {
				items.push({
					value: `${head}--include-token`,
					label: "--include-token",
					description: "emit unmasked tokens",
				});
			}

			return items.length > 0 ? items : null;
		},
	},
	{
		name: "import",
		description: t("commands.context.sub.import.description"),
		usage: "<path-or-json> [--overwrite]",
		// No dynamic completion — paths are hard to complete correctly,
		// and faking it would only mislead. Users pre-expand paths in
		// their shell.
	},
	{
		name: "namespace",
		description: t("commands.context.sub.namespace.description"),
		usage: "<namespace>",
		getArgumentCompletions(prefix: string) {
			if (prefix.includes(" ")) return null;
			const svc = tryGetContextService();
			if (!svc) return null;
			// setNamespace() requires an active context. Don't offer completions that
			// would lead the user into a command path that cannot succeed (e.g. an
			// env-backed session where cached namespaces came from startup validation
			// but there is no active context to apply them to).
			if (!svc.getStatus().activeContextName) return null;
			const lower = prefix.toLowerCase();
			const items = svc
				.getCachedNamespaces()
				.filter(n => n.toLowerCase().startsWith(lower))
				.map(n => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
	},
	{ name: "env", description: t("commands.context.sub.env.description"), usage: "set|unset|list [KEY=VALUE ...]" },
	{ name: "set", description: t("commands.context.sub.set.description"), usage: "KEY=VALUE [KEY2=VALUE2 ...]" },
	{
		name: "unset",
		description: t("commands.context.sub.unset.description"),
		usage: "KEY [KEY2 ...]",
		getArgumentCompletions(prefix: string) {
			const lastSpace = prefix.lastIndexOf(" ");
			const headRaw = lastSpace === -1 ? "" : prefix.slice(0, lastSpace + 1);
			const tail = lastSpace === -1 ? prefix : prefix.slice(lastSpace + 1);
			const svc = tryGetContextService();
			if (!svc) return null;
			const knownKeys = svc.getActiveEnvKeys();
			const knownExact = new Set(knownKeys);
			// Group known keys by their lowercased form so we can detect
			// case-distinct collisions (e.g. both `Foo` and `FOO` present).
			const variantsByLower = new Map<string, string[]>();
			for (const k of knownKeys) {
				const lower = k.toLowerCase();
				const existing = variantsByLower.get(lower);
				if (existing) existing.push(k);
				else variantsByLower.set(lower, [k]);
			}
			// Normalization priority:
			//   1. Exact-case match → preserve user's token verbatim
			//   2. Lowercase maps to exactly one canonical → rewrite (the common
			//      "user typed lowercase, context has uppercase" path)
			//   3. Lowercase maps to multiple canonicals (ambiguous) → preserve
			//      as-typed. Auto-picking one would silently target the wrong
			//      variable. The handler will match nothing and report a no-op,
			//      letting the user retype the exact case they meant.
			//   4. No match → preserve as-typed so typos surface via handler.
			const typedTokens = headRaw.trim().split(/\s+/).filter(Boolean);
			const normalizedTokens = typedTokens.map(t => {
				if (knownExact.has(t)) return t;
				const variants = variantsByLower.get(t.toLowerCase());
				if (variants && variants.length === 1) return variants[0];
				return t;
			});
			const head = normalizedTokens.length > 0 ? `${normalizedTokens.join(" ")} ` : "";
			const alreadyExact = new Set(normalizedTokens);
			const items = knownKeys
				.filter(k => !alreadyExact.has(k))
				.filter(k => k.toLowerCase().startsWith(tail.toLowerCase()))
				.map(k => ({
					value: `${head}${k} `,
					label: k,
					description: "env var on active context",
				}));
			return items.length > 0 ? items : null;
		},
	},
	{ name: "wizard", description: t("commands.context.sub.wizard.description") },
];

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<BuiltinSlashCommandSpec> = [
	{
		name: "settings",
		description: t("commands.settings.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: t("commands.plan.description"),
		inlineHint: t("commands.plan.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: t("commands.model.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: t("commands.fast.description"),
		subcommands: [
			{ name: "on", description: t("commands.fast.sub.on.description") },
			{ name: "off", description: t("commands.fast.sub.off.description") },
			{ name: "status", description: t("commands.fast.sub.status.description") },
		],
		allowArgs: true,
		handle: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(enabled ? t("commands.fast.enabled") : t("commands.fast.disabled"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(t("commands.fast.enabled"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(t("commands.fast.disabled"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				const enabled = runtime.ctx.session.isFastModeEnabled();
				runtime.ctx.showStatus(enabled ? t("commands.fast.statusOn") : t("commands.fast.statusOff"));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(t("commands.fast.usage"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: t("commands.export.description"),
		inlineHint: t("commands.export.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: t("commands.dump.description"),
		handle: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: t("commands.share.description"),
		handle: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "browser",
		description: t("commands.browser.description"),
		subcommands: [
			{ name: "headless", description: t("commands.browser.sub.headless.description") },
			{ name: "visible", description: t("commands.browser.sub.visible.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning(t("commands.browser.disabled"));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (["headless", "hidden"].includes(arg)) {
				next = true;
			} else if (["visible", "show", "headful"].includes(arg)) {
				next = false;
			} else {
				runtime.ctx.showStatus(t("commands.browser.usage"));
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(
						t("commands.browser.restartFailed", {
							message: error instanceof Error ? error.message : String(error),
						}),
					);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(next ? t("commands.browser.modeHeadless") : t("commands.browser.modeVisible"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "chrome",
		description: t("commands.chrome.description"),
		subcommands: [
			{ name: "status", description: t("commands.chrome.sub.status.description") },
			{ name: "relaunch", description: t("commands.chrome.sub.relaunch.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const action = command.args.trim().toLowerCase() === "relaunch" ? "relaunch" : "status";
			const { runChromeCommand } = await import("../cli/chrome-cli");
			try {
				runtime.ctx.showStatus(await runChromeCommand(action, settings));
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "copy",
		description: t("commands.copy.description"),
		subcommands: [
			{ name: "last", description: t("commands.copy.sub.last.description") },
			{ name: "code", description: t("commands.copy.sub.code.description") },
			{ name: "all", description: t("commands.copy.sub.all.description") },
			{ name: "cmd", description: t("commands.copy.sub.cmd.description") },
			{ name: "link", description: t("commands.copy.sub.link.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || undefined;
			await runtime.ctx.handleCopyCommand(sub);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "open",
		description: t("commands.open.description"),
		allowArgs: true,
		handle: async (command, runtime) => {
			await runtime.ctx.handleOpenCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: t("commands.session.description"),
		subcommands: [
			{ name: "info", description: t("commands.session.sub.info.description") },
			{ name: "delete", description: t("commands.session.sub.delete.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: t("commands.jobs.description"),
		handle: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: t("commands.usage.description"),
		handle: async (_command, runtime) => {
			await runtime.ctx.handleUsageCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "changelog",
		description: t("commands.changelog.description"),
		subcommands: [{ name: "full", description: t("commands.changelog.sub.full.description") }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: t("commands.hotkeys.description"),
		handle: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: t("commands.tools.description"),
		handle: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: t("commands.extensions.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: t("commands.agents.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: t("commands.branch.description"),
		handle: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: t("commands.fork.description"),
		handle: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: t("commands.tree.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: t("commands.login.description"),
		inlineHint: t("commands.login.inlineHint"),
		allowArgs: true,
		handle: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getLoginOptions().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? t("commands.login.alreadyInProgressFor", { provider: pendingProvider })
							: t("commands.login.alreadyInProgress");
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus(t("commands.login.callbackReceived"));
				} else {
					runtime.ctx.showWarning(t("commands.login.noCallbackWaiting"));
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? t("commands.login.alreadyInProgressFor", { provider })
					: t("commands.login.alreadyInProgress");
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: t("commands.logout.description"),
		handle: (_command, runtime) => {
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: t("commands.mcp.description"),
		subcommands: [
			{
				name: "add",
				description: t("commands.mcp.sub.add.description"),
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: t("commands.mcp.sub.list.description") },
			{
				name: "remove",
				description: t("commands.mcp.sub.remove.description"),
				usage: "<name> [--scope project|user]",
			},
			{ name: "test", description: t("commands.mcp.sub.test.description"), usage: "<name>" },
			{ name: "reauth", description: t("commands.mcp.sub.reauth.description"), usage: "<name>" },
			{ name: "unauth", description: t("commands.mcp.sub.unauth.description"), usage: "<name>" },
			{ name: "enable", description: t("commands.mcp.sub.enable.description"), usage: "<name>" },
			{ name: "disable", description: t("commands.mcp.sub.disable.description"), usage: "<name>" },
			{
				name: "smithery-search",
				description: t("commands.mcp.sub.smitherySearch.description"),
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: t("commands.mcp.sub.smitheryLogin.description") },
			{ name: "smithery-logout", description: t("commands.mcp.sub.smitheryLogout.description") },
			{ name: "reconnect", description: t("commands.mcp.sub.reconnect.description"), usage: "<name>" },
			{ name: "reload", description: t("commands.mcp.sub.reload.description") },
			{ name: "resources", description: t("commands.mcp.sub.resources.description") },
			{ name: "prompts", description: t("commands.mcp.sub.prompts.description") },
			{ name: "notifications", description: t("commands.mcp.sub.notifications.description") },
			{ name: "help", description: t("commands.mcp.sub.help.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: t("commands.ssh.description"),
		subcommands: [
			{
				name: "add",
				description: t("commands.ssh.sub.add.description"),
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: t("commands.ssh.sub.list.description") },
			{
				name: "remove",
				description: t("commands.ssh.sub.remove.description"),
				usage: "<name> [--scope project|user]",
			},
			{ name: "help", description: t("commands.ssh.sub.help.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "media",
		description: "Control rich-media playback",
		subcommands: [
			{ name: "play", description: "Play media", usage: "<latest|id>" },
			{ name: "pause", description: "Pause media", usage: "<latest|id>" },
			{ name: "stop", description: "Stop and reset media", usage: "<latest|id>" },
		],
		allowArgs: true,
		handle: (command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.ctx.handleMediaCommand(command.text);
		},
	},
	{
		name: "new",
		description: t("commands.new.description"),
		handle: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "compact",
		description: t("commands.compact.description"),
		inlineHint: t("commands.compact.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCompactCommand(customInstructions);
		},
	},
	{
		name: "handoff",
		description: t("commands.handoff.description"),
		inlineHint: t("commands.handoff.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: t("commands.resume.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showSessionSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "btw",
		description: t("commands.btw.description"),
		inlineHint: t("commands.btw.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "background",
		aliases: ["bg"],
		description: t("commands.background.description"),
		handle: (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.handleBackgroundCommand();
		},
	},
	{
		name: "debug",
		description: t("commands.debug.description"),
		handle: (_command, runtime) => {
			runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: t("commands.memory.description"),
		subcommands: [
			{ name: "view", description: t("commands.memory.sub.view.description") },
			{ name: "clear", description: t("commands.memory.sub.clear.description") },
			{ name: "reset", description: t("commands.memory.sub.reset.description") },
			{ name: "enqueue", description: t("commands.memory.sub.enqueue.description") },
			{ name: "rebuild", description: t("commands.memory.sub.rebuild.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: t("commands.rename.description"),
		inlineHint: t("commands.rename.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError(t("commands.rename.usage"));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},

	{
		name: "move",
		description: t("commands.move.description"),
		inlineHint: t("commands.move.inlineHint"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const targetPath = command.args;
			if (!targetPath) {
				runtime.ctx.showError(t("commands.move.usage"));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(targetPath);
		},
	},
	{
		name: "exit",
		description: t("commands.exit.description"),
		handle: shutdownHandler,
	},
	{
		name: "plugin",
		aliases: ["marketplace", "plugins"],
		description: t("commands.plugin.description"),
		subcommands: [
			{ name: "marketplace", description: t("commands.plugin.sub.marketplace.description") },
			{
				name: "install",
				description: t("commands.plugin.sub.install.description"),
				usage: "[--force] [--scope user|project] <name@marketplace>",
			},
			{
				name: "uninstall",
				description: t("commands.plugin.sub.uninstall.description"),
				usage: "[--scope user|project] <name@marketplace>",
			},
			{
				name: "enable",
				description: t("commands.plugin.sub.enable.description"),
				usage: "[--scope user|project] <name@marketplace>",
			},
			{
				name: "disable",
				description: t("commands.plugin.sub.disable.description"),
				usage: "[--scope user|project] <name@marketplace>",
			},
			{
				name: "upgrade",
				description: t("commands.plugin.sub.upgrade.description"),
				usage: "[--scope user|project] [name@marketplace]",
			},
			{ name: "discover", description: t("commands.plugin.sub.discover.description"), usage: "[marketplace]" },
			{ name: "list", description: t("commands.plugin.sub.list.description") },
			{ name: "validate", description: t("commands.plugin.sub.validate.description"), usage: "[path]" },
			{ name: "setup", description: t("commands.plugin.sub.setup.description") },
			{ name: "help", description: t("commands.plugin.sub.help.description") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "";
			const rest = args.slice(1).join(" ").trim();

			// /plugin (no args) → open interactive dashboard
			if (!sub) {
				runtime.ctx.showPluginDashboard();
				return;
			}

			// /plugin install (no args) → interactive browser
			if (sub === "install" && !rest) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(t("commands.plugin.error", { message: String(err) }));
				}
				return;
			}

			// /plugin list (no args) → open interactive dashboard
			if (sub === "list" && !rest) {
				runtime.ctx.showPluginDashboard();
				return;
			}

			// /plugin uninstall (no args) → interactive uninstall selector
			if (sub === "uninstall" && !rest) {
				try {
					runtime.ctx.showPluginSelector("uninstall");
				} catch (err) {
					runtime.ctx.showStatus(t("commands.plugin.error", { message: String(err) }));
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: (extraPaths?: readonly string[]) => {
					const home = os.homedir();
					invalidateFsCache(path.join(home, getConfigDirName(), "plugins", "installed_plugins.json"));
					for (const p of extraPaths ?? []) invalidateFsCache(p);
					clearXcshPluginRootsCache();
				},
			});

			try {
				const showPluginStatus = (
					message: string,
					refresh?: Awaited<ReturnType<typeof mgr.refreshMarketplaces>>,
				) => {
					const warning = refresh ? formatMarketplaceRefreshWarning(refresh) : undefined;
					runtime.ctx.showStatus(warning ? `${warning}\n\n${message}` : message);
				};
				switch (sub) {
					// ── Marketplace management (/plugin marketplace add|remove|update|list) ──
					case "marketplace": {
						const mktArgs = rest.split(/\s+/);
						const mktSub = mktArgs[0] || "";
						const mktRest = mktArgs.slice(1).join(" ").trim();
						switch (mktSub) {
							case "add": {
								if (!mktRest) {
									runtime.ctx.showStatus(t("commands.plugin.marketplace.addUsage"));
									return;
								}
								const entry = await mgr.addMarketplace(mktRest);
								runtime.ctx.showStatus(t("commands.plugin.marketplace.added", { name: entry.name }));
								break;
							}
							case "remove":
							case "rm": {
								if (!mktRest) {
									runtime.ctx.showStatus(t("commands.plugin.marketplace.removeUsage"));
									return;
								}
								await mgr.removeMarketplace(mktRest);
								runtime.ctx.showStatus(t("commands.plugin.marketplace.removed", { name: mktRest }));
								break;
							}
							case "update": {
								if (mktRest) {
									await mgr.updateMarketplace(mktRest);
									runtime.ctx.showStatus(t("commands.plugin.marketplace.updated", { name: mktRest }));
								} else {
									const refresh = await mgr.refreshMarketplaces();
									showPluginStatus(
										t("commands.plugin.marketplace.updatedAll", { count: refresh.successful.length }),
										refresh,
									);
								}
								break;
							}
							default: {
								const marketplaces = await mgr.listMarketplaces();
								if (marketplaces.length === 0) {
									runtime.ctx.showStatus(t("commands.plugin.marketplace.noneConfiguredGetStarted"));
								} else {
									const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
									runtime.ctx.showStatus(
										`Marketplaces:\n${lines.join("\n")}\n\n${t("commands.plugin.marketplace.listHint")}`,
									);
								}
								break;
							}
						}
						break;
					}
					// ── Legacy shorthand: /marketplace add|remove|update → /plugin marketplace ──
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus(t("commands.plugin.marketplace.addUsage"));
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(t("commands.plugin.marketplace.added", { name: entry.name }));
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus(t("commands.plugin.marketplace.removeUsage"));
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(t("commands.plugin.marketplace.removed", { name: rest }));
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(t("commands.plugin.marketplace.updated", { name: rest }));
						} else {
							const refresh = await mgr.refreshMarketplaces();
							showPluginStatus(
								t("commands.plugin.marketplace.updatedAll", { count: refresh.successful.length }),
								refresh,
							);
						}
						break;
					}
					// ── Plugin discovery ──
					case "discover": {
						const refresh = await mgr.refreshMarketplaces(rest ? [rest] : undefined);
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								showPluginStatus(t("commands.plugin.marketplace.noneConfiguredTry"), refresh);
							} else {
								showPluginStatus(t("commands.plugin.marketplace.noPluginsAvailable"), refresh);
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							showPluginStatus(`Available plugins:\n${lines.join("\n")}`, refresh);
						}
						break;
					}
					// ── Install ──
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						const refresh = await mgr.refreshMarketplaces([marketplace]);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						showPluginStatus(t("commands.plugin.installed", { name, marketplace }), refresh);
						break;
					}
					// ── Uninstall ──
					case "uninstall": {
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"Usage: /plugin uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(t("commands.plugin.uninstalled", { pluginId: uninstArgs.pluginId }));
						break;
					}
					// ── Enable / Disable ──
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugin ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(
							isEnable
								? t("commands.plugin.enabled", { pluginId: parsed.pluginId })
								: t("commands.plugin.disabled", { pluginId: parsed.pluginId }),
						);
						break;
					}
					// ── Upgrade ──
					case "upgrade": {
						const refresh = await mgr.refreshMarketplaces();
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"Usage: /plugin upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							showPluginStatus(
								t("commands.plugin.upgraded", { pluginId: upArgs.pluginId, version: result.version }),
								refresh,
							);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								showPluginStatus(t("commands.plugin.allUpToDate"), refresh);
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								showPluginStatus(
									`${t("commands.plugin.upgradedCount", { count: results.length })}:\n${lines.join("\n")}`,
									refresh,
								);
							}
						}
						break;
					}
					// ── Installed list ──
					case "installed": {
						const lines: string[] = [];
						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push(t("commands.plugin.npmPlugins"));
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}
						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push(t("commands.plugin.marketplacePlugins"));
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}
						if (lines.length === 0) {
							runtime.ctx.showStatus(t("commands.plugin.noneInstalled"));
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
					// ── Validate ──
					case "validate": {
						const targetPath = rest
							? path.resolve(runtime.ctx.sessionManager.getCwd(), rest)
							: runtime.ctx.sessionManager.getCwd();
						const catalogPath = path.join(targetPath, ".xcsh-plugin", "marketplace.json");
						const pluginPath = path.join(targetPath, ".xcsh-plugin", "plugin.json");
						const catalogContent = await readOptionalTextFile(catalogPath);
						if (catalogContent !== undefined) {
							const catalog = parseMarketplaceCatalog(catalogContent, catalogPath);
							runtime.ctx.showStatus(
								t("commands.plugin.validate.marketplaceValid", {
									name: catalog.name,
									count: catalog.plugins.length,
								}),
							);
						} else {
							const pluginContent = await readOptionalTextFile(pluginPath);
							if (pluginContent === undefined) {
								runtime.ctx.showStatus(t("commands.plugin.validate.notFound", { path: targetPath }));
								break;
							}
							const manifest = JSON.parse(pluginContent);
							runtime.ctx.showStatus(
								t("commands.plugin.validate.pluginValid", { name: manifest.name ?? path.basename(targetPath) }),
							);
						}
						break;
					}
					// ── Setup (guided recommended plugin install) ──
					case "setup": {
						const refresh = await mgr.refreshMarketplaces();
						const allPlugins = await mgr.listAvailablePlugins();
						const recommended = allPlugins.filter(p => p.recommended);
						if (recommended.length === 0) {
							showPluginStatus(t("commands.plugin.setup.noRecommended"), refresh);
							break;
						}

						const installedPlugins = await mgr.listInstalledPlugins();
						const installedIds = new Set(installedPlugins.map(p => p.id));
						const toSetup = recommended.filter(
							p => !Array.from(installedIds).some(id => id.startsWith(`${p.name}@`)),
						);

						if (toSetup.length === 0) {
							showPluginStatus(t("commands.plugin.setup.allInstalled"), refresh);
							break;
						}

						const lines: string[] = [`${t("commands.plugin.setup.title")}\n`];
						let pluginInstalledCount = 0;
						let skippedCount = 0;

						for (const plugin of toSetup) {
							const name = plugin.displayName || plugin.name;

							// Step 1: Setup prerequisites (detect → install → auth)
							if (plugin.prerequisites && plugin.prerequisites.length > 0) {
								let prerequisitesReady = true;
								for (const prereq of plugin.prerequisites) {
									const result = await setupTool(prereq);

									if (!result.installSuccess && result.installAttempted) {
										lines.push(
											`  x ${name} — ${prereq.tool}: ${t("commands.plugin.setup.installFailed")} (${result.error})`,
										);
										lines.push(`    Fix: ${prereq.installCmd}`);
										prerequisitesReady = false;
										break;
									}

									if (result.installAttempted && result.installSuccess) {
										lines.push(`  + ${name} — ${prereq.tool}: ${t("commands.plugin.setup.installed")}`);
									}

									if (!result.authenticated && prereq.authLoginCmd) {
										lines.push(
											`  ~ ${name} — ${prereq.tool}: ${t("commands.plugin.setup.notAuthenticated")}`,
										);
										lines.push(`    Run: ${prereq.authLoginCmd}`);
									} else if (result.authenticated && result.user) {
										lines.push(
											`  ✓ ${name} — ${prereq.tool}: ${t("commands.plugin.setup.authenticatedAs", { user: result.user })}`,
										);
									} else if (result.authenticated) {
										lines.push(`  ✓ ${name} — ${prereq.tool}: ${t("commands.plugin.setup.ready")}`);
									}
								}
								if (!prerequisitesReady) {
									skippedCount++;
									continue;
								}
							}

							// Step 2: Install the plugin
							const marketplaces = await mgr.listMarketplaces();
							let didInstall = false;
							for (const mkt of marketplaces) {
								const available = await mgr.listAvailablePlugins(mkt.name);
								if (available.some(a => a.name === plugin.name)) {
									try {
										await mgr.installPlugin(plugin.name, mkt.name);
										lines.push(`  ✓ ${name} — ${t("commands.plugin.setup.pluginInstalled")}`);
										pluginInstalledCount++;
										didInstall = true;
									} catch (err) {
										lines.push(
											`  ! ${name} — ${t("commands.plugin.setup.pluginInstallFailed", { message: err instanceof Error ? err.message : String(err) })}`,
										);
										skippedCount++;
									}
									break;
								}
							}
							if (!didInstall && skippedCount === 0) {
								lines.push(`  ? ${name} — ${t("commands.plugin.setup.notFoundInMarketplace")}`);
								skippedCount++;
							}
						}

						lines.push("");
						lines.push(
							t("commands.plugin.setup.installCount", {
								installed: pluginInstalledCount,
								total: toSetup.length,
							}),
						);
						if (skippedCount > 0) {
							lines.push(t("commands.plugin.setup.skippedCount", { count: skippedCount }));
						}
						showPluginStatus(lines.join("\n"), refresh);
						break;
					}
					// ── Help ──
					case "help": {
						runtime.ctx.showStatus(t("commands.plugin.help"));
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(t("commands.plugin.marketplace.noneConfiguredBrowse"));
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`Marketplaces:\n${lines.join("\n")}\n\n${t("commands.plugin.marketplace.listHintAll")}`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(t("commands.plugin.error", { message: msg }));
			}
		},
	},
	{
		name: "reload-plugins",
		description: t("commands.reloadPlugins.description"),
		handle: async (_command, runtime) => {
			// Invalidate the fs content cache for all registry files so
			// listXcshPluginRoots re-reads from disk on next access.
			const home = os.homedir();
			invalidateFsCache(path.join(home, getConfigDirName(), "plugins", "installed_plugins.json"));
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			if (projectPath) invalidateFsCache(projectPath);
			clearXcshPluginRootsCache();
			await runtime.ctx.refreshSlashCommandState();
			runtime.ctx.showStatus(t("commands.reloadPlugins.done"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: t("commands.force.description"),
		inlineHint: t("commands.force.inlineHint"),
		allowArgs: true,
		handle: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError(t("commands.force.usage"));
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(t("commands.force.set", { toolName }));
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return prompt;
		},
	},
	{
		name: "quit",
		description: t("commands.quit.description"),
		handle: shutdownHandler,
	},
	{
		name: "apply",
		description: "Apply a configuration to a resource from a file (create or update)",
		inlineHint: "-f <file.json|file.yaml> [-n namespace] [--dry-run=client|server]",
		allowArgs: true,
		getArgumentCompletions(_prefix: string) {
			return null;
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("apply", command, runtime.ctx);
		},
	},
	{
		name: "create",
		description: "Create a resource from a file (fail if exists)",
		inlineHint: "-f <file.json|file.yaml> [-n namespace] [--dry-run=client|server]",
		allowArgs: true,
		getArgumentCompletions(_prefix: string) {
			return null;
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("create", command, runtime.ctx);
		},
	},
	{
		name: "delete",
		description: "Delete a resource by file or by kind and name",
		inlineHint: "<kind> <name> | -f <file> [-n namespace] [--force]",
		allowArgs: true,
		getArgumentCompletions(prefix: string) {
			try {
				const { getKindCompletions } = require("./resource-commands") as typeof import("./resource-commands");
				return getKindCompletions(prefix);
			} catch {
				return null;
			}
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("delete", command, runtime.ctx);
		},
	},
	{
		name: "describe",
		description: "Show detailed information about a resource",
		inlineHint: "<kind> <name> [-n namespace] [-o json|yaml]",
		allowArgs: true,
		getArgumentCompletions(prefix: string) {
			try {
				const { getKindCompletions } = require("./resource-commands") as typeof import("./resource-commands");
				return getKindCompletions(prefix);
			} catch {
				return null;
			}
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("describe", command, runtime.ctx);
		},
	},
	{
		name: "diff",
		description: "Preview what changes would be applied from a file",
		inlineHint: "-f <file.json|file.yaml> [-n namespace]",
		allowArgs: true,
		getArgumentCompletions(_prefix: string) {
			return null;
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("diff", command, runtime.ctx);
		},
	},
	{
		name: "get",
		description: "List or fetch F5 XC resources",
		inlineHint: "<kind> [name] [-n namespace] [-o json|yaml|table]",
		allowArgs: true,
		getArgumentCompletions(prefix: string) {
			try {
				const { getKindCompletions } = require("./resource-commands") as typeof import("./resource-commands");
				return getKindCompletions(prefix);
			} catch {
				return null;
			}
		},
		handle: async (command, runtime) => {
			const { handleResourceCommand } = await import("./resource-commands");
			await handleResourceCommand("get", command, runtime.ctx);
		},
	},
	{
		name: "manifest",
		description: "Export live F5 XC resources as {kind, metadata, spec} manifest files",
		inlineHint: "<kind> [name] [-n namespace] [-o json|yaml] [-f output-path] [--all]",
		allowArgs: true,
		getArgumentCompletions(prefix: string) {
			try {
				const { getExportKindCompletions } = require("./export-command") as typeof import("./export-command");
				return getExportKindCompletions(prefix);
			} catch {
				return null;
			}
		},
		handle: async (command, runtime) => {
			const { handleExportResourceCommand } = await import("./export-command");
			await handleExportResourceCommand(command, runtime.ctx);
		},
	},
	{
		name: "context",
		description: t("commands.context.description"),
		allowArgs: true,
		getArgumentCompletions(argumentPrefix: string) {
			const firstSpace = argumentPrefix.indexOf(" ");
			if (firstSpace !== -1) {
				const subName = argumentPrefix.slice(0, firstSpace).toLowerCase();
				const subPrefix = argumentPrefix.slice(firstSpace + 1).replace(/^ +/, "");
				const sub = CONTEXT_SUBCOMMANDS.find(s => s.name === subName);
				if (!sub?.getArgumentCompletions) return null;
				const items = sub.getArgumentCompletions(subPrefix);
				if (!items || items.length === 0) return null;
				return items.map(item => ({ ...item, value: `${subName} ${item.value}` }));
			}
			const lower = argumentPrefix.toLowerCase();
			const items: { value: string; label: string; description?: string; hint?: string }[] = [];
			const svc = tryGetContextService();
			if (svc) {
				for (const n of svc.listContextNamesCached()) {
					if (!n.toLowerCase().startsWith(lower)) continue;
					const hint = svc.getContextHint(n);
					items.push({
						value: `${n} `,
						label: n,
						description: hint?.apiUrl,
					});
				}
				if (svc.previousContextName && "-".startsWith(lower)) {
					items.push({
						value: "- ",
						label: "-",
						description: `Switch to ${svc.previousContextName}`,
					});
				}
			}
			for (const sub of CONTEXT_SUBCOMMANDS) {
				if (!sub.name.toLowerCase().startsWith(lower)) continue;
				items.push({
					value: `${sub.name} `,
					label: sub.name,
					description: sub.description,
					hint: sub.usage,
				});
			}
			return items.length > 0 ? items : null;
		},
		subcommands: CONTEXT_SUBCOMMANDS,
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			const { ContextCommandController } = await import("../modes/controllers/context-command-controller");
			const controller = new ContextCommandController(runtime.ctx);
			await controller.handle(command);
		},
	},
	{
		name: "route",
		description: "Display or configure provider-agnostic dynamic model routing",
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Display dynamic routing status and active tier" },
			{ name: "off", description: "Disable dynamic model routing" },
			{ name: "shadow", description: "Record dynamic model routing decisions speculatively without switching" },
			{ name: "auto", description: "Enable dynamic model routing and clear manual model pins" },
			{ name: "profile", description: "Select a provider-sticky subscription routing profile" },
		],
		handle: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			const { handleRouteCommand } = await import("../routing/commands");
			const args = command.args ? command.args.split(/\s+/) : ["status"];
			const status = runtime.ctx.session.getRoutingStatus();
			const currentModel = runtime.ctx.session.model
				? `${runtime.ctx.session.model.provider}/${runtime.ctx.session.model.id}`
				: "unknown";
			const res = await handleRouteCommand(args, {
				coordinator: (runtime.ctx.session as any).routingCoordinator,
				currentModel,
				mode: status.mode,
				profile: status.profile,
			});
			if (res.newMode) {
				runtime.ctx.session.setRoutingMode(res.newMode);
			}
			if (res.newProfile) {
				const applied = await runtime.ctx.session.applyRoutingProfile(res.newProfile);
				if (!applied.applied) {
					res.output = `Routing profile ${res.newProfile} unavailable: ${applied.missingModels.join(", ")}`;
				}
			}
			(runtime.ctx.ui as any).notify?.(res.output, "info");
		},
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, BuiltinSlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getArgumentCompletions: command.getArgumentCompletions,
	}),
);

/**
 * Execute a builtin slash command when it matches known command syntax.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command consumed
 * the input entirely. Returns a `string` when the command was handled but remaining
 * text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseBuiltinSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}

	const remaining = await command.handle(parsed, runtime);
	return remaining ?? true;
}
