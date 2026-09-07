/** Herdr rendered-state acceptance. Run only against a dedicated, idle shell pane.
 * bun packages/coding-agent/scripts/model-selection-uat.ts --target dev --pane <returned-id> --report /tmp/uat.json
 * Targets: installed, dev, compiled. --live uses the existing profile for read-only navigation.
 */

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createThinkingConfig, Effort, getBundledProviders } from "@f5-sales-demo/pi-ai";
import { CURRENT_CONFIG_VERSION } from "../src/config/auto-config";

if (process.env.HERDR_ENV !== "1") throw new Error("Run inside Herdr");
const { values } = parseArgs({
	options: {
		target: { type: "string", default: "dev" },
		pane: { type: "string" },
		report: { type: "string" },
		live: { type: "boolean", default: false },
	},
});
if (!values.pane || !values.report) throw new Error("--pane (dedicated idle shell) and --report are required");
const pane = values.pane;
const root = resolve(import.meta.dir, "../../..");
const launches: Record<string, string> = {
	installed: "xcsh",
	dev: "bun run dev",
	compiled: "packages/coding-agent/dist/xcsh",
};
const launch = launches[values.target!];
if (!launch) throw new Error("Unknown target");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const receipts: { provider: string; model: string; turns: number; reasoning?: string }[] = [];
const snapshots: { step: string; text: string }[] = [];
const profile = await mkdtemp(join(tmpdir(), "xcsh-model-uat-"));
const models = ["uat-cloud-a", "uat-cloud-b", "ollama"];
let fail = false;
let empty = false;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const provider = url.pathname.split("/")[1];
		if (url.pathname.endsWith("/models"))
			return fail
				? new Response("Controlled outage", { status: 503 })
				: Response.json({ data: empty ? [] : [{ id: "uat-model" }] });
		if (url.pathname.endsWith("/chat/completions")) {
			const body = (await request.json()) as {
				model: string;
				messages: { role: string }[];
				reasoning_effort?: string;
			};
			receipts.push({
				provider,
				model: body.model,
				turns: body.messages.filter(message => message.role === "user").length,
				reasoning: body.reasoning_effort,
			});
			const chunk = {
				id: "uat",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { role: "assistant", content: "UAT_OK" }, finish_reason: null }],
			};
			return new Response(
				`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		return new Response("Not found", { status: 404 });
	},
});
await mkdir(join(profile, "agent"));
const agentDir = join(profile, "agent");
await Bun.write(
	join(agentDir, "models.yml"),
	Bun.YAML.stringify({
		version: CURRENT_CONFIG_VERSION,
		providers: Object.fromEntries(
			models.map(provider => [
				provider,
				{
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${server.port}/${provider}/v1`,
					auth: "none",
					discovery: { type: "openai-compat" },
					compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
					models: [
						{
							id: "uat-model",
							contextWindow: 32000,
							maxTokens: 1024,
							reasoning: true,
							thinking: createThinkingConfig([Effort.Low, Effort.Medium, Effort.High]),
						},
					],
				},
			]),
		),
	}),
);
await Bun.write(
	join(agentDir, "config.yml"),
	Bun.YAML.stringify({
		modelRoles: {
			default: "uat-cloud-a/uat-model",
			smol: "uat-cloud-b/uat-model",
			plan: "uat-cloud-b/uat-model",
			"custom-review": "uat-cloud-b/uat-model",
		},
		disabledProviders: [...getBundledProviders(), "llama.cpp", "lm-studio"].filter(
			provider => !models.includes(provider),
		),
		routing: { mode: "auto" },
		compaction: { enabled: false },
		checkForUpdates: false,
	}),
);
async function herdr(...args: string[]): Promise<string> {
	const child = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(`herdr ${args[0]} ${args[1]}: ${stderr}`);
	return stdout;
}
const keys = (...input: string[]) => herdr("pane", "send-keys", pane, ...input);
async function rendered() {
	return Bun.stripANSI(await herdr("pane", "read", pane, "--source", "visible"));
}
async function wait(step: string, predicate: (text: string) => boolean, timeout = 20000) {
	const until = Date.now() + timeout;
	let text = "";
	do {
		text = await rendered();
		if (predicate(text)) {
			snapshots.push({ step, text: sanitize(text) });
			return text;
		}
		await Bun.sleep(150);
	} while (Date.now() < until);
	snapshots.push({ step, text: sanitize(text) });
	throw new Error(`Rendered assertion failed: ${step}`);
}
function sanitize(text: string) {
	return text
		.replace(/(?:sk-|ghp_|gho_)[\w-]+/g, "[REDACTED]")
		.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[EMAIL]");
}
async function command(text: string) {
	await herdr("pane", "send-text", pane, text);
	await Bun.sleep(150);
	await keys("Enter");
}
async function openPicker() {
	await command("/model");
	await wait("open picker", text => text.includes("Models:") && text.includes("Ctrl+R:"));
}
let outcome = "failed";
let error: string | undefined;
try {
	const environment = values.live
		? ""
		: `env -i PATH=${quote([...new Set([resolve(Bun.which("bun")!, ".."), resolve(Bun.which("xcsh")!, ".."), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"))} HOME=${quote(process.env.HOME!)} TERM=xterm-256color HERDR_ENV=1 PI_CODING_AGENT_DIR=${quote(agentDir)} `;
	const launchCommand = `cd ${quote(root)} && ${environment}${launch} --no-mcp --no-lsp --no-extensions --no-skills --no-memories --no-title`;
	await herdr("pane", "run", pane, launchCommand + (values.live ? " --no-session" : " --model uat-cloud-a/uat-model"));
	await Bun.sleep(1500);
	await wait("ready", text => text.includes("xcsh v") && text.includes("idle"), 45000);
	await Bun.sleep(2500);
	await openPicker();
	const providerTabs = (await rendered()).split("\n").find(line => line.startsWith("Models:"));
	if (!providerTabs) throw new Error("Provider navigation missing");
	async function assertHealthyPicker(step: string) {
		const text = await wait(step, text => text.includes(providerTabs!) && !text.includes("Refreshing "));
		if (
			/Unable to connect|Provider unavailable|authentication required|availability unverified|Ctrl\+R: retry/i.test(
				text,
			)
		) {
			throw new Error(`Unresolved provider state at ${step}; inspect the captured screen`);
		}
		if (!values.live && /llama\.cpp:|LM Studio:/.test(text)) {
			throw new Error(`Unconfigured local runtime advertised at ${step}`);
		}
	}
	await assertHealthyPicker("initial provider health");
	for (let i = 0; i < 9; i++) {
		await keys("Tab");
		await Bun.sleep(200);
		await wait(`cycle ${i}`, text => text.includes("Models:") && text.includes(providerTabs!));
		await assertHealthyPicker(`provider health ${i}`);
	}
	await keys("Shift+Tab");
	if (!values.live) {
		const split = JSON.parse(
			await herdr("pane", "split", pane, "--direction", "right", "--ratio", "0.33", "--cwd", root, "--no-focus"),
		);
		const sibling = split.result.pane.pane_id as string;
		try {
			await wait("narrow navigation", text => text.includes("Ctrl+R:") && text.includes("Enter: choose"));
		} finally {
			await herdr("pane", "close", sibling);
		}
		for (const provider of ["uat-cloud-a", "uat-cloud-b", "ollama", "uat-cloud-a"]) {
			await herdr("pane", "send-text", pane, `${provider}/uat-model`);
			await wait(`search ${provider}`, text => text.includes(`[${provider}/uat-model]`));
			await keys("Enter");
			await wait(
				"scope",
				text =>
					text.includes("Use in this conversation") &&
					text.includes("Save as default") &&
					text.includes("Assign to role"),
			);
			await keys("Enter");
			await wait("reasoning", text => text.includes("Thinking for:") && text.includes("low —"));
			for (let attempt = 0; attempt < 8; attempt++) {
				const text = await rendered();
				if (text.split("\n").some(line => line.includes("low —") && !line.trimStart().startsWith("low —"))) break;
				await keys("Down");
				await Bun.sleep(50);
			}
			await wait("selected reasoning", text =>
				text.split("\n").some(line => line.includes("low —") && !line.trimStart().startsWith("low —")),
			);
			await keys("Enter");
			await wait("applied", text => text.includes(`This conversation: ${provider}/uat-model`));
			const before = receipts.length;
			await command("Say UAT_OK.");
			await wait(`response ${provider}`, text => text.includes("UAT_OK") && receipts.length > before);
			if (receipts.at(-1)?.provider !== provider) throw new Error("Request routed to the wrong provider");
			if (receipts.at(-1)?.reasoning !== "low") throw new Error("Request lost the selected reasoning level");
			await openPicker();
		}
		// Independently assign fast, thorough and plan roles through the UI.
		for (const [role, index] of [
			["smol", 1],
			["slow", 2],
			["plan", 4],
			["custom-review", 8],
		] as const) {
			await herdr("pane", "send-text", pane, "uat-cloud-b/uat-model");
			await keys("Enter");
			await wait("role scope", text => text.includes("Assign to role"));
			await keys("Down", "Down", "Enter");
			await wait("role list", text => text.includes("Set as SMOL"));
			for (let i = 0; i < index; i++) await keys("Down");
			await keys("Enter");
			await wait("role reasoning", text => text.includes("Thinking for:"));
			await keys("Enter");
			await wait(
				`saved ${role}`,
				text => !text.includes("Thinking for:") && text.includes("Active: uat-cloud-a/uat-model"),
			);
			const roles = (
				Bun.YAML.parse(await Bun.file(join(agentDir, "config.yml")).text()) as {
					modelRoles: Record<string, string>;
				}
			).modelRoles;
			if (roles[role] !== "uat-cloud-b/uat-model") throw new Error(`Role ${role} was not saved`);
			await keys("Escape");
			await openPicker();
		}
		await keys("Escape");
		await command("/plan");
		await wait("plan enabled", text => text.includes("Plan mode enabled"));
		const beforePlan = receipts.length;
		await command("Say UAT_OK in planning mode.");
		await wait("plan response", text => text.includes("UAT_OK") && receipts.length > beforePlan);
		if (receipts.at(-1)?.provider !== "uat-cloud-b") throw new Error("Plan request used the wrong provider");
		await command("/plan");
		await wait("plan exit confirmation", text => text.includes("Exit plan mode?"));
		await keys("Enter");
		await wait("plan restored", text => text.includes("Plan mode disabled") || text.includes("Plan mode paused"));
		const beforeRestore = receipts.length;
		await command("Say UAT_OK after planning.");
		await wait("restored response", text => text.includes("UAT_OK") && receipts.length > beforeRestore);
		if (receipts.at(-1)?.provider !== "uat-cloud-a")
			throw new Error("Plan exit did not restore conversation provider");
		await openPicker();
		// Cancellation and reopening must leave saved default unchanged.
		await keys("Enter");
		await keys("Escape");
		await keys("Escape");
		await openPicker();
		fail = true;
		await keys("ctrl+r");
		await wait("outage", text => text.includes("Ctrl+R: retry") || text.includes("Cached model list"));
		fail = false;
		empty = true;
		await keys("ctrl+r");
		await wait("empty", text => text.includes("empty catalog"));
		empty = false;
		await keys("ctrl+r");
		await wait("recovery", text => text.includes("uat-model") && !text.includes("empty catalog"));
		const persisted = Bun.YAML.parse(await Bun.file(join(agentDir, "config.yml")).text()) as {
			modelRoles: { default: string };
		};
		if (persisted.modelRoles.default !== "uat-cloud-a/uat-model")
			throw new Error("Conversation selection changed the default");
		// Resume a conversation choice which differs from the saved default.
		await herdr("pane", "send-text", pane, "uat-cloud-b/uat-model");
		await keys("Enter");
		await wait("resume scope", text => text.includes("Use in this conversation"));
		await keys("Enter");
		await wait("resume reasoning", text => text.includes("Thinking for:"));
		await keys("Enter");
		await wait("resume selection", text => text.includes("This conversation: uat-cloud-b/uat-model"));
		await keys("ctrl+c", "ctrl+c");
		await Bun.sleep(500);
		await herdr("pane", "run", pane, `${launchCommand} --continue`);
		await Bun.sleep(4000);
		await wait("resumed", text => text.includes("idle"));
		const beforeResume = receipts.length;
		const previousTurns = receipts.at(-1)!.turns;
		await command("Say UAT_OK after resume.");
		await wait("resumed response", text => text.includes("UAT_OK") && receipts.length > beforeResume);
		if (receipts.at(-1)?.provider !== "uat-cloud-b" || receipts.at(-1)!.turns <= previousTurns)
			throw new Error("Resume lost conversation selection or history");
		await openPicker();
		await herdr("pane", "send-text", pane, "uat-cloud-b/uat-model");
		await keys("Enter");
		await wait("default scope", text => text.includes("Save as default"));
		await keys("Down", "Enter");
		await wait("default reasoning", text => text.includes("Thinking for:"));
		await keys("Enter");
		await wait("default saved", text => text.includes("Saved default: uat-cloud-b/uat-model"));
		const afterDefault = Bun.YAML.parse(await Bun.file(join(agentDir, "config.yml")).text()) as {
			modelRoles: { default: string };
		};
		if (afterDefault.modelRoles.default !== "uat-cloud-b/uat-model") throw new Error("Default not persisted");
		await openPicker();
		await herdr("pane", "send-text", pane, "uat-cloud-a/uat-model");
		await keys("Enter");
		await wait("failure scope", text => text.includes("Save as default"));
		await keys("Down", "Enter");
		await wait("failure reasoning", text => text.includes("Thinking for:"));
		const configPath = join(agentDir, "config.yml");
		await rename(configPath, `${configPath}.backup`);
		await mkdir(configPath);
		try {
			await keys("Enter");
			await wait(
				"persistence failure",
				text =>
					(text.includes("EISDIR") || text.includes("directory")) &&
					text.includes("Active: uat-cloud-b/uat-model"),
			);
		} finally {
			await rm(configPath, { recursive: true });
			await rename(`${configPath}.backup`, configPath);
		}
	}
	await keys("Escape");
	outcome = "passed";
} catch (cause) {
	error = String(cause);
} finally {
	server.stop(true);
	await Bun.write(
		values.report,
		JSON.stringify(
			{
				target: values.target,
				pane,
				cwd: root,
				live: values.live,
				profile: values.live ? undefined : profile,
				outcome,
				error,
				receipts,
				snapshots,
			},
			null,
			2,
		),
	);
}
console.log(JSON.stringify({ target: values.target, pane, outcome, error, report: values.report }));
if (outcome !== "passed") process.exitCode = 1;
