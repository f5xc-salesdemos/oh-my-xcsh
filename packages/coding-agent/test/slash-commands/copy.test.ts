import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "../../src/modes/types";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

function runtime() {
	const handleCopyCommand = vi.fn();
	const handleOpenCommand = vi.fn(async (_args: string) => undefined);
	const setText = vi.fn();
	return {
		handleCopyCommand,
		handleOpenCommand,
		setText,
		value: {
			ctx: { handleCopyCommand, handleOpenCommand, editor: { setText } } as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("copy/open slash commands", () => {
	it.each([undefined, "last", "code", "all", "cmd", "link"])("routes /copy %s", async subcommand => {
		const harness = runtime();
		const input = subcommand ? `/copy ${subcommand}` : "/copy";
		expect(await executeBuiltinSlashCommand(input, harness.value)).toBe(true);
		expect(harness.handleCopyCommand).toHaveBeenCalledWith(subcommand);
	});

	it("opens only with no arguments and lets the controller report rejection", async () => {
		const harness = runtime();
		expect(await executeBuiltinSlashCommand("/open", harness.value)).toBe(true);
		expect(await executeBuiltinSlashCommand("/open /tmp/file", harness.value)).toBe(true);
		expect(harness.handleOpenCommand.mock.calls).toEqual([[""], ["/tmp/file"]]);
	});
});
