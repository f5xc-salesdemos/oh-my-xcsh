import { describe, expect, it } from "bun:test";
import { getChangedPathsFromPorcelain, isRustAffectingPath } from "../../../../scripts/run-rs-task";

/**
 * The local Rust gate decides whether to run from a list of changed paths (#2573).
 *
 * The defect it had was not in the matching but in *which* list it consulted: `git status --porcelain`
 * reports the working tree only, so committing Rust changes emptied the list and `check:rs` skipped
 * itself — exactly when someone is about to push. A real `cargo fmt` violation reached CI that way.
 * `hasRustAffectingChanges` now also diffs against the default branch.
 *
 * That plumbing needs git, so what is pinned here is the part that can be: the path predicate both lists
 * are filtered through, and the porcelain parser feeding it. Importing this module used to execute the
 * whole task and call `process.exit`, which is why none of it had a test; it is now behind
 * `import.meta.main`.
 */
describe("isRustAffectingPath", () => {
	it("matches Rust sources wherever they sit, including a committed crate path", () => {
		for (const changedPath of [
			"crates/containment-check/src/main.rs",
			"src/lib.rs",
			"crates/brush-core-vendored/src/sys/unix/landlock.rs",
		]) {
			expect(isRustAffectingPath(changedPath)).toBe(true);
		}
	});

	it("matches the build inputs that change how Rust compiles", () => {
		for (const changedPath of [
			"Cargo.toml",
			"Cargo.lock",
			"crates/pi-natives/build.rs",
			"rust-toolchain.toml",
			"rustfmt.toml",
			".clippy.toml",
			".cargo/config.toml",
		]) {
			expect(isRustAffectingPath(changedPath)).toBe(true);
		}
	});

	it("ignores paths that cannot affect a Rust build", () => {
		for (const changedPath of [
			"packages/coding-agent/src/sandbox/containment.ts",
			"biome.json",
			"README.md",
			"docs/rustfmt.toml.md",
			"notes.rs.txt",
		]) {
			expect(isRustAffectingPath(changedPath)).toBe(false);
		}
	});

	// Windows checkouts report backslashes; the predicate normalises before matching.
	it("normalises separators", () => {
		expect(isRustAffectingPath("crates\\containment-check\\src\\main.rs")).toBe(true);
		expect(isRustAffectingPath("crates\\foo\\Cargo.toml")).toBe(true);
	});
});

describe("getChangedPathsFromPorcelain", () => {
	const porcelain = (entries: string[]): Uint8Array => new TextEncoder().encode(`${entries.join("\0")}\0`);

	it("reads a NUL-separated status list", () => {
		const paths = getChangedPathsFromPorcelain(porcelain([" M src/lib.rs", "?? notes.md"]));
		expect(paths).toEqual(["src/lib.rs", "notes.md"]);
	});

	// A rename emits the destination and then the source as a separate entry. Both must be reported, or
	// renaming a .ts file over a .rs one could hide the Rust change.
	it("reports both sides of a rename", () => {
		const paths = getChangedPathsFromPorcelain(porcelain(["R  new/lib.rs", "old/lib.rs"]));
		expect(paths).toEqual(["new/lib.rs", "old/lib.rs"]);
	});

	it("is empty for a clean tree — which is the state that used to disable the gate", () => {
		expect(getChangedPathsFromPorcelain(new Uint8Array())).toEqual([]);
	});
});

/**
 * Review of #2573's fix found two ways the predicate could still miss a Rust change.
 *
 * Both were confirmed before fixing. A rename is the subtler one: `git diff --name-only` reports only the
 * destination when rename detection is on, so `git mv src/foo.rs src/foo.txt` emitted just the .txt path
 * and a branch that deleted a module looked Rust-free. The diff now passes `--no-renames`, which splits it
 * into a delete plus an add so the .rs side is visible — that flag is what these paths stand in for.
 */
describe("isRustAffectingPath — paths that must not slip through", () => {
	it("sees the source side of a rename away from Rust", () => {
		// What `--no-renames` surfaces: the deleted .rs plus the added non-Rust file.
		expect(["src/foo.rs", "src/foo.txt"].some(isRustAffectingPath)).toBe(true);
		// And what plain --name-only would have surfaced on its own is not enough.
		expect(isRustAffectingPath("src/foo.txt")).toBe(false);
	});

	// crates/tree-sitter-glimmer/build.rs compiles parser.c and scanner.c, so these change what Cargo
	// produces and clippy can fail on the result.
	it("treats C/C++ sources compiled by a build script as Rust-affecting", () => {
		for (const changedPath of [
			"crates/tree-sitter-glimmer/src/parser.c",
			"crates/tree-sitter-glimmer/src/scanner.c",
			"crates/tree-sitter-glimmer/src/tree_sitter/parser.h",
			"crates/foo/src/thing.cc",
			"crates/foo/src/thing.cpp",
		]) {
			expect(isRustAffectingPath(changedPath)).toBe(true);
		}
	});

	it("does not treat prose that merely mentions those extensions as code", () => {
		for (const changedPath of ["docs/parser.c.md", "notes-about-h.txt"]) {
			expect(isRustAffectingPath(changedPath)).toBe(false);
		}
	});
});

describe("Rust manifest discovery", () => {
	it("covers excluded standalone crates and deduplicates workspace members", async () => {
		const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { discoverRustManifests } = await import("../../../../scripts/run-rs-task");
		const root = await mkdtemp(join(tmpdir(), "xcsh-rust-discovery-"));
		try {
			await writeFile(
				join(root, "Cargo.toml"),
				'[workspace]\nmembers = ["member"]\nexclude = ["vendor"]\nresolver = "3"\n',
			);
			for (const name of ["member", "vendor", "obsolete"]) {
				await mkdir(join(root, name, "src"), { recursive: true });
				await writeFile(join(root, name, "src/lib.rs"), "pub fn fixture() {}\n");
				await writeFile(
					join(root, name, "Cargo.toml"),
					`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n${name !== "member" ? "[workspace]\n" : ""}`,
				);
			}
			const git = (...args: string[]) => {
				const result = Bun.spawnSync(["git", ...args], { cwd: root });
				expect(result.exitCode).toBe(0);
			};
			git("init", "--quiet");
			git("add", ".");
			await rm(join(root, "obsolete"), { recursive: true });
			await mkdir(join(root, "new-crate/src"), { recursive: true });
			await writeFile(join(root, "new-crate/src/lib.rs"), "pub fn fixture() {}\n");
			await writeFile(
				join(root, "new-crate/Cargo.toml"),
				'[package]\nname = "new-crate"\nversion = "0.1.0"\nedition = "2024"\n[workspace]\n',
			);
			expect(await discoverRustManifests(root)).toEqual([
				join(root, "Cargo.toml"),
				join(root, "new-crate/Cargo.toml"),
				join(root, "vendor/Cargo.toml"),
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
