import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@f5-sales-demo/pi-agent-core";
import { CopySelectorComponent } from "../../../src/modes/components/copy-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionMessageEntry } from "../../../src/session/session-manager";

function entry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-09-07T00:00:00Z", message };
}

function user(id: string, text: string): SessionMessageEntry {
	return entry(id, { role: "user", content: text, timestamp: 1 });
}

function assistant(id: string, text: string): SessionMessageEntry {
	return entry(id, {
		role: "assistant",
		content: [{ type: "text", text }],
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

beforeAll(() => initTheme());

describe("CopySelectorComponent", () => {
	it("navigates targets, enters blocks, copies, opens links, and ascends", () => {
		const onPick = vi.fn();
		const onOpen = vi.fn();
		const onCancel = vi.fn();
		const selector = new CopySelectorComponent(
			[user("u", "question"), assistant("a", "```ts\nconst x = 1;\n```\n[docs](https://example.test/docs)")],
			{ requestRender: vi.fn(), onPick, onOpen, onCancel, viewportRows: () => 20 },
		);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("o");
		expect(onOpen).toHaveBeenCalledWith("https://example.test/docs", "link · docs");
		selector.handleInput("\r");
		expect(onPick).toHaveBeenCalledWith("https://example.test/docs", "link · docs");
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("shows an explicit earlier-history placeholder for an oversized turn and loads it with a", () => {
		const entries = [
			user("old", "old"),
			...Array.from({ length: 700 }, (_, index) => assistant(`a-${index}`, `part ${index}`)),
		];
		const selector = new CopySelectorComponent(entries, {
			requestRender: vi.fn(),
			onPick: vi.fn(),
			onCancel: vi.fn(),
		});
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("press a to load all history");
		expect(selector.touchedEntryCount).toBe(600);
		selector.handleInput("a");
		expect(selector.targetCount).toBe(701);
	});

	it("restores selection by stable entry ID after loading omitted history", () => {
		const entries = Array.from({ length: 605 }, (_, index) => user(`u-${index}`, `message ${index}`));
		const onPick = vi.fn();
		const selector = new CopySelectorComponent(entries, {
			requestRender: vi.fn(),
			onPick,
			onCancel: vi.fn(),
		});
		selector.handleInput("\x1b[A");
		selector.handleInput("a");
		selector.handleInput("\r");
		expect(onPick).toHaveBeenCalledWith("message 603", "user message");
	});

	it("keeps disposal idempotent", () => {
		const selector = new CopySelectorComponent([user("u", "hello")], {
			requestRender: vi.fn(),
			onPick: vi.fn(),
			onCancel: vi.fn(),
		});
		expect(() => {
			selector.dispose();
			selector.dispose();
		}).not.toThrow();
	});

	it("routes scroll-aware clicks only through visible copy/open controls and skips no-op repaint", () => {
		const requestRender = vi.fn();
		const onPick = vi.fn();
		const onOpen = vi.fn();
		const links = Array.from({ length: 8 }, (_, index) => `[link ${index}](https://example.test/${index})`).join(
			"\n",
		);
		const selector = new CopySelectorComponent([assistant("a", links)], {
			requestRender,
			onPick,
			onOpen,
			onCancel: vi.fn(),
			viewportRows: () => 7,
		});
		selector.handleInput("\x1b[C");
		selector.render(100);
		selector.handleInput("\x1b[<65;1;1M");
		const rendered = selector.render(100).map(line => Bun.stripANSI(line));
		const row = rendered.findIndex(line => line.includes("link · link 2"));
		const col = rendered[row]!.indexOf("↗ open");
		expect(row).toBeGreaterThanOrEqual(2);
		expect(col).toBeGreaterThan(0);
		selector.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
		expect(onOpen).toHaveBeenCalledWith("https://example.test/2", "link · link 2");
		expect(onPick).not.toHaveBeenCalled();

		for (let index = 0; index < 20; index++) {
			selector.handleInput("\x1b[<65;1;1M");
			selector.render(100);
		}
		requestRender.mockClear();
		selector.handleInput("\x1b[<65;1;1M");
		expect(requestRender).not.toHaveBeenCalled();
	});
});
