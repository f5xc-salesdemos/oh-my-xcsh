import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getPluginsDir } from "@f5-sales-demo/pi-utils";
import {
	buildContainmentFence,
	containmentStatus,
	fenceVerdict,
	seatbeltFenceVerdict,
} from "../src/sandbox/containment";

/**
 * The fence is deliberately *gentle*: the only thing it prevents is the assistant wandering the
 * filesystem. Operations are not restricted, so `/usr`, `/tmp`, package caches, the network and
 * process execution are never mentioned. Anything that breaks ordinary work is a bug in the fence,
 * not a stricter policy — see #2554.
 */

/**
 * Fixture directories, removed after the file runs (#2633).
 *
 * These leaked for a long time: 2,714 `fence-*` directories were sitting in the OS temp dir, from 52 call
 * sites here with no cleanup. That is not merely untidy — it is what made `readdirSync(os.tmpdir())`
 * expensive enough (15.4ms) to cause a real latency regression in #2624, and it buries anyone reading that
 * directory to debug a temp-path problem.
 *
 * The `xcsh-` prefix is deliberate. The previous prefixes were generic — `fence-`, `sf-`, `conf-` — and a
 * bulk cleanup of `sf-*` would also match the Salesforce CLI's own `sf-telemetry` directory. Fixtures
 * should be identifiable as ours from the name alone, so removing them can never take somebody else's
 * state with them.
 *
 * Cleanup lives in `afterAll`, not at the end of each test: a `rmSync` in the body is skipped when an
 * assertion throws, which is exactly when the file is being re-run repeatedly and littering fastest.
 */
const fixtures: string[] = [];

afterAll(() => {
	for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
	fixtures.length = 0;
});

function realTmp(suffix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `xcsh-fence-${suffix}-`)));
	fixtures.push(dir);
	return dir;
}

describe("buildContainmentFence", () => {
	it("denies parent enumeration while preserving named sibling access on Seatbelt", () => {
		const home = realTmp("home");
		const workspace = path.join(home, "GIT", "custA");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		// Home and the shared container remain usable by name (#2637). Only the scanning step is refused.
		expect(fence.deny).not.toContain(home);
		expect(fence.deny).not.toContain(path.join(home, "GIT"));
		expect(fence.denyEnumerate).toContain(path.join(home, "GIT"));
		expect(fence.denyOnSeatbelt).not.toContain(path.join(home, "GIT"));
		expect(fence.allow).toContain(workspace);
		expect(fenceVerdict(fence, path.join(home, "GIT"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(home, "GIT", "custB", "secret"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(home, "GIT", "custB", "secret"), "write")).toBe("allow");
		expect(seatbeltFenceVerdict(fence, path.join(home, "GIT", "custB", "secret"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "read")).toBe("allow");
		expect(seatbeltFenceVerdict(fence, path.join(workspace, "notes.md"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "write")).toBe("allow");
		expect(fenceVerdict(fence, workspace, "enumerate")).toBe("allow");
	});

	it("keeps explicit trusted roots without synthesizing a recursive Seatbelt deny", () => {
		const home = realTmp("seatbelt-trusted-grant");
		const parent = path.join(home, "customers");
		const workspace = path.join(parent, "example-a");
		const trusted = path.join(parent, "shared-handoff");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(trusted, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, extraRoots: [trusted] });

		expect(fence.denyOnSeatbelt).not.toContain(parent);
		expect(fence.allow).toContain(workspace);
		expect(fence.allow).toContain(trusted);
		expect(seatbeltFenceVerdict(fence, path.join(trusted, "handoff.txt"), "read")).toBe("allow");
		expect(seatbeltFenceVerdict(fence, path.join(parent, "example-b", "secret.txt"), "read")).toBe("allow");
	});

	it("retains the low-level recursive Seatbelt deny for specialized fences", () => {
		const home = realTmp("explicit-seatbelt");
		const parent = path.join(home, "customers");
		const workspace = path.join(parent, "example-a");
		fs.mkdirSync(workspace, { recursive: true });

		const fence = buildContainmentFence({ workspace, home });
		const specialized = { ...fence, denyOnSeatbelt: [parent] };

		expect(seatbeltFenceVerdict(specialized, path.join(parent, "example-b", "secret.txt"), "read")).toBe("deny");
		expect(seatbeltFenceVerdict(specialized, path.join(workspace, "notes.md"), "read")).toBe("allow");
	});

	it("leaves everything outside home alone — nothing operational is restricted", () => {
		const home = realTmp("home2");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		for (const p of ["/usr/bin/env", "/bin/sh", "/etc/hosts", "/opt/homebrew/bin/bun", "/dev/null"]) {
			expect(fenceVerdict(fence, p, "read")).toBe("allow");
		}
		// The OS temp dir is not customer data and must stay usable for both directions.
		expect(fenceVerdict(fence, path.join(fs.realpathSync(os.tmpdir()), "scratch"), "write")).toBe("allow");
	});

	it("lets an explicit read grant restore parent enumeration", () => {
		const home = realTmp("enumeration-override");
		const parent = path.join(home, "customers");
		const workspace = path.join(parent, "example-a");
		fs.mkdirSync(workspace, { recursive: true });

		const defaultFence = buildContainmentFence({ workspace, home });
		const readGranted = buildContainmentFence({ workspace, home, readOnlyRoots: [parent] });
		const writeGranted = buildContainmentFence({ workspace, home, writeOnlyRoots: [parent] });

		expect(fenceVerdict(defaultFence, parent, "enumerate")).toBe("deny");
		expect(fenceVerdict(readGranted, parent, "enumerate")).toBe("allow");
		expect(fenceVerdict(writeGranted, parent, "enumerate")).toBe("deny");
	});

	it("re-allows package caches so toolchains keep working", () => {
		const home = realTmp("home3");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		// Keep these explicit grants stable for toolchain compatibility. Home is otherwise available under
		// the operator-rights policy, so the grants must not introduce a narrower write rule.
		for (const cache of [".bun/install/cache", ".cargo/registry", ".npm/_cacache", ".m2/repository"]) {
			expect(fenceVerdict(fence, path.join(home, cache, "x"), "write")).toBe("allow");
		}
	});

	it("keeps operator-owned home and configuration writable", () => {
		const home = realTmp("home4");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		for (const own of [
			".gitconfig",
			".aws/config",
			".zshrc",
			".zprofile",
			".ssh/config",
			".xcsh/settings.json",
			".xcsh/plugins/example/plugin.json",
			".xcsh/skills/example/SKILL.md",
		]) {
			expect(fenceVerdict(fence, path.join(home, own), "read")).toBe("allow");
			expect(fenceVerdict(fence, path.join(home, own), "write")).toBe("allow");
		}
	});

	it("keeps the operator's private files under their normal filesystem rights", () => {
		const home = realTmp("home5");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		// This asserted the opposite until #2637, and the reversal is deliberate. `.aws/credentials` stopped
		// being denied in #2581 because a path-based fence cannot let `aws` read it without letting `cat`
		// read it. #2637 finished the thought: the fence is a courtesy against inadvertent wandering
		// between customers, not a privilege boundary against the operator, whose own machine this is.
		//
		// The exfiltration-via-prompt-injection risk was raised in review and is real, but it is not new —
		// the cloud credential store has been readable since #2581, so closing SSH alone would be theatre.
		// Recorded on #2637; the operator's call, and they made it.
		for (const own of [".ssh/id_rsa", ".gnupg/secring.gpg", "Documents/tax.pdf"]) {
			expect(fenceVerdict(fence, path.join(home, own), "read")).toBe("allow");
		}
	});

	it("hides cross-session root listings even when nested under an allowed root", () => {
		const home = realTmp("home6");
		// The pathological case: the workspace IS the agent dir's parent, so the leak roots sit
		// inside something the fence allows. The exact enumeration deny must still win.
		const workspace = path.join(home, ".xcsh");
		const sessions = path.join(workspace, "agent", "sessions");
		fs.mkdirSync(sessions, { recursive: true });
		const fence = buildContainmentFence({ workspace, home, leakRoots: [sessions] });

		expect(fenceVerdict(fence, path.join(workspace, "config.yml"), "read")).toBe("allow");
		expect(fenceVerdict(fence, sessions, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(sessions, "other.jsonl"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(sessions, "other.jsonl"), "write")).toBe("allow");
	});

	it("isolates cross-session roots without splitting their writable parent", () => {
		const home = realTmp("operator-rights");
		const workspace = path.join(home, "work");
		const sessions = path.join(home, ".xcsh", "agent", "sessions");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(sessions, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, leakRoots: [sessions] });

		expect(fence.deny).not.toContain(sessions);
		expect(fence.denyEnumerate).toContain(sessions);
		expect(fenceVerdict(fence, sessions, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(sessions, "known-session.jsonl"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(home, "created-directly"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fs.realpathSync(os.tmpdir()), "created-directly"), "write")).toBe("allow");
	});

	it("lets explicit grants override private roots without widening their direction", () => {
		const home = realTmp("private-grants");
		const workspace = path.join(home, "w");
		const privateParent = path.join(home, ".xcsh", "agent");
		const sessions = path.join(privateParent, "sessions");
		const candidate = path.join(sessions, "other.jsonl");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(sessions, { recursive: true });

		const defaultFence = buildContainmentFence({ workspace, home, leakRoots: [sessions] });
		const full = buildContainmentFence({ workspace, home, leakRoots: [sessions], extraRoots: [privateParent] });
		const readOnly = buildContainmentFence({ workspace, home, leakRoots: [sessions], readOnlyRoots: [sessions] });
		const writeOnly = buildContainmentFence({
			workspace,
			home,
			leakRoots: [sessions],
			writeOnlyRoots: [privateParent],
		});

		expect(fenceVerdict(defaultFence, sessions, "enumerate")).toBe("deny");
		expect(fenceVerdict(defaultFence, candidate, "read")).toBe("allow");
		expect(fenceVerdict(defaultFence, candidate, "write")).toBe("allow");
		expect(fenceVerdict(full, candidate, "read")).toBe("allow");
		expect(fenceVerdict(full, candidate, "write")).toBe("allow");
		expect(fenceVerdict(full, sessions, "enumerate")).toBe("allow");
		expect(fenceVerdict(readOnly, candidate, "read")).toBe("allow");
		expect(fenceVerdict(readOnly, candidate, "write")).toBe("deny");
		expect(fenceVerdict(writeOnly, candidate, "read")).toBe("deny");
		expect(fenceVerdict(writeOnly, candidate, "write")).toBe("allow");
		expect(fenceVerdict(writeOnly, sessions, "enumerate")).toBe("deny");
	});

	it("grants extra roots from --allow-path for both directions", () => {
		const home = realTmp("home7");
		const workspace = path.join(home, "w");
		const shared = realTmp("shared");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home, extraRoots: [shared] });

		expect(fenceVerdict(fence, path.join(shared, "f"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(shared, "f"), "write")).toBe("allow");
	});

	// A seatbelt `(subpath …)` rule on a non-canonical path silently matches nothing — a rule that
	// appears to enforce and does not. Verified: `/tmp/x` grants nothing because the real path is
	// `/private/tmp/x`. So canonicalisation is a correctness requirement, not tidiness.
	it("canonicalises every root", () => {
		const home = realTmp("home8");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const link = path.join(home, "link-to-w");
		fs.symlinkSync(workspace, link);
		const fence = buildContainmentFence({ workspace: link, home });

		expect(fence.allow).toContain(workspace);
		expect(fence.allow).not.toContain(link);
		for (const root of [...fence.allow, ...fence.allowReadOnly, ...fence.deny, ...fence.denyEnumerate]) {
			expect(path.isAbsolute(root)).toBe(true);
			// A root that exists must already be its own real path. One that does not yet exist (an
			// absent cache dir) has nothing to resolve, and is emitted so it can be created later.
			if (fs.existsSync(root)) expect(root).toBe(fs.realpathSync(root));
		}
	});

	it("refuses to build a fence whose workspace cannot be canonicalised", () => {
		const home = realTmp("home9");
		expect(() => buildContainmentFence({ workspace: path.join(home, "does-not-exist"), home })).toThrow(
			/canonicalise/i,
		);
	});

	// A cache dir must be grantable BEFORE it exists, or the very first `bun install` — which
	// creates ~/.bun — fails inside the fence. Absent optional roots are granted, not dropped.
	it("grants a cache dir that does not exist yet", () => {
		const home = realTmp("home10");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		expect(fs.existsSync(path.join(home, ".bun"))).toBe(false);

		const fence = buildContainmentFence({ workspace, home });
		expect(fenceVerdict(fence, path.join(home, ".bun", "install", "cache", "x"), "write")).toBe("allow");
	});

	// An absent root must never be emitted non-canonically for a path that DOES exist, because a
	// non-canonical rule silently grants nothing. Existing roots are still resolved.
	it("canonicalises the roots that exist", () => {
		const home = realTmp("home11");
		const workspace = path.join(home, "w");
		const realCache = realTmp("cache");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(path.join(home, ".bun", "install"), { recursive: true });
		fs.symlinkSync(realCache, path.join(home, ".bun", "install", "cache"));

		const fence = buildContainmentFence({ workspace, home });
		expect(fence.allow).toContain(realCache);
		expect(fenceVerdict(fence, path.join(realCache, "pkg"), "write")).toBe("allow");
	});
});

/**
 * Findings from adversarial review of this fence, each verified allowed before the fix.
 *
 * They share a shape worth naming: the fence is permissive by default, so every gap is a path that
 * matched no rule rather than a rule that was wrong. Denying home was never the whole boundary.
 */
/**
 * Adversarial review of #2624, which found three ways the single boundary was looser than intended.
 *
 * All three are the same shape: the fence is allow-by-default, so anything it fails to *name* is
 * reachable — and while the second policy was there, its deny-by-default posture was quietly covering
 * for each gap. Removing that posture is what exposed them, which is the risk this whole change carries
 * and the reason the review was worth running.
 */
/**
 * The operator's home is theirs (#2637).
 *
 * Reported: `Read ~/git/STYLE_GUIDE.md` refused with the workspace at `~/MEDDPICC/CUSTOMER-A`. The refusal was
 * correct for the rule and the model declined to work around it, so the work simply stopped and the
 * operator was told the boundary was working as intended.
 *
 * This fence is a professional courtesy — an effort to stop *inadvertent* wandering between customers —
 * for an operator with senior technical skills and the same rights on this machine as the agent acting for
 * them. It is not a prison, and it does not re-implement file permissions.
 */
describe("buildContainmentFence — the operator's home is theirs (#2637)", () => {
	/** `<home>/MEDDPICC/CUSTOMER-A`, the shape the report came from. */
	function customerSession(suffix: string) {
		const home = realTmp(suffix);
		const container = path.join(home, "MEDDPICC");
		const workspace = path.join(container, "CUSTOMER-A");
		const sibling = path.join(container, "CUSTOMER-B");
		const elsewhere = path.join(home, "git");
		for (const dir of [workspace, sibling, elsewhere]) fs.mkdirSync(dir, { recursive: true });
		return { home, container, workspace, sibling, elsewhere };
	}

	it("reads a file elsewhere in the operator's home", () => {
		const { home, workspace, elsewhere } = customerSession("ownhome");
		const fence = buildContainmentFence({ workspace, home });

		expect(fenceVerdict(fence, path.join(elsewhere, "STYLE_GUIDE.md"), "read")).toBe("allow");
		expect(fence.deny).not.toContain(home);
	});

	it("refuses scanning the session folder's parent without refusing a named sibling", () => {
		const { home, container, workspace, sibling } = customerSession("sibling");
		const fence = buildContainmentFence({ workspace, home });

		expect(fenceVerdict(fence, container, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(sibling, "notes.md"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(sibling, "notes.md"), "write")).toBe("allow");
		expect(fence.denyEnumerate).toContain(container);
		expect(fenceVerdict(fence, path.join(workspace, "mine.md"), "write")).toBe("allow");
	});

	it("keeps the enumeration deny exact when the workspace is nested deeper", () => {
		const home = realTmp("nested");
		const container = path.join(home, "MEDDPICC");
		const workspace = path.join(container, "CUSTOMER-A", "repo");
		const otherTenant = path.join(container, "CUSTOMER-B", "repo");
		for (const dir of [workspace, otherTenant]) fs.mkdirSync(dir, { recursive: true });

		const fence = buildContainmentFence({ workspace, home });

		expect(fenceVerdict(fence, path.dirname(workspace), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(otherTenant, "secret.env"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(container, "CUSTOMER-A", "sibling-of-repo"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "mine.md"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(home, "git", "STYLE_GUIDE.md"), "read")).toBe("allow");
	});

	/** A session whose folder is a direct child of home must not change normal home navigation. */
	it("does not fence home when the session folder sits directly in it", () => {
		const home = realTmp("inhome");
		const workspace = path.join(home, "custA");
		const sibling = path.join(home, "custB");
		for (const dir of [workspace, sibling]) fs.mkdirSync(dir, { recursive: true });

		// Leak roots passed explicitly: the defaults point at the *real* agent directories, which a temp
		// home knows nothing about, so relying on them here would assert nothing.
		const sessions = path.join(home, ".xcsh", "agent", "sessions");
		const fence = buildContainmentFence({ workspace, home, leakRoots: [sessions] });

		expect(fence.deny).not.toContain(home);
		expect(fenceVerdict(fence, home, "enumerate")).toBe("allow");
		expect(fenceVerdict(fence, path.join(sibling, "notes.md"), "read")).toBe("allow");
		// Xcsh-private state follows the same operator-rights rule: its listing is hidden, while a path
		// the operator names directly remains available.
		expect(fenceVerdict(fence, sessions, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(sessions, "x.jsonl"), "read")).toBe("allow");
	});
});

describe("buildContainmentFence — adversarial review of #2624", () => {
	// The shared temp root holds per-session state: `local://` content at `<tmp>/xcsh-local/<sessionId>`
	// (local-protocol.ts:118) and task artifacts at `<tmp>/xcsh-tasks/<id>` (task/index.ts). Both are
	// exactly the cross-session channel the leak roots exist to close, and classifying `tmp` as
	// operational made every session's copy discoverable by every other session.
	it("hides other sessions' local roots without splitting the shared temp dir", () => {
		const home = realTmp("leaktmp");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const sharedTmp = fs.realpathSync(os.tmpdir());

		const fence = buildContainmentFence({ workspace, home });

		const otherLocal = path.join(sharedTmp, "xcsh-local", "other-session", "handoff.json");
		expect(fenceVerdict(fence, path.join(sharedTmp, "xcsh-local"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, otherLocal, "read")).toBe("allow");
		expect(fenceVerdict(fence, otherLocal, "write")).toBe("allow");
		// Ordinary scratch beside it stays reachable — `xcsh://about` promises `/tmp`, and the refusal of
		// it was one of the false refusals #2582 removed. Only the private-container listings are shut.
		expect(fenceVerdict(fence, path.join(sharedTmp, "scratch.txt"), "write")).toBe("allow");
	});

	/**
	 * The fence is built on the session's first `bash` call, so its cost is user-visible latency.
	 *
	 * The first version of the leak-root fix enumerated the OS temp dir looking for `xcsh-task-*`
	 * siblings. On a workstation with 17,505 entries in it that was 15ms of a 25-42ms build — per build,
	 * and growing without bound as the temp dir fills. It pushed `echo short` past the 50ms
	 * auto-background threshold, which is how it was caught: a *timing* test in `tools.test.ts` failed,
	 * not a containment one.
	 *
	 * Asserted by counting `readdir` calls rather than by wall-clock time. A timing threshold would be the
	 * obvious test and the wrong one: it flakes on a loaded runner, and it measures the symptom instead of
	 * the cause. What must stay true is that a fence build enumerates *only* the filesystem root — a
	 * bounded, tiny directory — and never a temp or home directory whose size is the operator's business.
	 */
	it("enumerates only the filesystem root, never a large directory", () => {
		const home = realTmp("perf");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });

		const scanned: string[] = [];
		const spy = spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike) => {
			scanned.push(String(dir));
			return [];
		}) as unknown as typeof fs.readdirSync);
		try {
			buildContainmentFence({ workspace, home, fsRoot: home });
		} finally {
			spy.mockRestore();
		}

		// Exactly the configured root, once. The earlier version also listed `os.tmpdir()` hunting for
		// `xcsh-task-*` siblings, which cost 15ms of a 25-42ms build on a 17k-entry directory and pushed a
		// trivial `echo` past the 50ms auto-background threshold — caught by a *timing* test elsewhere,
		// not by anything here.
		expect(scanned).toEqual([home]);
	});

	// …and the session's own known local root must stay reachable, or `local://` breaks for everyone.
	it("keeps the session's own local root reachable inside the hidden container", () => {
		const home = realTmp("ownlocal");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const mine = path.join(fs.realpathSync(os.tmpdir()), "xcsh-local", "my-session");
		fs.mkdirSync(mine, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, extraRoots: [mine] });

		expect(fenceVerdict(fence, path.join(mine, "handoff.json"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(mine, "handoff.json"), "write")).toBe("allow");
		// A different session is not discoverable by listing the shared parent, but a path the operator
		// already knows keeps ordinary named access.
		const theirs = path.join(fs.realpathSync(os.tmpdir()), "xcsh-local", "their-session", "x");
		expect(fenceVerdict(fence, path.join(fs.realpathSync(os.tmpdir()), "xcsh-local"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, theirs, "read")).toBe("allow");
	});

	// `sandbox.allowRead: ["~/shared"]` was passed straight to `realpathSync`, which does not expand `~`,
	// so the rule named a path that does not exist and was dropped. The grant then appeared to do nothing
	// while the refusal it was meant to lift kept recommending it — worse than an unimplemented flag. The
	// policy this replaced expanded `~` (`expandPath`), so this was a regression, not an old gap.
	it("expands ~ in a granted root", () => {
		const home = realTmp("tildehome");
		const workspace = path.join(home, "w");
		const shared = path.join(home, "shared");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(shared, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, readOnlyRoots: ["~/shared"], homeForTilde: home });

		expect(fenceVerdict(fence, path.join(shared, "ref.csv"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(shared, "ref.csv"), "write")).toBe("deny");
	});

	/** The injectable list exercises the second-drive shape that cannot be discovered on this host. */
	it("protects enumeration of other filesystem roots while allowing named paths", () => {
		const home = realTmp("otherroots");
		const workspace = path.join(home, "w");
		const otherRoot = realTmp("drive-d");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(path.join(otherRoot, "customerB"), { recursive: true });

		const fence = buildContainmentFence({ workspace, home, otherRoots: [otherRoot] });

		expect(fence.denyEnumerate).toContain(otherRoot);
		expect(fenceVerdict(fence, otherRoot, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(otherRoot, "customerB", "secret.tf"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(otherRoot, "customerB", "secret.tf"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "write")).toBe("allow");
	});

	/**
	 * The hazard the test above cannot see, asserted white-box.
	 *
	 * `tooBroadToDeny` refuses to deny a filesystem root, which is right for the workspace's own. On
	 * Windows `D:\` IS a filesystem root, so running the other-roots list through that check drops every
	 * entry and the rule becomes a no-op on the only platform it exists for. The first version did exactly
	 * that, and the injected-temp-dir test passed anyway, because a temp directory is not a root here.
	 *
	 * `/` is the only value on this platform that reproduces the shape. Nonsense as a real configuration —
	 * which is the point: this asserts the list is not silently filtered, not that anyone should pass it.
	 */
	it("does not let the broad-root guard filter the other-roots list", () => {
		const container = realTmp("rootfilter");
		const workspace = path.join(container, "w");
		fs.mkdirSync(workspace, { recursive: true });

		// `fsRoot` is the container, so `/` is a filesystem root that is NOT this workspace's — the exact
		// shape a second Windows drive has, and the only way to produce it on this platform.
		// The injected root must not contain home, or the #2637 guard correctly skips it. A sibling temp
		// root is the honest stand-in for "a second Windows drive".
		const otherRoot = realTmp("rootfilter-other");
		const fence = buildContainmentFence({
			workspace,
			home: path.join(container, "home"),
			fsRoot: container,
			otherRoots: [otherRoot],
		});

		expect(fence.denyEnumerate).toContain(otherRoot);
	});

	it("protects another filesystem root even when that root contains home", () => {
		const workspaceContainer = realTmp("workspace-drive");
		const workspace = path.join(workspaceContainer, "repo");
		const otherRoot = realTmp("home-drive");
		const home = path.join(otherRoot, "Users", "operator");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(home, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, fsRoot: workspaceContainer, otherRoots: [otherRoot] });

		expect(fence.denyEnumerate).toContain(otherRoot);
		expect(fenceVerdict(fence, otherRoot, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(home, "known.txt"), "read")).toBe("allow");
	});

	// …but the root the workspace actually lives on is never denied, however it arrives.
	it("never denies the workspace's own filesystem root", () => {
		const container = realTmp("ownroot");
		const workspace = path.join(container, "w");
		fs.mkdirSync(workspace, { recursive: true });

		const fence = buildContainmentFence({
			workspace,
			home: realTmp("ownroot-home"),
			fsRoot: container,
			otherRoots: [container],
		});

		expect(fence.deny).not.toContain(container);
		expect(fence.denyEnumerate).not.toContain(container);
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "write")).toBe("allow");
	});

	it("keeps a named granted tree usable under a protected other root", () => {
		const home = realTmp("otherrootsgrant");
		const workspace = path.join(home, "w");
		const otherRoot = realTmp("driveE");
		const tools = path.join(otherRoot, "tools");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(tools, { recursive: true });

		const fence = buildContainmentFence({ workspace, home, otherRoots: [otherRoot], extraRoots: [tools] });

		expect(fenceVerdict(fence, path.join(tools, "bin", "cc"), "read")).toBe("allow");
		expect(fenceVerdict(fence, otherRoot, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(otherRoot, "customerB", "x"), "read")).toBe("allow");
	});

	// `--allow-path <dir>` for a directory that does not exist yet must retain its directional contract.
	it("honours a granted root that does not exist yet", () => {
		const home = realTmp("absentgrant");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const notYet = path.join(home, "output-dir");
		expect(fs.existsSync(notYet)).toBe(false);

		const fence = buildContainmentFence({ workspace, home, extraRoots: [notYet] });

		expect(fence.allow).toContain(notYet);
		expect(fenceVerdict(fence, path.join(notYet, "report.csv"), "write")).toBe("allow");
	});
});

describe("buildContainmentFence — review findings", () => {
	// `--allow-path <dir>` maps into BOTH sandbox.allowRead and sandbox.allowWrite (main.ts:649), which
	// reaches the fence as the same root in readOnlyRoots and writeOnlyRoots. Those two rules sit at
	// equal depth, and `fenceVerdict` tests read-only first, so the write was refused — the flag granted
	// read only, while the containment prompt tells the model it "grants read and write". The documented
	// remedy for a refusal did not work, which is worse than a missing feature.
	it("grants read AND write when a root is given as both read-only and write-only", () => {
		const home = realTmp("bothhome");
		const workspace = path.join(home, "w");
		const granted = realTmp("granted");
		fs.mkdirSync(workspace, { recursive: true });

		const fence = buildContainmentFence({
			workspace,
			home,
			readOnlyRoots: [granted],
			writeOnlyRoots: [granted],
		});

		expect(fenceVerdict(fence, path.join(granted, "x"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(granted, "x"), "write")).toBe("allow");
		// Asserted on the emitted rules too: a single allow, not two half-grants that happen to combine.
		expect(fence.allow).toContain(granted);
		expect(fence.allowReadOnly).not.toContain(granted);
		expect(fence.allowWriteOnly).not.toContain(granted);
	});

	// The split must survive, or this fix would undo #2516: a folder shared for reading must not become
	// writable just because some *other* root was granted both ways.
	it("keeps one-directional grants one-directional", () => {
		const home = realTmp("splithome");
		const workspace = path.join(home, "w");
		const readable = realTmp("readable");
		const writable = realTmp("writable");
		fs.mkdirSync(workspace, { recursive: true });

		const fence = buildContainmentFence({
			workspace,
			home,
			readOnlyRoots: [readable],
			writeOnlyRoots: [writable],
		});

		expect(fenceVerdict(fence, path.join(readable, "x"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(readable, "x"), "write")).toBe("deny");
		expect(fenceVerdict(fence, path.join(writable, "x"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(writable, "x"), "read")).toBe("deny");
	});

	it("denies sibling discovery even when the workspace is outside home", () => {
		const base = realTmp("work");
		const a = path.join(base, "customer-a");
		const b = path.join(base, "customer-b");
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		const fence = buildContainmentFence({ workspace: a, home: path.join(base, "unrelated-home") });

		expect(fenceVerdict(fence, base, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(b, "secret"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(b, "planted"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(a, "own.md"), "write")).toBe("allow");
	});

	it("never denies a parent too broad to deny", () => {
		// Denying the parent must not reach the filesystem root, a system directory, or the OS temp
		// dir — each would refuse work the fence is supposed to leave alone.
		const tmp = fs.realpathSync(os.tmpdir());
		const shallow = buildContainmentFence({ workspace: tmp, home: path.join(tmp, "no-such-home") });
		expect(fenceVerdict(shallow, path.join(tmp, "scratch"), "write")).toBe("allow");

		const system = buildContainmentFence({ workspace: "/usr/local", home: path.join(tmp, "no-such-home") });
		expect(fenceVerdict(system, "/usr/bin/env", "read")).toBe("allow");
		expect(fenceVerdict(system, "/etc/hosts", "read")).toBe("allow");
	});

	it("keeps operator-owned toolchain configuration writable while preserving cache access", () => {
		const home = realTmp("credhome");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		for (const own of [
			".cargo/config.toml",
			".cargo/credentials.toml",
			".gradle/init.gradle",
			".m2/settings.xml",
			".npm/_authToken",
		]) {
			expect(fenceVerdict(fence, path.join(home, own), "read")).toBe("allow");
			expect(fenceVerdict(fence, path.join(home, own), "write")).toBe("allow");
		}
		for (const artifact of [
			".cargo/registry/index/x",
			".m2/repository/org/x.jar",
			".npm/_cacache/index-v5/x",
			".bun/install/cache/pkg",
			".gradle/caches/modules-2/x",
		]) {
			expect(fenceVerdict(fence, path.join(home, artifact), "write")).toBe("allow");
		}
	});

	// #2581: the home deny left every CLI xcsh ships a plugin for unable to read its own configuration.
	// Measured on v19.100.0: `gh` exited 1, `glab` 2, `az` 1 with a Python traceback, `aws` 255 blaming a
	// missing profile, `gcloud` 1, and `sf` exited **0** while crashing — a failure no script can detect.
	it("grants each shipped CLI its own config and state directory", () => {
		const home = realTmp("clihome");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		// Read AND write: these CLIs persist refreshed tokens, logs and profiles as part of ordinary
		// use. `gh auth login`, `az login`, `aws sso login` and `sf org login` all write here.
		for (const config of [
			".config/gh/hosts.yml", // the token gh authenticates with
			".sf/sf-2026-07-28.log",
			".sfdx/alias.json",
			".azure/azureProfile.json",
			".aws/credentials",
			".config/gcloud/access_tokens.db",
			".docker/contexts/meta/x",
			".kube/cache/discovery/x",
			".terraform.d/credentials.tfrc.json",
		]) {
			expect(fenceVerdict(fence, path.join(home, config), "read")).toBe("allow");
			expect(fenceVerdict(fence, path.join(home, config), "write")).toBe("allow");
		}

		// These paths can name commands, but that does not turn this courtesy into a privilege boundary
		// against the operator. Shell profiles and SSH configuration are writable for the same reason.
		for (const config of [
			".aws/config", // credential_process = <command>
			".kube/config", // users[].user.exec.command
			".docker/config.json", // credsStore / credHelpers
			".docker/cli-plugins/docker-evil", // plugin executable
			".azure/cliextensions/evil/__init__.py", // az extension, executed as Python
			".terraform.d/plugins/evil", // provider binary
			".config/gcloud/virtenv/bin/activate", // sourced by the gcloud launcher
			".config/gh/config.yml", // gh alias set x '!sh -c …'
			".config/glab-cli/aliases.yml", // glab keeps aliases in their own file
			"Library/Application Support/glab-cli/aliases.yml",
			".aws/cli/alias", // an aws alias starting with `!` runs through a shell
		]) {
			expect(fenceVerdict(fence, path.join(home, config), "read")).toBe("allow");
			expect(fenceVerdict(fence, path.join(home, config), "write")).toBe("allow");
		}
	});

	// Same defect as the CACHE_DIRS carve-out, missed for Go: `go` is in the tool list xcsh probes for,
	// and its module cache lives at ~/go/pkg/mod, so `go build` failed inside the fence.
	it("grants the Go module cache so `go build` works", () => {
		const home = realTmp("gohome");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		expect(fenceVerdict(fence, path.join(home, "go/pkg/mod/cache/download/x"), "write")).toBe("allow");
		// `~/go/src` was denied only as a side effect of the whole-home deny. It is the operator's own
		// checked-out source, so #2637 leaves it alone.
		expect(fenceVerdict(fence, path.join(home, "go/src/private/x"), "read")).toBe("allow");
	});

	// The grants above must not have widened anything else. This is the property that makes the fence
	// worth having at all, so it is asserted beside the change that could break it.
	it("keeps discovery and cross-session isolation after the CLI grants", () => {
		const home = realTmp("stillhome");
		const workspace = path.join(home, "GIT", "custA");
		const sessions = path.join(home, ".xcsh", "agent", "sessions");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(sessions, { recursive: true });
		const fence = buildContainmentFence({ workspace, home, leakRoots: [sessions] });

		expect(fenceVerdict(fence, path.join(home, "GIT"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(home, "GIT/custB/secrets.tf"), "read")).toBe("allow");
		const otherSession = path.join(home, ".xcsh/agent/sessions/other.jsonl");
		expect(fenceVerdict(fence, sessions, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, otherSession, "read")).toBe("allow");
		expect(fenceVerdict(fence, otherSession, "write")).toBe("allow");
		// The operator's own private files are not withheld from them. Asserted rather than left implicit,
		// so anyone auditing what this fence protects sees the choice.
		for (const own of [".ssh/id_ed25519", ".gnupg/secring.gpg", "Documents/contract.pdf"]) {
			expect(fenceVerdict(fence, path.join(home, own), "read")).toBe("allow");
		}
	});

	it("keeps a read-only grant read-only and a write-only grant write-only", () => {
		// Verified allow/allow before the fix: bash.ts merged sandbox.allowRead and sandbox.allowWrite
		// into one read+write list, so a folder shared for reading became writable — undoing the
		// read/write split built for #2516.
		const home = realTmp("splithome");
		const workspace = path.join(home, "w");
		const shared = realTmp("shared-ro");
		const drop = realTmp("drop-wo");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home, readOnlyRoots: [shared], writeOnlyRoots: [drop] });

		expect(fenceVerdict(fence, path.join(shared, "ctx.md"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(shared, "ctx.md"), "write")).toBe("deny");
		expect(fenceVerdict(fence, path.join(drop, "out.log"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(drop, "out.log"), "read")).toBe("deny");
	});
});

/**
 * What gets reported has to be what is actually enforcing.
 *
 * The backend cannot be inferred from `process.platform`: Landlock can be compiled out of the kernel,
 * left out of its boot-time LSM list, or too old to allow cross-directory rename. Each of those looks
 * identical from TypeScript, and each changes what the boundary is worth — so the answer comes from a
 * probe, and these tests pin what happens for every answer it can give.
 */
describe("containmentStatus", () => {
	const landlock = () => ({ backend: "landlock" });
	const scannerOnly = () => ({ backend: "scanner-only" });
	const unavailable = () => undefined;

	it("reports seatbelt on macOS without consulting the probe at all", () => {
		let probed = false;
		const status = containmentStatus(true, "darwin", () => {
			probed = true;
			return scannerOnly();
		});
		expect(status).toEqual({ enabled: true, backend: "seatbelt", osEnforced: true });
		expect(probed).toBe(false);
	});

	it("reports landlock as OS-enforced when the kernel provides it", () => {
		expect(containmentStatus(true, "linux", landlock)).toEqual({
			enabled: true,
			backend: "landlock",
			osEnforced: true,
		});
	});

	it("does not arm Landlock for a discovery-only fence that would remove ancestor listings", () => {
		const home = realTmp("status-discovery-home");
		const workspace = path.join(home, "workspaces", "customer-a");
		fs.mkdirSync(workspace, { recursive: true });
		const fence = buildContainmentFence({ workspace, home });
		let probed = false;

		expect(
			containmentStatus(
				true,
				"linux",
				() => {
					probed = true;
					return landlock();
				},
				fence,
			),
		).toEqual({ enabled: true, backend: "scanner-only", osEnforced: false, discoveryOnly: true });
		expect(probed).toBe(false);
	});

	// The case that must not over-claim: a Linux box where Landlock is absent or too old.
	it("reports scanner-only on Linux when the kernel does not provide Landlock", () => {
		expect(containmentStatus(true, "linux", scannerOnly)).toEqual({
			enabled: true,
			backend: "scanner-only",
			osEnforced: false,
		});
	});

	it("falls back to scanner-only when the probe cannot answer", () => {
		// A native module from an older release has no such export. Understating the boundary is the
		// safe direction to be wrong in; claiming enforcement that is not there is not.
		expect(containmentStatus(true, "linux", unavailable)).toEqual({
			enabled: true,
			backend: "scanner-only",
			osEnforced: false,
		});
	});

	/**
	 * The failure mode that actually happened, which the throwing case does not cover.
	 *
	 * A native module built before this export existed simply does not have the symbol. The first version
	 * of this code reached it through a static named import, which fails at *link* time — the tarball
	 * install smoke test died with `SyntaxError: Export named 'containmentBackend' not found` before any
	 * runtime guard could run. Reaching it as a namespace member turns that into `undefined`, which is a
	 * case code can handle, and this is the shape that has to keep working.
	 */
	it("treats a native module with no such export as simply having no backend", () => {
		const olderNative = {} as { containmentBackend?: () => { backend: string } };
		const status = containmentStatus(true, "linux", () => olderNative.containmentBackend?.());
		expect(status).toEqual({ enabled: true, backend: "scanner-only", osEnforced: false });
	});

	it("survives a probe that throws rather than taking down xcsh://about", () => {
		const status = containmentStatus(true, "linux", () => {
			throw new TypeError("containmentBackend is not a function");
		});
		expect(status.osEnforced).toBe(false);
		expect(status.backend).toBe("scanner-only");
	});

	it("says disabled before asking anything, when isolation is off", () => {
		let probed = false;
		const status = containmentStatus(false, "linux", () => {
			probed = true;
			return landlock();
		});
		expect(status).toEqual({ enabled: false, backend: "disabled", osEnforced: false });
		expect(probed).toBe(false);
	});

	it("reports scanner-only on Windows", () => {
		expect(containmentStatus(true, "win32", scannerOnly).osEnforced).toBe(false);
	});
});

describe("buildContainmentFence — enumeration isolation is exact", () => {
	it("does not turn the courtesy into a named-path restriction", () => {
		const home = realTmp("cousinhome");
		const container = realTmp("tenants");
		const workspace = path.join(container, "example-corp", "repo");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(path.join(container, "globex", "repo"), { recursive: true });
		const fence = buildContainmentFence({ workspace, home });

		expect(fenceVerdict(fence, path.dirname(workspace), "enumerate")).toBe("deny");
		// Known paths stay under the operator's normal authority.
		for (const access of ["read", "write"] as const) {
			expect(fenceVerdict(fence, path.join(container, "globex", "repo", "secrets.tf"), access)).toBe("allow");
			expect(fenceVerdict(fence, path.join(container, "example-corp", "other-repo", "x"), access)).toBe("allow");
			expect(fenceVerdict(fence, path.join(container, "loose-file.txt"), access)).toBe("allow");
		}
		// …and the workspace itself still works, or the fence is useless.
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "write")).toBe("allow");
	});

	it("still refuses to deny a root too broad to deny", () => {
		const home = realTmp("broadhome");
		// Directly under the OS temp dir: walking up must stop rather than deny $TMPDIR or /.
		const workspace = path.join(fs.realpathSync(os.tmpdir()), `fence-broad-${process.pid}`);
		fs.mkdirSync(workspace, { recursive: true });
		try {
			const fence = buildContainmentFence({ workspace, home });
			for (const root of fence.deny) {
				expect(root).not.toBe("/");
				expect(root).not.toBe(fs.realpathSync(os.tmpdir()));
			}
			// Operational paths stay reachable however far up the walk went.
			for (const p of ["/usr/bin/env", "/etc/hosts", "/bin/sh"]) {
				expect(fenceVerdict(fence, p, "read")).toBe("allow");
			}
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});

// Review of the ancestor walk: with the workspace under /tmp, canonicalisation gives /private/tmp/…,
// and `tooBroadToDeny` named `/private` and `os.tmpdir()` but not the resolved `/tmp` — so the walk
// denied /private/tmp and took every other temp path with it, against the guarantee in xcsh://about.
describe("buildContainmentFence — the ancestor walk never denies a temp root", () => {
	it("leaves /tmp usable when the workspace itself lives under it", () => {
		const home = realTmp("tmphome");
		const container = `/tmp/fence-tmp-probe-${process.pid}`;
		const workspace = path.join(container, "repo");
		fs.mkdirSync(workspace, { recursive: true });
		try {
			// Resolved, never hardcoded: `/tmp` really is `/private/tmp` on macOS and really is `/tmp` on
			// Linux, and the fence works in resolved paths. Writing the macOS spelling in made this pass
			// locally and fail on the Linux runner, where it asserted against a path that exists nowhere.
			const realTmpRoot = fs.realpathSync("/tmp");
			const realContainer = fs.realpathSync(container);

			const fence = buildContainmentFence({ workspace, home });
			for (const root of fence.deny) {
				expect(root).not.toBe("/tmp");
				expect(root).not.toBe(realTmpRoot);
			}
			expect(fenceVerdict(fence, path.join(realTmpRoot, "other-session.txt"), "read")).toBe("allow");
			// The workspace's own container cannot be scanned, but a named child is still reachable.
			expect(fenceVerdict(fence, realContainer, "enumerate")).toBe("deny");
			expect(fenceVerdict(fence, path.join(realContainer, "sibling", "x"), "read")).toBe("allow");
			expect(fenceVerdict(fence, path.join(fs.realpathSync(workspace), "mine.txt"), "write")).toBe("allow");
		} finally {
			fs.rmSync(container, { recursive: true, force: true });
		}
	});
});

/** Data containers lose casual discovery without restricting explicitly named paths (#2931). */
describe("buildContainmentFence — data roots outside the workspace", () => {
	/** A synthetic filesystem root, so an assertion never depends on what this machine mounts. */
	function syntheticRoot(suffix: string, entries: readonly string[]): string {
		const root = realTmp(suffix);
		for (const entry of entries) fs.mkdirSync(path.join(root, entry), { recursive: true });
		return root;
	}

	it("protects container enumeration while leaving named and operational paths alone", () => {
		const fsRoot = syntheticRoot("fsdata", ["usr", "bin", "etc", "opt", "var", "Users", "data", "srv", "Volumes"]);
		const home = path.join(fsRoot, "Users", "me");
		const workspace = path.join(home, "MEDDPICC", "CUSTOMER-A");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(path.join(fsRoot, "Users", "otheruser"), { recursive: true });
		fs.mkdirSync(path.join(fsRoot, "data", "globex"), { recursive: true });
		fs.mkdirSync(path.join(fsRoot, "Volumes", "Backup"), { recursive: true });

		const fence = buildContainmentFence({ workspace, home, fsRoot });

		// The account container cannot be listed, but a named account remains under normal OS authority.
		const accountRoot = path.join(fsRoot, "Users");
		const otherHome = path.join(accountRoot, "otheruser");
		expect(fence.deny).not.toContain(accountRoot);
		expect(fence.denyEnumerate).toContain(accountRoot);
		expect(fence.allow).toContain(home);
		expect(fenceVerdict(fence, accountRoot, "enumerate")).toBe("deny");
		for (const access of ["read", "write", "enumerate"] as const) {
			expect(fenceVerdict(fence, path.join(otherHome, "workspace"), access)).toBe("allow");
			expect(fenceVerdict(fence, path.join(home, ".config", "tool"), access)).toBe("allow");
		}

		// The operator can still override the courtesy with an explicit grant.
		const granted = buildContainmentFence({ workspace, home, fsRoot, extraRoots: [otherHome] });
		expect(fenceVerdict(granted, path.join(otherHome, "named-file"), "read")).toBe("allow");
		expect(fenceVerdict(granted, path.join(otherHome, "named-file"), "write")).toBe("allow");

		for (const root of ["data", "srv", "Volumes"].map(name => path.join(fsRoot, name))) {
			expect(fence.denyEnumerate).toContain(root);
			expect(fenceVerdict(fence, root, "enumerate")).toBe("deny");
		}
		for (const named of ["data/globex/secrets.tf", "srv/tenantZ/notes.md", "Volumes/Backup/customerY"]) {
			const candidate = path.join(fsRoot, named);
			expect(fenceVerdict(fence, candidate, "read")).toBe("allow");
			expect(fenceVerdict(fence, candidate, "write")).toBe("allow");
		}

		// …and nothing a tool needs. This fence restricts no operation; that is what makes it gentle.
		for (const operational of ["usr/bin/env", "bin/sh", "etc/hosts", "opt/homebrew/bin/bun", "var/log/x"]) {
			expect(fenceVerdict(fence, path.join(fsRoot, operational), "read")).toBe("allow");
		}
		// The workspace remains fully usable inside a protected container.
		expect(fenceVerdict(fence, path.join(workspace, "notes.md"), "write")).toBe("allow");
	});

	it("protects a known data container that does not exist yet", () => {
		const fsRoot = syntheticRoot("fsabsent", ["usr", "Users"]);
		const home = path.join(fsRoot, "Users", "me");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });
		expect(fs.existsSync(path.join(fsRoot, "srv"))).toBe(false);

		const fence = buildContainmentFence({ workspace, home, fsRoot });

		expect(fence.denyEnumerate).toContain(path.join(fsRoot, "srv"));
		expect(fenceVerdict(fence, path.join(fsRoot, "srv"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(fsRoot, "srv", "tenantZ", "x"), "read")).toBe("allow");
	});

	// A deny beats an allow at EQUAL depth, so denying a root that is itself the workspace would not
	// merely be redundant — it would kill the session's own tree. Reachable wherever a container puts
	// the checkout at the top level: /app, /src, /workspaces.
	it("never denies a top-level root that is itself the workspace", () => {
		const fsRoot = syntheticRoot("fsws", ["usr", "app"]);
		const workspace = path.join(fsRoot, "app");
		const fence = buildContainmentFence({ workspace, home: path.join(fsRoot, "Users", "me"), fsRoot });

		expect(fence.deny).not.toContain(workspace);
		expect(fence.denyEnumerate).not.toContain(workspace);
		expect(fenceVerdict(fence, path.join(workspace, "src", "main.ts"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(workspace, "src", "main.ts"), "write")).toBe("allow");
	});

	// Same equal-depth hazard for a root the operator granted deliberately. `--allow-path /shared` must
	// win over a blanket "unknown root" deny, or the flag would silently do nothing.
	it("never denies a top-level root the operator granted", () => {
		const fsRoot = syntheticRoot("fsgrant", ["usr", "shared", "readonly", "data"]);
		const home = path.join(fsRoot, "Users", "me");
		const workspace = path.join(home, "w");
		fs.mkdirSync(workspace, { recursive: true });

		const fence = buildContainmentFence({
			workspace,
			home,
			fsRoot,
			extraRoots: [path.join(fsRoot, "shared")],
			readOnlyRoots: [path.join(fsRoot, "readonly")],
		});

		expect(fenceVerdict(fence, path.join(fsRoot, "shared", "x"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fsRoot, "shared", "x"), "write")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fsRoot, "readonly", "x"), "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fsRoot, "readonly", "x"), "write")).toBe("deny");
		expect(fenceVerdict(fence, path.join(fsRoot, "shared"), "enumerate")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fsRoot, "readonly"), "enumerate")).toBe("allow");
		// An ungranted data container beside them still cannot be enumerated.
		expect(fenceVerdict(fence, path.join(fsRoot, "data"), "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(fsRoot, "data", "x"), "read")).toBe("allow");
	});

	// The synthetic root proves the rule; this proves it is wired to the real filesystem, which is the
	// part that actually ships. Asserted on the emitted roots, because that is what the backend compiles.
	it("protects the real home container on this machine and no operational root", () => {
		const fence = buildContainmentFence({ workspace: fs.realpathSync(process.cwd()) });

		const accountRoot = path.join(
			path.parse(fs.realpathSync(process.cwd())).root,
			process.platform === "linux" ? "home" : "Users",
		);
		expect(fence.deny).not.toContain(accountRoot);
		expect(fence.denyEnumerate).toContain(accountRoot);
		expect(fenceVerdict(fence, accountRoot, "enumerate")).toBe("deny");
		expect(fence.allow).toContain(fs.realpathSync(os.homedir()));
		expect(fenceVerdict(fence, fs.realpathSync(os.homedir()), "write")).toBe("allow");
		// Only what this platform actually has: `/private` is macOS-only, and `realpathSync` on an absent
		// path throws — which failed the Linux runner while passing locally. The file already warns about
		// exactly this trap two describes up, and I walked into it anyway.
		for (const operational of ["/usr", "/bin", "/sbin", "/etc", "/dev", "/opt", "/var", "/private", "/tmp"]) {
			if (!fs.existsSync(operational)) continue;
			expect(fence.deny).not.toContain(operational);
			expect(fence.deny).not.toContain(fs.realpathSync(operational));
		}
		expect(fenceVerdict(fence, "/usr/bin/env", "read")).toBe("allow");
		expect(fenceVerdict(fence, path.join(fs.realpathSync("/tmp"), "scratch.txt"), "write")).toBe("allow");
	});

	// Agent configuration belongs to the operator just like shell and CLI configuration. Keeping these
	// read-only would still be a privilege boundary even though they happen to be xcsh inputs.
	it("keeps the agent's plugins, user skills, and settings writable", () => {
		const fence = buildContainmentFence({ workspace: fs.realpathSync(process.cwd()) });

		for (const own of [
			path.join(getPluginsDir(), "probe", "manifest.json"),
			path.join(getAgentDir(), "skills", "probe", "SKILL.md"),
			path.join(getConfigRootDir(), "settings.json"),
		]) {
			expect(fenceVerdict(fence, own, "read")).toBe("allow");
			expect(fenceVerdict(fence, own, "write")).toBe("allow");
		}
	});

	// A leak root inside the granted plugins tree must still hide its listing while ABSENT — the
	// case that used to fall through, because `canonical` drops a path that does not exist yet and the
	// home deny was quietly covering for it. Passed explicitly rather than read from the environment:
	// the ambient dirs depend on whether an earlier test relocated the agent dir, which is not a
	// property this test is about.
	it("hides a cross-session leak root nested inside a grant, even before it exists", () => {
		const home = realTmp("leaknest");
		const workspace = path.join(home, "w");
		const plugins = path.join(home, ".xcsh", "plugins");
		const leak = path.join(plugins, "shared-state");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(plugins, { recursive: true });
		expect(fs.existsSync(leak)).toBe(false);

		const fence = buildContainmentFence({ workspace, home, leakRoots: [leak] });

		expect(fence.deny).not.toContain(leak);
		expect(fence.denyEnumerate).toContain(leak);
		expect(fenceVerdict(fence, leak, "enumerate")).toBe("deny");
		expect(fenceVerdict(fence, path.join(leak, "other-session.json"), "read")).toBe("allow");
	});
});
