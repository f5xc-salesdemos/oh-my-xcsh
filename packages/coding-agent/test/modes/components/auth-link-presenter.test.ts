import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { Container, setTerminalHyperlinks, TERMINAL } from "@f5-sales-demo/pi-tui";
import { presentAuthLink, presentDeviceCode } from "../../../src/modes/components/auth-link-presenter";
import { initTheme } from "../../../src/modes/theme/theme";

const LONG_URL =
	"https://login.example.test/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&scope=openid%20profile&state=synthetic-state&code_challenge=synthetic-challenge";

const OSC_8_OPEN = /\x1b\]8;;([^\x07]+)\x07/g;
const OSC_8_CLOSE = /\x1b\]8;;\x07/g;
const originalHyperlinkCapability = TERMINAL.hyperlinks;

beforeAll(() => {
	initTheme();
	setTerminalHyperlinks(true);
});

afterAll(() => setTerminalHyperlinks(originalHyperlinkCapability));

describe("presentDeviceCode", () => {
	it("keeps the verification URL and one-time code visible in a narrow terminal", () => {
		const container = new Container();
		const url = "https://auth.openai.com/codex/device";
		presentDeviceCode(container, url, "ABCD-EFGH");
		const rendered = container.render(24).join("\n");
		const visible = Bun.stripANSI(rendered);
		expect(visible.replace(/\s/g, "")).toContain(url);
		expect(visible).toContain("ABCD-EFGH");
		expect(visible).toContain("Press c");
		expect(rendered).toContain(`\x1b]8;;${url}\x07`);
	});
});

describe("presentAuthLink", () => {
	for (const width of [18, 80]) {
		it(`keeps the exact target hidden and each rendered link segment balanced at width ${width}`, () => {
			const container = new Container();
			const copy = vi.fn(async (_url: string) => undefined);

			presentAuthLink(container, LONG_URL, { copy, platform: "linux" });

			const renderedLines = container.render(width);
			const rendered = renderedLines.join("\n");
			const visible = Bun.stripANSI(rendered).replace(/\s+/g, " ").trim();
			expect(visible).toContain("Open sign-in page");
			expect(visible).toContain("Ctrl+click to open");
			expect(visible).toContain("Clipboard availability depends on terminal support.");
			expect(visible).not.toContain(LONG_URL);

			const linkedLines = renderedLines.filter(line => line.includes("\x1b]8;;"));
			expect(linkedLines.length).toBeGreaterThan(0);
			for (const line of linkedLines) {
				const targets = [...line.matchAll(OSC_8_OPEN)].map(match => match[1]);
				const closes = line.match(OSC_8_CLOSE) ?? [];
				expect(targets.length).toBe(closes.length);
				expect(targets.every(target => target === LONG_URL)).toBe(true);
			}

			expect(copy).toHaveBeenCalledTimes(1);
			expect(copy).toHaveBeenCalledWith(LONG_URL);
			expect(copy.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
		});
	}

	it("uses the macOS click hint", () => {
		const container = new Container();
		presentAuthLink(container, LONG_URL, { copy: vi.fn(), platform: "darwin" });

		const visible = Bun.stripANSI(container.render(80).join("\n")).replace(/\s+/g, " ").trim();
		expect(visible).toContain("Cmd+click to open");
		expect(visible).not.toContain("Ctrl+click to open");
	});

	it("falls back to a visible URL when terminal hyperlinks are disabled", () => {
		setTerminalHyperlinks(false);
		try {
			const container = new Container();
			presentAuthLink(container, LONG_URL, { copy: vi.fn(), platform: "linux" });

			const rendered = container.render(240).join("\n");
			expect(Bun.stripANSI(rendered)).toContain(LONG_URL);
			expect(rendered).not.toContain("\x1b]8;;");
		} finally {
			setTerminalHyperlinks(true);
		}
	});
});
