import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "../src/models";
import {
	buildGoogleVertexClientOptions,
	createGoogleVertexAuthClient,
	type GoogleVertexProjectRuntime,
	googleVertexRequestUrl,
	readConfiguredGcloudProject,
	resolveGoogleVertexLocation,
	resolveGoogleVertexProject,
} from "../src/providers/google-vertex";
import { mapOptionsForApi } from "../src/stream";
import type { Model, SimpleStreamOptions } from "../src/types";

const PROJECT_ENV_NAMES = ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"] as const;

async function withoutProjectEnvironment(run: () => Promise<void>): Promise<void> {
	const originalValues = new Map<string, string | undefined>();
	for (const name of PROJECT_ENV_NAMES) {
		originalValues.set(name, Bun.env[name]);
		delete Bun.env[name];
	}

	try {
		await run();
	} finally {
		for (const [name, value] of originalValues) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	}
}

describe("Google Vertex runtime configuration", () => {
	it("uses the standalone OAuth token through an explicit auth client", async () => {
		const model = getBundledModel("google-vertex", "gemini-3.8-flash") as Model<"google-vertex">;
		const clientOptions = buildGoogleVertexClientOptions(
			model,
			"confirmed-project",
			"global",
			"isolated-vertex-oauth-token",
		);
		const authClient = clientOptions.googleAuthOptions?.authClient;
		expect(authClient).toBeInstanceOf(createGoogleVertexAuthClient("comparison-token").constructor);
		if (!authClient) throw new Error("Expected an explicit Vertex OAuth auth client");
		const headers = await authClient.getRequestHeaders(
			"https://aiplatform.googleapis.com/v1/projects/confirmed-project/locations/global",
		);

		expect(headers.get("authorization")).toBe("Bearer isolated-vertex-oauth-token");
		expect(clientOptions.httpOptions?.headers?.Authorization).toBeUndefined();
	});

	it("preserves standalone OAuth and confirmed project options through the simple stream mapper", () => {
		const model = getBundledModel("google-vertex", "gemini-3.8-flash");
		const runtimeOptions = {
			apiKey: "isolated-vertex-oauth-token",
			project: "confirmed-project",
			location: "global",
		} as SimpleStreamOptions;

		expect(mapOptionsForApi(model, runtimeOptions, runtimeOptions.apiKey)).toMatchObject({
			apiKey: "isolated-vertex-oauth-token",
			project: "confirmed-project",
			location: "global",
		});
	});

	it("preserves a named tool choice for Vertex instead of widening it to unrestricted any", () => {
		const model = getBundledModel("google-vertex", "gemini-3.8-flash");
		const runtimeOptions = {
			toolChoice: { type: "tool", name: "todo_write" },
		} as SimpleStreamOptions;

		expect(mapOptionsForApi(model, runtimeOptions)).toMatchObject({
			toolChoice: { name: "todo_write" },
		});
	});

	it("resolves the project from ADC when project environment variables are absent", async () => {
		await withoutProjectEnvironment(async () => {
			const originalCredentialsPath = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
			const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-vertex-adc-"));
			const credentialsPath = path.join(tempDirectory, "application_default_credentials.json");

			try {
				await Bun.write(credentialsPath, JSON.stringify({ project_id: "123456789012" }));
				Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

				expect(await resolveGoogleVertexProject()).toBe("123456789012");
			} finally {
				if (originalCredentialsPath === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
				else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialsPath;
				await fs.rm(tempDirectory, { recursive: true, force: true });
			}
		});
	});

	it("falls back to the active gcloud project when ADC has no project", async () => {
		await withoutProjectEnvironment(async () => {
			const requestedExecutables: string[] = [];
			const runtime: GoogleVertexProjectRuntime = {
				readAdcProject: async () => undefined,
				findGcloud: () => "/test/bin/gcloud",
				readConfiguredProject: async gcloud => {
					requestedExecutables.push(gcloud);
					return "gcloud-project";
				},
			};

			expect(await resolveGoogleVertexProject(undefined, runtime)).toBe("gcloud-project");
			expect(requestedExecutables).toEqual(["/test/bin/gcloud"]);
		});
	});

	it("reads the active project directly from the gcloud configuration", async () => {
		const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-gcloud-config-"));
		try {
			await fs.mkdir(path.join(configDirectory, "configurations"), { recursive: true });
			await Bun.write(path.join(configDirectory, "active_config"), "enterprise\n");
			await Bun.write(
				path.join(configDirectory, "configurations", "config_enterprise"),
				"[core]\naccount = user@example.com\nproject = enterprise-vertex-project\n[compute]\nregion = us-east1\n",
			);

			expect(await readConfiguredGcloudProject(configDirectory)).toBe("enterprise-vertex-project");
		} finally {
			await fs.rm(configDirectory, { recursive: true, force: true });
		}
	});

	it("uses the local gcloud configuration before invoking the gcloud executable", async () => {
		await withoutProjectEnvironment(async () => {
			let executableLookupCalled = false;
			const runtime: GoogleVertexProjectRuntime = {
				readAdcProject: async () => undefined,
				readLocalConfigProject: async () => "local-config-project",
				findGcloud: () => {
					executableLookupCalled = true;
					return "/test/bin/gcloud";
				},
				readConfiguredProject: async () => "cli-project",
			};

			expect(await resolveGoogleVertexProject(undefined, runtime)).toBe("local-config-project");
			expect(executableLookupCalled).toBe(false);
		});
	});

	it("always uses the global Vertex location and global endpoint", async () => {
		const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
		try {
			Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			expect(resolveGoogleVertexLocation({ location: "europe-west4" })).toBe("global");
			expect(googleVertexRequestUrl("gemini-3.8-flash", "test-project", "global")).toBe(
				"https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent",
			);
		} finally {
			if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
			else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
		}
	});
});
