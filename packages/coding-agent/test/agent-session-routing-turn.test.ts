import { describe, expect, it } from "bun:test";
import { RoutingCoordinator } from "../src/routing/coordinator";
import { RoutingStateMachine } from "../src/routing/state-machine";

describe("AgentSession Turn Routing Evaluation (I02)", () => {
	it("should evaluate routing decision during turn dispatch when routing mode is enabled", async () => {
		const sm = new RoutingStateMachine({ currentTier: "utility" }); // already at utility
		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		const decision = await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "auto",
			prompt: "Fix typo in line 5", // simple operation -> utility
			availableModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
		});

		expect(decision.mode).toBe("auto");
		expect(decision.applied).toBe(true);
		expect(decision.effectiveTier).toBe("utility");
		expect(decision.selectedModel).toBe("openai/gpt-5.6-luna");
	});

	it("should calculate used tokens correctly including deep array content blocks", async () => {
		const { calculateUsedTokens } = await import("../src/session/agent-session");
		const messages = [
			{ role: "user", content: "Hello world" }, // length 11 -> 2.75 -> 3
			{
				role: "assistant",
				content: [
					{ type: "text", text: "This is a" }, // length 9
					{ type: "image_url", image_url: { url: "..." } }, // ignored
					{ type: "text", text: " test block" }, // length 11
					{ type: "tool_use", name: "some_tool", input: { massive_ast: "huge string here..." } }, // ignored
				],
			}, // 9 + 11 = 20 -> 5
		];
		// 11 + 20 = 31 total chars -> 31 / 4 = 7.75 -> round to 8
		expect(calculateUsedTokens(messages)).toBe(8);
	});

	it("should ignore base64 images when estimating tokens in strings", async () => {
		const { calculateUsedTokens } = await import("../src/session/agent-session");
		const messages = [
			{ role: "user", content: "data:image/jpeg;base64,massivebase64stringthatshouldbeignoredentirely" },
			{ role: "assistant", content: "Normal text" }, // length 11
		];
		// 11 chars -> 11/4 = 2.75 -> 3
		expect(calculateUsedTokens(messages)).toBe(3);
	});

	it("should reset session-level routing state completely when branch lacks custom routing entries", async () => {
		const { createAgentSession } = await import("../src/sdk");
		const { SessionManager } = await import("../src/session/session-manager");

		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as any);

		const { session } = await createAgentSession({
			model: { provider: "test", id: "model-1", name: "test model", contextWindow: 8000, api: "anthropic" } as any,
			sessionManager: sm,
			modelRegistry: {
				getAvailable: () => [],
				getApiKey: async () => "key",
				getApiKeyForProvider: async () => "key",
				syncExtensionSources: () => {},
				clearSourceRegistrations: () => {},
			} as any,
			enableLsp: false,
			enableMCP: false,
		});

		// Force mutate the state to pretend we were in a routed state
		session.agent.serviceTier = "frontier" as any;

		// Rewind to first message, which has no routing events before it
		const entries = session.sessionManager.getBranch();
		await session.branch(entries[0].id);

		expect(session.modelResolutionSource).toBe("config");
		expect(session.agent.serviceTier).toBeUndefined();
	});
});
