import { afterEach, expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import { AssistantMessageEventStream } from "@f5-sales-demo/pi-ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { applyModelSelection } from "../src/modes/controllers/model-selection";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	_resetSettingsForTest();
});
async function harness() {
	_resetSettingsForTest();
	const dir = mkdtempSync(join(tmpdir(), "model-selection-session-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const auth = await AuthStorage.create(join(dir, "auth.db"));
	cleanups.push(() => auth.close());
	for (const provider of ["anthropic", "google-vertex", "ollama"]) auth.setRuntimeApiKey(provider, "test-key");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				ollama: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "uat-local" }],
				},
			},
		}),
	);
	const registry = new ModelRegistry(auth, join(dir, "models.json"));
	const models = [
		registry.find("anthropic", "claude-sonnet-4-5")!,
		registry.find("google-vertex", "gemini-2.5-pro")!,
		registry.find("ollama", "uat-local")!,
	];
	const settings = await Settings.init({ cwd: dir, agentDir: dir });
	settings.set("modelRoles", { default: "anthropic/claude-sonnet-4-5:low" });
	settings.set("routing.mode", "auto");
	settings.set("compaction.enabled", false);
	await settings.flush({ throwOnError: true });
	const requests: { selector: string; messages: number }[] = [];
	const agent = new Agent({
		initialState: { model: models[0], tools: [], systemPrompt: "Test", messages: [] },
		streamFn: (model, context) => {
			requests.push({ selector: `${model.provider}/${model.id}`, messages: context.messages.length });
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "UAT answer" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
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
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		modelRegistry: registry,
		settings,
		sessionManager: SessionManager.inMemory(dir),
	});
	cleanups.push(() => session.dispose());
	return { session, settings, models, requests, dir };
}
test("conversation switches route actual turns across providers and retain conversation and saved default", async () => {
	const { session, settings, models, requests } = await harness();
	for (const model of [models[0], models[1], models[2], models[0]]) {
		await applyModelSelection(session, {
			scope: "conversation",
			model,
			selector: `${model.provider}/${model.id}`,
			thinkingLevel: ThinkingLevel.Inherit,
		});
		await session.prompt("Say UAT answer.");
		expect(requests.at(-1)?.selector).toBe(`${model.provider}/${model.id}`);
	}
	expect(requests.map(request => request.messages)).toEqual([1, 3, 5, 7]);
	expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5:low");
});
test("saved roles are independent and a failed persistence never changes the active model", async () => {
	const { session, settings, models, dir } = await harness();
	for (const role of ["smol", "slow", "plan", "custom-review"]) {
		await applyModelSelection(session, {
			scope: "role",
			role,
			model: models[1],
			selector: "google-vertex/gemini-2.5-pro",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(session.model).toBe(models[0]);
	}
	const saved = await Bun.file(join(dir, "config.yml")).text();
	expect(saved).toContain("custom-review: google-vertex/gemini-2.5-pro:high");
	const previousRoles = settings.get("modelRoles");
	const flush = vi.spyOn(settings, "flush").mockRejectedValue(new Error("disk full"));
	await expect(
		applyModelSelection(session, {
			scope: "default",
			model: models[1],
			selector: "google-vertex/gemini-2.5-pro",
			thinkingLevel: ThinkingLevel.High,
		}),
	).rejects.toThrow("disk full");
	expect(session.model).toBe(models[0]);
	expect(settings.get("modelRoles")).toEqual(previousRoles);
	flush.mockRestore();
	await settings.flush();
});
test("strict settings flush surfaces real filesystem errors and retries after repair", async () => {
	const { settings, dir } = await harness();
	const config = join(dir, "config.yml");
	unlinkSync(config);
	mkdirSync(config);
	settings.setModelRole("smol", "anthropic/claude-sonnet-4-5:low");
	await expect(settings.flush({ throwOnError: true })).rejects.toThrow();
	rmSync(config, { recursive: true });
	await settings.flush({ throwOnError: true });
	expect(await Bun.file(config).text()).toContain("smol: anthropic/claude-sonnet-4-5:low");
});

test("resume restores a conversation selection made before its first request", async () => {
	const { session, models } = await harness();
	session.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
	await applyModelSelection(session, {
		scope: "conversation",
		model: models[1],
		selector: "google-vertex/gemini-2.5-pro",
		thinkingLevel: ThinkingLevel.High,
	});
	expect(session.sessionManager.buildSessionContext().models.default).toBe("google-vertex/gemini-2.5-pro");
	const resumed = new AgentSession({
		agent: new Agent({ initialState: { model: models[1], tools: [], messages: [], systemPrompt: "Test" } }),
		settings: session.settings,
		sessionManager: session.sessionManager,
		modelRegistry: session.modelRegistry,
	});
	expect(resumed.getRoutingState().manualPin).toBe("google-vertex/gemini-2.5-pro");
	await resumed.dispose();
});

test("saving default changes current and future selections without altering other roles", async () => {
	const { session, settings, models, dir } = await harness();
	await applyModelSelection(session, {
		scope: "default",
		model: models[1],
		selector: "google-vertex/gemini-2.5-pro",
		thinkingLevel: ThinkingLevel.High,
	});
	expect(session.model).toBe(models[1]);
	expect(session.thinkingLevel).toBe(ThinkingLevel.High);
	expect(settings.getModelRole("default")).toBe("google-vertex/gemini-2.5-pro:high");
	expect(await Bun.file(join(dir, "config.yml")).text()).toContain("default: google-vertex/gemini-2.5-pro:high");
});

test("session persistence failure restores the previous active model and routing pin", async () => {
	const { session, models } = await harness();
	const previousPin = session.getRoutingState().manualPin;
	const flush = vi.spyOn(session.sessionManager, "flush").mockRejectedValueOnce(new Error("session disk full"));
	await expect(
		applyModelSelection(session, {
			scope: "conversation",
			model: models[1],
			selector: "google-vertex/gemini-2.5-pro",
			thinkingLevel: ThinkingLevel.High,
		}),
	).rejects.toThrow("session disk full");
	expect(session.model).toBe(models[0]);
	expect(session.getRoutingState().manualPin).toBe(previousPin);
	flush.mockRestore();
});
