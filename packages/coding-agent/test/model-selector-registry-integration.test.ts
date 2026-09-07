import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@f5-sales-demo/pi-tui";
import { hookFetch } from "@f5-sales-demo/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { ModelSelectorComponent } from "../src/modes/components/model-selector";
import { initTheme } from "../src/modes/theme/theme";
import { AuthStorage } from "../src/session/auth-storage";

beforeAll(() => initTheme());
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

async function harness() {
	const dir = mkdtempSync(join(tmpdir(), "selector-registry-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const auth = await AuthStorage.create(join(dir, "auth.db"));
	cleanup.push(() => auth.close());
	auth.setRuntimeApiKey("google-vertex", "test-token");
	auth.setRuntimeApiKey("test-cloud", "test-token");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				"test-cloud": {
					baseUrl: "http://test.invalid/v1",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
				ollama: {
					baseUrl: "http://local.invalid/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-compat" },
				},
			},
		}),
	);
	const response = { ids: ["test-model"], fail: false, wait: undefined as Promise<void> | undefined };
	const unhook = hookFetch(async () => {
		const ids = [...response.ids];
		if (response.wait) await response.wait;
		if (response.fail) throw new Error("controlled outage");
		return Response.json({ data: ids.map(id => ({ id })) });
	});
	cleanup.push(() => unhook[Symbol.dispose]());
	const registry = new ModelRegistry(auth, join(dir, "models.json"));
	await registry.refreshProvider("google-vertex");
	await registry.refreshProvider("test-cloud");
	const onSelect = vi.fn();
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		registry.find("google-vertex", "gemini-3.8-flash"),
		Settings.isolated(),
		registry,
		[],
		onSelect,
		() => {},
	);
	await Bun.sleep(20);
	return { registry, selector, response, auth, onSelect, dir };
}

describe("real registry and provider picker", () => {
	test("retains unrelated live discovery state through repeated cloud and local refreshes", async () => {
		const { registry, selector } = await harness();
		await registry.refreshProvider("google-vertex");
		const before = registry.getProviderDiscoveryState("google-vertex");
		const model = registry.find("google-vertex", "gemini-3.8-flash");
		for (let i = 0; i < 3; i++) {
			await registry.refreshProvider("test-cloud");
			await registry.refreshProvider("ollama");
			expect(registry.getProviderDiscoveryState("google-vertex")).toEqual(before);
			expect(registry.find("google-vertex", "gemini-3.8-flash")).toBe(model);
			selector.handleInput("\t");
			await Bun.sleep(20);
			expect(Bun.stripANSI(selector.render(160).join("\n"))).toContain("Google Vertex");
		}
	});
});

test("ordered overlapping refreshes cannot restore an older catalog; empty results remove stale models", async () => {
	const { registry, response } = await harness();
	const gate = Promise.withResolvers<void>();
	response.wait = gate.promise;
	response.ids = ["old-model"];
	const older = registry.refreshProvider("test-cloud");
	await Bun.sleep(10);
	response.ids = ["new-model"];
	const newer = registry.refreshProvider("test-cloud");
	gate.resolve();
	response.wait = undefined;
	await Promise.all([older, newer]);
	expect(registry.getProviderDiscoveryState("test-cloud")?.models).toEqual(["new-model"]);
	expect(registry.find("test-cloud", "old-model")).toBeUndefined();
	response.ids = [];
	await registry.refreshProvider("test-cloud");
	expect(registry.getProviderDiscoveryState("test-cloud")).toMatchObject({ status: "ok", models: [] });
	expect(registry.find("test-cloud", "new-model")).toBeUndefined();
});
test("failed discovery retains cached models and reports the failure", async () => {
	const { registry, response } = await harness();
	await registry.refreshProvider("test-cloud");
	response.fail = true;
	await registry.refreshProvider("test-cloud");
	expect(registry.getProviderDiscoveryState("test-cloud")).toMatchObject({
		status: "cached",
		stale: true,
		error: "controlled outage",
	});
	expect(registry.find("test-cloud", "test-model")).toBeDefined();
});

test("configured provider survives logout and discovers models after authentication without restart", async () => {
	const { registry, auth } = await harness();
	auth.removeRuntimeApiKey("test-cloud");
	await registry.refreshProvider("test-cloud");
	expect(registry.getProviderInventory()).toContain("test-cloud");
	expect(registry.getProviderDiscoveryState("test-cloud")?.status).toBe("unauthenticated");
	auth.setRuntimeApiKey("test-cloud", "new-test-key");
	await registry.refreshProvider("test-cloud");
	expect(registry.getProviderDiscoveryState("test-cloud")?.status).toBe("ok");
	expect(registry.find("test-cloud", "test-model")).toBeDefined();
});

test("refresh cannot change the exact model held by an open confirmation", async () => {
	const { registry, selector, response, onSelect } = await harness();
	selector.handleInput("\t");
	await registry.refreshProvider("test-cloud");
	await Bun.sleep(10);
	const gate = Promise.withResolvers<void>();
	response.wait = gate.promise;
	response.ids = ["replacement-model"];
	selector.handleInput("\x12");
	selector.handleInput("\r");
	gate.resolve();
	response.wait = undefined;
	await registry.refreshProvider("test-cloud");
	await Bun.sleep(10);
	selector.handleInput("\r");
	selector.handleInput("\r");
	expect(onSelect).toHaveBeenCalledWith(
		expect.objectContaining({ selector: "test-cloud/test-model", scope: "conversation" }),
	);
});

test("disabled providers are excluded from inventory and cannot be refreshed", async () => {
	const { registry, dir } = await harness();
	_resetSettingsForTest();
	cleanup.push(_resetSettingsForTest);
	const settings = await Settings.init({ cwd: dir, agentDir: dir });
	settings.set("disabledProviders", ["google-vertex"]);
	const state = registry.getProviderDiscoveryState("google-vertex");
	expect(registry.getProviderInventory()).not.toContain("google-vertex");
	expect(registry.getAvailable().some(model => model.provider === "google-vertex")).toBe(false);
	await registry.refreshProvider("google-vertex");
	expect(registry.getProviderDiscoveryState("google-vertex")).toEqual(state);
	await settings.flush();
});
