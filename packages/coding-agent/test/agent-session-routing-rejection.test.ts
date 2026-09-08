import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@f5-sales-demo/pi-agent-core";
import { createThinkingConfig, Effort } from "@f5-sales-demo/pi-ai";
import { TempDir } from "@f5-sales-demo/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("AgentSession Routing Rejection Escalation (TDD)", () => {
	let tempDir: TempDir;
	let settings: Settings;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("xcsh-test-rejection");
		settings = Settings.isolated();
		settings.set("routing.mode", "auto");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				systemPrompt: "You are a test agent",
				model: { provider: "openai", id: "gpt-5.6", api: "openai-responses" } as any,
				tools: [],
			},
		});

		session = new AgentSession({
			agent,
			settings,
			modelRegistry,
			sessionManager,
		});
	});

	afterEach(async () => {
		tempDir.removeSync();
	});

	it("should step escalation sequentially when safeToContinue is true", async () => {
		modelRegistry.getAvailable = () => [{ provider: "openai", id: "gpt-5.6-terra" }] as any;
		modelRegistry.getApiKey = async () => "mock-key";

		const events: any[] = [];
		session.subscribe(e => events.push(e));

		session.restoreRoutingState({ currentTier: "utility" });

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: true,
		});

		await session.waitForIdle();

		const escalationEvent = events.find(e => e.type === "routing_escalated");
		expect(escalationEvent).toBeDefined();
		expect(escalationEvent.effectiveTier).toBe("balanced");
	});

	it("should not mutate state if mode is shadow", async () => {
		modelRegistry.getAvailable = () => [{ provider: "openai", id: "gpt-5.6-terra" }] as any;
		settings.set("routing.mode", "shadow");

		const events: any[] = [];
		session.subscribe(e => events.push(e));

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: true,
		});

		await session.waitForIdle();

		const escalationEvent = events.find(e => e.type === "routing_escalated");
		expect(escalationEvent).toBeUndefined();
	});

	it("should not abort agent if target model cannot be resolved during escalation", async () => {
		modelRegistry.getAvailable = () => [];

		let emitCount = 0;
		session.subscribe(e => {
			if (e.type === "routing_escalated") {
				emitCount++;
			}
		});

		session.restoreRoutingState({ currentTier: "utility" });

		let abortCount = 0;
		session.agent.abort = () => {
			abortCount++;
		};

		let continueCount = 0;
		session.agent.continue = () => {
			continueCount++;
			return Promise.resolve();
		};

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: true,
		});

		await session.waitForIdle();

		expect(abortCount).toBe(0);
		expect(continueCount).toBe(0);

		expect(emitCount).toBe(0);
		expect(session.getRoutingState().currentTier).toBe("utility");
	});
	it("should revert state and resume agent if target exists but switch/authentication fails", async () => {
		modelRegistry.getAvailable = () => [{ provider: "openai", id: "gpt-5.6-terra" }] as any;
		session.setModelRoutingSwitch = async () => {
			throw new Error("Simulated auth failure");
		};

		session.restoreRoutingState({ currentTier: "utility" });

		let abortCount = 0;
		session.agent.abort = () => {
			abortCount++;
		};

		let continueCount = 0;
		session.agent.continue = () => {
			continueCount++;
			return Promise.resolve();
		};

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: true,
		});

		await session.waitForIdle();

		expect(abortCount).toBe(0);
		expect(continueCount).toBe(1);
		expect(session.getRoutingState().currentTier).toBe("utility");
	});

	it("should not immediately switch model if outcome is unsafe to continue", async () => {
		modelRegistry.getAvailable = () =>
			[
				{ provider: "openai", id: "gpt-5.6-terra" },
				{ provider: "openai", id: "gpt-5.6-sol" },
			] as any;

		let switchCount = 0;
		session.setModelRoutingSwitch = async () => {
			switchCount++;
		};

		session.restoreRoutingState({ currentTier: "utility" });

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: false,
		});

		await session.waitForIdle();

		expect(switchCount).toBe(0);
	});

	it("should restore model state if escalation swap fails", async () => {
		modelRegistry.getAvailable = () => [{ provider: "openai", id: "gpt-5.6-terra" }] as any;
		modelRegistry.getApiKey = async () => "mock-key";

		const originalSetModel = session.setModelRoutingSwitch.bind(session);
		session.setModelRoutingSwitch = async model => {
			await originalSetModel(model);
			throw new Error("Simulated swap failure");
		};

		session.restoreRoutingState({ currentTier: "utility" });

		let appendedModelId = "";
		let appendedRole = "";
		const originalAppend = session.sessionManager.appendModelChange.bind(session.sessionManager);
		(session.sessionManager as any).appendModelChange = (modelId: string, role: string) => {
			if (role === "routing_switch_rollback") {
				appendedModelId = modelId;
				appendedRole = role;
			}
			originalAppend(modelId, role);
		};

		session.recordRoutingOutcome({
			status: "rejected",
			evidence: [{ kind: "test_failure", summary: "Failed" }],
			safeToContinue: true,
		});

		await session.waitForIdle();

		expect(session.model?.id).toBe("gpt-5.6");
		expect(appendedModelId).toBe("openai/gpt-5.6");
		expect(appendedRole).toBe("routing_switch_rollback");
	});

	it("sendCustomMessage() turn trigger should not bypass routing evaluation", async () => {
		session.settings.set("routing.mode", "auto");
		session.settings.set("routing.pools", "litellm/openai");

		let routingEvaluated = false;
		// Spy on routingCoordinator.evaluateTurn
		const _originalEvaluateTurn = (session as any).routingCoordinator.evaluateTurn;
		(session as any).routingCoordinator.evaluateTurn = async (_ctx: any) => {
			routingEvaluated = true;
			throw new Error("routing evaluated stop");
		};

		await expect(
			session.sendCustomMessage({ customType: "test", content: "hello", display: true }, { triggerTurn: true }),
		).rejects.toThrow("routing evaluated stop");

		expect(routingEvaluated).toBe(true);
	});

	it("should clear internal URLs when routing to LiteLLM gpt-5.6-luna", async () => {
		modelRegistry.getAvailable = () => [{ provider: "litellm", id: "gpt-5.6-luna", contextWindow: 128000 }] as any;
		modelRegistry.getApiKeyForProvider = async () => "mock-key";
		modelRegistry.getApiKey = async () => "mock-key";
		settings.set("routing.mode", "auto");
		settings.set("routing.pools", "litellm/gpt-5.6-luna");
		settings.set("routing.internalOpenAiUrl", "https://internal.openai.example.com");

		const _originalEvaluateTurn = (session as any).routingCoordinator.evaluateTurn;
		(session as any).routingCoordinator.evaluateTurn = async (_ctx: any) => {
			return {
				applied: true,
				selectedModel: "litellm/gpt-5.6-luna",
				reasons: ["mock"],
			};
		};

		let _appendedContent: any;
		(session as any).promptWithMessage = async (_m: any, _text: any, _opts: any) => {
			return Promise.resolve();
		};
		session.agent.prompt = async () => {
			return Promise.resolve();
		};

		await session.sendCustomMessage({ customType: "test", content: "hello", display: true }, { triggerTurn: true });
		expect(session.model?.baseUrl).toBe("https://internal.openai.example.com");

		settings.set("routing.internalOpenAiUrl", "");
		await session.sendCustomMessage({ customType: "test", content: "hello", display: true }, { triggerTurn: true });
		expect(session.model?.baseUrl).toBeUndefined();
	});

	it("should trigger image-only fallback correctly in evaluateAndApplyRouting", async () => {
		modelRegistry.getAvailable = () => [{ provider: "openai", id: "gpt-5.6", api: "openai-responses" }] as any;
		modelRegistry.getApiKeyForProvider = async () => "mock-key";
		modelRegistry.getApiKey = async () => "mock-key";
		settings.set("routing.mode", "auto");
		settings.set("routing.delegation", "read-only");
		const _originalEvaluateTurn = (session as any).routingCoordinator.evaluateTurn;
		(session as any).routingCoordinator.evaluateTurn = async (_ctx: any) => {
			return {
				applied: true,
				selectedModel: "openai/gpt-5.6",
				delegation: {
					subtasks: [
						{ id: "1", title: "task 1", description: "task 1" },
						{ id: "2", title: "task 2", description: "task 2" },
					],
				},
			};
		};

		const message: any = {
			customType: "test",
			content: [{ type: "image", mimeType: "image/png", data: "fake" }],
			display: true,
		};

		let appendedContent: any;
		session.agent.prompt = async (messages: any) => {
			console.log("agent.prompt called");
			const lastMessage = messages[messages.length - 1];
			appendedContent = lastMessage.content;
			return Promise.resolve();
		};

		console.log("TEST: Triggering sendCustomMessage 2");
		await session.sendCustomMessage(message, { triggerTurn: true });
		console.log("TEST: Finished sendCustomMessage 2");

		const textBlock = appendedContent.find((c: any) => c.type === "text");
		expect(textBlock).toBeDefined();
		expect(textBlock.text).toContain("<delegation_results>");
	});

	it("should apply routing.internalOpenAiUrl to LiteLLM GPT models in setModelRoutingSwitch", async () => {
		settings.set("routing.internalOpenAiUrl", "https://internal-openai.example.com");
		modelRegistry.getApiKey = async () => "mock-key";

		const litellmGptModel = {
			provider: "litellm",
			id: "gpt-5.6-luna",
			api: "openai-responses",
			reasoning: true,
			thinking: createThinkingConfig([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]),
		} as any;

		await session.setModelRoutingSwitch(litellmGptModel, "low" as any);

		const activeModel = session.model;
		expect(activeModel).toBeDefined();
		expect(activeModel?.provider).toBe("litellm");
		expect(activeModel?.id).toBe("gpt-5.6-luna");
		expect(activeModel?.baseUrl).toBe("https://internal-openai.example.com");
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("should calculate correct delegation tokens and pass AbortSignal", async () => {
		settings.set("routing.mode", "auto");
		settings.set("routing.delegation", "read-only");

		const controller = new AbortController();
		let evaluateAndApplyRoutingCalledWithSignal = false;
		let childPromptAborted = false;

		const originalChildSession = AgentSession.prototype.buildDisplaySessionContext;
		const originalPrompt = AgentSession.prototype.prompt;
		const oldKey = process.env.OPENAI_API_KEY;

		try {
			let emittedTokens = -1;
			session.subscribe((e: any) => {
				if (e.type === "routing_delegated") {
					emittedTokens = e.tokensUsed;
				}
			});

			process.env.OPENAI_API_KEY = "test-key";

			let buildDisplaySessionContextCalled = false;

			(AgentSession.prototype as any).buildDisplaySessionContext = () => {
				buildDisplaySessionContextCalled = true;
				return {
					usedTokens: 42,
					hasPersistedMCPToolSelection: false,
					messages: [],
				};
			};

			(AgentSession.prototype as any).prompt = async () => {
				return new Promise<void>((_resolve, reject) => {
					if (controller.signal.aborted) {
						childPromptAborted = true;
						reject(new Error("Aborted"));
						return;
					}
					const onAbort = () => {
						childPromptAborted = true;
						reject(new Error("Aborted"));
					};
					controller.signal.addEventListener("abort", onAbort);

					// Abort the controller while we are in the prompt
					controller.abort();
				});
			};

			(session as any).promptWithMessage = async (_m: any, _text: any, opts: any) => {
				if (opts?.signal === controller.signal) {
					evaluateAndApplyRoutingCalledWithSignal = true;
				}
				return Promise.resolve();
			};

			(session as any).routingCoordinator.evaluateTurn = async (ctx: any) => {
				if (ctx.signal === controller.signal) {
					evaluateAndApplyRoutingCalledWithSignal = true;
				}
				return {
					applied: true,
					selectedModel: "openai/gpt-5.6",
					effectiveTier: "utility",
					reasons: [],
					delegation: {
						mode: "read-only",
						subtasks: [
							{ id: "1", title: "task 1", description: "task 1" },
							{ id: "2", title: "task 2", description: "task 2" },
						],
					},
				};
			};

			const message: any = { customType: "test", content: "test", display: true };
			await session.sendCustomMessage(message, { triggerTurn: true, signal: controller.signal } as any);

			expect(evaluateAndApplyRoutingCalledWithSignal).toBe(true);
			expect(buildDisplaySessionContextCalled).toBe(true);
			expect(childPromptAborted).toBe(true);
			expect(emittedTokens).toBe(0);
		} finally {
			(AgentSession.prototype as any).buildDisplaySessionContext = originalChildSession;
			(AgentSession.prototype as any).prompt = originalPrompt;
			if (oldKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = oldKey;
			}
		}
	});
});
