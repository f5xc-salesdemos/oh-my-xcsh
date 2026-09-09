import { describe, expect, it, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@f5-sales-demo/xcsh";
import nativeLifecycleControl, {
	NATIVE_LIFECYCLE_CONTINUATION_TITLE,
	NATIVE_LIFECYCLE_CONTROL_FLAG,
	requestNativeLifecycleCancellation,
} from "../src/extensibility/extensions/bundled/native-lifecycle-control";
import { nativeLifecycleChildArgv, nativeLifecycleContract } from "../src/lifecycle/native-acceptance";
import {
	currentXcshCommand,
	NATIVE_LIFECYCLE_SCENARIOS,
	redactNativeLifecycleRequest,
} from "../src/lifecycle/native-acceptance-driver";

describe("native lifecycle acceptance contract", () => {
	it("uses the documented reduced-discovery JSON child argv without an ephemeral session", () => {
		expect(
			nativeLifecycleChildArgv({
				model: "gpt-5.6-luna",
				sessionDir: "/tmp/sessions",
				tools: "read",
				prompt: "read fixture",
			}),
		).toEqual([
			"--model",
			"gpt-5.6-luna",
			"--mode",
			"json",
			"--session-dir",
			"/tmp/sessions",
			"--no-memories",
			"--no-skills",
			"--no-rules",
			"--no-mcp",
			"--no-lsp",
			"--tools",
			"read",
			"--print",
			"read fixture",
		]);
	});

	it("requires exact path resume and documents real process controls", () => {
		const contract = nativeLifecycleContract();
		expect(contract.version).toBe(2);
		expect(contract.session_id).toBe("^[0-9a-f]{16}$");
		expect(contract.session_dir).toContain("absolute directory");
		expect(contract.session_header_sha256).toContain("terminating LF byte");
		expect(contract.model).toContain("non-secret");
		expect(contract.controls).toEqual({
			resume: "--resume <exact-session-path>",
			cancel: "PtySession.interrupt() sends SIGINT to the native child process group",
			managed_cancel:
				"protocol 22 agent.turn.action.get/ack cooperatively aborts the active ExtensionUIController and AgentSession",
			await_user: "--native-lifecycle-control await-user uses the interactive ExtensionUiController",
			continuation: "write the continuation and Enter to the same native PTY",
			replay: "restart --resume <exact-session-path> with the same authenticated binding",
		});
		expect(contract.scenarios).toEqual(NATIVE_LIFECYCLE_SCENARIOS);
		expect(contract.reporter).toEqual({
			protocol: 22,
			capability_env: "HERDR_NATIVE_CAPABILITY",
			capability_persistence: "never",
			actions: ["cancel:1:requested", "cancel:1:safe_point", "cancel:1:timed_out"],
		});
	});

	it("builds interactive and exact-path resume children without print mode", () => {
		const interactive = nativeLifecycleChildArgv({
			model: "gpt-5.6-luna",
			sessionDir: "/tmp/sessions",
			tools: "read",
			prompt: "read fixture",
			interactive: true,
		});
		expect(interactive).not.toContain("--mode");
		expect(interactive.slice(-3)).toEqual(["--tools", "read", "read fixture"]);
		const resumed = nativeLifecycleChildArgv({
			model: "gpt-5.6-luna",
			sessionDir: "/tmp/sessions",
			tools: "read",
			prompt: "",
			resume: "/tmp/sessions/exact.jsonl",
			interactive: true,
		});
		expect(resumed.slice(-4)).toEqual(["--tools", "read", "--resume", "/tmp/sessions/exact.jsonl"]);
	});

	it("reexecutes the source CLI under Bun and the compiled binary directly", () => {
		expect(currentXcshCommand(["--version"], ["bun", "/repo/src/cli.ts", "lifecycle"], "/usr/bin/bun")).toBe(
			"'/usr/bin/bun' '/repo/src/cli.ts' '--version'",
		);
		expect(currentXcshCommand(["--version"], ["/opt/xcsh", "lifecycle"], "/opt/xcsh")).toBe(
			"'/opt/xcsh' '--version'",
		);
	});

	it("redacts the request-only native capability from executable receipts", () => {
		expect(
			redactNativeLifecycleRequest({
				execution_id: "execution-1",
				native_capability: "must-not-escape",
				state: "starting",
			}),
		).toEqual({ execution_id: "execution-1", state: "starting" });
	});
});

describe("native lifecycle control", () => {
	function loadControl(flagValue: string | undefined) {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
		const registerFlag = vi.fn();
		const pi = {
			registerFlag,
			getFlag: () => flagValue,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		nativeLifecycleControl(pi);
		return { handlers, registerFlag };
	}

	it("is inert unless the explicit acceptance flag is configured", async () => {
		const { handlers, registerFlag } = loadControl(undefined);
		const input = vi.fn();
		await handlers.get("before_agent_start")?.({}, { hasUI: true, ui: { input } } as unknown as ExtensionContext);
		expect(registerFlag).toHaveBeenCalledWith(
			NATIVE_LIFECYCLE_CONTROL_FLAG,
			expect.objectContaining({ type: "string" }),
		);
		expect(input).not.toHaveBeenCalled();
	});

	it("uses the extension UI and returns the continuation to the native turn", async () => {
		const { handlers } = loadControl("await-user");
		const abort = vi.fn();
		const input = vi.fn(async () => "approved");
		const result = await handlers.get("before_agent_start")?.({}, {
			hasUI: true,
			abort,
			ui: { input },
		} as unknown as ExtensionContext);
		expect(input).toHaveBeenCalledWith(
			NATIVE_LIFECYCLE_CONTINUATION_TITLE,
			"Enter the continuation label",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(result).toEqual({
			message: {
				customType: "native-lifecycle-continuation",
				content: "Native lifecycle continuation: approved",
				display: false,
			},
		});
		expect(abort).not.toHaveBeenCalled();
	});

	it("fails closed when the native prompt is dismissed", async () => {
		const { handlers } = loadControl("await-user");
		const abort = vi.fn();
		await handlers.get("before_agent_start")?.({}, {
			hasUI: true,
			abort,
			ui: { input: async () => undefined },
		} as unknown as ExtensionContext);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("exposes the active ExtensionUIController abort signal as a cooperative safe point", async () => {
		const { handlers } = loadControl("await-user");
		const abort = vi.fn();
		let promptSignal: AbortSignal | undefined;
		const pending = handlers.get("before_agent_start")?.({}, {
			hasUI: true,
			abort,
			ui: {
				input: (_title: string, _placeholder: string, options: { signal?: AbortSignal }) =>
					new Promise<undefined>(resolve => {
						promptSignal = options.signal;
						options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
					}),
			},
		} as unknown as ExtensionContext);
		await Promise.resolve();
		expect(promptSignal).toBeDefined();
		expect(requestNativeLifecycleCancellation("Herdr cancel action")).toBe(true);
		await pending;
		expect(promptSignal?.aborted).toBe(true);
		expect(requestNativeLifecycleCancellation("late action")).toBe(false);
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
