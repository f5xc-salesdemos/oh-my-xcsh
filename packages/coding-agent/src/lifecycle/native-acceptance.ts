/**
 * Stable argv contract for the producer-owned native lifecycle driver.
 *
 * This deliberately drives an ordinary xcsh child.  It does not manufacture
 * reporter frames or supply an offline model: callers must provide a normally
 * configured model and inspect the child's JSON stream and session file.
 */
export const NATIVE_LIFECYCLE_DRIVER_VERSION = 1;
export const NATIVE_LIFECYCLE_SCENARIOS = [
	"success",
	"failure",
	"await-continue",
	"cancel",
	"reply-loss-replay",
] as const;
export type NativeLifecycleScenario = (typeof NATIVE_LIFECYCLE_SCENARIOS)[number];

export interface NativeLifecycleChildOptions {
	model: string;
	sessionDir: string;
	prompt: string;
	tools: string;
	resume?: string;
	interactive?: boolean;
}

/** Build the exact low-discovery argv used by lifecycle acceptance children. */
export function nativeLifecycleChildArgv(options: NativeLifecycleChildOptions): string[] {
	return [
		"--model",
		options.model,
		...(options.interactive ? [] : ["--mode", "json"]),
		"--session-dir",
		options.sessionDir,
		"--no-memories",
		"--no-skills",
		"--no-rules",
		"--no-mcp",
		"--no-lsp",
		"--tools",
		options.tools,
		...(options.resume !== undefined
			? ["--resume", options.resume, ...(options.prompt ? [options.prompt] : [])]
			: options.interactive
				? [options.prompt]
				: ["--print", options.prompt]),
	];
}

/** A public, machine-readable contract for controller/acceptance drivers. */
export function nativeLifecycleContract(): Record<string, unknown> {
	return {
		version: NATIVE_LIFECYCLE_DRIVER_VERSION,
		transport: "xcsh-json-session-v3",
		session_id: "^[0-9a-f]{16}$",
		session_path: "<session-dir>/<timestamp>_<session-id>.jsonl",
		child: {
			modes: { non_interactive: "json", pty: "interactive" },
			reduced_discovery_flags: ["--no-memories", "--no-skills", "--no-rules", "--no-mcp", "--no-lsp"],
		},
		controls: {
			resume: "--resume <exact-session-path>",
			cancel: "PtySession.interrupt() sends SIGINT to the native child process group",
			await_user: "--native-lifecycle-control await-user uses the interactive ExtensionUiController",
			continuation: "write the continuation and Enter to the same native PTY",
			replay: "restart --resume <exact-session-path> with the same authenticated binding",
		},
		scenarios: NATIVE_LIFECYCLE_SCENARIOS,
	};
}
