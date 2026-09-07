import { describe, expect, it } from "bun:test";
import type { SgrMouseEvent } from "../src/mouse";
import type { Terminal, TerminalAppearance } from "../src/terminal";
import { type Component, TUI } from "../src/tui";

class RecordingTerminal implements Terminal {
	columns = 40;
	rows = 8;
	kittyProtocolActive = false;
	appearance: TerminalAppearance | undefined;
	writes: string[] = [];
	input?: (data: string) => void;
	resize?: () => void;
	start(input: (data: string) => void, resize: () => void): void {
		this.input = input;
		this.resize = resize;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	onAppearanceChange(): void {}
}

class MouseComponent implements Component {
	events: SgrMouseEvent[] = [];
	render(): string[] {
		return ["FULLSCREEN"];
	}
	invalidate(): void {}
	routeMouse(event: SgrMouseEvent): void {
		this.events.push(event);
	}
}

describe("fullscreen overlay lifecycle", () => {
	it("owns alternate screen and mouse modes until hidden", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		const component = new MouseComponent();
		const handle = tui.showOverlay(component, { fullscreen: true });
		tui.start();
		await Bun.sleep(0);
		expect(terminal.writes.join("")).toContain("\x1b[?1049h");
		expect(terminal.writes.join("")).toContain("\x1b[?1006h");

		terminal.input?.("\x1b[<0;3;4M");
		expect(component.events[0]).toMatchObject({ col: 2, row: 3, leftClick: true });

		handle.hide();
		await Bun.sleep(0);
		const output = terminal.writes.join("");
		expect(output).toContain("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
		expect(output).toContain("\x1b[?1049l");
	});

	it("leaves ordinary overlays on the normal screen", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.showOverlay(new MouseComponent());
		tui.start();
		await Bun.sleep(0);
		expect(terminal.writes.join("")).not.toContain("\x1b[?1049h");
		tui.stop();
	});

	it("keeps one alternate screen across nested fullscreen overlays", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		const first = tui.showOverlay(new MouseComponent(), { fullscreen: true });
		tui.start();
		await Bun.sleep(0);
		const second = tui.showOverlay(new MouseComponent(), { fullscreen: true, mouseTracking: false });
		await Bun.sleep(0);
		expect(terminal.writes.join("").match(/\x1b\[\?1049h/g)).toHaveLength(1);
		expect(terminal.writes.join("")).toContain("\x1b[?1006l\x1b[?1003l\x1b[?1000l");

		second.hide();
		await Bun.sleep(0);
		expect(terminal.writes.join("").match(/\x1b\[\?1049l/g)).toBeNull();
		expect(terminal.writes.join("").match(/\x1b\[\?1006h/g)?.length).toBe(2);

		first.hide();
		await Bun.sleep(0);
		expect(terminal.writes.join("").match(/\x1b\[\?1049l/g)).toHaveLength(1);
	});

	it("restores mouse and screen modes when stopped", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.showOverlay(new MouseComponent(), { fullscreen: true });
		tui.start();
		await Bun.sleep(0);
		terminal.writes.length = 0;

		tui.stop();
		const output = terminal.writes.join("");
		expect(output).toContain("\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?1049l");
	});

	it("keeps mouse reporting disabled when a fullscreen overlay opts out", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.showOverlay(new MouseComponent(), { fullscreen: true, mouseTracking: false });
		tui.start();
		await Bun.sleep(0);
		expect(terminal.writes.join("")).toContain("\x1b[?1049h");
		expect(terminal.writes.join("")).not.toContain("\x1b[?1006h");
		tui.stop();
	});

	it("repaints on width-only resize and preserves scrollback on exit", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new MouseComponent());
		const overlay = tui.showOverlay(new MouseComponent(), { fullscreen: true });
		tui.start();
		await Bun.sleep(0);
		terminal.writes.length = 0;

		terminal.columns = 50;
		terminal.resize?.();
		await Bun.sleep(0);
		expect(terminal.writes.join("")).toContain("\x1b[H");

		terminal.writes.length = 0;
		overlay.hide();
		await Bun.sleep(0);
		const restored = terminal.writes.join("");
		expect(restored).toContain("\x1b[?1049l");
		expect(restored).not.toContain("\x1b[3J");
		tui.stop();
	});
});
