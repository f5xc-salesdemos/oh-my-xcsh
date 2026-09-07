import { describe, expect, it } from "bun:test";
import type { ChatInbound } from "../src/core/transport/index";
import { MockTransport } from "../src/core/transport/mock";

describe("MockTransport", () => {
	it("(1) subscriber receives emitted chat_delta then chat_done in order", async () => {
		const t = new MockTransport();
		await t.connect();

		const received: ChatInbound[] = [];
		t.onMessage(m => received.push(m));

		const delta = { type: "chat_delta" as const, id: "x", itemId: "a1", seq: 0, delta: "hello" };
		const done = { type: "chat_done" as const, id: "x" };
		t.emit(delta);
		t.emit(done);

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual(delta);
		expect(received[1]).toEqual(done);
	});

	it("(2) send() records into sent", () => {
		const t = new MockTransport();
		const req = { type: "chat_request" as const, id: "r1", text: "hi", context: null, mode: "educational" as const };
		t.send(req);
		expect(t.sent).toHaveLength(1);
		expect(t.sent[0]).toEqual(req);
	});

	it("(3) unsubscribe stops delivery", () => {
		const t = new MockTransport();
		const received: ChatInbound[] = [];
		const unsub = t.onMessage(m => received.push(m));

		const delta1 = { type: "chat_delta" as const, id: "x", itemId: "a1", seq: 0, delta: "a" };
		t.emit(delta1);
		expect(received).toHaveLength(1);

		unsub();

		const delta2 = { type: "chat_delta" as const, id: "x", itemId: "a1", seq: 1, delta: "b" };
		t.emit(delta2);
		expect(received).toHaveLength(1); // no new message after unsub
	});

	it('(4) dispose() sets state "closed" and stops delivery', () => {
		const t = new MockTransport();
		const received: ChatInbound[] = [];
		t.onMessage(m => received.push(m));

		t.dispose();
		expect(t.state).toBe("closed");

		const delta = { type: "chat_delta" as const, id: "x", itemId: "a1", seq: 0, delta: "z" };
		t.emit(delta);
		expect(received).toHaveLength(0);
	});

	it("(5) two subscribers both receive an emit", () => {
		const t = new MockTransport();
		const a: ChatInbound[] = [];
		const b: ChatInbound[] = [];
		t.onMessage(m => a.push(m));
		t.onMessage(m => b.push(m));

		const done = { type: "chat_done" as const, id: "y" };
		t.emit(done);

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0]).toEqual(done);
		expect(b[0]).toEqual(done);
	});
});
