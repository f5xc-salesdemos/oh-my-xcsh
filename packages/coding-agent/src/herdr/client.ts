import { randomUUID } from "node:crypto";
import { connect } from "node:net";

export const HERDR_PROTOCOL_MIN_VERSION = 19;
export const HERDR_PROTOCOL_MAX_VERSION = 20;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HerdrProtocolError extends Error {
	constructor(
		message: string,
		readonly code = "protocol_error",
	) {
		super(message);
		this.name = "HerdrProtocolError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Typed, one-request-per-connection client for supported Herdr JSONL protocols. */
export class HerdrClient {
	private protocolChecked = false;
	private negotiatedProtocol: number | undefined;
	private capabilities: Readonly<Record<string, unknown>> = {};

	constructor(
		readonly socketPath: string,
		readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {
		if (!socketPath) throw new HerdrProtocolError("HERDR_SOCKET_PATH is unavailable", "unavailable");
	}

	async ensureProtocol(): Promise<void> {
		if (this.protocolChecked) return;
		const pong = await this.requestRaw<{
			type: string;
			protocol: number;
			version: string;
			capabilities?: Record<string, unknown>;
		}>("ping", {});
		if (
			pong.type !== "pong" ||
			!Number.isInteger(pong.protocol) ||
			pong.protocol < HERDR_PROTOCOL_MIN_VERSION ||
			pong.protocol > HERDR_PROTOCOL_MAX_VERSION
		) {
			throw new HerdrProtocolError(
				`Herdr protocol mismatch: supported ${HERDR_PROTOCOL_MIN_VERSION}-${HERDR_PROTOCOL_MAX_VERSION}, received ${String(pong.protocol)}`,
				"protocol_mismatch",
			);
		}
		this.negotiatedProtocol = pong.protocol;
		this.capabilities = isRecord(pong.capabilities) ? Object.freeze({ ...pong.capabilities }) : {};
		this.protocolChecked = true;
	}

	get protocolVersion(): number | undefined {
		return this.negotiatedProtocol;
	}

	hasCapability(name: string): boolean {
		return this.capabilities[name] === true;
	}

	async request<T extends Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
		await this.ensureProtocol();
		return this.requestRaw<T>(method, params);
	}

	private requestRaw<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = `xcsh:${randomUUID()}`;
		return new Promise<T>((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const socket = connect({ path: this.socketPath });
			const finish = (error?: unknown, value?: T): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (error !== undefined) reject(error);
				else resolve(value as T);
			};
			socket.setEncoding("utf8");
			socket.setTimeout(this.timeoutMs, () => finish(new HerdrProtocolError("Herdr request timed out", "timeout")));
			socket.once("error", error => finish(new HerdrProtocolError(error.message, "transport_error")));
			socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
			socket.on("data", chunk => {
				buffer += chunk;
				if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
					finish(new HerdrProtocolError("Herdr response exceeded 4 MiB", "response_too_large"));
					return;
				}
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.trim()) continue;
					let decoded: unknown;
					try {
						decoded = JSON.parse(line);
					} catch {
						finish(new HerdrProtocolError("Herdr returned invalid JSON", "invalid_json"));
						return;
					}
					if (!isRecord(decoded) || decoded.id !== id) continue;
					if (isRecord(decoded.error)) {
						finish(
							new HerdrProtocolError(
								typeof decoded.error.message === "string" ? decoded.error.message : "Herdr request failed",
								typeof decoded.error.code === "string" ? decoded.error.code : "remote_error",
							),
						);
						return;
					}
					if (!("result" in decoded) || !isRecord(decoded.result)) {
						finish(new HerdrProtocolError("Herdr response is missing a typed result"));
						return;
					}
					finish(undefined, decoded.result as T);
					return;
				}
			});
			socket.once("end", () => {
				if (settled) return;
				// Protocol 19 permits the final response to be terminated by EOF. The
				// server normally emits JSONL, but older/current transports may omit the
				// trailing newline when they close a one-shot connection.
				try {
					const decoded = JSON.parse(buffer) as Record<string, unknown>;
					if (decoded.id !== id) throw new Error("response id mismatch");
					if (isRecord(decoded.error)) {
						finish(
							new HerdrProtocolError(
								typeof decoded.error.message === "string" ? decoded.error.message : "Herdr request failed",
								typeof decoded.error.code === "string" ? decoded.error.code : "remote_error",
							),
						);
					} else if (isRecord(decoded.result)) finish(undefined, decoded.result as T);
					else finish(new HerdrProtocolError("Herdr response is missing a typed result"));
				} catch {
					finish(new HerdrProtocolError("Herdr closed the socket before responding", "eof"));
				}
			});
		});
	}
}
