import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createThinkingConfig,
	Effort,
	getBundledModel,
	type Model,
	type OpenAICompat,
	ReasoningEffort,
	type ThinkingConfig,
	writeModelCache,
} from "@f5-sales-demo/pi-ai";
import { hookFetch, Snowflake } from "@f5-sales-demo/pi-utils";
import { CURRENT_CONFIG_VERSION, generateModelsYml } from "../src/config/auto-config";
import {
	kNoAuth,
	MODEL_ROLES,
	ModelRegistry,
	resolveApiKeyConfig,
	resolveYamlApiKeyConfig,
	sanitizeProviderFailure,
} from "../src/config/model-registry";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;

	test("commit role includes a visible badge tag", () => {
		expect(MODEL_ROLES.commit.tag).toBe("COMMIT");
		expect(MODEL_ROLES.commit.color).toBe("dim");
	});

	test("records an authenticated Google Vertex catalog as successfully discovered", async () => {
		authStorage.setRuntimeApiKey("google-vertex", "authorized-test-token");
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refreshProvider("google-vertex", "online");

		expect(registry.getProviderDiscoveryState("google-vertex")).toMatchObject({
			provider: "google-vertex",
			status: "ok",
			stale: false,
		});
		expect(registry.getProviderDiscoveryState("google-vertex")?.models).toContain("gemini-3.8-flash");
		expect(registry.getProviderDiscoveryState("google-vertex")?.models).not.toContain("gemini-3.7-flash");
	});

	beforeEach(async () => {
		_resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		_resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	type ProviderConfig = {
		baseUrl: string;
		apiKey: string;
		api: string;
		models: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			thinking?: ThinkingConfig;
			input: string[];
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
			contextWindow: number;
			maxTokens: number;
		}>;
	};

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			thinking?: ThinkingConfig;
			contextWindow?: number;
		}>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map(m => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				thinking: m.thinking,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ProviderConfig>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function writeCachedOllamaModels(models: Model<"openai-completions">[]) {
		writeModelCache("ollama", Date.now(), models, true, cacheDbPath);
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function writeRawModelsConfig(config: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify(config));
	}

	function mockOpenAiCompatibleModels(url: string, modelIds: string[]) {
		return hookFetch(input => {
			const requestUrl = String(input);
			if (requestUrl === url) {
				return new Response(JSON.stringify({ data: modelIds.map(id => ({ id })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${requestUrl}`);
		});
	}

	describe("provider access state", () => {
		test("distinguishes runtime credentials, live validation, and sanitized failures", async () => {
			authStorage.setRuntimeApiKey("test-cloud", "runtime-secret");
			writeRawModelsJson({
				"test-cloud": {
					baseUrl: "https://models.example.test/v1",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getProviderAccessState("test-cloud")).toMatchObject({
				credentialSource: "runtime",
				status: "configured-unverified",
				catalogFreshness: "none",
				selectable: true,
			});

			const unhook = mockOpenAiCompatibleModels("https://models.example.test/v1/models", ["allowed"]);
			try {
				await registry.refreshProvider("test-cloud", "online");
			} finally {
				unhook[Symbol.dispose]();
			}
			expect(registry.getProviderAccessState("test-cloud")).toMatchObject({
				status: "connected",
				catalogFreshness: "fresh",
				selectable: true,
			});
		});

		test("identifies keyless providers without claiming they were validated", () => {
			writeRawModelsJson({
				vllm: {
					baseUrl: "http://vllm.example.test/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "local-model" }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getProviderAccessState("vllm")).toMatchObject({
				credentialSource: "keyless",
				status: "configured-unverified",
				selectable: true,
			});
		});

		test("does not leave providers without a discovery route in checking state", async () => {
			authStorage.setRuntimeApiKey("static-cloud", "runtime-secret");
			writeRawModelsJson({
				"static-cloud": providerConfig("https://models.example.test/v1", [{ id: "static-model" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("static-cloud", "online");

			expect(registry.getProviderAccessState("static-cloud")).toMatchObject({
				credentialSource: "runtime",
				status: "configured-unverified",
				selectable: true,
			});
		});

		test("classifies a rejected credential as requiring re-authentication", async () => {
			authStorage.setRuntimeApiKey("test-cloud", "revoked-secret");
			writeRawModelsJson({
				"test-cloud": {
					baseUrl: "https://models.example.test/v1",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});
			using _hook = hookFetch(input => {
				if (String(input) === "https://models.example.test/v1/models") {
					return new Response("Unauthorized", { status: 401 });
				}
				throw new Error(`Unexpected URL: ${String(input)}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			await registry.refreshProvider("test-cloud", "online");

			expect(registry.getProviderAccessState("test-cloud")).toMatchObject({
				status: "reauth-required",
				selectable: false,
			});
		});

		test("filters configured and discovered models and exposes picker metadata", () => {
			writeRawModelsJson({
				demo: {
					...providerConfig("https://demo.example.test/v1", [{ id: "allowed" }, { id: "blocked" }]),
					modelAllowlist: ["allowed"],
					picker: { groupId: "proxy", groupLabel: "Proxy", sectionLabel: "Demo" },
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "demo").map(model => model.id)).toEqual(["allowed"]);
			expect(registry.getProviderPickerMetadata("demo")).toEqual({
				groupId: "proxy",
				groupLabel: "Proxy",
				sectionLabel: "Demo",
			});
		});

		test("redacts tokens and query credentials from provider failures", () => {
			expect(sanitizeProviderFailure("401 Bearer secret-token https://x.test?api_key=secret-value")).toBe(
				"401 Bearer [redacted] https://x.test?api_key=[redacted]",
			);
		});
	});

	describe("canonical equivalence", () => {
		test("groups dotted provider variants under the bundled canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("collapses wrapped, dated, and tuned anthropic variants under the base canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-4.5" },
					{ id: "claude-opus-4-5-20251101" },
					{ id: "claude-4.5-opus-high-thinking" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-5");

			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-opus-4.5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-opus-4-5-20251101")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-4.5-opus-high-thinking")).toBe(true);
		});

		test("collapses gitlab duo chat wrapper ids into the upstream canonical id", () => {
			writeRawModelsJson({
				"gitlab-duo": providerConfig("https://demo.example.com/v1", [{ id: "duo-chat-opus-4-6" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-6");

			expect(variants.some(variant => variant.selector === "gitlab-duo/duo-chat-opus-4-6")).toBe(true);
		});

		test("collapses synthetic and vendor-prefixed glm wrappers into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "hf:zai-org/GLM-4.7" }, { id: "zai-glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "demo/hf:zai-org/GLM-4.7")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/zai-glm-4.7")).toBe(true);
		});

		test("collapses compact and reordered claude aliases into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "claude-opus-45" },
					{ id: "claude-4.5-sonnet" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const opusVariants = registry.getCanonicalVariants("claude-opus-4-5");
			const sonnetVariants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/claude-opus-45")).toBe(true);
			expect(sonnetVariants.some(variant => variant.selector === "demo/claude-4.5-sonnet")).toBe(true);
		});

		test("collapses nitro-suffixed OpenRouter variants under the upstream canonical id", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7-20251222:nitro" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "openrouter/z-ai/glm-4.7-20251222:nitro")).toBe(true);
		});

		test("collapses anthropic latest aliases into the best upstream claude family id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-latest" },
					{ id: "anthropic/claude-haiku-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// claude-opus-latest collapses to the newest opus family id in the bundled
			// catalog — currently claude-opus-5 (update when a newer opus ships).
			const opusVariants = registry.getCanonicalVariants("claude-opus-5");
			const haikuVariants = registry.getCanonicalVariants("claude-haiku-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/anthropic/claude-opus-latest")).toBe(true);
			expect(haikuVariants.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest")).toBe(true);
			expect(
				registry
					.getCanonicalVariants("claude-haiku-4-5-20251001-thinking")
					.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest"),
			).toBe(false);
		});

		test("collapses wrapped gemini tool and tuning variants under the base preview id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "google/gemini-3.1-pro-preview" },
					{ id: "google/gemini-3.1-pro-preview-customtools" },
					{ id: "google/gemini-3.1-pro-preview-high" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("gemini-3.1-pro-preview");

			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-customtools")).toBe(
				true,
			);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-high")).toBe(true);
		});

		test("collapses compact version aliases and hardware suffixes into clean canonical ids", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "hf:nvidia/Kimi-K2.5-NVFP4" },
					{ id: "kimi-k2-5" },
					{ id: "z-ai/glm4.7" },
					{ id: "z-ai/glm5" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const kimiVariants = registry.getCanonicalVariants("kimi-k2.5");
			const glm47Variants = registry.getCanonicalVariants("glm-4.7");
			const glm5Variants = registry.getCanonicalVariants("glm-5");

			expect(kimiVariants.some(variant => variant.selector === "demo/hf:nvidia/Kimi-K2.5-NVFP4")).toBe(true);
			expect(kimiVariants.some(variant => variant.selector === "demo/kimi-k2-5")).toBe(true);
			expect(glm47Variants.some(variant => variant.selector === "demo/z-ai/glm4.7")).toBe(true);
			expect(glm5Variants.some(variant => variant.selector === "demo/z-ai/glm5")).toBe(true);
		});

		test("prefers clean canonical ids over bundled wrapper ids when available", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "zai/glm-4.6v-flash" },
					{ id: "hf:deepseek-ai/DeepSeek-V3" },
					{ id: "google/gemini-pro-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(
				registry
					.getCanonicalVariants("glm-4.6v-flash")
					.some(variant => variant.selector === "demo/zai/glm-4.6v-flash"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("deepseek-v3")
					.some(variant => variant.selector === "demo/hf:deepseek-ai/DeepSeek-V3"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("gemini-pro")
					.some(variant => variant.selector === "demo/google/gemini-pro-latest"),
			).toBe(true);
		});

		test("applies explicit equivalence overrides from config", () => {
			writeRawModelsConfig({
				providers: {
					"p-anthropic": providerConfig("https://demo.example.com/v1", [{ id: "corp-sonnet" }]),
				},
				equivalence: {
					overrides: {
						"p-anthropic/corp-sonnet": "claude-sonnet-4-5",
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "p-anthropic/corp-sonnet")).toBe(true);
		});

		test("exclusions keep variants out of canonical grouping", () => {
			writeRawModelsConfig({
				providers: {
					demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				},
				equivalence: {
					exclude: ["demo/anthropic/claude-sonnet-4.5"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const grouped = registry.getCanonicalVariants("claude-sonnet-4-5");
			const fallback = registry.getCanonicalVariants("anthropic/claude-sonnet-4.5");

			expect(grouped.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(false);
			expect(fallback.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("resolves interleaved registries using their owning provider order", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});
			let order = ["demo", "anthropic"];
			const first = new ModelRegistry(authStorage, modelsJsonPath, { getProviderOrder: () => order });
			const second = new ModelRegistry(authStorage, modelsJsonPath, {
				getProviderOrder: () => ["anthropic", "demo"],
			});
			const resolve = (registry: ModelRegistry) =>
				registry.resolveCanonicalModel("claude-sonnet-4-5", {
					availableOnly: false,
					candidates: registry.getAll(),
				});
			for (let index = 0; index < 3; index++) {
				expect(resolve(first)?.provider).toBe("demo");
				expect(resolve(second)?.provider).toBe("anthropic");
			}
			order = ["anthropic", "demo"];
			expect(resolve(first)?.provider).toBe("anthropic");
		});
	});

	describe("OpenRouter routed suffix fallback", () => {
		test("find synthesizes a routed model id from the base OpenRouter metadata", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openrouter", "z-ai/glm-4.7-20251222:nitro");

			expect(model?.provider).toBe("openrouter");
			expect(model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(model?.name).toBe("z-ai/glm-4.7-20251222:nitro");
		});
	});

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some(m => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			await registry.refresh("offline");

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("provider compat overrides", () => {
		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(model.compat?.supportsUsageInStreaming).toBe(false);
				expect(model.compat?.supportsStrictMode).toBe(false);
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			expect(model?.compat?.supportsUsageInStreaming).toBe(false);
			expect(model?.compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			expect(model?.compat?.supportsUsageInStreaming).toBe(true);
			expect(model?.compat?.maxTokensField).toBe("max_completion_tokens");
		});
	});

	describe("custom models merge behavior", () => {
		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Built-in models still present, custom model merged in
			expect(anthropicModels.length).toBeGreaterThan(1);
			const custom = anthropicModels.find(m => m.id === "claude-custom");
			expect(custom).toBeDefined();
			expect(custom!.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom same-id replacement does not keep bundled headers", () => {
			writeRawModelsJson({
				"github-copilot": {
					baseUrl: "https://proxy.example.com/v1",
					headers: { "X-Proxy": "proxy" },
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "gpt-4o" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");

			expect(model?.headers).toEqual({ "X-Proxy": "proxy" });
			expect(model?.headers?.["User-Agent"]).toBeUndefined();
			expect(model?.headers?.["Editor-Version"]).toBeUndefined();
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.some(m => m.id === "custom/openrouter-model")).toBe(true);
			expect(models.some(m => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet")).toBe(
				true,
			);
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("built-in gpt-5.4 applies the hardcoded context window policy", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(1_000_000);
		});

		test("custom gpt-5.4 replacement keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openai", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom-only gpt-5.4 provider keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom gpt-5.4 replacement preserves its explicit context window", () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);
		});

		test("modelOverrides can still patch a custom gpt-5.4 replacement", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							name: "gpt-5.4",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 256000,
							maxTokens: 128000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("discoverable bundled replacement survives refresh", async () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", name: "Proxy GPT-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.name).toBe("Proxy GPT-5.4");
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			const model = registry.find("openai", "gpt-5.4");
			expect(model?.name).toBe("Proxy GPT-5.4");
			expect(model?.contextWindow).toBe(256000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("discoverable custom-only gpt-5.4 survives refresh", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:8080",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					discovery: { type: "llama.cpp" },
					models: [{ id: "gpt-5.4" }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("custom-local", "gpt-5.4")?.contextWindow).toBe(1_000_000);

			using _hook = mockOpenAiCompatibleModels("http://127.0.0.1:8080/models", ["gpt-5.4"]);
			await registry.refreshProvider("custom-local", "online");

			const model = registry.find("custom-local", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("http://127.0.0.1:8080");
		});

		test("discoverable custom compat survives refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							compat: {
								extraBody: { source: "proxy" },
							},
						},
					],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.compat?.extraBody).toEqual({ source: "proxy" });

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			expect(registry.find("openai", "gpt-5.4")?.compat?.extraBody).toEqual({ source: "proxy" });
		});

		test("modelOverrides still apply after discoverable refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							contextWindow: 256000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);

			using _hook = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			await registry.refreshProvider("openai", "online");

			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("newly discovered ids inherit provider fields, not another model's custom fields", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://provider.example.com/v1",
					headers: { "X-Provider": "provider" },
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							baseUrl: "https://special.example.com/v1",
							headers: { "X-Model": "special" },
						},
					],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://special.example.com/v1");

			using _hook = mockOpenAiCompatibleModels("https://provider.example.com/v1/models", ["gpt-5.4", "gpt-5.5"]);
			await registry.refreshProvider("openai", "online");

			const discovered = registry.find("openai", "gpt-5.5");
			expect(discovered?.baseUrl).toBe("https://provider.example.com/v1");
			expect(discovered?.headers?.["X-Provider"]).toBe("provider");
			expect(discovered?.headers?.["X-Model"]).toBeUndefined();
		});

		test("same-id replacement uses configured compat without bundled compat leak", () => {
			writeRawModelsJson({
				"minimax-code": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					compat: {
						extraBody: { source: "proxy" },
					},
					models: [{ id: "MiniMax-M2.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("minimax-code", "MiniMax-M2.5");
			expect(model?.compat?.thinkingFormat).toBeUndefined();
			expect(model?.compat?.reasoningContentField).toBeUndefined();
			expect(model?.compat?.extraBody).toEqual({ source: "proxy" });
		});

		test("removing custom models from models.json keeps built-in provider models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("thinking metadata normalization", () => {
		test("custom models preserve explicit thinking", () => {
			const thinking: ThinkingConfig = createThinkingConfig(
				[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				"anthropic-adaptive",
			);

			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [
					{ id: "claude-custom", reasoning: true, thinking },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "anthropic").find(m => m.id === "claude-custom");

			expect(model?.thinking).toEqual(thinking);
		});

		test("model overrides can replace canonical thinking metadata", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							thinking: createThinkingConfig([Effort.Low, Effort.Medium], "budget"),
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");

			expect(model?.thinking).toEqual(createThinkingConfig([Effort.Low, Effort.Medium], "budget"));
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override merges compat.extraBody across provider+model", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						extraBody: {
							gateway: "default-gateway",
							controller: "provider-controller",
						},
					},
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								extraBody: {
									controller: "model-controller",
								},
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.extraBody).toEqual({ gateway: "default-gateway", controller: "model-controller" });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompat | undefined;
			const opusCompat = opus?.compat as OpenAICompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find(m => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnet?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh("offline");

			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await registry.refresh("offline");

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("github-copilot oauth endpoint alignment", () => {
		test("getApiKey does not mutate bundled github-copilot baseUrl", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_individual_token_123",
					refresh: "ghu_individual_token_123",
					expires: Date.now() + 60_000,
				},
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");
			expect(model).toBeDefined();
			if (!model) throw new Error("Expected github-copilot/gpt-4o model");

			const initialBaseUrl = model.baseUrl;
			const firstApiKey = await registry.getApiKey(model);
			expect(firstApiKey).toBeDefined();
			const firstParsed = JSON.parse(firstApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(firstParsed.token).toBe("ghu_individual_token_123");
			expect(firstParsed.enterpriseUrl).toBeUndefined();
			const secondApiKey = await registry.getApiKey(model);
			expect(secondApiKey).toBeDefined();
			const secondParsed = JSON.parse(secondApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(secondParsed.token).toBe("ghu_enterprise_token_456");
			expect(secondParsed.enterpriseUrl).toBe("ghe.example.com");
			expect(model.baseUrl).toBe(initialBaseUrl);
		});

		test("refreshProvider uses enterprise Copilot discovery host for peeked credentials", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const requestedUrls: string[] = [];
			using _hook = hookFetch((input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "https://copilot-api.ghe.example.com/models") {
					const authHeader =
						input instanceof Request
							? input.headers.get("Authorization")
							: new Headers(init?.headers).get("Authorization");
					expect(authHeader).toBe("Bearer ghu_enterprise_token_456");
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "gpt-5-mini",
									name: "GPT-5 mini",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("github-copilot", "online");
			expect(requestedUrls).toContain("https://copilot-api.ghe.example.com/models");
			expect(requestedUrls).not.toContain("https://api.githubcopilot.com/models");
		});
	});

	describe("entitlement-scoped OAuth discovery", () => {
		test("refreshes expired Antigravity credentials before discovering models", async () => {
			await authStorage.set("google-antigravity", {
				type: "oauth",
				access: "expired-access-token",
				refresh: "refresh-token",
				expires: Date.now() - 60_000,
				projectId: "project-id",
			});

			const requestedUrls: string[] = [];
			using _hook = hookFetch((input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "https://oauth2.googleapis.com/token") {
					return Response.json({ access_token: "fresh-access-token", expires_in: 3600 });
				}
				if (url === "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels") {
					const authorization =
						input instanceof Request
							? input.headers.get("Authorization")
							: new Headers(init?.headers).get("Authorization");
					expect(authorization).toBe("Bearer fresh-access-token");
					return Response.json({
						models: {
							"gemini-3.6-flash-high": {
								displayName: "Gemini 3.6 Flash High",
								maxTokens: 1_000_000,
								maxOutputTokens: 65_536,
								supportsThinking: true,
							},
						},
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("google-antigravity", "online");

			expect(requestedUrls).toContain("https://oauth2.googleapis.com/token");
			expect(registry.find("google-antigravity", "gemini-3.6-flash-high")).toMatchObject({
				contextWindow: 1_000_000,
				maxTokens: 65_536,
				reasoning: true,
			});
		});
	});

	describe("disabled provider filtering", () => {
		test("getAvailable and getDiscoverableProviders exclude disabled providers from settings", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_test_token_for_disabled",
					refresh: "ghu_test_token_for_disabled",
					expires: Date.now() + 60_000,
				},
			]);
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["github-copilot", "ollama"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getAvailable().some(model => model.provider === "github-copilot")).toBe(false);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");
		});
	});
	describe("runtime discovery", () => {
		test("auto-discovers ollama models without provider config", async () => {
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const ollamaModels = getModelsForProvider(registry, "ollama");
			expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
			expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
			expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
		});

		test("discovers ollama models at runtime and treats auth:none providers as available", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(
						JSON.stringify({
							models: [{ name: "qwen2.5-coder:7b" }, { model: "llama3.2:3b", name: "llama3.2:3b" }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const ollamaModels = getModelsForProvider(registry, "ollama");
			expect(ollamaModels.some(m => m.id === "qwen2.5-coder:7b")).toBe(true);
			expect(ollamaModels.some(m => m.id === "llama3.2:3b")).toBe(true);

			const available = registry.getAvailable().filter(m => m.provider === "ollama");
			expect(available.length).toBe(2);
			expect(await registry.getApiKey(available[0])).toBe(kNoAuth);
		});

		test("normalizes cached ollama completions rows to responses on load", () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			writeCachedOllamaModels([
				{
					id: "phi4-mini",
					name: "phi4-mini",
					api: "openai-completions",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const ollama = registry.find("ollama", "phi4-mini");

			expect(ollama?.api).toBe("openai-responses");
			expect(ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
			expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("cached");
		});

		test("discovers ollama thinking capabilities from show metadata", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(
						JSON.stringify({
							models: [{ name: "qwen3.5:397b-cloud" }, { name: "llama3.2:3b" }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
					if (body.model === "qwen3.5:397b-cloud") {
						return new Response(JSON.stringify({ capabilities: ["completion", "thinking"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (body.model === "llama3.2:3b") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
				}
				throw new Error(`Unexpected request: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const qwen = registry.find("ollama", "qwen3.5:397b-cloud");
			expect(qwen?.reasoning).toBe(true);
			expect(qwen?.thinking).toEqual(createThinkingConfig([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]));

			const llama = registry.find("ollama", "llama3.2:3b");
			expect(llama?.reasoning).toBe(false);
		});

		test("discovers ollama context window from show model_info", async () => {
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
					if (body.model === "gemma3:4b") {
						return new Response(
							JSON.stringify({
								model_info: {
									"gemma3.context_length": 131072,
								},
							}),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}
				throw new Error(`Unexpected request: ${url}`);
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const gemma = registry.find("ollama", "gemma3:4b");
			expect(gemma?.contextWindow).toBe(131072);
			expect(gemma?.maxTokens).toBe(8192);
			expect(gemma?.input).toEqual(["text"]);
			expect(gemma?.reasoning).toBe(false);
		});

		test("discovery failure does not fail model registry refresh", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			using _hook = hookFetch(() => {
				throw new Error("connection refused");
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			expect(getModelsForProvider(registry, "ollama")).toHaveLength(0);
			expect(registry.getError()).toBeUndefined();
		});
		test("loads cached local models before live refresh and preserves them on failure", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});

			{
				using _hook = hookFetch(input => {
					const url = String(input);
					if (url === "http://127.0.0.1:11434/api/tags") {
						return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (url === "http://127.0.0.1:11434/api/show") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});
				const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await primedRegistry.refresh();
			}

			const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
			expect(cachedRegistry.getProviderDiscoveryState("ollama")?.status).toBe("cached");

			{
				using _hook = hookFetch(() => {
					throw new Error("connection refused");
				});
				await cachedRegistry.refreshProvider("ollama");
			}

			expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
			const state = cachedRegistry.getProviderDiscoveryState("ollama");
			expect(state?.status).toBe("cached");
			expect(state?.error).toContain("connection refused");
		});

		test("reports unauthenticated discoverable providers without discarding cached models", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					discovery: { type: "ollama" },
				},
			});
			authStorage.setRuntimeApiKey("custom-local", "test-key");

			{
				using _hook = hookFetch(input => {
					const url = String(input);
					if (url === "http://127.0.0.1:11434/api/tags") {
						return new Response(JSON.stringify({ models: [{ name: "local-coder" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (url === "http://127.0.0.1:11434/api/show") {
						return new Response(JSON.stringify({ capabilities: ["completion"] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				});
				const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
				await primedRegistry.refreshProvider("custom-local");
			}

			authStorage.setRuntimeApiKey("custom-local", "");
			const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await cachedRegistry.refreshProvider("custom-local");

			expect(getModelsForProvider(cachedRegistry, "custom-local").some(model => model.id === "local-coder")).toBe(
				true,
			);
			const state = cachedRegistry.getProviderDiscoveryState("custom-local");
			expect(state?.status).toBe("unauthenticated");
			expect(state?.models).toContain("local-coder");
		});
		test("llama.cpp discovery honors configured API key", async () => {
			authStorage.setRuntimeApiKey("llama.cpp", "test-llama-key");
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
					return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }, { id: "mistral:7b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const llamaModels = getModelsForProvider(registry, "llama.cpp");
			expect(llamaModels.some(m => m.id === "llama-3.2:3b")).toBe(true);
			const apiKey = await registry.getApiKey(llamaModels[0]);
			expect(apiKey).toBe("test-llama-key");
			expect(apiKey).not.toBe(kNoAuth);
		});
		test("llama.cpp discovery without API key is treated as keyless", async () => {
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					// When no API key, headers should be empty object or undefined
					expect(authHeader).toBeUndefined();
					return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					const headers = init?.headers as Headers | Record<string, string> | undefined;
					let authHeader: string | null = null;
					if (headers instanceof Headers) {
						authHeader = headers.get("Authorization");
					} else if (typeof headers === "object") {
						authHeader = headers.Authorization;
					}
					expect(authHeader).toBeUndefined();
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const state = registry.getProviderDiscoveryState("llama.cpp");
			if (state?.status !== "ok") {
				throw new Error(`Discovery failed with status ${state?.status}: ${state?.error}`);
			}
			const llamaModels = getModelsForProvider(registry, "llama.cpp");
			const apiKey = await registry.getApiKey(llamaModels[0]);
			expect(apiKey).toBe(kNoAuth);
		});
		test("llama.cpp discovery reads context window from props n_ctx", async () => {
			using _hook = hookFetch(input => {
				const url = String(input);
				if (url === "http://127.0.0.1:8080/models") {
					return new Response(JSON.stringify({ data: [{ id: "qwen35-35b-a3b" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:8080/props") {
					return new Response(
						JSON.stringify({
							default_generation_settings: {
								n_ctx: 262144,
							},
							modalities: {
								vision: true,
								audio: false,
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();
			const llama = registry.find("llama.cpp", "qwen35-35b-a3b");
			expect(llama?.contextWindow).toBe(262144);
			expect(llama?.maxTokens).toBe(8192);
			expect(llama?.input).toEqual(["text", "image"]);
		});
	});

	describe("openai-compat discovery (LiteLLM proxy)", () => {
		test("vLLM discovery consumes advertised context limits and preserves fallbacks", async () => {
			writeRawModelsJson({
				vllm: {
					baseUrl: "http://127.0.0.1:8000/v1",
					auth: "none",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});
			using _hook = hookFetch((input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toBe("http://127.0.0.1:8000/v1/models");
				const authorization =
					input instanceof Request
						? input.headers.get("Authorization")
						: new Headers(init?.headers).get("Authorization");
				expect(authorization).toBeNull();
				return Response.json({
					data: [
						{ id: "large-local", max_model_len: 65_536 },
						{ id: "tiny-local", context_length: "2048" },
						{ id: "metadata-free" },
					],
				});
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");

			expect(registry.isProviderKeyless("vllm")).toBe(true);
			expect(registry.getAvailable().some(model => model.provider === "vllm")).toBe(true);
			expect(registry.find("vllm", "large-local")).toMatchObject({ contextWindow: 65_536, maxTokens: 8192 });
			expect(registry.find("vllm", "tiny-local")).toMatchObject({ contextWindow: 2048, maxTokens: 512 });
			expect(registry.find("vllm", "metadata-free")).toMatchObject({ contextWindow: 128_000, maxTokens: 8192 });
		});

		test("vLLM discovery preserves explicit thinking and transport compatibility overrides", async () => {
			const thinking = createThinkingConfig([Effort.Low, Effort.High], "effort", Effort.High);
			writeRawModelsJson({
				vllm: {
					baseUrl: "http://127.0.0.1:8000/v1",
					auth: "none",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
					modelOverrides: {
						"reasoning-local": {
							reasoning: true,
							thinking,
							compat: {
								thinkingFormat: "qwen-chat-template",
								reasoningContentField: "reasoning_content",
								supportsTemperature: false,
							},
						},
					},
				},
			});
			using _hook = hookFetch(input => {
				expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
				return Response.json({ data: [{ id: "reasoning-local", max_model_len: 65_536 }] });
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("vllm", "online");

			expect(registry.find("vllm", "reasoning-local")).toMatchObject({
				reasoning: true,
				thinking,
				compat: {
					thinkingFormat: "qwen-chat-template",
					reasoningContentField: "reasoning_content",
					supportsTemperature: false,
				},
			});
		});
		test("a text-only discovery cache cannot erase bundled GPT-5.6 vision at startup", () => {
			const cached = {
				...getBundledModel("litellm", "gpt-5.6-sol"),
				input: ["text"] as Array<"text" | "image">,
			};
			writeModelCache("litellm", Date.now(), [cached], true, cacheDbPath);
			writeRawModelsJson({
				litellm: {
					baseUrl: "https://proxy.example.com/api/v1",
					apiKey: "test-key",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDiscoveryState("litellm")?.status).toBe("cached");
			expect(registry.find("litellm", "gpt-5.6-sol")?.input).toEqual(["text", "image"]);
		});

		test("existing generated config keeps GPT-5.6 image input through discovery without migration", async () => {
			const previousBaseUrl = Bun.env.LITELLM_BASE_URL;
			const previousApiKey = Bun.env.LITELLM_API_KEY;
			try {
				delete Bun.env.LITELLM_BASE_URL;
				delete Bun.env.LITELLM_API_KEY;
				const legacyModelsPath = path.join(tempDir, "legacy-models.yml");
				const legacyGenerated = generateModelsYml("https://proxy.example.com", {
					apiBasePath: "/api/v1",
					apiKeyLiteral: "test-key",
				}).replace(/\n {8}input:\n {10}- text\n {10}- image/, "");
				expect(legacyGenerated).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
				expect(legacyGenerated).not.toContain("        input:");
				fs.writeFileSync(legacyModelsPath, legacyGenerated);

				const registry = new ModelRegistry(authStorage, legacyModelsPath);

				expect(registry.find("litellm", "gpt-5.6-sol")?.input).toEqual(["text", "image"]);
				using _hook = mockOpenAiCompatibleModels("https://proxy.example.com/api/v1/models", ["gpt-5.6-sol"]);
				await registry.refreshProvider("litellm", "online");
				expect(registry.getProviderDiscoveryState("litellm")?.status).toBe("ok");
				expect(registry.find("litellm", "gpt-5.6-sol")?.input).toEqual(["text", "image"]);
				expect(fs.readFileSync(legacyModelsPath, "utf8")).toBe(legacyGenerated);
			} finally {
				if (previousBaseUrl === undefined) delete Bun.env.LITELLM_BASE_URL;
				else Bun.env.LITELLM_BASE_URL = previousBaseUrl;
				if (previousApiKey === undefined) delete Bun.env.LITELLM_API_KEY;
				else Bun.env.LITELLM_API_KEY = previousApiKey;
			}
		});

		test("generated config preserves GPT-5.6 Sol effort metadata after discovery", async () => {
			const previousBaseUrl = Bun.env.LITELLM_BASE_URL;
			const previousApiKey = Bun.env.LITELLM_API_KEY;
			try {
				Bun.env.LITELLM_BASE_URL = "https://proxy.example.com";
				Bun.env.LITELLM_API_KEY = "test-key";
				const generatedModelsPath = path.join(tempDir, "generated-models.yml");
				fs.writeFileSync(
					generatedModelsPath,
					generateModelsYml("https://proxy.example.com", {
						apiBasePath: "/api/v1",
						apiKeyLiteral: "test-key",
					}),
				);
				using _hook = mockOpenAiCompatibleModels("https://proxy.example.com/api/v1/models", [
					"gpt-5.6-sol",
					"unrelated-model",
				]);

				const registry = new ModelRegistry(authStorage, generatedModelsPath);
				await registry.refreshProvider("litellm", "online");

				const model = registry.find("litellm", "gpt-5.6-sol");
				expect(model).toMatchObject({
					reasoning: true,
					input: ["text", "image"],
					thinking: createThinkingConfig([
						ReasoningEffort.None,
						Effort.Low,
						Effort.Medium,
						Effort.High,
						Effort.XHigh,
						ReasoningEffort.Max,
					]),
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					compat: { supportsTemperature: false },
				});
				expect(registry.find("litellm", "unrelated-model")).toBeUndefined();
			} finally {
				if (previousBaseUrl === undefined) delete Bun.env.LITELLM_BASE_URL;
				else Bun.env.LITELLM_BASE_URL = previousBaseUrl;
				if (previousApiKey === undefined) delete Bun.env.LITELLM_API_KEY;
				else Bun.env.LITELLM_API_KEY = previousApiKey;
			}
		});

		test("an explicit user model override can restrict GPT-5.6 Sol to text", () => {
			writeRawModelsJson({
				litellm: {
					modelOverrides: {
						"gpt-5.6-sol": { input: ["text"] },
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("litellm", "gpt-5.6-sol")?.input).toEqual(["text"]);
		});

		test("config with discovery.type openai-compat loads without schema error", () => {
			writeRawModelsJson({
				litellm: {
					baseUrl: "http://localhost:4000",
					apiKey: "test-key",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});
			// If schema rejects openai-compat, ModelRegistry constructor throws ConfigError
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry).toBeDefined();
		});

		test("openai-compat discovery fetches /models endpoint", async () => {
			writeRawModelsJson({
				litellm: {
					baseUrl: "http://localhost:4000",
					apiKey: "test-key",
					api: "openai-completions",
					discovery: { type: "openai-compat" },
				},
			});
			using _hook = mockOpenAiCompatibleModels("http://localhost:4000/models", ["claude-3.5-sonnet", "gpt-4o"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("litellm", "online");
			expect(registry.find("litellm", "claude-3.5-sonnet")).toBeDefined();
			expect(registry.find("litellm", "gpt-4o")).toBeDefined();
		});
	});
});

// =========================================================================
// resolveApiKeyConfig() — generic resolver (always falls back to literal)
// =========================================================================

describe("resolveApiKeyConfig()", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedEnv.LITELLM_API_KEY = process.env.LITELLM_API_KEY;
		delete process.env.LITELLM_API_KEY;
	});

	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val !== undefined) process.env[key] = val;
			else delete process.env[key];
		}
	});

	test("returns env var value when env var is set", () => {
		process.env.LITELLM_API_KEY = "sk-real-token-abc123";
		expect(resolveApiKeyConfig("LITELLM_API_KEY")).toBe("sk-real-token-abc123");
	});

	test("returns literal string when env var is not set (for runtime/extension keys)", () => {
		delete process.env.LITELLM_API_KEY;
		expect(resolveApiKeyConfig("LITELLM_API_KEY")).toBe("LITELLM_API_KEY");
	});

	test("returns literal value for mixed-case strings", () => {
		expect(resolveApiKeyConfig("sk-abc123-mixed")).toBe("sk-abc123-mixed");
	});
});

// =========================================================================
// resolveYamlApiKeyConfig() — YAML-specific resolver (PR #104 regression fix)
// =========================================================================

describe("resolveYamlApiKeyConfig()", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedEnv.LITELLM_API_KEY = process.env.LITELLM_API_KEY;
		savedEnv.MY_CUSTOM_KEY = process.env.MY_CUSTOM_KEY;
		delete process.env.LITELLM_API_KEY;
		delete process.env.MY_CUSTOM_KEY;
	});

	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val !== undefined) process.env[key] = val;
			else delete process.env[key];
		}
	});

	test("returns env var value when env var is set", () => {
		process.env.LITELLM_API_KEY = "sk-real-token-abc123";
		expect(resolveYamlApiKeyConfig("LITELLM_API_KEY")).toBe("sk-real-token-abc123");
	});

	test("returns undefined for ALL_CAPS env var name when env var is not set", () => {
		delete process.env.LITELLM_API_KEY;
		expect(resolveYamlApiKeyConfig("LITELLM_API_KEY")).toBeUndefined();
	});

	test("returns undefined for 2-segment ALL_CAPS name when env var is not set", () => {
		expect(resolveYamlApiKeyConfig("DEMO_KEY")).toBeUndefined();
	});

	test("returns undefined for 3-segment ALL_CAPS name when env var is not set", () => {
		delete process.env.MY_CUSTOM_KEY;
		expect(resolveYamlApiKeyConfig("MY_CUSTOM_KEY")).toBeUndefined();
	});

	test("returns literal value for mixed-case strings (real API keys)", () => {
		expect(resolveYamlApiKeyConfig("sk-abc123-mixed")).toBe("sk-abc123-mixed");
	});

	test("returns literal value for lowercase strings", () => {
		expect(resolveYamlApiKeyConfig("abc")).toBe("abc");
	});

	test("returns literal value for strings with special characters", () => {
		expect(resolveYamlApiKeyConfig("sk-ant-api03-xyz")).toBe("sk-ant-api03-xyz");
	});

	test("returns literal value for strings starting with lowercase", () => {
		expect(resolveYamlApiKeyConfig("myKey123")).toBe("myKey123");
	});
});
