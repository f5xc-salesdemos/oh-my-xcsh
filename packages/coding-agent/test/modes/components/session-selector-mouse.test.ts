import { beforeAll, describe, expect, it } from "bun:test";
import type { SgrMouseEvent } from "@f5-sales-demo/pi-tui";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => initTheme());

const mouseEvent = (row: number, overrides: Partial<SgrMouseEvent> = {}): SgrMouseEvent => ({
	button: 0,
	col: 3,
	row,
	release: false,
	wheel: null,
	motion: false,
	leftClick: true,
	...overrides,
});

function session(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-02T00:00:00Z"),
		messageCount: 1,
		firstMessage: `body for ${id}`,
		allMessagesText: `body for ${id}`,
	};
}

function selector(onSelect: (path: string) => void, rows = 28): SessionSelectorComponent {
	return new SessionSelectorComponent(
		[session("alpha", "Alpha session"), session("beta", "Beta session"), session("gamma", "Gamma session")],
		onSelect,
		() => {},
		() => {},
		undefined,
		{ fillHeight: true, getTerminalRows: () => rows },
	);
}

describe("SessionSelectorComponent mouse", () => {
	it("selects a rendered session row and preserves Enter behavior", () => {
		const picked: string[] = [];
		const component = selector(path => picked.push(path));
		const lines = component.render(80).map(line => Bun.stripANSI(line));
		const betaRow = lines.findIndex(line => line.includes("Beta session"));
		component.routeMouse(mouseEvent(betaRow), betaRow, 3);
		expect(picked).toEqual(["/tmp/beta.jsonl"]);

		const keyboardPicked: string[] = [];
		selector(path => keyboardPicked.push(path)).handleInput("\n");
		expect(keyboardPicked).toEqual(["/tmp/alpha.jsonl"]);
	});

	it("keeps separator and pinned footer rows inert", () => {
		const picked: string[] = [];
		const component = selector(path => picked.push(path));
		const lines = component.render(80).map(line => Bun.stripANSI(line));
		const alphaRow = lines.findIndex(line => line.includes("Alpha session"));
		const betaRow = lines.findIndex(line => line.includes("Beta session"));
		const separatorRow = lines.findIndex((line, index) => index > alphaRow && index < betaRow && line.trim() === "");
		const footerRow = lines.findIndex(line => line.includes("Esc to cancel"));
		component.routeMouse(mouseEvent(separatorRow), separatorRow, 3);
		component.routeMouse(mouseEvent(footerRow), footerRow, 3);
		expect(picked).toEqual([]);
	});

	it("moves the selected session with wheel input", () => {
		const picked: string[] = [];
		const component = selector(path => picked.push(path));
		component.render(80);
		component.routeMouse(mouseEvent(0, { button: 65, wheel: 1, leftClick: false }), 0, 0);
		component.handleInput("\n");
		expect(picked).toEqual(["/tmp/beta.jsonl"]);
	});

	it("keeps delete confirmation visible in a filled viewport", () => {
		const component = new SessionSelectorComponent(
			Array.from({ length: 20 }, (_, index) => session(`s${index}`, `Session ${index}`)),
			() => {},
			() => {},
			() => {},
			async () => false,
			{ fillHeight: true, getTerminalRows: () => 24 },
		);
		component.handleInput("\x1b[3~");
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Delete session?");
		expect(rendered).toContain("Session 0");
	});
});
