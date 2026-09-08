import { ANTHROPIC_ROUTING_POOL, OPENAI_CODEX_ROUTING_POOL } from "./subscription-profiles";
import type { RoutingPoolConfig } from "./types";

export const BUILTIN_ROUTING_PRESETS: Record<string, RoutingPoolConfig> = {
	[OPENAI_CODEX_ROUTING_POOL.id]: OPENAI_CODEX_ROUTING_POOL,
	"openai/gpt-5.6": {
		id: "openai/gpt-5.6",
		provider: "openai",
		tiers: { ...OPENAI_CODEX_ROUTING_POOL.tiers },
		effortPolicy: OPENAI_CODEX_ROUTING_POOL.effortPolicy,
	},
	[ANTHROPIC_ROUTING_POOL.id]: ANTHROPIC_ROUTING_POOL,
	"litellm/openai": {
		id: "litellm/openai",
		provider: "litellm",
		tiers: { ...OPENAI_CODEX_ROUTING_POOL.tiers },
		effortPolicy: OPENAI_CODEX_ROUTING_POOL.effortPolicy,
	},
	"litellm/anthropic": {
		id: "litellm/anthropic",
		provider: "litellm",
		tiers: { ...ANTHROPIC_ROUTING_POOL.tiers },
		effortPolicy: ANTHROPIC_ROUTING_POOL.effortPolicy,
	},
};

/**
 * Validate custom routing pools from settings.
 */
export function validateCustomPools(pools: any): Record<string, RoutingPoolConfig> {
	if (typeof pools !== "object" || pools === null) return {};
	const validPools: Record<string, RoutingPoolConfig> = {};
	const seenIds = new Set<string>();

	for (const [key, pool] of Object.entries(pools)) {
		if (typeof pool !== "object" || pool === null) continue;
		const p = pool as any;
		if (typeof p.id !== "string") continue;
		if (typeof p.tiers !== "object" || p.tiers === null) continue;
		if (typeof p.tiers.utility !== "string") continue;
		if (typeof p.tiers.balanced !== "string") continue;
		if (typeof p.tiers.frontier !== "string") continue;

		if (seenIds.has(p.id)) continue;

		if (
			p.tiers.utility === p.tiers.balanced ||
			p.tiers.utility === p.tiers.frontier ||
			p.tiers.balanced === p.tiers.frontier
		) {
			throw new Error(`Duplicate tier selectors found in pool ${p.id}`);
		}

		const allowMixed = typeof p.allowMixed === "boolean" ? p.allowMixed : false;
		if (!allowMixed) {
			const getPrefix = (model: string) =>
				model.includes("/") ? model.split("/")[0] : typeof p.provider === "string" ? p.provider : "";
			const uPrefix = getPrefix(p.tiers.utility);
			const bPrefix = getPrefix(p.tiers.balanced);
			const fPrefix = getPrefix(p.tiers.frontier);

			const prefixes = new Set([uPrefix, bPrefix, fPrefix].filter(Boolean));
			if (prefixes.size > 1) {
				continue;
			}
		}

		seenIds.add(p.id);
		validPools[key] = {
			id: p.id,
			provider: typeof p.provider === "string" ? p.provider : undefined,
			allowMixed: typeof p.allowMixed === "boolean" ? p.allowMixed : undefined,
			tiers: {
				utility: p.tiers.utility,
				balanced: p.tiers.balanced,
				frontier: p.tiers.frontier,
			},
		};
	}
	return validPools;
}

/**
 * Resolve active pool for an anchor model string (e.g. "openai/gpt-4o" or "litellm/gpt-5.6-terra").
 * Custom overrides take precedence over built-in presets.
 * Returns undefined if model/provider is untiered or unknown.
 */
export function resolveModelPool(
	anchorModel: string,
	customPools: Record<string, RoutingPoolConfig> = {},
	disabledPresets: readonly string[] = [],
	familyPolicy: "sticky" | "configured-mixed" = "sticky",
): RoutingPoolConfig | undefined {
	// 1. Extract provider and model name
	let provider = "";
	let modelName = anchorModel;
	if (anchorModel.includes("/")) {
		const parts = anchorModel.split("/");
		provider = parts[0];
		modelName = parts.slice(1).join("/");
	}

	// 2. Check custom pools first
	for (const [poolId, pool] of Object.entries(customPools)) {
		if (!pool?.tiers) continue;
		if (disabledPresets.includes(poolId) || disabledPresets.includes(pool.id)) continue;
		if (familyPolicy === "sticky") {
			if (pool.allowMixed) continue;
			if (provider) {
				const pProv = pool.provider ?? provider;
				const uProv = pool.tiers.utility.includes("/") ? pool.tiers.utility.split("/")[0] : pProv;
				const bProv = pool.tiers.balanced.includes("/") ? pool.tiers.balanced.split("/")[0] : pProv;
				const fProv = pool.tiers.frontier.includes("/") ? pool.tiers.frontier.split("/")[0] : pProv;
				if (uProv !== provider || bProv !== provider || fProv !== provider) {
					continue;
				}
			}
		}
		if (provider && pool.provider && pool.provider !== provider && pool.id !== anchorModel) {
			continue;
		}

		const qualify = (tier: string) => (tier.includes("/") ? tier : `${pool.provider ?? provider}/${tier}`);

		if (
			pool.id === anchorModel ||
			pool.tiers.utility === anchorModel ||
			pool.tiers.balanced === anchorModel ||
			pool.tiers.frontier === anchorModel ||
			pool.tiers.utility === modelName ||
			pool.tiers.balanced === modelName ||
			pool.tiers.frontier === modelName ||
			qualify(pool.tiers.utility) === anchorModel ||
			qualify(pool.tiers.balanced) === anchorModel ||
			qualify(pool.tiers.frontier) === anchorModel
		) {
			return pool;
		}
	}

	// 3. Match against built-in presets (enforcing provider prefix match if present)
	for (const [presetId, pool] of Object.entries(BUILTIN_ROUTING_PRESETS)) {
		if (disabledPresets.includes(presetId) || disabledPresets.includes(pool.id)) continue;
		if (provider && pool.provider && pool.provider !== provider && presetId !== anchorModel) {
			continue; // Provider mismatch!
		}

		const qualify = (tier: string) => (tier.includes("/") ? tier : `${pool.provider}/${tier}`);

		if (
			presetId === anchorModel ||
			pool.tiers.utility === modelName ||
			pool.tiers.balanced === modelName ||
			pool.tiers.frontier === modelName ||
			qualify(pool.tiers.utility) === anchorModel ||
			qualify(pool.tiers.balanced) === anchorModel ||
			qualify(pool.tiers.frontier) === anchorModel
		) {
			return pool;
		}
	}

	// No match - untiered or unknown model
	return undefined;
}
