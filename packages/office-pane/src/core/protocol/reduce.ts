/** Pure reducer for the ordered assistant-item chat stream. */

import type { AssistantMessagePhase } from "@f5-sales-demo/xcsh/browser/chat-protocol";
import type { ChatRefWire, ChatStreamMsg } from "./messages";
import type { ChatErrorReason } from "./reasons";

export interface AssistantTurnItem {
	readonly id: string;
	readonly phase: AssistantMessagePhase;
	readonly text: string;
	readonly status: "streaming" | "done" | "error";
	readonly lastSeq: number;
	readonly pending: Readonly<Record<number, string>>;
}

export interface TurnState {
	readonly id: string;
	readonly items: readonly AssistantTurnItem[];
	/** Aggregate transcript text, including commentary, for the existing presentation. */
	readonly text: string;
	/** Speakable/terminal text only. */
	readonly finalText: string;
	readonly status: "streaming" | "done" | "error";
	readonly references: readonly ChatRefWire[];
	readonly reason?: ChatErrorReason;
}

export function initTurn(id: string): TurnState {
	return { id, items: [], text: "", finalText: "", status: "streaming", references: [] };
}

function aggregate(items: readonly AssistantTurnItem[]): Pick<TurnState, "text" | "finalText"> {
	const visible = items.map(item => item.text).filter(Boolean);
	const final = items
		.filter(item => item.phase === "final_answer")
		.map(item => item.text)
		.filter(Boolean);
	return { text: visible.join("\n\n"), finalText: final.join("\n") };
}

function updateItem(
	state: TurnState,
	itemId: string,
	update: (item: AssistantTurnItem) => AssistantTurnItem,
	phase: AssistantMessagePhase = "final_answer",
): TurnState {
	let found = false;
	const items = state.items.map(item => {
		if (item.id !== itemId) return item;
		found = true;
		return update(item);
	});
	if (!found) {
		items.push(update({ id: itemId, phase, text: "", status: "streaming", lastSeq: -1, pending: {} }));
	}
	return { ...state, items, ...aggregate(items) };
}

/** Fold one inbound stream event into turn state. Idempotent after terminal. */
export function reduceChatTurn(state: TurnState, msg: ChatStreamMsg): TurnState {
	if (msg.id !== state.id) return state;
	if (state.status !== "streaming") return state;

	if (msg.type === "chat_message_start") {
		return updateItem(state, msg.itemId, item => ({ ...item, phase: msg.phase }), msg.phase);
	}

	if (msg.type === "chat_delta") {
		return updateItem(state, msg.itemId, item => {
			if (msg.seq <= item.lastSeq || Object.hasOwn(item.pending, msg.seq)) return item;
			const merged: Record<number, string> = { ...item.pending, [msg.seq]: msg.delta };
			let text = item.text;
			let lastSeq = item.lastSeq;
			while (Object.hasOwn(merged, lastSeq + 1)) {
				text += merged[lastSeq + 1];
				delete merged[lastSeq + 1];
				lastSeq++;
			}
			return { ...item, text, lastSeq, pending: merged };
		});
	}

	if (msg.type === "chat_message_end") {
		return updateItem(
			state,
			msg.itemId,
			item => ({ ...item, phase: msg.phase, status: "done", pending: {} }),
			msg.phase,
		);
	}

	if (msg.type === "chat_done") {
		const items = state.items.map(item => ({ ...item, status: "done" as const, pending: {} }));
		return { ...state, items, ...aggregate(items), status: "done", references: msg.references ?? [] };
	}

	const items = state.items.map(item => ({ ...item, status: "error" as const, pending: {} }));
	return { ...state, items, ...aggregate(items), status: "error", reason: msg.reason };
}
