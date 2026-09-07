import { expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ChatRequestMsg, MockTransport, type Transport } from "../src/core";
import { useChatSession } from "../src/panel/useChatSession";

test("send emits a chat_request with a c- id and the text", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("hi");
	});

	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	expect(reqs).toHaveLength(1);
	const req = reqs[0];
	if (!req) throw new Error("expected chat_request in mock.sent");
	expect(req.id).toMatch(/^c-/);
	expect(req.text).toBe("hi");
});

test("onConnected fires exactly once after the transport connects", async () => {
	const mock = new MockTransport();
	let count = 0;
	await act(async () => {
		renderHook(() =>
			useChatSession(mock, {
				onConnected: () => {
					count += 1;
				},
			}),
		);
		await new Promise(r => setTimeout(r, 0));
	});
	expect(count).toBe(1);
});

test("with no provision, provisioning settles to 'ready' after connect (chat enabled)", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => {
		expect(result.current.provisioning).toBe("ready");
	});
	expect(result.current.provisionError).toBeUndefined();
});

test("provision() runs BEFORE onConnected, and only then does provisioning become 'ready'", async () => {
	const mock = new MockTransport();
	const order: string[] = [];
	let resolveProvision: () => void = () => {};
	const provision = () =>
		new Promise<void>(r => {
			order.push("provision");
			resolveProvision = r;
		});
	const { result } = renderHook(() =>
		useChatSession(mock, { provision, onConnected: () => order.push("onConnected") }),
	);

	// While provision is pending, chat is gated and host tools are NOT advertised.
	await waitFor(() => {
		expect(result.current.provisioning).toBe("configuring");
	});
	expect(order).toEqual(["provision"]);

	// Resolving the ack advances to ready and fires onConnected exactly once, after provision.
	await act(async () => {
		resolveProvision();
		await new Promise(r => setTimeout(r, 0));
	});
	await waitFor(() => {
		expect(result.current.provisioning).toBe("ready");
	});
	expect(order).toEqual(["provision", "onConnected"]);
});

test("a rejected provision surfaces provisioning='error' + provisionError and does NOT advertise host tools", async () => {
	const mock = new MockTransport();
	let advertised = false;
	const provision = () => Promise.reject(new Error("configure_error: bad token"));
	const { result } = renderHook(() =>
		useChatSession(mock, {
			provision,
			onConnected: () => {
				advertised = true;
			},
		}),
	);

	await waitFor(() => {
		expect(result.current.provisioning).toBe("error");
	});
	expect(result.current.provisionError).toMatch(/provider configuration failed/i);
	expect(advertised).toBe(false);
});

test("a reason-only chat_error surfaces fixed status without raw provider text", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("hi");
	});
	const req = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0];
	if (!req) throw new Error("expected chat_request in mock.sent");

	await act(async () => {
		mock.emit({ type: "chat_error", id: req.id, reason: "provider-5xx" });
	});

	expect(result.current.status).toBe("error");
	expect(result.current.reason).toBe("provider-5xx");
});

test("streaming deltas + chat_done accumulates text and sets status done", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("hi");
	});

	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	expect(reqs).toHaveLength(1);
	const sentReq = reqs[0];
	if (!sentReq) throw new Error("expected chat_request in mock.sent");
	const { id } = sentReq;

	await act(async () => {
		mock.emit({ type: "chat_delta", id, itemId: "a1", seq: 0, delta: "Hel" });
		mock.emit({ type: "chat_delta", id, itemId: "a1", seq: 1, delta: "lo" });
		mock.emit({ type: "chat_done", id });
	});

	expect(result.current.status).toBe("done");
	const assistantTurn = result.current.turns.find(t => t.kind === "assistant");
	expect(assistantTurn).toBeDefined();
	if (assistantTurn?.kind === "assistant") {
		expect(assistantTurn.state.text).toBe("Hello");
	}
});

test("each chat_request carries a history_hint; newChat bumps it (engine resets history) and clears the transcript", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("first");
	});
	const req1 = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0];
	if (!req1) throw new Error("expected chat_request");
	expect(req1.history_hint).toBeTruthy();
	expect(result.current.turns.length).toBeGreaterThan(0);

	// New chat: transcript clears immediately.
	await act(async () => {
		result.current.newChat();
	});
	expect(result.current.turns).toHaveLength(0);

	// The next turn carries a DIFFERENT history_hint, so the engine resets context.
	await act(async () => {
		result.current.send("second");
	});
	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	const req2 = reqs[reqs.length - 1];
	if (!req2) throw new Error("expected second chat_request");
	expect(req2.history_hint).toBeTruthy();
	expect(req2.history_hint).not.toBe(req1.history_hint);
});

test("newChat aborts the in-flight turn (chat_stop) so a wedged turn can't survive the reset", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("do a slow thing");
	});
	const req = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0];
	if (!req) throw new Error("expected chat_request");
	// The turn is still streaming (no chat_done). newChat must abort it on the server.
	await act(async () => {
		result.current.newChat();
	});
	const stops = mock.sent.filter(m => m.type === "chat_stop");
	expect(stops).toHaveLength(1);
	expect((stops[0] as { id: string }).id).toBe(req.id);
	expect(result.current.turns).toHaveLength(0);
});

test("within one conversation, successive turns reuse the SAME history_hint", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await act(async () => {
		result.current.send("a");
	});
	// settle the first turn so the second isn't queued at the engine (client-side send still emits)
	const first = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0];
	if (!first) throw new Error("expected chat_request");
	await act(async () => {
		mock.emit({ type: "chat_done", id: first.id });
		result.current.send("b");
	});
	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	expect(reqs[0].history_hint).toBe(reqs[reqs.length - 1].history_hint);
});

test("chat_tool_notice folds live tool activity onto the active assistant turn", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("summarize the workbook");
	});
	const id = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0]?.id;
	if (!id) throw new Error("expected chat_request in mock.sent");

	// Tool starts → a running activity appears on the turn.
	await act(async () => {
		mock.emit({ type: "chat_tool_notice", id, tool: "get_workbook_info", ok: true, detail: "…: running…" });
	});
	let turn = result.current.turns.find(t => t.kind === "assistant");
	if (turn?.kind !== "assistant") throw new Error("no assistant turn");
	expect(turn.activities).toEqual([{ tool: "get_workbook_info", running: true, ok: true }]);

	// Tool ends → it settles; the next tool starts running.
	await act(async () => {
		mock.emit({ type: "chat_tool_notice", id, tool: "get_workbook_info", ok: true, detail: "…: done" });
		mock.emit({ type: "chat_tool_notice", id, tool: "read_range", ok: true, detail: "…: running…" });
	});
	turn = result.current.turns.find(t => t.kind === "assistant");
	if (turn?.kind !== "assistant") throw new Error("no assistant turn");
	expect(turn.activities).toEqual([
		{ tool: "get_workbook_info", running: false, ok: true },
		{ tool: "read_range", running: true, ok: true },
	]);

	// chat_done settles any still-running activity (no eternal spinner).
	await act(async () => {
		mock.emit({ type: "chat_delta", id, itemId: "a1", seq: 0, delta: "Done." });
		mock.emit({ type: "chat_done", id });
	});
	turn = result.current.turns.find(t => t.kind === "assistant");
	if (turn?.kind !== "assistant") throw new Error("no assistant turn");
	expect(turn.activities.every(a => !a.running)).toBe(true);
	expect(turn.state.text).toBe("Done.");
});

test("a failing chat_tool_notice end marks the activity not-ok", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await act(async () => {
		result.current.send("write it");
	});
	const id = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request")[0]?.id;
	if (!id) throw new Error("expected chat_request in mock.sent");

	await act(async () => {
		mock.emit({ type: "chat_tool_notice", id, tool: "write_range", ok: true, detail: "…: running…" });
		mock.emit({ type: "chat_tool_notice", id, tool: "write_range", ok: false, detail: "…: failed" });
	});
	const turn = result.current.turns.find(t => t.kind === "assistant");
	if (turn?.kind !== "assistant") throw new Error("no assistant turn");
	expect(turn.activities).toEqual([{ tool: "write_range", running: false, ok: false }]);
});

test("send() on a throwing (closed) transport surfaces an error turn — no perpetual spinner", async () => {
	// A transport whose connect() resolves but send() throws (state 'closed').
	const closedTransport: Transport = {
		state: "closed",
		connect: () => Promise.resolve(),
		send: () => {
			throw new Error("Cannot send in state 'closed'");
		},
		onMessage: () => () => {},
		stop: () => {},
		dispose: () => {},
	};

	const { result } = renderHook(() => useChatSession(closedTransport));

	await act(async () => {
		result.current.send("hi");
	});

	// The optimistic assistant turn is folded into a terminal error (never a
	// perpetual 'streaming' turn), reported as bridge-disconnected.
	expect(result.current.status).toBe("error");
	expect(result.current.reason).toBe("bridge-disconnected");
	const assistant = result.current.turns.find(t => t.kind === "assistant");
	expect(assistant?.kind === "assistant" && assistant.state.status).toBe("error");
});

test("connect() rejection surfaces status=error and reason=bridge-disconnected", async () => {
	// Minimal transport stub whose connect() always rejects.
	const failingTransport: Transport = {
		state: "idle",
		connect: () => Promise.reject(new Error("boom")),
		send: () => {},
		onMessage: () => () => {},
		stop: () => {},
		dispose: () => {},
	};

	const { result } = renderHook(() => useChatSession(failingTransport));

	await waitFor(() => {
		expect(result.current.status).toBe("error");
	});
	expect(result.current.reason).toBe("bridge-disconnected");
});

test("send with images places them on the chat_request; a text-only send omits the field", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));

	await act(async () => {
		result.current.send("describe", { images: [{ data: "QUJD", mimeType: "image/png" }] });
	});
	await act(async () => {
		result.current.send("no images here");
	});

	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	expect(reqs).toHaveLength(2);
	expect(reqs[0].images).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
	// A text-only turn stays a clean frame — no empty images array.
	expect(reqs[1].images).toBeUndefined();
});

test("requests list_skills on connect and exposes the skills reply", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	// Let connect → provision (none) → ready run, which sends list_skills.
	await act(async () => {
		await new Promise(r => setTimeout(r, 0));
	});
	expect(mock.sent.some(m => m.type === "list_skills")).toBe(true);
	expect(result.current.skills).toEqual([]);

	// The engine replies with its loaded skills → they surface on the hook.
	await act(async () => {
		mock.emit({ type: "skills", skills: [{ name: "competitive", description: "battlecards" }] } as never);
	});
	expect(result.current.skills).toEqual([{ name: "competitive", description: "battlecards" }]);
});

test("requests available models and switches through the configured engine callback", async () => {
	const mock = new MockTransport();
	const selected: string[] = [];
	const { result } = renderHook(() =>
		useChatSession(mock, {
			selectModel: async id => {
				selected.push(id);
				return id;
			},
		}),
	);
	await act(async () => {
		await new Promise(r => setTimeout(r, 0));
	});
	expect(mock.sent.some(message => message.type === "list_models")).toBe(true);

	await act(async () => {
		mock.emit({
			type: "models",
			current: "gpt-5.6-sol",
			models: [
				{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
				{ id: "claude-opus-5", label: "Claude Opus 5" },
			],
		} as never);
	});
	expect(result.current.model).toBe("gpt-5.6-sol");
	expect(result.current.models).toHaveLength(2);

	await act(async () => {
		await result.current.selectModel("claude-opus-5");
	});
	expect(selected).toEqual(["claude-opus-5"]);
	expect(result.current.model).toBe("claude-opus-5");
});

test("pickPath sends a pick_path frame and resolves with the path_picked reply", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await act(async () => {
		await new Promise(r => setTimeout(r, 0));
	});
	let resolved: { path?: string } = {};
	await act(async () => {
		const p = result.current.pickPath("folder");
		mock.emit({ type: "path_picked", path: "/Users/me/ctx" } as never);
		resolved = await p;
	});
	expect(mock.sent.some(m => m.type === "pick_path" && (m as { mode?: string }).mode === "folder")).toBe(true);
	expect(resolved.path).toBe("/Users/me/ctx");
});

test("send({webSearch}) sets web_search on the chat_request; omitted otherwise", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await act(async () => {
		result.current.send("news?", { webSearch: true });
	});
	await act(async () => {
		result.current.send("plain");
	});
	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	expect(reqs[0].web_search).toBe(true);
	expect(reqs[1].web_search).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Session-local chat history (read-back only)
// ---------------------------------------------------------------------------

/** Send `text` and settle the turn so it looks like a completed exchange. */
async function completeTurn(mock: MockTransport, send: (t: string) => void, text: string): Promise<void> {
	await act(async () => {
		send(text);
	});
	const reqs = mock.sent.filter((m): m is ChatRequestMsg => m.type === "chat_request");
	const req = reqs[reqs.length - 1];
	if (!req) throw new Error("expected chat_request");
	await act(async () => {
		mock.emit({ type: "chat_delta", id: req.id, itemId: "a1", seq: 0, delta: "ok" });
		mock.emit({ type: "chat_done", id: req.id });
	});
}

test("history starts empty and nothing is being viewed", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));
	expect(result.current.history).toEqual([]);
	expect(result.current.viewingId).toBeNull();
});

test("newChat archives the outgoing conversation, titled from its first user turn", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await completeTurn(mock, result.current.send, "explain this pivot table");
	await act(async () => {
		result.current.send("and the second question");
	});

	await act(async () => {
		result.current.newChat();
	});

	// The live transcript is clear and the conversation moved into history intact.
	expect(result.current.turns).toEqual([]);
	expect(result.current.history).toHaveLength(1);
	expect(result.current.history[0].title).toBe("explain this pivot table");
	expect(result.current.history[0].turns.filter(t => t.kind === "user")).toHaveLength(2);
});

test("newChat on an empty transcript archives nothing (no blank history entries)", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await act(async () => {
		result.current.newChat();
		result.current.newChat();
	});
	expect(result.current.history).toEqual([]);
});

test("a long first prompt is truncated into the history title", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	const long = `summarize ${"the quarterly revenue figures ".repeat(6)}`;
	await completeTurn(mock, result.current.send, long);
	await act(async () => {
		result.current.newChat();
	});

	const title = result.current.history[0].title;
	expect(title.length).toBeLessThanOrEqual(48);
	expect(title.endsWith("…")).toBe(true);
	expect(long.startsWith(title.slice(0, -1))).toBe(true);
});

test("newest chats come first in history", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await completeTurn(mock, result.current.send, "first chat");
	await act(async () => {
		result.current.newChat();
	});
	await completeTurn(mock, result.current.send, "second chat");
	await act(async () => {
		result.current.newChat();
	});

	expect(result.current.history.map(h => h.title)).toEqual(["second chat", "first chat"]);
});

test("viewHistory shows the archived turns; exitHistory restores the live ones", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await completeTurn(mock, result.current.send, "the archived question");
	await act(async () => {
		result.current.newChat();
	});
	await completeTurn(mock, result.current.send, "the live question");

	const archivedId = result.current.history[0].id;
	await act(async () => {
		result.current.viewHistory(archivedId);
	});
	expect(result.current.viewingId).toBe(archivedId);
	expect(result.current.turns.some(t => t.kind === "user" && t.text === "the archived question")).toBe(true);
	expect(result.current.turns.some(t => t.kind === "user" && t.text === "the live question")).toBe(false);

	// Exiting restores the live conversation — reading an archive never destroys it.
	await act(async () => {
		result.current.exitHistory();
	});
	expect(result.current.viewingId).toBeNull();
	expect(result.current.turns.some(t => t.kind === "user" && t.text === "the live question")).toBe(true);
});

test("send() HARD-REFUSES while viewing history (the engine no longer holds that context)", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await completeTurn(mock, result.current.send, "archived");
	await act(async () => {
		result.current.newChat();
	});
	const archivedId = result.current.history[0].id;
	await act(async () => {
		result.current.viewHistory(archivedId);
	});

	const before = mock.sent.filter(m => m.type === "chat_request").length;
	await act(async () => {
		result.current.send("a follow-up in the restored chat");
		result.current.retry();
	});

	// Nothing was sent and no optimistic turn was appended: answering here would
	// silently reply WITHOUT the conversation the user is reading.
	expect(mock.sent.filter(m => m.type === "chat_request")).toHaveLength(before);
	expect(result.current.turns.some(t => t.kind === "user" && t.text.includes("follow-up"))).toBe(false);
});

test("newChat while viewing history exits the archive and banks the LIVE conversation", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await completeTurn(mock, result.current.send, "chat one");
	await act(async () => {
		result.current.newChat();
	});
	await completeTurn(mock, result.current.send, "chat two");
	await act(async () => {
		result.current.viewHistory(result.current.history[0].id);
	});

	await act(async () => {
		result.current.newChat();
	});

	expect(result.current.viewingId).toBeNull();
	expect(result.current.turns).toEqual([]);
	// "chat two" (the live one) was archived — not the snapshot being viewed.
	expect(result.current.history.map(h => h.title)).toEqual(["chat two", "chat one"]);
});

test("a chat banked MID-STREAM reads back settled, keeping the text that had arrived", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await act(async () => {
		result.current.send("a question mid-flight");
	});
	const req = mock.sent.find((m): m is ChatRequestMsg => m.type === "chat_request");
	if (!req) throw new Error("expected chat_request");
	await act(async () => {
		mock.emit({ type: "chat_delta", id: req.id, itemId: "a1", seq: 0, delta: "a partial answer" });
		mock.emit({ type: "chat_tool_notice", id: req.id, tool: "read_range", phase: "start" } as never);
	});
	expect(result.current.status).toBe("streaming");

	// New chat while streaming is the wedge-recovery path: it chat_stops the turn and
	// banks the conversation. The terminal frame lands after the bank and can never
	// reach the (immutable) snapshot, so newChat must settle it on the way in.
	await act(async () => {
		result.current.newChat();
	});
	await act(async () => {
		mock.emit({ type: "chat_done", id: req.id });
	});

	await act(async () => {
		result.current.viewHistory(result.current.history[0].id);
	});

	// Never a perpetual "Thinking…" in a read-only archive.
	expect(result.current.status).not.toBe("streaming");
	// The text the user actually saw is preserved (mirrors pressing Stop, which
	// settles to done with whatever arrived — an error state would DISCARD it).
	const assistant = result.current.turns.find(t => t.kind === "assistant");
	if (!assistant || assistant.kind !== "assistant") throw new Error("expected an archived assistant turn");
	expect(assistant.state.status).toBe("done");
	expect(assistant.state.text).toBe("a partial answer");
	// And no tool row is left spinning.
	expect(assistant.activities.some(a => a.running)).toBe(false);
});

test("a chat banked before the first token reads back as a terminal message, not an empty bubble", async () => {
	const mock = new MockTransport();
	const { result } = renderHook(() => useChatSession(mock));
	await waitFor(() => expect(result.current.provisioning).toBe("ready"));

	await act(async () => {
		result.current.send("stopped before any answer");
	});
	await act(async () => {
		result.current.newChat();
	});
	await act(async () => {
		result.current.viewHistory(result.current.history[0].id);
	});

	expect(result.current.status).not.toBe("streaming");
	const assistant = result.current.turns.find(t => t.kind === "assistant");
	if (!assistant || assistant.kind !== "assistant") throw new Error("expected an archived assistant turn");
	// Nothing arrived, so there is no partial answer to preserve: say it was stopped
	// rather than render an empty assistant row.
	expect(assistant.state.status).toBe("done");
	expect(assistant.state.text).toMatch(/stopped/i);
});


test("chat_media fetches chunked assets and attaches browser-safe media to its assistant turn", async () => {
	const mock = new MockTransport();
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = () => "blob:resolved-media";
	URL.revokeObjectURL = () => {};
	try {
		const { result, unmount } = renderHook(() => useChatSession(mock));
		await act(async () => result.current.send("show it"));
		const request = mock.sent.find((message): message is ChatRequestMsg => message.type === "chat_request")!;
		const ref = `blob:sha256:${"a".repeat(64)}`;
		await act(async () => {
			mock.emit({
				type: "chat_media",
				id: request.id,
				media: {
					version: 1,
					id: `media_${"a".repeat(24)}`,
					kind: "image",
					original: { ref, mimeType: "image/png", bytes: 3 },
					provenance: { sourceType: "tool", source: "display_media" },
					playback: { autoplay: false, loop: false, muted: true, fpsCap: 12 },
				},
			});
		});
		await waitFor(() => expect(mock.sent.some(message => message.type === "media_asset_read")).toBe(true));
		const assetRequest = mock.sent.find(message => message.type === "media_asset_read")!;
		if (assetRequest.type !== "media_asset_read") throw new Error("expected media request");
		await act(async () => {
			mock.emit({
				type: "media_asset_chunk",
				requestId: assetRequest.requestId,
				chunk: {
					ref,
					mimeType: "image/png",
					offset: 0,
					nextOffset: 3,
					eof: true,
					bytes: 3,
					data: "aW1n",
				},
			});
		});
		await waitFor(() => {
			const assistant = result.current.turns.find(turn => turn.kind === "assistant");
			expect(assistant?.kind === "assistant" ? assistant.media?.[0]?.src : undefined).toBe("blob:resolved-media");
		});
		unmount();
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	}
});
