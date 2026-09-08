import { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import { canonicalizeOAuthProviderId, type Model, ReasoningEffort } from "@f5-sales-demo/pi-ai";
import type { Settings } from "../../config/settings";
import type { VllmDiscoveredModel } from "../../config/vllm-config";
import {
	applySubscriptionProfileRoles,
	SUBSCRIPTION_ROUTING_PROFILES,
	type SubscriptionProfileId,
} from "../../routing/subscription-profiles";

export interface LoginModelChoice {
	label: string;
	description: string;
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface LiteLLMLoginModelChoice extends LoginModelChoice {
	provider: "anthropic" | "litellm";
	modelId: "claude-opus-5" | "gpt-5.6-sol";
}

export const LITELLM_LOGIN_MODEL_CHOICES: readonly LiteLLMLoginModelChoice[] = [
	{
		label: "GPT-5.6 Sol",
		description: "OpenAI-compatible model with high reasoning",
		provider: "litellm",
		modelId: "gpt-5.6-sol",
		thinkingLevel: ThinkingLevel.High,
	},
	{
		label: "Claude Opus 5",
		description: "Anthropic Messages model with high reasoning",
		provider: "anthropic",
		modelId: "claude-opus-5",
		thinkingLevel: ThinkingLevel.High,
	},
];

export const GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE: LoginModelChoice = {
	label: "Gemini 3.6 Flash High",
	description: "Google Antigravity model with high reasoning",
	provider: "google-antigravity",
	modelId: "gemini-3.6-flash-high",
	thinkingLevel: ThinkingLevel.High,
};

export const GOOGLE_VERTEX_LOGIN_MODEL_CHOICE: LoginModelChoice = {
	label: "Gemini 3.8 Flash High",
	description: "Corporate Vertex AI model with high reasoning",
	provider: "google-vertex",
	modelId: "gemini-3.8-flash",
	thinkingLevel: ThinkingLevel.High,
};

export const OPENAI_CODEX_LOGIN_MODEL_CHOICE: LoginModelChoice = {
	label: "GPT-5.6 Terra",
	description: "OpenAI Codex subscription model with medium reasoning",
	provider: "openai-codex",
	modelId: "gpt-5.6-terra",
	thinkingLevel: ThinkingLevel.Medium,
};

export const ANTHROPIC_LOGIN_MODEL_CHOICE: LoginModelChoice = {
	label: "Claude Sonnet 5",
	description: "Claude subscription default with medium thinking",
	provider: "anthropic",
	modelId: "claude-sonnet-5",
	thinkingLevel: ThinkingLevel.Medium,
};

export function getAvailableLiteLLMLoginModelChoices(availableModelIds: readonly string[]): LiteLLMLoginModelChoice[] {
	const available = new Set(availableModelIds);
	return LITELLM_LOGIN_MODEL_CHOICES.filter(choice => available.has(choice.modelId));
}

/**
 * Build the curated role defaults for a model family selected through LiteLLM.
 *
 * LiteLLM has its own model catalog, so this deliberately does not run OAuth
 * entitlement checks. It shares only the reviewed OAuth role policy and maps
 * that policy onto the provider namespace used by the LiteLLM configuration.
 */
export function getLiteLLMLoginModelRoles(
	choice: LiteLLMLoginModelChoice,
	currentRoles: Readonly<Record<string, string>>,
): Record<string, string> {
	const profileId: SubscriptionProfileId = choice.modelId === "claude-opus-5" ? "anthropic" : "openai-codex";
	const profile = SUBSCRIPTION_ROUTING_PROFILES[profileId];
	const roles = Object.fromEntries(
		Object.entries(profile.roles).map(([role, selector]) => {
			const slash = selector.indexOf("/");
			return [role, `${choice.provider}/${selector.slice(slash + 1)}`];
		}),
	);
	return { ...currentRoles, ...roles };
}

export function getVllmLoginModelChoices(models: readonly VllmDiscoveredModel[]): LoginModelChoice[] {
	return models.map(model => ({
		label: model.id,
		description:
			model.contextWindow === undefined
				? "Context limit not advertised; using compatibility defaults"
				: `${model.contextWindow.toLocaleString("en-US")} token context`,
		provider: "vllm",
		modelId: model.id,
	}));
}

function resolveLoginThinkingLevel(choice: LoginModelChoice, model: Model): ThinkingLevel {
	if (choice.thinkingLevel !== undefined) return choice.thinkingLevel;
	return model.thinking?.supportedLevels.some(level => level.effort === ReasoningEffort.None)
		? ThinkingLevel.Off
		: ThinkingLevel.Inherit;
}

export function formatLoginThinkingState(level: ThinkingLevel | undefined): string {
	if (level === undefined || level === ThinkingLevel.Inherit) return "provider default thinking";
	if (level === ThinkingLevel.Off) return "thinking off";
	return `thinking ${level}`;
}

/**
 * Minimal session surface needed to apply a model after a successful login.
 * Kept structural so the login flow can call it without pulling in the full
 * AgentSession type, and so it stays trivially unit-testable.
 */
interface BaseModelApplicableSession {
	modelRegistry: { getAll(): Model[] };
	setModel(model: Model, role: "default", options: { selector: string; thinkingLevel: ThinkingLevel }): Promise<void>;
}

interface ModelApplicableSession extends BaseModelApplicableSession {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	modelRegistry: {
		getAll(): Model[];
		getProviderDiscoveryState?(provider: string): { status: string; stale: boolean; models: string[] } | undefined;
	};
	settings?: Pick<Settings, "getModelRoles" | "get" | "set">;
	setModelTemporary?(model: Model, thinkingLevel?: ThinkingLevel): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
}

/**
 * After a successful `/login`, apply the model the user explicitly selected as
 * the active and persisted default model, including its thinking level.
 *
 * Returns true when the exact provider/model pair resolves after registry refresh.
 */
export async function applyModelAfterLogin(
	session: BaseModelApplicableSession,
	choice: LoginModelChoice,
): Promise<boolean> {
	const resolved = session.modelRegistry
		.getAll()
		.find(model => model.provider === choice.provider && model.id === choice.modelId);
	if (!resolved) return false;
	const selector = `${choice.provider}/${choice.modelId}`;
	await session.setModel(resolved, "default", {
		selector,
		thinkingLevel: resolveLoginThinkingLevel(choice, resolved),
	});
	return true;
}

/**
 * Apply a provider's curated model after OAuth login.
 *
 * Providers without a curated choice, or registries that do not advertise the
 * exact preferred model, leave the active and persisted model unchanged.
 */
export async function applyOAuthLoginModel(
	session: ModelApplicableSession,
	providerId: string,
): Promise<LoginModelChoice | undefined> {
	const canonicalProvider = canonicalizeOAuthProviderId(providerId);
	const choice =
		canonicalProvider === ANTHROPIC_LOGIN_MODEL_CHOICE.provider
			? ANTHROPIC_LOGIN_MODEL_CHOICE
			: canonicalProvider === GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE.provider
				? GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE
				: canonicalProvider === OPENAI_CODEX_LOGIN_MODEL_CHOICE.provider
					? OPENAI_CODEX_LOGIN_MODEL_CHOICE
					: undefined;
	if (!choice) return undefined;
	const discovery = session.modelRegistry.getProviderDiscoveryState?.(canonicalProvider);
	if (session.modelRegistry.getProviderDiscoveryState && (discovery?.status !== "ok" || discovery.stale)) {
		return undefined;
	}

	const settings = session.settings;
	const storedProfile = settings?.get("routing.profile");
	const previousProfile: "none" | SubscriptionProfileId =
		storedProfile === "anthropic" || storedProfile === "google-antigravity" || storedProfile === "openai-codex"
			? storedProfile
			: "none";
	const storedRoutingMode = settings?.get("routing.mode");
	const previousRoutingMode =
		storedRoutingMode === "shadow" || storedRoutingMode === "auto" ? storedRoutingMode : "off";
	const previousRoles = settings
		? Object.fromEntries(
				Object.entries(settings.getModelRoles()).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			)
		: {};
	const previousModel = session.model;
	const previousThinkingLevel = session.thinkingLevel;
	let nextRoles: Record<string, string> | undefined;
	if (settings) {
		const available = discovery
			? discovery.models.map(modelId => `${canonicalProvider}/${modelId}`)
			: session.modelRegistry.getAll().map(model => `${model.provider}/${model.id}`);
		const profile = applySubscriptionProfileRoles(
			canonicalProvider as SubscriptionProfileId,
			previousRoles,
			available,
		);
		if (!profile.applied) return undefined;
		nextRoles = profile.roles;
	}

	try {
		if (settings && nextRoles) {
			settings.set("modelRoles", nextRoles);
			settings.set("routing.mode", "off");
			settings.set("routing.profile", canonicalProvider as SubscriptionProfileId);
		}
		const applied = await applyModelAfterLogin(session, choice);
		if (!applied && settings) {
			settings.set("modelRoles", previousRoles);
			settings.set("routing.mode", previousRoutingMode);
			settings.set("routing.profile", previousProfile);
		}
		return applied ? choice : undefined;
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		if (settings) {
			try {
				settings.set("modelRoles", previousRoles);
				settings.set("routing.mode", previousRoutingMode);
				settings.set("routing.profile", previousProfile);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		try {
			if (previousModel && session.setModelTemporary) {
				await session.setModelTemporary(previousModel, previousThinkingLevel);
			} else if (previousThinkingLevel !== undefined) {
				session.setThinkingLevel(previousThinkingLevel);
			}
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError([error, ...rollbackErrors], "OAuth login model rollback was incomplete");
		}
		throw error;
	}
}
