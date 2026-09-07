import { describe, expect, it } from "bun:test";
import { setTerminalHyperlinks, TERMINAL } from "@f5-sales-demo/pi-tui";
import { getDefault } from "../../src/config/settings-schema";
import { applyHyperlinkSetting, fileHyperlink, resolveHyperlinkMode, urlHyperlink } from "../../src/tui/hyperlink";

describe("hyperlink setting", () => {
	it("defaults to auto", () => {
		expect(getDefault("tui.hyperlinks")).toBe("auto");
	});

	it("applies off and always ahead of detection", () => {
		expect(resolveHyperlinkMode("off", { detected: true, isTTY: true, noColor: false })).toBe(false);
		expect(resolveHyperlinkMode("always", { detected: false, isTTY: false, noColor: true })).toBe(true);
	});

	it("requires all auto-mode gates", () => {
		expect(resolveHyperlinkMode("auto", { detected: true, isTTY: true, noColor: false })).toBe(true);
		expect(resolveHyperlinkMode("auto", { detected: false, isTTY: true, noColor: false })).toBe(false);
		expect(resolveHyperlinkMode("auto", { detected: true, isTTY: false, noColor: false })).toBe(false);
		expect(resolveHyperlinkMode("auto", { detected: true, isTTY: true, noColor: true })).toBe(false);
	});

	it("restores auto from the immutable startup snapshot after runtime overrides", () => {
		const original = TERMINAL.hyperlinks;
		const detected = resolveHyperlinkMode("auto");
		try {
			applyHyperlinkSetting(detected ? "off" : "always");
			expect(TERMINAL.hyperlinks).toBe(!detected);
			applyHyperlinkSetting("auto");
			expect(TERMINAL.hyperlinks).toBe(detected);
		} finally {
			setTerminalHyperlinks(original);
		}
	});

	it("rejects unsafe targets, strips nested OSC 8 labels, and emits normalized bytes", () => {
		const original = TERMINAL.hyperlinks;
		setTerminalHyperlinks(true);
		try {
			expect(urlHyperlink("javascript:alert(1)", "unsafe")).toBe("unsafe");
			expect(urlHyperlink("https://example.test/%C2%80", "unsafe")).toBe("unsafe");
			const nested = urlHyperlink("https://example.test", "\x1b]8;;https://old.test\x1b\\label\x1b]8;;\x07");
			expect(nested).toBe("\x1b]8;;https://example.test/\x07label\x1b]8;;\x07");
			expect(fileHyperlink("docs/read me.md", "file", "/tmp/session")).toBe(
				"\x1b]8;;file:///tmp/session/docs/read%20me.md\x07file\x1b]8;;\x07",
			);
		} finally {
			setTerminalHyperlinks(original);
		}
	});
});
