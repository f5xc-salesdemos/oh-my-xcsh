import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@f5-sales-demo/pi-ai";
import type { TUI } from "@f5-sales-demo/pi-tui";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ModelSelectorComponent } from "../src/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

function normalizeRenderedText(text: string): string {
	return (
		text
			// strip ANSI escapes
			.replace(/\x1b\[[0-9;]*m/g, "")
			// collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

function createSelector(model: Model, settings: Settings): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: "off" }],
		() => {},
		() => {},
	);
}

let testTheme = await getThemeByName("xcsh-dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector role badge thinking display", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("xcsh-dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("renders per-role thinking labels with inherit mode to avoid badge ambiguity", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				smol: `${model.provider}/${model.id}:minimal`,
				slow: `${model.provider}/${model.id}`,
				plan: `${model.provider}/${model.id}:high`,
				commit: `${model.provider}/${model.id}:medium`,
			},
		});

		const selector = createSelector(model, settings);

		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (inherit)");
		expect(rendered).toContain("SMOL (min)");
		expect(rendered).toContain("SLOW (inherit)");
		expect(rendered).toContain("PLAN (high)");
		expect(rendered).toContain("COMMIT (medium)");
		expect(rendered).not.toContain("Role Thinking:");

		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as DEFAULT (Default)");
		expect(menuRendered).toContain("Set as SMOL (Fast)");
		expect(menuRendered).toContain("Set as SLOW (Thinking)");
		expect(menuRendered).toContain("Set as PLAN (Architect)");
		expect(menuRendered).toContain("Set as COMMIT (Commit)");
	});

	test("shows custom roles from cycleOrder/modelRoles and honors built-in metadata overrides", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			cycleOrder: ["smol", "custom-fast", "default"],
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				"custom-fast": `${model.provider}/${model.id}:low`,
				smol: `${model.provider}/${model.id}`,
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		const selector = createSelector(model, settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("custom-fast (low)");
		expect(rendered).toContain("SMOL (inherit)");

		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as custom-fast");
		expect(menuRendered).toContain("Set as SMOL (Quick)");
	});

	test("finds a model by its displayed provider/model selector", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const selector = createSelector(model, Settings.isolated());
		await Bun.sleep(0);

		for (const character of `${model.provider}/${model.id}`) {
			selector.handleInput(character);
		}

		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain(`${model.provider}/${model.id}`);
		expect(rendered).not.toContain("No matching models");
	});
});
