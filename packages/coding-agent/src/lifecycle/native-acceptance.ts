/**
 * Stable argv contract for the producer-owned native lifecycle driver.
 *
 * This deliberately drives an ordinary xcsh child.  It does not manufacture
 * reporter frames or supply an offline model: callers must provide a normally
 * configured model and inspect the child's JSON stream and session file.
 */
export const NATIVE_LIFECYCLE_DRIVER_VERSION = 1;

export interface NativeLifecycleChildOptions {
	model: string;
	sessionDir: string;
	prompt: string;
	tools: string;
	resume?: string;
}

/** Build the exact low-discovery argv used by lifecycle acceptance children. */
export function nativeLifecycleChildArgv(options: NativeLifecycleChildOptions): string[] {
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
		"--tools",
		options.tools,
		...(options.resume === undefined ? ["--print", options.prompt] : ["--resume", options.resume, options.prompt]),
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
			mode: "json",
			reduced_discovery_flags: ["--no-memories", "--no-skills", "--no-rules", "--no-mcp", "--no-lsp"],
		},
		controls: {
			resume: "--resume <exact-session-path>",
			cancel: "SIGINT to the native child",
			await_user: "interactive native UI prompt; observe turn_phase awaiting_user",
			replay: "restart a child with the same authenticated HERDR_EXECUTION_ID and generation",
		},
	};
}
