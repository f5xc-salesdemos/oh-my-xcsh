import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "@f5-sales-demo/pi-natives";
import {
	getAgentDir,
	getConfigRootDir,
	getMemoriesDir,
	getPluginsDir,
	setAgentDir,
	TempDir,
} from "@f5-sales-demo/pi-utils";
import { discoverAndLoadExtensions } from "../src/extensibility/extensions/loader";
import { getMemoryRoot } from "../src/memories";
import { buildContainmentFence, containmentStatus } from "../src/sandbox/containment";
import { evaluateToolCall } from "../src/sandbox/enforce";
import { resolveSessionFence } from "../src/sandbox/session-fence";

let tmp: TempDir;
let home: string;
let parent: string;
let custA: string;
let custB: string;
let originalAgentDir: string;
let originalAgentDirOverride: string | undefined;

beforeAll(() => {
	tmp = TempDir.createSync("xcsh-sbx-iso-");
	// The customers live in a container *inside* home, which is the layout the fleet uses
	// (`~/MEDDPICC/<customer>`). They used to sit directly in `home`, and #2637 deliberately leaves that
	// case open — the siblings are in home, so nothing can read all of home and refuse them. Keeping the
	// old shape here would have asserted a protection that no longer exists.
	home = path.join(tmp.absolute(), "home");
	parent = path.join(home, "customers");
	custA = path.join(parent, "custA");
	custB = path.join(parent, "custB");
	fs.mkdirSync(custA, { recursive: true });
	fs.mkdirSync(custB, { recursive: true });
	fs.writeFileSync(path.join(custA, "notes.md"), "a");
	fs.writeFileSync(path.join(custB, "secret.env"), "TOKEN=b");
	originalAgentDir = getAgentDir();
	originalAgentDirOverride = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(path.join(home, ".xcsh", "agent"));
	fs.mkdirSync(getMemoriesDir(), { recursive: true });
});

afterAll(() => {
	setAgentDir(originalAgentDir);
	if (originalAgentDirOverride === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirOverride;
	tmp.removeSync();
});

/** Whether the `read` tool would be refused — the same fence the shell is confined by (#2624). */
function reads(cwd: string, filePath: string): boolean {
	const fence = resolveSessionFence(cwd, { get: () => undefined })!;
	return evaluateToolCall({ toolName: "read", input: { file_path: filePath }, cwd, fence }).block;
}

/** Whether the `write` tool would be refused. */
function writes(cwd: string, filePath: string): boolean {
	const fence = resolveSessionFence(cwd, { get: () => undefined })!;
	return evaluateToolCall({ toolName: "write", input: { file_path: filePath }, cwd, fence }).block;
}

describe("two-customer isolation", () => {
	it("a session in custA cannot enumerate the parent but can use a named custB path", () => {
		expect(reads(custA, parent)).toBe(true);
		expect(reads(custA, path.join(custB, "secret.env"))).toBe(false);
		expect(reads(custA, path.join(custA, "notes.md"))).toBe(false);
	});

	it("a parent-folder session sees both customer subfolders (automatic)", () => {
		expect(reads(parent, path.join(custA, "notes.md"))).toBe(false);
		expect(reads(parent, path.join(custB, "secret.env"))).toBe(false);
	});

	it("keeps Bash named access under the operator's authority", () => {
		const fence = resolveSessionFence(custA, { get: () => undefined })!;
		const scan = (command: string) => evaluateToolCall({ toolName: "bash", input: { command }, cwd: custA, fence });

		for (const command of ["cat ../custB/secret.env", `cat ${path.join(custB, "secret.env")}`]) {
			expect(scan(command).block).toBe(false);
		}
		expect(scan("cat notes.md").block).toBe(false);
	});

	it("blocks structured recursive discovery from the shared parent", () => {
		const fence = resolveSessionFence(custA, { get: () => undefined })!;
		for (const toolName of ["find", "grep", "ast_grep", "ast_edit"]) {
			const input = toolName === "find" ? { pattern: `${parent}/**/*` } : { path: parent };
			expect(evaluateToolCall({ toolName, input, cwd: custA, fence }).block).toBe(true);
		}
	});
});

describe("functionality preservation under the sandbox", () => {
	it("keeps operator-owned plugins writable (e.g. the meddpicc engine)", () => {
		const plugin = path.join(getPluginsDir(), "cache", "plugins", "meddpicc", "engine", "cli.ts");
		expect(reads(custA, plugin)).toBe(false);
		expect(writes(custA, plugin)).toBe(false);
	});

	it("keeps user-level skills and settings writable", () => {
		for (const own of [
			path.join(getAgentDir(), "skills", "account-planning", "SKILL.md"),
			path.join(getConfigRootDir(), "settings.json"),
		]) {
			expect(reads(custA, own)).toBe(false);
			expect(writes(custA, own)).toBe(false);
		}
	});

	// #2637: the operator's own dotfiles are theirs. What stays blocked is another customer's folder and
	// another session's state, asserted above and below.
	it("keeps the operator's own home and configuration writable", () => {
		for (const own of [".gitconfig", ".aws/config", ".zshrc", ".zprofile", ".ssh/config"]) {
			const target = path.join(os.homedir(), own);
			expect(reads(custA, target)).toBe(false);
			expect(writes(custA, target)).toBe(false);
		}
	});
});

describe("memory isolation (belt-and-suspenders)", () => {
	it("partitions the memory store per working directory", () => {
		expect(getMemoryRoot(getAgentDir(), custA)).not.toBe(getMemoryRoot(getAgentDir(), custB));
	});

	it("hides the memory-store listing while preserving named operator access", () => {
		expect(reads(custA, getMemoriesDir())).toBe(true);
		expect(reads(custA, path.join(getMemoryRoot(getAgentDir(), custB), "MEMORY.md"))).toBe(false);
		expect(reads(custA, path.join(getMemoryRoot(getAgentDir(), custA), "MEMORY.md"))).toBe(false);
	});
});

describe("bundled registration", () => {
	it("loads the sandbox-guard extension by default", async () => {
		const result = await discoverAndLoadExtensions([], custA);
		expect(result.extensions.some(ext => ext.path === "bundled:sandbox-guard")).toBe(true);
	});
});

/**
 * The same two-customer scenario, proved at the enforcement layer rather than at the text scan.
 *
 * The cases above ask `evaluateToolCall` whether it would refuse a command. These run the command.
 * That distinction is the whole of #2554: the scanner reads what was written, while containment is
 * consulted where the shell acts, after expansion and symlink resolution. A scenario that only ever
 * asked the scanner would have passed throughout every escape in #2542 and #2553.
 */
describe("two-customer isolation, enforced in the shell", () => {
	function productFenceFor(cwd: string, extraRoots: readonly string[] = []) {
		return buildContainmentFence({ workspace: cwd, home, extraRoots });
	}

	function fenceFor(cwd: string, extraRoots: readonly string[] = []) {
		const fence = productFenceFor(cwd, extraRoots);
		return {
			allow: [...fence.allow],
			allowReadOnly: [...fence.allowReadOnly],
			allowWriteOnly: [...fence.allowWriteOnly],
			deny: [...fence.deny],
			denyOnSeatbelt: [...fence.denyOnSeatbelt],
			denyEnumerate: [...fence.denyEnumerate],
		};
	}

	async function shell(cwd: string, command: string, fenced = true, extraRoots: readonly string[] = []) {
		let out = "";
		const result = (await executeShell(
			{ command, cwd, fence: fenced ? fenceFor(cwd, extraRoots) : undefined },
			(_e, c) => {
				out += c ?? "";
			},
		)) as { exitCode?: number; output?: string };
		return { code: result?.exitCode ?? -1, text: out + (result?.output ?? "") };
	}

	/**
	 * Brush expands globs in the agent process, before an OS sandbox can help. The enumeration check must
	 * therefore happen before `read_dir`, on every platform.
	 */
	it("a parent glob does not reveal sibling names", async () => {
		const { text } = await shell(custA, "printf '%s\\n' ../*");
		expect(text).not.toContain("custB");
	});

	it("preserves named sibling reads and writes, including after traversal", async () => {
		for (const command of ["cat ../custB/secret.env", `cat ${path.join(custB, "secret.env")}`]) {
			const { code, text } = await shell(custA, command);
			expect(code).toBe(0);
			expect(text).toContain("TOKEN=b");
		}
		// Brush evaluates `cd` in-process. The exact parent-enumeration deny must not turn that discovery
		// boundary into a restriction on a named sibling path.
		const moved = await shell(custA, "cd ../custB && cat secret.env");
		expect(moved.code).toBe(0);
		expect(moved.text).toContain("TOKEN=b");
		await shell(custA, `printf x > ${path.join(custB, "planted.env")}`);
		expect(fs.readFileSync(path.join(custB, "planted.env"), "utf8")).toBe("x");
		await shell(custA, `cp ${path.join(custB, "secret.env")} .`);
		expect(fs.existsSync(path.join(custA, "secret.env"))).toBe(true);
	});

	it("preserves a named sibling path assembled only after the shell starts", async () => {
		const command = `p=${JSON.stringify(path.dirname(custB))}; n=custB; cat "$p/$n/secret.env"`;
		const { code, text } = await shell(custA, command);
		expect(code).toBe(0);
		expect(text).toContain("TOKEN=b");
	});

	it("keeps an explicitly trusted sibling readable and writable through Seatbelt", async () => {
		const read = await shell(custA, `cat ${path.join(custB, "secret.env")}`, true, [custB]);
		expect(read.code).toBe(0);
		expect(read.text).toContain("TOKEN=b");

		const trustedOutput = path.join(custB, "trusted-output.txt");
		const write = await shell(custA, `printf trusted > ${trustedOutput}`, true, [custB]);
		expect(write.code).toBe(0);
		expect(fs.readFileSync(trustedOutput, "utf8")).toBe("trusted");
	});

	it("allows operator-owned configuration writes through the OS fence", async () => {
		const targets = [
			path.join(home, ".gitconfig"),
			path.join(home, ".aws", "config"),
			path.join(home, ".zshrc"),
			path.join(home, ".ssh", "config"),
			path.join(home, ".xcsh", "plugins", "example", "plugin.json"),
		];
		for (const target of targets) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const result = await shell(custA, `printf operator > ${JSON.stringify(target)}`);
			expect(result.code).toBe(0);
			expect(fs.readFileSync(target, "utf8")).toBe("operator");
		}
	});

	it("reports a spawned parent listing according to the actual fence backend", async () => {
		const osEnforced = containmentStatus(true, process.platform, undefined, productFenceFor(custA)).osEnforced;
		const { text } = await shell(custA, "ls ..");
		if (osEnforced) expect(text).not.toContain("custB");
		else expect(text).toContain("custB");
	});

	it("but works normally inside its own folder", async () => {
		const own = await shell(custA, "cat notes.md && printf ' ok' >> notes.md && cat notes.md");
		expect(own.code).toBe(0);
		expect(own.text).toContain("a");
	});

	it("and the same session unfenced reaches custB — the control", async () => {
		const { code, text } = await shell(custA, `cat ${path.join(custB, "secret.env")}`, false);
		expect(code).toBe(0);
		expect(text).toContain("TOKEN=b");
	});
});

describe("local account discovery isolation, enforced in the shell", () => {
	it("aligns account enumeration with the actual fence backend and preserves named access", async () => {
		const fsRoot = path.join(tmp.absolute(), "account-fixture");
		const accountRoot = path.join(fsRoot, "Users");
		const operatorHome = path.join(accountRoot, "operator");
		const otherHome = path.join(accountRoot, "other-account");
		const workspace = path.join(operatorHome, "workspace");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(otherHome, { recursive: true });
		fs.writeFileSync(path.join(otherHome, "synthetic.txt"), "synthetic");

		const fence = buildContainmentFence({ workspace, home: operatorHome, fsRoot });
		const wire = {
			allow: [...fence.allow],
			allowReadOnly: [...fence.allowReadOnly],
			allowWriteOnly: [...fence.allowWriteOnly],
			deny: [...fence.deny],
			denyOnSeatbelt: [...fence.denyOnSeatbelt],
			denyEnumerate: [...fence.denyEnumerate],
		};
		const run = async (command: string) => {
			const result = (await executeShell({ command, cwd: workspace, fence: wire }, () => {})) as {
				exitCode?: number;
			};
			return result.exitCode ?? -1;
		};

		expect(await run(`printf operator > ${JSON.stringify(path.join(operatorHome, ".zshrc"))}`)).toBe(0);
		expect(fs.readFileSync(path.join(operatorHome, ".zshrc"), "utf8")).toBe("operator");
		const osEnforced = containmentStatus(true, process.platform, undefined, fence).osEnforced;
		const accountListing = await run(`ls ${JSON.stringify(accountRoot)} > /dev/null`);
		expect(accountListing === 0).toBe(!osEnforced);
		expect(await run(`cd ${JSON.stringify(otherHome)}`)).toBe(0);
		expect(await run(`cat ${JSON.stringify(path.join(otherHome, "synthetic.txt"))} > /dev/null`)).toBe(0);
	});
});
