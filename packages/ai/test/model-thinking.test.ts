import { describe, expect, it } from "bun:test";
import {
	applyGeneratedModelPolicies,
	clampThinkingLevelForModel,
	createThinkingConfig,
	Effort,
	enrichModelThinking,
	getSupportedEfforts,
	linkSparkPromotionTargets,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	type ReasoningEffort,
	requireSupportedEffort,
} from "@f5-sales-demo/pi-ai/model-thinking";
import type { Api, Model, Provider, ThinkingConfig } from "@f5-sales-demo/pi-ai/types";
import { getBundledModel } from "../src/models";
import MODELS from "../src/models.json" with { type: "json" };
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
}): Model<TApi> {
	return enrichModelThinking({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: "",
		reasoning: overrides.reasoning ?? true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

function expectThinking(
	model: Model | undefined,
	efforts: readonly ReasoningEffort[],
	mode: ThinkingConfig["mode"],
	defaultLevel: ReasoningEffort = "medium",
) {
	expect(model?.thinking?.mode).toBe(mode);
	expect(model?.thinking?.defaultLevel).toBe(defaultLevel);
	expect(model?.thinking?.supportedLevels.map(level => level.effort)).toEqual([...efforts]);
}

describe("model thinking metadata", () => {
	it("bundles GPT-5.6 Sol for LiteLLM with the live-verified effort range", () => {
		const model = getBundledModel("litellm", "gpt-5.6-sol");

		expect(model).toMatchObject({
			id: "gpt-5.6-sol",
			api: "openai-completions",
			provider: "litellm",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1050000,
			maxTokens: 128000,
			thinking: createThinkingConfig([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]),
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});

	it("corrects image input only for the generated LiteLLM GPT-5.6 Sol entry", () => {
		const models: Model<Api>[] = [
			createModel({ id: "gpt-5.6-sol", api: "openai-completions", provider: "litellm" }),
			createModel({ id: "gpt-5.6-sol", api: "openai-completions", provider: "custom" }),
			createModel({ id: "gpt-5.6-terra", api: "openai-completions", provider: "litellm" }),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.input).toEqual(["text", "image"]);
		expect(models[1]?.input).toEqual(["text"]);
		expect(models[2]?.input).toEqual(["text"]);
	});

	it("stores supported efforts for Codex mini in model metadata", () => {
		const model = createModel({
			id: "gpt-5.1-codex-mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expectThinking(model, [Effort.Medium, Effort.High], "effort", Effort.Medium);
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow(/Supported efforts: medium, high/);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: medium, high/);
	});

	it("replaces Vertex Gemini 3.7 Flash with GA Gemini 3.8 Flash", () => {
		const model = getBundledModel("google-vertex", "gemini-3.8-flash");

		expect(model).toMatchObject({
			id: "gemini-3.8-flash",
			api: "google-vertex",
			provider: "google-vertex",
			reasoning: true,
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinking: createThinkingConfig([Effort.Low, Effort.Medium, Effort.High], "google-level", Effort.High),
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(DEFAULT_MODEL_PER_PROVIDER["google-vertex"]).toBe("gemini-3.8-flash");
		expect(getBundledModel("google-vertex", "gemini-3.7-flash")).toBeUndefined();
	});

	it("stores xhigh support directly in metadata for GPT-5.2", () => {
		const model = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expectThinking(model, [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh], "effort");
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("maps every documented Gemini 3 Pro thinking level", () => {
		const model = createModel({
			id: "gemini-3-pro-preview",
			api: "google-generative-ai",
			provider: "google",
		});

		expectThinking(model, [Effort.Low, Effort.Medium, Effort.High], "google-level");
		expect(mapEffortToGoogleThinkingLevel(model, Effort.Low)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(model, Effort.Medium)).toBe("MEDIUM");
		expect(mapEffortToGoogleThinkingLevel(model, Effort.High)).toBe("HIGH");
	});

	it("applies HIGH defaults only to full Vertex Gemini Flash and Pro models", () => {
		for (const id of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3-pro-preview"]) {
			expect(getBundledModel("google-vertex", id).thinking?.defaultLevel).toBe(Effort.High);
		}
		expect(getSupportedEfforts(getBundledModel("google-vertex", "gemini-3-flash-preview"))).not.toContain("none");
		expect(getSupportedEfforts(getBundledModel("google-vertex", "gemini-3-pro-preview"))).not.toContain("none");
		expect(getBundledModel("google-vertex", "gemini-2.5-flash-lite").thinking?.defaultLevel).toBe(Effort.Medium);
		expect(getBundledModel("google", "gemini-3-flash-preview").thinking?.defaultLevel).toBe(Effort.Medium);
	});

	it("encodes anthropic transport mode in metadata", () => {
		const opus45 = createModel({
			id: "claude-opus-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const opus46 = createModel({
			id: "claude-opus-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const sonnet46 = createModel({
			id: "claude-sonnet-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		});

		expect(opus45.thinking?.mode).toBe("anthropic-budget-effort");
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet46.thinking?.mode).toBe("anthropic-adaptive");
		expectThinking(opus46, [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], "anthropic-adaptive");
		expectThinking(sonnet46, [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], "anthropic-adaptive");
		// opus 4.6 now refuses xhigh/max for the same reason sonnet 4.6 always has:
		// the Messages API rejects `xhigh` on both, and opus 4.6's fallback chain
		// rejects `max`. Asserting the old `"xhigh"`/`"max"` here is what let #2630
		// ship — the mapping was pinned to an unprobed assumption.
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.Max)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
		// The user-facing path clamps rather than throwing; see effort-ladder.test.ts.
		expect(mapEffortToAnthropicAdaptiveEffort(opus46, Effort.High)).toBe("high");
	});
});

/**
 * #2630 follow-up. The first fix keyed the extended enum on
 * `semverGte(version, "5.0")`, which grants `xhigh`/`max` to every FUTURE Claude
 * version the moment it appears in the catalog — the same open-ended grant that
 * caused #2630 in the first place (#2346 keyed on `kind === "opus"`).
 *
 * Capability must be opt-in per measured version, so an unprobed model fails
 * closed to the conservative range instead of inheriting an unverified ceiling.
 */
describe("unprobed Claude versions fail closed — #2630", () => {
	for (const id of ["claude-opus-6", "claude-sonnet-6", "claude-opus-5.1"]) {
		it(`${id} does not inherit xhigh or max before it is probed`, () => {
			const model = createModel({ id, api: "anthropic-messages", provider: "anthropic" });
			const levels = getSupportedEfforts(model);
			expect(levels).not.toContain(Effort.XHigh);
			expect(levels).not.toContain(Effort.Max);
		});
	}

	it("still grants the measured 5.0 models their full range", () => {
		for (const id of ["claude-opus-5", "claude-sonnet-5"]) {
			const levels = getSupportedEfforts(createModel({ id, api: "anthropic-messages", provider: "anthropic" }));
			expect(levels).toContain(Effort.XHigh);
			expect(levels).toContain(Effort.Max);
		}
	});
});

describe("bundled GPT-5.4 model metadata", () => {
	it("stores raw GPT-5.4 mini/nano catalog metadata for OpenAI, OpenAI Codex, and Copilot", () => {
		const openAiMini = MODELS.openai["gpt-5.4-mini"];
		const openAiNano = MODELS.openai["gpt-5.4-nano"];
		const openAiCodexMini = MODELS["openai-codex"]["gpt-5.4-mini"];
		const openAiCodexNano = MODELS["openai-codex"]["gpt-5.4-nano"];
		const copilotMini = MODELS["github-copilot"]["gpt-5.4-mini"];

		for (const candidate of [openAiMini, openAiNano, openAiCodexMini, openAiCodexNano, copilotMini]) {
			expect(candidate?.thinking?.supportedLevels.map(level => level.effort)).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
			]);
		}
		expect(openAiCodexMini?.api).toBe("openai-codex-responses");
		expect(openAiCodexNano?.api).toBe("openai-codex-responses");
		expect(openAiCodexMini?.contextWindow).toBe(272000);
		expect(openAiCodexNano?.contextWindow).toBe(272000);
		expect(openAiCodexMini?.preferWebsockets).toBe(true);
		expect(openAiCodexNano?.preferWebsockets).toBe(true);
		expect(openAiCodexMini?.priority).toBe(1);
		expect(openAiCodexNano?.priority).toBe(2);
	});

	it("exposes xhigh support for bundled GPT-5.4 mini/nano runtime models across supported providers", () => {
		const openAiMini = getBundledModel("openai", "gpt-5.4-mini");
		const openAiNano = getBundledModel("openai", "gpt-5.4-nano");
		const openAiCodexMini = getBundledModel("openai-codex", "gpt-5.4-mini");
		const openAiCodexNano = getBundledModel("openai-codex", "gpt-5.4-nano");
		const copilotMini = getBundledModel("github-copilot", "gpt-5.4-mini");

		expect(openAiCodexMini.contextWindow).toBe(272000);
		expect(openAiCodexNano.contextWindow).toBe(272000);
		expect(requireSupportedEffort(openAiMini, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(openAiNano, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(openAiCodexMini, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(openAiCodexNano, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(copilotMini, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("does not bundle GitHub Copilot GPT-5.4 nano", () => {
		const copilotModels = MODELS["github-copilot"] as Record<string, unknown>;
		expect(copilotModels["gpt-5.4-nano"]).toBeUndefined();
		expect(getBundledModel("github-copilot", "gpt-5.4-nano")).toBeUndefined();
	});
});

describe("generated model policies", () => {
	it("refreshes thinking metadata and applies parsed catalog corrections", () => {
		const models: Model<Api>[] = [
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://example.com",
				reasoning: true,
				thinking: createThinkingConfig([Effort.High], "budget", Effort.High),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
				maxTokens: 32000,
			},
			{
				id: "anthropic.claude-opus-4-6-v1:0",
				name: "Claude Opus 4.6",
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
				maxTokens: 32000,
			},
			{
				id: "gpt-5.2-codex",
				name: "GPT-5.2 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 32000,
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 mini",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 32000,
				priority: 2,
			},
		];

		applyGeneratedModelPolicies(models);

		expectThinking(
			models[0],
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			"anthropic-budget-effort",
		);
		expect(models[0]?.cost.cacheRead).toBe(0.5);
		expect(models[0]?.cost.cacheWrite).toBe(6.25);
		expectThinking(
			models[1],
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			"anthropic-adaptive",
		);
		expect(models[1]?.cost.cacheRead).toBe(0.5);
		expect(models[1]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.contextWindow).toBe(1000000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[3]?.contextWindow).toBe(272000);
		expect(models[3]?.priority).toBe(1);
	});

	it("does not special-case Copilot Opus 4.6 generated limits", () => {
		const models: Model<Api>[] = [
			{
				...createModel({
					id: "claude-opus-4.6",
					api: "anthropic-messages",
					provider: "github-copilot",
				}),
				contextWindow: 168000,
				maxTokens: 32000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(168000);
		expect(models[0]?.maxTokens).toBe(32000);
	});

	it("links spark variants to their base models", () => {
		const models = [
			createModel({
				id: "gpt-5.2-codex-spark",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
			createModel({
				id: "gpt-5.2-codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
		];

		linkSparkPromotionTargets(models);

		expect(models[0]?.contextPromotionTarget).toBe("openai-codex/gpt-5.2-codex");
	});
});

describe("model thinking runtime helpers", () => {
	it("rejects unsupported explicit metadata instead of inferring or clamping", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "custom-reasoner",
			name: "Custom Reasoner",
			api: "openai-codex-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: createThinkingConfig([Effort.Medium, Effort.High]),
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		};

		expect(() => clampThinkingLevelForModel(model, Effort.Minimal)).toThrow(/not supported/);
		expect(() => clampThinkingLevelForModel(model, Effort.XHigh)).toThrow(/not supported/);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.High);
	});

	it('forces "off" for non-reasoning models', () => {
		const model = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "openai",
			reasoning: false,
		});

		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("enables xhigh for openai-completions API (custom models)", () => {
		const model = createModel({
			id: "custom-model",
			api: "openai-completions",
			provider: "custom",
		});

		// openai-completions should support xhigh by default
		expect(getSupportedEfforts(model).at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("does not expose xhigh for binary-thinking openai-compat transports", () => {
		const model = enrichModelThinking({
			id: "glm-4.7",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "zai",
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		} satisfies Model<"openai-completions">);

		expectThinking(model, [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], "effort");
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("derives binary-thinking fallback from resolved compat when catalog compat is partial", () => {
		const model = enrichModelThinking({
			id: "qwen/qwen3-32b",
			name: "Qwen 3 32B",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			compat: {
				supportsToolChoice: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		} satisfies Model<"openai-completions">);

		expectThinking(model, [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], "effort");
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("enables xhigh for openai-responses and openai-codex-responses APIs", () => {
		const responsesModel = createModel({
			id: "custom-responses",
			api: "openai-responses",
			provider: "custom",
		});

		const codexModel = createModel({
			id: "custom-codex",
			api: "openai-codex-responses",
			provider: "custom",
		});

		// Both should support xhigh
		expect(getSupportedEfforts(responsesModel).at(-1)).toBe(Effort.XHigh);
		expect(getSupportedEfforts(codexModel).at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(responsesModel, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(codexModel, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("rejects reasoning models that are missing thinking metadata at runtime", () => {
		const model = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">;

		expect(() => requireSupportedEffort(model, Effort.High)).toThrow(/missing thinking metadata/);
	});

	it("drops empty thinking metadata so presence checks stay meaningful", () => {
		const model = enrichModelThinking({
			id: "plain-model",
			name: "Plain Model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: false,
			thinking: { mode: "effort", supportedLevels: [], defaultLevel: Effort.High },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} satisfies Model<"openai-responses">);

		expect(model.thinking).toBeUndefined();
	});
});
