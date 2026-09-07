/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `xcsh -p "prompt"` - text output
 * - `xcsh --mode json "prompt"` - JSON event stream
 */
import type { AgentMessage, ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import type { AssistantMessage, ImageContent, Model } from "@f5-sales-demo/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { finalAnswerText } from "../session/final-answer";
import type { SessionHeader } from "../session/session-manager";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
/**
 * The `{"type":"session"}` line that opens a `--mode json` stream, or undefined when the session has
 * no header.
 *
 * `model` and `provider` are added on the wire only. The assistant message events already carried
 * them but the header did not, so an exported transcript could not state which model produced it
 * without walking later events (#2459). `SessionHeader` is the persisted JSONL shape and is
 * deliberately untouched: adding fields there would bump the session version and require a migration
 * for a value already recoverable from the log.
 */
export function buildJsonSessionHeaderLine(
	header: SessionHeader | null,
	model: Model | undefined,
	thinkingLevel?: ThinkingLevel,
): string | undefined {
	if (!header) return undefined;
	const wireHeader = {
		...header,
		model: model?.id ?? null,
		provider: model ? String(model.provider) : null,
		thinking: thinkingLevel ?? null,
	};
	return `${JSON.stringify(wireHeader)}\n`;
}

function isHiddenContextMessage(message: AgentMessage): boolean {
	return (message.role === "custom" || message.role === "hookMessage") && message.display === false;
}

export function buildJsonAgentEventLine(event: AgentSessionEvent): string | undefined {
	if ((event.type === "message_start" || event.type === "message_end") && isHiddenContextMessage(event.message)) {
		return undefined;
	}
	const publicEvent =
		event.type === "agent_end"
			? { ...event, messages: event.messages.filter(message => !isHiddenContextMessage(message)) }
			: event;
	return `${JSON.stringify(publicEvent)}\n`;
}

export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<0 | 1> {
	const { mode, messages = [], initialMessage, initialImages } = options;

	// Emit session header for JSON mode.
	if (mode === "json") {
		const line = buildJsonSessionHeaderLine(session.sessionManager.getHeader(), session.model, session.thinkingLevel);
		if (line) process.stdout.write(line);
	}
	// Set up extensions for print mode (no UI, no command context)
	const extensionRunner = session.extensionRunner;
	if (extensionRunner) {
		extensionRunner.initialize(
			// ExtensionActions
			{
				sendMessage: (message, options) => {
					session.sendCustomMessage(message, options).catch(e => {
						process.stderr.write(`Extension sendMessage failed: ${e instanceof Error ? e.message : String(e)}\n`);
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch(e => {
						process.stderr.write(
							`Extension sendUserMessage failed: ${e instanceof Error ? e.message : String(e)}\n`,
						);
					});
				},
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => session.getAllToolNames(),
				setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
				getCommands: () => [],
				setModel: async model => {
					const key = await session.modelRegistry.getApiKey(model);
					if (!key) return false;
					await session.setModel(model);
					return true;
				},
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => session.sessionManager.getSessionName?.(),
				setSessionName: async (name: string) => {
					session.sessionManager.setSessionName?.(name);
				},
			},
			// ExtensionContextActions
			{
				getModel: () => session.model,
				getSearchDb: () => session.searchDb,
				isIdle: () => !session.isStreaming,
				abort: () => session.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => session.getContextUsage(),
				getSystemPrompt: () => session.systemPrompt,
				compact: async instructionsOrOptions => {
					const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
					const options =
						instructionsOrOptions && typeof instructionsOrOptions === "object"
							? instructionsOrOptions
							: undefined;
					await session.compact(instructions, options);
				},
			},
			// ExtensionCommandContextActions - commands invokable via prompt("/command")
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async options => {
					const success = await session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await session.reload();
				},
				compact: async instructionsOrOptions => {
					const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
					const options =
						instructionsOrOptions && typeof instructionsOrOptions === "object"
							? instructionsOrOptions
							: undefined;
					await session.compact(instructions, options);
				},
			},
			// No UI context
		);
		extensionRunner.onError(err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		});
		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		if (mode === "json") {
			const line = buildJsonAgentEventLine(event);
			if (line) process.stdout.write(line);
		}
	});

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		await session.prompt(initialMessage, { images: initialImages });
	}

	// Send remaining messages
	for (const message of messages) {
		await session.prompt(message);
	}

	const state = session.state;
	const lastMessage = state.messages[state.messages.length - 1];
	const assistantMsg = lastMessage?.role === "assistant" ? (lastMessage as AssistantMessage) : undefined;
	const failed = assistantMsg?.stopReason === "error" || assistantMsg?.stopReason === "aborted";

	// In text mode, output final response or the terminal model error.
	if (mode === "text" && assistantMsg) {
		if (failed) {
			process.stderr.write(`${assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`}\n`);
		} else {
			const text = finalAnswerText(assistantMsg);
			if (text) process.stdout.write(`${text}\n`);
		}
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stdout.write("", err => {
		if (err) reject(err);
		else resolve();
	});
	await promise;

	return failed ? 1 : 0;
}
