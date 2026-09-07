import type { AssistantMessage, TextContent } from "@f5-sales-demo/pi-ai";

/** Missing phase intentionally follows Codex's final-answer fallback. */
export function isFinalAnswerContent(content: TextContent): boolean {
	return content.phase !== "commentary";
}

/** Select only terminal answer text; commentary remains available on the message transcript. */
export function finalAnswerText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text" && isFinalAnswerContent(content))
		.map(content => content.text)
		.filter(Boolean)
		.join("\n");
}
