import { afterEach, describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	clearCustomApis,
	getBundledModel,
	registerCustomApi,
	type SimpleStreamOptions,
} from "@f5-sales-demo/pi-ai";
import { AssistantMessageEventStream } from "@f5-sales-demo/pi-ai/utils/event-stream";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

function successfulMessage(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "custom-vertex-capture",
		provider: "google-vertex",
		model: modelId,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Corporate Vertex session runtime options", () => {
	afterEach(() => clearCustomApis());

	it("sends only the isolated Vertex OAuth token and confirmed project to the provider", async () => {
		const model = { ...getBundledModel("google-vertex", "gemini-3.8-flash"), api: "custom-vertex-capture" };
		const settings = Settings.isolated({
			"providers.vertexProject": "confirmed-project",
			"providers.vertexLocation": "europe-west4",
		});
		const requestedProviders: string[] = [];
		const modelRegistry = {
			getAvailable: () => [model],
			getApiKey: async () => "isolated-vertex-oauth-token",
			getApiKeyForProvider: async (provider: string) => {
				requestedProviders.push(provider);
				return provider === "google-vertex" ? "isolated-vertex-oauth-token" : "wrong-namespace-token";
			},
			syncExtensionSources: () => {},
			clearSourceRegistrations: () => {},
		};
		const { session } = await createAgentSession({
			model: model as never,
			modelRegistry: modelRegistry as never,
			settings,
			sessionManager: SessionManager.inMemory(),
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
		});
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi("custom-vertex-capture", (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = successfulMessage(model.id);
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		});

		try {
			await session.agent.prompt("test");
			expect(requestedProviders).toEqual(["google-vertex"]);
			expect(capturedOptions).toMatchObject({
				apiKey: "isolated-vertex-oauth-token",
				project: "confirmed-project",
				location: "global",
			});
		} finally {
			await session.dispose();
		}
	});

	it("rejects a Vertex request before the provider when no project was confirmed", async () => {
		const model = { ...getBundledModel("google-vertex", "gemini-3.8-flash"), api: "custom-vertex-capture" };
		const { session } = await createAgentSession({
			model: model as never,
			modelRegistry: {
				getAvailable: () => [model],
				getApiKey: async () => "isolated-vertex-oauth-token",
				getApiKeyForProvider: async () => "isolated-vertex-oauth-token",
				syncExtensionSources: () => {},
				clearSourceRegistrations: () => {},
			} as never,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
		});
		let providerCalled = false;
		registerCustomApi("custom-vertex-capture", () => {
			providerCalled = true;
			return new AssistantMessageEventStream();
		});

		try {
			expect(() =>
				session.agent.streamFn(model as never, { messages: [] }, { apiKey: "isolated-vertex-oauth-token" }),
			).toThrow("Corporate Vertex requires a confirmed project. Run /login google-vertex.");
			expect(providerCalled).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
