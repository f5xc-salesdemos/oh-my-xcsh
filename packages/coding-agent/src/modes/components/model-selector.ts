import { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import { getSupportedReasoningEfforts, type Model, modelsAreEqual, ReasoningEffort } from "@f5-sales-demo/pi-ai";
import {
	Container,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	type Tab,
	TabBar,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@f5-sales-demo/pi-tui";
import type { ModelRegistry, ProviderDiscoveryState, ProviderDiscoveryStatus } from "../../config/model-registry";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS, MODEL_ROLES } from "../../config/model-registry";
import { resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { fuzzyFilter } from "../../utils/fuzzy";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";

function makeInvertedBadge(label: string, color: ThemeColor): string {
	const fgAnsi = theme.getFgAnsi(color);
	const bgAnsi = fgAnsi.replace(/\x1b\[38;/g, "\x1b[48;");
	return `${bgAnsi}\x1b[30m ${label} \x1b[39m\x1b[49m`;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function compactSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getAlphaSearchTokens(query: string): string[] {
	return [...normalizeSearchText(query).matchAll(/[a-z]+/g)].map(match => match[0]).filter(token => token.length > 0);
}

export interface ModelItem {
	kind: "provider";
	provider: string;
	id: string;
	model: Model;
	selector: string;
}

interface CanonicalModelItem {
	kind: "canonical";
	id: string;
	model: Model;
	selector: string;
	variantCount: number;
	searchText: string;
	normalizedSearchText: string;
	compactSearchText: string;
}

interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export interface DefaultPickerModelPresentation {
	model: Model;
	displaySelector: string;
	selector: string;
}

/** Present every service selector exactly; access tiers are not interchangeable aliases. */
export function presentModelsForDefaultPicker(
	models: readonly Model[],
	_explicitlyScoped = false,
): DefaultPickerModelPresentation[] {
	return models
		.filter(model => model.visibility !== "hide")
		.map(model => {
			const selector = `${model.provider}/${model.id}`;
			return { model, displaySelector: selector, selector };
		});
}

export function getModelSearchText(item: DefaultPickerModelPresentation): string {
	const { model, selector } = item;
	return [model.provider, model.publisher, model.family, model.tier, model.name, model.description, selector]
		.filter(Boolean)
		.join(" ");
}

function getModelDisplayName(model: Model): string {
	const tieredName = [model.family, model.tier].filter(Boolean).join(" ");
	if (tieredName && compactSearchText(tieredName) === compactSearchText(model.name)) return tieredName;
	return model.name;
}

function getModelPublisher(model: Model): string {
	if (model.publisher) return model.publisher;
	if (model.provider.startsWith("google-")) return "Google";
	if (model.provider === "openai" || model.provider === "openai-codex") return "OpenAI";
	if (model.provider === "anthropic") return "Anthropic";
	return getProviderDisplayName(model.provider);
}

function getModelFamily(model: Model): string {
	if (model.family) return model.family;
	if (model.provider === "anthropic" && /^claude-(?:haiku|sonnet|opus)-/i.test(model.id)) return "Claude";
	return (
		model.name.match(/^(?:Gemini\s+\d+(?:\.\d+)?|GPT-\d+(?:\.\d+)?|Claude\s+\S+(?:\s+\d+(?:\.\d+)?)?)/i)?.[0] ??
		model.name
	);
}

function modelHierarchyKey(item: ModelItem, includeProvider: boolean): string {
	return [
		includeProvider ? getProviderDisplayName(item.provider) : "",
		getModelPublisher(item.model),
		getModelFamily(item.model),
	]
		.join("\0")
		.toLocaleLowerCase();
}

function sortModelsByHierarchy(items: ModelItem[], includeProvider: boolean): void {
	items.sort((left, right) =>
		modelHierarchyKey(left, includeProvider).localeCompare(modelHierarchyKey(right, includeProvider)),
	);
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Keep historical catalogs authoritative while presenting only current user-facing families. */
export function filterCurrentBrowserModels(models: readonly Model[]): Model[] {
	const newestGeminiVersion = new Map<string, string>();
	const newestClaudeVersion = new Map<string, string>();
	for (const model of models) {
		if (model.provider.startsWith("google-")) {
			const gemini = model.id.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-|$)/i);
			if (gemini?.[1] && gemini[2]) {
				const key = `${model.provider}:${gemini[2].toLowerCase()}`;
				const previous = newestGeminiVersion.get(key);
				if (!previous || compareVersions(gemini[1], previous) > 0) newestGeminiVersion.set(key, gemini[1]);
			}
		}
		const claude = model.id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?(?:-|$)/i);
		if (claude?.[1] && claude[2]) {
			const key = `${model.provider}:${claude[1].toLowerCase()}`;
			const version = `${claude[2]}.${claude[3] ?? "0"}`;
			const previous = newestClaudeVersion.get(key);
			if (!previous || compareVersions(version, previous) > 0) newestClaudeVersion.set(key, version);
		}
	}

	return models.filter(model => {
		const gpt = model.id.match(/^gpt-(\d+(?:\.\d+)?)(?:-|$)/i);
		if (gpt?.[1]) {
			// Older GPT generations are still available through explicit --models scopes,
			// but the general browser starts at the current 5.6 family.
			if (compareVersions(gpt[1], "5.6") < 0) return false;
			if (model.provider === "openai-codex") return /^gpt-5\.6-(?:sol|terra|luna)$/i.test(model.id);
		}
		const claude = model.id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?(?:-|$)/i);
		if (claude?.[1] && claude[2]) {
			const version = `${claude[2]}.${claude[3] ?? "0"}`;
			return newestClaudeVersion.get(`${model.provider}:${claude[1].toLowerCase()}`) === version;
		}
		if (!model.provider.startsWith("google-")) return true;
		if (!model.id.startsWith("gemini-")) {
			// Antigravity discovery can expose implementation-only experiment ids
			// alongside its supported Gemini, Claude, and GPT-OSS catalog.
			return model.provider === "google-antigravity" && /^gpt-oss-/i.test(model.id);
		}
		const match = model.id.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-|$)/i);
		if (!match?.[1] || !match[2]) return false;
		return newestGeminiVersion.get(`${model.provider}:${match[2].toLowerCase()}`) === match[1];
	});
}

export function getProviderDisplayName(provider: string): string {
	if (provider === "anthropic") return "Anthropic / Claude";
	if (provider === "openai-codex") return "ChatGPT Subscription";
	if (provider === "openai") return "OpenAI API Key";
	if (provider === "google-vertex") return "Google Vertex";
	if (provider === "google-antigravity") return "Antigravity (Gemini, Claude, GPT-OSS)";
	if (provider === "vllm") return "vLLM";
	if (provider === "lm-studio") return "LM Studio";
	if (provider === "llama.cpp") return "llama.cpp";
	if (provider === "ollama") return "Ollama";
	return provider
		.split("-")
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

const LOCAL_PROVIDER_IDS = new Set(["ollama", "vllm", "lm-studio", "llama.cpp"]);
const LOCAL_PROVIDERS_TAB = "local-providers";

export interface ProviderModelGroup {
	id: string;
	label: string;
	classification: "authenticated" | "local";
	discoveryStatus: ProviderDiscoveryStatus;
	stale: boolean;
	models: ModelItem[];
	providers: string[];
}

function modelItems(models: readonly Model[], currentOnly = true): ModelItem[] {
	return presentModelsForDefaultPicker(currentOnly ? filterCurrentBrowserModels(models) : models).map(item => ({
		kind: "provider",
		provider: item.model.provider,
		id: item.displaySelector.slice(item.displaySelector.indexOf("/") + 1),
		model: item.model,
		selector: item.selector,
	}));
}

/** Provider identity is independent of catalog discovery success. */
export function buildProviderModelGroups(
	models: readonly Model[],
	getDiscoveryState: (provider: string) => ProviderDiscoveryState | undefined,
	configuredProviderOrder: readonly string[] = [],
	currentProvider?: string,
	hasAuth: (provider: string) => boolean = () => true,
	currentOnly = true,
	inventory: readonly string[] = [],
): ProviderModelGroup[] {
	const items = modelItems(models, currentOnly);
	const byProvider = new Map<string, ModelItem[]>();
	for (const item of items) {
		const providerItems = byProvider.get(item.provider) ?? [];
		providerItems.push(item);
		byProvider.set(item.provider, providerItems);
	}

	for (const provider of inventory) {
		if (!byProvider.has(provider)) byProvider.set(provider, []);
	}
	const authenticated: ProviderModelGroup[] = [];
	const localProviders: string[] = [];
	const localItems: ModelItem[] = [];
	let localStale = false;
	for (const [provider, providerItems] of byProvider) {
		const discovery = getDiscoveryState(provider);
		if (LOCAL_PROVIDER_IDS.has(provider)) {
			localProviders.push(provider);
			localStale ||= discovery?.status !== "ok" || discovery.stale;
			localItems.push(...providerItems);
			continue;
		}
		if (!hasAuth(provider) && !inventory.includes(provider)) continue;
		sortModelsByHierarchy(providerItems, false);
		authenticated.push({
			id: provider,
			label: getProviderDisplayName(provider),
			classification: "authenticated",
			discoveryStatus: !hasAuth(provider) ? "unauthenticated" : (discovery?.status ?? "idle"),
			stale: discovery?.stale ?? true,
			providers: [provider],
			models: providerItems,
		});
	}

	const configuredRank = new Map<string, number>();
	for (const provider of configuredProviderOrder) {
		const normalized = provider.trim().toLowerCase();
		if (normalized && !configuredRank.has(normalized)) configuredRank.set(normalized, configuredRank.size);
	}
	authenticated.sort((left, right) => {
		if (left.id === currentProvider && right.id !== currentProvider) return -1;
		if (right.id === currentProvider && left.id !== currentProvider) return 1;
		const leftRank = configuredRank.get(left.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		const rightRank = configuredRank.get(right.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.label.localeCompare(right.label);
	});

	if (localProviders.length > 0) {
		sortModelsByHierarchy(localItems, true);
		const localGroup: ProviderModelGroup = {
			id: LOCAL_PROVIDERS_TAB,
			label: "Local Providers",
			classification: "local",
			discoveryStatus: localStale ? "cached" : "ok",
			stale: localStale,
			models: localItems,
			providers: localProviders,
		};
		if (currentProvider && LOCAL_PROVIDER_IDS.has(currentProvider)) authenticated.unshift(localGroup);
		else authenticated.push(localGroup);
	}
	return authenticated;
}

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;
}

export interface ModelSelection {
	scope: "conversation" | "default" | "role";
	model: Model;
	selector: string;
	thinkingLevel: ThinkingLevel;
	role?: string;
}
type RoleSelectCallback = (selection: ModelSelection) => void | Promise<void>;
type CancelCallback = () => void;
interface MenuRoleAction {
	label: string;
	role: string; // now accepts custom role strings
}

/**
 * Component that renders a model selector with provider tabs and context menu.
 * - Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate model list
 * - Enter: Open context menu to select action
 * - Escape: Close menu or selector
 */
export class ModelSelectorComponent extends Container {
	#searchInput: Input;
	#headerContainer: Container;
	#tabBar: TabBar | null = null;
	#listContainer: Container;
	#menuContainer: Container;
	#allModels: ModelItem[] = [];
	#filteredModels: ModelItem[] = [];
	#canonicalModels: CanonicalModelItem[] = [];
	#filteredCanonicalModels: CanonicalModelItem[] = [];
	#selectedIndex: number = 0;
	#roles = {} as Record<string, RoleAssignment | undefined>;
	#settings = null as unknown as Settings;
	#modelRegistry = null as unknown as ModelRegistry;
	#onSelectCallback = (() => {}) as RoleSelectCallback;
	#onCancelCallback = (() => {}) as CancelCallback;
	#errorMessage?: unknown;
	#tui: TUI;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#temporaryOnly: boolean;
	#currentModel: Model | undefined;
	#providerGroups: ProviderModelGroup[] = [];
	#refreshingProvider?: string;
	#spinnerFrame = 0;
	#spinnerTimer?: ReturnType<typeof setInterval>;
	#pendingRefreshes = 0;
	#panelHeight = 0;
	#panelLayoutKey = "";

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.#isMenuOpen) return lines;
		const key = `${width}:${this.#getActiveProvider()}:${this.#searchInput.getValue()}`;
		if (key !== this.#panelLayoutKey) {
			this.#panelLayoutKey = key;
			this.#panelHeight = 0;
		}
		this.#panelHeight = Math.max(this.#panelHeight, lines.length);
		// Keep established space when refresh removes rows; navigation may establish a new layout.
		lines.splice(lines.length - 1, 0, ...Array<string>(this.#panelHeight - lines.length).fill(""));
		return lines;
	}

	#stopSpinner(): void {
		if (this.#spinnerTimer) clearInterval(this.#spinnerTimer);
		this.#spinnerTimer = undefined;
	}

	dispose(): void {
		this.#stopSpinner();
	}

	#renderProviderStatus(width: number): string[] {
		if (this.#isMenuOpen) return [];
		const group = this.#providerGroups[this.#activeTabIndex];
		// Reserve the same status area for every provider. Updating status never moves the catalog.
		const rows = Array<string>(1 + Math.max(1, ...this.#providerGroups.map(group => group.providers.length))).fill(
			"",
		);
		if (!group || this.#searchInput.getValue().trim()) return rows;
		const refreshing = this.#refreshingProvider === group.id;
		if (refreshing) {
			const frames = theme.spinnerFrames.length ? theme.spinnerFrames : ["⠋", "⠙", "⠹", "⠸"];
			rows[0] = theme.fg(
				"muted",
				`  ${frames[this.#spinnerFrame % frames.length]} Refreshing ${group.label} model list…`,
			);
		} else if (
			group.providers.some(
				provider => this.#modelRegistry.getProviderDiscoveryState?.(provider)?.status === "cached",
			)
		) {
			const state = this.#modelRegistry.getProviderDiscoveryState?.(group.id);
			const age = this.#formatDiscoveryAge(state?.fetchedAt);
			rows[0] = theme.fg("muted", `  Cached model list${age ? ` from ${age}` : ""}. Ctrl+R to refresh.`);
		}
		for (const [index, provider] of group.providers.entries()) {
			const state = this.#modelRegistry.getProviderDiscoveryState?.(provider);
			const label = getProviderDisplayName(provider);
			let message = "";
			let color: ThemeColor = "muted";
			if (state?.error) {
				message = `${label}: ${state.error} · Ctrl+R: retry`;
				color = "warning";
			} else if (state?.status === "unauthenticated" || group.discoveryStatus === "unauthenticated") {
				message = `${label}: authentication required · Ctrl+L: login`;
				color = "warning";
			} else if (!state || state.status === "idle") message = `${label}: availability unverified · Ctrl+R: refresh`;
			else if (state.status === "ok" && state.models.length === 0)
				message = `${label}: empty catalog · Ctrl+R: refresh`;
			rows[index + 1] = theme.fg(color, message);
		}
		return rows.map(row => truncateToWidth(row, width));
	}

	#menuRoleActions: MenuRoleAction[] = [];

	// Tab state
	#providers: string[] = [];
	#activeTabIndex: number = 0;

	// Context menu state
	#isMenuOpen: boolean = false;
	#menuSelectedIndex: number = 0;
	#menuStep: "scope" | "role" | "thinking" = "scope";
	#menuScope: ModelSelection["scope"] = "conversation";
	#menuItem?: ModelItem | CanonicalModelItem;
	#applying = false;
	#onLogin?: () => void;
	#currentThinkingLevel: ThinkingLevel = ThinkingLevel.Inherit;
	#menuSelectedRole: string | null = null;

	constructor(
		tui: TUI,
		_currentModel: Model | undefined,
		settings: Settings,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: RoleSelectCallback,
		onCancel: () => void,
		options?: {
			temporaryOnly?: boolean;
			initialSearchInput?: string;
			currentThinkingLevel?: ThinkingLevel;
			onLogin?: () => void;
		},
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		this.#onLogin = options?.onLogin;
		this.#currentModel = _currentModel;
		this.#currentThinkingLevel = options?.currentThinkingLevel ?? ThinkingLevel.Inherit;
		const initialSearchInput = options?.initialSearchInput;

		// Initialize menu role actions (built-in + custom from settings)
		this.#buildMenuRoleActions();

		// Load current role assignments from settings
		this.#loadRoleModels();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		const hintText =
			scopedModels.length > 0
				? "Showing models from --models scope"
				: "Only showing models from configured providers (see README for details)";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create header container for tab bar
		this.#headerContainer = new Container();
		this.addChild(this.#headerContainer);

		this.addChild(new Spacer(1));

		// Create search input
		this.#searchInput = new Input();
		if (initialSearchInput) {
			this.#searchInput.setValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			// Enter on search input opens menu if we have a selection
			if (this.#filteredModels[this.#selectedIndex]) {
				this.#openMenu();
			}
		};
		this.addChild(this.#searchInput);

		this.addChild(new Spacer(1));

		// Status has fixed rows and renders independently of the model list.
		this.addChild({ render: width => this.#renderProviderStatus(width), invalidate() {} });

		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		// Create menu container (hidden by default)
		this.#menuContainer = new Container();
		this.addChild(this.#menuContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.#loadModels().then(() => {
			this.#buildProviderTabs();
			this.#updateTabBar();
			// Always apply the current search query — the user may have typed
			// while models were loading asynchronously.
			const currentQuery = this.#searchInput.getValue();
			if (currentQuery) {
				this.#filterModels(currentQuery);
			} else {
				this.#applyTabFilter();
			}
			// Request re-render after models are loaded
			this.#tui.requestRender();
			void this.#refreshSelectedProvider().catch(error => {
				this.#errorMessage = String(error);
				this.#updateList();
				this.#tui.requestRender();
			});
		});
	}

	#buildMenuRoleActions(): void {
		this.#menuRoleActions = getKnownRoleIds(this.#settings).map(role => {
			const roleInfo = getRoleInfo(role, this.#settings);
			const roleLabel = roleInfo.tag ? `${roleInfo.tag} (${roleInfo.name})` : roleInfo.name;
			return {
				label: `Set as ${roleLabel}`,
				role,
			};
		});
	}

	#loadRoleModels(): void {
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		for (const role of getKnownRoleIds(this.#settings)) {
			const roleValue = this.#settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (resolved.warning) this.#errorMessage = resolved.warning;
			if (resolved.model) {
				this.#roles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
				};
			}
		}
	}

	#sortModels(models: ModelItem[]): void {
		// Sort: tagged models (default/smol/slow/plan) first, then MRU, then alphabetical
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (model: ModelItem) => {
			let i = 0;
			while (i < MODEL_ROLE_IDS.length) {
				const role = MODEL_ROLE_IDS[i];
				const assigned = this.#roles[role];
				if (assigned && modelsAreEqual(assigned.model, model.model)) {
					break;
				}
				i++;
			}
			return i;
		};

		const dateRe = /-(\d{8})$/;
		const latestRe = /-latest$/;

		models.sort((a, b) => {
			const aKey = a.selector;
			const bKey = b.selector;

			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			// Then MRU order (models in mruIndex come before those not in it)
			const aMru = mruIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			// By provider, then recency within provider
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;

			// Priority field (lower = better, e.g. Codex priority values)
			const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
			const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
			if (aPri !== bPri) return aPri - bPri;

			// Version number descending (higher version = better model)
			const aVer = extractVersionNumber(a.id);
			const bVer = extractVersionNumber(b.id);
			if (aVer !== bVer) return bVer - aVer;

			const aIsLatest = latestRe.test(a.id);
			const bIsLatest = latestRe.test(b.id);
			const aDate = a.id.match(dateRe)?.[1] ?? "";
			const bDate = b.id.match(dateRe)?.[1] ?? "";

			// Both have dates or latest tags — sort by recency
			const aHasRecency = aIsLatest || aDate !== "";
			const bHasRecency = bIsLatest || bDate !== "";

			// Models with recency info come before those without
			if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

			// If neither has recency info, fall back to alphabetical
			if (!aHasRecency) return a.id.localeCompare(b.id);

			// -latest always sorts first within recency group
			if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

			// Both have dates — descending (newest first)
			if (aDate && bDate) return bDate.localeCompare(aDate);

			// One has date, other is latest — latest first
			return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
		});
	}

	#sortCanonicalModels(models: CanonicalModelItem[]): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (model: CanonicalModelItem) => {
			let i = 0;
			while (i < MODEL_ROLE_IDS.length) {
				const role = MODEL_ROLE_IDS[i];
				const assigned = this.#roles[role];
				if (assigned && modelsAreEqual(assigned.model, model.model)) {
					break;
				}
				i++;
			}
			return i;
		};

		models.sort((a, b) => {
			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			const aMru = mruIndex.get(`${a.model.provider}/${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(`${b.model.provider}/${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = a.model.provider.localeCompare(b.model.provider);
			if (providerCmp !== 0) return providerCmp;

			return a.id.localeCompare(b.id);
		});
	}

	async #loadModels(): Promise<void> {
		let models: ModelItem[];

		// Use scoped models if provided via --models flag
		if (this.#scopedModels.length > 0) {
			models = presentModelsForDefaultPicker(
				this.#scopedModels.map(scoped => scoped.model),
				true,
			).map(item => ({
				kind: "provider",
				provider: item.model.provider,
				id: item.displaySelector.slice(item.displaySelector.indexOf("/") + 1),
				model: item.model,
				selector: item.selector,
			}));
		} else {
			// Render the current inventory immediately; the selected-provider refresh
			// joins the registry queue without blocking navigation on startup discovery.

			// Check for models.json errors
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			} else if (!this.#errorMessage) {
				this.#errorMessage = undefined;
			}

			// Load available models (built-in models still work even if models.json failed)
			try {
				models = this.#availableItems();
			} catch (error) {
				this.#allModels = [];
				this.#filteredModels = [];
				this.#canonicalModels = [];
				this.#filteredCanonicalModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		this.#sortModels(models);

		this.#allModels = models;
		this.#filteredModels = models;
		this.#canonicalModels = [];
		this.#filteredCanonicalModels = [];
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, models.length - 1));
	}

	#availableItems(): ModelItem[] {
		const available = this.#modelRegistry.getAvailable();
		const retained = [this.#currentModel, ...Object.values(this.#roles).map(role => role?.model)].filter(
			(model): model is Model => Boolean(model),
		);
		const items = modelItems(available);
		for (const model of retained) {
			if (
				this.#modelRegistry.getProviderInventory &&
				!this.#modelRegistry.getProviderInventory().includes(model.provider)
			)
				continue;
			if (!items.some(item => modelsAreEqual(item.model, model))) items.push(...modelItems([model], false));
		}
		return items;
	}

	#buildProviderTabs(): void {
		const previousProvider = this.#getActiveProvider();
		const discoveryState = (provider: string): ProviderDiscoveryState | undefined => {
			if (this.#scopedModels.length > 0 || typeof this.#modelRegistry.getProviderDiscoveryState !== "function") {
				return { provider, status: "ok", optional: false, stale: false, models: [] };
			}
			return this.#modelRegistry.getProviderDiscoveryState(provider);
		};
		const configuredOrder = this.#settings.get("modelProviderOrder");
		this.#providerGroups = buildProviderModelGroups(
			this.#allModels.map(item => item.model),
			discoveryState,
			configuredOrder,
			this.#currentModel?.provider,
			provider =>
				this.#scopedModels.length > 0 ||
				typeof this.#modelRegistry.authStorage?.hasAuth !== "function" ||
				this.#modelRegistry.isProviderKeyless?.(provider) ||
				this.#modelRegistry.authStorage.hasAuth(provider),
			false,
			this.#scopedModels.length > 0 ? [] : (this.#modelRegistry.getProviderInventory?.() ?? []),
		);
		this.#providers = this.#providerGroups.map(group => group.id);
		const previousIndex = this.#providers.indexOf(previousProvider);
		this.#activeTabIndex = previousIndex >= 0 ? previousIndex : 0;
	}

	async #refreshSelectedProvider(): Promise<void> {
		const activeGroup = this.#providerGroups[this.#activeTabIndex];
		if (!activeGroup || typeof this.#modelRegistry.refreshProvider !== "function" || this.#scopedModels.length > 0)
			return;
		const selectedSelector = this.#getSelectedItem()?.selector;
		this.#refreshingProvider = activeGroup.id;
		this.#pendingRefreshes++;
		if (!this.#spinnerTimer) {
			this.#spinnerTimer = setInterval(() => {
				this.#spinnerFrame++;
				this.#tui.requestRender();
			}, 80);
			this.#spinnerTimer.unref();
		}
		this.#updateList();
		this.#tui.requestRender();
		const providers = new Set(activeGroup.providers);
		// Keep probing optional local runtimes without advertising absent installations.
		if (activeGroup.classification === "local") {
			for (const provider of this.#modelRegistry.getDiscoverableProviders?.() ?? []) {
				if (LOCAL_PROVIDER_IDS.has(provider)) providers.add(provider);
			}
		}
		try {
			await Promise.all([...providers].map(provider => this.#modelRegistry.refreshProvider(provider, "online")));
			const models = this.#availableItems();
			this.#sortModels(models);
			this.#allModels = models;
			this.#buildProviderTabs();
			this.#updateTabBar();
			this.#applyTabFilter();
			const refreshedIndex =
				this.#getActiveProvider() === activeGroup.id
					? this.#filteredModels.findIndex(item => item.selector === selectedSelector)
					: -1;
			if (refreshedIndex >= 0) this.#selectedIndex = refreshedIndex;
		} finally {
			if (--this.#pendingRefreshes === 0) this.#stopSpinner();
			if (this.#refreshingProvider === activeGroup.id) this.#refreshingProvider = undefined;
			this.#updateList();
			this.#tui.requestRender();
		}
	}

	#updateTabBar(): void {
		this.#headerContainer.clear();

		const tabs: Tab[] = this.#providerGroups.map(group => ({
			id: group.id,
			label: group.label,
		}));
		const tabBar = new TabBar("Models", tabs, getTabBarTheme(), this.#activeTabIndex);
		tabBar.onTabChange = (_tab, index) => {
			this.#activeTabIndex = index;
			this.#selectedIndex = 0;
			this.#applyTabFilter();
			void this.#refreshSelectedProvider().catch(error => {
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				this.#updateList();
				this.#tui.requestRender();
			});
		};
		this.#tabBar = tabBar;
		this.#headerContainer.addChild(tabBar);
		if (this.#currentModel)
			this.#headerContainer.addChild(
				new Text(
					theme.fg(
						"muted",
						`Active: ${this.#currentModel.provider}/${this.#currentModel.id} (${this.#currentThinkingLevel})`,
					),
					0,
					0,
				),
			);
		this.#headerContainer.addChild(
			new Text(
				theme.fg("dim", "Tab/Shift+Tab: provider · Enter: choose\nCtrl+R: refresh · Ctrl+L: login · Esc: back"),
				0,
				0,
			),
		);
	}

	#getActiveProvider(): string {
		return this.#providers[this.#activeTabIndex] ?? "";
	}

	#isCanonicalTab(): boolean {
		return false;
	}

	#filterModels(query: string): void {
		const isCanonicalTab = false;
		const activeGroup = this.#providerGroups[this.#activeTabIndex];

		// Search is a temporary global grouped view; the active provider tab remains unchanged.
		const baseModels = query.trim()
			? this.#providerGroups.flatMap(group => group.models)
			: (activeGroup?.models ?? []);
		const baseCanonicalModels = this.#canonicalModels;

		// Apply fuzzy filter if query is present
		if (query.trim()) {
			if (isCanonicalTab) {
				const alphaTokens = getAlphaSearchTokens(query);
				const alphaFiltered =
					alphaTokens.length === 0
						? baseCanonicalModels
						: baseCanonicalModels.filter(item =>
								alphaTokens.every(token => item.normalizedSearchText.includes(token)),
							);
				const compactQuery = compactSearchText(query);
				const substringFiltered =
					compactQuery.length === 0
						? alphaFiltered
						: alphaFiltered.filter(item => item.compactSearchText.includes(compactQuery));
				const fuzzySource =
					substringFiltered.length > 0
						? substringFiltered
						: alphaFiltered.length > 0
							? alphaFiltered
							: baseCanonicalModels;
				const fuzzyMatches = fuzzyFilter(fuzzySource, query, ({ searchText }) => searchText);
				this.#sortCanonicalModels(fuzzyMatches);
				this.#filteredCanonicalModels = fuzzyMatches;
			} else {
				const selectorQuery = query.trim().toLowerCase();
				const selectorMatches = selectorQuery.includes("/")
					? baseModels.filter(item => item.selector.toLowerCase().includes(selectorQuery))
					: undefined;
				const alphaTokens = getAlphaSearchTokens(query);
				const alphaFiltered = (selectorMatches ?? baseModels).filter(item => {
					const searchText = normalizeSearchText(
						getModelSearchText({ model: item.model, selector: item.selector, displaySelector: item.selector }),
					);
					return alphaTokens.every(token => searchText.includes(token));
				});
				const fuzzyMatches = fuzzyFilter(
					selectorMatches ?? (alphaFiltered.length > 0 ? alphaFiltered : baseModels),
					query,
					({ model, selector }) => getModelSearchText({ model, selector, displaySelector: selector }),
				);
				this.#sortModels(fuzzyMatches);
				sortModelsByHierarchy(fuzzyMatches, true);
				this.#filteredModels = fuzzyMatches;
			}
		} else {
			this.#filteredModels = baseModels;
			this.#filteredCanonicalModels = baseCanonicalModels;
		}

		const visibleCount = isCanonicalTab ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, visibleCount - 1));
		this.#updateList();
	}

	#applyTabFilter(): void {
		const query = this.#searchInput.getValue();
		this.#filterModels(query);
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) {
			return undefined;
		}
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) {
			return "less than a minute ago";
		}
		const ageMinutes = Math.round(ageMs / 60_000);
		return `${ageMinutes}m ago`;
	}

	#getProviderEmptyStateMessage(): string | undefined {
		const activeGroup = this.#providerGroups[this.#activeTabIndex];
		if (!activeGroup || activeGroup.classification === "local" || this.#searchInput.getValue().trim()) {
			return undefined;
		}
		const state = this.#modelRegistry.getProviderDiscoveryState(activeGroup.id);
		if (!state) {
			return undefined;
		}
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable":
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "ok":
				return "  Provider reported no models.";
		}
	}

	#updateList(): void {
		if (this.#isMenuOpen) return;
		this.#listContainer.clear();
		const isCanonicalTab = this.#isCanonicalTab();
		const visibleItems = isCanonicalTab ? this.#filteredCanonicalModels : this.#filteredModels;

		const maxVisible = Math.max(1, Math.min(6, Math.floor(((this.#tui.terminal?.rows ?? 40) - 17) / 3)));
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, visibleItems.length);

		const activeGroup = this.#providerGroups[this.#activeTabIndex];
		const searching = Boolean(this.#searchInput.getValue().trim());
		const showProvider = searching || activeGroup?.classification === "local";

		// Show visible slice of filtered models
		let previousGroup: string | undefined;
		for (let i = startIndex; i < endIndex; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			const canonicalItem = isCanonicalTab ? (item as CanonicalModelItem) : undefined;
			const providerItem = isCanonicalTab ? undefined : (item as ModelItem);
			const group = showProvider
				? [
						getProviderDisplayName(providerItem?.provider ?? ""),
						getModelPublisher(item.model),
						getModelFamily(item.model),
					]
						.filter(Boolean)
						.join(" › ")
				: [getModelPublisher(item.model), getModelFamily(item.model)].filter(Boolean).join(" › ");
			if (group && group !== previousGroup) {
				if (previousGroup) this.#listContainer.addChild(new Spacer(1));
				this.#listContainer.addChild(new Text(theme.fg("muted", `  ${group}`), 0, 0));
				previousGroup = group;
			}

			const isSelected = i === this.#selectedIndex;

			// Build role badges (inverted: color as background, black text)
			const roleBadgeTokens: string[] = [];
			for (const role of MODEL_ROLE_IDS) {
				const { tag, color } = getRoleInfo(role, this.#settings);
				const assigned = this.#roles[role];
				if (!tag || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;

				const badge = makeInvertedBadge(tag, color ?? "success");
				const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
				roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
			}
			// Custom role badges
			for (const [role, assigned] of Object.entries(this.#roles)) {
				if (role in MODEL_ROLES || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;
				const roleInfo = getRoleInfo(role, this.#settings);
				const badgeLabel = roleInfo.tag ?? roleInfo.name;
				const badge = makeInvertedBadge(badgeLabel, roleInfo.color ?? "muted");
				const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
				roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
			}
			const badgeText = roleBadgeTokens.length > 0 ? ` ${roleBadgeTokens.join(" ")}` : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${theme.fg("accent", item.id)}${variants}${backing}${badgeText}`;
				} else {
					line = `${prefix}${theme.fg("accent", getModelDisplayName(item.model))} ${theme.fg("dim", `[${item.selector}]`)}${badgeText}`;
				}
			} else {
				const prefix = "  ";
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${item.id}${variants}${backing}${badgeText}`;
				} else {
					line = `${prefix}${getModelDisplayName(item.model)} ${theme.fg("dim", `[${item.selector}]`)}${badgeText}`;
				}
			}

			this.#listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < visibleItems.length) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${visibleItems.length})`);
			this.#listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.#errorMessage) {
			const errorLines = String(this.#errorMessage).split("\n");
			for (const line of errorLines) {
				this.#listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (visibleItems.length === 0) {
			const statusMessage = this.#getProviderEmptyStateMessage();
			this.#listContainer.addChild(new Text(theme.fg("muted", statusMessage ?? "  No matching models"), 0, 0));
		} else {
			const selected = visibleItems[this.#selectedIndex];
			if (!selected) {
				return;
			}
			this.#listContainer.addChild(new Spacer(1));
			const suffix = isCanonicalTab
				? ` (${selected.model.provider}/${selected.model.id}, ${(selected as CanonicalModelItem).variantCount} variants)`
				: "";
			this.#listContainer.addChild(
				new Text(theme.fg("muted", `  Model Name: ${getModelDisplayName(selected.model)}${suffix}`), 0, 0),
			);
		}
	}
	#getThinkingLevelsForModel(model: Model): ReadonlyArray<ThinkingLevel> {
		return [
			ThinkingLevel.Inherit,
			...getSupportedReasoningEfforts(model).map(level =>
				level === ReasoningEffort.None ? ThinkingLevel.Off : (level as ThinkingLevel),
			),
		];
	}

	#getCurrentRoleThinkingLevel(role: string): ThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}

	#getThinkingPreselectIndex(role: string, model: Model): number {
		const options = this.#getThinkingLevelsForModel(model);
		const currentLevel =
			this.#menuScope === "conversation" ? this.#currentThinkingLevel : this.#getCurrentRoleThinkingLevel(role);
		const foundIndex = options.indexOf(currentLevel);
		return foundIndex >= 0 ? foundIndex : 0;
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | undefined {
		return this.#isCanonicalTab()
			? this.#filteredCanonicalModels[this.#selectedIndex]
			: this.#filteredModels[this.#selectedIndex];
	}

	#openMenu(): void {
		this.#menuItem = this.#getSelectedItem();
		if (!this.#menuItem) return;
		this.#isMenuOpen = true;
		this.#menuScope = "conversation";
		this.#menuStep = "scope";
		this.#menuSelectedRole = null;
		this.#menuSelectedIndex = 0;
		this.#updateMenu();
	}

	#openThinkingMenu(role: string): void {
		const selected = this.#menuItem ?? this.#getSelectedItem();
		if (!selected) return;
		this.#menuItem = selected;
		this.#isMenuOpen = true;
		this.#menuStep = "thinking";
		this.#menuSelectedRole = role;
		this.#menuSelectedIndex = this.#getThinkingPreselectIndex(role, selected.model);
		this.#updateMenu();
	}

	#closeMenu(): void {
		this.#isMenuOpen = false;
		this.#menuStep = "role";
		this.#menuSelectedRole = null;
		this.#menuItem = undefined;
		this.#menuContainer.clear();
		this.#updateList();
	}

	#updateMenu(): void {
		this.#menuContainer.clear();
		this.#listContainer.clear();

		const selectedItem = this.#menuItem;
		if (!selectedItem) return;

		const showingThinking = this.#menuStep === "thinking" && this.#menuSelectedRole !== null;
		const thinkingOptions = showingThinking ? this.#getThinkingLevelsForModel(selectedItem.model) : [];
		const optionLines = showingThinking
			? thinkingOptions.map((thinkingLevel, index) => {
					const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
					const label = getThinkingLevelMetadata(thinkingLevel).label;
					const effort = thinkingLevel === ThinkingLevel.Off ? ReasoningEffort.None : thinkingLevel;
					const description =
						thinkingLevel === ThinkingLevel.Inherit
							? `Use the provider default (${selectedItem.model.thinking?.defaultLevel ?? "off"})`
							: selectedItem.model.thinking?.supportedLevels.find(level => level.effort === effort)?.description;
					return `${prefix}${label}${description ? ` — ${description}` : ""}`;
				})
			: this.#menuStep === "scope"
				? this.#scopeActions().map(
						(label, index) => `${index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    "}${label}`,
					)
				: this.#menuRoleActions.map((action, index) => {
						const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
						return `${prefix}${action.label}`;
					});

		const selectedRoleName = this.#menuSelectedRole
			? this.#menuScope === "conversation"
				? "This conversation"
				: getRoleInfo(this.#menuSelectedRole, this.#settings).name
			: "";
		const headerText =
			showingThinking && this.#menuSelectedRole
				? `  Thinking for: ${selectedRoleName} (${selectedItem.id})`
				: `  Action for: ${selectedItem.id}`;
		const hintText = showingThinking ? "  Enter: confirm  Esc: back" : "  Enter: continue  Esc: cancel";
		const menuWidth = Math.max(
			visibleWidth(headerText),
			visibleWidth(hintText),
			...optionLines.map(line => visibleWidth(line)),
		);

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
		if (showingThinking && this.#menuSelectedRole) {
			this.#menuContainer.addChild(
				new Text(
					theme.fg("text", `  Thinking for: ${theme.bold(selectedRoleName)} (${theme.bold(selectedItem.id)})`),
					0,
					0,
				),
			);
		} else {
			this.#menuContainer.addChild(new Text(theme.fg("text", `  Action for: ${theme.bold(selectedItem.id)}`), 0, 0));
		}
		this.#menuContainer.addChild(new Spacer(1));

		for (let i = 0; i < optionLines.length; i++) {
			const lineText = optionLines[i];
			if (!lineText) continue;
			const isSelected = i === this.#menuSelectedIndex;
			const line = isSelected ? theme.fg("accent", lineText) : theme.fg("muted", lineText);
			this.#menuContainer.addChild(new Text(line, 0, 0));
		}

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
	}

	handleInput(keyData: string): void {
		if (this.#applying) return;
		if (this.#isMenuOpen) {
			this.#handleMenuInput(keyData);
			return;
		}

		// Tab bar navigation
		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}

		if (matchesKey(keyData, "ctrl+l") && this.#onLogin) {
			this.#stopSpinner();
			this.#onLogin();
			return;
		}

		if (matchesKey(keyData, "ctrl+r")) {
			void this.#refreshSelectedProvider().catch(error => {
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				this.#updateList();
				this.#tui.requestRender();
			});
			return;
		}

		// Up arrow - navigate list (wrap to bottom when at top)
		if (matchesKey(keyData, "up")) {
			const itemCount = this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? itemCount - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}

		// Down arrow - navigate list (wrap to top when at bottom)
		if (matchesKey(keyData, "down")) {
			const itemCount = this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === itemCount - 1 ? 0 : this.#selectedIndex + 1;
			this.#updateList();
			return;
		}

		// Enter selects the model and opens its exact reasoning picker.
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem) {
				this.#openMenu();
			}
			return;
		}

		// Escape or Ctrl+C - close selector
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#stopSpinner();
			this.#onCancelCallback();
			return;
		}

		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}
	#handleMenuInput(keyData: string): void {
		const selectedItem = this.#menuItem;
		if (!selectedItem) return;

		const optionCount =
			this.#menuStep === "thinking" && this.#menuSelectedRole !== null
				? this.#getThinkingLevelsForModel(selectedItem.model).length
				: this.#menuStep === "scope"
					? this.#scopeActions().length
					: this.#menuRoleActions.length;
		if (optionCount === 0) return;

		if (matchesKey(keyData, "up")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex - 1 + optionCount) % optionCount;
			this.#updateMenu();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex + 1) % optionCount;
			this.#updateMenu();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#menuStep === "scope") {
				this.#menuScope = (["conversation", "default", "role"] as const)[this.#menuSelectedIndex];
				if (this.#menuScope === "role") {
					this.#menuStep = "role";
					this.#menuSelectedIndex = 0;
					this.#updateMenu();
				} else this.#openThinkingMenu("default");
				return;
			}
			if (this.#menuStep === "role") {
				this.#menuScope = "role";
				const action = this.#menuRoleActions[this.#menuSelectedIndex];
				if (!action) return;
				this.#menuSelectedRole = action.role;
				this.#menuStep = "thinking";
				this.#menuSelectedIndex = this.#getThinkingPreselectIndex(action.role, selectedItem.model);
				this.#updateMenu();
				return;
			}

			if (!this.#menuSelectedRole) return;
			const thinkingOptions = this.#getThinkingLevelsForModel(selectedItem.model);
			const thinkingLevel = thinkingOptions[this.#menuSelectedIndex];
			if (!thinkingLevel) return;
			void this.#handleSelect(selectedItem, thinkingLevel);
			return;
		}

		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			if (this.#menuStep === "thinking" && this.#menuSelectedRole !== null) {
				this.#menuStep = this.#menuScope === "role" ? "role" : "scope";
				const roleIndex = this.#menuRoleActions.findIndex(action => action.role === this.#menuSelectedRole);
				this.#menuSelectedRole = null;
				this.#menuSelectedIndex =
					this.#menuScope === "role" ? Math.max(0, roleIndex) : this.#menuScope === "default" ? 1 : 0;
				this.#updateMenu();
				return;
			}
			this.#closeMenu();
			return;
		}
	}

	#scopeActions(): string[] {
		return this.#temporaryOnly
			? ["Use in this conversation"]
			: ["Use in this conversation", "Save as default", "Assign to role"];
	}

	async #handleSelect(item: ModelItem | CanonicalModelItem, thinkingLevel: ThinkingLevel): Promise<void> {
		const selection: ModelSelection = {
			scope: this.#menuScope === "role" && this.#menuSelectedRole === "default" ? "default" : this.#menuScope,
			model: item.model,
			selector: item.selector,
			thinkingLevel,
			...(this.#menuScope === "role" ? { role: this.#menuSelectedRole! } : {}),
		};
		this.#applying = true;
		try {
			await this.#onSelectCallback(selection);
			if (selection.scope !== "conversation") {
				const role = selection.scope === "default" ? "default" : selection.role!;
				this.#roles[role] = { model: item.model, thinkingLevel };
			}
			this.#errorMessage = undefined;
			this.#closeMenu();
		} catch (error) {
			this.#errorMessage = error instanceof Error ? error.message : String(error);
			this.#closeMenu();
		} finally {
			this.#applying = false;
			this.#tui.requestRender();
		}
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
}

/** Extract the first version number from a model ID (e.g. "gemini-2.5-pro" → 2.5, "claude-sonnet-4-6" → 4.6). */
function extractVersionNumber(id: string): number {
	// Dot-separated version: "gemini-2.5-pro" → 2.5
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	// Dash-separated short segments: "claude-sonnet-4-6" → 4.6, "llama-3-1-8b" → 3.1
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	// Single number after separator: "gpt-4o" → 4
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}
