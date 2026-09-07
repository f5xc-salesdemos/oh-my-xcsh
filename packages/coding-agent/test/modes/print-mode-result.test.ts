import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";

function assistantMessage(
	stopReason: "stop" | "error" | "aborted",
	content: AssistantMessage["content"] = stopReason === "stop" ? [{ type: "text", text: "ok" }] : [],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "litellm",
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
		...(stopReason !== "stop" ? { errorMessage: "405 Method Not Allowed" } : {}),
	};
}

function fakeSession(message: AssistantMessage): { session: AgentSession; dispose: ReturnType<typeof mock> } {
	const dispose = mock(async () => {});
	const session = {
		sessionManager: { getHeader: () => null },
		model: undefined,
		thinkingLevel: undefined,
		extensionRunner: undefined,
		subscribe: () => () => {},
		state: { messages: [message] },
		dispose,
	} as unknown as AgentSession;
	return { session, dispose };
}

describe("print mode result", () => {
	it("returns failure for a JSON model error and leaves lifecycle disposal to main", async () => {
		const { session, dispose } = fakeSession(assistantMessage("error"));

		const result = await runPrintMode(session, { mode: "json" });

		expect(result).toBe(1);
		expect(dispose).not.toHaveBeenCalled();
	});

	it("returns failure and reports the provider error in text mode", async () => {
		const { session, dispose } = fakeSession(assistantMessage("error"));
		const originalWrite = process.stderr.write;
		let stderr = "";
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += chunk.toString();
			return true;
		}) as typeof process.stderr.write;

		try {
			const result = await runPrintMode(session, { mode: "text" });

			expect(result).toBe(1);
			expect(stderr).toBe("405 Method Not Allowed\n");
			expect(dispose).not.toHaveBeenCalled();
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("returns failure when the model turn is aborted", async () => {
		const { session } = fakeSession(assistantMessage("aborted"));

		expect(await runPrintMode(session, { mode: "json" })).toBe(1);
	});

	it("returns success for a completed JSON response", async () => {
		const { session, dispose } = fakeSession(assistantMessage("stop"));

		const result = await runPrintMode(session, { mode: "json" });

		expect(result).toBe(0);
		expect(dispose).not.toHaveBeenCalled();
	});

	it("prints only final-answer text and keeps missing-phase fallback semantics", async () => {
		const { session } = fakeSession(
			assistantMessage("stop", [
				{ type: "text", text: "Checking.", phase: "commentary" },
				{ type: "text", text: "Answer one.", phase: "final_answer" },
				{ type: "text", text: "Answer two." },
			]),
		);
		const originalWrite = process.stdout.write;
		let stdout = "";
		process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
			stdout += chunk.toString();
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		try {
			expect(await runPrintMode(session, { mode: "text" })).toBe(0);
			expect(stdout).toBe("Answer one.\nAnswer two.\n");
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});
