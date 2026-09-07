/** Minimal authenticated request checks. Reports no credentials or provider response bodies. */
import { completeSimple } from "@f5-sales-demo/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { discoverAuthStorage } from "../src/sdk";

const settings = await Settings.init();
const auth = await discoverAuthStorage();
const registry = new ModelRegistry(auth);
const results: { selector: string; outcome: string; reason?: string }[] = [];
try {
	for (const [provider, id] of [
		["google-vertex", "gemini-3.8-flash"],
		["anthropic", "claude-haiku-4-5"],
		["openai-codex", "gpt-5.6-luna"],
	]) {
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
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with exactly UAT_OK.", timestamp: Date.now() }] },
				{
					apiKey,
					maxTokens: 128,
					signal: AbortSignal.timeout(45000),
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
