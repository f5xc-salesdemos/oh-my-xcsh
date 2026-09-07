import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, isEnoent } from "@f5-sales-demo/pi-utils";
import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type GoogleGenAIOptions,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { $ } from "bun";
import { OAuth2Client } from "google-auth-library";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import type { GoogleThinkingLevel } from "./google-gemini-cli";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared";

export interface GoogleVertexOptions extends StreamOptions {
	/** OAuth bearer token from the isolated Vertex credential namespace. */
	apiKey?: string;
	toolChoice?: "auto" | "none" | "any" | { name: string };
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
	project?: string;
	location?: string;
}

export interface GoogleVertexProjectRuntime {
	readAdcProject(): Promise<string | undefined>;
	readLocalConfigProject?(): Promise<string | undefined>;
	findGcloud(): string | null;
	readConfiguredProject(gcloud: string): Promise<string | undefined>;
}

interface GoogleVertexSamplingConfig extends GenerateContentConfig {
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}

const API_VERSION = "v1";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			// apiKey is an isolated, short-lived OAuth bearer token for the Corporate
			// Vertex route. It is never sourced from Gemini consumer credentials.
			const project = await resolveGoogleVertexProject(options);
			const location = resolveGoogleVertexLocation(options);
			const client = createClient(model, project, location, options?.apiKey);
			const params = buildGoogleVertexParams(model, context, options);
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: googleVertexRequestUrl(model.id, project, location),
				body: params,
			};
			const googleStream = await client.models.generateContentStream(params);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							if (!firstTokenTime) firstTokenTime = Date.now();
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some(b => b.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					// promptTokenCount includes cachedContentTokenCount when cached content is used.
					// Subtract to get non-cached input, matching the OpenAI convention where
					// input = uncached prompt tokens and cacheRead = cached tokens so that
					// input + cacheRead = total prompt tokens (no double-counting).
					// Ref: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse.UsageMetadata
					const cachedTokens = chunk.usageMetadata.cachedContentTokenCount || 0;
					output.usage = {
						input: (chunk.usageMetadata.promptTokenCount || 0) - cachedTokens,
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: cachedTokens,
						cacheWrite: 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(
					output.rawStopReason ? `Gemini stopped with ${output.rawStopReason}` : "An unknown error occurred",
				);
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = await finalizeErrorMessage(error, rawRequestDump);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function buildHttpOptions(model: Model<"google-vertex">): { headers?: Record<string, string> } | undefined {
	if (!model.headers) {
		return undefined;
	}
	return { headers: { ...model.headers } };
}

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	accessToken?: string,
): GoogleGenAI {
	return new GoogleGenAI(buildGoogleVertexClientOptions(model, project, location, accessToken));
}

export function buildGoogleVertexClientOptions(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	accessToken?: string,
): GoogleGenAIOptions {
	return {
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		googleAuthOptions: accessToken ? { authClient: createGoogleVertexAuthClient(accessToken) } : undefined,
		httpOptions: buildHttpOptions(model),
	};
}

/** Create an explicit auth client so standalone OAuth never invokes ambient ADC discovery. */
export function createGoogleVertexAuthClient(accessToken: string): OAuth2Client {
	const authClient = new OAuth2Client();
	authClient.setCredentials({ access_token: accessToken });
	return authClient;
}

const defaultProjectRuntime: GoogleVertexProjectRuntime = {
	readAdcProject,
	readLocalConfigProject: readConfiguredGcloudProject,
	findGcloud: () => $which("gcloud"),
	readConfiguredProject: async gcloud => {
		const result = await $`${gcloud} config get-value project`.quiet().nothrow();
		const configuredProject = result.text().trim();
		if (result.exitCode !== 0 || !configuredProject || configuredProject === "(unset)") {
			return undefined;
		}
		return configuredProject;
	},
};

function parseGcloudCoreProject(content: string): string | undefined {
	let inCoreSection = false;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const section = line.match(/^\[([^\]]+)]$/);
		if (section) {
			inCoreSection = section[1].trim() === "core";
			continue;
		}
		if (!inCoreSection) continue;
		const property = line.match(/^project\s*=\s*(.+)$/);
		if (!property) continue;
		const project = property[1].trim();
		return project && project !== "(unset)" ? project : undefined;
	}
	return undefined;
}

/** Read the active gcloud project's INI file without requiring gcloud's Python launcher. */
export async function readConfiguredGcloudProject(
	configDirectory: string = $env.CLOUDSDK_CONFIG || path.join(os.homedir(), ".config", "gcloud"),
): Promise<string | undefined> {
	let configurationName = $env.CLOUDSDK_ACTIVE_CONFIG_NAME?.trim();
	if (!configurationName) {
		try {
			configurationName = (await fs.readFile(path.join(configDirectory, "active_config"), "utf8")).trim();
		} catch {
			configurationName = "default";
		}
	}
	if (!/^[A-Za-z0-9_-]+$/.test(configurationName)) return undefined;

	try {
		const content = await fs.readFile(
			path.join(configDirectory, "configurations", `config_${configurationName}`),
			"utf8",
		);
		return parseGcloudCoreProject(content);
	} catch {
		return undefined;
	}
}

export async function resolveGoogleVertexProject(
	options?: GoogleVertexOptions,
	runtime: GoogleVertexProjectRuntime = defaultProjectRuntime,
): Promise<string> {
	const project = options?.project || $env.GOOGLE_CLOUD_PROJECT || $env.GCLOUD_PROJECT;
	if (project) return project;

	const adcProject = await runtime.readAdcProject();
	if (adcProject) return adcProject;

	const localConfigProject = await runtime.readLocalConfigProject?.();
	if (localConfigProject) return localConfigProject;

	const gcloud = runtime.findGcloud();
	if (gcloud) {
		const configuredProject = await runtime.readConfiguredProject(gcloud);
		if (configuredProject) return configuredProject;
	}

	throw new Error(
		"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT, run `gcloud config set project PROJECT_ID`, or pass project in options.",
	);
}

export function resolveGoogleVertexLocation(options?: GoogleVertexOptions): string {
	// Gemini 3.8 Flash Corporate is served through the global endpoint only.
	// Ignore inherited provider/environment locations so a request cannot drift.
	void options;
	return "global";
}

async function readAdcProject(): Promise<string | undefined> {
	const credentialsPath =
		$env.GOOGLE_APPLICATION_CREDENTIALS ||
		path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
	try {
		const credentials = (await Bun.file(credentialsPath).json()) as {
			project_id?: unknown;
		};
		if (typeof credentials.project_id === "string" && credentials.project_id.length > 0) {
			return credentials.project_id;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return undefined;
}

export function googleVertexRequestUrl(modelId: string, project: string, location: string): string {
	const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
	return `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent`;
}

export function buildGoogleVertexParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const isGemini38Flash = model.id === "gemini-3.8-flash";
	if (isGemini38Flash && options.thinking?.level === "MINIMAL") {
		throw new Error("MINIMAL thinking is not supported by Gemini 3.8 Flash");
	}

	const generationConfig: GoogleVertexSamplingConfig = {};
	if (!isGemini38Flash && options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (!isGemini38Flash && options.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (!isGemini38Flash && options.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (!isGemini38Flash && options.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (!isGemini38Flash && options.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (!isGemini38Flash && options.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: context.systemPrompt.toWellFormed() }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools, model) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		const forcedToolName = typeof options.toolChoice === "string" ? undefined : options.toolChoice.name;
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(typeof options.toolChoice === "string" ? options.toolChoice : "any"),
				...(forcedToolName && { allowedFunctionNames: [forcedToolName] }),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (model.reasoning && (options.thinking?.enabled || isGemini38Flash)) {
		const cfg: ThinkingConfig = { includeThoughts: true };
		if (options.thinking?.level !== undefined) {
			cfg.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
		} else if (isGemini38Flash) {
			cfg.thinkingLevel = ThinkingLevel.HIGH;
		} else if (options.thinking?.budgetTokens !== undefined) {
			cfg.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = cfg;
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}
