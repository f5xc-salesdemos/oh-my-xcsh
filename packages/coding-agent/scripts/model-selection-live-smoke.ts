import "../../../scripts/dev-vertex-credentials";
/** Minimal authenticated request checks. Reports no credentials or provider response bodies. */
import { completeSimple, Effort } from "@f5-sales-demo/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { discoverAuthStorage } from "../src/sdk";

const settings = await Settings.init();
const auth = await discoverAuthStorage();
const registry = new ModelRegistry(auth);
const results: { selector: string; outcome: string; reason?: string }[] = [];
try {
	const targets = [
		["google-vertex", "gemini-3.8-flash"],
		["anthropic", "claude-haiku-4-5"],
		["openai-codex", "gpt-5.6-luna"],
	];
	for (const provider of ["ollama", "vllm"]) {
		await registry.refreshProvider(provider, "online");
		const model = registry.getAvailable().find(model => model.provider === provider);
		if (model) targets.push([provider, model.id]);
		else results.push({ selector: provider, outcome: "blocked", reason: "No local model discovered" });
	}
	for (const [provider, id] of targets) {
		const selector = `${provider}/${id}`;
		try {
			await registry.refreshProvider(provider, "online");
			const model = registry.find(provider, id);
			if (!model) {
				results.push({ selector, outcome: "blocked", reason: "Model absent from catalog" });
				continue;
			}
			const apiKey = await registry.getApiKey(model);
			if (!apiKey) {
				results.push({ selector, outcome: "blocked", reason: "Authentication unavailable" });
				continue;
			}
			const local = provider === "ollama" || provider === "vllm";
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with exactly UAT_OK.", timestamp: Date.now() }] },
				{
					apiKey,
					maxTokens: local ? 1024 : 128,
					...(local ? { reasoning: Effort.Low } : {}),
					signal: AbortSignal.timeout(local ? 120000 : 45000),
					...(provider === "google-vertex"
						? { project: settings.get("providers.vertexProject"), location: "global" }
						: {}),
				},
			);
			const passed =
				response.stopReason === "stop" &&
				response.content.some(block => block.type === "text" && block.text.includes("UAT_OK"));
			results.push({
				selector,
				outcome: passed ? "passed" : "blocked",
				reason: passed ? undefined : `Provider returned ${response.stopReason}`,
			});
		} catch {
			results.push({ selector, outcome: "blocked", reason: "Live request unavailable" });
		}
	}
} finally {
	auth.close();
}
console.log(JSON.stringify(results, null, 2));
