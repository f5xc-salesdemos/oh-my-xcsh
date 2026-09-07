import { afterEach, describe, expect, it, vi } from "bun:test";
import * as native from "@f5-sales-demo/pi-natives";
import { copyToClipboardWithResult } from "../../src/utils/clipboard";

afterEach(() => vi.restoreAllMocks());

describe("copyToClipboardWithResult", () => {
	it("reports native clipboard success", async () => {
		vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		expect(await copyToClipboardWithResult("copy me")).toEqual({ ok: true });
	});

	it("reports an actionable failure when no clipboard transport succeeds", async () => {
		vi.spyOn(native, "copyToClipboard").mockImplementation(() => {
			throw new Error("clipboard unavailable");
		});
		expect(await copyToClipboardWithResult("copy me")).toEqual({
			ok: false,
			error: "clipboard unavailable",
		});
	});
});
