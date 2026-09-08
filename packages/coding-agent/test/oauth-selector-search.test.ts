import { beforeAll, describe, expect, it, vi } from "bun:test";
import { getOAuthProviders } from "@f5-sales-demo/pi-ai";
import { OAuthSelectorComponent } from "../src/modes/components/oauth-selector";
import { getLoginOptions } from "../src/modes/controllers/login-options";
import { initTheme } from "../src/modes/theme/theme";
import type { AuthStorage } from "../src/session/auth-storage";

beforeAll(() => {
	initTheme();
});

function createSelector(
	mode: "login" | "logout" = "login",
	authenticated = false,
	options?: ConstructorParameters<typeof OAuthSelectorComponent>[4],
) {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const authStorage = {
		hasAuth: (provider: string) =>
			authenticated && (provider === "google-antigravity" || provider === "openai-codex"),
	} as unknown as AuthStorage;
	const selector = new OAuthSelectorComponent(mode, authStorage, onSelect, onCancel, options);
	return { selector, onSelect, onCancel };
}

function renderText(selector: OAuthSelectorComponent): string {
	return Bun.stripANSI(selector.render(100).join("\n"));
}

describe("OAuthSelectorComponent provider search", () => {
	it("exposes exactly one canonical ChatGPT provider", () => {
		expect(getOAuthProviders().filter(provider => provider.id.startsWith("openai-codex"))).toEqual([
			expect.objectContaining({ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)" }),
		]);
		const selector = createSelector("login", true).selector;
		for (const character of "openai-codex") selector.handleInput(character);
		const rendered = renderText(selector);
		expect(rendered).toContain("ChatGPT Plus/Pro (Codex Subscription)");
		expect(rendered).not.toContain("ChatGPT Plus/Pro (Browser callback)");
		expect(rendered.match(/credential detected/g)).toHaveLength(1);
	});

	it("renders honest normalized access and picker-scope labels", () => {
		const selector = createSelector("login", false, {
			getAccessState: provider => ({
				provider,
				credentialSource: provider === "vllm" ? "keyless" : "stored-oauth",
				status: provider === "anthropic" ? "reauth-required" : "configured-unverified",
				catalogFreshness: "none",
				selectable: false,
			}),
			isExcluded: provider => provider === "anthropic",
		}).selector;
		for (const character of "anthropic") selector.handleInput(character);
		const rendered = renderText(selector);
		expect(rendered).toContain("re-authentication required");
		expect(rendered).toContain("excluded from picker");
		expect(rendered).not.toContain("logged in");
	});

	it("identifies keyless providers without calling them logged in", () => {
		const selector = createSelector("login", false, {
			getAccessState: provider => ({
				provider,
				credentialSource: provider === "vllm" ? "keyless" : undefined,
				status: provider === "vllm" ? "configured-unverified" : "unconfigured",
				catalogFreshness: "none",
				selectable: provider === "vllm",
			}),
		}).selector;
		for (const character of "vllm") selector.handleInput(character);
		const rendered = renderText(selector);
		expect(rendered).toContain("keyless configured");
		expect(rendered).not.toContain("logged in");
	});

	it("renders a bounded provider viewport with position and input guidance", () => {
		const { selector } = createSelector();
		const providerCount = getLoginOptions().length;
		const rendered = renderText(selector);

		expect(rendered).toContain(`Showing 1-10 of ${providerCount}`);
		expect(rendered).toContain("Type to filter providers");
		expect(rendered).toContain("Enter: select");
		expect(rendered).not.toContain("Antigravity (Gemini 3, Claude, GPT-OSS)");
	});

	it("filters by provider name or ID and selects from only the visible matches", () => {
		const { selector, onSelect } = createSelector();

		for (const character of "openai-codex") selector.handleInput(character);

		const rendered = renderText(selector);
		expect(rendered).toContain("ChatGPT Plus/Pro (Codex Subscription)");
		expect(rendered).not.toContain("ChatGPT Plus/Pro (Browser callback)");
		expect(rendered).not.toContain("Anthropic (Claude Pro/Max)");
		expect(rendered).toContain("1 match");

		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("openai-codex");
	});

	it("shows an empty state for unmatched input and does not select", () => {
		const { selector, onSelect } = createSelector();

		for (const character of "no-such-provider") selector.handleInput(character);

		expect(renderText(selector)).toContain("No matching providers");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("clears a non-empty filter before Escape cancels the selector", () => {
		const { selector, onCancel } = createSelector();
		for (const character of "litellm") selector.handleInput(character);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();
		expect(renderText(selector)).toContain(`Showing 1-10 of ${getLoginOptions().length}`);

		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("keeps the selected row visible when navigating beyond the first page", () => {
		const { selector } = createSelector();
		for (let index = 0; index < 11; index += 1) selector.handleInput("\x1b[B");

		const rendered = renderText(selector);
		expect(rendered).toContain("Google Cloud Code Assist (Gemini CLI)");
		expect(rendered).not.toContain("Anthropic (Claude Pro/Max)");
		expect(rendered).toContain(`Showing 3-12 of ${getLoginOptions().length}`);
	});

	it("keeps generic and Enterprise Antigravity credentials as distinct routes", () => {
		const login = createSelector("login", true).selector;
		for (const character of "google-antigravity-enterprise") login.handleInput(character);
		expect(renderText(login)).toContain("Google Antigravity Enterprise (Advanced OAuth)");

		const logout = createSelector("logout", true).selector;
		for (const character of "antigravity") logout.handleInput(character);
		const rendered = renderText(logout);
		expect(rendered).toContain("Antigravity (Gemini 3, Claude, GPT-OSS)");
		expect(rendered).toContain("Google Antigravity Enterprise (Advanced OAuth)");
		expect(rendered).toContain(
			`2 matches (${getOAuthProviders().filter(provider => !provider.loginOnly).length} total)`,
		);
	});
});
