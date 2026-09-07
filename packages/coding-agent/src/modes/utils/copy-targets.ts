import type { AgentMessage } from "@f5-sales-demo/pi-agent-core";
import type { ToolCall } from "@f5-sales-demo/pi-ai";
import { extractMarkdownLinks } from "@f5-sales-demo/pi-tui";
import type { SessionMessageEntry } from "../../session/session-manager";

export interface CopyBlock {
	kind: "code" | "quote" | "command" | "result" | "link";
	label: string;
	content: string;
	language?: string;
	href?: string;
}

export interface CopyTarget {
	id: string;
	role: AgentMessage["role"];
	label: string;
	content: string;
	entries: SessionMessageEntry[];
	blocks: CopyBlock[];
}

export interface InitialCopyProjection {
	entries: SessionMessageEntry[];
	truncated: boolean;
	requiresAllHistory: boolean;
	touched: number;
}

const OPEN_FENCE_RE = /^```([^\n]*)$/u;
const CLOSE_FENCE_RE = /^```/u;
const QUOTE_RE = /^>(.*)$/u;

export function initialCopyEntries(
	entries: readonly SessionMessageEntry[],
	limit = 600,
	hasEarlier = false,
): InitialCopyProjection {
	if (entries.length <= limit && !hasEarlier)
		return { entries: [...entries], truncated: false, requiresAllHistory: false, touched: entries.length };
	const start = Math.max(0, entries.length - limit);
	for (let index = start; index < entries.length; index++) {
		const message = entries[index]!.message;
		const attribution = "attribution" in message ? message.attribution : undefined;
		if (attribution === "user" || (message.role === "user" && attribution !== "agent")) {
			return {
				entries: entries.slice(index),
				truncated: true,
				requiresAllHistory: false,
				touched: entries.length - index,
			};
		}
	}
	return { entries: [], truncated: true, requiresAllHistory: true, touched: Math.min(limit, entries.length) };
}

function textContent(message: AgentMessage): string {
	if (message.role === "user" || message.role === "developer") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("")
			.trim();
	}
	if (message.role === "toolResult") {
		return message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim();
	}
	if (message.role === "bashExecution") return [message.command, message.output].filter(Boolean).join("\n");
	if (message.role === "pythonExecution") return [message.code, message.output].filter(Boolean).join("\n");
	if (message.role === "branchSummary") return message.summary;
	if (message.role === "compactionSummary") return message.summary;
	if (message.role === "custom" || message.role === "hookMessage") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n");
	}
	return "";
}

export function extractMarkdownBlocks(text: string): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	const lines = text.split("\n");
	let quote: string[] | undefined;
	const flushQuote = () => {
		if (!quote) return;
		blocks.push({ kind: "quote", label: "quote", content: quote.join("\n") });
		quote = undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const open = OPEN_FENCE_RE.exec(line);
		if (open) {
			let close = index + 1;
			while (close < lines.length && !CLOSE_FENCE_RE.test(lines[close]!)) close++;
			if (close < lines.length) {
				flushQuote();
				const language = open[1]!.trim() || undefined;
				blocks.push({
					kind: "code",
					label: language ? `code · ${language}` : "code",
					content: lines.slice(index + 1, close).join("\n"),
					language,
				});
				index = close;
				continue;
			}
		}
		const match = QUOTE_RE.exec(line);
		if (match) {
			quote ??= [];
			quote.push(match[1]!.startsWith(" ") ? match[1]!.slice(1) : match[1]!);
		} else {
			flushQuote();
		}
	}
	flushQuote();
	const seen = new Set<string>();
	for (const link of extractMarkdownLinks(text)) {
		if (!/^https?:\/\//iu.test(link.href) || seen.has(link.href)) continue;
		seen.add(link.href);
		blocks.push({
			kind: "link",
			label: link.text === link.href ? "link" : `link · ${link.text}`,
			content: link.href,
			href: link.href,
		});
	}
	return blocks;
}

function commandFromToolCall(call: ToolCall): CopyBlock | undefined {
	if (call.name === "bash" && typeof call.arguments.command === "string") {
		return { kind: "command", label: "bash command", content: call.arguments.command, language: "bash" };
	}
	if (call.name === "python" && typeof call.arguments.code === "string") {
		return { kind: "command", label: "python command", content: call.arguments.code, language: "python" };
	}
	if (call.name === "eval") {
		const args = call.arguments as { code?: unknown; cells?: unknown };
		const cells = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
		const code = cells
			.flatMap(cell =>
				cell && typeof cell === "object" && typeof (cell as { code?: unknown }).code === "string"
					? [(cell as { code: string }).code]
					: [],
			)
			.join("\n\n");
		if (code) return { kind: "command", label: "eval command", content: code, language: "python" };
	}
	return undefined;
}

function targetLabel(message: AgentMessage): string {
	const attribution = "attribution" in message ? message.attribution : undefined;
	if (attribution === "user" || (message.role === "user" && attribution !== "agent")) return "user message";
	if (message.role === "assistant") return "assistant message";
	if (message.role === "toolResult") return `${message.toolName} result`;
	if (message.role === "bashExecution") return "bash execution";
	if (message.role === "pythonExecution") return "python execution";
	return "message";
}

/** Build copy targets directly from persisted SessionMessageEntry values. */
export function buildCopyTargets(entries: readonly SessionMessageEntry[]): CopyTarget[] {
	const targets: CopyTarget[] = [];
	const calls = new Map<string, CopyTarget>();
	for (const entry of entries) {
		const message = entry.message;
		if (message.role === "toolResult") {
			const owner = calls.get(message.toolCallId);
			if (owner) {
				owner.entries.push(entry);
				const result = textContent(message);
				if (result) owner.blocks.push({ kind: "result", label: `${message.toolName} result`, content: result });
				continue;
			}
		}

		const content = textContent(message);
		const blocks = extractMarkdownBlocks(content);
		const target: CopyTarget = {
			id: entry.id,
			role: message.role,
			label: targetLabel(message),
			content,
			entries: [entry],
			blocks,
		};
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls.set(part.id, target);
				const command = commandFromToolCall(part);
				if (command) blocks.push(command);
			}
		}
		if (message.role === "bashExecution") {
			blocks.push({ kind: "command", label: "bash command", content: message.command, language: "bash" });
			if (message.output.trim()) blocks.push({ kind: "result", label: "bash result", content: message.output });
		}
		if (message.role === "pythonExecution") {
			blocks.push({ kind: "command", label: "python command", content: message.code, language: "python" });
			if (message.output.trim()) blocks.push({ kind: "result", label: "python result", content: message.output });
		}
		if (
			content ||
			blocks.length > 0 ||
			(message.role === "assistant" && message.content.some(part => part.type === "toolCall"))
		) {
			targets.push(target);
		}
	}
	return targets;
}

export function extractLastLink(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const links = extractMarkdownBlocks(textContent(messages[index]!)).filter(block => block.kind === "link");
		const last = links.at(-1);
		if (last?.href) return last.href;
	}
	return undefined;
}
