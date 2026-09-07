import { type Container, Text } from "@f5-sales-demo/pi-tui";
import { recoveryUrlHyperlink } from "../../tui/hyperlink";
import { copyToClipboard } from "../../utils/clipboard";
import { theme } from "../theme/theme";

type AuthLinkContainer = Pick<Container, "addChild">;

export interface AuthLinkPresenterOptions {
	copy?: (url: string) => void | Promise<void>;
	platform?: NodeJS.Platform;
}

/** Present a browser authorization target without exposing its long URL as visible terminal text. */
export function presentAuthLink(
	container: AuthLinkContainer,
	url: string,
	options: AuthLinkPresenterOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	const clickHint = platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
	const hyperlink = recoveryUrlHyperlink(url, "Open sign-in page");
	container.addChild(new Text(`${theme.fg("accent", hyperlink)} ${theme.fg("dim", `(${clickHint})`)}`, 1, 0));
	if (hyperlink === "Open sign-in page") container.addChild(new Text(theme.fg("accent", url), 1, 0));
	container.addChild(
		new Text(
			theme.fg("dim", "Sign-in URL copied when supported. Clipboard availability depends on terminal support."),
			1,
			0,
		),
	);

	const copy = options.copy ?? copyToClipboard;
	try {
		void Promise.resolve(copy(url)).catch(() => undefined);
	} catch {
		// Clipboard access is best-effort; the OSC 8 link remains available.
	}
}

/** Render device verification details so they remain usable without hyperlink or clipboard support. */
export function presentDeviceCode(container: AuthLinkContainer, url: string, userCode: string): void {
	const hyperlink = recoveryUrlHyperlink(url, url);
	container.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
	container.addChild(new Text(theme.fg("warning", `One-time code: ${theme.bold(userCode)}`), 1, 0));
	container.addChild(
		new Text(theme.fg("dim", "Press c at the prompt to copy; the code remains readable above."), 1, 0),
	);
}
