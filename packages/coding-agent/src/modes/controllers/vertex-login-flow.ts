import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

export const VERTEX_LOGIN_MODEL = "gemini-3.8-flash";
export const VERTEX_LOGIN_LOCATION = "global";
const VERTEX_BUILD_CREDENTIALS_UNAVAILABLE =
	"Corporate Vertex OAuth credentials are unavailable in this build. Install an official xcsh binary or provide the licensed build credentials when running from source.";

export type VertexProjectSource = "environment" | "adc" | "gcloud";
export interface VertexProject {
	id: string;
	source: VertexProjectSource;
}
export interface VertexLoginRuntime {
	environment: Record<string, string | undefined>;
	readAdcProject(): Promise<string | undefined>;
	readGcloudProject(): Promise<string | undefined>;
	applicationDefaultAccessToken(): Promise<string | undefined>;
	loginApplicationDefault(headless: boolean): Promise<void>;
	validateModel(project: string, location: string, accessToken: string): Promise<void>;
}

function clean(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result || undefined;
}

/** Resolve the project in the same precedence order users see in the wizard. */
export async function detectVertexProject(runtime: VertexLoginRuntime): Promise<VertexProject | undefined> {
	const environmentProject =
		clean(runtime.environment.GOOGLE_CLOUD_PROJECT) ?? clean(runtime.environment.GCLOUD_PROJECT);
	if (environmentProject) return { id: environmentProject, source: "environment" };
	const adcProject = clean(await runtime.readAdcProject());
	if (adcProject) return { id: adcProject, source: "adc" };
	const gcloudProject = clean(await runtime.readGcloudProject());
	return gcloudProject ? { id: gcloudProject, source: "gcloud" } : undefined;
}

export function isHeadlessTerminal(
	environment: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (environment.CLOUD_SHELL || environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.SSH_TTY)
		return true;
	if (platform === "darwin" || platform === "win32") return false;
	return !environment.DISPLAY && !environment.WAYLAND_DISPLAY;
}

export function vertexFailureGuidance(error: unknown, project?: string): string {
	const message = error instanceof Error ? error.message : String(error);
	const projectArg = project ? ` --project ${project}` : "";
	if (message === VERTEX_BUILD_CREDENTIALS_UNAVAILABLE) return VERTEX_BUILD_CREDENTIALS_UNAVAILABLE;
	if (/credential|unauthenticated|login|access token/i.test(message)) {
		return "Vertex OAuth credentials are unavailable. Run `/login google-vertex` and sign in again.";
	}
	if (/billing/i.test(message)) return `Enable billing for the selected project:${projectArg}`;
	if (/serviceusage|api.*disabled|not.*enabled/i.test(message)) {
		return `Enable Vertex AI: \`gcloud services enable aiplatform.googleapis.com${projectArg}\`.`;
	}
	if (/permission|iam|forbidden|403/i.test(message)) {
		return "Ask a project administrator for Vertex AI User access and Gemini model access in global.";
	}
	return `Vertex AI could not access ${VERTEX_LOGIN_MODEL} in global: ${message}`;
}

export async function validateVertexLogin(
	runtime: VertexLoginRuntime,
	project: string,
	oauthAccessToken?: string,
): Promise<void> {
	const accessToken = oauthAccessToken ?? (await runtime.applicationDefaultAccessToken());
	if (!accessToken) throw new Error("Application Default Credentials are unavailable");
	await runtime.validateModel(project, VERTEX_LOGIN_LOCATION, accessToken);
}

export const defaultVertexLoginRuntime: VertexLoginRuntime = {
	environment: Bun.env,
	async readAdcProject() {
		try {
			const credentialsPath =
				Bun.env.GOOGLE_APPLICATION_CREDENTIALS ??
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
			const credentials = (await Bun.file(credentialsPath).json()) as { project_id?: unknown };
			return typeof credentials.project_id === "string" ? clean(credentials.project_id) : undefined;
		} catch {
			return undefined;
		}
	},
	async readGcloudProject() {
		try {
			return clean(await $`gcloud config get-value project`.quiet().text());
		} catch {
			return undefined;
		}
	},
	async applicationDefaultAccessToken() {
		try {
			return clean(await $`gcloud auth application-default print-access-token`.quiet().text());
		} catch {
			return undefined;
		}
	},
	async loginApplicationDefault(headless) {
		if (headless) await $`gcloud auth application-default login --no-launch-browser`;
		else await $`gcloud auth application-default login`;
	},
	async validateModel(project, location, accessToken) {
		const response = await fetch(
			`https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${location}/publishers/google/models/${VERTEX_LOGIN_MODEL}:generateContent`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
					generationConfig: { maxOutputTokens: 8 },
				}),
			},
		);
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	},
};
