import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERTEX_CLIENT_ID_ENV, VERTEX_CLIENT_SECRET_ENV } from "./vertex-build-credentials";

export interface VertexClientCredentials {
	clientId: string;
	clientSecret: string;
}

/** Read only the named client pair from an xcsh bundle; never evaluate bundled code. */
export function readBundledVertexClient(binary: Uint8Array): VertexClientCredentials | undefined {
	const bytes = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
	const start = bytes.indexOf("function resolveVertexOAuthClient()");
	if (start < 0) return undefined;
	const source = bytes.subarray(start, start + 4096).toString("utf8");
	const literal = '"(?:[^"\\\\]|\\\\.)*"';
	const id = source.match(new RegExp(`const compiledClientId = (${literal})\\.trim\\(\\)`));
	const secret = source.match(new RegExp(`const compiledClientSecret = (${literal})\\.trim\\(\\)`));
	if (!id || !secret) return undefined;
	try {
		const clientId = (JSON.parse(id[1]) as string).trim();
		const clientSecret = (JSON.parse(secret[1]) as string).trim();
		return clientId && clientSecret ? { clientId, clientSecret } : undefined;
	} catch {
		return undefined;
	}
}

export async function localVertexCredentials(
	options: { environment?: Record<string, string | undefined>; credentialFile?: string; binaryPaths?: string[] } = {},
): Promise<VertexClientCredentials | undefined> {
	const environment = options.environment ?? process.env;
	const clientId = environment[VERTEX_CLIENT_ID_ENV]?.trim();
	const clientSecret = environment[VERTEX_CLIENT_SECRET_ENV]?.trim();
	if (clientId || clientSecret) {
		if (!clientId || !clientSecret)
			throw new Error(
				"Supply both licensed Vertex OAuth build inputs; partial pairs are not combined with local credentials.",
			);
		return { clientId, clientSecret };
	}
	// CI credentials come exclusively from its injected secrets, never workstation state.
	if (environment.CI) return undefined;
	const credentialFile =
		options.credentialFile ??
		environment.XCSH_VERTEX_OAUTH_CREDENTIALS_FILE ??
		join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), "xcsh", "vertex-build.json");
	try {
		const value = JSON.parse(await readFile(credentialFile, "utf8")) as VertexClientCredentials;
		if (
			typeof value.clientId === "string" &&
			value.clientId.trim() &&
			typeof value.clientSecret === "string" &&
			value.clientSecret.trim()
		) {
			return { clientId: value.clientId.trim(), clientSecret: value.clientSecret.trim() };
		}
		throw new Error("Invalid local Vertex build credential file; supply a complete client pair.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Cannot read local Vertex build credentials; check the private credential file.");
	}
	const binaryPaths =
		options.binaryPaths ??
		[Bun.which("xcsh"), join(homedir(), ".local", "bin", "xcsh")].filter((path): path is string => Boolean(path));
	for (const path of new Set(binaryPaths)) {
		let pair: VertexClientCredentials | undefined;
		try {
			pair = readBundledVertexClient(await readFile(path));
		} catch {
			continue;
		}
		if (!pair) continue;
		await mkdir(dirname(credentialFile), { recursive: true, mode: 0o700 });
		const temporary = await mkdtemp(join(dirname(credentialFile), ".vertex-build-"));
		try {
			const source = join(temporary, "credentials.json");
			await writeFile(source, JSON.stringify(pair), { mode: 0o600 });
			try {
				await link(source, credentialFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST")
					throw new Error("Cannot persist private local Vertex build credentials.");
				return await localVertexCredentials({ ...options, credentialFile, binaryPaths: [] });
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
		return pair;
	}
	return undefined;
}
