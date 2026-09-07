import { describe, expect, test } from "bun:test";

import { CHAT_ERROR_REASONS } from "../src/core";
import { ERROR_MESSAGES, errorText, turnsToMessages } from "../src/panel/adapt";
import type { AssistantTurn, Turn, UserTurn } from "../src/panel/useChatSession";

function user(id: string, text: string): UserTurn {
	return { kind: "user", id, text };
}

function assistant(
	id: string,
	text: string,
	over: Partial<AssistantTurn["state"]> = {},
	activities: AssistantTurn["activities"] = [],
): AssistantTurn {
	return {
		kind: "assistant",
		state: {
			id,
			items: [{ id: `${id}:assistant:0`, phase: "final_answer", text, status: "done", lastSeq: 0, pending: {} }],
			text,
			finalText: text,
			status: "done",
			references: [],
			...over,
		},
		activities,
	};
}

describe("errorText", () => {
	test("maps a classified reason to its human message", () => {
		expect(errorText("provider-5xx")).toBe(ERROR_MESSAGES["provider-5xx"]);
	});

	test("falls back to fixed generic copy when the reason is absent", () => {
		expect(errorText(undefined)).toBe("Something went wrong. Please try again.");
	});

	test("covers every ChatErrorReason (exhaustive map)", () => {
		for (const r of CHAT_ERROR_REASONS) {
			expect(ERROR_MESSAGES[r]).toBeTruthy();
		}
	});
});

describe("turnsToMessages", () => {
	test("maps a user turn to a user row and an assistant turn to an assistant row", () => {
		const turns: Turn[] = [user("u-1", "hello"), assistant("c-1", "hi there")];
		const msgs = turnsToMessages({ turns, status: "done" });
		expect(msgs).toEqual([
			{ id: "u-1", role: "user", text: "hello" },
			{ id: "c-1", role: "assistant", text: "hi there" },
		]);
	});

	test("a streaming assistant turn keeps its partial text and is not an error", () => {
		const turns: Turn[] = [user("u-1", "go"), assistant("c-1", "partia", { status: "streaming" })];
		const msgs = turnsToMessages({ turns, status: "streaming" });
		expect(msgs[1]).toMatchObject({ id: "c-1", role: "assistant", text: "partia" });
		expect(msgs[1].error).toBeUndefined();
	});

	test("a terminal turn error (retryable reason) renders the classified message + retry on the last row", () => {
		const turns: Turn[] = [user("u-1", "do it"), assistant("c-1", "", { status: "error", reason: "provider-5xx" })];
		const msgs = turnsToMessages({ turns, status: "error", reason: "provider-5xx" });
		const last = msgs[msgs.length - 1];
		expect(last.error).toBe(true);
		expect(last.text).toBe(ERROR_MESSAGES["provider-5xx"]);
		expect(last.retryText).toBe("do it");
	});

	test("a connect-level error with no turns appends a synthetic error row (no retry — nothing to resend)", () => {
		const msgs = turnsToMessages({ turns: [], status: "error", reason: "bridge-disconnected" });
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: "assistant", error: true, text: ERROR_MESSAGES["bridge-disconnected"] });
		expect(msgs[0].retryText).toBeUndefined();
	});

	test("a session error after prior turns (retryable reason) appends a synthetic row WITH retry text", () => {
		const turns: Turn[] = [user("u-1", "hi"), assistant("c-1", "answer")];
		const msgs = turnsToMessages({ turns, status: "error", reason: "provider-5xx" });
		expect(msgs).toHaveLength(3);
		const last = msgs[msgs.length - 1];
		expect(last).toMatchObject({ role: "assistant", error: true, text: ERROR_MESSAGES["provider-5xx"] });
		expect(last.retryText).toBe("hi");
	});

	test("a transport-dead error (bridge-disconnected) offers NO retry even with prior turns", () => {
		// Resending on the closed socket would throw and orphan a perpetual
		// 'streaming' turn — so the transcript must not offer Retry here.
		const turns: Turn[] = [
			user("u-1", "hi"),
			assistant("c-1", "", { status: "error", reason: "bridge-disconnected" }),
		];
		const msgs = turnsToMessages({ turns, status: "error", reason: "bridge-disconnected" });
		const last = msgs[msgs.length - 1];
		expect(last.error).toBe(true);
		expect(last.retryText).toBeUndefined();
	});

	test("a transport-dead error (session-disposed) also offers no retry", () => {
		const turns: Turn[] = [user("u-1", "x"), assistant("c-1", "", { status: "error", reason: "session-disposed" })];
		const msgs = turnsToMessages({ turns, status: "error", reason: "session-disposed" });
		expect(msgs[msgs.length - 1].retryText).toBeUndefined();
	});

	test("does not double-append when the last turn already carries the error", () => {
		const turns: Turn[] = [user("u-1", "x"), assistant("c-1", "", { status: "error", reason: "no-worker" })];
		const msgs = turnsToMessages({ turns, status: "error", reason: "no-worker" });
		expect(msgs).toHaveLength(2);
		expect(msgs.filter(m => m.error)).toHaveLength(1);
	});

	test("emits tool-activity rows BEFORE the assistant text of the same turn, in call order", () => {
		const turns: Turn[] = [
			user("u-1", "summarize"),
			assistant("c-1", "Here is the summary.", {}, [
				{ tool: "get_workbook_info", running: false, ok: true },
				{ tool: "read_range", running: false, ok: true },
			]),
		];
		const msgs = turnsToMessages({ turns, status: "done" });
		expect(msgs).toEqual([
			{ id: "u-1", role: "user", text: "summarize" },
			{ id: "c-1-tool-0", role: "tool", text: "", tool: "get_workbook_info", ok: true, running: false },
			{ id: "c-1-tool-1", role: "tool", text: "", tool: "read_range", ok: true, running: false },
			{ id: "c-1", role: "assistant", text: "Here is the summary." },
		]);
	});

	test("a still-running activity on a streaming turn renders a running tool row before the thinking body", () => {
		const turns: Turn[] = [
			user("u-1", "read it"),
			assistant("c-1", "", { status: "streaming" }, [{ tool: "read_table", running: true, ok: true }]),
		];
		const msgs = turnsToMessages({ turns, status: "streaming" });
		expect(msgs[1]).toEqual({
			id: "c-1-tool-0",
			role: "tool",
			text: "",
			tool: "read_table",
			ok: true,
			running: true,
		});
		expect(msgs[2]).toMatchObject({ id: "c-1", role: "assistant", text: "" });
	});

	test("tool rows precede the body so an errored turn still gets its Retry on the last row", () => {
		const turns: Turn[] = [
			user("u-1", "go"),
			assistant("c-1", "", { status: "error", reason: "provider-5xx" }, [
				{ tool: "get_workbook_info", running: false, ok: true },
			]),
		];
		const msgs = turnsToMessages({ turns, status: "error", reason: "provider-5xx" });
		expect(msgs[1]).toMatchObject({ role: "tool", tool: "get_workbook_info" });
		const last = msgs[msgs.length - 1];
		expect(last).toMatchObject({ id: "c-1", role: "assistant", error: true });
		expect(last.retryText).toBe("go");
	});

	test("a done assistant turn carries its cited references onto the row", () => {
		const refs = [
			{ kind: "doc" as const, title: "WAF docs", url: "https://docs.cloud.f5.com/waf" },
			{ kind: "console" as const, title: "HTTP LB", url: "https://example-corp.console.ves.volterra.io/lb" },
		];
		const turns: Turn[] = [user("u-1", "how?"), assistant("c-1", "See the docs.", { references: refs })];
		const msgs = turnsToMessages({ turns, status: "done" });
		expect(msgs[1]).toEqual({ id: "c-1", role: "assistant", text: "See the docs.", references: refs });
	});

	test("a streaming turn does not attach references (they arrive only on chat_done)", () => {
		const turns: Turn[] = [user("u-1", "go"), assistant("c-1", "typing", { status: "streaming" })];
		const msgs = turnsToMessages({ turns, status: "streaming" });
		expect(msgs[1].references).toBeUndefined();
	});

	test("a done turn with no references gets no references field", () => {
		const turns: Turn[] = [user("u-1", "hi"), assistant("c-1", "answer")];
		const msgs = turnsToMessages({ turns, status: "done" });
		expect(msgs[1].references).toBeUndefined();
	});
});
