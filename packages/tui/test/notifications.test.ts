import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildHerdrNotificationCommand, NotifyProtocol, TerminalInfo } from "../src/terminal-capabilities";

const originalEnv = {
	PATH: process.env.PATH,
	HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	PI_NOTIFICATIONS: process.env.PI_NOTIFICATIONS,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
});

describe("Herdr notifications", () => {
	it("builds injection-safe argv and maps sounds", () => {
		const env = { HERDR_PANE_ID: "pane:1" };
		expect(buildHerdrNotificationCommand({ title: "Review; rm -rf /", body: "ready", type: "ask" }, env)).toEqual([
			"herdr",
			"notification",
			"show",
			"Review; rm -rf /",
			"--body",
			"ready",
			"--sound",
			"request",
		]);
		expect(buildHerdrNotificationCommand({ body: "done", type: "completion" }, env)?.at(-1)).toBe("done");
		expect(buildHerdrNotificationCommand({ body: "failed", type: "error" }, env)?.at(-1)).toBe("request");
	});

	it("rejects absent and unsafe pane identities", () => {
		expect(buildHerdrNotificationCommand("done", {})).toBeNull();
		expect(buildHerdrNotificationCommand("done", { HERDR_PANE_ID: "bad pane;command" })).toBeNull();
	});

	it("protects CLI help-like titles", () => {
		expect(buildHerdrNotificationCommand({ title: "--help", body: "done" }, { HERDR_PANE_ID: "p-1" })?.[3]).toBe(
			"xcsh",
		);
	});

	it("falls back to the terminal protocol when the Herdr executable is missing", () => {
		process.env.HERDR_PANE_ID = "pane-1";
		process.env.PATH = "";
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		new TerminalInfo("base", null, false, false, NotifyProtocol.Osc9).sendNotification({
			title: "Build",
			body: "finished",
			type: "completion",
		});
		expect(writes.join("")).toContain("Build: finished");
	});

	it("suppresses both Herdr and fallback delivery when notifications are disabled", () => {
		process.env.HERDR_PANE_ID = "pane-1";
		process.env.PI_NOTIFICATIONS = "off";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const spawn = vi.spyOn(Bun, "spawn");
		new TerminalInfo("base", null, false, false, NotifyProtocol.Osc9).sendNotification("done");
		expect(spawn).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
});
