import type { OAuthProviderInfo } from "@f5-sales-demo/pi-ai";
import { Container, Input, matchesKey, Spacer, Text, TruncatedText } from "@f5-sales-demo/pi-tui";
import type { ProviderAccessState } from "../../config/model-registry";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage } from "../../session/auth-storage";
import { getLoginOptions } from "../controllers/login-options";
import { DynamicBorder } from "./dynamic-border";
/**
 * Component that renders an OAuth provider selector.
 */
export class OAuthSelectorComponent extends Container {
	static readonly MAX_VISIBLE_PROVIDERS = 10;

	#listContainer: Container;
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchInput: Input;
	#selectedIndex: number = 0;
	#mode: "login" | "logout";
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#getAccessState?: (providerId: string) => ProviderAccessState;
	#validateAccess?: (providerId: string) => Promise<ProviderAccessState>;
	#isExcluded?: (providerId: string) => boolean;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;
	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			getAccessState?: (providerId: string) => ProviderAccessState;
			validateAccess?: (providerId: string) => Promise<ProviderAccessState>;
			isExcluded?: (providerId: string) => boolean;
			requestRender?: () => void;
		},
	) {
		super();
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#getAccessState = options?.getAccessState;
		this.#validateAccess = options?.validateAccess;
		this.#isExcluded = options?.isExcluded;
		this.#requestRenderCallback = options?.requestRender;
		// Load all OAuth providers
		this.#loadProviders();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		// Add title
		const title = mode === "login" ? "Select provider to login:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Type to filter providers:"), 0, 0));
		this.#searchInput = new Input();
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		// Add bottom border
		this.addChild(new DynamicBorder());
		// Initial render
		this.#updateList();
		this.#startValidation();
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}
	#loadProviders(): void {
		this.#allProviders =
			this.#mode === "login"
				? getLoginOptions()
				: getLoginOptions().filter(provider => !provider.loginOnly && provider.id !== "google-vertex");
		// Keep the curated registry order stable except for explicit priorities.
		this.#allProviders = this.#allProviders
			.map((provider, index) => ({ provider, index }))
			.sort((a, b) => (a.provider.loginOrder ?? 0) - (b.provider.loginOrder ?? 0) || a.index - b.index)
			.map(({ provider }) => provider);
		this.#filteredProviders = this.#allProviders;
	}

	#filterProviders(query: string): void {
		const normalizedQuery = query.trim().toLowerCase();
		this.#filteredProviders = normalizedQuery
			? this.#allProviders.filter(provider =>
					`${provider.name} ${provider.id}`.toLowerCase().includes(normalizedQuery),
				)
			: this.#allProviders;
		this.#selectedIndex = 0;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback && !this.#validateAccess) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#allProviders) {
			const access = this.#getAccessState?.(provider.id);
			if (!this.#authStorage.hasAuth(provider.id) && access?.credentialSource !== "keyless") {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback && !this.#validateAccess) return;
		let result: "valid" | "invalid" | undefined;
		try {
			if (this.#validateAccess) {
				const access = await this.#validateAccess(providerId);
				if (access.status === "connected") result = "valid";
				else if (access.status === "reauth-required") result = "invalid";
			} else {
				result = (await this.#validateAuthCallback!(providerId)) ? "valid" : "invalid";
			}
		} catch {
			result = undefined;
		}

		if (generation !== this.#validationGeneration) return;
		if (result) this.#authState.set(providerId, result);
		else this.#authState.delete(providerId);
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#updateList();
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#getStatusIndicator(providerId: string): string {
		const excluded = this.#isExcluded?.(providerId) ? theme.fg("muted", " · excluded from picker") : "";
		const state = this.#authState.get(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? `${theme.spinnerFrames[this.#spinnerFrame % frameCount]} ` : "";
			return theme.fg("warning", ` ${spinner}checking`) + excluded;
		}
		const access = this.#getAccessState?.(providerId);
		if (state === "invalid" || access?.status === "reauth-required") {
			return theme.fg("error", ` ${theme.status.error} re-authentication required`) + excluded;
		}
		if (access?.status === "unreachable") {
			return theme.fg("warning", ` ${theme.status.warning} unreachable`) + excluded;
		}
		if (access?.credentialSource === "keyless") {
			return theme.fg("success", ` ${theme.status.success} keyless configured`) + excluded;
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.success} connected`) + excluded;
		}
		let label = "";
		if (access?.status === "configured-unverified") label = theme.fg("warning", " credential detected");
		else if (access?.status === "connected") label = theme.fg("success", ` ${theme.status.success} connected`);
		else if (!access && this.#authStorage.hasAuth(providerId)) label = theme.fg("warning", " credential detected");
		return label + excluded;
	}
	#updateList(): void {
		this.#listContainer.clear();
		const maxVisible = OAuthSelectorComponent.MAX_VISIBLE_PROVIDERS;
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - maxVisible + 1, this.#filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.#filteredProviders[i];
			if (!provider) continue;
			const isSelected = i === this.#selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("chromeAccent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("contentAccent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			this.#listContainer.addChild(new TruncatedText(line, 0, 0));
			if (provider.description) {
				this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `     ${provider.description}`), 0, 0));
			}
		}

		// Show "no providers" if empty
		if (this.#allProviders.length === 0) {
			const message =
				this.#mode === "login" ? "No OAuth providers available" : "No OAuth providers logged in. Use /login first.";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		} else if (this.#filteredProviders.length === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "  No matching providers"), 0, 0));
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  0 matches (${this.#allProviders.length} total)`), 0, 0),
			);
		} else if (this.#searchInput.getValue()) {
			const matchLabel = this.#filteredProviders.length === 1 ? "match" : "matches";
			this.#listContainer.addChild(
				new TruncatedText(
					theme.fg(
						"muted",
						`  ${this.#filteredProviders.length} ${matchLabel} (${this.#allProviders.length} total)`,
					),
					0,
					0,
				),
			);
		} else {
			this.#listContainer.addChild(
				new TruncatedText(
					theme.fg("muted", `  Showing ${startIndex + 1}-${endIndex} of ${this.#filteredProviders.length}`),
					0,
					0,
				),
			);
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", `  ${this.#statusMessage}`), 0, 0));
		}
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(
			new TruncatedText(theme.fg("muted", "  Type to filter providers · Enter: select · Esc: clear/cancel"), 0, 0),
		);
	}
	handleInput(keyData: string): void {
		// Up arrow
		if (matchesKey(keyData, "up")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Down arrow
		else if (matchesKey(keyData, "down")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page up
		else if (matchesKey(keyData, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - OAuthSelectorComponent.MAX_VISIBLE_PROVIDERS);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page down
		else if (matchesKey(keyData, "pageDown")) {
			this.#selectedIndex = Math.min(
				Math.max(0, this.#filteredProviders.length - 1),
				this.#selectedIndex + OAuthSelectorComponent.MAX_VISIBLE_PROVIDERS,
			);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Home
		else if (matchesKey(keyData, "home")) {
			this.#selectedIndex = 0;
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// End
		else if (matchesKey(keyData, "end")) {
			this.#selectedIndex = Math.max(0, this.#filteredProviders.length - 1);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Enter
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedProvider = this.#filteredProviders[this.#selectedIndex];
			if (selectedProvider?.available) {
				this.#statusMessage = undefined;
				this.stopValidation();
				this.#onSelectCallback(selectedProvider.id);
			} else if (selectedProvider) {
				this.#statusMessage = "Provider unavailable in this environment.";
				this.#updateList();
			}
		}
		// Escape or Ctrl+C
		else if (matchesSelectCancel(keyData)) {
			if (this.#searchInput.getValue()) {
				this.#searchInput.setValue("");
				this.#filterProviders("");
				return;
			}
			this.stopValidation();
			this.#onCancelCallback();
		}
		// Everything else edits the provider filter.
		else {
			const previousQuery = this.#searchInput.getValue();
			this.#searchInput.handleInput(keyData);
			const nextQuery = this.#searchInput.getValue();
			if (nextQuery !== previousQuery) this.#filterProviders(nextQuery);
		}
	}
}
