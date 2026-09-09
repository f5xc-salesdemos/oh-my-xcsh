/**
 * Stable argv contract for the producer-owned native lifecycle driver.
 *
 * This deliberately drives an ordinary xcsh child.  It does not manufacture
 * reporter frames or supply an offline model: callers must provide a normally
 * configured model and inspect the child's JSON stream and session file.
 */
export const NATIVE_LIFECYCLE_DRIVER_VERSION = 2;
export const NATIVE_LIFECYCLE_SCENARIOS = [
	"success",
	"failure",
	"await-continue",
	"cancel",
	"managed-cancel",
	"managed-working-cancel",
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
		session_dir: "absolute directory containing the canonical JSONL session",
		session_path: "<session-dir>/<timestamp>_<session-id>.jsonl",
		session_header_sha256: "SHA-256 of the exact first JSONL header line including its terminating LF byte",
		model: "configured non-secret model identifier",
		child: {
			modes: { non_interactive: "json", pty: "interactive" },
			reduced_discovery_flags: ["--no-memories", "--no-skills", "--no-rules", "--no-mcp", "--no-lsp"],
		},
		controls: {
			resume: "--resume <exact-session-path>",
			cancel: "PtySession.interrupt() sends SIGINT to the native child process group",
			managed_cancel:
				"protocol 22 agent.turn.action.get/ack cooperatively aborts the active ExtensionUIController and AgentSession",
			await_user: "--native-lifecycle-control await-user uses the interactive ExtensionUiController",
			continuation: "write the continuation and Enter to the same native PTY",
			replay: "restart --resume <exact-session-path> with the same authenticated binding",
		},
		reporter: {
			protocol: 22,
			capability_env: "HERDR_NATIVE_CAPABILITY",
			capability_persistence: "never",
			actions: ["cancel:1:requested", "cancel:1:safe_point", "cancel:1:timed_out"],
		},
		scenarios: NATIVE_LIFECYCLE_SCENARIOS,
	};
}
