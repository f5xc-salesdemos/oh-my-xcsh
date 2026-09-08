import { describe, expect, it } from "bun:test";
import { RoutingCoordinator } from "../src/routing/coordinator";
import { RoutingStateMachine } from "../src/routing/state-machine";

describe("Routing Coordinator (I01)", () => {
	const available = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

	it("should pass through unchanged when routing mode is 'off'", async () => {
		const sm = new RoutingStateMachine();
		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		const decision = await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "off",
			prompt: "Summarize file",
			availableModels: available,
		});

		expect(decision.mode).toBe("off");
		expect(decision.applied).toBe(false);
		expect(decision.selectedModel).toBe("openai/gpt-5.6");
		expect(decision.reasons).toContain("mode_off");
	});

	it("should calculate decision but NOT apply switch or mutate state machine in 'shadow' mode", async () => {
		const sm = new RoutingStateMachine({ currentTier: "balanced" });
		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		const decision = await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "shadow",
			prompt: "Summarize README.md", // simple read -> utility
			availableModels: available,
		});

		expect(decision.mode).toBe("shadow");
		expect(decision.applied).toBe(false);
		expect(decision.desiredTier).toBe("utility");
		expect(decision.effectiveTier).toBe("balanced");
		expect(decision.reasons).toContain("mode_shadow");

		// State machine operational state remains unmutated!
		expect(sm.getState().currentTier).toBe("balanced");
		expect(sm.getState().downshiftStreak).toBe(0);
	});

	it("should apply temporary model switch when routing mode is 'auto'", async () => {
		const sm = new RoutingStateMachine({ currentTier: "utility" }); // already at utility
		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		const decision = await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "auto",
			prompt: "Summarize README.md", // simple read -> utility
			availableModels: available,
		});

		expect(decision.mode).toBe("auto");
		expect(decision.applied).toBe(true);
		expect(decision.desiredTier).toBe("utility");
		expect(decision.effectiveTier).toBe("utility");
		expect(decision.selectedModel).toBe("openai/gpt-5.6-luna");
	});

	it("should respect manual pin until cleared", async () => {
		const sm = new RoutingStateMachine();
		sm.setManualPin("openai/o3-mini");

		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		const decision = await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "auto",
			prompt: "Summarize README.md",
			availableModels: available,
		});

		expect(decision.applied).toBe(false);
		expect(decision.selectedModel).toBe("openai/o3-mini");
		expect(decision.reasons).toContain("user_model_pin");
	});

	it("should defer state machine mutations until pool resolution is verified non-degraded", async () => {
		const sm = new RoutingStateMachine({ currentTier: "frontier", downshiftStreak: 1 });
		const coordinator = new RoutingCoordinator({ stateMachine: sm });

		// Degraded availability (0 available models) causes tier resolution to fail
		await coordinator.evaluateTurn({
			anchorModel: "openai/gpt-5.6",
			mode: "auto",
			prompt: "Simple task", // Drives desired utility -> triggering downshift calculation
			availableModels: [],
		});

		// The active state machine should remain untouched
		expect(sm.getState().downshiftStreak).toBe(1);
	});

	it("selects the Codex tier effort and escalates frontier reasoning independently", async () => {
		const availableCodex = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
		const normal = await new RoutingCoordinator().evaluateTurn({
			anchorModel: "openai-codex/gpt-5.6-terra",
			mode: "auto",
			prompt: "Update this one configuration field",
			availableModels: availableCodex,
		});
		expect(normal.selectedModel).toBe("openai-codex/gpt-5.6-terra");
		expect(normal.selectedEffort).toBe("medium");
		expect(normal.effortReason).toBe("tier_default");

		const rejected = await new RoutingCoordinator().evaluateTurn({
			anchorModel: "openai-codex/gpt-5.6-terra",
			mode: "auto",
			prompt: "Review the architecture migration and security design",
			priorRejection: true,
			availableModels: availableCodex,
		});
		expect(rejected.selectedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(rejected.selectedEffort).toBe("xhigh");
		expect(rejected.effortReason).toBe("rejection_escalation");
	});
});
