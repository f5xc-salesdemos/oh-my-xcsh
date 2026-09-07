import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { processResponsesStream } from "../src/providers/openai-responses-shared";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

async function* responseEvents(): AsyncGenerator<any> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "message",
			id: "msg-c",
			role: "assistant",
			status: "in_progress",
			phase: "commentary",
			content: [],
		},
	};
	yield { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } };
	yield { type: "response.output_text.delta", delta: "Checking now." };
	yield {
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg-c",
			role: "assistant",
			status: "completed",
			phase: "commentary",
			content: [{ type: "output_text", text: "Checking now.", annotations: [] }],
		},
	};
	yield {
		type: "response.output_item.added",
		item: { type: "message", id: "msg-f", role: "assistant", status: "in_progress", content: [] },
	};
	yield { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } };
	yield { type: "response.output_text.delta", delta: "Complete." };
	yield {
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg-f",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Complete.", annotations: [] }],
		},
	};
}

describe("OpenAI Responses assistant phases", () => {
	it("promotes phase onto text content and boundaries while deltas remain phase-less", async () => {
		const output = assistant();
		const stream = new AssistantMessageEventStream();
		const seen: AssistantMessageEvent[] = [];
		const consume = (async () => {
			for await (const event of stream) seen.push(event);
		})();
		await processResponsesStream(responseEvents(), output, stream, getBundledModel("openai", "gpt-5")!);
		stream.end(output);
		await consume;

		expect(output.content).toMatchObject([
			{ type: "text", text: "Checking now.", phase: "commentary" },
			{ type: "text", text: "Complete.", phase: "final_answer" },
		]);
		expect(seen.filter(event => event.type === "text_start").map(event => event.phase)).toEqual([
			"commentary",
			"final_answer",
		]);
		expect(seen.filter(event => event.type === "text_end").map(event => event.phase)).toEqual([
			"commentary",
			"final_answer",
		]);
		for (const event of seen.filter(event => event.type === "text_delta")) {
			expect("phase" in event).toBe(false);
		}
	});
});
