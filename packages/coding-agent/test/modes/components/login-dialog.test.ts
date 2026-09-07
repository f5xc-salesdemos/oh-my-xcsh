import { beforeAll, describe, expect, it, vi } from "bun:test";
import { presentAuthLink } from "../../../src/modes/components/auth-link-presenter";
import { LoginDialogComponent } from "../../../src/modes/components/login-dialog";
import { initTheme } from "../../../src/modes/theme/theme";

const LONG_AUTH_URL =
	"https://login.example.test/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&scope=openid%20profile&state=synthetic-state&code_challenge=synthetic-challenge";

beforeAll(() => {
	initTheme();
});

describe("LoginDialogComponent", () => {
	it("presents and copies the exact auth target without visibly rendering it", () => {
		const requestRender = vi.fn();
		const openUrl = vi.fn();
		const copy = vi.fn(async () => undefined);
		const dialog = new LoginDialogComponent({ requestRender } as never, "synthetic-provider", vi.fn(), {
			openUrl,
			presentLink: (container, url) => presentAuthLink(container, url, { copy, platform: "linux" }),
		});

		dialog.showAuth(LONG_AUTH_URL, "Complete the synthetic provider instructions.");

		const visible = Bun.stripANSI(dialog.render(28).join("\n")).replace(/\s+/g, " ").trim();
		expect(visible).toContain("Open sign-in page");
		expect(visible).toContain("Ctrl+click to open");
		expect(visible).toContain("Complete the synthetic provider instructions.");
		expect(visible).not.toContain(LONG_AUTH_URL);
		expect(copy).toHaveBeenCalledTimes(1);
		expect(copy).toHaveBeenCalledWith(LONG_AUTH_URL);
		expect(openUrl).toHaveBeenCalledTimes(1);
		expect(openUrl).toHaveBeenCalledWith(LONG_AUTH_URL);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("displays the hosted URL while opening the automatic loopback URL", () => {
		const requestRender = vi.fn();
		const openUrl = vi.fn();
		const copy = vi.fn(async () => undefined);
		const displayedUrl = `${LONG_AUTH_URL}&route=hosted`;
		const automaticUrl = `${LONG_AUTH_URL}&route=loopback`;
		const dialog = new LoginDialogComponent({ requestRender } as never, "anthropic", vi.fn(), {
			openUrl,
			presentLink: (container, url) => presentAuthLink(container, url, { copy, platform: "linux" }),
		});

		dialog.showAuth(displayedUrl, undefined, automaticUrl);

		expect(copy).toHaveBeenCalledWith(displayedUrl);
		expect(openUrl).toHaveBeenCalledWith(automaticUrl);
	});

	it("keeps recovery instructions visible when browser launch fails", async () => {
		const requestRender = vi.fn();
		const dialog = new LoginDialogComponent({ requestRender } as never, "synthetic-provider", vi.fn(), {
			openUrl: vi.fn(async () => ({ ok: false as const, error: "launcher unavailable" })),
			presentLink: (container, url) => presentAuthLink(container, url, { copy: vi.fn(), platform: "linux" }),
		});
		dialog.showAuth(LONG_AUTH_URL, "Paste the authorization code manually.");
		await Bun.sleep(0);
		const visible = Bun.stripANSI(dialog.render(200).join("\n"));
		expect(visible).toContain("Open sign-in page");
		expect(visible).toContain("Paste the authorization code manually.");
		expect(visible).toContain("Could not open browser: launcher unavailable");
		expect(requestRender).toHaveBeenCalled();
	});
});
