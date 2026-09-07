import { describe, expect, it } from "bun:test";
import { initTurn, reduceChatTurn } from "../src/core/protocol/reduce";

const ID = "c-phase";

describe("phased assistant item reduction", () => {
	it("keeps ordered commentary and final-answer lifecycle items", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, { type: "chat_message_start", id: ID, itemId: "a1", phase: "commentary" } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a1", seq: 1, delta: "now." } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a1", seq: 0, delta: "Checking " } as any);
		state = reduceChatTurn(state, { type: "chat_message_end", id: ID, itemId: "a1", phase: "commentary" } as any);
		state = reduceChatTurn(state, { type: "chat_message_start", id: ID, itemId: "a2", phase: "final_answer" } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a2", seq: 0, delta: "Complete." } as any);
		state = reduceChatTurn(state, { type: "chat_message_end", id: ID, itemId: "a2", phase: "final_answer" } as any);
		state = reduceChatTurn(state, { type: "chat_done", id: ID } as any);

		expect(state.items).toEqual([
			expect.objectContaining({ id: "a1", phase: "commentary", text: "Checking now.", status: "done" }),
			expect.objectContaining({ id: "a2", phase: "final_answer", text: "Complete.", status: "done" }),
		]);
		expect(state.text).toBe("Checking now.\n\nComplete.");
		expect(state.finalText).toBe("Complete.");
		expect(state.status).toBe("done");
	});

	it("ignores duplicate lifecycle frames and defaults missing phase to final_answer", () => {
		let state = initTurn(ID);
		const start = { type: "chat_message_start", id: ID, itemId: "a1", phase: "final_answer" } as any;
		state = reduceChatTurn(state, start);
		state = reduceChatTurn(state, start);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a1", seq: 0, delta: "Answer" } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a1", seq: 0, delta: "Answer" } as any);
		state = reduceChatTurn(state, { type: "chat_message_end", id: ID, itemId: "a1", phase: "final_answer" } as any);

		expect(state.items).toHaveLength(1);
		expect(state.text).toBe("Answer");
		expect(state.finalText).toBe("Answer");
	});

	it("preserves phased partial text and marks every item errored when the turn aborts", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, { type: "chat_message_start", id: ID, itemId: "a1", phase: "commentary" } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a1", seq: 0, delta: "Trying." } as any);
		state = reduceChatTurn(state, { type: "chat_message_end", id: ID, itemId: "a1", phase: "commentary" } as any);
		state = reduceChatTurn(state, { type: "chat_message_start", id: ID, itemId: "a2", phase: "final_answer" } as any);
		state = reduceChatTurn(state, { type: "chat_delta", id: ID, itemId: "a2", seq: 0, delta: "Partial" } as any);
		state = reduceChatTurn(state, { type: "chat_error", id: ID, reason: "provider-5xx" } as any);

		expect(state.status).toBe("error");
		expect(state.reason).toBe("provider-5xx");
		expect(state.items.map(item => item.status)).toEqual(["error", "error"]);
		expect(state.text).toBe("Trying.\n\nPartial");
		expect(state.finalText).toBe("Partial");

		const duplicateTerminal = reduceChatTurn(state, { type: "chat_done", id: ID } as any);
		expect(duplicateTerminal).toBe(state);
	});
});
