import { INTENT_FIELD } from "@f5-sales-demo/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@f5-sales-demo/pi-ai";
import { Loader, Spacer, TERMINAL } from "@f5-sales-demo/pi-tui";
import { settings } from "../../config/settings";
import { createMarkdownMediaOptions } from "../../media/markdown-resolver";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import {
	createStreamingAssistantGutter,
	createSystemGutter,
	createToolGutter,
	type GutterBlock,
} from "../../modes/components/gutter-block";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import { ReadGroupOutcomeAggregator } from "../../modes/utils/read-group-outcome-aggregator";
import type { AgentSessionEvent } from "../../session/agent-session";
import { calculatePromptTokens } from "../../session/compaction/compaction";
import type { ExitPlanModeDetails } from "../../tools";

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#lastReadGroupGutter: GutterBlock<ReadToolGroupComponent> | undefined = undefined;
	#lastThinkingCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundToolCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#pendingGutters = new Map<string, GutterBlock<any>>();
	#readGroupAggregator = new ReadGroupOutcomeAggregator();
	// streamingAssistantGutter is stored on ctx for cross-controller access (e.g. thinking toggle)
	constructor(private ctx: InteractiveModeContext) {}

	dispose(): void {
		this.#cancelIdleCompaction();
	}

	#resetReadGroup(): void {
		// Only clear the grouping state so the next reads start a new group.
		// setDone() is handled by #cleanupReadGutter() when each read actually completes,
		// so we never prematurely mark a group as done (e.g. read + edit patterns).
		this.#lastReadGroup = undefined;
		this.#lastReadGroupGutter = undefined;
	}

	#getReadGroup(toolCallId?: string): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			this.ctx.chatContainer.addChild(new Spacer(1));
			const group = new ReadToolGroupComponent();
			group.setExpanded(this.ctx.toolOutputExpanded);
			const gutter = createToolGutter(this.ctx.ui, group);
			this.ctx.chatContainer.addChild(gutter);
			this.#lastReadGroup = group;
			this.#lastReadGroupGutter = gutter;
		}
		// Track the group gutter under each read tool ID so async completion can find it
		if (toolCallId && this.#lastReadGroupGutter) {
			this.#pendingGutters.set(toolCallId, this.#lastReadGroupGutter);
		}
		return this.#lastReadGroup;
	}

	/**
	 * Remove a read tool's gutter entry. Records the caller-supplied outcome
	 * into the group aggregator; finalizes the gutter (calling `setDone` with
	 * the aggregated worst outcome) only when no other reads still share the
	 * same group gutter. The spinner stays active during the group lifetime.
	 */
	#cleanupReadGutter(toolCallId: string, outcome: "success" | "error"): void {
		const gutter = this.#pendingGutters.get(toolCallId);
		this.#pendingGutters.delete(toolCallId);
		if (!gutter) return;
		this.#readGroupAggregator.record(gutter, outcome);
		const stillActive = Array.from(this.#pendingGutters.values()).some(g => g === gutter);
		if (!stillActive) {
			this.#readGroupAggregator.finalize(gutter);
		}
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}
	#updateWorkingMessageFromIntent(intent: string | undefined): void {
		const trimmed = intent?.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed} (esc to interrupt)`);
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(
			async (event: AgentSessionEvent) => {
				await this.handleEvent(event);
			},
			{ waitForTurnSettlement: true },
		);
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();

		switch (event.type) {
			case "turn_phase":
				this.ctx.statusLine.setTurnPhase(event.phase);
				this.ctx.ui.requestRender();
				break;

			case "agent_start":
				this.#lastIntent = undefined;
				this.#readToolCallArgs.clear();
				this.#readToolCallAssistantComponents.clear();
				this.#lastAssistantComponent = undefined;
				if (this.ctx.retryEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
					this.ctx.retryEscapeHandler = undefined;
				}
				if (this.ctx.retryLoader) {
					this.ctx.retryLoader.stop();
					this.ctx.retryLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				this.#cancelIdleCompaction();
				this.ctx.ensureLoadingAnimation();
				this.ctx.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
					if (this.#renderedCustomMessages.has(signature)) {
						break;
					}
					this.#renderedCustomMessages.add(signature);
					this.#resetReadGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "user") {
					const textContent = this.ctx.getUserMessageText(event.message);
					const imageCount =
						typeof event.message.content === "string"
							? 0
							: event.message.content.filter(content => content.type === "image").length;
					const signature = `${textContent}\u0000${imageCount}`;

					this.#resetReadGroup();
					if (this.ctx.optimisticUserMessageSignature !== signature) {
						this.ctx.addMessageToChat(event.message);
					}
					this.ctx.optimisticUserMessageSignature = undefined;

					if (!event.message.synthetic) {
						this.ctx.editor.setText("");
						this.ctx.updatePendingMessagesDisplay();
					}
					this.ctx.ui.requestRender();
				} else if (event.message.role === "fileMention") {
					this.#resetReadGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.#lastThinkingCount = 0;
					this.#resetReadGroup();
					this.ctx.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.ctx.hideThinkingBlock,
						createMarkdownMediaOptions(this.ctx.sessionManager, () => this.ctx.ui.requestRender()),
					);
					this.ctx.streamingMessage = event.message;
					this.ctx.streamingAssistantGutter = createStreamingAssistantGutter(
						this.ctx.ui,
						this.ctx.streamingComponent,
					);
					this.ctx.chatContainer.addChild(this.ctx.streamingAssistantGutter);
					this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
					this.ctx.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.ctx.streamingComponent && event.message.role === "assistant") {
					this.ctx.streamingMessage = event.message;
					this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
					if (
						event.assistantMessageEvent.type === "text_end" &&
						event.assistantMessageEvent.phase === "commentary"
					) {
						this.ctx.streamingAssistantGutter?.setThinkingMode();
					}

					const thinkingCount = this.ctx.streamingMessage.content.filter(
						content => content.type === "thinking" && content.thinking.trim(),
					).length;
					if (thinkingCount > this.#lastThinkingCount) {
						this.#resetReadGroup();
						this.#lastThinkingCount = thinkingCount;
						this.ctx.streamingAssistantGutter?.setThinkingMode();
					}

					for (const content of this.ctx.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						if (content.name === "read") {
							this.#trackReadToolCall(content.id, content.arguments);
							const component = this.ctx.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments, content.id);
							} else {
								const group = this.#getReadGroup(content.id);
								group.updateArgs(content.arguments, content.id);
								this.ctx.pendingTools.set(content.id, group);
							}
							continue;
						}

						// Preserve the raw partial JSON for renderers that need to surface fields before the JSON object closes.
						// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
						const renderArgs =
							"partialJson" in content
								? { ...content.arguments, __partialJson: content.partialJson }
								: content.arguments;
						if (!this.ctx.pendingTools.has(content.id)) {
							if (content.name === "todo_write" && !settings.get("todo.verbose")) {
								continue;
							}
							this.#resetReadGroup();
							this.ctx.chatContainer.addChild(new Spacer(1));
							const tool = this.ctx.session.getToolByName(content.name);
							const component = new ToolExecutionComponent(
								content.name,
								renderArgs,
								{
									showImages: settings.get("terminal.showImages"),
									editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
									editAllowFuzzy: settings.get("edit.fuzzyMatch"),
								},
								tool,
								this.ctx.ui,
								this.ctx.sessionManager.getCwd(),
							);
							component.setExpanded(this.ctx.toolOutputExpanded);
							const gutter = createToolGutter(this.ctx.ui, component);
							this.ctx.chatContainer.addChild(gutter);
							this.ctx.pendingTools.set(content.id, component);
							this.#pendingGutters.set(content.id, gutter);
						} else {
							const component = this.ctx.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(renderArgs, content.id);
							}
						}
					}

					// Update working message with intent from streamed tool arguments
					for (const content of this.ctx.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						const args = content.arguments;
						if (!args || typeof args !== "object" || !(INTENT_FIELD in args)) continue;
						this.#updateWorkingMessageFromIntent(args[INTENT_FIELD] as string | undefined);
					}

					this.ctx.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.ctx.streamingComponent && event.message.role === "assistant") {
					this.ctx.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.ctx.streamingMessage.stopReason === "aborted" && !this.ctx.session.isTtsrAbortPending) {
						const retryAttempt = this.ctx.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.ctx.streamingMessage.errorMessage = errorMessage;
					}
					if (this.ctx.session.isTtsrAbortPending && this.ctx.streamingMessage.stopReason === "aborted") {
						const msgWithoutAbort = { ...this.ctx.streamingMessage, stopReason: "stop" as const };
						this.ctx.streamingComponent.updateContent(msgWithoutAbort);
					} else {
						this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
					}

					if (
						this.ctx.streamingMessage.stopReason !== "aborted" &&
						this.ctx.streamingMessage.stopReason !== "error"
					) {
						for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
							component.setArgsComplete(toolCallId);
						}
					}
					this.#lastAssistantComponent = this.ctx.streamingComponent;
					this.#lastAssistantComponent.setUsageInfo(event.message.usage);
					this.ctx.streamingAssistantGutter?.setDone();
					this.ctx.streamingAssistantGutter = undefined;
					this.ctx.streamingComponent = undefined;
					this.ctx.streamingMessage = undefined;
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
				}
				this.ctx.ui.requestRender();
				break;

			case "tool_execution_start": {
				this.#updateWorkingMessageFromIntent(event.intent);
				if (!this.ctx.pendingTools.has(event.toolCallId)) {
					if (event.toolName === "read") {
						this.#trackReadToolCall(event.toolCallId, event.args);
						const component = this.ctx.pendingTools.get(event.toolCallId);
						if (component) {
							component.updateArgs(event.args, event.toolCallId);
						} else {
							const group = this.#getReadGroup(event.toolCallId);
							group.updateArgs(event.args, event.toolCallId);
							this.ctx.pendingTools.set(event.toolCallId, group);
						}
						this.ctx.ui.requestRender();
						break;
					}

					this.#resetReadGroup();
					if (event.toolName === "todo_write" && !settings.get("todo.verbose")) {
						break;
					}
					const tool = this.ctx.session.getToolByName(event.toolName);
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
						{
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					const gutter = createToolGutter(this.ctx.ui, component);
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(gutter);
					this.ctx.pendingTools.set(event.toolCallId, component);
					this.#pendingGutters.set(event.toolCallId, gutter);
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "tool_execution_update": {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async
						?.state;
					const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
					component.updateResult(
						{ ...event.partialResult, isError: asyncState === "failed" },
						!isFinalAsyncState,
						event.toolCallId,
					);
					if (isFinalAsyncState) {
						// `tool_execution_update` events don't currently carry `isWarning`, but read
						// it defensively so a future async tool returning a warning outcome on
						// successful completion is honored without a second edit here.
						const isWarning = (event as { isWarning?: boolean }).isWarning;
						this.#pendingGutters
							.get(event.toolCallId)
							?.setDone(asyncState === "failed" ? "error" : isWarning ? "warning" : "success");
						this.#pendingGutters.delete(event.toolCallId);
						this.ctx.pendingTools.delete(event.toolCallId);
						this.#backgroundToolCallIds.delete(event.toolCallId);
					}
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				if (event.toolName === "read") {
					if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
						const component = this.ctx.pendingTools.get(event.toolCallId);
						if (component) {
							component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
							this.ctx.pendingTools.delete(event.toolCallId);
						}
						const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
						if (asyncState === "running") {
							this.#backgroundToolCallIds.add(event.toolCallId);
						} else {
							this.#cleanupReadGutter(event.toolCallId, event.isError ? "error" : "success");
							this.#backgroundToolCallIds.delete(event.toolCallId);
							this.#clearReadToolCall(event.toolCallId);
						}
						this.ctx.ui.requestRender();
					} else {
						let component = this.ctx.pendingTools.get(event.toolCallId);
						if (!component) {
							const group = this.#getReadGroup(event.toolCallId);
							const args = this.#readToolCallArgs.get(event.toolCallId);
							if (args) {
								group.updateArgs(args, event.toolCallId);
							}
							component = group;
							this.ctx.pendingTools.set(event.toolCallId, group);
						}
						const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
						const isBackgroundRunning = asyncState === "running";
						component.updateResult(
							{ ...event.result, isError: event.isError },
							isBackgroundRunning,
							event.toolCallId,
						);
						if (isBackgroundRunning) {
							this.#backgroundToolCallIds.add(event.toolCallId);
						} else {
							this.#cleanupReadGutter(event.toolCallId, event.isError ? "error" : "success");
							this.ctx.pendingTools.delete(event.toolCallId);
							this.#backgroundToolCallIds.delete(event.toolCallId);
							this.#clearReadToolCall(event.toolCallId);
						}
						this.ctx.ui.requestRender();
					}
				} else {
					const component = this.ctx.pendingTools.get(event.toolCallId);
					if (component) {
						const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
						const isBackgroundRunning = asyncState === "running";
						component.updateResult(
							{ ...event.result, isError: event.isError },
							isBackgroundRunning,
							event.toolCallId,
						);
						if (isBackgroundRunning) {
							this.#backgroundToolCallIds.add(event.toolCallId);
						} else {
							this.#pendingGutters
								.get(event.toolCallId)
								?.setDone(event.isError ? "error" : event.isWarning ? "warning" : "success");
							this.#pendingGutters.delete(event.toolCallId);
							this.ctx.pendingTools.delete(event.toolCallId);
							this.#backgroundToolCallIds.delete(event.toolCallId);
						}
						this.ctx.ui.requestRender();
					}
				}
				// Update todo display when todo_write tool completes
				if (event.toolName === "todo_write" && !event.isError) {
					const details = event.result.details as { phases?: TodoPhase[] } | undefined;
					if (details?.phases) {
						this.ctx.setTodos(details.phases);
					}
				} else if (event.toolName === "todo_write" && event.isError) {
					const textContent = event.result.content.find(
						(content: { type: string; text?: string }) => content.type === "text",
					)?.text;
					this.ctx.showWarning(
						`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo_write succeeds."}`,
					);
				}
				if (event.toolName === "exit_plan_mode" && !event.isError) {
					const details = event.result.details as ExitPlanModeDetails | undefined;
					if (details) {
						await this.ctx.handleExitPlanModeTool(details);
					}
				}
				break;
			}

			case "agent_end":
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
					this.ctx.statusContainer.clear();
				}
				if (this.ctx.streamingComponent) {
					this.ctx.chatContainer.removeChild(this.ctx.streamingAssistantGutter ?? this.ctx.streamingComponent);
					this.ctx.streamingAssistantGutter?.dispose();
					this.ctx.streamingAssistantGutter = undefined;
					this.ctx.streamingComponent = undefined;
					this.ctx.streamingMessage = undefined;
				}
				await this.ctx.flushPendingModelSwitch();
				// Orphan pending tools at agent_end mean the turn aborted or
				// errored before those tools completed. Mark the gutter as
				// error so the live UI matches what a transcript rebuild
				// renders for the same condition.
				//
				// We deliberately do NOT call `updateResult` here: a tool
				// may have streamed partial output via
				// `tool_execution_update` before aborting, and replacing
				// that content with a synthetic "did not complete" string
				// would discard the most diagnostic output in the exact
				// failure case the user cares about. The error gutter
				// color carries the outcome; the body keeps whatever
				// streamed content it had.
				{
					const orphanGutters = new Set<GutterBlock<any>>();
					for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
						if (this.#backgroundToolCallIds.has(toolCallId)) continue;
						const gutter = this.#pendingGutters.get(toolCallId);
						if (gutter) {
							this.#readGroupAggregator.record(gutter, "error");
							orphanGutters.add(gutter);
						}
						this.#pendingGutters.delete(toolCallId);
						this.ctx.pendingTools.delete(toolCallId);
					}
					for (const gutter of orphanGutters) {
						this.#readGroupAggregator.finalize(gutter);
					}
				}
				this.#backgroundToolCallIds = new Set(
					Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
				);
				this.#resetReadGroup();
				this.#readToolCallArgs.clear();
				this.#readToolCallAssistantComponents.clear();
				this.#lastAssistantComponent = undefined;
				this.ctx.ui.requestRender();
				this.#scheduleIdleCompaction();
				this.sendCompletionNotification(event);
				break;

			case "auto_compaction_start": {
				this.#cancelIdleCompaction();
				this.ctx.autoCompactionEscapeHandler = this.ctx.editor.onEscape;
				this.ctx.editor.onEscape = () => {
					this.ctx.session.abortCompaction();
				};
				this.ctx.statusContainer.clear();
				const reasonText =
					event.reason === "overflow" ? "Context overflow detected, " : event.reason === "idle" ? "Idle " : "";
				const actionLabel = event.action === "handoff" ? "Auto-handoff" : "Auto context-full maintenance";
				this.ctx.autoCompactionLoader = new Loader(
					this.ctx.ui,
					spinner => theme.fg("spinnerAccent", spinner),
					text => theme.fg("muted", text),
					`${reasonText}${actionLabel}… (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
				this.ctx.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				this.#cancelIdleCompaction();
				if (this.ctx.autoCompactionEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
					this.ctx.autoCompactionEscapeHandler = undefined;
				}
				if (this.ctx.autoCompactionLoader) {
					this.ctx.autoCompactionLoader.stop();
					this.ctx.autoCompactionLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				const isHandoffAction = event.action === "handoff";
				if (event.aborted) {
					this.ctx.showStatus(
						isHandoffAction ? "Auto-handoff cancelled" : "Auto context-full maintenance cancelled",
					);
				} else if (event.result) {
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
				} else if (event.errorMessage) {
					this.ctx.showWarning(event.errorMessage);
				} else if (isHandoffAction) {
					this.ctx.chatContainer.clear();
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					await this.ctx.reloadTodos();
					this.ctx.showStatus("Auto-handoff completed");
				} else if (event.skipped) {
					// Benign skip: no model selected, no candidate models available, or nothing
					// to compact yet. Not a failure — suppress the warning.
				} else {
					this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
				}
				await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
				this.ctx.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				this.ctx.retryEscapeHandler = this.ctx.editor.onEscape;
				this.ctx.editor.onEscape = () => {
					this.ctx.session.abortRetry();
				};
				this.ctx.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.ctx.retryLoader = new Loader(
					this.ctx.ui,
					spinner => theme.fg("warning", spinner),
					text => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s… (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.ctx.statusContainer.addChild(this.ctx.retryLoader);
				this.ctx.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				if (this.ctx.retryEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
					this.ctx.retryEscapeHandler = undefined;
				}
				if (this.ctx.retryLoader) {
					this.ctx.retryLoader.stop();
					this.ctx.retryLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				if (!event.success) {
					this.ctx.showError(
						`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
					);
				}
				this.ctx.ui.requestRender();
				break;
			}

			case "retry_fallback_applied": {
				this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
				break;
			}

			case "retry_fallback_succeeded": {
				this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
				break;
			}

			case "ttsr_triggered": {
				const component = new TtsrNotificationComponent(event.rules);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(createSystemGutter(this.ctx.ui, component));
				this.ctx.ui.requestRender();
				break;
			}

			case "todo_reminder": {
				if (settings.get("todo.verbose")) {
					const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
					this.ctx.chatContainer.addChild(createSystemGutter(this.ctx.ui, component));
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "todo_auto_clear":
				await this.ctx.reloadTodos();
				break;
		}
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule while compaction/handoff is already running — the agent_end from a
		// handoff agent turn still has the old session's bloated token counts, and scheduling
		// here would fire after the session resets, trying to handoff an empty session.
		if (this.ctx.session.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.session.isStreaming) return;
			if (this.ctx.session.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.session.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#currentContextTokens(): number {
		const lastAssistant = this.ctx.session.agent.state.messages
			.slice()
			.reverse()
			.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "aborted");
		return lastAssistant?.usage ? calculatePromptTokens(lastAssistant.usage) : 0;
	}

	sendCompletionNotification(event?: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		if (this.ctx.isBackgrounded === false) return;
		const notify = settings.get("completion.notify");
		if (notify === "off") return;
		const title = this.ctx.sessionManager.getSessionName();
		const lastAssistant = event?.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const failed = lastAssistant?.stopReason === "error";
		TERMINAL.sendNotification({
			title: title || "xcsh",
			body: failed ? "Stopped with error" : "Complete",
			type: failed ? "error" : "completion",
		});
	}

	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "agent_end") {
			return;
		}
		if (this.ctx.session.queuedMessageCount > 0 || this.ctx.session.isStreaming) {
			return;
		}
		this.sendCompletionNotification(event);
		await this.ctx.shutdown();
	}
}
