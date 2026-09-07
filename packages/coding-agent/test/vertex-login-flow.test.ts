import { describe, expect, it } from "bun:test";
import {
	detectVertexProject,
	isHeadlessTerminal,
	VERTEX_LOGIN_MODEL,
	type VertexLoginRuntime,
	validateVertexLogin,
	vertexFailureGuidance,
} from "../src/modes/controllers/vertex-login-flow";

function runtime(overrides: Partial<VertexLoginRuntime> = {}): VertexLoginRuntime {
	return {
		environment: {},
		readAdcProject: async () => undefined,
		readGcloudProject: async () => undefined,
		applicationDefaultAccessToken: async () => "adc-token",
		loginApplicationDefault: async () => {},
		validateModel: async () => {},
		...overrides,
	};
}

describe("corporate Vertex login flow", () => {
	it("targets the GA Gemini 3.8 Flash model", () => {
		expect(VERTEX_LOGIN_MODEL).toBe("gemini-3.8-flash");
		expect(vertexFailureGuidance(new Error("not found"))).toContain("gemini-3.8-flash");
	});
	it("uses explicit environment, ADC, then gcloud project precedence", async () => {
		await expect(
			detectVertexProject(
				runtime({ environment: { GOOGLE_CLOUD_PROJECT: "environment" }, readAdcProject: async () => "adc" }),
			),
		).resolves.toEqual({ id: "environment", source: "environment" });
		await expect(
			detectVertexProject(runtime({ readAdcProject: async () => "adc", readGcloudProject: async () => "gcloud" })),
		).resolves.toEqual({ id: "adc", source: "adc" });
		await expect(detectVertexProject(runtime({ readGcloudProject: async () => "gcloud" }))).resolves.toEqual({
			id: "gcloud",
			source: "gcloud",
		});
	});

	it("validates ADC and the Vertex model without any consumer credential fallback", async () => {
		const calls: string[] = [];
		await validateVertexLogin(
			runtime({
				applicationDefaultAccessToken: async () => "adc-token",
				validateModel: async (project, location, token) => {
					calls.push(`${project}/${location}/${token}`);
				},
			}),
			"corporate-project",
		);
		expect(calls).toEqual(["corporate-project/global/adc-token"]);
	});

	it("uses an explicitly supplied authorized OAuth token without invoking gcloud ADC", async () => {
		let adcRead = false;
		const calls: string[] = [];
		await validateVertexLogin(
			runtime({
				applicationDefaultAccessToken: async () => {
					adcRead = true;
					return undefined;
				},
				validateModel: async (_project, _location, token) => {
					calls.push(token);
				},
			}),
			"corporate-project",
			"authorized-oauth-token",
		);
		expect(adcRead).toBe(false);
		expect(calls).toEqual(["authorized-oauth-token"]);
	});

	it("does not validate when ADC is missing and gives actionable remediation", async () => {
		let called = false;
		await expect(
			validateVertexLogin(
				runtime({
					applicationDefaultAccessToken: async () => undefined,
					validateModel: async () => {
						called = true;
					},
				}),
				"p",
			),
		).rejects.toThrow("Application Default Credentials");
		expect(called).toBe(false);
		expect(vertexFailureGuidance(new Error("403 API disabled"), "p")).toContain(
			"gcloud services enable aiplatform.googleapis.com --project p",
		);
	});

	it("preserves only the safe missing-build-client diagnostic while keeping ordinary auth recovery generic", () => {
		const missingBuildClient =
			"Corporate Vertex OAuth credentials are unavailable in this build. Install an official xcsh binary or provide the licensed build credentials when running from source.";

		expect(vertexFailureGuidance(new Error(missingBuildClient))).toBe(missingBuildClient);
		expect(vertexFailureGuidance(new Error("Vertex access token expired: sensitive-provider-detail"))).toBe(
			"Vertex OAuth credentials are unavailable. Run `/login google-vertex` and sign in again.",
		);
	});

	it("detects Cloud Shell and display-less terminals as headless", () => {
		expect(isHeadlessTerminal({ CLOUD_SHELL: "true" })).toBe(true);
		expect(isHeadlessTerminal({ DISPLAY: ":0" })).toBe(false);
	});
});
