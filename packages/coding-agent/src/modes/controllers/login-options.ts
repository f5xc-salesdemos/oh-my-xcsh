import { getOAuthProviders, type OAuthProviderInfo } from "@f5-sales-demo/pi-ai";

export type LoginOption = OAuthProviderInfo & { kind: "local" | "oauth" };

/**
 * The login menu is broader than OAuth. Keep local setup routes here instead
 * of pretending they are OAuth providers (and therefore credential storage).
 */
export function getLoginOptions(): LoginOption[] {
	return [
		{
			id: "google-vertex",
			kind: "local",
			name: "Google Cloud Vertex AI (Corporate)",
			description: "Enterprise Vertex subscription · browser sign-in · Gemini 3.8 Flash HIGH",
			available: true,
			loginOrder: -100,
		},
		...getOAuthProviders().map(provider => ({ ...provider, kind: "oauth" as const })),
	];
}
