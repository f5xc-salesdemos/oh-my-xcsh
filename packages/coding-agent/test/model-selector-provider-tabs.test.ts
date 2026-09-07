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
	options: { staleVertex?: boolean; antigravity?: boolean; refreshProvider?: () => Promise<void> } = {},
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
	} as unknown as ModelRegistry;
	const onSelect = vi.fn();
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		currentModel ?? sol,
		Settings.isolated(),
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
		expect(rendered).toContain("Only showing models from configured providers (see README for details)");
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
