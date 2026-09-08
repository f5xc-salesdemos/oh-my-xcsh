import { beforeAll, describe, expect, it, vi } from "bun:test";
import { createThinkingConfig, Effort, type Model, ReasoningEffort } from "@f5-sales-demo/pi-ai";
import type { TUI } from "@f5-sales-demo/pi-tui";
import type { ModelRegistry, ProviderDiscoveryState } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	buildProviderModelGroups,
	filterCurrentBrowserModels,
	ModelSelectorComponent,
} from "../src/modes/components/model-selector";
import { initTheme } from "../src/modes/theme/theme";

const model = (provider: string, id: string, metadata: Partial<Model> = {}): Model =>
	({
		provider,
		id,
		name: metadata.name ?? id,
		...metadata,
	}) as Model;

const state = (
	provider: string,
	status: ProviderDiscoveryState["status"] = "ok",
	stale = false,
): ProviderDiscoveryState => ({ provider, status, stale, optional: false, models: [] });

beforeAll(() => initTheme());

describe("authenticated provider model groups", () => {
	it("groups both LiteLLM transports into one six-model tab", () => {
		const ids = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
		const claudeIds = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
		const metadata = (provider: string) => ({
			groupId: "litellm",
			groupLabel: "LiteLLM",
			sectionLabel: provider === "litellm" ? "OpenAI" : "Anthropic",
		});
		const groups = buildProviderModelGroups(
			[...ids.map(id => model("litellm", id)), ...claudeIds.map(id => model("anthropic", id))],
			provider => state(provider),
			[],
			"litellm",
			() => true,
			false,
			["litellm", "anthropic"],
			metadata,
			provider => ({
				provider,
				credentialSource: "configuration",
				status: "connected",
				catalogFreshness: "fresh",
				selectable: true,
			}),
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("LiteLLM");
		expect(groups[0]?.providers).toEqual(["litellm", "anthropic"]);
		expect(groups[0]?.stale).toBe(false);
		expect(groups[0]?.models).toHaveLength(6);
		expect(new Set(groups[0]?.models.map(item => item.sectionLabel))).toEqual(new Set(["OpenAI", "Anthropic"]));
	});

	it("keeps only current GPT and per-lineage Gemini families in the browser", () => {
		const filtered = filterCurrentBrowserModels([
			model("openai-codex", "gpt-5.5"),
			model("openai-codex", "gpt-5.6-sol"),
			model("openai-codex", "gpt-5.6-terra"),
			model("openai-codex", "gpt-5.6-luna"),
			model("google-vertex", "gemini-2.5-flash"),
			model("google-vertex", "gemini-3.8-flash"),
			model("google-antigravity", "gemini-3.6-flash-tiered"),
			model("google-antigravity", "gemini-3.7-flash-tiered"),
			model("google-antigravity", "gemini-3-pro-high"),
			model("google-antigravity", "gemini-3.1-pro-high"),
			model("google-vertex", "gemini-3-pro-preview"),
			model("google-vertex", "gemini-3.1-pro-preview"),
			model("google-vertex", "gemini-3.1-pro-preview-customtools"),
			model("google-antigravity", "claude-sonnet-4-5-thinking"),
			model("google-antigravity", "claude-sonnet-4-6"),
			model("google-antigravity", "claude-sonnet-4-6-thinking"),
			model("google-antigravity", "gpt-oss-120b-medium"),
			model("google-antigravity", "tab_flash_lite_preview"),
			model("github-copilot", "gpt-5.4"),
			model("github-copilot", "gpt-5.6-sol"),
		]);
		expect(filtered.map(item => `${item.provider}/${item.id}`)).toEqual([
			"openai-codex/gpt-5.6-sol",
			"openai-codex/gpt-5.6-terra",
			"openai-codex/gpt-5.6-luna",
			"google-vertex/gemini-3.8-flash",
			"google-antigravity/gemini-3.7-flash-tiered",
			"google-antigravity/gemini-3.1-pro-high",
			"google-vertex/gemini-3.1-pro-preview",
			"google-vertex/gemini-3.1-pro-preview-customtools",
			"google-antigravity/claude-sonnet-4-6",
			"google-antigravity/claude-sonnet-4-6-thinking",
			"google-antigravity/gpt-oss-120b-medium",
			"github-copilot/gpt-5.6-sol",
		]);
	});

	it("preserves historical models when an explicit --models scope requests them", () => {
		const groups = buildProviderModelGroups(
			[model("openai-codex", "gpt-5.5")],
			provider => state(provider),
			[],
			"openai-codex",
			() => true,
			false,
		);
		expect(groups[0]?.models.map(item => item.selector)).toEqual(["openai-codex/gpt-5.5"]);
	});

	it("admits successful and cached authenticated catalogs, retains failures, and separates local runtimes", () => {
		const models = [
			model("openai-codex", "gpt-5.6-sol"),
			model("google-vertex", "gemini-3.8-flash"),
			model("google-antigravity", "gemini-3.7-flash-tiered"),
			model("anthropic", "claude-sonnet-4-6"),
			model("ollama", "qwen3:8b"),
			model("vllm", "local-gpt"),
		];
		const states = new Map([
			["openai-codex", state("openai-codex")],
			["google-vertex", state("google-vertex", "cached", true)],
			["google-antigravity", state("google-antigravity", "cached", true)],
			["anthropic", state("anthropic", "unavailable", true)],
			["ollama", state("ollama")],
			["vllm", state("vllm", "cached", true)],
		]);

		const groups = buildProviderModelGroups(
			models,
			provider => states.get(provider),
			[],
			"google-vertex",
			provider => provider !== "google-antigravity",
		);
		expect(groups.map(group => group.id)).toEqual(["google-vertex", "anthropic", "openai-codex", "local-providers"]);
		expect(groups[0]?.label).toBe("Google Vertex");
		expect(groups[0]?.stale).toBe(true);
		expect(groups[3]?.models.map(item => item.provider)).toEqual(["ollama", "vllm"]);
		expect(groups[3]?.discoveryStatus).toBe("cached");
		expect(groups[3]?.stale).toBe(true);
		expect(groups.flatMap(group => group.models).some(item => item.provider === "anthropic")).toBe(true);
		expect(groups.flatMap(group => group.models).some(item => item.provider === "google-antigravity")).toBe(false);
	});

	it("uses configured-provider order before display-name order when the current provider is absent", () => {
		const models = [
			model("openai-codex", "gpt-5.6-sol"),
			model("google-vertex", "gemini-3.8-flash"),
			model("anthropic", "claude-sonnet-4-6"),
		];
		const groups = buildProviderModelGroups(models, provider => state(provider), ["google-vertex"]);
		expect(groups.map(group => group.id)).toEqual(["google-vertex", "anthropic", "openai-codex"]);
		expect(groups[1]?.label).toBe("Anthropic / Claude");
	});
});

function selectorHarness(
	currentModel?: Model,
	options: {
		staleVertex?: boolean;
		antigravity?: boolean;
		refreshProvider?: () => Promise<void>;
		providerAllowlist?: string[];
	} = {},
) {
	const sol = model("openai-codex", "gpt-5.6-sol", {
		name: "GPT-5.6-Sol",
		publisher: "OpenAI",
		family: "GPT-5.6",
		tier: "Sol",
		reasoning: true,
		thinking: createThinkingConfig([
			ReasoningEffort.None,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]),
	});
	const terra = model("openai-codex", "gpt-5.6-terra", {
		name: "GPT-5.6-Terra",
		publisher: "OpenAI",
		family: "GPT-5.6",
		tier: "Terra",
	});
	const luna = model("openai-codex", "gpt-5.6-luna", {
		name: "GPT-5.6-Luna",
		publisher: "OpenAI",
		family: "GPT-5.6",
		tier: "Luna",
	});
	const vertex = model("google-vertex", "gemini-3.8-flash", {
		name: "Gemini 3.8 Flash",
		reasoning: true,
		thinking: createThinkingConfig([Effort.Low, Effort.Medium, Effort.High]),
	});
	const ollama = model("ollama", "qwen3:8b", { name: "Qwen 3 8B", publisher: "Qwen", family: "Qwen 3" });
	const models = [
		sol,
		terra,
		luna,
		model("openai-codex", "gpt-5.5", { name: "GPT-5.5" }),
		vertex,
		model("google-vertex", "gemini-2.5-flash", { name: "Gemini 2.5 Flash" }),
		model("google-antigravity", "gemini-3.1-pro-high-vertex", {
			name: "Gemini 3.1 Pro High (Vertex, Antigravity)",
		}),
		ollama,
	];
	const states = new Map([
		["openai-codex", state("openai-codex")],
		["google-vertex", state("google-vertex", options.staleVertex ? "cached" : "ok", options.staleVertex ?? false)],
		["google-antigravity", state("google-antigravity")],
		["ollama", state("ollama")],
	]);
	const refreshProvider = vi.fn(options.refreshProvider ?? (async () => undefined));
	const registry = {
		authStorage: { hasAuth: (provider: string) => provider !== "google-antigravity" || options.antigravity === true },
		refresh: vi.fn(async () => undefined),
		refreshProvider,
		getError: () => undefined,
		getAll: () => models,
		getAvailable: () => models,
		getProviderDiscoveryState: (provider: string) => states.get(provider),
		getProviderAccessState: (provider: string) => ({
			provider,
			credentialSource: provider === "ollama" ? "keyless" : "stored-oauth",
			status: provider === "google-vertex" && options.staleVertex ? "unreachable" : "connected",
			catalogFreshness: provider === "google-vertex" && options.staleVertex ? "stale" : "fresh",
			selectable: !(provider === "google-vertex" && options.staleVertex),
		}),
	} as unknown as ModelRegistry;
	const onSelect = vi.fn();
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		currentModel ?? sol,
		Settings.isolated({ modelProviderAllowlist: options.providerAllowlist ?? [] }),
		registry,
		[],
		onSelect,
		() => {},
		{ temporaryOnly: true },
	);
	return { selector, onSelect, refreshProvider };
}

describe("provider-tab model selector", () => {
	it("renders Claude tier labels, role badges, and canonical thinking choices", async () => {
		const haiku = model("anthropic", "claude-haiku-4-5-20251001", {
			name: "Claude Haiku 4.5",
			reasoning: true,
			thinking: createThinkingConfig([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]),
		});
		const sonnet = model("anthropic", "claude-sonnet-5", {
			name: "Claude Sonnet 5",
			reasoning: true,
			thinking: createThinkingConfig([
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			]),
		});
		const opus = model("anthropic", "claude-opus-5", { name: "Claude Opus 5" });
		const models = [haiku, sonnet, opus];
		const settings = Settings.isolated({
			modelRoles: {
				smol: "anthropic/claude-haiku-4-5-20251001:low",
				default: "anthropic/claude-sonnet-5:medium",
				slow: "anthropic/claude-opus-5:high",
				plan: "anthropic/claude-opus-5:high",
			},
		});
		const registry = {
			authStorage: { hasAuth: () => true },
			refresh: vi.fn(async () => undefined),
			refreshProvider: vi.fn(async () => undefined),
			getError: () => undefined,
			getAll: () => models,
			getAvailable: () => models,
			getProviderDiscoveryState: () => state("anthropic"),
		} as unknown as ModelRegistry;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			sonnet,
			settings,
			registry,
			[],
			vi.fn(),
			() => {},
			{ temporaryOnly: true },
		);
		await Bun.sleep(0);
		let rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).toContain("Models:   Anthropic / Claude");
		expect(rendered).toContain("Anthropic › Claude");
		expect(rendered).toContain("Claude Haiku 4.5 [anthropic/claude-haiku-4-5-20251001]");
		expect(rendered).toContain("Claude Sonnet 5 [anthropic/claude-sonnet-5]");
		expect(rendered).toContain("Claude Opus 5 [anthropic/claude-opus-5]");
		expect(rendered).toContain("SMOL");
		expect(rendered).toContain("DEFAULT");
		expect(rendered).toContain("SLOW");
		expect(rendered).toContain("PLAN");

		for (const character of "sonnet") selector.handleInput(character);
		selector.handleInput("\r");
		selector.handleInput("\r");
		rendered = Bun.stripANSI(selector.render(100).join("\n"));
		for (const effort of ["min", "low", "medium", "high", "xhigh", "max"]) {
			expect(rendered).toContain(`${effort} —`);
		}
		expect(rendered).not.toContain("off —");
	});

	it("renders provider hierarchy and exact ChatGPT tier selectors without legacy tabs", async () => {
		const { selector } = selectorHarness();
		await Bun.sleep(0);
		const rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).not.toContain("Only showing models from configured providers");
		expect(rendered).toContain("ChatGPT Subscription");
		expect(rendered).toContain("OpenAI › GPT-5.6");
		expect(rendered.match(/OpenAI › GPT-5\.6/g)).toHaveLength(1);
		expect(rendered).toContain("GPT-5.6 Sol [openai-codex/gpt-5.6-sol]");
		expect(rendered).toContain("GPT-5.6 Terra [openai-codex/gpt-5.6-terra]");
		expect(rendered).toContain("GPT-5.6 Luna [openai-codex/gpt-5.6-luna]");
		expect(rendered).not.toContain("QUICK");
		expect(rendered).not.toContain("ALL MODELS");
		expect(rendered).not.toContain("Gemini 3.8 Flash");
	});

	it("applies the normal picker allowlist without changing explicit model resolution", async () => {
		const { selector } = selectorHarness(undefined, { providerAllowlist: ["google-vertex"] });
		await Bun.sleep(0);
		const rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).toContain("Models:   Google Vertex");
		expect(rendered).not.toContain("ChatGPT Subscription");
		expect(rendered).not.toContain("Only showing models from configured providers");
	});

	it("searches globally, groups providers, and clearing restores the active provider", async () => {
		const { selector } = selectorHarness();
		await Bun.sleep(0);
		for (const character of "gemini") selector.handleInput(character);
		let rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).toContain("Google Vertex › Google › Gemini 3.8");
		expect(rendered).toContain("google-vertex/gemini-3.8-flash");
		for (let index = 0; index < 6; index += 1) selector.handleInput("\x7f");
		rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).toContain("GPT-5.6 Sol");
		expect(rendered).not.toContain("Gemini 3.8 Flash");
	});

	it("allows exact provider selectors containing the secondary-role shortcut", async () => {
		const { selector } = selectorHarness(undefined, { antigravity: true });
		await Bun.sleep(0);
		for (const character of "google-vertex/gemini-3.8-flash") selector.handleInput(character);
		const rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(selector.getSearchInput().getValue()).toBe("google-vertex/gemini-3.8-flash");
		expect(rendered).toContain("Google Vertex › Google › Gemini 3.8");
		expect(rendered).not.toContain("Action for:");
		expect(rendered).not.toContain("google-antigravity/");
	});

	it("does not return non-current catalog versions through global search", async () => {
		const { selector } = selectorHarness();
		await Bun.sleep(0);
		for (const character of "gemini-2.5-flash") selector.handleInput(character);
		const rendered = Bun.stripANSI(selector.render(180).join("\n"));
		expect(rendered).toContain("No matching models");
		expect(rendered).not.toContain("google-vertex/gemini-2.5-flash");
	});

	it("describes retained cached inventory and refreshes it with Ctrl+R", async () => {
		const current = model("google-vertex", "gemini-3.8-flash");
		let finishRefresh: (() => void) | undefined;
		const pendingRefresh = new Promise<void>(resolve => {
			finishRefresh = resolve;
		});
		const { selector, refreshProvider } = selectorHarness(current, {
			staleVertex: true,
			refreshProvider: () => pendingRefresh,
		});
		await Bun.sleep(0);
		let rendered = Bun.stripANSI(selector.render(120).join("\n"));
		expect(rendered).toContain("Google Vertex");
		expect(rendered).not.toContain("Google Vertex (stale)");
		expect(rendered).toContain("Refreshing Google Vertex model list");
		expect(rendered).toContain("Ctrl+R: refresh");

		selector.handleInput("\x12");
		await Bun.sleep(0);
		expect(refreshProvider).toHaveBeenCalledWith("google-vertex", "online");
		rendered = Bun.stripANSI(selector.render(120).join("\n"));
		expect(rendered).toContain("Refreshing Google Vertex model list");

		finishRefresh?.();
		await Bun.sleep(0);
	});

	it("never activates a stale disabled row", async () => {
		const current = model("google-vertex", "gemini-3.8-flash");
		const { selector, onSelect } = selectorHarness(current, { staleVertex: true });
		await Bun.sleep(0);
		const rendered = Bun.stripANSI(selector.render(120).join("\n"));
		expect(rendered).toContain("Gemini 3.8 Flash");
		expect(rendered).toContain("unavailable");

		selector.handleInput("\r");
		selector.handleInput("\r");
		selector.handleInput("\r");
		await Bun.sleep(0);

		expect(onSelect).not.toHaveBeenCalled();
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("Action for:");
	});

	it("supports keyboard tab navigation and narrow rendering", async () => {
		const { selector, refreshProvider } = selectorHarness();
		await Bun.sleep(0);
		selector.handleInput("\t");
		await Bun.sleep(0);
		const vertex = Bun.stripANSI(selector.render(52).join("\n"));
		expect(vertex).toContain("Gemini 3.8 Flash");
		expect(vertex).not.toContain("GPT-5.6 Sol");
		expect(refreshProvider).toHaveBeenCalledWith("google-vertex", "online");

		selector.handleInput("\t");
		await Bun.sleep(0);
		const local = Bun.stripANSI(selector.render(52).join("\n"));
		expect(local).toContain("Local Providers");
		expect(local).toContain("Ollama › Qwen › Qwen 3");
		expect(local).toContain("ollama/qwen3:8b");
	});

	it("uses Gemini's provider-specific thinking levels instead of the OpenAI effort ladder", async () => {
		const { selector } = selectorHarness();
		await Bun.sleep(0);
		selector.handleInput("\t");
		await Bun.sleep(0);
		selector.handleInput("\r");
		selector.handleInput("\r");
		const picker = Bun.stripANSI(selector.render(100).join("\n"));
		expect(picker).not.toContain("min —");
		expect(picker).toContain("low —");
		expect(picker).toContain("medium —");
		expect(picker).toContain("high —");
		expect(picker).not.toContain("off —");
		expect(picker).not.toContain("xhigh —");
		expect(picker).not.toContain("max —");
	});

	it("keeps exact reasoning metadata when selecting Sol", async () => {
		const { selector, onSelect } = selectorHarness();
		await Bun.sleep(0);
		for (const character of "sol") selector.handleInput(character);
		selector.handleInput("\r");
		selector.handleInput("\r");
		for (let index = 0; index < 5; index += 1) selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({ id: "gpt-5.6-sol" }),
				scope: "conversation",
				thinkingLevel: Effort.XHigh,
				selector: "openai-codex/gpt-5.6-sol",
			}),
		);
	});
});

it("keeps model rows and panel height fixed while the refresh spinner advances and settles", async () => {
	let pending: Promise<void> | undefined;
	const { selector } = selectorHarness(undefined, {
		refreshProvider: async () => {
			await pending;
		},
	});
	await Bun.sleep(20);
	const before = new Map([52, 120].map(width => [width, Bun.stripANSI(selector.render(width).join("\n"))]));
	const gate = Promise.withResolvers<void>();
	pending = gate.promise;
	selector.handleInput("\x12");
	await Bun.sleep(10);
	const first = Bun.stripANSI(selector.render(120).join("\n"));
	await Bun.sleep(120);
	const second = Bun.stripANSI(selector.render(120).join("\n"));
	try {
		expect(first).not.toBe(second);
		for (const [width, idle] of before) {
			const refreshing = Bun.stripANSI(selector.render(width).join("\n"));
			expect(refreshing.split("\n").length).toBe(idle.split("\n").length);
			expect(refreshing.split("\n").findIndex(line => line.includes("GPT-5.6 Sol"))).toBe(
				idle.split("\n").findIndex(line => line.includes("GPT-5.6 Sol")),
			);
		}
	} finally {
		gate.resolve();
	}
	await Bun.sleep(20);
	for (const [width, idle] of before) {
		expect(Bun.stripANSI(selector.render(width).join("\n"))).toBe(idle);
	}
});
