import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { setTerminalHyperlinks, TERMINAL } from "@f5-sales-demo/pi-tui";
import { renderSegment } from "../src/modes/components/status-line/segments";
import type { SegmentContext } from "../src/modes/components/status-line/types";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const originalHyperlinks = TERMINAL.hyperlinks;

beforeAll(async () => initTheme());
afterAll(() => setTerminalHyperlinks(originalHyperlinks));

describe("hyperlink live setting side effects", () => {
	it("updates the shared renderer policy and invalidates every affected surface", () => {
		const statusInvalidate = vi.fn();
		const chatInvalidate = vi.fn();
		const uiInvalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { invalidate: statusInvalidate },
			chatContainer: { invalidate: chatInvalidate },
			ui: { invalidate: uiInvalidate, requestRender },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("tui.hyperlinks", "always");
		expect(TERMINAL.hyperlinks).toBe(true);
		controller.handleSettingChange("tui.hyperlinks", "off");
		expect(TERMINAL.hyperlinks).toBe(false);
		expect(statusInvalidate).toHaveBeenCalledTimes(2);
		expect(chatInvalidate).toHaveBeenCalledTimes(2);
		expect(uiInvalidate).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("uses the same safe policy for PR status links", () => {
		const context = { git: { pr: { number: 42, url: "https://example.test/pr/42" } } } as SegmentContext;
		setTerminalHyperlinks(true);
		expect(renderSegment("pr", context).content).toContain("\x1b]8;;https://example.test/pr/42\x07");
		setTerminalHyperlinks(false);
		expect(renderSegment("pr", context).content).not.toContain("\x1b]8;;");
	});
});
