import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const COMPOSE = path.join(ROOT, "docker-compose.dev.yml");
const UAT_COMMON = path.join(ROOT, "scripts/uat-common.sh");
const UAT_SCRIPTS = [path.join(ROOT, "scripts/uat-gemini-auth.sh"), path.join(ROOT, "scripts/uat-gemini-prompts.sh")];

describe("Vertex development and UAT defaults", () => {
	it("defaults Compose and authenticated UAT to Gemini 3.8 Flash on global while preserving overrides", async () => {
		const dollar = "$";
		const compose = parse(await Bun.file(COMPOSE).text()) as {
			services: { "xcsh-dev": { environment: Record<string, string> } };
		};
		const environment = compose.services["xcsh-dev"].environment;
		expect(environment.GEMINI_MODEL).toBe(`${dollar}{GEMINI_MODEL:-gemini-3.8-flash}`);
		expect(environment.VERTEX_AI_LOCATION).toBe(`${dollar}{VERTEX_AI_LOCATION:-global}`);

		for (const scriptPath of UAT_SCRIPTS) {
			const script = await Bun.file(scriptPath).text();
			expect(script).toContain(`MODEL=${dollar}{GEMINI_MODEL:-gemini-3.8-flash}`);
			expect(script).toContain(`LOCATION=${dollar}{VERTEX_AI_LOCATION:-global}`);
		}
	});

	it("constructs the global host without a global- prefix and keeps regional endpoint support", async () => {
		const command = 'source "$1"; uat_vertex_endpoint "$2" "$3" "$4"';
		const global = Bun.spawnSync([
			"bash",
			"-c",
			command,
			"bash",
			UAT_COMMON,
			"gemini-3.8-flash",
			"project-a",
			"global",
		]);
		const regional = Bun.spawnSync([
			"bash",
			"-c",
			command,
			"bash",
			UAT_COMMON,
			"gemini-3.8-flash",
			"project-a",
			"northamerica-northeast1",
		]);

		expect(global.exitCode).toBe(0);
		expect(global.stdout.toString().trim()).toBe(
			"https://aiplatform.googleapis.com/v1/projects/project-a/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
		);
		expect(regional.exitCode).toBe(0);
		expect(regional.stdout.toString().trim()).toBe(
			"https://northamerica-northeast1-aiplatform.googleapis.com/v1/projects/project-a/locations/northamerica-northeast1/publishers/google/models/gemini-3.8-flash:generateContent",
		);
	});

	it("targets Gemini 3.8 Flash in the Vertex provider UAT without changing Antigravity routes", async () => {
		const source = await Bun.file(path.join(ROOT, "packages/coding-agent/scripts/eager-todo-provider-uat.ts")).text();
		const antigravity = await Bun.file(path.join(ROOT, "packages/coding-agent/bench/context.ts")).text();
		expect(source).toContain('model: "google-vertex/gemini-3.8-flash"');
		expect(source).not.toContain('model: "google-vertex/gemini-3.7-flash"');
		expect(antigravity).toContain('"google-antigravity/gemini-3.7-flash-tiered"');
	});
});
