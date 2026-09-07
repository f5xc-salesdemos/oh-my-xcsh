import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTerminalHyperlinks, TERMINAL } from "@f5-sales-demo/pi-tui";
import { settings } from "../config/settings";

const DETECTED_TERMINAL_HYPERLINKS = TERMINAL.hyperlinks;
let policyGeneration = 0;
const OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const UNSAFE_RE = /[\x00-\x1f\x7f-\x9f]/u;
type HyperlinkMode = "off" | "auto" | "always";

export function resolveHyperlinkMode(
	mode: HyperlinkMode,
	options: { detected?: boolean; isTTY?: boolean; noColor?: boolean } = {},
): boolean {
	if (mode === "off") return false;
	if (mode === "always") return true;
	return (
		(options.detected ?? DETECTED_TERMINAL_HYPERLINKS) &&
		(options.isTTY ?? process.stdout.isTTY === true) &&
		!(options.noColor ?? Boolean(Bun.env.NO_COLOR))
	);
}

export function isHyperlinkEnabled(): boolean {
	return resolveHyperlinkMode(settings.get("tui.hyperlinks"));
}

export function applyHyperlinkSetting(mode?: unknown): void {
	const resolved = mode === "off" || mode === "auto" || mode === "always" ? mode : settings.get("tui.hyperlinks");
	const enabled = resolveHyperlinkMode(resolved);
	if (TERMINAL.hyperlinks !== enabled) policyGeneration++;
	setTerminalHyperlinks(enabled);
}

export function getHyperlinkPolicyGeneration(): number {
	return policyGeneration;
}

function safeAbsoluteUri(target: string): string | undefined {
	if (!target || UNSAFE_RE.test(target)) return undefined;
	try {
		if (UNSAFE_RE.test(decodeURIComponent(target))) return undefined;
		const parsed = new URL(target);
		if (!new Set(["http:", "https:", "file:"]).has(parsed.protocol)) return undefined;
		return parsed.href;
	} catch {
		return undefined;
	}
}

function wrap(target: string, label: string): string {
	if (!TERMINAL.hyperlinks) return label;
	const uri = safeAbsoluteUri(target);
	if (!uri) return label;
	return `\x1b]8;;${uri}\x07${label.replace(OSC8_RE, "")}\x1b]8;;\x07`;
}

export function urlHyperlink(target: string, label: string): string {
	const normalized = /^www\./iu.test(target) ? `https://${target}` : target;
	return wrap(normalized, label);
}

export function recoveryUrlHyperlink(target: string, label: string): string {
	const normalized = /^www\./iu.test(target) ? `https://${target}` : target;
	return wrap(normalized, label);
}

export function fileHyperlink(target: string, label: string, cwd = process.cwd()): string {
	const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
	return wrap(pathToFileURL(absolute).href, label);
}
