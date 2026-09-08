import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { BUILTIN_ROUTING_PRESETS, resolveModelPool } from "../src/routing/presets";
import { AuthStorage } from "../src/session/auth-storage";

describe("Routing Presets (R03)", () => {
	it("should contain standard reviewed presets for OpenAI, Anthropic, and LiteLLM", () => {
		expect(BUILTIN_ROUTING_PRESETS["openai/gpt-5.6"]).toBeDefined();
		expect(BUILTIN_ROUTING_PRESETS["openai/gpt-5.6"]).toMatchObject({
			provider: "openai",
			tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
		});
		expect(BUILTIN_ROUTING_PRESETS["anthropic/claude"]).toBeDefined();
		expect(BUILTIN_ROUTING_PRESETS["anthropic/claude"]).toMatchObject({
			tiers: { utility: "claude-haiku-4-5", balanced: "claude-sonnet-5", frontier: "claude-opus-5" },
			effortPolicy: {
				byTier: { utility: "low", balanced: "medium", frontier: "high" },
				frontierEscalation: { effort: "xhigh", minimumComplexityScore: 90 },
			},
		});
		expect(BUILTIN_ROUTING_PRESETS["litellm/openai"]).toBeDefined();
		expect(BUILTIN_ROUTING_PRESETS["litellm/openai"]).toMatchObject({
			provider: "litellm",
			tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
		});
		expect(BUILTIN_ROUTING_PRESETS["litellm/anthropic"]).toMatchObject({
			provider: "litellm",
			tiers: { utility: "claude-haiku-4-5", balanced: "claude-sonnet-5", frontier: "claude-opus-5" },
		});
		expect(BUILTIN_ROUTING_PRESETS["openai-codex/gpt-5.6"]).toMatchObject({
			provider: "openai-codex",
			tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
		});
	});

	it("should validate all built-in preset models exist in the registry", async () => {
		const authStorage = await AuthStorage.create(path.join(os.tmpdir(), `testauth-${Date.now()}.db`));
		const registry = new ModelRegistry(authStorage);
		// The registry automatically loads models.json, so we can check against its inventory.
		const available = registry.getAll().map(m => `${m.provider}/${m.id}`);

		for (const pool of Object.values(BUILTIN_ROUTING_PRESETS)) {
			// Provider-discovered and subscription models intentionally need not exist in the static bundle.
			if (pool.provider === "openai" || pool.provider === "openai-codex" || pool.provider === "litellm") continue;
			const p = pool.provider ? `${pool.provider}/` : "";
			expect(available).toContain(`${p}${pool.tiers.utility}`);
			expect(available).toContain(`${p}${pool.tiers.balanced}`);
			expect(available).toContain(`${p}${pool.tiers.frontier}`);
		}
	});

	it("should resolve pool from explicit selector or anchor model", () => {
		const openaiPool = resolveModelPool("openai/gpt-5.6", {});
		expect(openaiPool).toBeDefined();
		expect(openaiPool?.tiers.utility).toBe("gpt-5.6-luna");
		expect(openaiPool?.tiers.balanced).toBe("gpt-5.6-terra");
		expect(openaiPool?.tiers.frontier).toBe("gpt-5.6-sol");

		const litellmOpenaiPool = resolveModelPool("litellm/openai", {});
		expect(litellmOpenaiPool).toBeDefined();
		expect(litellmOpenaiPool?.tiers.utility).toBe("gpt-5.6-luna");
		expect(litellmOpenaiPool?.tiers.balanced).toBe("gpt-5.6-terra");
		expect(litellmOpenaiPool?.tiers.frontier).toBe("gpt-5.6-sol");
	});

	it("should NOT cross provider families when anchor model has explicit provider prefix", () => {
		const litellmClaudePool = resolveModelPool("litellm/claude-sonnet-5", {});
		expect(litellmClaudePool).toBeDefined();
		expect(litellmClaudePool?.id).toBe("litellm/anthropic");
		expect(litellmClaudePool?.provider).toBe("litellm");
	});

	it("should match custom pools when anchor model has provider prefix", () => {
		const customPools = {
			"my-openai": {
				id: "my-openai",
				provider: "openai",
				tiers: {
					utility: "gpt-4.1-mini",
					balanced: "gpt-4.1",
					frontier: "gpt-5-pro",
				},
			},
		};
		const matched = resolveModelPool("openai/gpt-5-pro", customPools);
		expect(matched).toBeDefined();
		expect(matched?.id).toBe("my-openai");
	});

	it("should skip custom pools without tiers and not throw TypeError", () => {
		const customPools = {
			"untiered-pool": { id: "untiered-pool", provider: "openai" } as any,
		};
		const pool = resolveModelPool("openai/gpt-5.6", customPools);
		expect(pool).toBeDefined();
		expect(pool?.id).toBe("openai/gpt-5.6");
	});

	it("should NOT infer tiers from arbitrary unknown model names", () => {
		const unknownPool = resolveModelPool("my-custom-provider/unknown-model-xyz", {});
		expect(unknownPool).toBeUndefined();
	});

	it("should filter out pools in disabledPresets list", () => {
		const customPools = {
			"my-openai": {
				id: "my-openai",
				provider: "openai",
				tiers: {
					utility: "gpt-4o-mini",
					balanced: "gpt-4o",
					frontier: "o3-mini",
				},
			},
		};
		// Disabled custom pool -> falls back to builtin
		const disabledCustom = resolveModelPool("openai/gpt-5.6-luna", customPools, ["my-openai"]);
		expect(disabledCustom?.id).toBe("openai/gpt-5.6");

		// Disabled builtin pool -> falls back to undefined
		const disabledBuiltin = resolveModelPool("openai/gpt-5.6", {}, ["openai/gpt-5.6"]);
		expect(disabledBuiltin).toBeUndefined();
	});

	it("should skip mixed pools when familyPolicy is sticky", () => {
		const customPools = {
			"mixed-pool": {
				id: "mixed-pool",
				provider: "openai",
				allowMixed: true,
				tiers: {
					utility: "gpt-4o-mini",
					balanced: "claude-3-5-sonnet",
					frontier: "o3-mini",
				},
			},
		};
		// sticky policy skips allowMixed=true pool
		const sticky = resolveModelPool("mixed-pool", customPools, [], "sticky");
		expect(sticky?.id).not.toBe("mixed-pool");

		// configured-mixed policy matches the allowMixed=true pool
		const mixed = resolveModelPool("mixed-pool", customPools, [], "configured-mixed");
		expect(mixed?.id).toBe("mixed-pool");
	});

	it("should reject custom pool configurations with duplicate selectors in validateCustomPools", () => {
		const { validateCustomPools } = require("../src/routing/presets");
		const badPools = {
			"bad-pool": {
				id: "bad-pool",
				tiers: {
					utility: "gpt-4.1",
					balanced: "gpt-4.1",
					frontier: "gpt-5-pro",
				},
			},
		};

		expect(() => validateCustomPools(badPools)).toThrow("Duplicate tier selectors found in pool bad-pool");
	});
});
