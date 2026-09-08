/** Local source-runtime preload. Credentials stay in memory, not child-process environment or source files. */
import { localVertexCredentials } from "./local-vertex-credentials";
const credentials = await localVertexCredentials();
if (credentials) {
	Object.assign(globalThis, {
		PI_VERTEX_OAUTH_CLIENT_ID: credentials.clientId,
		PI_VERTEX_OAUTH_CLIENT_SECRET: credentials.clientSecret,
	});
}
