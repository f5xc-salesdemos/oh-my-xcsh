import { beforeAll, expect, test, vi } from "bun:test";
import { getBundledModel } from "@f5-sales-demo/pi-ai";
import type { TUI } from "@f5-sales-demo/pi-tui";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ModelSelectorComponent } from "../src/modes/components/model-selector";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => initTheme());
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
function harness(onSelect = vi.fn()) {
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		model,
		Settings.isolated(),
		{ getAll: () => [model] } as unknown as ModelRegistry,
		[{ model, thinkingLevel: "off" }],
		onSelect,
		vi.fn(),
	);
	return { selector, onSelect };
}
test("Enter offers explicit scope and preselects conversation without applying anything", async () => {
	const { selector, onSelect } = harness();
	await Bun.sleep(0);
	selector.handleInput("\r");
	const rendered = Bun.stripANSI(selector.render(100).join("\n"));
	expect(rendered).toContain("Use in this conversation");
	expect(rendered).toContain("Save as default");
	expect(rendered).toContain("Assign to role");
	expect(onSelect).not.toHaveBeenCalled();
	selector.handleInput("\r");
	selector.handleInput("\r");
	await Bun.sleep(0);
	expect(onSelect).toHaveBeenCalledWith(
		expect.objectContaining({ scope: "conversation", selector: "anthropic/claude-sonnet-4-5" }),
	);
});
test("Escape leaves an unfinished scope selection unapplied", async () => {
	const { selector, onSelect } = harness();
	await Bun.sleep(0);
	selector.handleInput("\r");
	selector.handleInput("\r");
	selector.handleInput("\x1b");
	selector.handleInput("\x1b");
	expect(onSelect).not.toHaveBeenCalled();
});

test("failed asynchronous role persistence leaves badges unchanged and allows retry", async () => {
	const gate = Promise.withResolvers<void>();
	const onSelect = vi.fn(() => gate.promise);
	const { selector } = harness(onSelect);
	await Bun.sleep(0);
	selector.handleInput("\r");
	selector.handleInput("\x1b[B");
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	selector.handleInput("\r");
	expect(onSelect).toHaveBeenCalledTimes(1);
	selector.handleInput("\r");
	expect(onSelect).toHaveBeenCalledTimes(1);
	gate.reject(new Error("save failed"));
	await Bun.sleep(0);
	const rendered = Bun.stripANSI(selector.render(100).join("\n"));
	expect(rendered).toContain("save failed");
	expect(rendered).not.toContain("SMOL (inherit)");
});

test("saved default is an explicit scope and supported current reasoning is preselected", async () => {
	const { selector, onSelect } = harness();
	await Bun.sleep(0);
	selector.handleInput("\r");
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	selector.handleInput("\r");
	expect(onSelect).toHaveBeenCalledWith(
		expect.objectContaining({ scope: "default", selector: "anthropic/claude-sonnet-4-5" }),
	);
});

test("printable r begins a global search instead of applying a hidden role shortcut", async () => {
	const { selector } = harness();
	await Bun.sleep(0);
	selector.handleInput("r");
	expect(selector.getSearchInput().getValue()).toBe("r");
	expect(Bun.stripANSI(selector.render(52).join("\n"))).not.toContain("Action for:");
});

test("provider navigation renders while startup discovery is still pending", async () => {
	const pending = new Promise<void>(() => {});
	const registry = {
		getAll: () => [model],
		getAvailable: () => [model],
		getError: () => undefined,
		getProviderInventory: () => ["anthropic"],
		getProviderDiscoveryState: () => undefined,
		awaitBackgroundRefresh: () => pending,
		refreshProvider: () => pending,
	} as unknown as ModelRegistry;
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		model,
		Settings.isolated(),
		registry,
		[],
		vi.fn(),
		vi.fn(),
	);
	await Bun.sleep(0);
	const rendered = Bun.stripANSI(selector.render(80).join("\n"));
	expect(rendered).toContain("Anthropic / Claude");
	expect(rendered).toContain("Refreshing Anthropic / Claude");
	expect(rendered).toContain("Enter: choose");
});
