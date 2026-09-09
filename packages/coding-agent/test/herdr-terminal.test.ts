import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildXcshCommand, shellQuote } from "../src/commands/herdr";
import { createRetryingLazy } from "../src/extensibility/extensions/bundled/herdr-terminal";
import { HerdrClient, HerdrProtocolError } from "../src/herdr/client";
import { type HerdrBindingV1, HerdrController } from "../src/herdr/controller";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

interface Request {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

async function fakeHerdr(
	handler: (request: Request) => Record<string, unknown>,
	options: { trailingNewline?: boolean } = {},
): Promise<{ socketPath: string; requests: Request[]; close(): Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "xcsh-herdr-terminal-"));
	roots.push(root);
	const socketPath = path.join(root, "herdr.sock");
	const requests: Request[] = [];
	const server: Server = createServer(socket => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			input += chunk;
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(input.slice(0, newline)) as Request;
			requests.push(request);
			const suffix = options.trailingNewline === false ? "" : "\n";
			socket.end(`${JSON.stringify({ id: request.id, result: handler(request) })}${suffix}`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
	};
}

function binding(ownerToken = "owner-a"): HerdrBindingV1 {
	return {
		version: 1,
		sessionName: "org",
		workspaceId: "w1",
		rootPaneId: "w1:p1",
		ownerToken,
		terminals: [],
	};
}

describe("Herdr protocol client", () => {
	test("validates the protocol and reconnects for each request", async () => {
		const fake = await fakeHerdr(request =>
			request.method === "ping"
				? { type: "pong", protocol: 19, version: "test" }
				: { type: "workspace_list", workspaces: [] },
		);
		try {
			const client = new HerdrClient(fake.socketPath);
			expect((await client.request("workspace.list", {})).type).toBe("workspace_list");
			expect((await client.request("workspace.list", {})).type).toBe("workspace_list");
			expect(fake.requests.map(request => request.method)).toEqual(["ping", "workspace.list", "workspace.list"]);
		} finally {
			await fake.close();
		}
	});

	test("negotiates protocol 22 and advertised capabilities", async () => {
		const fake = await fakeHerdr(request =>
			request.method === "ping"
				? { type: "pong", protocol: 22, version: "test", capabilities: { agent_turn_journal: true } }
				: { type: "workspace_list", workspaces: [] },
		);
		try {
			const client = new HerdrClient(fake.socketPath);
			await client.ensureProtocol();
			expect(client.protocolVersion).toBe(22);
			expect(client.hasCapability("agent_turn_journal")).toBe(true);
			expect(client.hasCapability("unknown")).toBe(false);
		} finally {
			await fake.close();
		}
	});

	test("rejects incompatible servers", async () => {
		const fake = await fakeHerdr(() => ({ type: "pong", protocol: 17, version: "old" }));
		try {
			await expect(new HerdrClient(fake.socketPath).ensureProtocol()).rejects.toMatchObject({
				code: "protocol_mismatch",
			});
		} finally {
			await fake.close();
		}
	});

	test("rejects unreviewed future protocols", async () => {
		const fake = await fakeHerdr(() => ({ type: "pong", protocol: 23, version: "future" }));
		try {
			await expect(new HerdrClient(fake.socketPath).ensureProtocol()).rejects.toMatchObject({
				code: "protocol_mismatch",
			});
		} finally {
			await fake.close();
		}
	});

	test("accepts a response terminated by EOF without a trailing newline", async () => {
		const fake = await fakeHerdr(
			request =>
				request.method === "ping"
					? { type: "pong", protocol: 19, version: "test" }
					: { type: "pane_list", panes: [] },
			{ trailingNewline: false },
		);
		try {
			expect((await new HerdrClient(fake.socketPath).request("pane.list", {})).type).toBe("pane_list");
		} finally {
			await fake.close();
		}
	});
});

describe("conversation-owned Herdr terminals", () => {
	test("reports unavailable outside Herdr", async () => {
		const oldSocket = process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SOCKET_PATH;
		try {
			await expect(HerdrController.connect()).rejects.toBeInstanceOf(HerdrProtocolError);
		} finally {
			if (oldSocket) process.env.HERDR_SOCKET_PATH = oldSocket;
		}
	});

	test("does not claim an arbitrary Herdr workspace without a launcher owner token", async () => {
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method.endsWith("report_metadata")) return { type: "ok" };
			throw new Error(`unexpected ${request.method}`);
		});
		const previous = {
			session: process.env.HERDR_SESSION,
			workspace: process.env.HERDR_WORKSPACE_ID,
			pane: process.env.HERDR_PANE_ID,
			owner: process.env.XCSH_HERDR_OWNER,
			bindingPath: process.env.XCSH_HERDR_BINDING_PATH,
		};
		process.env.HERDR_SESSION = "org";
		process.env.HERDR_WORKSPACE_ID = "w1";
		process.env.HERDR_PANE_ID = "w1:p1";
		delete process.env.XCSH_HERDR_OWNER;
		delete process.env.XCSH_HERDR_BINDING_PATH;
		try {
			await expect(HerdrController.connect({ socketPath: fake.socketPath })).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(fake.requests).toHaveLength(0);
		} finally {
			const restore = (name: string, value: string | undefined): void => {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			};
			restore("HERDR_SESSION", previous.session);
			restore("HERDR_WORKSPACE_ID", previous.workspace);
			restore("HERDR_PANE_ID", previous.pane);
			restore("XCSH_HERDR_OWNER", previous.owner);
			restore("XCSH_HERDR_BINDING_PATH", previous.bindingPath);
			await fake.close();
		}
	});

	test("creates without focus, filters unrelated panes, and updates the resume reference", async () => {
		const owner = "owner-a";
		const panes = new Map<string, Record<string, unknown>>([
			["w1:p1", { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", tokens: {} }],
			["w1:p9", { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", tokens: { xcsh_owner: "other" } }],
		]);
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method === "pane.report_metadata") {
				Object.assign(panes.get(String(request.params.pane_id))!, { tokens: request.params.tokens });
				return { type: "ok" };
			}
			if (request.method === "workspace.report_metadata") return { type: "ok" };
			if (request.method === "tab.create") {
				panes.set("w1:p2", {
					pane_id: "w1:p2",
					tab_id: "w1:t2",
					workspace_id: "w1",
					tokens: {},
				});
				return {
					type: "tab_created",
					tab: { tab_id: "w1:t2", workspace_id: "w1" },
					root_pane: panes.get("w1:p2")!,
				};
			}
			if (request.method === "pane.list") return { type: "pane_list", panes: [...panes.values()] };
			if (request.method === "pane.get")
				return { type: "pane_info", pane: panes.get(String(request.params.pane_id)) };
			if (request.method === "pane.send_text" || request.method === "pane.send_keys") return { type: "ok" };
			throw new Error(`unexpected ${request.method}`);
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "xcsh-herdr-binding-"));
		roots.push(root);
		const bindingPath = path.join(root, "binding.json");
		try {
			const controller = await HerdrController.connect({
				socketPath: fake.socketPath,
				bindingPath,
				binding: binding(owner),
			});
			const terminal = await controller.create("tests", "/repo");
			expect(terminal.paneId).toBe("w1:p2");
			const create = fake.requests.find(request => request.method === "tab.create")!;
			expect(create.params).toMatchObject({ workspace_id: "w1", label: "tests", cwd: "/repo", focus: false });
			expect(await controller.list()).toEqual([terminal]);
			await controller.run("tests", "printf ready");
			expect(fake.requests.slice(-2).map(request => [request.method, request.params])).toEqual([
				["pane.send_text", { pane_id: "w1:p2", text: "printf ready" }],
				["pane.send_keys", { pane_id: "w1:p2", keys: ["enter"] }],
			]);
			await controller.updateSessionRef("/sessions/current.jsonl");
			const persisted = JSON.parse(await fs.readFile(bindingPath, "utf8")) as HerdrBindingV1;
			expect(persisted.activeSessionRef).toBe("/sessions/current.jsonl");
			expect(JSON.stringify(await controller.list())).not.toContain("w1:p9");
		} finally {
			await fake.close();
		}
	});

	test("requires a second forced close for a busy owned pane", async () => {
		const state = binding();
		state.terminals.push({ name: "server", tabId: "w1:t2", paneId: "w1:p2", createdAt: "now" });
		let closed = false;
		let statusCalls = 0;
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method.endsWith("report_metadata")) return { type: "ok" };
			if (request.method === "pane.get")
				return {
					type: "pane_info",
					pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", tokens: { xcsh_owner: "owner-a" } },
				};
			if (request.method === "pane.list")
				return {
					type: "pane_list",
					panes: [{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", tokens: { xcsh_owner: "owner-a" } }],
				};

			if (request.method === "pane.process_info")
				return {
					type: "pane_process_info",
					process_info:
						statusCalls++ === 0 ? undefined : { shell_pid: 10, foreground_processes: [{ pid: 10 }, { pid: 11 }] },
				};
			if (request.method === "tab.close") {
				closed = true;
				return { type: "ok" };
			}
			throw new Error(`unexpected ${request.method}`);
		});
		try {
			const controller = await HerdrController.connect({ socketPath: fake.socketPath, binding: state });
			await expect(controller.close("server", true)).rejects.toMatchObject({ code: "busy" });
			expect(closed).toBe(false);
			await controller.close("server", true);
			expect(closed).toBe(true);
		} finally {
			await fake.close();
		}
	});

	test("focuses an owned pane only after revalidating its metadata token", async () => {
		const state = binding();
		state.terminals.push({ name: "logs", tabId: "w1:t2", paneId: "w1:p2", createdAt: "now" });
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method.endsWith("report_metadata")) return { type: "ok" };
			if (request.method === "pane.get")
				return {
					type: "pane_info",
					pane: {
						pane_id: "w1:p2",
						tab_id: "w1:t2",
						workspace_id: "w1",
						tokens: { xcsh_owner: "owner-a" },
					},
				};
			if (request.method === "pane.focus") return { type: "ok" };
			throw new Error(`unexpected ${request.method}`);
		});
		try {
			const controller = await HerdrController.connect({ socketPath: fake.socketPath, binding: state });
			await controller.focus("logs");
			expect(fake.requests.slice(-2).map(request => request.method)).toEqual(["pane.get", "pane.focus"]);
		} finally {
			await fake.close();
		}
	});

	test("rejects a forged terminal record before reading or mutating the pane", async () => {
		const state = binding();
		state.terminals.push({ name: "foreign", tabId: "w1:t9", paneId: "w1:p9", createdAt: "now" });
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method.endsWith("report_metadata")) return { type: "ok" };
			if (request.method === "pane.get")
				return {
					type: "pane_info",
					pane: {
						pane_id: "w1:p9",
						tab_id: "w1:t9",
						workspace_id: "w1",
						tokens: { xcsh_owner: "another-owner" },
					},
				};
			throw new Error(`unexpected ${request.method}`);
		});
		try {
			const controller = await HerdrController.connect({ socketPath: fake.socketPath, binding: state });
			await expect(controller.read("foreign")).rejects.toMatchObject({ code: "not_owned" });
			expect(fake.requests.some(request => request.method === "pane.read")).toBe(false);
		} finally {
			await fake.close();
		}
	});

	test("refuses to close a tab containing a pane owned by another conversation", async () => {
		const state = binding();
		state.terminals.push({ name: "shared", tabId: "w1:t2", paneId: "w1:p2", createdAt: "now" });
		let closed = false;
		const panes = [
			{
				pane_id: "w1:p2",
				tab_id: "w1:t2",
				workspace_id: "w1",
				tokens: { xcsh_owner: "owner-a" },
			},
			{
				pane_id: "w1:p3",
				tab_id: "w1:t2",
				workspace_id: "w1",
				tokens: { xcsh_owner: "owner-b" },
			},
		];
		const fake = await fakeHerdr(request => {
			if (request.method === "ping") return { type: "pong", protocol: 19, version: "test" };
			if (request.method.endsWith("report_metadata")) return { type: "ok" };
			if (request.method === "pane.get") return { type: "pane_info", pane: panes[0] };
			if (request.method === "pane.list") return { type: "pane_list", panes };
			if (request.method === "pane.process_info")
				return { type: "pane_process_info", process_info: { shell_pid: 10, foreground_processes: [] } };
			if (request.method === "tab.close") {
				closed = true;
				return { type: "ok" };
			}
			throw new Error(`unexpected ${request.method}`);
		});
		try {
			const controller = await HerdrController.connect({ socketPath: fake.socketPath, binding: state });
			await expect(controller.close("shared")).rejects.toMatchObject({ code: "not_owned" });
			expect(closed).toBe(false);
		} finally {
			await fake.close();
		}
	});
});

describe("Herdr launcher", () => {
	test("quotes the executable and every forwarded xcsh argument", () => {
		expect(shellQuote("a'b")).toBe(`'a'"'"'b'`);
		expect(buildXcshCommand("/opt/xcsh bin", ["--model", "openai/gpt 5", "it's safe"])).toBe(
			`'/opt/xcsh bin' '--model' 'openai/gpt 5' 'it'"'"'s safe'`,
		);
	});
});

describe("Herdr terminal connection lifecycle", () => {
	test("retries after a transient controller connection failure", async () => {
		let attempts = 0;
		const controller = createRetryingLazy(async () => {
			if (++attempts === 1) throw new Error("socket starting");
			return "connected";
		});
		await expect(controller()).rejects.toThrow("socket starting");
		expect(await controller()).toBe("connected");
		expect(attempts).toBe(2);
	});
});
