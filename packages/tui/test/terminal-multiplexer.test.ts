import { describe, expect, it } from "bun:test";
import { isInsideHerdr, isInsideTerminalMultiplexer } from "../src/terminal-multiplexer";

describe("Herdr detection", () => {
	it("recognizes canonical and pane identity variants", () => {
		expect(isInsideHerdr({ HERDR_ENV: "1" })).toBe(true);
		expect(isInsideHerdr({ HERDR_PANE_ID: "pane-1" })).toBe(true);
		expect(isInsideHerdr({ HERDR_TAB_ID: "tab-1" })).toBe(true);
		expect(isInsideHerdr({ HERDR_WORKSPACE_ID: "workspace-1" })).toBe(true);
		expect(isInsideHerdr({ HERDR_SOCKET_PATH: "/tmp/herdr.sock" })).toBe(false);
		expect(isInsideTerminalMultiplexer({ HERDR_PANE_ID: "pane-1" })).toBe(true);
	});
});
