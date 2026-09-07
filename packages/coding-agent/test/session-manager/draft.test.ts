import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@f5-sales-demo/pi-utils";
import { SessionManager } from "../../src/session/session-manager";

describe("SessionManager draft persistence", () => {
	let tempDir: TempDir;
	let manager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("xcsh-draft-");
		manager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		await manager.close();
		await tempDir.remove();
	});

	it("restores a persisted draft once", async () => {
		await manager.saveDraft("unfinished prompt");
		const draftPath = path.join(manager.getArtifactsDir()!, "draft.txt");
		const sessionPath = manager.getSessionFile()!;
		expect(await Bun.file(draftPath).text()).toBe("unfinished prompt");
		await manager.close();
		manager = await SessionManager.open(sessionPath);
		expect(await manager.consumeDraft()).toBe("unfinished prompt");
		expect(await manager.consumeDraft()).toBeNull();
		await manager.close();
		expect(await Bun.file(sessionPath).exists()).toBe(false);
	});

	it("removes a stale draft when the current editor is empty", async () => {
		await manager.saveDraft("stale");
		const draftPath = path.join(manager.getArtifactsDir()!, "draft.txt");
		await manager.saveDraft("");
		expect(await Bun.file(draftPath).exists()).toBe(false);
	});
});
