import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import type { Model } from "@f5-sales-demo/pi-ai";
import { commitLiteLLMLogin } from "../src/modes/controllers/litellm-login-transaction";
import { LITELLM_LOGIN_MODEL_CHOICES } from "../src/modes/controllers/login-model";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createPaths() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-litellm-transaction-"));
	temporaryDirectories.push(directory);
	return {
		modelsPath: path.join(directory, "models.yml"),
		configPath: path.join(directory, "config.yml"),
	};
}

function createSession(options?: { failModelApply?: boolean; selectedModel?: Model }) {
	const previousModel = { id: "previous", provider: "previous-provider" } as Model;
	const selectedModel = options?.selectedModel ?? ({ id: "gpt-5.6-sol", provider: "litellm" } as Model);
	const refresh = vi.fn(async () => {});
	let modelRoles: Record<string, string> = { default: "previous-provider/previous:medium", smol: "other/smol" };
	const settings = {
		getModelRoles: vi.fn(() => modelRoles),
		set: vi.fn((_key: "modelRoles", value: Record<string, string>) => {
			modelRoles = value;
		}),
	};
	const setModel = vi.fn(async () => {
		modelRoles = { ...modelRoles, default: "litellm/gpt-5.6-sol:high" };
		if (options?.failModelApply) throw new Error("model apply failed");
	});
	const setModelTemporary = vi.fn(async () => {});
	const setThinkingLevel = vi.fn();
	return {
		previousModel,
		selectedModel,
		refresh,
		setModel,
		setModelTemporary,
		setThinkingLevel,
		settings,
		getModelRoles: () => modelRoles,
		session: {
			model: previousModel,
			thinkingLevel: ThinkingLevel.Medium,
			modelRegistry: { refresh, getAll: () => [selectedModel, previousModel] },
			setModel,
			setModelTemporary,
			setThinkingLevel,
			settings,
		},
	};
}

const GPT = LITELLM_LOGIN_MODEL_CHOICES.find(choice => choice.modelId === "gpt-5.6-sol")!;
const OPUS = LITELLM_LOGIN_MODEL_CHOICES.find(choice => choice.modelId === "claude-opus-5")!;

describe("commitLiteLLMLogin", () => {
	it("writes the URL-bearing profiles, refreshes, and applies the selected model", async () => {
		const paths = createPaths();
		const state = createSession();

		await commitLiteLLMLogin({
			...paths,
			credentials: { baseUrl: "https://litellm.example.test", apiKey: "sk-test" },
			probe: { reachable: true, models: ["gpt-5.6-sol"], apiBasePath: "/api/v1" },
			choice: GPT,
			session: state.session,
		});

		const modelsYml = fs.readFileSync(paths.modelsPath, "utf8");
		expect(modelsYml).toContain('baseUrl: "https://litellm.example.test/anthropic"');
		expect(modelsYml).toContain('baseUrl: "https://litellm.example.test/api/v1"');
		expect(modelsYml).toContain('apiKey: "sk-test"');
		expect(fs.existsSync(paths.configPath)).toBe(true);
		expect(state.refresh).toHaveBeenCalledWith("online");
		expect(state.setModel).toHaveBeenCalledWith(state.selectedModel, "default", {
			selector: "litellm/gpt-5.6-sol",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(state.getModelRoles()).toEqual({
			smol: "litellm/gpt-5.6-luna:low",
			default: "litellm/gpt-5.6-terra:medium",
			slow: "litellm/gpt-5.6-sol:high",
			plan: "litellm/gpt-5.6-sol:high",
		});
	});

	it("applies Claude family defaults without relying on the OAuth entitlement manifest", async () => {
		const paths = createPaths();
		const state = createSession({ selectedModel: { id: "claude-opus-5", provider: "anthropic" } as Model });

		await commitLiteLLMLogin({
			...paths,
			credentials: { baseUrl: "https://litellm.example.test", apiKey: "sk-test" },
			probe: { reachable: true, models: ["claude-opus-5"], apiBasePath: "/v1" },
			choice: OPUS,
			session: state.session,
		});

		expect(state.getModelRoles()).toEqual({
			smol: "anthropic/claude-haiku-4-5:low",
			default: "anthropic/claude-sonnet-5:medium",
			slow: "anthropic/claude-opus-5:high",
			plan: "anthropic/claude-opus-5:high",
		});
	});

	it("restores both files and the prior active model when apply fails", async () => {
		const paths = createPaths();
		const previousModels = "previous models\n";
		const previousConfig = "previous config\n";
		fs.writeFileSync(paths.modelsPath, previousModels);
		fs.writeFileSync(paths.configPath, previousConfig);
		const state = createSession({ failModelApply: true });

		await expect(
			commitLiteLLMLogin({
				...paths,
				credentials: { baseUrl: "https://litellm.example.test", apiKey: "sk-test" },
				probe: { reachable: true, models: ["gpt-5.6-sol"], apiBasePath: "/v1" },
				choice: GPT,
				session: state.session,
			}),
		).rejects.toThrow("model apply failed");

		expect(fs.readFileSync(paths.modelsPath, "utf8")).toBe(previousModels);
		expect(fs.readFileSync(paths.configPath, "utf8")).toBe(previousConfig);
		expect(state.refresh).toHaveBeenCalledTimes(2);
		expect(state.setModelTemporary).toHaveBeenCalledWith(state.previousModel, ThinkingLevel.Medium);
		expect(state.getModelRoles()).toEqual({ default: "previous-provider/previous:medium", smol: "other/smol" });
	});

	it("removes newly-created files when the first commit fails", async () => {
		const paths = createPaths();
		const state = createSession({ failModelApply: true });

		await expect(
			commitLiteLLMLogin({
				...paths,
				credentials: { baseUrl: "https://litellm.example.test", apiKey: "sk-test" },
				probe: { reachable: true, models: ["gpt-5.6-sol"], apiBasePath: "/v1" },
				choice: GPT,
				session: state.session,
			}),
		).rejects.toThrow("model apply failed");

		expect(fs.existsSync(paths.modelsPath)).toBe(false);
		expect(fs.existsSync(paths.configPath)).toBe(false);
	});
});
