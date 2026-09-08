import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage } from "../src/auth-storage";

describe("AuthStorage credential source", () => {
	let directory = "";
	let storage: AuthStorage;
	let store: AuthCredentialStore;
	let previousOpenAIKey: string | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "xcsh-auth-source-"));
		store = await AuthCredentialStore.open(path.join(directory, "agent.db"));
		storage = new AuthStorage(store);
		previousOpenAIKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
	});

	afterEach(async () => {
		store.close();
		if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenAIKey;
		await fs.rm(directory, { recursive: true, force: true });
	});

	it("reports runtime, stored API key, stored OAuth, environment, and configuration sources", async () => {
		storage.setRuntimeApiKey("runtime-provider", "runtime-secret");
		await storage.set("stored-key", { type: "api_key", key: "stored-secret" });
		await storage.set("anthropic", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		process.env.OPENAI_API_KEY = "environment-secret";
		storage.setFallbackResolver(provider => (provider === "configured-provider" ? "configured-secret" : undefined));

		expect(storage.getCredentialSource("runtime-provider")).toBe("runtime");
		expect(storage.getCredentialSource("stored-key")).toBe("stored-api-key");
		expect(storage.getCredentialSource("anthropic")).toBe("stored-oauth");
		expect(storage.getCredentialSource("openai")).toBe("environment");
		expect(storage.getCredentialSource("configured-provider")).toBe("configuration");
		expect(storage.getCredentialSource("missing-provider")).toBeUndefined();
	});
});
