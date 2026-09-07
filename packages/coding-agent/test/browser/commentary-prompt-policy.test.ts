import { describe, expect, it } from "bun:test";
import { HOST_PROFILES } from "../../src/browser/host-profiles";

describe("Codex-compatible commentary policy", () => {
	it("does not demand unconditional text before tools", () => {
		for (const profile of Object.values(HOST_PROFILES)) {
			expect(profile.systemPrompt).not.toContain("ALWAYS respond with TEXT FIRST");
		}
	});

	it("requires purposeful commentary and final-answer separation", () => {
		for (const profile of Object.values(HOST_PROFILES)) {
			expect(profile.systemPrompt).toContain("No commentary for trivial no-tool work");
			expect(profile.systemPrompt).toContain("Before non-trivial tool work");
			expect(profile.systemPrompt).toContain("final answer self-contained");
		}
	});
});
