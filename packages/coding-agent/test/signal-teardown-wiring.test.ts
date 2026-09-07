import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("signal teardown wiring", () => {
	it("routes LSP and terminal-disconnect cleanup through postmortem", async () => {
		const sourceRoot = path.resolve(import.meta.dir, "../src");
		const lsp = await Bun.file(path.join(sourceRoot, "lsp/client.ts")).text();
		const interactive = await Bun.file(path.join(sourceRoot, "modes/interactive-mode.ts")).text();
		const terminal = await Bun.file(path.resolve(import.meta.dir, "../../tui/src/terminal.ts")).text();

		expect(lsp).toContain('postmortem.register("lsp-shutdown"');
		expect(lsp).not.toContain('process.on("SIGTERM"');
		expect(interactive).toContain('postmortem.register("session-teardown"');
		expect(interactive).toContain("createSessionTeardown({");
		expect(terminal).toContain('process.kill(process.pid, "SIGHUP")');
	});
});
