import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@f5-sales-demo/pi-agent-core";
import { registerLocales } from "@f5-sales-demo/pi-utils";
import { locales } from "../../../src/locales";
import { CommandController } from "../../../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

registerLocales(locales);

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 };
}

function harness(messages: AgentMessage[]) {
	const showError = vi.fn();
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const controller = new CommandController({
		session: { messages },
		showError,
		showWarning,
		showStatus,
	} as unknown as InteractiveModeContext);
	return { controller, showError, showWarning, showStatus };
}

describe("CommandController /open", () => {
	it("rejects arguments without invoking the opener", async () => {
		const state = harness([user("https://example.test/latest")]);
		const opener = vi.spyOn(state.controller, "openHttpUrl");
		await state.controller.handleOpenCommand("/tmp/file");
		expect(opener).not.toHaveBeenCalled();
		expect(state.showError).toHaveBeenCalledWith("Usage: /open");
	});

	it("opens only the latest transcript HTTP(S) link and reports failures", async () => {
		const state = harness([
			user("[file](file:///tmp/no) [old](https://example.test/old)"),
			user("javascript:alert(1) then https://example.test/latest"),
		]);
		vi.spyOn(state.controller, "openHttpUrl").mockResolvedValue({ ok: false, error: "launcher unavailable" });
		await state.controller.handleOpenCommand("");
		expect(state.controller.openHttpUrl).toHaveBeenCalledWith("https://example.test/latest");
		expect(state.showError).toHaveBeenCalledWith("Could not open link: launcher unavailable");
	});

	it("keeps arbitrary non-HTTP links closed", async () => {
		const state = harness([user("[file](file:///tmp/no) [script](javascript:alert(1))")]);
		const opener = vi.spyOn(state.controller, "openHttpUrl");
		await state.controller.handleOpenCommand();
		expect(opener).not.toHaveBeenCalled();
		expect(state.showWarning).toHaveBeenCalledWith("No HTTP(S) link found in the transcript.");
	});
});
