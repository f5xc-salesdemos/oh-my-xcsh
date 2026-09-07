import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import { _resetSettingsForTest, Settings } from "../../../src/config/settings";
import { EventController } from "../../../src/modes/controllers/event-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		_resetSettingsForTest();
	});

	it("registers UI event handling as the turn settlement boundary", () => {
		const unsubscribe = vi.fn();
		const subscribe = vi.fn((_listener: unknown, _options?: unknown) => unsubscribe);
		const context = {
			session: { subscribe },
		} as unknown as InteractiveModeContext;
		const controller = new EventController(context);

		controller.subscribeToAgent();

		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(subscribe.mock.calls[0]?.[1]).toEqual({ waitForTurnSettlement: true });
		expect(context.unsubscribe).toBe(unsubscribe);
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn();
		const context = {
			isInitialized: true,
			isBackgrounded: false,
			loadingAnimation: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map<string, unknown>(),
			flushPendingModelSwitch: async () => {},
			ui: { requestRender: vi.fn() },
			chatContainer: { removeChild: vi.fn() },
			statusContainer: { clear: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			editor: { getText: () => "" },
			sessionManager: { getSessionName: () => undefined },
			session: {
				isCompacting: false,
				isStreaming: false,
				runIdleCompaction,
				agent: { state: { messages: [createAssistantMessage()] } },
			},
		} as unknown as InteractiveModeContext;

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("renders the normalized phase without provider or tool payloads", async () => {
		const setTurnPhase = vi.fn();
		const context = {
			isInitialized: true,
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn(), setTurnPhase },
			updateEditorTopBorder: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new EventController(context);

		await controller.handleEvent({ type: "turn_phase", phase: "tool_call", turnId: 4 });

		expect(setTurnPhase).toHaveBeenCalledWith("tool_call");
		expect(JSON.stringify(setTurnPhase.mock.calls)).not.toContain("toolCallId");
	});

	it("restores the working indicator after commentary completes", async () => {
		const message = createAssistantMessage();
		message.content = [{ type: "text", text: "Checking.", phase: "commentary" }];
		const setThinkingMode = vi.fn();
		const context = {
			isInitialized: true,
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: message,
			streamingAssistantGutter: { setThinkingMode },
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new EventController(context);

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "Checking.",
				phase: "commentary",
				partial: message,
			},
		});

		expect(setThinkingMode).toHaveBeenCalledTimes(1);
	});
});
