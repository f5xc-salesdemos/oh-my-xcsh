import { describe, expect, it } from "bun:test";
import { resolveTerminalInfo } from "../src/terminal-capabilities";

describe("terminal hyperlink capability policy", () => {
	it.each([
		[{ TERM_PROGRAM: "ghostty" }, true],
		[{ TERM_PROGRAM: "iTerm.app" }, true],
		[{ TERM_PROGRAM: "unknown", COLORTERM: "truecolor" }, false],
		[{ TERM: "screen-256color", STY: "123" }, false],
		[{ TERM: "xterm-256color", ZELLIJ: "0" }, false],
	])("classifies direct and fallback terminals", (env, expected) => {
		expect(resolveTerminalInfo(env, true).hyperlinks).toBe(expected);
	});

	it("requires a TTY and honors NO_COLOR", () => {
		const env = { TERM_PROGRAM: "ghostty" };
		expect(resolveTerminalInfo(env, false).hyperlinks).toBe(false);
		expect(resolveTerminalInfo({ ...env, NO_COLOR: "1" }, true).hyperlinks).toBe(false);
	});

	it.each([
		["0.7.4", false],
		["0.7.5", true],
		["0.8.0-beta.1", true],
		[undefined, false],
	])("gates Herdr %s", (version, expected) => {
		expect(
			resolveTerminalInfo({ HERDR_ENV: "1", HERDR_VERSION: version, TERM_PROGRAM: "ghostty" }, true).hyperlinks,
		).toBe(expected);
	});

	it.each([
		["3.3", false],
		["3.4", true],
		["3.5a", true],
		[undefined, false],
	])("gates tmux %s", (version, expected) => {
		expect(
			resolveTerminalInfo(
				{ TMUX: "/tmp/tmux", TERM: "screen-256color", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: version },
				true,
			).hyperlinks,
		).toBe(expected);
	});

	it("rejects an SSH fallback but accepts a positively preserved terminal", () => {
		expect(resolveTerminalInfo({ SSH_CONNECTION: "a b", TERM: "xterm-256color" }, true).hyperlinks).toBe(false);
		expect(resolveTerminalInfo({ SSH_CONNECTION: "a b", TERM_PROGRAM: "iTerm.app" }, true).hyperlinks).toBe(true);
	});
});
