import { describe, expect, it, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@f5-sales-demo/xcsh";
import nativeLifecycleControl, {
	NATIVE_LIFECYCLE_CONTINUATION_TITLE,
	NATIVE_LIFECYCLE_CONTROL_FLAG,
} from "../src/extensibility/extensions/bundled/native-lifecycle-control";
import { nativeLifecycleChildArgv, nativeLifecycleContract } from "../src/lifecycle/native-acceptance";
import { currentXcshCommand, NATIVE_LIFECYCLE_SCENARIOS } from "../src/lifecycle/native-acceptance-driver";

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
		expect(contract.version).toBe(1);
		expect(contract.session_id).toBe("^[0-9a-f]{16}$");
		expect(contract.controls).toEqual({
			resume: "--resume <exact-session-path>",
			cancel: "PtySession.interrupt() sends SIGINT to the native child process group",
			await_user: "--native-lifecycle-control await-user uses the interactive ExtensionUiController",
			continuation: "write the continuation and Enter to the same native PTY",
			replay: "restart --resume <exact-session-path> with the same authenticated binding",
		});
		expect(contract.scenarios).toEqual(NATIVE_LIFECYCLE_SCENARIOS);
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
});
