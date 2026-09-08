import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import type { Model } from "@f5-sales-demo/pi-ai";
import { writeAgentConfigFileSync } from "../../config/agent-config-file";
import {
	generateConfigYml,
	generateModelsYml,
	healConfigYmlModelRoles,
	type ProbeResult,
	writeLiteLLMModelsYml,
} from "../../config/auto-config";
import type { LiteLLMLoginCredentials } from "./litellm-login-flow";
import { applyModelAfterLogin, getLiteLLMLoginModelRoles, type LiteLLMLoginModelChoice } from "./login-model";

interface TransactionSession {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	modelRegistry: {
		refresh(mode: "online"): Promise<void>;
		getAll(): Model[];
	};
	setModel(model: Model, role: "default", options: { selector: string; thinkingLevel: ThinkingLevel }): Promise<void>;
	setModelTemporary?(model: Model, thinkingLevel?: ThinkingLevel): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	settings: {
		getModelRoles(): Readonly<Record<string, string | undefined>>;
		set(key: "modelRoles", value: Record<string, string>): void;
	};
}

interface CommitLiteLLMLoginOptions {
	modelsPath: string;
	configPath: string;
	credentials: LiteLLMLoginCredentials;
	probe: ProbeResult;
	choice: LiteLLMLoginModelChoice;
	session: TransactionSession;
}

interface FileSnapshot {
	existed: boolean;
	content?: Buffer;
	mode?: number;
}

function captureFile(filePath: string): FileSnapshot {
	try {
		const stat = fs.statSync(filePath);
		return { existed: true, content: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
		throw error;
	}
}

async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
	if (!snapshot.existed) {
		await fs.promises.rm(filePath, { force: true });
		return;
	}
	if (!snapshot.content) throw new Error(`Missing rollback content for ${filePath}`);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, snapshot.content, { mode: snapshot.mode });
	if (snapshot.mode !== undefined) await fs.promises.chmod(filePath, snapshot.mode);
}

/**
 * Persist the prepared LiteLLM configuration and selected model as one
 * recoverable operation. Any failure restores the prior files and active model.
 */
export async function commitLiteLLMLogin(options: CommitLiteLLMLoginOptions): Promise<void> {
	const { modelsPath, configPath, credentials, probe, choice, session } = options;
	const modelsSnapshot = captureFile(modelsPath);
	const configSnapshot = captureFile(configPath);
	const previousModel = session.model;
	const previousThinkingLevel = session.thinkingLevel;
	const previousModelRoles = Object.fromEntries(
		Object.entries(session.settings.getModelRoles()).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);

	try {
		const yml = generateModelsYml(credentials.baseUrl, {
			apiBasePath: probe.apiBasePath,
			apiKeyLiteral: credentials.apiKey,
		});
		await writeLiteLLMModelsYml(modelsPath, yml);

		if (!fs.existsSync(configPath)) writeAgentConfigFileSync(configPath, generateConfigYml());
		healConfigYmlModelRoles(configPath);

		await session.modelRegistry.refresh("online");
		const applied = await applyModelAfterLogin(session, choice);
		if (!applied) throw new Error(`Model unavailable after refresh: ${choice.provider}/${choice.modelId}`);
		session.settings.set("modelRoles", getLiteLLMLoginModelRoles(choice, previousModelRoles));
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		for (const [filePath, snapshot] of [
			[configPath, configSnapshot],
			[modelsPath, modelsSnapshot],
		] as const) {
			try {
				await restoreFile(filePath, snapshot);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}

		try {
			session.settings.set("modelRoles", previousModelRoles);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}

		try {
			await session.modelRegistry.refresh("online");
			if (previousModel && session.setModelTemporary) {
				await session.setModelTemporary(previousModel, previousThinkingLevel);
			} else if (previousThinkingLevel !== undefined) {
				session.setThinkingLevel(previousThinkingLevel);
			}
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}

		if (rollbackErrors.length > 0) {
			throw new AggregateError([error, ...rollbackErrors], "LiteLLM login failed and rollback was incomplete");
		}
		throw error;
	}
}
