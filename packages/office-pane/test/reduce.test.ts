import { describe, expect, it } from "bun:test";
import type { ChatDeltaMsg, ChatDoneMsg, ChatErrorMsg } from "../src/core/protocol/messages";
import { initTurn, reduceChatTurn } from "../src/core/protocol/reduce";

const ID = "c-1";

function delta(seq: number, text: string): ChatDeltaMsg {
	return { type: "chat_delta", id: ID, itemId: "a1", seq, delta: text };
}

function done(refs?: ChatDoneMsg["references"]): ChatDoneMsg {
	return { type: "chat_done", id: ID, references: refs };
}

function error(reason: ChatErrorMsg["reason"]): ChatErrorMsg {
	return { type: "chat_error", id: ID, reason };
}

describe("reduceChatTurn — in-order deltas + done", () => {
	it("accumulates text and transitions to done", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, delta(0, "Hel"));
		state = reduceChatTurn(state, delta(1, "lo"));
		state = reduceChatTurn(state, done());
		expect(state.text).toBe("Hello");
		expect(state.status).toBe("done");
		expect(state.references).toEqual([]);
	});

	it("captures references from chat_done", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, delta(0, "x"));
		state = reduceChatTurn(state, done([{ kind: "doc", title: "HTTP LB", url: "https://docs.example.com" }]));
		expect(state.references).toHaveLength(1);
		expect(state.references[0]?.title).toBe("HTTP LB");
	});
});

describe("reduceChatTurn — chat_error", () => {
	it("sets status error and captures reason", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, error("session-busy"));
		expect(state.status).toBe("error");
		expect(state.reason).toBe("session-busy");
		expect("error" in state).toBe(false);
	});

	it("ignores messages after terminal status", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, error("no-worker"));
		const after = reduceChatTurn(state, delta(0, "ignored"));
		expect(after).toBe(state); // same reference — no mutation
	});
});

describe("reduceChatTurn — out-of-order deltas ordered by seq", () => {
	it("buffers seq:1 until seq:0 arrives then flushes in order", () => {
		let state = initTurn(ID);
		// seq 1 arrives before seq 0
		state = reduceChatTurn(state, delta(1, "lo"));
		expect(state.text).toBe(""); // seq 0 not yet seen — still buffered
		expect(state.items[0]?.lastSeq).toBe(-1);
		// seq 0 arrives — both should flush in order
		state = reduceChatTurn(state, delta(0, "Hel"));
		expect(state.text).toBe("Hello");
		expect(state.items[0]?.lastSeq).toBe(1);
		state = reduceChatTurn(state, done());
		expect(state.status).toBe("done");
	});

	it("ignores messages for a different turn id", () => {
		const state = initTurn(ID);
		const other = reduceChatTurn(state, {
			type: "chat_delta",
			id: "c-other",
			itemId: "a1",
			seq: 0,
			delta: "x",
		});
		expect(other).toBe(state);
	});
});

describe("reduceChatTurn — pending flush + clear on terminal close", () => {
	// Test A: gapped pending deltas cannot be recovered — they are discarded and pending is cleared.
	it("drops gapped pending deltas and clears pending on chat_done (Test A)", () => {
		let state = initTurn(ID);
		// seq 2 arrives but seq 0 and 1 never arrive — contiguous flush from lastSeq+1=0 stops immediately
		state = reduceChatTurn(state, delta(2, "orphan"));
		expect(state.text).toBe("");
		expect(Object.keys(state.items[0]?.pending ?? {})).toHaveLength(1);
		// chat_done: contiguous flush starts at seq 0 which is absent → no flushing;
		// seq 2 in pending is discarded (missing data cannot be invented).
		state = reduceChatTurn(state, done());
		expect(state.status).toBe("done");
		expect(state.text).toBe("");
		expect(state.items[0]?.pending).toEqual({});
	});

	it("drops gapped pending deltas and clears pending on chat_error (Test A — error variant)", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, delta(3, "orphan"));
		expect(Object.keys(state.items[0]?.pending ?? {})).toHaveLength(1);
		state = reduceChatTurn(state, error("no-worker"));
		expect(state.status).toBe("error");
		expect(state.text).toBe("");
		expect(state.items[0]?.pending).toEqual({});
	});

	// Test B: contiguous heads always flush on delta arrival, so by the time chat_done arrives
	// pending is already empty — the done-flush is a no-op in this case.
	it("done-flush is a no-op when all gaps filled before close (Test B)", () => {
		let state = initTurn(ID);
		state = reduceChatTurn(state, delta(0, "A")); // flushes → text='A', lastSeq=0, pending={}
		state = reduceChatTurn(state, delta(2, "C")); // gap at 1 → buffered, pending={2:'C'}
		state = reduceChatTurn(state, delta(1, "B")); // fills gap → flushes 1 then 2 → text='ABC', pending={}
		// Pending is already empty; the flush in chat_done is a no-op.
		expect(state.text).toBe("ABC");
		expect(state.items[0]?.pending).toEqual({});
		state = reduceChatTurn(state, done());
		expect(state.status).toBe("done");
		expect(state.text).toBe("ABC");
		expect(state.items[0]?.pending).toEqual({});
	});
});
