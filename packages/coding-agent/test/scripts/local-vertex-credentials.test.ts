import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVertexCredentials, readBundledVertexClient } from "../../../../scripts/local-vertex-credentials";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const pair = { clientId: "fixture-client", clientSecret: "fixture-secret" };
const bundle = `binary-prefix\0function resolveVertexOAuthClient() { const compiledClientId = "fixture-client".trim(); const compiledClientSecret = "fixture-secret".trim(); }`;

test("loads a named embedded pair without executing binary content", () => {
	expect(readBundledVertexClient(Buffer.from(bundle))).toEqual(pair);
	expect(readBundledVertexClient(Buffer.from('const compiledClientId = "unrelated".trim();'))).toBeUndefined();
});
test("persists recovered build inputs privately and reuses them without an installed binary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vertex-build-"));
	directories.push(dir);
	const binary = join(dir, "xcsh");
	const credentialFile = join(dir, "private", "vertex-build.json");
	await writeFile(binary, bundle);
	expect(await localVertexCredentials({ environment: {}, credentialFile, binaryPaths: [binary] })).toEqual(pair);
	expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(credentialFile, "utf8"))).toEqual(pair);
	await rm(binary);
	expect(await localVertexCredentials({ environment: {}, credentialFile, binaryPaths: [] })).toEqual(pair);
});
test("CI never reads workstation credentials and explicit injected inputs take precedence", async () => {
	expect(
		await localVertexCredentials({ environment: { CI: "true" }, credentialFile: "/must-not-read" }),
	).toBeUndefined();
	expect(
		await localVertexCredentials({
			environment: {
				CI: "true",
				XCSH_VERTEX_OAUTH_CLIENT_ID: pair.clientId,
				XCSH_VERTEX_OAUTH_CLIENT_SECRET: pair.clientSecret,
			},
			credentialFile: "/must-not-read",
		}),
	).toEqual(pair);
	await expect(
		localVertexCredentials({
			environment: { XCSH_VERTEX_OAUTH_CLIENT_ID: pair.clientId },
			credentialFile: "/must-not-read",
		}),
	).rejects.toThrow("partial pairs");
});

test("the dev preload makes the client pair available to source OAuth renewal without exporting it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vertex-preload-"));
	directories.push(dir);
	const credentialFile = join(dir, "vertex-build.json");
	await writeFile(credentialFile, JSON.stringify(pair), { mode: 0o600 });
	const root = join(import.meta.dir, "../../../..");
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			"./scripts/dev-vertex-credentials.ts",
			"-e",
			`
		import {refreshVertexWithAntigravityOAuth} from "./packages/ai/src/utils/oauth/google-antigravity";
		const result = await refreshVertexWithAntigravityOAuth("fixture-refresh", async (_url, options) => {
			const body = new URLSearchParams(options.body);
			if (body.get("client_id") !== "fixture-client" || body.get("client_secret") !== "fixture-secret") throw new Error("Wrong build inputs");
			return Response.json({access_token:"fixture-access",expires_in:3600});
		});
		if(result.access !== "fixture-access" || process.env.XCSH_VERTEX_OAUTH_CLIENT_SECRET) throw new Error("Invalid preload isolation");
		console.log("PRELOAD_OK");
	`,
		],
		{
			cwd: root,
			env: { PATH: process.env.PATH, XCSH_VERTEX_OAUTH_CREDENTIALS_FILE: credentialFile },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [status, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(status).toBe(0);
	expect(stdout.trim()).toBe("PRELOAD_OK");
});

test("parallel workstreams can initialize and read the same private credential file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vertex-parallel-"));
	directories.push(dir);
	const binary = join(dir, "xcsh");
	const credentialFile = join(dir, "shared", "vertex-build.json");
	await writeFile(binary, bundle);
	const results = await Promise.all(
		Array.from({ length: 12 }, () =>
			localVertexCredentials({ environment: {}, credentialFile, binaryPaths: [binary] }),
		),
	);
	expect(results).toEqual(Array.from({ length: 12 }, () => pair));
	expect(JSON.parse(await readFile(credentialFile, "utf8"))).toEqual(pair);
	expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
});
