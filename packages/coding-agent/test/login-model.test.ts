import { describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import { createThinkingConfig, Effort, ReasoningEffort } from "@f5-sales-demo/pi-ai";
import {
	applyModelAfterLogin,
	applyOAuthLoginModel,
	formatLoginThinkingState,
	GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE,
	GOOGLE_VERTEX_LOGIN_MODEL_CHOICE,
	getAvailableLiteLLMLoginModelChoices,
	getVllmLoginModelChoices,
	LITELLM_LOGIN_MODEL_CHOICES,
	OPENAI_CODEX_LOGIN_MODEL_CHOICE,
} from "../src/modes/controllers/login-model";

function makeSession(opts: {
	model?: { id: string; provider: string };
	models: Array<{
		id: string;
		provider: string;
		reasoning?: boolean;
		thinking?: ReturnType<typeof createThinkingConfig>;
	}>;
	thinkingLevel?: ThinkingLevel;
}) {
	let modelRoles: Record<string, string> = { vision: "google/vision" };
	let routingProfile: "none" | "anthropic" | "google-antigravity" | "openai-codex" = "none";
	let routingMode: "off" | "shadow" | "auto" = "auto";
	const session: any = {
		model: opts.model,
		thinkingLevel: opts.thinkingLevel ?? ThinkingLevel.High,
		modelRegistry: { getAll: () => opts.models },
		settings: {
			getModelRoles: () => modelRoles,
			get: (key: string) => (key === "routing.mode" ? routingMode : routingProfile),
			set: (key: string, value: any) => {
				if (key === "modelRoles") modelRoles = value;
				if (key === "routing.profile") routingProfile = value;
				if (key === "routing.mode") routingMode = value;
			},
		},
	};
	const setModel = vi.fn(async (model: { id: string; provider: string }, _role: string, _opts?: unknown) => {
		session.model = model;
	});
	const setModelTemporary = vi.fn(async (model: { id: string; provider: string }, thinkingLevel?: ThinkingLevel) => {
		session.model = model;
		if (thinkingLevel !== undefined) session.thinkingLevel = thinkingLevel;
	});
	const setThinkingLevel = vi.fn((level: ThinkingLevel) => {
		session.thinkingLevel = level;
	});
	session.setModel = setModel;
	session.setModelTemporary = setModelTemporary;
	session.setThinkingLevel = setThinkingLevel;
	return {
		session,
		setModel,
		setModelTemporary,
		setThinkingLevel,
		getModelRoles: () => modelRoles,
		getRoutingProfile: () => routingProfile,
		getRoutingMode: () => routingMode,
		getThinkingLevel: () => session.thinkingLevel,
	};
}
const M = (id: string, provider = "litellm") => ({ id, provider });
const GPT_CHOICE = LITELLM_LOGIN_MODEL_CHOICES.find(choice => choice.modelId === "gpt-5.6-sol")!;
const OPUS_CHOICE = LITELLM_LOGIN_MODEL_CHOICES.find(choice => choice.modelId === "claude-opus-5")!;

describe("applyModelAfterLogin", () => {
	it("persists corporate Vertex Gemini 3.8 Flash with HIGH thinking", async () => {
		const { session, setModel, setThinkingLevel } = makeSession({
			model: undefined,
			models: [M("gemini-3.8-flash", "google-vertex")],
		});
		await expect(applyModelAfterLogin(session as never, GOOGLE_VERTEX_LOGIN_MODEL_CHOICE)).resolves.toBe(true);
		expect(setModel).toHaveBeenCalledWith(M("gemini-3.8-flash", "google-vertex"), "default", {
			selector: "google-vertex/gemini-3.8-flash",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});
	it("persists the selected model and high thinking", async () => {
		const { session, setModel, setThinkingLevel } = makeSession({
			model: undefined,
			models: [M("gpt-5.6-sol")],
		});
		const applied = await applyModelAfterLogin(session as never, GPT_CHOICE);
		expect(applied).toBe(true);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0][0]).toMatchObject({ id: "gpt-5.6-sol", provider: "litellm" });
		expect(setModel.mock.calls[0][1]).toBe("default");
		expect(setModel.mock.calls[0][2]).toEqual({
			selector: "litellm/gpt-5.6-sol",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("applies an explicit post-login choice over the existing session model", async () => {
		const { session, setModel } = makeSession({
			model: M("existing"),
			models: [M("claude-opus-5", "anthropic")],
		});
		const applied = await applyModelAfterLogin(session as never, OPUS_CHOICE);
		expect(applied).toBe(true);
		expect(setModel).toHaveBeenCalledWith(
			M("claude-opus-5", "anthropic"),
			"default",
			expect.objectContaining({ selector: "anthropic/claude-opus-5" }),
		);
	});

	it("requires the selected provider and model pair to resolve", async () => {
		const { session, setModel } = makeSession({
			model: undefined,
			models: [M("claude-opus-5", "litellm")],
		});
		const applied = await applyModelAfterLogin(session as never, OPUS_CHOICE);
		expect(applied).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("resolves a missing vLLM choice level to provider-default thinking", async () => {
		const model = M("metadata-free", "vllm");
		const { session, setModel, setThinkingLevel } = makeSession({ models: [model] });
		const [choice] = getVllmLoginModelChoices([{ id: "metadata-free" }]);

		await expect(applyModelAfterLogin(session as never, choice!)).resolves.toBe(true);
		expect(setModel).toHaveBeenCalledWith(model, "default", {
			selector: "vllm/metadata-free",
			thinkingLevel: ThinkingLevel.Inherit,
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("resolves a missing vLLM choice level to off only when canonical metadata supports none", async () => {
		const model = {
			...M("explicit-off", "vllm"),
			reasoning: true,
			thinking: createThinkingConfig([ReasoningEffort.None, Effort.High]),
		};
		const { session, setModel } = makeSession({ models: [model] });
		const [choice] = getVllmLoginModelChoices([{ id: "explicit-off" }]);

		await expect(applyModelAfterLogin(session as never, choice!)).resolves.toBe(true);
		expect(setModel).toHaveBeenCalledWith(model, "default", {
			selector: "vllm/explicit-off",
			thinkingLevel: ThinkingLevel.Off,
		});
	});

	it("preserves explicit reasoning and compatibility metadata while inheriting provider thinking", async () => {
		const model = {
			...M("reasoning-default", "vllm"),
			reasoning: true,
			thinking: createThinkingConfig([Effort.Low, Effort.High], "effort", Effort.High),
			compat: { supportsReasoningEffort: true, supportsTemperature: false },
		};
		const { session, setModel } = makeSession({ models: [model] });
		const [choice] = getVllmLoginModelChoices([{ id: "reasoning-default" }]);

		await expect(applyModelAfterLogin(session as never, choice!)).resolves.toBe(true);
		expect(setModel.mock.calls[0]?.[0]).toBe(model);
		expect(setModel.mock.calls[0]?.[2]).toEqual({
			selector: "vllm/reasoning-default",
			thinkingLevel: ThinkingLevel.Inherit,
		});
		expect(model).toMatchObject({
			thinking: createThinkingConfig([Effort.Low, Effort.High], "effort", Effort.High),
			compat: { supportsReasoningEffort: true, supportsTemperature: false },
		});
	});
});

describe("getAvailableLiteLLMLoginModelChoices", () => {
	it("returns only curated models advertised by the authenticated catalog", () => {
		const choices = getAvailableLiteLLMLoginModelChoices(["gpt-5.6-sol", "unrelated-model"]);
		expect(choices).toEqual([GPT_CHOICE]);
	});

	it("puts the vision-capable production default first in the stable display order", () => {
		const choices = getAvailableLiteLLMLoginModelChoices(["claude-opus-5", "gpt-5.6-sol"]);
		expect(choices).toEqual([GPT_CHOICE, OPUS_CHOICE]);
	});

	it("returns no choices when neither curated model is advertised", () => {
		expect(getAvailableLiteLLMLoginModelChoices(["gpt-5.6-terra"])).toEqual([]);
	});
});

describe("getVllmLoginModelChoices", () => {
	it("creates provider-scoped choices from only the discovered vLLM catalog", () => {
		expect(getVllmLoginModelChoices([{ id: "local-tool-model", contextWindow: 32_768 }, { id: "compact" }])).toEqual([
			{
				label: "local-tool-model",
				description: "32,768 token context",
				provider: "vllm",
				modelId: "local-tool-model",
			},
			{
				label: "compact",
				description: "Context limit not advertised; using compatibility defaults",
				provider: "vllm",
				modelId: "compact",
			},
		]);
	});
});

describe("formatLoginThinkingState", () => {
	it("distinguishes provider-default, off, and explicit thinking", () => {
		expect(formatLoginThinkingState(undefined)).toBe("provider default thinking");
		expect(formatLoginThinkingState(ThinkingLevel.Inherit)).toBe("provider default thinking");
		expect(formatLoginThinkingState(ThinkingLevel.Off)).toBe("thinking off");
		expect(formatLoginThinkingState(ThinkingLevel.High)).toBe("thinking high");
	});
});

describe("applyOAuthLoginModel", () => {
	it("persists Gemini 3.6 Flash High after Google Antigravity login", async () => {
		const { session, setModel, setThinkingLevel, getModelRoles, getRoutingProfile } = makeSession({
			model: M("gpt-5.6-sol"),
			models: [
				M("gemini-3.6-flash-high", "google-antigravity"),
				M("gemini-3.1-pro-high-vertex", "google-antigravity"),
			],
		});

		const applied = await applyOAuthLoginModel(session as never, "google-antigravity");

		expect(applied).toEqual(GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE);
		expect(setModel).toHaveBeenCalledWith(M("gemini-3.6-flash-high", "google-antigravity"), "default", {
			selector: "google-antigravity/gemini-3.6-flash-high",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(getModelRoles()).toMatchObject({
			default: "google-antigravity/gemini-3.6-flash-high:high",
			plan: "google-antigravity/gemini-3.1-pro-high-vertex:high",
			vision: "google/vision",
		});
		expect(getRoutingProfile()).toBe("google-antigravity");
	});

	it("does not apply the generic Gemini profile after enterprise login", async () => {
		const { session, setModel, setThinkingLevel } = makeSession({
			model: M("gpt-5.6-sol"),
			models: [
				M("gemini-3.6-flash-high", "google-antigravity"),
				M("gemini-3.1-pro-high-vertex", "google-antigravity"),
			],
		});

		const applied = await applyOAuthLoginModel(session as never, "google-antigravity-enterprise");

		expect(applied).toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not replace the current model when the preferred provider model is unavailable", async () => {
		const { session, setModel, setThinkingLevel } = makeSession({
			model: M("gpt-5.6-sol"),
			models: [M("gemini-3-flash", "google-antigravity")],
		});

		const applied = await applyOAuthLoginModel(session as never, "google-antigravity");

		expect(applied).toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not apply a subscription profile from stale entitlement discovery", async () => {
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			models: [
				M("gemini-3.6-flash-high", "google-antigravity"),
				M("gemini-3.1-pro-high-vertex", "google-antigravity"),
			],
		});
		(session.modelRegistry as any).getProviderDiscoveryState = () => ({ status: "cached", stale: true });

		const result = await applyOAuthLoginModel(session as never, "google-antigravity");

		expect(result).toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});

	it("applies the complete Anthropic subscription profile with exact discovered IDs", async () => {
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			model: M("gpt-5.6-sol"),
			models: [
				M("claude-haiku-4-5-20251001", "anthropic"),
				M("claude-sonnet-5", "anthropic"),
				M("claude-opus-5", "anthropic"),
			],
		});
		(session.modelRegistry as any).getProviderDiscoveryState = () => ({
			status: "ok",
			stale: false,
			models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
		});

		const applied = await applyOAuthLoginModel(session as never, "anthropic");

		expect(applied).toMatchObject({
			provider: "anthropic",
			modelId: "claude-sonnet-5",
			thinkingLevel: ThinkingLevel.Medium,
		});
		expect(setModel).toHaveBeenCalledWith(M("claude-sonnet-5", "anthropic"), "default", {
			selector: "anthropic/claude-sonnet-5",
			thinkingLevel: ThinkingLevel.Medium,
		});
		expect(getModelRoles()).toMatchObject({
			smol: "anthropic/claude-haiku-4-5-20251001:low",
			default: "anthropic/claude-sonnet-5:medium",
			slow: "anthropic/claude-opus-5:high",
			plan: "anthropic/claude-opus-5:high",
			vision: "google/vision",
		});
		expect(getRoutingProfile()).toBe("anthropic");
		expect(getRoutingMode()).toBe("off");
	});

	it("keeps the prior state when Anthropic inventory is stale or incomplete", async () => {
		const previousModel = M("existing", "openai");
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			model: previousModel,
			models: [M("claude-haiku-4-5", "anthropic"), M("claude-opus-5", "anthropic")],
		});
		(session.modelRegistry as any).getProviderDiscoveryState = () => ({
			status: "ok",
			stale: false,
			models: ["claude-haiku-4-5", "claude-opus-5"],
		});
		await expect(applyOAuthLoginModel(session as never, "anthropic")).resolves.toBeUndefined();
		expect(session.model).toBe(previousModel);
		expect(setModel).not.toHaveBeenCalled();
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});

	it("applies the complete OpenAI Codex subscription profile", async () => {
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			model: undefined,
			models: [
				M("gpt-5.6-luna", "openai-codex"),
				M("gpt-5.6-terra", "openai-codex"),
				M("gpt-5.6-sol", "openai-codex"),
			],
		});

		const applied = await applyOAuthLoginModel(session as never, "openai-codex");

		expect(applied).toEqual(OPENAI_CODEX_LOGIN_MODEL_CHOICE);
		expect(OPENAI_CODEX_LOGIN_MODEL_CHOICE).toMatchObject({
			label: "GPT-5.6 Terra",
			modelId: "gpt-5.6-terra",
			thinkingLevel: ThinkingLevel.Medium,
		});
		expect(setModel).toHaveBeenCalledWith(M("gpt-5.6-terra", "openai-codex"), "default", {
			selector: "openai-codex/gpt-5.6-terra",
			thinkingLevel: ThinkingLevel.Medium,
		});
		expect(getModelRoles()).toMatchObject({
			smol: "openai-codex/gpt-5.6-luna:low",
			default: "openai-codex/gpt-5.6-terra:medium",
			slow: "openai-codex/gpt-5.6-sol:high",
			plan: "openai-codex/gpt-5.6-sol:high",
		});
		expect(getRoutingProfile()).toBe("openai-codex");
		expect(getRoutingMode()).toBe("off");
	});

	it("leaves model, roles, routing, and profile intact when Terra is missing", async () => {
		const previousModel = M("existing", "anthropic");
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			model: previousModel,
			models: [M("gpt-5.6-luna", "openai-codex"), M("gpt-5.6-sol", "openai-codex")],
		});

		await expect(applyOAuthLoginModel(session as never, "openai-codex")).resolves.toBeUndefined();
		expect(session.model).toBe(previousModel);
		expect(setModel).not.toHaveBeenCalled();
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});

	it("leaves the OpenAI profile intact when authenticated discovery is stale", async () => {
		const previousModel = M("existing", "anthropic");
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode } = makeSession({
			model: previousModel,
			models: [
				M("gpt-5.6-luna", "openai-codex"),
				M("gpt-5.6-terra", "openai-codex"),
				M("gpt-5.6-sol", "openai-codex"),
			],
		});
		(session.modelRegistry as any).getProviderDiscoveryState = () => ({ status: "cached", stale: true });

		await expect(applyOAuthLoginModel(session as never, "openai-codex")).resolves.toBeUndefined();
		expect(session.model).toBe(previousModel);
		expect(setModel).not.toHaveBeenCalled();
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});

	it("rolls roles and routing back when the Terra model cannot be persisted", async () => {
		const previousModel = M("existing", "anthropic");
		const { session, setModelTemporary, getModelRoles, getRoutingProfile, getRoutingMode, getThinkingLevel } =
			makeSession({
				model: previousModel,
				thinkingLevel: ThinkingLevel.Low,
				models: [
					M("gpt-5.6-luna", "openai-codex"),
					M("gpt-5.6-terra", "openai-codex"),
					M("gpt-5.6-sol", "openai-codex"),
				],
			});
		(session as any).setModel = vi.fn(async (model: { id: string; provider: string }) => {
			session.model = model;
			session.thinkingLevel = ThinkingLevel.Medium;
			throw new Error("persistence failed");
		});

		await expect(applyOAuthLoginModel(session as never, "openai-codex")).rejects.toThrow("persistence failed");
		expect(session.model).toBe(previousModel);
		expect(getThinkingLevel()).toBe(ThinkingLevel.Low);
		expect(setModelTemporary).toHaveBeenCalledWith(previousModel, ThinkingLevel.Low);
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});

	it("rolls the complete Anthropic profile back when settings persistence fails", async () => {
		const previousModel = M("existing", "openai");
		const { session, setModel, getModelRoles, getRoutingProfile, getRoutingMode, getThinkingLevel } = makeSession({
			model: previousModel,
			thinkingLevel: ThinkingLevel.Low,
			models: [
				M("claude-haiku-4-5", "anthropic"),
				M("claude-sonnet-5", "anthropic"),
				M("claude-opus-5", "anthropic"),
			],
		});
		(session.modelRegistry as any).getProviderDiscoveryState = () => ({
			status: "ok",
			stale: false,
			models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
		});
		const persist = session.settings.set;
		let failed = false;
		session.settings.set = (key: string, value: unknown) => {
			if (key === "routing.profile" && !failed) {
				failed = true;
				throw new Error("settings persistence failed");
			}
			persist(key, value);
		};

		await expect(applyOAuthLoginModel(session as never, "anthropic")).rejects.toThrow("settings persistence failed");
		expect(setModel).not.toHaveBeenCalled();
		expect(session.model).toBe(previousModel);
		expect(getThinkingLevel()).toBe(ThinkingLevel.Low);
		expect(getModelRoles()).toEqual({ vision: "google/vision" });
		expect(getRoutingProfile()).toBe("none");
		expect(getRoutingMode()).toBe("auto");
	});
});
