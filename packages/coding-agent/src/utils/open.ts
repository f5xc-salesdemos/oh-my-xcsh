/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", urlOrPath];
			break;
		case "win32":
			cmd = ["rundll32", "url.dll,FileProtocolHandler", urlOrPath];
			break;
		default:
			cmd = ["xdg-open", urlOrPath];
			break;
	}
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {
		// Best-effort: browser opening is non-critical
	}
}

export type OpenHttpUrlResult = { ok: true } | { ok: false; error: string };

/** Open one validated HTTP(S) URL and report whether the platform launcher accepted it. */
export async function openHttpUrl(target: string): Promise<OpenHttpUrlResult> {
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return { ok: false, error: "Not a valid URL" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: "Only HTTP(S) links can be opened" };
	}
	const cmd =
		process.platform === "darwin"
			? ["open", parsed.href]
			: process.platform === "win32"
				? ["rundll32", "url.dll,FileProtocolHandler", parsed.href]
				: ["xdg-open", parsed.href];
	try {
		const processHandle = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		const exitCode = await processHandle.exited;
		if (exitCode === 0) return { ok: true };
		const detail = (await new Response(processHandle.stderr).text()).trim();
		return { ok: false, error: detail || `Browser launcher exited with status ${exitCode}` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
