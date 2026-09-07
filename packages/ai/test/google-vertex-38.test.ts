import { describe, expect, it } from "bun:test";
import { Effort, getBundledModel } from "@f5-sales-demo/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import { buildGoogleVertexParams, googleVertexRequestUrl } from "../src/providers/google-vertex";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types";

describe("Vertex Gemini 3.8 request contract", () => {
	const model = getBundledModel("google-vertex", "gemini-3.8-flash") as Model<"google-vertex">;

	it("defaults to HIGH and strips deprecated or unsupported sampling controls", () => {
		const params = buildGoogleVertexParams(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				temperature: 0.2,
				topP: 0.8,
				topK: 20,
				minP: 0.1,
				presencePenalty: 0.5,
				repetitionPenalty: 0.5,
				maxTokens: 1234,
			},
		);

		expect(params.model).toBe("gemini-3.8-flash");
		expect(params.config).toMatchObject({
			maxOutputTokens: 1234,
			thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
		});
		for (const field of ["temperature", "topP", "topK", "minP", "presencePenalty", "repetitionPenalty"]) {
			expect(params.config).not.toHaveProperty(field);
		}
		expect(googleVertexRequestUrl(model.id, "test-project", "global")).toContain(
			"/models/gemini-3.8-flash:streamGenerateContent",
		);
	});

	it.each([
		[Effort.Low, "LOW"],
		[Effort.Medium, "MEDIUM"],
		[Effort.High, "HIGH"],
	] as const)("preserves an explicit %s thinking level", (_effort, expected) => {
		const params = buildGoogleVertexParams(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ thinking: { enabled: true, level: expected } },
		);
		expect(String(params.config?.thinkingConfig?.thinkingLevel)).toBe(expected);
		expect(model.thinking?.defaultLevel).toBe(Effort.High);
	});

	it("does not advertise or accept unsupported MINIMAL thinking", () => {
		expect(model.thinking?.supportedLevels.map(level => level.effort)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		expect(() =>
			buildGoogleVertexParams(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{ thinking: { enabled: true, level: "MINIMAL" } },
			),
		).toThrow(/MINIMAL.*Gemini 3\.8 Flash/i);
	});

	it("restricts forced function calling to the requested tool", () => {
		const params = buildGoogleVertexParams(
			model,
			{
				messages: [{ role: "user", content: "Use lookup", timestamp: 1 }],
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						parameters: { type: "object", properties: {} } as unknown as TSchema,
					},
				],
			},
			{ toolChoice: { name: "lookup" } },
		);

		const functionCalling = params.config?.toolConfig?.functionCallingConfig;
		expect(String(functionCalling?.mode)).toBe("ANY");
		expect(functionCalling?.allowedFunctionNames).toEqual(["lookup"]);
	});

	it("keeps matching function-call and function-response IDs", () => {
		const toolCallId = "call-38_exact";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "lookup", arguments: { value: 7 } }],
			api: "google-vertex",
			provider: "google-vertex",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: "lookup",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 3,
		};
		const context: Context = {
			messages: [{ role: "user", content: "Use lookup", timestamp: 1 }, assistant, result],
		};

		const params = buildGoogleVertexParams(model, context);
		if (!Array.isArray(params.contents)) throw new Error("Expected array contents");
		const contents = params.contents as Array<{
			parts?: Array<{
				functionCall?: { id?: string };
				functionResponse?: { id?: string; name?: string };
			}>;
		}>;
		const modelTurn = contents[1];
		const responseTurn = contents[2];
		expect(modelTurn?.parts?.[0]?.functionCall?.id).toBe(toolCallId);
		expect(responseTurn?.parts?.[0]?.functionResponse?.id).toBe(toolCallId);
		expect(responseTurn?.parts?.[0]?.functionResponse?.name).toBe("lookup");
	});
});
