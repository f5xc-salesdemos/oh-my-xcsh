import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@f5-sales-demo/pi-agent-core";
import {
	buildCopyTargets,
	extractLastLink,
	extractMarkdownBlocks,
	initialCopyEntries,
} from "../../../src/modes/utils/copy-targets";
import { SessionManager, type SessionMessageEntry } from "../../../src/session/session-manager";

function entry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-09-07T00:00:00Z", message };
}

function user(id: string, text: string): SessionMessageEntry {
	return entry(id, { role: "user", content: text, timestamp: 1 });
}

function assistant(id: string, content: unknown[]): SessionMessageEntry {
	return entry(id, {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AgentMessage);
}

describe("initial copy projection", () => {
	it("reads only the newest bounded message tail from the session tree", () => {
		const manager = SessionManager.inMemory();
		for (let index = 0; index < 605; index++)
			manager.appendMessage({ role: "user", content: `${index}`, timestamp: 1 });
		const tail = manager.getMessageBranchTail(600);
		expect(tail.truncated).toBe(true);
		expect(tail.entries).toHaveLength(600);
		expect(tail.entries[0]?.message.role === "user" && tail.entries[0].message.content).toBe("5");
	});

	it("counts non-message branch entries against the 600-entry inspection bound", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "outside-bound", timestamp: 1 });
		for (let index = 0; index < 600; index++) manager.appendCustomEntry("metadata", { index });
		manager.appendMessage({ role: "user", content: "inside-bound", timestamp: 1 });

		const tail = manager.getMessageBranchTail(600);
		expect(tail.truncated).toBe(true);
		expect(tail.entries).toHaveLength(1);
		expect(tail.entries[0]?.message.role === "user" && tail.entries[0].message.content).toBe("inside-bound");
	});

	it("advances a 600-entry tail to the first user boundary", () => {
		const entries = Array.from({ length: 605 }, (_, index) =>
			assistant(`a-${index}`, [{ type: "text", text: `${index}` }]),
		);
		entries[10] = user("boundary", "start");
		const result = initialCopyEntries(entries);
		expect(result.entries[0]?.id).toBe("boundary");
		expect(result.touched).toBe(595);
		expect(result.entries.length).toBeLessThanOrEqual(600);
	});

	it("requires explicit all-history loading when no complete turn fits", () => {
		const entries = [
			user("old", "oversized"),
			...Array.from({ length: 700 }, (_, index) => assistant(`a-${index}`, [])),
		];
		const result = initialCopyEntries(entries);
		expect(result.entries).toEqual([]);
		expect(result.requiresAllHistory).toBe(true);
		expect(result.touched).toBe(600);
	});

	it("starts at a user-attributed boundary and ignores agent-attributed user messages", () => {
		const entries = Array.from({ length: 605 }, (_, index) =>
			assistant(`a-${index}`, [{ type: "text", text: `${index}` }]),
		);
		entries[6] = entry("agent-user", { role: "user", content: "internal", attribution: "agent", timestamp: 1 });
		entries[9] = entry("forwarded-user", {
			role: "developer",
			content: "forwarded",
			attribution: "user",
			timestamp: 1,
		});
		const result = initialCopyEntries(entries);
		expect(result.entries[0]?.id).toBe("forwarded-user");
	});
});

describe("copy targets", () => {
	it("folds matching grouped tool results and preserves orphan results", () => {
		const call = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } });
		const result = (id: string, callId: string) =>
			entry(id, {
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text: id }],
				isError: false,
				timestamp: 1,
			});
		const targets = buildCopyTargets([
			assistant("tools", [call("one"), call("two")]),
			result("result-one", "one"),
			result("result-two", "two"),
			result("orphan", "missing"),
		]);
		expect(targets).toHaveLength(2);
		expect(targets[0]?.entries.map(item => item.id)).toEqual(["tools", "result-one", "result-two"]);
		expect(targets[0]?.blocks.filter(block => block.kind === "result")).toHaveLength(2);
		expect(targets[1]?.id).toBe("orphan");
	});

	it("extracts code, quotes, commands, and deduplicated HTTP links", () => {
		const blocks = extractMarkdownBlocks(
			"> quote\n> continued\n\n```ts\nconst x = 1;\n```\n[one](https://example.test) https://example.test",
		);
		expect(blocks.map(block => block.kind)).toEqual(["quote", "code", "link"]);
		expect(blocks[0]?.content).toBe("quote\ncontinued");
		expect(blocks[2]?.href).toBe("https://example.test");
	});

	it("returns only the latest HTTP(S) transcript link", () => {
		const messages = [
			assistant("a", [{ type: "text", text: "[file](file:///tmp/x) https://first.test" }]).message,
			assistant("b", [{ type: "text", text: "[latest](https://latest.test/path)" }]).message,
		];
		expect(extractLastLink(messages)).toBe("https://latest.test/path");
	});
});
