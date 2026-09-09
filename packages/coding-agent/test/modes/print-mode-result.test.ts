import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@f5-sales-demo/pi-ai";
import { Snowflake } from "@f5-sales-demo/pi-utils";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

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

function fakeSession(
	message: AssistantMessage,
	sessionManager: Pick<SessionManager, "getHeader" | "ensureOnDisk"> = {
		getHeader: () => null,
		ensureOnDisk: async () => {},
	},
): { session: AgentSession; dispose: ReturnType<typeof mock> } {
	const dispose = mock(async () => {});
	const session = {
		sessionManager,
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

	it("persists the JSON header before advertising its resumable session", async () => {
		const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `xcsh-json-header-${Snowflake.next()}-`));
		const sessionManager = SessionManager.create(sessionDir, sessionDir);
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Expected persistent session header");
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session path");
		const { session } = fakeSession(assistantMessage("stop"), sessionManager);
		let stdout = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
			stdout += chunk.toString();
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		try {
			await runPrintMode(session, { mode: "json" });
			const advertisedHeader = JSON.parse(stdout.trim()) as { id?: unknown };
			expect(advertisedHeader.id).toBe(header.id);
			expect(header.id).toMatch(/^[0-9a-f]{16}$/);
			expect(fs.existsSync(sessionFile)).toBe(true);
			expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).id).toBe(header.id);
			expect((await SessionManager.open(sessionFile, sessionDir)).getHeader()?.id).toBe(header.id);
		} finally {
			process.stdout.write = originalWrite;
			fs.rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
