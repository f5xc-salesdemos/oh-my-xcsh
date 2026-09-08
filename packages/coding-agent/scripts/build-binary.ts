#!/usr/bin/env bun

import * as path from "node:path";
import { localVertexCredentials } from "../../../scripts/local-vertex-credentials";
import { vertexBuildDefines } from "../../../scripts/vertex-build-credentials";

const packageRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const credentials = await localVertexCredentials();
const vertexEnvironment = credentials
	? {
			XCSH_VERTEX_OAUTH_CLIENT_ID: credentials.clientId,
			XCSH_VERTEX_OAUTH_CLIENT_SECRET: credentials.clientSecret,
		}
	: Bun.env;
const result = await Bun.build({
	entrypoints: [path.join(packageRoot, "src", "cli.ts")],
	compile: { outfile: path.join(packageRoot, "dist", "xcsh") },
	root: repoRoot,
	external: ["mupdf"],
	define: {
		PI_COMPILED: "true",
		...vertexBuildDefines(vertexEnvironment),
	},
	throw: false,
});

if (!result.success) {
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}
