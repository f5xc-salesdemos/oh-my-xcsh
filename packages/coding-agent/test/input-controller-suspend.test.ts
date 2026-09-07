import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";

const originalPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform): void => {
	Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
};

function context() {
	const ui = { start: vi.fn(), stop: vi.fn(), requestRender: vi.fn() };
	const showStatus = vi.fn();
	const showError = vi.fn();
	return {
		ctx: { ui, showStatus, showError } as unknown as InteractiveModeContext,
		ui,
		showStatus,
		showError,
	};
}

afterEach(() => {
	setPlatform(originalPlatform);
	process.removeAllListeners("SIGCONT");
	vi.restoreAllMocks();
});

describe("InputController.handleCtrlZ", () => {
	it("is a safe no-op on Windows", () => {
		setPlatform("win32");
		const kill = vi.spyOn(process, "kill");
		const { ctx, ui, showStatus } = context();
		new InputController(ctx).handleCtrlZ();
		expect(kill).not.toHaveBeenCalled();
		expect(ui.stop).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalled();
	});

	it("SIGSTOPs only the xcsh process on POSIX", () => {
		setPlatform("linux");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const { ctx, ui } = context();
		new InputController(ctx).handleCtrlZ();
		expect(ui.stop).toHaveBeenCalled();
		expect(kill).toHaveBeenCalledWith(process.pid, "SIGSTOP");
	});

	it("restores the UI if suspension fails", () => {
		setPlatform("linux");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("blocked");
		});
		const { ctx, ui, showError } = context();
		expect(() => new InputController(ctx).handleCtrlZ()).not.toThrow();
		expect(ui.start).toHaveBeenCalled();
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		expect(showError).toHaveBeenCalled();
	});
});
