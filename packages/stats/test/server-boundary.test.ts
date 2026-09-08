import { describe, expect, it } from "bun:test";
import { Socket } from "node:net";
import * as os from "node:os";
import { startServer } from "../src/server";

async function tcpConnects(hostname: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = new Socket();
		const finish = (connected: boolean) => {
			socket.destroy();
			resolve(connected);
		};
		socket.setTimeout(750);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
		socket.connect({ host: hostname, port });
	});
}

describe("stats dashboard network boundary", () => {
	it("binds explicitly to IPv4 loopback without granting cross-origin reads", async () => {
		const server = await startServer(0);
		try {
			expect(server.hostname).toBe("127.0.0.1");
			const response = await fetch(`http://127.0.0.1:${server.port}/`);
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			expect(await tcpConnects("127.0.0.1", server.port)).toBe(true);
			expect(await tcpConnects("127.0.0.2", server.port)).toBe(false);

			const nonLoopback = Object.values(os.networkInterfaces())
				.flat()
				.find(address => address?.family === "IPv4" && !address.internal)?.address;
			if (nonLoopback) {
				expect(await tcpConnects(nonLoopback, server.port)).toBe(false);
			}
		} finally {
			server.stop();
		}
	});
});
