import { afterEach, describe, expect, it, vi } from "bun:test";
import { emergencyTerminalRestore, ProcessTerminal, setAlternateScreenActive } from "../src/terminal";

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

function stoppedTerminal(): string[] {
	const writes: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	const terminal = new ProcessTerminal();
	terminal.start(
		() => {},
		() => {},
	);
	terminal.stop();
	writes.length = 0;
	return writes;
}

afterEach(() => {
	setAlternateScreenActive(false);
	vi.restoreAllMocks();
	restore(process.stdin, "isTTY", stdinIsTty);
	restore(process.stdout, "isTTY", stdoutIsTty);
	restore(process.stdin, "setRawMode", stdinSetRawMode);
});

describe("emergency fullscreen restoration", () => {
	it("always disables mouse modes without leaving an inactive alternate screen", () => {
		const writes = stoppedTerminal();
		emergencyTerminalRestore();
		const output = writes.join("");
		expect(output).toContain("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
		expect(output).not.toContain("\x1b[?1049l");
	});

	it("leaves an active alternate screen exactly once", () => {
		const writes = stoppedTerminal();
		setAlternateScreenActive(true);
		emergencyTerminalRestore();
		expect(writes.join("")).toContain("\x1b[?1049l");
		writes.length = 0;
		emergencyTerminalRestore();
		expect(writes.join("")).not.toContain("\x1b[?1049l");
	});
});
