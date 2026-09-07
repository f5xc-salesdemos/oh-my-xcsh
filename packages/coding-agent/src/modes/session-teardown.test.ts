import { describe, expect, it } from "bun:test";
import { createSessionTeardown } from "./session-teardown";

describe("createSessionTeardown", () => {
	it("saves the draft before disposal", async () => {
		const order: string[] = [];
		const teardown = createSessionTeardown({
			getDraftText: () => "unsent draft",
			beginDispose: () => void order.push("begin"),
			saveDraft: async text => void order.push(`save:${text}`),
			disposeSession: async () => void order.push("dispose"),
		});
		await teardown();
		expect(order).toEqual(["begin", "save:unsent draft", "dispose"]);
	});

	it("always disposes after a failed draft write", async () => {
		let disposed = false;
		const teardown = createSessionTeardown({
			getDraftText: () => "draft",
			beginDispose: () => {},
			saveDraft: async () => {
				throw new Error("disk full");
			},
			disposeSession: async () => {
				disposed = true;
			},
		});
		await teardown();
		expect(disposed).toBe(true);
	});

	it("snapshots once and memoizes concurrent disposal", async () => {
		let draftCalls = 0;
		let saveCalls = 0;
		let disposeCalls = 0;
		const release = Promise.withResolvers<void>();
		const teardown = createSessionTeardown({
			getDraftText: () => `draft-${++draftCalls}`,
			beginDispose: () => {},
			saveDraft: async () => void saveCalls++,
			disposeSession: async () => {
				disposeCalls++;
				await release.promise;
			},
		});
		const first = teardown();
		const second = teardown();
		release.resolve();
		await Promise.all([first, second]);
		await teardown();
		expect({ draftCalls, saveCalls, disposeCalls }).toEqual({ draftCalls: 1, saveCalls: 1, disposeCalls: 1 });
	});
});
