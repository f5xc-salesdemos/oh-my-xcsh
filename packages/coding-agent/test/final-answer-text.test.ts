import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import { finalAnswerText } from "../src/session/final-answer";

describe("finalAnswerText", () => {
	it("excludes commentary and treats a missing phase as final-answer text", () => {
		const message = {
			content: [
				{ type: "text", text: "I am checking.", phase: "commentary" },
				{ type: "text", text: "The explicit answer.", phase: "final_answer" },
				{ type: "text", text: "Legacy answer." },
			],
		} as AssistantMessage;

		expect(finalAnswerText(message)).toBe("The explicit answer.\nLegacy answer.");
	});

	it("returns an empty string for commentary-only output", () => {
		const message = {
			content: [{ type: "text", text: "Still working.", phase: "commentary" }],
		} as AssistantMessage;
		expect(finalAnswerText(message)).toBe("");
	});
});
