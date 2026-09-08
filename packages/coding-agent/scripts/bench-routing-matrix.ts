import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	completeSimple,
	getBundledModel,
	type ImageContent,
	type Model,
	type TextContent,
	type UserMessage,
} from "@f5-sales-demo/pi-ai";
import { resolveAntigravityServingModelId } from "@f5-sales-demo/pi-ai/providers/google-gemini-cli";
import Ajv2020 from "ajv/dist/2020";
import { GoogleAuth } from "google-auth-library";
import { ModelRegistry, type ProviderDiscoveryState } from "../src/config/model-registry";
import { RoutingCoordinator } from "../src/routing/coordinator";
import { OPENAI_CODEX_ROUTING_POOL } from "../src/routing/subscription-profiles";
import type { RoutingPoolConfig, RoutingTier } from "../src/routing/types";

export type InventoryState =
	| "AVAILABLE"
	| "SIMULATED"
	| "BLOCKED_AUTH"
	| "BLOCKED_NETWORK"
	| "BLOCKED_RATE_LIMIT"
	| "UNSUPPORTED_DISCOVERY"
	| "FAIL_SCHEMA"
	| "FAIL_EMPTY_INVENTORY"
	| "FAIL_MISSING_TIERS";

export type RunStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED_UNTIERED" | "SIMULATED";

export interface LaneCapability {
	id: string;
	required: boolean;
	clientProvider: string;
	upstreamFamily: "openai" | "anthropic" | "google";
	endpointKind: "direct" | "gateway";
	poolId: string;
	inferenceApiType:
		| "openai-responses"
		| "openai-codex-responses"
		| "anthropic-messages"
		| "google-vertex"
		| "google-gemini-cli";
	inventoryAdapterId: "openai-compatible" | "anthropic" | "vertex-model-garden" | "oauth-entitlement";
	credentialResolverId: string;
	defaultBaseUrl?: string;
	multimodal: boolean;
	requireResponseModel: boolean;
	canProveUpstreamProvider: boolean;
	tiers: Record<RoutingTier, string>;
	effortPolicy?: RoutingPoolConfig["effortPolicy"];
}

export type BenchmarkProfile = "canonical" | "subscription";
export const CANONICAL_LANE_IDS = [
	"openai",
	"anthropic",
	"litellm-openai",
	"litellm-anthropic",
	"google-vertex",
] as const;
export const SUBSCRIPTION_LANE_IDS = ["google-antigravity", "openai-codex"] as const;

export const LANE_CAPABILITIES: Record<string, LaneCapability> = {
	openai: {
		id: "openai",
		required: true,
		clientProvider: "openai",
		upstreamFamily: "openai",
		endpointKind: "direct",
		poolId: "openai/gpt-5.6",
		inferenceApiType: "openai-responses",
		inventoryAdapterId: "openai-compatible",
		credentialResolverId: "xcsh-openai-direct",
		defaultBaseUrl: "https://api.openai.com/v1",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: true,
		tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
	},
	anthropic: {
		id: "anthropic",
		required: true,
		clientProvider: "anthropic",
		upstreamFamily: "anthropic",
		endpointKind: "direct",
		poolId: "anthropic/claude",
		inferenceApiType: "anthropic-messages",
		inventoryAdapterId: "anthropic",
		credentialResolverId: "xcsh-anthropic-direct",
		defaultBaseUrl: "https://api.anthropic.com",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: true,
		tiers: {
			utility: "claude-haiku-4-5",
			balanced: "claude-sonnet-5",
			frontier: "claude-opus-5",
		},
	},
	"litellm-openai": {
		id: "litellm-openai",
		required: true,
		clientProvider: "litellm",
		upstreamFamily: "openai",
		endpointKind: "gateway",
		poolId: "litellm/openai",
		inferenceApiType: "openai-responses",
		inventoryAdapterId: "openai-compatible",
		credentialResolverId: "xcsh-litellm-openai",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: false,
		tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
	},
	"litellm-anthropic": {
		id: "litellm-anthropic",
		required: true,
		clientProvider: "anthropic",
		upstreamFamily: "anthropic",
		endpointKind: "gateway",
		poolId: "litellm/anthropic",
		inferenceApiType: "anthropic-messages",
		inventoryAdapterId: "openai-compatible",
		credentialResolverId: "xcsh-litellm-anthropic",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: false,
		tiers: {
			utility: "claude-haiku-4-5",
			balanced: "claude-sonnet-5",
			frontier: "claude-opus-5",
		},
	},
	"google-vertex": {
		id: "google-vertex",
		required: true,
		clientProvider: "google-vertex",
		upstreamFamily: "google",
		endpointKind: "direct",
		poolId: "google-vertex/gemini",
		inferenceApiType: "google-vertex",
		inventoryAdapterId: "vertex-model-garden",
		credentialResolverId: "google-adc",
		multimodal: true,
		// The current Google Vertex SDK stream does not expose a response-reported model.
		requireResponseModel: false,
		canProveUpstreamProvider: true,
		tiers: { utility: "gemini-2.5-flash-lite", balanced: "gemini-2.5-flash", frontier: "gemini-2.5-pro" },
	},
	"google-antigravity": {
		id: "google-antigravity",
		required: true,
		clientProvider: "google-antigravity",
		upstreamFamily: "google",
		endpointKind: "gateway",
		poolId: "google-antigravity/subscription",
		inferenceApiType: "google-gemini-cli",
		inventoryAdapterId: "oauth-entitlement",
		credentialResolverId: "xcsh-auth-storage-google-antigravity",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: false,
		// Flash handles normal operations; the planning/frontier tier uses Pro.
		tiers: {
			utility: "gemini-3.6-flash-high",
			balanced: "gemini-3.6-flash-high",
			frontier: "gemini-3.1-pro-high-vertex",
		},
		effortPolicy: { byTier: { utility: "high", balanced: "high", frontier: "high" } },
	},
	"openai-codex": {
		id: "openai-codex",
		required: true,
		clientProvider: "openai-codex",
		upstreamFamily: "openai",
		endpointKind: "gateway",
		poolId: OPENAI_CODEX_ROUTING_POOL.id,
		inferenceApiType: "openai-codex-responses",
		inventoryAdapterId: "oauth-entitlement",
		credentialResolverId: "xcsh-auth-storage-openai-codex",
		multimodal: true,
		requireResponseModel: true,
		canProveUpstreamProvider: false,
		tiers: OPENAI_CODEX_ROUTING_POOL.tiers,
		effortPolicy: OPENAI_CODEX_ROUTING_POOL.effortPolicy,
	},
};

export interface BenchmarkArgs {
	profile: BenchmarkProfile;
	repetitions: number;
	warmups: number;
	lanes: string[];
	scenarios: string[];
	reportDir: string;
	dryRun: boolean;
	timeoutMs: number;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): BenchmarkArgs {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const repetitions = Number(get("--repetitions") ?? process.env.ROUTING_MATRIX_REPETITIONS ?? "3");
	const warmups = Number(get("--warmups") ?? process.env.ROUTING_MATRIX_WARMUPS ?? "1");
	const profile = (get("--profile") ?? process.env.ROUTING_MATRIX_PROFILE ?? "canonical") as BenchmarkProfile;
	if (profile !== "canonical" && profile !== "subscription") throw new Error(`Unknown profile: ${profile}`);
	const timeoutMs = Number(
		get("--timeout-ms") ?? process.env.ROUTING_MATRIX_TIMEOUT_MS ?? (profile === "subscription" ? "120000" : "20000"),
	);
	if (
		!Number.isInteger(repetitions) ||
		repetitions < 1 ||
		!Number.isInteger(warmups) ||
		warmups < 0 ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1
	) {
		throw new Error("Invalid benchmark counts or timeout");
	}
	const profileLanes = profile === "subscription" ? SUBSCRIPTION_LANE_IDS : CANONICAL_LANE_IDS;
	const lanes = (get("--lanes") ?? process.env.ROUTING_MATRIX_LANES ?? profileLanes.join(","))
		.split(",")
		.map(value => value.trim().toLowerCase())
		.filter(Boolean);
	for (const lane of lanes) {
		if (!LANE_CAPABILITIES[lane]) throw new Error(`Unknown lane: ${lane}`);
	}
	const scenarios = (get("--scenarios") ?? BASE_SCENARIOS.map(item => item.id).join(","))
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);
	for (const scenario of scenarios) {
		if (!ALL_SCENARIOS.some(item => item.id === scenario)) throw new Error(`Unknown scenario: ${scenario}`);
	}
	return {
		profile,
		repetitions,
		warmups,
		timeoutMs,
		lanes,
		scenarios,
		reportDir:
			get("--report-dir") ??
			get("--out") ??
			process.env.ROUTING_MATRIX_REPORT_DIR ??
			path.join("/tmp", "routing-matrix-reports", timestamp),
		dryRun: argv.includes("--dry-run") || process.env.ROUTING_MATRIX_DRY_RUN === "true",
	};
}

export interface LaneCredential {
	apiKey?: string;
	authMechanism?: "bearer" | "api-key" | "oauth-bearer" | "oauth-packed" | "google-adc";
	baseUrl?: string;
	inventoryBaseUrl?: string;
	project?: string;
	location?: string;
}

async function resolveAdcAccessToken(): Promise<string | undefined> {
	if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) return undefined;
	try {
		const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
		const client = await auth.getClient();
		const token = await client.getAccessToken();
		return typeof token === "string" ? token : (token?.token ?? undefined);
	} catch {
		return undefined;
	}
}

export async function resolveLaneCredentials(): Promise<Record<string, LaneCredential>> {
	let storage:
		| {
				getApiKey(provider: string): Promise<string | undefined>;
				getOAuthCredential?(provider: string): unknown;
				close?(): void;
		  }
		| undefined;
	try {
		const { discoverAuthStorage } = await import("../src/sdk");
		storage = await discoverAuthStorage();
	} catch {
		storage = undefined;
	}
	const key = async (provider: string, explicit?: string) => explicit ?? (await storage?.getApiKey(provider));
	const openai = await key("openai", process.env.OPENAI_API_KEY);
	const anthropic = await key("anthropic", process.env.ANTHROPIC_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY);
	const anthropicUsesOAuth = Boolean(process.env.ANTHROPIC_OAUTH_TOKEN || storage?.getOAuthCredential?.("anthropic"));
	const litellmOpenai = await key("litellm", process.env.LITELLM_OPENAI_API_KEY ?? process.env.LITELLM_API_KEY);
	const litellmAnthropic = await key("litellm", process.env.LITELLM_ANTHROPIC_API_KEY ?? process.env.LITELLM_API_KEY);
	const googleAntigravity = await key("google-antigravity", process.env.GOOGLE_ANTIGRAVITY_OAUTH_TOKEN);
	const openaiCodex = await key("openai-codex", process.env.OPENAI_CODEX_OAUTH_TOKEN);
	const adcToken = await resolveAdcAccessToken();
	storage?.close?.();
	const location = process.env.GOOGLE_CLOUD_LOCATION ?? process.env.VERTEX_LOCATION ?? "us-central1";
	const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? process.env.LITELLM_URL;
	return {
		openai: {
			apiKey: openai,
			authMechanism: openai ? "bearer" : undefined,
			baseUrl: process.env.OPENAI_BASE_URL ?? LANE_CAPABILITIES.openai.defaultBaseUrl,
		},
		anthropic: {
			apiKey: anthropic,
			authMechanism: anthropic ? (anthropicUsesOAuth ? "oauth-bearer" : "api-key") : undefined,
			baseUrl: process.env.ANTHROPIC_BASE_URL ?? LANE_CAPABILITIES.anthropic.defaultBaseUrl,
		},
		"litellm-openai": {
			apiKey: litellmOpenai,
			authMechanism: litellmOpenai ? "bearer" : undefined,
			baseUrl: process.env.LITELLM_OPENAI_BASE_URL ?? litellmBaseUrl,
		},
		"litellm-anthropic": {
			apiKey: litellmAnthropic,
			authMechanism: litellmAnthropic ? "bearer" : undefined,
			baseUrl:
				process.env.LITELLM_ANTHROPIC_BASE_URL ??
				(litellmBaseUrl ? `${litellmBaseUrl.replace(/\/+$/, "")}/anthropic` : undefined),
			inventoryBaseUrl: process.env.LITELLM_ANTHROPIC_INVENTORY_URL ?? litellmBaseUrl,
		},
		"google-vertex": {
			apiKey: adcToken,
			authMechanism: adcToken ? "google-adc" : undefined,
			project: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.VERTEX_PROJECT_ID,
			location,
			baseUrl: process.env.VERTEX_BASE_URL ?? `https://${location}-aiplatform.googleapis.com/v1beta1`,
		},
		"google-antigravity": {
			apiKey: googleAntigravity,
			authMechanism: googleAntigravity ? "oauth-packed" : undefined,
		},
		"openai-codex": {
			apiKey: openaiCodex,
			authMechanism: openaiCodex ? "oauth-packed" : undefined,
		},
	};
}

export interface InventoryResult {
	laneId: string;
	state: InventoryState;
	models: string[];
	endpointId: string;
	durationMs: number;
	httpStatus?: number;
	reasonCode?: string;
	missingTiers: string[];
	eligibleCandidates: string[];
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function endpointFingerprint(raw?: string): string {
	if (!raw) return "unconfigured";
	try {
		const url = new URL(raw);
		return createHash("sha256").update(`${url.protocol}//${url.host}${url.pathname}`).digest("hex").slice(0, 16);
	} catch {
		return "invalid-endpoint";
	}
}

function modelListUrl(capability: LaneCapability, credential: LaneCredential): string | undefined {
	const rawBase = credential.inventoryBaseUrl ?? credential.baseUrl;
	if (!rawBase) return undefined;
	const base = rawBase.replace(/\/+$/, "");
	if (capability.inventoryAdapterId === "vertex-model-garden") {
		return `${base}/publishers/google/models`;
	}
	if (/\/models$/.test(base)) return base;
	if (/\/v1$/.test(base)) return `${base}/models`;
	return `${base}/v1/models`;
}

function parseInventory(capability: LaneCapability, payload: unknown): string[] | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	let entries: unknown;
	if (capability.inventoryAdapterId === "vertex-model-garden") {
		entries = (payload as any).publisherModels;
	} else {
		entries = Array.isArray(payload) ? payload : ((payload as any).data ?? (payload as any).models);
	}
	if (!Array.isArray(entries)) return undefined;
	const models = entries
		.map(entry => {
			if (typeof entry === "string") return entry;
			if (!entry || typeof entry !== "object") return undefined;
			const raw = (entry as any).id ?? (entry as any).name;
			if (typeof raw !== "string" || raw.length === 0) return undefined;
			return capability.inventoryAdapterId === "vertex-model-garden" ? raw.split("/").pop() : raw;
		})
		.filter((value): value is string => Boolean(value));
	return [...new Set(models)].sort();
}

export async function discoverLaneInventory(
	capability: LaneCapability,
	credential: LaneCredential,
	fetchImpl: FetchLike = globalThis.fetch,
	signal?: AbortSignal,
): Promise<InventoryResult> {
	const started = performance.now();
	const url = modelListUrl(capability, credential);
	const base = {
		laneId: capability.id,
		models: [] as string[],
		endpointId: endpointFingerprint(url),
		durationMs: 0,
		missingTiers: [] as string[],
		eligibleCandidates: [] as string[],
	};
	if (!credential.apiKey || !credential.authMechanism) {
		return {
			...base,
			state: "BLOCKED_AUTH",
			durationMs: performance.now() - started,
			reasonCode: "missing_credentials",
		};
	}
	if (!url) {
		return {
			...base,
			state: "UNSUPPORTED_DISCOVERY",
			durationMs: performance.now() - started,
			reasonCode: "missing_inventory_endpoint",
		};
	}
	const headers = new Headers({ accept: "application/json" });
	if (capability.inventoryAdapterId === "anthropic") {
		if (credential.authMechanism === "oauth-bearer") {
			headers.set("authorization", `Bearer ${credential.apiKey}`);
			headers.set("anthropic-beta", "oauth-2025-04-20");
		} else {
			headers.set("x-api-key", credential.apiKey);
			headers.set("anthropic-version", "2023-06-01");
		}
	} else {
		headers.set("authorization", `Bearer ${credential.apiKey}`);
	}
	let response: Response;
	try {
		response = await fetchImpl(url, { method: "GET", headers, signal });
	} catch (error) {
		return {
			...base,
			state: "BLOCKED_NETWORK",
			durationMs: performance.now() - started,
			reasonCode:
				error instanceof DOMException && error.name === "AbortError"
					? "inventory_aborted"
					: "inventory_network_error",
		};
	}
	if (!response.ok) {
		const state: InventoryState =
			response.status === 401 || response.status === 403
				? "BLOCKED_AUTH"
				: response.status === 404
					? "UNSUPPORTED_DISCOVERY"
					: response.status === 429
						? "BLOCKED_RATE_LIMIT"
						: "BLOCKED_NETWORK";
		return {
			...base,
			state,
			httpStatus: response.status,
			durationMs: performance.now() - started,
			reasonCode: `inventory_http_${response.status}`,
		};
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { ...base, state: "FAIL_SCHEMA", durationMs: performance.now() - started, reasonCode: "malformed_json" };
	}
	const models = parseInventory(capability, payload);
	if (!models) {
		return {
			...base,
			state: "FAIL_SCHEMA",
			durationMs: performance.now() - started,
			reasonCode: "invalid_inventory_schema",
		};
	}
	if (models.length === 0) {
		return {
			...base,
			state: "FAIL_EMPTY_INVENTORY",
			durationMs: performance.now() - started,
			reasonCode: "empty_inventory",
		};
	}
	return { ...base, state: "AVAILABLE", models, durationMs: performance.now() - started };
}

export interface OAuthEntitlementSnapshot {
	state?: ProviderDiscoveryState;
	models: Model<any>[];
}

export type OAuthEntitlementResolver = (provider: string) => Promise<OAuthEntitlementSnapshot>;

async function resolveOAuthEntitlements(provider: string): Promise<OAuthEntitlementSnapshot> {
	const { discoverAuthStorage } = await import("../src/sdk");
	const storage = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(storage);
		await registry.refreshProvider(provider, "online");
		const state = registry.getProviderDiscoveryState(provider);
		const entitled = new Set(state?.models ?? []);
		return {
			state,
			models: registry.getAvailable().filter(model => model.provider === provider && entitled.has(model.id)),
		};
	} finally {
		storage.close();
	}
}

/**
 * Discover subscription models through the provider's authenticated entitlement endpoint.
 * Cached or bundled models are never accepted as live discovery evidence.
 */
export async function discoverOAuthEntitlementInventory(
	capability: LaneCapability,
	credential: LaneCredential,
	resolver: OAuthEntitlementResolver = resolveOAuthEntitlements,
): Promise<{ inventory: InventoryResult; models: Model<any>[] }> {
	const started = performance.now();
	const base: InventoryResult = {
		laneId: capability.id,
		state: "BLOCKED_AUTH",
		models: [],
		endpointId: createHash("sha256")
			.update(`oauth-entitlement:${capability.clientProvider}`)
			.digest("hex")
			.slice(0, 16),
		durationMs: 0,
		missingTiers: [],
		eligibleCandidates: [],
	};
	if (!credential.apiKey || credential.authMechanism !== "oauth-packed") {
		return {
			inventory: { ...base, durationMs: performance.now() - started, reasonCode: "missing_oauth_credentials" },
			models: [],
		};
	}
	let snapshot: OAuthEntitlementSnapshot;
	try {
		snapshot = await resolver(capability.clientProvider);
	} catch {
		return {
			inventory: {
				...base,
				state: "BLOCKED_NETWORK",
				durationMs: performance.now() - started,
				reasonCode: "entitlement_discovery_error",
			},
			models: [],
		};
	}
	const state = snapshot.state;
	if (!state) {
		return {
			inventory: {
				...base,
				state: "UNSUPPORTED_DISCOVERY",
				durationMs: performance.now() - started,
				reasonCode: "missing_entitlement_adapter_state",
			},
			models: [],
		};
	}
	if (state.status === "unauthenticated") {
		return {
			inventory: {
				...base,
				state: "BLOCKED_AUTH",
				durationMs: performance.now() - started,
				reasonCode: "entitlement_auth_failed",
			},
			models: [],
		};
	}
	if (state.status !== "ok" || state.stale) {
		return {
			inventory: {
				...base,
				state: "BLOCKED_NETWORK",
				durationMs: performance.now() - started,
				reasonCode: state.stale ? "stale_entitlement_inventory" : "entitlement_discovery_unavailable",
			},
			models: [],
		};
	}
	const modelsById = new Map(snapshot.models.map(model => [model.id, model]));
	const models = [...new Set(state.models)].sort();
	if (models.length === 0) {
		return {
			inventory: {
				...base,
				state: "FAIL_EMPTY_INVENTORY",
				durationMs: performance.now() - started,
				reasonCode: "empty_entitlement_inventory",
			},
			models: [],
		};
	}
	const missingRecords = models.filter(model => !modelsById.has(model));
	if (missingRecords.length > 0) {
		return {
			inventory: {
				...base,
				state: "FAIL_SCHEMA",
				models,
				durationMs: performance.now() - started,
				reasonCode: "missing_entitlement_model_metadata",
			},
			models: [],
		};
	}
	return {
		inventory: { ...base, state: "AVAILABLE", models, durationMs: performance.now() - started },
		models: models.map(model => modelsById.get(model)!),
	};
}

export function reconcileLaneInventory(
	capability: LaneCapability,
	models: string[],
): Pick<InventoryResult, "state" | "missingTiers" | "eligibleCandidates"> {
	const available = new Set(models.map(model => model.replace(/^models\//, "")));
	const configured = [...new Set([capability.tiers.utility, capability.tiers.balanced, capability.tiers.frontier])];
	const missingTiers = configured.filter(model => !available.has(model));
	const eligibleCandidates = configured
		.filter(model => available.has(model))
		.map(model => `${capability.clientProvider}/${model}`);
	return { state: missingTiers.length ? "FAIL_MISSING_TIERS" : "AVAILABLE", missingTiers, eligibleCandidates };
}

export interface ScenarioDefinition {
	id: string;
	name: string;
	expectedTier: RoutingTier;
	prompt: string;
	responseMarker: string;
	hasImages?: boolean;
	priorRejection?: boolean;
}

export const BASE_SCENARIOS: ScenarioDefinition[] = [
	{
		id: "utility-greeting",
		name: "Utility exact response",
		expectedTier: "utility",
		prompt: "Summarize this instruction silently, then output RESPOND_UTILITY_OK and nothing else.",
		responseMarker: "RESPOND_UTILITY_OK",
	},
	{
		id: "balanced-reasoning",
		name: "Balanced architecture reasoning",
		expectedTier: "balanced",
		prompt: "Analyze this architecture question silently. Output RESPOND_BALANCED_OK and nothing else.",
		responseMarker: "RESPOND_BALANCED_OK",
	},
	{
		id: "frontier-analysis",
		name: "Frontier architecture migration analysis",
		expectedTier: "frontier",
		prompt: "Perform a deep architecture migration analysis silently. Output RESPOND_FRONTIER_OK and nothing else.",
		responseMarker: "RESPOND_FRONTIER_OK",
	},
	{
		id: "multimodal-visual",
		name: "Frontier image-derived inspection",
		expectedTier: "frontier",
		prompt:
			"Perform a security architecture inspection of the attached image. Transcribe the large visible routing code exactly and output only that code.",
		responseMarker: "ROUTE-7C",
		hasImages: true,
	},
];

export const ESCALATION_SCENARIO: ScenarioDefinition = {
	id: "rejection-escalation",
	name: "Frontier rejection escalation",
	expectedTier: "frontier",
	prompt:
		"Re-evaluate the rejected architecture and security migration deeply. Output RESPOND_ESCALATION_OK and nothing else.",
	responseMarker: "RESPOND_ESCALATION_OK",
	priorRejection: true,
};

export const ALL_SCENARIOS: ScenarioDefinition[] = [...BASE_SCENARIOS, ESCALATION_SCENARIO];

export interface MatrixEntry {
	lane: string;
	anchorModel: string;
	scenario: ScenarioDefinition;
	repetition: number;
}

export function expandLaneScenarios(lanes: string[], repetitions = 1, scenarios = BASE_SCENARIOS): MatrixEntry[] {
	const rows: MatrixEntry[] = [];
	for (const lane of lanes) {
		const capability = LANE_CAPABILITIES[lane];
		if (!capability) throw new Error(`Unknown lane: ${lane}`);
		for (const scenario of scenarios) {
			for (let repetition = 1; repetition <= repetitions; repetition++) {
				rows.push({
					lane,
					anchorModel: `${capability.clientProvider}/${capability.tiers.utility}`,
					scenario,
					repetition,
				});
			}
		}
	}
	return rows;
}

export function extractResponseText(content: unknown): { ok: boolean; text: string; reasonCode?: string } {
	if (typeof content === "string") return { ok: true, text: content.trim() };
	if (!Array.isArray(content)) return { ok: false, text: "", reasonCode: "invalid_content_shape" };
	const text: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") return { ok: false, text: "", reasonCode: "invalid_content_block" };
		if ((block as any).type === "text" && typeof (block as any).text === "string") {
			text.push((block as any).text.trim());
			continue;
		}
		if ((block as any).type === "thinking" || (block as any).type === "redactedThinking") continue;
		return { ok: false, text: text.join("\n"), reasonCode: `unexpected_${String((block as any).type ?? "block")}` };
	}
	return { ok: text.length > 0, text: text.join("\n").trim(), reasonCode: text.length ? undefined : "missing_text" };
}

export interface ClassifyMeasuredRunOptions {
	effectiveTier?: RoutingTier;
	expectedTier: RoutingTier;
	requestedModel: string;
	expectedResponseModel?: string;
	responseModel?: string;
	clientProvider?: string;
	expectedClientProvider: string;
	responseContent: unknown;
	expectedMarker: string;
	stopReason?: string;
	totalTokens: number;
	requireResponseModel: boolean;
	blockedReasonCode?: string;
	error?: string;
}

export function classifyMeasuredRun(options: ClassifyMeasuredRunOptions): { status: RunStatus; reasonCode?: string } {
	if (options.blockedReasonCode) return { status: "BLOCKED", reasonCode: options.blockedReasonCode };
	if (options.effectiveTier !== options.expectedTier) return { status: "FAIL", reasonCode: "tier_mismatch" };
	if (options.error) return { status: "FAIL", reasonCode: "behavioral_error" };
	if (options.clientProvider !== options.expectedClientProvider)
		return { status: "FAIL", reasonCode: "client_provider_mismatch" };
	if (options.requireResponseModel && !options.responseModel)
		return { status: "FAIL", reasonCode: "missing_response_model" };
	if (
		options.responseModel &&
		normalizeModelId(options.responseModel) !==
			normalizeModelId(options.expectedResponseModel ?? options.requestedModel)
	) {
		return { status: "FAIL", reasonCode: "response_model_mismatch" };
	}
	if (options.stopReason !== "stop") return { status: "FAIL", reasonCode: "invalid_stop_reason" };
	const extracted = extractResponseText(options.responseContent);
	if (!extracted.ok) return { status: "FAIL", reasonCode: extracted.reasonCode };
	if (extracted.text !== options.expectedMarker) return { status: "FAIL", reasonCode: "marker_mismatch" };
	if (options.totalTokens <= 0) return { status: "FAIL", reasonCode: "invalid_usage" };
	return { status: "PASS" };
}

function normalizeModelId(model: string): string {
	return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

export interface ContractIntegrityOptions {
	dryRun: boolean;
	cleanWorktree: boolean;
	exactHead: boolean;
	secretScanPassed: boolean;
	expectedWarmups: number;
	expectedMeasured: number;
	inventories: Array<{ state: InventoryState }>;
	warmups: Array<{ status: RunStatus }>;
	measured: Array<{ status: RunStatus }>;
}

export function validateContractIntegrity(options: ContractIntegrityOptions): {
	matrixComplete: boolean;
	authoritative: boolean;
} {
	const allPass = (rows: Array<{ status: RunStatus }>) => rows.every(row => row.status === "PASS");
	const matrixComplete =
		!options.dryRun &&
		options.inventories.length > 0 &&
		options.inventories.every(item => item.state === "AVAILABLE") &&
		options.warmups.length === options.expectedWarmups &&
		options.measured.length === options.expectedMeasured &&
		allPass(options.warmups) &&
		allPass(options.measured);
	const authoritative = matrixComplete && options.cleanWorktree && options.exactHead && options.secretScanPassed;
	return { matrixComplete, authoritative };
}

export function computeExitCode(options: { hasFailure: boolean; hasBlocked: boolean; invalidCli: boolean }): number {
	if (options.invalidCli) return 64;
	if (options.hasFailure) return 1;
	if (options.hasBlocked) return 2;
	return 0;
}

export function redactSecretStrings<T>(value: T, secrets: string[] = []): T {
	const secretSet = secrets.filter(secret => secret.length >= 4);
	const visit = (node: unknown, key?: string): unknown => {
		if (Array.isArray(node)) return node.map(item => visit(item));
		if (node && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([entryKey, item]) => [entryKey, visit(item, entryKey)]));
		}
		if (typeof node !== "string") return node;
		if (key && /authorization|api[-_]?key|token|secret|credential|adcpath/i.test(key)) return "[REDACTED]";
		let sanitized = node;
		for (const secret of secretSet) sanitized = sanitized.split(secret).join("[REDACTED]");
		sanitized = sanitized.replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
		sanitized = sanitized.replace(/(https?:\/\/)([^:@/]+):([^@/]+)@/gi, "$1[REDACTED]:[REDACTED]@");
		sanitized = sanitized.replace(/([?&](?:api_key|key|token|access_token)=)[^&\s"']+/gi, "$1[REDACTED]");
		sanitized = sanitized.replace(
			/(?:[A-Za-z]:\\|\/)[^\s"']*(?:credential|service-account|adc)[^\s"']*\.json/gi,
			"[REDACTED_PATH]",
		);
		return sanitized;
	};
	return visit(value) as T;
}

export function sanitizeDiagnostic(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const sanitized = message.replace(/\n?raw-http-request=[^\s]+/gi, "").trim();
	return sanitized || undefined;
}

let reportValidator: ReturnType<Ajv2020["compile"]> | undefined;
export function validateRoutingMatrixReport(report: unknown): { valid: boolean; errors?: unknown } {
	if (!reportValidator) {
		const schemaPath = path.join(import.meta.dir, "routing-matrix-report.schema.json");
		const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
		reportValidator = new Ajv2020({ allErrors: true }).compile(schema);
	}
	const valid = reportValidator(report);
	return { valid: Boolean(valid), errors: reportValidator.errors };
}

const VISUAL_FIXTURE_PNG =
	"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";

export function createMultimodalMessage(prompt: string): UserMessage {
	const text: TextContent = { type: "text", text: prompt };
	const image: ImageContent = { type: "image", data: VISUAL_FIXTURE_PNG, mimeType: "image/png" };
	return { role: "user", content: [text, image], timestamp: Date.now() };
}

function constructModel(
	capability: LaneCapability,
	modelId: string,
	baseUrl?: string,
	discoveredModels: readonly Model<any>[] = [],
): Model<any> {
	const discovered = discoveredModels.find(
		model => model.provider === capability.clientProvider && model.id === modelId,
	);
	if (discovered) return baseUrl ? { ...discovered, baseUrl } : discovered;
	const bundled = getBundledModel(capability.clientProvider as any, modelId);
	if (bundled) return baseUrl ? { ...bundled, baseUrl } : bundled;
	return {
		id: modelId,
		name: modelId,
		provider: capability.clientProvider,
		api: capability.inferenceApiType,
		baseUrl: baseUrl ?? "",
		contextWindow: 128000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

function customPool(capability: LaneCapability): RoutingPoolConfig {
	return {
		id: capability.poolId,
		provider: capability.clientProvider,
		tiers: capability.tiers,
		effortPolicy: capability.effortPolicy,
	};
}

interface ReportRow {
	lane: string;
	kind: "warmup" | "measured";
	status: RunStatus;
	reasonCode?: string;
	diagnostic?: string;
	requestedModel?: string;
	responseModel?: string;
	clientProvider?: string;
	responseModelSource?: string;
	upstreamProvider?: string;
	upstreamProviderSource?: string;
	scenarioId?: string;
	repetition: number;
	effectiveTier?: RoutingTier;
	requestedEffort?: string;
	effortReason?: string;
	stopReason?: string;
	usage?: { input: number; output: number; totalTokens: number };
	startedAt: string;
	durationMs: number;
}

function responseEvidence(response: any): {
	responseModel?: string;
	responseModelSource?: string;
	upstreamProvider?: string;
	upstreamProviderSource?: string;
} {
	const attribution = response?.responseAttribution;
	return {
		responseModel: attribution?.responseModel,
		responseModelSource: attribution?.responseModelSource,
		upstreamProvider: attribution?.upstreamProvider,
		upstreamProviderSource: attribution?.upstreamProviderSource,
	};
}

function expectedResponseModel(capability: LaneCapability, requestedModel: string): string {
	return capability.id === "google-antigravity"
		? resolveAntigravityServingModelId(normalizeModelId(requestedModel))
		: requestedModel;
}

function normalizedUsage(response: any): { input: number; output: number; totalTokens: number } {
	const usage = response?.usage ?? {};
	const input = usage.input ?? usage.inputTokens ?? usage.promptTokens ?? 0;
	const output = usage.output ?? usage.outputTokens ?? usage.completionTokens ?? 0;
	return { input, output, totalTokens: usage.totalTokens ?? input + output };
}

function gitState(): { commit: string; clean: boolean; exactHead: boolean } {
	try {
		const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
		const clean = execSync("git status --porcelain", { encoding: "utf8" }).trim().length === 0;
		let exactHead = false;
		try {
			exactHead = commit === execSync("git rev-parse origin/main", { encoding: "utf8" }).trim();
		} catch {}
		return { commit, clean, exactHead };
	} catch {
		return { commit: "unknown", clean: false, exactHead: false };
	}
}

function scanCandidate(reportPath: string): boolean {
	try {
		const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
		execFileSync(
			"gitleaks",
			["dir", path.dirname(reportPath), "--no-banner", "--redact", "--config", path.join(root, ".gitleaks.toml")],
			{
				stdio: "pipe",
			},
		);
		return true;
	} catch {
		return false;
	}
}

async function run(): Promise<number> {
	let args: BenchmarkArgs;
	try {
		args = parseArgs();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 64;
	}
	const git = gitState();
	const credentials = await resolveLaneCredentials();
	const inventory: InventoryResult[] = [];
	const eligibleByLane = new Map<string, string[]>();
	const discoveredModelsByLane = new Map<string, Model<any>[]>();
	const secrets = Object.values(credentials).flatMap(item => (item.apiKey ? [item.apiKey] : []));
	for (const laneId of args.lanes) {
		const capability = LANE_CAPABILITIES[laneId];
		if (args.dryRun) {
			const models = Object.values(capability.tiers);
			const reconciled = reconcileLaneInventory(capability, models);
			inventory.push({
				laneId,
				state: "SIMULATED",
				models,
				endpointId: "simulated",
				durationMs: 0,
				missingTiers: [],
				eligibleCandidates: reconciled.eligibleCandidates,
			});
			eligibleByLane.set(laneId, reconciled.eligibleCandidates);
			continue;
		}
		const entitlement =
			capability.inventoryAdapterId === "oauth-entitlement"
				? await discoverOAuthEntitlementInventory(capability, credentials[laneId])
				: undefined;
		const discovered = entitlement
			? entitlement.inventory
			: await discoverLaneInventory(
					capability,
					credentials[laneId],
					globalThis.fetch,
					AbortSignal.timeout(args.timeoutMs),
				);
		if (entitlement?.models.length) discoveredModelsByLane.set(laneId, entitlement.models);
		if (discovered.state === "AVAILABLE") {
			const reconciled = reconcileLaneInventory(capability, discovered.models);
			discovered.state = reconciled.state;
			discovered.missingTiers = reconciled.missingTiers;
			discovered.eligibleCandidates = reconciled.eligibleCandidates;
			eligibleByLane.set(laneId, reconciled.eligibleCandidates);
		}
		inventory.push(discovered);
	}

	const warmupRows: ReportRow[] = [];
	for (const laneId of args.lanes) {
		const capability = LANE_CAPABILITIES[laneId];
		const discovered = inventory.find(item => item.laneId === laneId)!;
		for (let repetition = 1; repetition <= args.warmups; repetition++) {
			const startedAt = new Date().toISOString();
			const started = performance.now();
			if (args.dryRun) {
				warmupRows.push({
					lane: laneId,
					kind: "warmup",
					status: "SIMULATED",
					repetition,
					startedAt,
					durationMs: 0,
				});
				continue;
			}
			if (discovered.state !== "AVAILABLE") {
				warmupRows.push({
					lane: laneId,
					kind: "warmup",
					status: discovered.state.startsWith("FAIL") ? "FAIL" : "BLOCKED",
					reasonCode: discovered.reasonCode ?? discovered.state.toLowerCase(),
					repetition,
					startedAt,
					durationMs: performance.now() - started,
				});
				continue;
			}
			const requestedModel = capability.tiers.utility;
			try {
				const response = await completeSimple(
					constructModel(
						capability,
						requestedModel,
						credentials[laneId].baseUrl,
						discoveredModelsByLane.get(laneId),
					),
					{ systemPrompt: "Warmup", messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }] },
					{
						apiKey: credentials[laneId].apiKey,
						maxTokens: 8,
						reasoning: capability.effortPolicy?.byTier.utility as any,
						signal: AbortSignal.timeout(args.timeoutMs),
					},
				);
				const evidence = responseEvidence(response);
				const usage = normalizedUsage(response);
				const responseModelValid =
					!capability.requireResponseModel ||
					(evidence.responseModel !== undefined &&
						normalizeModelId(evidence.responseModel) ===
							normalizeModelId(expectedResponseModel(capability, requestedModel)));
				const clientProviderValid = response?.provider === capability.clientProvider;
				const status: RunStatus =
					response?.stopReason === "stop" && usage.totalTokens > 0 && responseModelValid && clientProviderValid
						? "PASS"
						: "FAIL";
				warmupRows.push({
					lane: laneId,
					kind: "warmup",
					status,
					reasonCode: status === "PASS" ? undefined : "warmup_behavioral_failure",
					diagnostic: sanitizeDiagnostic(response?.errorMessage),
					requestedModel,
					requestedEffort: capability.effortPolicy?.byTier.utility,
					clientProvider: response?.provider,
					...evidence,
					stopReason: response?.stopReason,
					usage,
					repetition,
					startedAt,
					durationMs: performance.now() - started,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const blocked = /401|403|429|unauthorized|forbidden|timeout|network|connect|dns/i.test(message);
				warmupRows.push({
					lane: laneId,
					kind: "warmup",
					status: blocked ? "BLOCKED" : "FAIL",
					reasonCode: blocked ? "warmup_external_block" : "warmup_behavioral_failure",
					diagnostic: sanitizeDiagnostic(message),
					requestedModel,
					repetition,
					startedAt,
					durationMs: performance.now() - started,
				});
			}
		}
	}

	const selectedScenarios = ALL_SCENARIOS.filter(item => args.scenarios.includes(item.id));
	const measuredRows: ReportRow[] = [];
	const coordinator = new RoutingCoordinator();
	for (const entry of expandLaneScenarios(args.lanes, args.repetitions, selectedScenarios)) {
		const capability = LANE_CAPABILITIES[entry.lane];
		const discovered = inventory.find(item => item.laneId === entry.lane)!;
		const startedAt = new Date().toISOString();
		const started = performance.now();
		if (!args.dryRun && discovered.state !== "AVAILABLE") {
			measuredRows.push({
				lane: entry.lane,
				kind: "measured",
				status: discovered.state.startsWith("FAIL") ? "FAIL" : "BLOCKED",
				reasonCode: discovered.reasonCode ?? discovered.state.toLowerCase(),
				scenarioId: entry.scenario.id,
				repetition: entry.repetition,
				startedAt,
				durationMs: performance.now() - started,
			});
			continue;
		}
		coordinator.reset();
		const pool = customPool(capability);
		const decision = await coordinator.evaluateTurn({
			anchorModel: entry.anchorModel,
			mode: "auto",
			prompt: entry.scenario.prompt,
			hasImages: entry.scenario.hasImages,
			priorRejection: entry.scenario.priorRejection,
			availableModels: eligibleByLane.get(entry.lane) ?? [],
			customPools: { [capability.poolId]: pool },
			profilerMode: "rules",
			tierEffort: capability.effortPolicy?.byTier as Record<string, string> | undefined,
			signal: AbortSignal.timeout(args.timeoutMs),
		});
		const requestedModel = decision.selectedModel ?? entry.anchorModel;
		if (args.dryRun) {
			measuredRows.push({
				lane: entry.lane,
				kind: "measured",
				status: "SIMULATED",
				requestedModel,
				requestedEffort: decision.selectedEffort,
				effortReason: decision.effortReason,
				scenarioId: entry.scenario.id,
				repetition: entry.repetition,
				effectiveTier: decision.effectiveTier,
				startedAt,
				durationMs: performance.now() - started,
			});
			continue;
		}
		try {
			const modelId = normalizeModelId(requestedModel);
			const message = entry.scenario.hasImages
				? createMultimodalMessage(entry.scenario.prompt)
				: { role: "user" as const, content: entry.scenario.prompt, timestamp: Date.now() };
			const response = await completeSimple(
				constructModel(
					capability,
					modelId,
					credentials[entry.lane].baseUrl,
					discoveredModelsByLane.get(entry.lane),
				),
				{ systemPrompt: "Follow the exact benchmark output contract.", messages: [message] },
				{
					apiKey: credentials[entry.lane].apiKey,
					maxTokens: 64,
					reasoning: decision.selectedEffort as any,
					signal: AbortSignal.timeout(args.timeoutMs),
				},
			);
			const evidence = responseEvidence(response);
			const usage = normalizedUsage(response);
			const classification = classifyMeasuredRun({
				effectiveTier: decision.effectiveTier,
				expectedTier: entry.scenario.expectedTier,
				requestedModel,
				expectedResponseModel: expectedResponseModel(capability, requestedModel),
				responseModel: evidence.responseModel,
				clientProvider: response?.provider,
				expectedClientProvider: capability.clientProvider,
				responseContent: response?.content,
				expectedMarker: entry.scenario.responseMarker,
				stopReason: response?.stopReason,
				totalTokens: usage.totalTokens,
				requireResponseModel: capability.requireResponseModel,
				error: response?.errorMessage,
			});
			measuredRows.push({
				lane: entry.lane,
				kind: "measured",
				status: classification.status,
				reasonCode: classification.reasonCode,
				diagnostic: sanitizeDiagnostic(response?.errorMessage),
				requestedModel,
				requestedEffort: decision.selectedEffort,
				effortReason: decision.effortReason,
				clientProvider: response?.provider,
				...evidence,
				scenarioId: entry.scenario.id,
				repetition: entry.repetition,
				effectiveTier: decision.effectiveTier,
				stopReason: response?.stopReason,
				usage,
				startedAt,
				durationMs: performance.now() - started,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const blocked = /401|403|429|unauthorized|forbidden|timeout|network|connect|dns/i.test(message);
			measuredRows.push({
				lane: entry.lane,
				kind: "measured",
				status: blocked ? "BLOCKED" : "FAIL",
				reasonCode: blocked ? "inference_external_block" : "inference_behavioral_failure",
				diagnostic: sanitizeDiagnostic(message),
				requestedModel,
				requestedEffort: decision.selectedEffort,
				effortReason: decision.effortReason,
				scenarioId: entry.scenario.id,
				repetition: entry.repetition,
				effectiveTier: decision.effectiveTier,
				startedAt,
				durationMs: performance.now() - started,
			});
		}
	}

	const expectedWarmups = args.lanes.length * args.warmups;
	const expectedMeasured = args.lanes.length * selectedScenarios.length * args.repetitions;
	const provisionalContract = validateContractIntegrity({
		dryRun: args.dryRun,
		cleanWorktree: git.clean,
		exactHead: git.exactHead,
		secretScanPassed: true,
		expectedWarmups,
		expectedMeasured,
		inventories: inventory,
		warmups: warmupRows,
		measured: measuredRows,
	});
	const report = redactSecretStrings(
		{
			schemaVersion: 3,
			startedAt: warmupRows[0]?.startedAt ?? measuredRows[0]?.startedAt ?? new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			git,
			parameters: args,
			capabilities: args.lanes.map(lane => LANE_CAPABILITIES[lane]),
			inventory,
			warmups: warmupRows,
			measured: measuredRows,
			summary: {
				...provisionalContract,
				expectedWarmups,
				expectedMeasured,
				passedWarmups: warmupRows.filter(row => row.status === "PASS").length,
				passedMeasured: measuredRows.filter(row => row.status === "PASS").length,
			},
			security: { redacted: true, secretScanPassed: true },
		},
		secrets,
	);
	const schema = validateRoutingMatrixReport(report);
	if (!schema.valid) {
		console.error("Report schema validation failed", schema.errors);
		return 1;
	}
	fs.mkdirSync(args.reportDir, { recursive: true });
	const candidate = path.join(args.reportDir, ".routing-matrix-report.candidate.json");
	const finalPath = path.join(args.reportDir, "routing-matrix-report.json");
	fs.writeFileSync(candidate, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	const secretScanPassed = scanCandidate(candidate);
	if (!secretScanPassed) {
		fs.rmSync(candidate, { force: true });
		console.error("Secret scan failed; no report published");
		return 1;
	}
	fs.renameSync(candidate, finalPath);
	const reportHash = createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
	fs.writeFileSync(
		path.join(args.reportDir, "routing-matrix-report.receipt.json"),
		`${JSON.stringify({ schemaVersion: 1, reportSha256: reportHash, scanner: "gitleaks", passed: true }, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	const hasFailure =
		[...inventory].some(item => item.state.startsWith("FAIL")) ||
		[...warmupRows, ...measuredRows].some(row => row.status === "FAIL");
	const hasBlocked =
		inventory.some(item => item.state.startsWith("BLOCKED") || item.state === "UNSUPPORTED_DISCOVERY") ||
		[...warmupRows, ...measuredRows].some(row => row.status === "BLOCKED");
	console.log(`Report: ${finalPath}`);
	console.log(`Warmups: ${warmupRows.filter(row => row.status === "PASS").length}/${expectedWarmups} PASS`);
	console.log(`Measured: ${measuredRows.filter(row => row.status === "PASS").length}/${expectedMeasured} PASS`);
	console.log(
		`Matrix complete: ${provisionalContract.matrixComplete}; authoritative: ${provisionalContract.authoritative}`,
	);
	return computeExitCode({ hasFailure, hasBlocked, invalidCli: false });
}

if (import.meta.main) {
	run()
		.then(code => process.exit(code))
		.catch(error => {
			console.error("Benchmark harness failed", error);
			process.exit(1);
		});
}
