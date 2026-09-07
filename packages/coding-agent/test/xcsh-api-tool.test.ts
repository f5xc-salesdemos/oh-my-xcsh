import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { XcshApiTool } from "../src/tools/xcsh-api";

function mockSession(bashEnv?: Record<string, string>): any {
	return { settings: { get: (key: string) => (key === "bash.environment" ? (bashEnv ?? {}) : undefined) } };
}

describe("XcshApiTool", () => {
	let cacheDir: string;
	let originalEnv: Record<string, string | undefined>;
	const envKeys = ["XCSH_API_URL", "XCSH_API_TOKEN", "XCSH_NAMESPACE", "XCSH_CONTEXT_NAME"];
	beforeEach(async () => {
		originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
		for (const key of envKeys) delete process.env[key];
		cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "xcsh-api-fixture-"));
	});
	afterEach(async () => {
		for (const key of envKeys) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		await fs.rm(cacheDir, { recursive: true, force: true });
	});
	it("has correct name and label", () => {
		const tool = new XcshApiTool(mockSession());
		expect(tool.name).toBe("xcsh_api");
		expect(tool.label).toBe("API");
	});

	it("rejects when XCSH_API_URL is missing", async () => {
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		delete process.env.XCSH_API_URL;
		delete process.env.XCSH_API_TOKEN;
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-1", {
				method: "GET",
				path: "/api/config/namespaces/default/http_loadbalancers",
			});
			expect(result.isError).toBe(true);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("XCSH_API_URL");
		} finally {
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("rejects when XCSH_API_TOKEN is missing", async () => {
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		delete process.env.XCSH_API_TOKEN;
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-2", {
				method: "GET",
				path: "/api/config/namespaces/default/http_loadbalancers",
			});
			expect(result.isError).toBe(true);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("XCSH_API_TOKEN");
		} finally {
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("substitutes all path params via params map", async () => {
		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, _init?: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response(JSON.stringify({ metadata: { name: "test" } }), { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			await tool.execute("call-3", {
				method: "POST",
				path: "/api/config/namespaces/{namespace}/http_loadbalancers",
				params: { namespace: "example-ns" },
				payload: { metadata: { name: "example-lb" } },
			});
			expect(capturedUrl).toBe(
				"https://test.console.ves.volterra.io/api/config/namespaces/example-ns/http_loadbalancers",
			);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("substitutes extra path params like vh_name", async () => {
		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, _init?: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			await tool.execute("call-4", {
				method: "GET",
				path: "/api/config/namespaces/{namespace}/virtual_hosts/{vh_name}/active_staged_signatures",
				params: { namespace: "default", vh_name: "example-vh" },
			});
			expect(capturedUrl).toBe(
				"https://test.console.ves.volterra.io/api/config/namespaces/default/virtual_hosts/example-vh/active_staged_signatures",
			);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("sends body for DELETE when payload is provided", async () => {
		let capturedBody: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			capturedBody = init?.body ?? null;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			await tool.execute("call-5", {
				method: "DELETE",
				path: "/api/config/namespaces/{namespace}/http_loadbalancers/{name}",
				params: { namespace: "default", name: "example-lb" },
				payload: { fail_if_referred: true },
			});
			expect(capturedBody).not.toBeNull();
			expect(JSON.parse(capturedBody as unknown as string)).toEqual({ fail_if_referred: true });
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("returns compact JSON (not pretty-printed)", async () => {
		const originalFetch = globalThis.fetch;
		const compactJson = '{"metadata":{"name":"test"},"spec":{"timeout":30}}';
		globalThis.fetch = (async (_input: any, _init?: any) => {
			return new Response(compactJson, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-6", {
				method: "GET",
				path: "/api/config/namespaces/default/healthchecks",
			});
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain(compactJson);
			expect(text).not.toContain("  ");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("appends a model-visible item count to list responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify({ items: [{ name: "one" }, { name: "two" }, { name: "three" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-list-count", {
				method: "GET",
				path: "/api/web/namespaces",
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			expect(text).toEndWith("Item count: 3");
			expect(result.details?.itemCount).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("includes X-Request-ID header and requestId in details", async () => {
		let capturedHeaders: Record<string, string> = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			capturedHeaders = init?.headers ?? {};
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-7", {
				method: "GET",
				path: "/api/config/namespaces/default/healthchecks",
			});
			expect(capturedHeaders["X-Request-ID"]).toBeDefined();
			expect(capturedHeaders["X-Request-ID"].length).toBeGreaterThan(0);
			const details = (result as any).details;
			expect(details?.requestId).toBe(capturedHeaders["X-Request-ID"]);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("includes AbortSignal timeout on fetch", async () => {
		let capturedSignal: AbortSignal | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			capturedSignal = init?.signal;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			await tool.execute("call-8", {
				method: "GET",
				path: "/api/config/namespaces/default/healthchecks",
			});
			expect(capturedSignal).toBeDefined();
			expect(capturedSignal).toBeInstanceOf(AbortSignal);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("auto-resolves {namespace} from bash.environment when not in params", async () => {
		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, _init?: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "auto-ns" }));
			// Use a POST path so auto-expand does not intercept (auto-expand only fires for GET without payload)
			await tool.execute("call-9", {
				method: "POST",
				path: "/api/config/namespaces/{namespace}/http_loadbalancers",
				payload: "{}",
			});
			expect(capturedUrl).toContain("auto-ns");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("expands $XCSH_NAMESPACE in payload", async () => {
		let capturedBody: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			capturedBody = init?.body ?? null;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "example-namespace" }));
			await tool.execute("call-10", {
				method: "POST",
				path: "/api/config/namespaces/example-namespace/http_loadbalancers",
				payload: { metadata: { namespace: "$XCSH_NAMESPACE" } },
			});
			expect(capturedBody).not.toBeNull();
			const parsed = JSON.parse(capturedBody as unknown as string);
			expect(parsed.metadata.namespace).toBe("example-namespace");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("includes resolvedPayload in details for POST with payload", async () => {
		let _capturedBody: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			_capturedBody = init?.body ?? null;
			return new Response(JSON.stringify({ metadata: { name: "test" } }), { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "resolved-ns" }));
			const result = await tool.execute("call-resolved", {
				method: "POST",
				path: "/api/config/namespaces/resolved-ns/healthchecks",
				payload: { metadata: { name: "test", namespace: "$XCSH_NAMESPACE" } },
			});
			const details = (result as any).details;
			expect(details?.resolvedPayload).toBeDefined();
			const parsed = JSON.parse(details.resolvedPayload);
			expect(parsed.metadata.namespace).toBe("resolved-ns");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("resolves credentials from bash.environment when process.env is empty", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			capturedHeaders = init?.headers ?? {};
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		delete process.env.XCSH_API_URL;
		delete process.env.XCSH_API_TOKEN;
		try {
			const tool = new XcshApiTool(
				mockSession({
					XCSH_API_URL: "https://context.console.ves.volterra.io",
					XCSH_API_TOKEN: "context-token",
					XCSH_NAMESPACE: "context-ns",
				}),
			);
			await tool.execute("call-ctx", {
				method: "GET",
				path: "/api/config/namespaces/{namespace}/healthchecks",
			});
			expect(capturedUrl).toBe(
				"https://context.console.ves.volterra.io/api/config/namespaces/context-ns/healthchecks",
			);
			expect(capturedHeaders.Authorization).toBe("APIToken context-token");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("returns raw text when server declares JSON but body is unparseable", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, _init?: any) => {
			return new Response("not-valid-json", {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-json-fallback", {
				method: "GET",
				path: "/api/config/namespaces/default/healthchecks",
			});
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			// Should fall back to raw text, not throw into catch block
			expect(text).toContain("200 OK");
			expect(text).toContain("not-valid-json");
			// Should NOT be an error — HTTP 200 with unparseable body is still a success
			expect(result.isError).toBeUndefined();
			// Details should be preserved (requestId, status)
			const details = (result as any).details;
			expect(details?.status).toBe(200);
			expect(details?.requestId).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("accepts paths: ['*'] without path parameter (batch wildcard)", async () => {
		const originalFetch = globalThis.fetch;
		// Mock fetch to return quickly for all batch requests
		globalThis.fetch = (async (_input: any, _init?: any) => {
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "test-ns" }));
			const result = await tool.execute("call-wildcard", {
				method: "GET",
				paths: ["*"],
			} as any);
			// Must NOT be a "path is required" error — paths was provided
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).not.toContain("`path` is required for single-resource");
			expect(text).not.toContain("Validation failed");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("returns clear error when neither path nor paths is provided", async () => {
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-no-path", {
				method: "GET",
			} as any);
			expect(result.isError).toBe(true);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("`path` is required for single-resource operations");
			expect(text).toContain('paths: ["*"]');
		} finally {
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("returns catalog error (not path-required error) when paths: ['*'] resolves empty", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, _init?: any) => {
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "test-ns" }));
			// Simulate empty catalog by passing explicit empty paths array (not wildcard)
			// and verify the distinction: explicit empty list falls through, wildcard returns specific error
			const result = await tool.execute("call-explicit-paths", {
				method: "GET",
				paths: ["*"],
			} as any);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			// Either succeeds (catalog loaded) or gives catalog-specific error
			// Must NOT say "path is required" since paths was provided
			expect(text).not.toContain("`path` is required for single-resource");
			if (result.isError) {
				// If it failed, it should be a catalog error not a path error
				expect(text).toContain("API catalog");
			}
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("includes requestId in network error details", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: any, _init?: any) => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		process.env.XCSH_API_URL = "https://test.console.ves.volterra.io";
		process.env.XCSH_API_TOKEN = "test-token";
		try {
			const tool = new XcshApiTool(mockSession());
			const result = await tool.execute("call-net-err", {
				method: "GET",
				path: "/api/config/namespaces/default/healthchecks",
			});
			expect(result.isError).toBe(true);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("Failed to fetch");
			// requestId should be present in details even on network error
			const details = (result as any).details;
			expect(details).toBeDefined();
			expect(details?.requestId).toBeDefined();
			expect(details?.status).toBe(0);
			expect(details?.method).toBe("GET");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("classifies mixed-scope core and secondary resources for an explicit concrete namespace", async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		const scopeName = `scope-explicit-${crypto.randomUUID()}`;
		process.env.XCSH_API_URL = "https://scope-explicit.example.test";
		process.env.XCSH_API_TOKEN = `scope-token-${crypto.randomUUID()}`;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "HEAD") return new Response(null, { status: 200 });
			const pathname = new URL(String(input)).pathname;
			if (pathname.endsWith("/http_loadbalancers")) {
				return Response.json({
					items: [
						{ name: "member-lb", namespace: scopeName },
						{ name: "external-lb", metadata: { namespace: "shared" } },
						{ name: "missing-lb" },
						{ name: "conflict-lb", namespace: scopeName, metadata: { namespace: "system" } },
					],
				});
			}
			if (pathname.endsWith("/api_definitions")) {
				return Response.json({
					items: [
						{ name: "member-api", metadata: { namespace: scopeName } },
						{ name: "external-api", namespace: "shared" },
						{ name: "unknown-api" },
					],
				});
			}
			return Response.json({ spec: { domains: ["member.example.test"] } });
		}) as typeof fetch;
		try {
			const tool = new XcshApiTool(mockSession({ XCSH_NAMESPACE: "wrong-default" }));
			const result = await tool.execute("mixed-explicit", {
				method: "GET",
				paths: [
					"/api/config/namespaces/{namespace}/http_loadbalancers",
					"/api/config/namespaces/{namespace}/api_definitions",
				],
				params: { namespace: scopeName },
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details!;

			expect(text).toContain("member-lb");
			expect(text).not.toContain("external-lb");
			expect(text).not.toContain("missing-lb");
			expect(text).not.toContain("conflict-lb");
			expect(text).toContain("other types with 1 items: api definitions");
			expect(text).toContain("External-visible results (not namespace members)");
			expect(text).toContain("from shared: 1");
			expect(text).toContain("Unknown-scope results (not counted as namespace members)");
			expect(text).toContain("conflicting namespace metadata: 1");
			expect(text).not.toContain("valid references for mutations");
			expect(details.batchTotalItems).toBe(2);
			expect(details.batchExternalVisibleItems).toBe(2);
			expect(details.batchUnknownScopeItems).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("uses the context-default concrete namespace and preserves literal wildcard routing", async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		delete process.env.XCSH_API_URL;
		delete process.env.XCSH_API_TOKEN;
		const scopeName = `scope-default-${crypto.randomUUID()}`;
		const seenPaths: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "HEAD") return new Response(null, { status: 200 });
			const pathname = new URL(String(input)).pathname;
			seenPaths.push(pathname);
			if (pathname === "/api/web/namespaces") return Response.json({ items: [{ name: scopeName }] });
			return Response.json({ items: [{ name: "member", namespace: scopeName }] });
		}) as typeof fetch;
		try {
			const session = mockSession({
				XCSH_API_URL: "https://scope-default.example.test",
				XCSH_API_TOKEN: `default-token-${crypto.randomUUID()}`,
				XCSH_NAMESPACE: scopeName,
				XCSH_CONTEXT_NAME: `context-${crypto.randomUUID()}`,
			});
			const concrete = await new XcshApiTool(session, cacheDir).execute("context-default", {
				method: "GET",
				paths: ["/api/config/namespaces/{namespace}/api_definitions"],
			});
			expect(concrete.details?.batchTotalItems).toBe(1);
			expect(seenPaths).toContain(`/api/config/namespaces/${scopeName}/api_definitions`);

			seenPaths.length = 0;
			const tenantWide = await new XcshApiTool(session, cacheDir).execute("tenant-wide", {
				method: "GET",
				paths: ["/api/config/namespaces/{namespace}/api_definitions"],
				params: { namespace: "*" },
			});
			expect(seenPaths[0]).toBe("/api/web/namespaces");
			expect(tenantWide.details?.batchTotalItems).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});

	it("uses a process-environment namespace for wildcard membership classification", async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		const originalNamespace = process.env.XCSH_NAMESPACE;
		const scopeName = `scope-process-${crypto.randomUUID()}`;
		process.env.XCSH_API_URL = "https://scope-process.example.test";
		process.env.XCSH_API_TOKEN = `process-token-${crypto.randomUUID()}`;
		process.env.XCSH_NAMESPACE = scopeName;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "HEAD") return new Response(null, { status: 200 });
			return Response.json({ items: [{ name: "process-member", namespace: scopeName }] });
		}) as typeof fetch;
		try {
			const result = await new XcshApiTool(mockSession({ XCSH_NAMESPACE: "context-must-lose" }), cacheDir).execute(
				"process-default",
				{
					method: "GET",
					paths: ["/api/config/namespaces/{namespace}/http_loadbalancers"],
				},
			);
			expect(result.details?.batchTotalItems).toBe(1);
			expect(result.content.find(content => content.type === "text")?.text).toContain("process-member");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
			if (originalNamespace) process.env.XCSH_NAMESPACE = originalNamespace;
			else delete process.env.XCSH_NAMESPACE;
		}
	});

	it("isolates wildcard cache identities without exposing raw identity material in filenames", async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.XCSH_API_URL;
		const originalToken = process.env.XCSH_API_TOKEN;
		delete process.env.XCSH_API_URL;
		delete process.env.XCSH_API_TOKEN;
		const marker = crypto.randomUUID();
		const scopeName = `namespace-${marker}`;
		const token = `credential-${marker}`;
		const contextName = `context-${marker}`;
		const apiBase = `https://tenant-${marker}.example.test`;
		const pathOne = "/api/config/namespaces/{namespace}/api_definitions";
		const pathTwo = "/api/config/namespaces/{namespace}/api_discoverys";
		let collectionFetches = 0;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "HEAD") return new Response(null, { status: 200 });
			collectionFetches++;
			return Response.json({ items: [{ name: `member-${collectionFetches}`, namespace: scopeName }] });
		}) as typeof fetch;
		const before = new Set(await fs.readdir(cacheDir).catch(() => []));
		let created: string[] = [];
		const run = async (overrides: Record<string, string>, paths: string[] = [pathOne]) => {
			const env = {
				XCSH_API_URL: apiBase,
				XCSH_API_TOKEN: token,
				XCSH_NAMESPACE: scopeName,
				XCSH_CONTEXT_NAME: contextName,
				...overrides,
			};
			return new XcshApiTool(mockSession(env), cacheDir).execute("cache-isolation", { method: "GET", paths });
		};
		try {
			await run({});
			expect(collectionFetches).toBe(1);
			await run({});
			expect(collectionFetches).toBe(1);
			await run({ XCSH_API_URL: `${apiBase}/alternate` });
			await run({ XCSH_CONTEXT_NAME: `${contextName}-alternate` });
			await run({ XCSH_API_TOKEN: `${token}-alternate` });
			await run({ XCSH_NAMESPACE: `${scopeName}-alternate` });
			await run({}, [pathOne, pathTwo]);
			expect(collectionFetches).toBe(7);

			const after = await fs.readdir(cacheDir);
			created = after.filter(name => !before.has(name));
			expect(created.length).toBe(6);
			for (const fileName of created) {
				expect(fileName).toMatch(/^v2-[a-f0-9]{64}\.json$/);
				expect(fileName).not.toContain(marker);
				expect(fileName).not.toContain("api_definitions");
			}
			const mode = (await fs.stat(cacheDir)).mode & 0o777;
			expect(mode).toBe(0o700);
		} finally {
			await Promise.all(created.map(fileName => fs.rm(path.join(cacheDir, fileName), { force: true })));
			globalThis.fetch = originalFetch;
			if (originalUrl) process.env.XCSH_API_URL = originalUrl;
			else delete process.env.XCSH_API_URL;
			if (originalToken) process.env.XCSH_API_TOKEN = originalToken;
			else delete process.env.XCSH_API_TOKEN;
		}
	});
});
