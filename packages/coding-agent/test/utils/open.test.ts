import { afterEach, describe, expect, it, vi } from "bun:test";
import { openHttpUrl } from "../../src/utils/open";

afterEach(() => vi.restoreAllMocks());

describe("openHttpUrl", () => {
	it.each(["file:///tmp/test", "javascript:alert(1)", "data:text/plain,no", "/tmp/test", "not a url"])(
		"rejects non-HTTP target %s",
		async target => {
			expect(await openHttpUrl(target)).toEqual({
				ok: false,
				error: target.includes(":") ? "Only HTTP(S) links can be opened" : "Not a valid URL",
			});
		},
	);

	it("returns explicit launcher success", async () => {
		const spawned = { exited: Promise.resolve(0), stderr: new Response("").body };
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(spawned as never);
		expect(await openHttpUrl("https://example.test/a b")).toEqual({ ok: true });
		expect(spawn).toHaveBeenCalledTimes(1);
		const command = spawn.mock.calls[0]![0] as string[];
		expect(command.at(-1)).toBe("https://example.test/a%20b");
	});

	it("returns explicit launcher failure", async () => {
		vi.spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
			stderr: new Response("launcher failed").body,
		} as never);
		expect(await openHttpUrl("https://example.test")).toEqual({ ok: false, error: "launcher failed" });
	});
});
