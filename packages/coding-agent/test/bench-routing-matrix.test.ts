import { afterEach, describe, expect, it } from "bun:test";
import {
	BASE_SCENARIOS,
	CANONICAL_LANE_IDS,
	classifyMeasuredRun,
	computeExitCode,
	createMultimodalMessage,
	discoverLaneInventory,
	discoverOAuthEntitlementInventory,
	ESCALATION_SCENARIO,
	expandLaneScenarios,
	extractResponseText,
	LANE_CAPABILITIES,
	parseArgs,
	reconcileLaneInventory,
	redactSecretStrings,
	SUBSCRIPTION_LANE_IDS,
	sanitizeDiagnostic,
	validateContractIntegrity,
	validateRoutingMatrixReport,
} from "../scripts/bench-routing-matrix";
import { profileTaskDeterministic } from "../src/routing/profiler";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function capturedRequest(input: string | URL | Request, init?: RequestInit): Request {
	return input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
}

describe("routing matrix capability and scenario contract", () => {
	it("declares the canonical and subscription lane profiles independently", () => {
		expect(CANONICAL_LANE_IDS).toEqual([
			"openai",
			"anthropic",
			"litellm-openai",
			"litellm-anthropic",
			"google-vertex",
		]);
		expect(SUBSCRIPTION_LANE_IDS).toEqual(["google-antigravity", "openai-codex"]);
		expect(LANE_CAPABILITIES.anthropic.clientProvider).toBe("anthropic");
		expect(LANE_CAPABILITIES["litellm-anthropic"].clientProvider).toBe("anthropic");
		expect(LANE_CAPABILITIES.anthropic.endpointKind).toBe("direct");
		expect(LANE_CAPABILITIES["litellm-anthropic"].endpointKind).toBe("gateway");
		expect(Object.values(LANE_CAPABILITIES).every(lane => lane.required)).toBe(true);
		expect(parseArgs(["--profile", "subscription", "--dry-run"]).lanes).toEqual([
			"google-antigravity",
			"openai-codex",
		]);
	});

	it("expands the canonical contract to 60 measured rows", () => {
		const rows = expandLaneScenarios([...CANONICAL_LANE_IDS], 3);
		expect(rows).toHaveLength(60);
	});

	it("uses only the reviewed flagship OpenAI and Anthropic tiers", () => {
		for (const laneId of ["openai", "litellm-openai"]) {
			expect(LANE_CAPABILITIES[laneId].tiers).toEqual({
				utility: "gpt-5.6-luna",
				balanced: "gpt-5.6-terra",
				frontier: "gpt-5.6-sol",
			});
		}
		for (const laneId of ["anthropic", "litellm-anthropic"]) {
			expect(LANE_CAPABILITIES[laneId].tiers).toEqual({
				utility: "claude-haiku-4-5",
				balanced: "claude-sonnet-5",
				frontier: "claude-opus-5",
			});
		}
	});

	it("maps subscription tiers to the reviewed models and reasoning levels", () => {
		expect(LANE_CAPABILITIES["google-antigravity"]).toMatchObject({
			tiers: {
				utility: "gemini-3.6-flash-high",
				balanced: "gemini-3.6-flash-high",
				frontier: "gemini-3.1-pro-high-vertex",
			},
			effortPolicy: { byTier: { utility: "high", balanced: "high", frontier: "high" } },
		});
		expect(LANE_CAPABILITIES["openai-codex"]).toMatchObject({
			tiers: { utility: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
			effortPolicy: {
				byTier: { utility: "low", balanced: "medium", frontier: "high" },
				frontierEscalation: { effort: "xhigh", minimumComplexityScore: 90 },
			},
		});
		expect(ESCALATION_SCENARIO).toMatchObject({ expectedTier: "frontier", priorRejection: true });
		expect(
			parseArgs(["--profile", "subscription", "--lanes", "openai-codex", "--scenarios", "rejection-escalation"])
				.scenarios,
		).toEqual(["rejection-escalation"]);
	});

	it("profiles every scenario to its declared tier", () => {
		for (const scenario of BASE_SCENARIOS) {
			const profile = profileTaskDeterministic({
				prompt: scenario.prompt,
				hasImages: scenario.hasImages,
			});
			expect(profile.desiredTier).toBe(scenario.expectedTier);
		}
	});

	it("uses an image-derived marker that is absent from the prompt", () => {
		const scenario = BASE_SCENARIOS.find(item => item.id === "multimodal-visual")!;
		expect(scenario.prompt).not.toContain(scenario.responseMarker);
		const message = createMultimodalMessage(scenario.prompt);
		expect(Array.isArray(message.content)).toBe(true);
		const image = (message.content as any[]).find(block => block.type === "image");
		expect(image.data.length).toBeGreaterThan(100);
		expect(image.mimeType).toBe("image/png");
		const png = Buffer.from(image.data, "base64");
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(png[24]).toBe(8);
	});
});

describe("provider-specific authenticated inventory", () => {
	it("accepts only fresh OAuth entitlement discovery and preserves runtime model metadata", async () => {
		const model = {
			id: "gpt-5.6-luna",
			provider: "openai-codex",
			api: "openai-codex-responses",
		} as any;
		const result = await discoverOAuthEntitlementInventory(
			LANE_CAPABILITIES["openai-codex"],
			{ apiKey: "packed-oauth", authMechanism: "oauth-packed" },
			async provider => ({
				state: {
					provider,
					status: "ok",
					optional: false,
					stale: false,
					models: ["gpt-5.6-luna"],
				},
				models: [model],
			}),
		);
		expect(result.inventory.state).toBe("AVAILABLE");
		expect(result.inventory.models).toEqual(["gpt-5.6-luna"]);
		expect(result.models).toEqual([model]);
	});

	it("rejects cached entitlement inventory instead of falling back to bundled models", async () => {
		const result = await discoverOAuthEntitlementInventory(
			LANE_CAPABILITIES["google-antigravity"],
			{ apiKey: "packed-oauth", authMechanism: "oauth-packed" },
			async provider => ({
				state: {
					provider,
					status: "cached",
					optional: false,
					stale: true,
					models: ["gemini-3.6-flash-high"],
				},
				models: [],
			}),
		);
		expect(result.inventory.state).toBe("BLOCKED_NETWORK");
		expect(result.inventory.models).toEqual([]);
		expect(result.inventory.reasonCode).toBe("stale_entitlement_inventory");
	});

	it("fails closed for missing OAuth, adapter state, empty entitlement, and incomplete metadata", async () => {
		const capability = LANE_CAPABILITIES["openai-codex"];
		const missingCredential = await discoverOAuthEntitlementInventory(capability, {}, async () => {
			throw new Error("resolver must not run");
		});
		const missingState = await discoverOAuthEntitlementInventory(
			capability,
			{ apiKey: "packed-oauth", authMechanism: "oauth-packed" },
			async () => ({ models: [] }),
		);
		const empty = await discoverOAuthEntitlementInventory(
			capability,
			{ apiKey: "packed-oauth", authMechanism: "oauth-packed" },
			async provider => ({
				state: { provider, status: "ok", optional: false, stale: false, models: [] },
				models: [],
			}),
		);
		const incomplete = await discoverOAuthEntitlementInventory(
			capability,
			{ apiKey: "packed-oauth", authMechanism: "oauth-packed" },
			async provider => ({
				state: { provider, status: "ok", optional: false, stale: false, models: ["gpt-5.6-luna"] },
				models: [],
			}),
		);

		expect(missingCredential.inventory.state).toBe("BLOCKED_AUTH");
		expect(missingState.inventory.state).toBe("UNSUPPORTED_DISCOVERY");
		expect(empty.inventory.state).toBe("FAIL_EMPTY_INVENTORY");
		expect(incomplete.inventory.state).toBe("FAIL_SCHEMA");
	});

	it("uses OpenAI bearer auth and parses data records", async () => {
		let request: Request | undefined;
		const result = await discoverLaneInventory(
			LANE_CAPABILITIES.openai,
			{ apiKey: "openai-secret", authMechanism: "bearer", baseUrl: "https://openai.example/v1" },
			async (input, init) => {
				request = capturedRequest(input, init);
				return response({ data: [{ id: "gpt-5.6-luna" }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }] });
			},
		);
		expect(result.state).toBe("AVAILABLE");
		expect(request?.url).toBe("https://openai.example/v1/models");
		expect(request?.headers.get("authorization")).toBe("Bearer openai-secret");
	});

	it("uses Anthropic API-key and OAuth header variants", async () => {
		for (const credential of [
			{ apiKey: "api-secret", authMechanism: "api-key" as const },
			{ apiKey: "oauth-secret", authMechanism: "oauth-bearer" as const },
		]) {
			let request: Request | undefined;
			const result = await discoverLaneInventory(
				LANE_CAPABILITIES.anthropic,
				{ ...credential, baseUrl: "https://anthropic.example/v1" },
				async (input, init) => {
					request = capturedRequest(input, init);
					return response({ data: [{ id: "claude-haiku-4-5" }] });
				},
			);
			expect(result.state).toBe("AVAILABLE");
			if (credential.authMechanism === "api-key") {
				expect(request?.headers.get("x-api-key")).toBe("api-secret");
				expect(request?.headers.get("authorization")).toBeNull();
			} else {
				expect(request?.headers.get("authorization")).toBe("Bearer oauth-secret");
				expect(request?.headers.get("x-api-key")).toBeNull();
			}
		}
	});

	it("keeps separate LiteLLM endpoint inventories", async () => {
		const seen: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			const url = capturedRequest(input).url;
			seen.push(url);
			return url.includes("openai-gateway")
				? response({ data: [{ id: "gpt-5.6-luna" }] })
				: response({ data: [{ id: "claude-haiku-4-5" }] });
		};
		const openai = await discoverLaneInventory(
			LANE_CAPABILITIES["litellm-openai"],
			{ apiKey: "secret", authMechanism: "bearer", baseUrl: "https://openai-gateway/v1" },
			fetchMock,
		);
		const anthropic = await discoverLaneInventory(
			LANE_CAPABILITIES["litellm-anthropic"],
			{ apiKey: "secret", authMechanism: "bearer", baseUrl: "https://anthropic-gateway/v1" },
			fetchMock,
		);
		expect(openai.models).toEqual(["gpt-5.6-luna"]);
		expect(anthropic.models).toEqual(["claude-haiku-4-5"]);
		expect(new Set(seen).size).toBe(2);
	});

	it("uses the Vertex Model Garden adapter with an ADC access token", async () => {
		let request: Request | undefined;
		const result = await discoverLaneInventory(
			LANE_CAPABILITIES["google-vertex"],
			{
				apiKey: "adc-access-token",
				authMechanism: "google-adc",
				baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
			},
			async (input, init) => {
				request = capturedRequest(input, init);
				return response({ publisherModels: [{ name: "publishers/google/models/gemini-2.5-pro" }] });
			},
		);
		expect(result.models).toEqual(["gemini-2.5-pro"]);
		expect(request?.url).toContain("/publishers/google/models");
		expect(request?.headers.get("authorization")).toBe("Bearer adc-access-token");
	});

	it.each([
		[401, "BLOCKED_AUTH"],
		[403, "BLOCKED_AUTH"],
		[404, "UNSUPPORTED_DISCOVERY"],
		[429, "BLOCKED_RATE_LIMIT"],
		[500, "BLOCKED_NETWORK"],
	] as const)("maps HTTP %s to %s without bundled fallback", async (status, state) => {
		const result = await discoverLaneInventory(
			LANE_CAPABILITIES.openai,
			{ apiKey: "secret", authMechanism: "bearer", baseUrl: "https://example.test/v1" },
			async () => response({ error: "failure" }, status),
		);
		expect(result.state).toBe(state);
		expect(result.models).toEqual([]);
	});

	it("distinguishes malformed, empty, network, and abort failures", async () => {
		const credential = { apiKey: "secret", authMechanism: "bearer" as const, baseUrl: "https://example.test/v1" };
		const malformed = await discoverLaneInventory(
			LANE_CAPABILITIES.openai,
			credential,
			async () => new Response("not-json", { status: 200 }),
		);
		const empty = await discoverLaneInventory(LANE_CAPABILITIES.openai, credential, async () =>
			response({ data: [] }),
		);
		const network = await discoverLaneInventory(LANE_CAPABILITIES.openai, credential, async () => {
			throw new TypeError("DNS failed");
		});
		const abort = await discoverLaneInventory(LANE_CAPABILITIES.openai, credential, async () => {
			throw new DOMException("timed out", "AbortError");
		});
		expect(malformed.state).toBe("FAIL_SCHEMA");
		expect(empty.state).toBe("FAIL_EMPTY_INVENTORY");
		expect(network.state).toBe("BLOCKED_NETWORK");
		expect(abort.state).toBe("BLOCKED_NETWORK");
	});

	it("fails missing credentials before performing HTTP", async () => {
		let called = false;
		const result = await discoverLaneInventory(LANE_CAPABILITIES.openai, {}, async () => {
			called = true;
			return response({ data: [] });
		});
		expect(result.state).toBe("BLOCKED_AUTH");
		expect(called).toBe(false);
	});
});

describe("inventory reconciliation and evidence", () => {
	it("requires every configured tier and returns lane-local qualified candidates", () => {
		const capability = LANE_CAPABILITIES["litellm-openai"];
		const missing = reconcileLaneInventory(capability, ["gpt-5.6-luna", "gpt-5.6-terra"]);
		expect(missing.state).toBe("FAIL_MISSING_TIERS");
		expect(missing.missingTiers).toEqual(["gpt-5.6-sol"]);
		const complete = reconcileLaneInventory(capability, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
		expect(complete.state).toBe("AVAILABLE");
		expect(complete.eligibleCandidates).toEqual([
			"litellm/gpt-5.6-luna",
			"litellm/gpt-5.6-terra",
			"litellm/gpt-5.6-sol",
		]);
	});

	it("extracts text deterministically and rejects unexpected blocks", () => {
		expect(
			extractResponseText([
				{ type: "text", text: " A " },
				{ type: "text", text: "B" },
			]),
		).toEqual({
			ok: true,
			text: "A\nB",
		});
		expect(extractResponseText([{ type: "toolCall", name: "x" }]).ok).toBe(false);
		expect(extractResponseText([{ type: "error", error: "secret" }]).ok).toBe(false);
	});

	it("never substitutes requested values for missing response attribution", () => {
		const missing = classifyMeasuredRun({
			effectiveTier: "utility",
			expectedTier: "utility",
			requestedModel: "openai/gpt-5.6-luna",
			responseModel: undefined,
			clientProvider: "openai",
			expectedClientProvider: "openai",
			responseContent: [{ type: "text", text: "RESPOND_UTILITY_OK" }],
			expectedMarker: "RESPOND_UTILITY_OK",
			stopReason: "stop",
			totalTokens: 10,
			requireResponseModel: true,
		});
		expect(missing.status).toBe("FAIL");
		expect(missing.reasonCode).toBe("missing_response_model");
	});

	it("reports provider behavioral errors before missing attribution", () => {
		const failed = classifyMeasuredRun({
			effectiveTier: "frontier",
			expectedTier: "frontier",
			requestedModel: "openai-codex/gpt-5.6-sol",
			responseModel: undefined,
			clientProvider: "openai-codex",
			expectedClientProvider: "openai-codex",
			responseContent: [],
			expectedMarker: "ROUTE-7C",
			stopReason: "error",
			totalTokens: 0,
			requireResponseModel: true,
			error: "The image could not be decoded",
		});
		expect(failed).toEqual({ status: "FAIL", reasonCode: "behavioral_error" });
	});

	it("removes raw HTTP capture paths from provider diagnostics", () => {
		expect(
			sanitizeDiagnostic(
				"Invalid image data\nraw-http-request=/home/example/.xcsh/logs/http-400-requests/request.json",
			),
		).toBe("Invalid image data");
	});
});

describe("contract, schema, and recursive security", () => {
	it("requires every inventory, warmup, and measured row", () => {
		const complete = validateContractIntegrity({
			dryRun: false,
			cleanWorktree: true,
			exactHead: true,
			secretScanPassed: true,
			expectedWarmups: 5,
			expectedMeasured: 60,
			inventories: Array.from({ length: 5 }, () => ({ state: "AVAILABLE" as const })),
			warmups: Array.from({ length: 5 }, () => ({ status: "PASS" as const })),
			measured: Array.from({ length: 60 }, () => ({ status: "PASS" as const })),
		});
		expect(complete).toEqual({ matrixComplete: true, authoritative: true });

		const warmupBlocked = validateContractIntegrity({
			...completeInput(),
			warmups: [{ status: "BLOCKED" }, ...Array.from({ length: 4 }, () => ({ status: "PASS" as const }))],
		});
		expect(warmupBlocked.authoritative).toBe(false);
		expect(computeExitCode({ hasFailure: false, hasBlocked: true, invalidCli: false })).toBe(2);
	});

	it("dry runs are simulated, non-complete, non-authoritative, and can exit zero", () => {
		const result = validateContractIntegrity({
			...completeInput(),
			dryRun: true,
			warmups: Array.from({ length: 5 }, () => ({ status: "SIMULATED" as const })),
			measured: Array.from({ length: 60 }, () => ({ status: "SIMULATED" as const })),
		});
		expect(result).toEqual({ matrixComplete: false, authoritative: false });
		expect(computeExitCode({ hasFailure: false, hasBlocked: false, invalidCli: false })).toBe(0);
	});

	it("redacts nested secrets, headers, URLs, query tokens, and ADC paths", () => {
		const redacted = redactSecretStrings(
			{
				nested: [{ authorization: "Bearer super-secret-token" }],
				url: "https://user:password@example.test/v1?api_key=query-secret",
				adcPath: "/home/example/secret-service-account.json",
				literal: "known-secret",
			},
			["known-secret"],
		);
		const serialized = JSON.stringify(redacted);
		expect(serialized).not.toContain("super-secret-token");
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("query-secret");
		expect(serialized).not.toContain("secret-service-account.json");
		expect(serialized).not.toContain("known-secret");
	});

	it("validates the versioned report shape", () => {
		expect(validateRoutingMatrixReport({ schemaVersion: 1 }).valid).toBe(false);
		expect(
			validateRoutingMatrixReport({
				schemaVersion: 3,
				git: { commit: "abc", clean: true, exactHead: true },
				parameters: {
					profile: "canonical",
					dryRun: false,
					repetitions: 3,
					warmups: 1,
					lanes: [...CANONICAL_LANE_IDS],
					scenarios: BASE_SCENARIOS.map(item => item.id),
					timeoutMs: 20_000,
				},
				inventory: [],
				warmups: [],
				measured: [],
				summary: { matrixComplete: false, authoritative: false },
				security: { redacted: true, secretScanPassed: false },
			}).valid,
		).toBe(true);
	});
});

function completeInput() {
	return {
		dryRun: false,
		cleanWorktree: true,
		exactHead: true,
		secretScanPassed: true,
		expectedWarmups: 5,
		expectedMeasured: 60,
		inventories: Array.from({ length: 5 }, () => ({ state: "AVAILABLE" as const })),
		warmups: Array.from({ length: 5 }, () => ({ status: "PASS" as const })),
		measured: Array.from({ length: 60 }, () => ({ status: "PASS" as const })),
	};
}
