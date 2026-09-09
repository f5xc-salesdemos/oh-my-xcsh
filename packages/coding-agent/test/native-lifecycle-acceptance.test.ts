import { describe, expect, it } from "bun:test";
import { nativeLifecycleChildArgv, nativeLifecycleContract } from "../src/lifecycle/native-acceptance";

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
			cancel: "SIGINT to the native child",
			await_user: "interactive native UI prompt; observe turn_phase awaiting_user",
			replay: "restart a child with the same authenticated HERDR_EXECUTION_ID and generation",
		});
	});
});
