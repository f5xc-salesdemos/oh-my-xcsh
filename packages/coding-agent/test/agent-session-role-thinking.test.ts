import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@f5-sales-demo/pi-agent-core";
import { createThinkingConfig, Effort, getBundledModel, ReasoningEffort } from "@f5-sales-demo/pi-ai";
import { TempDir } from "@f5-sales-demo/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { resolveThinkingLevelForModel } from "../src/thinking";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:medium`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		session.setThinkingLevel(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBeUndefined();
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("applies slow role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowPlanModel.provider}/${slowPlanModel.id}:high`,
				plan: `${slowPlanModel.provider}/${slowPlanModel.id}:off`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowPlanModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("rejects an unsupported saved role effort when updating the model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await expect(session.setModel(slowModel)).rejects.toThrow(/cannot disable thinking/i);
		expect(sessionSettings.getModelRole("default")).toBe("anthropic/nonexistent-model:off");
	});

	it("rejects unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-xhigh.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-xhigh.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(() => session.setThinkingLevel(Effort.XHigh)).toThrow(/xhigh is not supported/i);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("cycles through off only when the model advertises none", async () => {
		const model = {
			...getAnthropicModelOrThrow("claude-sonnet-4-5"),
			thinking: createThinkingConfig([ReasoningEffort.None, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-cycle-thinking.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-cycle-thinking.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("omits inherited effort while preserving supported Vertex overrides", () => {
		const flash = getBundledModel("google-vertex", "gemini-3.8-flash");
		const pro = getBundledModel("google-vertex", "gemini-3-pro-preview");
		const lite = getBundledModel("google-vertex", "gemini-2.5-flash-lite");

		expect(resolveThinkingLevelForModel(flash, undefined)).toBeUndefined();
		expect(resolveThinkingLevelForModel(pro, undefined)).toBeUndefined();
		for (const effort of [Effort.Low, Effort.Medium, Effort.High]) {
			expect(resolveThinkingLevelForModel(flash, effort)).toBe(effort);
			expect(resolveThinkingLevelForModel(pro, effort)).toBe(effort);
		}
		expect(resolveThinkingLevelForModel(lite, undefined)).toBeUndefined();
	});

	it("rejects off atomically when switching to Vertex Gemini 3", async () => {
		const initialModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetModel = getBundledModel("google-vertex", "gemini-3.8-flash");
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-vertex.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("google-vertex", "test-key");
		const sessionManager = SessionManager.inMemory();
		sessionSettings = Settings.isolated();
		sessionSettings.setModelRole("default", `${initialModel.provider}/${initialModel.id}:low`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models-vertex.yml")),
		});
		const entryCount = sessionManager.getEntries().length;
		const previousThinkingLevel = session.thinkingLevel;

		await expect(session.setModel(targetModel, "default", { thinkingLevel: "off" })).rejects.toThrow(
			/cannot disable thinking.*google-vertex\/gemini-3\.8-flash/i,
		);
		expect(session.model?.id).toBe(initialModel.id);
		expect(session.thinkingLevel).toBe(previousThinkingLevel);
		expect(sessionSettings.getModelRole("default")).toBe(`${initialModel.provider}/${initialModel.id}:low`);
		expect(sessionManager.getEntries()).toHaveLength(entryCount);
	});

	it("omits inherited effort when switching and lets a saved exact effort win", async () => {
		const initialModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetModel = getBundledModel("google-vertex", "gemini-3.8-flash");
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-vertex-default.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("google-vertex", "test-key");
		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models-vertex-default.yml")),
		});

		await session.setModelTemporary(targetModel);
		expect(session.thinkingLevel).toBeUndefined();

		await session.setModel(initialModel);
		sessionSettings.setModelRole("default", `${targetModel.provider}/${targetModel.id}:medium`);
		await session.setModel(targetModel);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("allows off for models that explicitly advertise none", () => {
		const model = {
			...getAnthropicModelOrThrow("claude-sonnet-4-5"),
			thinking: createThinkingConfig([ReasoningEffort.None, Effort.Low, Effort.Medium]),
		};
		expect(resolveThinkingLevelForModel(model, "off")).toBe("off");
	});
});
