import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@f5-sales-demo/pi-agent-core";
import { type AssistantMessage, getBundledModel, type ToolCall } from "@f5-sales-demo/pi-ai";
import { AssistantMessageEventStream } from "@f5-sales-demo/pi-ai/utils/event-stream";
import { Snowflake } from "@f5-sales-demo/pi-utils";
import { ChatHandler } from "../../src/browser/chat-handler";
import type { BridgeServer } from "../../src/browser/extension-bridge";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

/**
 * #2046 A6 — a tool-calling turn driven through the REAL WS `chat_request` path must
 * stream FULLY: the terminal `chat_done` fires exactly once, at TRUE turn completion,
 * NOT on the intermediate `toolUse` assistant `message_end`.
 *
 * Regression guarded: `ChatHandler.#handleSessionEvent` used to send `chat_done` on the
 * first non-error assistant `message_end`. On a tool-calling turn the agent loop emits a
 * `message_end` for the intermediate assistant message with `stopReason === "toolUse"`
 * (it carries a `toolCall` content part) BEFORE the tool runs — so `chat_done` fired
 * early and the `terminalSent` guard then DROPPED every later frame (tool notices, the
 * tool round-trip, and post-tool narration).
 *
 * Everything below the stub model is the real machinery: a real `ChatHandler` + real
 * `AgentSession`, driven through the `chat_request` `onMessage` path (as the WS client
 * would). The stub model narrates, calls the registered `echo` host tool, then — once
 * the injected result flows back — narrates again and completes on `stopReason: "stop"`.
 */

class FakeBridgeServer {
	readonly serveKind = "office" as const;
	readonly clientHost = "excel" as const;
	sent: Array<Record<string, unknown>> = [];
	#onMessage: Array<(m: Record<string, unknown>) => void> = [];
	#onDisconnected: Array<() => void> = [];

	send(payload: unknown): void {
		this.sent.push(payload as Record<string, unknown>);
	}
	onMessage(cb: (m: Record<string, unknown>) => void): void {
		this.#onMessage.push(cb);
	}
	onDisconnected(cb: () => void): void {
		this.#onDisconnected.push(cb);
	}

	// ---- test drivers ----
	emit(msg: Record<string, unknown>): void {
		for (const cb of this.#onMessage) cb(msg);
	}
	ofType(type: string): Array<Record<string, unknown>> {
		return this.sent.filter(frame => frame.type === type);
	}
	/** First index in send-order of a frame of `type`, or -1. */
	indexOf(type: string): number {
		return this.sent.findIndex(frame => frame.type === type);
	}
	/** Index of the first `chat_delta` whose delta equals `delta`, or -1. */
	deltaIndex(delta: string): number {
		return this.sent.findIndex(frame => frame.type === "chat_delta" && frame.delta === delta);
	}
}

const ECHO_DEF = {
	name: "echo",
	description: "Echo back the provided text",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
};

const ECHO_CALL_ID = "call_echo_1";
const ECHO_INPUT = "hello host tool";
const ECHO_OUTPUT = `echoed: ${ECHO_INPUT}`;
const PRE_NARRATION = "Echoing your text now — watch. ";
const POST_NARRATION = "All done, the echo came back.";

function baseAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for condition");
}

describe("#2046 A6 — chat_done defers to the final assistant message on a tool turn", () => {
	let session: AgentSession;
	let handler: ChatHandler;
	let server: FakeBridgeServer;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];
	let callCount: number;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-a6-tool-turn-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		callCount = 0;
	});

	afterEach(async () => {
		handler?.dispose();
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	/**
	 * @param toolTurn when true the first model call narrates then calls `echo`
	 *   (stopReason "toolUse"); the second call narrates then completes ("stop").
	 *   When false a single call narrates then completes ("stop") — a plain turn.
	 */
	async function makeSession(toolTurn: boolean): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const toolCall: ToolCall = {
			type: "toolCall",
			id: ECHO_CALL_ID,
			name: "echo",
			arguments: { text: ECHO_INPUT },
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context) => {
				callCount++;
				const isFirstCall = callCount === 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (toolTurn && isFirstCall) {
						// Turn 1: narrate, then call the registered host tool. The message that
						// ENDS this call carries a toolCall part with stopReason "toolUse".
						stream.push({ type: "start", partial: baseAssistant([], "toolUse") });
						stream.push({
							type: "text_start",
							contentIndex: 0,
							phase: "commentary",
							partial: baseAssistant([{ type: "text", text: "", phase: "commentary" }], "toolUse"),
						});
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: PRE_NARRATION,
							partial: baseAssistant([{ type: "text", text: PRE_NARRATION, phase: "commentary" }], "toolUse"),
						});
						stream.push({
							type: "text_end",
							contentIndex: 0,
							content: PRE_NARRATION,
							phase: "commentary",
							partial: baseAssistant([{ type: "text", text: PRE_NARRATION, phase: "commentary" }], "toolUse"),
						});
						const msg = baseAssistant(
							[{ type: "text", text: PRE_NARRATION, phase: "commentary" }, toolCall],
							"toolUse",
						);
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Final call: narrate the result, then complete on stopReason "stop".
						stream.push({ type: "start", partial: baseAssistant([], "stop") });
						stream.push({
							type: "text_start",
							contentIndex: 0,
							phase: "final_answer",
							partial: baseAssistant([{ type: "text", text: "", phase: "final_answer" }], "stop"),
						});
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: POST_NARRATION,
							partial: baseAssistant([{ type: "text", text: POST_NARRATION, phase: "final_answer" }], "stop"),
						});
						stream.push({
							type: "text_end",
							contentIndex: 0,
							content: POST_NARRATION,
							phase: "final_answer",
							partial: baseAssistant([{ type: "text", text: POST_NARRATION, phase: "final_answer" }], "stop"),
						});
						const msg = baseAssistant([{ type: "text", text: POST_NARRATION, phase: "final_answer" }], "stop");
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	it("streams the whole tool turn and sends exactly one chat_done AFTER the tool + post-tool narration", async () => {
		session = await makeSession(true);
		server = new FakeBridgeServer();
		handler = new ChatHandler(server as unknown as BridgeServer, session);
		handler.attach();

		// Register the echo host tool through the real onMessage path (as a WS client would).
		server.emit({ type: "set_host_tools", tools: [ECHO_DEF] });
		await waitFor(() => server.ofType("set_host_tools_ack").length === 1);
		expect(session.getActiveToolNames()).toContain("echo");

		// Drive the turn through the REAL chat_request path (not session.prompt directly).
		server.emit({
			type: "chat_request",
			id: "c-tool-1",
			text: "please echo something",
			context: null,
			mode: "configuration",
		});

		// The tool executes and round-trips a real host_tool_call frame.
		await waitFor(() => server.ofType("host_tool_call").length === 1);
		const call = server.ofType("host_tool_call")[0];
		expect(call.toolName).toBe("echo");
		// The turn must NOT be terminal yet — chat_done must not have fired on the toolUse step.
		expect(server.ofType("chat_done")).toHaveLength(0);

		// Inject the matching host_tool_result, which lets the turn continue and finish.
		server.emit({
			type: "host_tool_result",
			id: call.id as string,
			result: { content: [{ type: "text", text: ECHO_OUTPUT }] },
		});

		// The turn completes: exactly one terminal chat_done arrives.
		await waitFor(() => server.ofType("chat_done").length === 1);
		expect(server.ofType("chat_done")).toHaveLength(1);
		expect(server.ofType("chat_error")).toHaveLength(0);
		expect(server.ofType("chat_message_start").map(frame => frame.phase)).toEqual(["commentary", "final_answer"]);
		expect(server.ofType("chat_message_end").map(frame => frame.phase)).toEqual(["commentary", "final_answer"]);
		expect(server.ofType("chat_delta").map(frame => frame.itemId)).toEqual([
			server.ofType("chat_message_start")[0]?.itemId,
			server.ofType("chat_message_start")[1]?.itemId,
		]);

		// FRAME ORDER / TIMING — the load-bearing assertions this fix restores:
		const preIdx = server.deltaIndex(PRE_NARRATION);
		const postIdx = server.deltaIndex(POST_NARRATION);
		const toolCallIdx = server.indexOf("host_tool_call");
		const doneIdx = server.indexOf("chat_done");

		// Pre-tool narration streamed before the tool call.
		expect(preIdx).toBeGreaterThanOrEqual(0);
		expect(preIdx).toBeLessThan(toolCallIdx);
		// A tool-activity notice for echo was forwarded (dropped by the old premature-done bug).
		const echoNotices = server.ofType("chat_tool_notice").filter(f => f.tool === "echo");
		expect(echoNotices.length).toBeGreaterThanOrEqual(1);
		// Post-tool narration streamed AFTER the tool call (dropped by the old bug).
		expect(postIdx).toBeGreaterThan(toolCallIdx);
		// The single chat_done is the LAST relevant frame — after the tool AND after post-tool narration.
		expect(doneIdx).toBeGreaterThan(toolCallIdx);
		expect(doneIdx).toBeGreaterThan(postIdx);
		// No frames dropped after the tool step: post narration and done both present.
		expect(server.ofType("chat_delta").some(f => f.delta === POST_NARRATION)).toBe(true);
	});

	it("still sends exactly one chat_done on a plain (no-tool) turn — no regression", async () => {
		session = await makeSession(false);
		server = new FakeBridgeServer();
		handler = new ChatHandler(server as unknown as BridgeServer, session);
		handler.attach();

		server.emit({
			type: "chat_request",
			id: "c-plain-1",
			text: "just say something",
			context: null,
			mode: "configuration",
		});

		await waitFor(() => server.ofType("chat_done").length === 1);
		expect(server.ofType("chat_done")).toHaveLength(1);
		expect(server.ofType("chat_error")).toHaveLength(0);
		expect(server.ofType("host_tool_call")).toHaveLength(0);
		// The narration streamed, and chat_done came after it.
		const deltaIdx = server.deltaIndex(POST_NARRATION);
		expect(deltaIdx).toBeGreaterThanOrEqual(0);
		expect(server.indexOf("chat_done")).toBeGreaterThan(deltaIdx);
	});
});
