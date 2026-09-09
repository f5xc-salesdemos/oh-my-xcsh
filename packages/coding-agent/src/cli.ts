#!/usr/bin/env bun
import { APP_NAME, initI18n, MIN_BUN_VERSION, registerLocales, t, VERSION } from "@f5-sales-demo/pi-utils";
/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { CliUsageError, type CommandEntry, run } from "@f5-sales-demo/pi-utils/cli";
import { validateInlineFlagSyntax } from "./cli/flag-spec";
import { findPrefixedCommand, launchFlagScopeMessage } from "./cli/root-command-routing";
import { sandboxArgs, sandboxFlags, validateSandboxInvocation } from "./cli/sandbox-spec";
import { locales } from "./locales/index";

registerLocales(locales);
initI18n();

function parseSemver(version: string): [number, number, number] {
	function toint(value: string): number {
		const int = Number.parseInt(value, 10);
		if (Number.isNaN(int) || !Number.isFinite(int)) return 0;
		return int;
	}
	const [majorRaw, minorRaw, patchRaw] = version.split(".").map(toint);
	return [majorRaw, minorRaw, patchRaw];
}

function isAtLeastBunVersion(minimum: string): boolean {
	const ver = parseSemver(Bun.version);
	const min = parseSemver(minimum);
	for (let i = 0; i < 3; i++) {
		if (ver[i] !== min[i]) {
			return ver[i] > min[i];
		}
	}
	return true;
}

if (typeof Bun.JSONL?.parseChunk !== "function" || !isAtLeastBunVersion(MIN_BUN_VERSION)) {
	process.stderr.write(
		`${t("cli.errors.bunVersion", { minVersion: MIN_BUN_VERSION, currentVersion: Bun.version })}\n`,
	);
	process.exit(1);
}

// Detect known Bun errata that cause TUI crashes (e.g. Bun.stringWidth mishandling OSC sequences).
if (Bun.stringWidth("\x1b[0m\x1b]8;;\x07") !== 0) {
	process.stderr.write(`${t("cli.errors.bunErrata", { version: Bun.version })}\n`);
	process.exit(1);
}

process.title = APP_NAME;

const commands: CommandEntry[] = [
	{ name: "apply", load: () => import("./commands/apply").then(m => m.default) },
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "agents", load: () => import("./commands/agents").then(m => m.default) },
	{ name: "commit", load: () => import("./commands/commit").then(m => m.default) },
	{ name: "create", load: () => import("./commands/create").then(m => m.default) },
	{ name: "delete", load: () => import("./commands/delete").then(m => m.default) },
	{ name: "diff", load: () => import("./commands/diff").then(m => m.default) },
	{ name: "export", load: () => import("./commands/export").then(m => m.default) },
	{ name: "get", load: () => import("./commands/get").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "chrome", load: () => import("./commands/chrome").then(m => m.default) },
	{ name: "chrome-host", load: () => import("./commands/native-host").then(m => m.default) },
	{ name: "grep", load: () => import("./commands/grep").then(m => m.default) },
	{ name: "herdr", load: () => import("./commands/herdr").then(m => m.default) },
	{ name: "grievances", load: () => import("./commands/grievances").then(m => m.default) },
	{ name: "read", load: () => import("./commands/read").then(m => m.default) },
	{
		name: "sandbox",
		load: () => import("./commands/sandbox").then(m => m.default),
		validate: argv => validateSandboxInvocation(argv, APP_NAME),
		syntax: { args: sandboxArgs, flags: sandboxFlags },
	},
	{ name: "jupyter", load: () => import("./commands/jupyter").then(m => m.default) },
	{ name: "lifecycle", load: () => import("./commands/lifecycle").then(m => m.default) },
	{ name: "manager", load: () => import("./commands/manager").then(m => m.default) },
	{ name: "office", load: () => import("./commands/office").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "shell", load: () => import("./commands/shell").then(m => m.default) },
	{ name: "ssh", load: () => import("./commands/ssh").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "worker", load: () => import("./commands/worker").then(m => m.default) },
	{ name: "search", load: () => import("./commands/web-search").then(m => m.default), aliases: ["q"] },
	{ name: "self-update", load: () => import("./commands/self-update").then(m => m.default) },
	{ name: "validate", load: () => import("./commands/validate").then(m => m.default) },
];

async function showHelp(config: import("@f5-sales-demo/pi-utils/cli").CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@f5-sales-demo/pi-utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}

/**
 * Determine whether argv[0] is a known subcommand name.
 * If not, the entire argv is treated as args to the default "launch" command.
 */
function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(e => e.name === first || e.aliases?.includes(first));
}

function requestsHelp(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === "--help" || arg === "-h") return true;
	}
	return false;
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export function runCli(argv: string[]): Promise<void> {
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	// Keeping this routing boundary explicit makes the CLI fallback easy to audit.
	const first = argv[0];
	if (!isSubcommand(first)) {
		try {
			validateInlineFlagSyntax(argv);
		} catch (error) {
			if (!(error instanceof CliUsageError)) throw error;
			process.stderr.write(`Error: ${error.message}\n`);
			process.exitCode = 2;
			return Promise.resolve();
		}
	}
	const prefixedCommand = findPrefixedCommand(argv, token => isSubcommand(token));
	if (
		prefixedCommand !== undefined &&
		!prefixedCommand.prefixFlags.some(flag => flag === "help" || flag === "version")
	) {
		if (requestsHelp(prefixedCommand.commandArgs)) {
			return run({
				bin: APP_NAME,
				version: VERSION,
				argv: [prefixedCommand.command, ...prefixedCommand.commandArgs],
				commands,
				help: showHelp,
			});
		}
		process.stderr.write(
			`Error: ${launchFlagScopeMessage(
				prefixedCommand.prefixFlags,
				prefixedCommand.command,
				prefixedCommand.commandArgs,
				APP_NAME,
			)}\n`,
		);
		process.exitCode = 2;
		return Promise.resolve();
	}
	const runArgv =
		// Chrome launches the native-messaging host with the calling extension's
		// origin (chrome-extension://…/) as the first arg. Route that to the
		// `chrome-host` relay — a safety net if a manifest `path` points straight at
		// the binary instead of the launcher wrapper.
		first?.startsWith("chrome-extension://")
			? ["chrome-host", ...argv]
			: first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
				? argv
				: isSubcommand(first)
					? argv
					: ["launch", ...argv];
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

if (process.env.XCSH_SMOKE_TEST_SPECS === "1") {
	const specMod = require("./internal-urls/api-spec-index.generated") as { API_SPEC_INDEX?: { domains?: unknown[] } };
	const catalogMod = require("./internal-urls/api-catalog-index.generated") as {
		API_CATALOG_CATEGORY_SUMMARIES?: unknown[];
	};
	const domainCount = specMod.API_SPEC_INDEX?.domains?.length ?? 0;
	const categoryCount = catalogMod.API_CATALOG_CATEGORY_SUMMARIES?.length ?? 0;
	console.log(`api-specs: ${domainCount} domains, ${categoryCount} categories`);
	process.exit(domainCount > 0 && categoryCount > 0 ? 0 : 1);
}

// Post-publication verification exercises the licensed build inputs without
// printing the client, authorization URL, state, challenge, or any credential.
if (process.env.XCSH_SMOKE_TEST_VERTEX_AUTH === "1") {
	try {
		const { createVertexAuthorizationUrl } = await import("@f5-sales-demo/pi-ai/utils/oauth/google-antigravity");
		const url = new URL(createVertexAuthorizationUrl("release-verification-state", "release-verification-challenge"));
		const ready =
			url.protocol === "https:" &&
			url.searchParams.get("code_challenge_method") === "S256" &&
			Boolean(url.searchParams.get("client_id"));
		console.log(ready ? "vertex-auth: ready" : "vertex-auth: unavailable");
		process.exit(ready ? 0 : 1);
	} catch {
		console.log("vertex-auth: unavailable");
		process.exit(1);
	}
}

await runCli(process.argv.slice(2));
