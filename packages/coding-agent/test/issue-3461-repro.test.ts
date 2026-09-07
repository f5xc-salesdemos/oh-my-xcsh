import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("Ctrl-Z brush SIGTSTP assumption", () => {
	it("pins the vendored listener and uncatchable self-SIGSTOP workaround", async () => {
		const root = path.resolve(import.meta.dir, "../../..");
		const signalSource = await Bun.file(path.join(root, "crates/brush-core-vendored/src/sys/unix/signal.rs")).text();
		const processesSource = await Bun.file(path.join(root, "crates/brush-core-vendored/src/processes.rs")).text();
		const controllerSource = await Bun.file(
			path.join(import.meta.dir, "../src/modes/controllers/input-controller.ts"),
		).text();
		expect(signalSource).toContain("tstp_signal_listener");
		expect(signalSource).toMatch(/SIGTSTP/);
		expect(processesSource).toContain("tstp_signal_listener");
		expect(controllerSource).toMatch(/process\.kill\(process\.pid, "SIGSTOP"\)/);
	});
});
