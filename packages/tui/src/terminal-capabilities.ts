import { encodeSixel } from "@f5-sales-demo/pi-natives";
import { $env } from "@f5-sales-demo/pi-utils";
import { isInsideHerdr } from "./terminal-multiplexer";

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

export enum NotifyProtocol {
	Bell = "\x07",
	Osc99 = "\x1b]99;;",
	Osc9 = "\x1b]9;",
}

export type TerminalId = "kitty" | "ghostty" | "wezterm" | "iterm2" | "vscode" | "alacritty" | "base" | "trueColor";

export interface TerminalNotification {
	title?: string;
	body?: string;
	type?: string | string[];
}

const DEFAULT_NOTIFICATION_TITLE = "xcsh";
const HERDR_PANE_ID_PATTERN = /^[0-9A-Za-z:_-]{1,64}$/u;
const HERDR_USAGE_TOKENS = new Set(["help", "--help", "-h"]);

function notificationTitleAndBody(message: string | TerminalNotification): { title: string; body: string } {
	if (typeof message === "string") return { title: DEFAULT_NOTIFICATION_TITLE, body: message };
	return { title: message.title?.trim() || DEFAULT_NOTIFICATION_TITLE, body: message.body ?? "" };
}

function notificationToLine(message: TerminalNotification): string {
	if (message.title && message.body) return `${message.title}: ${message.body}`;
	return message.title ?? message.body ?? "";
}

export function buildHerdrNotificationCommand(
	message: string | TerminalNotification,
	env: NodeJS.ProcessEnv = Bun.env,
): string[] | null {
	if (!isInsideHerdr(env)) return null;
	const paneId = env.HERDR_PANE_ID?.trim();
	if (!paneId || !HERDR_PANE_ID_PATTERN.test(paneId)) return null;
	const parsed = notificationTitleAndBody(message);
	const title = HERDR_USAGE_TOKENS.has(parsed.title) ? DEFAULT_NOTIFICATION_TITLE : parsed.title;
	const types = typeof message === "string" ? [] : [message.type ?? []].flat();
	const sound =
		types.includes("ask") || types.includes("error") ? "request" : types.includes("completion") ? "done" : "none";
	return ["herdr", "notification", "show", title, "--body", parsed.body, "--sound", sound];
}

function sendHerdrNotification(message: string | TerminalNotification, env: NodeJS.ProcessEnv = Bun.env): boolean {
	const cmd = buildHerdrNotificationCommand(message, env);
	if (!cmd) return false;
	if (!Bun.which(cmd[0]!, { PATH: env.PATH })) return false;
	try {
		const child = Bun.spawn({
			cmd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

const SIXEL_DCS_START_REGEX = /\x1bP(?:[0-9;]*)q/u;
/** Terminal capability details used for rendering and protocol selection. */
export class TerminalInfo {
	constructor(
		public readonly id: TerminalId,
		public readonly imageProtocol: ImageProtocol | null,
		public readonly trueColor: boolean,
		public readonly hyperlinks: boolean,
		public readonly notifyProtocol: NotifyProtocol = NotifyProtocol.Bell,
	) {}

	isImageLine(line: string): boolean {
		if (!this.imageProtocol) return false;
		if (this.imageProtocol === ImageProtocol.Sixel) {
			return SIXEL_DCS_START_REGEX.test(line.slice(0, 128));
		}
		const prefix = line.slice(0, 64);
		if (prefix.includes(this.imageProtocol)) return true;
		// iTerm2 multipart transfer uses FilePart= and FileEnd instead of File=
		if (this.imageProtocol === ImageProtocol.Iterm2) {
			return prefix.includes("\x1b]1337;FilePart=") || prefix.includes("\x1b]1337;FileEnd");
		}
		return false;
	}

	formatNotification(message: string | TerminalNotification): string {
		if (this.notifyProtocol === NotifyProtocol.Bell) {
			return NotifyProtocol.Bell;
		}
		const line = typeof message === "string" ? message : notificationToLine(message);
		return `${this.notifyProtocol}${line}\x1b\\`;
	}

	sendNotification(message: string | TerminalNotification): void {
		if (isNotificationSuppressed()) return;
		if (sendHerdrNotification(message)) return;
		process.stdout.write(this.formatNotification(message));
	}
}

export function isNotificationSuppressed(): boolean {
	const value = $env.PI_NOTIFICATIONS;
	if (!value) return false;
	return value === "off" || value === "0" || value === "false";
}

function getForcedImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol | null | undefined {
	const raw = env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "kitty") return ImageProtocol.Kitty;
	if (raw === "iterm2" || raw === "iterm") return ImageProtocol.Iterm2;
	if (raw === "sixel") return ImageProtocol.Sixel;
	if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return null;
	return null;
}

function parseMajorMinorVersion(versionRaw?: string): { major: number; minor: number } | null {
	if (!versionRaw) return null;
	const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

/**
 * Returns true when running in Windows Terminal with known SIXEL support.
 *
 * Windows Terminal introduced SIXEL support in preview 1.22.
 */
export function isWindowsTerminalPreviewSixelSupported(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	if (env.TERM_PROGRAM && env.TERM_PROGRAM.toLowerCase() !== "windows_terminal") {
		return false;
	}
	const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
	if (!version) return false;
	return version.major > 1 || (version.major === 1 && version.minor >= 22);
}
function hasHerdrKittyGraphics(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === "1" && env.HERDR_KITTY_GRAPHICS === "1";
}

function getFallbackImageProtocol(
	terminalId: TerminalId,
	env: NodeJS.ProcessEnv,
	stdoutIsTTY: boolean,
): ImageProtocol | null {
	if (!stdoutIsTTY) return null;
	if (hasHerdrKittyGraphics(env)) return ImageProtocol.Kitty;
	if (terminalId === "alacritty") return null;
	// VS Code 1.80+ supports iTerm2 inline image protocol
	if (terminalId === "vscode") return ImageProtocol.Iterm2;
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.includes("screen") || term.includes("tmux") || term.includes("ghostty")) {
		return ImageProtocol.Kitty;
	}
	return null;
}
const KNOWN_TERMINALS = Object.freeze({
	// Fallback terminals
	base: new TerminalInfo("base", null, false, true, NotifyProtocol.Bell),
	trueColor: new TerminalInfo("trueColor", null, true, true, NotifyProtocol.Bell),
	// Recognized terminals
	kitty: new TerminalInfo("kitty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc99),
	ghostty: new TerminalInfo("ghostty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	wezterm: new TerminalInfo("wezterm", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	iterm2: new TerminalInfo("iterm2", ImageProtocol.Iterm2, true, true, NotifyProtocol.Osc9),
	vscode: new TerminalInfo("vscode", null, true, true, NotifyProtocol.Bell),
	alacritty: new TerminalInfo("alacritty", null, true, true, NotifyProtocol.Bell),
});

function caseEq(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase(); // For compiler to pattern match
}

export function resolveTerminalId(env: NodeJS.ProcessEnv): TerminalId {
	const {
		KITTY_WINDOW_ID,
		GHOSTTY_RESOURCES_DIR,
		WEZTERM_PANE,
		ITERM_SESSION_ID,
		VSCODE_PID,
		ALACRITTY_WINDOW_ID,
		TERM_PROGRAM,
		TERM,
		COLORTERM,
	} = env;

	if (KITTY_WINDOW_ID) return "kitty";
	if (GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (WEZTERM_PANE) return "wezterm";
	if (ITERM_SESSION_ID) return "iterm2";
	if (VSCODE_PID) return "vscode";
	if (ALACRITTY_WINDOW_ID) return "alacritty";

	if (TERM_PROGRAM) {
		if (caseEq(TERM_PROGRAM, "kitty")) return "kitty";
		if (caseEq(TERM_PROGRAM, "ghostty")) return "ghostty";
		if (caseEq(TERM_PROGRAM, "wezterm")) return "wezterm";
		if (caseEq(TERM_PROGRAM, "iterm.app")) return "iterm2";
		if (caseEq(TERM_PROGRAM, "vscode")) return "vscode";
		if (caseEq(TERM_PROGRAM, "alacritty")) return "alacritty";
	}

	if (TERM?.toLowerCase().includes("ghostty")) return "ghostty";

	if (COLORTERM) {
		if (caseEq(COLORTERM, "truecolor") || caseEq(COLORTERM, "24bit")) return "trueColor";
	}
	return "base";
}

/** Resolve terminal capabilities from an explicit environment and stdout TTY state. */
export function resolveTerminalInfo(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): TerminalInfo {
	const terminal = getTerminalInfo(resolveTerminalId(env));
	const hyperlinks = shouldEnableTerminalHyperlinks(env, stdoutIsTTY, terminal.id);
	const forcedImageProtocol = getForcedImageProtocol(env);
	if (forcedImageProtocol !== undefined) {
		return new TerminalInfo(
			terminal.id,
			forcedImageProtocol,
			terminal.trueColor,
			hyperlinks,
			terminal.notifyProtocol,
		);
	}
	if (!terminal.imageProtocol) {
		const fallbackImageProtocol = getFallbackImageProtocol(terminal.id, env, stdoutIsTTY);
		if (fallbackImageProtocol) {
			return new TerminalInfo(
				terminal.id,
				fallbackImageProtocol,
				terminal.trueColor,
				hyperlinks,
				terminal.notifyProtocol,
			);
		}
	}
	return new TerminalInfo(
		terminal.id,
		terminal.imageProtocol,
		terminal.trueColor,
		hyperlinks,
		terminal.notifyProtocol,
	);
}

function versionAtLeast(raw: string | undefined, major: number, minor: number, patch = 0): boolean {
	if (!raw) return false;
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw.trim());
	if (!match) return false;
	const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
	const wanted = [major, minor, patch];
	for (let index = 0; index < wanted.length; index++) {
		if (actual[index] !== wanted[index]) return actual[index]! > wanted[index]!;
	}
	return true;
}

function localCommandVersion(env: NodeJS.ProcessEnv, command: "herdr" | "tmux"): string | undefined {
	if (env !== Bun.env) return undefined;
	try {
		const result = Bun.spawnSync([command, command === "tmux" ? "-V" : "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return undefined;
		return /(\d+\.\d+(?:\.\d+)?(?:[-+._A-Za-z0-9]*)?)/u.exec(result.stdout.toString())?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Resolve the immutable startup OSC 8 capability snapshot.
 *
 * Unknown terminals and lossy multiplexers are deliberately conservative.
 * Herdr and tmux are enabled only at versions that preserve OSC 8 spans.
 */
function shouldEnableTerminalHyperlinks(
	env: NodeJS.ProcessEnv,
	stdoutIsTTY: boolean,
	terminalId: TerminalId = resolveTerminalId(env),
): boolean {
	if (!stdoutIsTTY || env.NO_COLOR) return false;
	if (env.STY || env.ZELLIJ) return false;
	if (isInsideHerdr(env)) return versionAtLeast(env.HERDR_VERSION ?? localCommandVersion(env, "herdr"), 0, 7, 5);
	if (env.TMUX) {
		const declaredVersion =
			env.TMUX_VERSION ?? (env.TERM_PROGRAM?.toLowerCase() === "tmux" ? env.TERM_PROGRAM_VERSION : undefined);
		return versionAtLeast(declaredVersion ?? localCommandVersion(env, "tmux"), 3, 4);
	}
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("screen") || term.startsWith("tmux") || term.startsWith("zellij")) return false;
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
		return terminalId !== "base" && terminalId !== "trueColor";
	}
	return terminalId !== "base" && terminalId !== "trueColor";
}

export const TERMINAL_ID: TerminalId = resolveTerminalId(Bun.env);

export const TERMINAL = resolveTerminalInfo(Bun.env, process.stdout.isTTY ?? false);

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
	hyperlinks: boolean;
};

/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void {
	(TERMINAL as unknown as MutableTerminalInfo).imageProtocol = imageProtocol;
}

/** Override OSC 8 hyperlink emission after applying the user's policy. */
export function setTerminalHyperlinks(enabled: boolean): void {
	(TERMINAL as unknown as MutableTerminalInfo).hyperlinks = enabled;
}

export function getTerminalInfo(terminalId: TerminalId): TerminalInfo {
	return KNOWN_TERMINALS[terminalId];
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	imageId?: number;
}

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/** Derive a deterministic Kitty image/placement id from a durable media id. */
export function stableKittyImageId(mediaId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < mediaId.length; index++) {
		hash ^= mediaId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return ((hash >>> 0) % 2_147_483_646) + 1;
}

/** Delete a Kitty image and all placements that use its stable id. */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2;\x1b\\`;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toBase64();
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.round(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

function calculateImageFit(
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions,
	cellDims: CellDimensions,
): { columns: number; rows: number } {
	const maxColumns = options.maxWidthCells !== undefined ? Math.max(1, Math.floor(options.maxWidthCells)) : undefined;
	const maxRows = options.maxHeightCells !== undefined ? Math.max(1, Math.floor(options.maxHeightCells)) : undefined;

	if (maxColumns === undefined && maxRows === undefined) {
		const columns = Math.max(1, Math.ceil(imageDimensions.widthPx / cellDims.widthPx));
		const rows = Math.max(1, Math.ceil(imageDimensions.heightPx / cellDims.heightPx));
		return { columns, rows };
	}

	const maxWidthPx = maxColumns !== undefined ? maxColumns * cellDims.widthPx : Number.POSITIVE_INFINITY;
	const maxHeightPx = maxRows !== undefined ? maxRows * cellDims.heightPx : Number.POSITIVE_INFINITY;
	const scale = Math.min(maxWidthPx / imageDimensions.widthPx, maxHeightPx / imageDimensions.heightPx);
	const fittedWidthPx = imageDimensions.widthPx * scale;
	const fittedHeightPx = imageDimensions.heightPx * scale;

	const columns = Math.max(1, Math.floor(fittedWidthPx / cellDims.widthPx));
	const rows = Math.max(1, Math.round(fittedHeightPx / cellDims.heightPx));

	return {
		columns: maxColumns !== undefined ? Math.min(columns, maxColumns) : columns,
		rows: maxRows !== undefined ? Math.min(rows, maxRows) : rows,
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; rows: number } | null {
	if (!TERMINAL.imageProtocol) {
		return null;
	}

	const cellDims = getCellDimensions();
	const fit = calculateImageFit(imageDimensions, options, cellDims);

	if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
		const sequence = encodeKitty(base64Data, {
			columns: fit.columns,
			rows: fit.rows,
			imageId: options.imageId,
		});
		return { sequence, rows: fit.rows };
	}

	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) {
		try {
			const targetWidthPx = Math.max(1, fit.columns * cellDims.widthPx);
			const targetHeightPx = Math.max(1, fit.rows * cellDims.heightPx);
			const decoded = new Uint8Array(Buffer.from(base64Data, "base64"));
			const sequence = encodeSixel(decoded, targetWidthPx, targetHeightPx);
			return { sequence, rows: fit.rows };
		} catch {
			return null;
		}
	}
	if (TERMINAL.imageProtocol === ImageProtocol.Iterm2) {
		const sequence = encodeITerm2(base64Data, {
			width: fit.columns,
			height: fit.rows,
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows: fit.rows };
	}

	return null;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
