import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { ensureEmbeddedAddon } = require("../native/embedded-extraction.js");

const temporaryDirectories: string[] = [];

function makeFixture(): { directory: string; sourcePath: string; targetPath: string; bytes: Buffer } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-native-extraction-"));
	temporaryDirectories.push(directory);
	const sourcePath = path.join(directory, "embedded.node");
	const targetPath = path.join(directory, "installed.node");
	const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
	fs.writeFileSync(sourcePath, bytes);
	return { directory, sourcePath, targetPath, bytes };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("embedded native extraction", () => {
	it("replaces a truncated extracted addon before returning it", () => {
		const { sourcePath, targetPath, bytes } = makeFixture();
		fs.writeFileSync(targetPath, bytes.subarray(0, 8192));
		const expectedMode = fs.statSync(targetPath).mode & 0o777;

		expect(ensureEmbeddedAddon({ sourcePath, targetPath })).toBe(targetPath);
		expect(Buffer.compare(fs.readFileSync(targetPath), bytes)).toBe(0);
		expect(fs.statSync(targetPath).mode & 0o777).toBe(expectedMode);
		expect(fs.readdirSync(path.dirname(targetPath)).filter(name => name.includes(".tmp-"))).toEqual([]);
	});

	it("leaves an existing complete addon untouched", () => {
		const { sourcePath, targetPath, bytes } = makeFixture();
		fs.writeFileSync(targetPath, bytes);
		const before = fs.statSync(targetPath);

		expect(ensureEmbeddedAddon({ sourcePath, targetPath })).toBe(targetPath);
		expect(fs.statSync(targetPath).ino).toBe(before.ino);
	});

	it("converges concurrent extractors on one complete final file", async () => {
		const { directory, sourcePath, targetPath, bytes } = makeFixture();
		const helperPath = path.join(import.meta.dir, "../native/embedded-extraction.js");
		const worker = [
			process.execPath,
			"-e",
			"const {ensureEmbeddedAddon}=require(process.argv[1]);ensureEmbeddedAddon({sourcePath:process.argv[2],targetPath:process.argv[3]});",
			helperPath,
			sourcePath,
			targetPath,
		];
		const processes = Array.from({ length: 8 }, () => Bun.spawn(worker, { stdout: "pipe", stderr: "pipe" }));

		expect(await Promise.all(processes.map(process => process.exited))).toEqual(Array(8).fill(0));
		expect(Buffer.compare(fs.readFileSync(targetPath), bytes)).toBe(0);
		expect(fs.readdirSync(directory).filter(name => name.includes(".tmp-"))).toEqual([]);
	});
});
