#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync } from "node:fs";
import * as path from "node:path";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			"--fix",
			"--allow-dirty",
			"--all-targets",
			"--no-deps",
			"--allow-staged",
			"--broken-code",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"]],
	"test:rs": [["cargo", "nextest", "run", "--workspace", "--all-features", "--status-level=fail", "--final-status-level=fail"]],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");

// Guarded so the decision helpers can be imported and tested. Without this, importing the module ran the
// whole task and called process.exit, which is why the skip logic had no test to catch #2573.
if (import.meta.main) {
	const taskName = process.argv[2];

	if (!isRustTaskName(taskName)) {
		console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
		process.exit(1);
	}

	if (!(isCI() || (await hasRustAffectingChanges(taskName)))) {
		console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
		process.exit(0);
	}

	const manifests = await discoverRustManifests(repoRoot);
	for (const manifest of manifests) {
		for (const command of TASK_COMMANDS[taskName]) {
			const args: string[] = [...command];
			const position = args[1] === "nextest" ? 3 : 2;
			args.splice(position, 0, "--manifest-path", manifest);
			const exitCode = await runCommand(args);
			if (exitCode !== 0) process.exit(exitCode);
		}
	}
}

/** Discover tracked and new manifests, checking each Cargo workspace exactly once. */
export async function discoverRustManifests(root: string): Promise<string[]> {
	const files = await $`git ls-files --cached --others --exclude-standard -z`.cwd(root).quiet();
	const manifests = [...new Set(files.stdout.toString().split("\0")
		.filter(file => path.basename(file) === "Cargo.toml")
		.map(file => path.resolve(root, file)).filter(existsSync))].sort((a, b) => a.length - b.length || a.localeCompare(b));
	const covered = new Set<string>();
	const workspaces = new Set<string>();
	for (const manifest of manifests) {
		if (covered.has(manifest)) continue;
		const result = await $`cargo metadata --no-deps --format-version 1 --manifest-path ${manifest}`.cwd(root).quiet();
		const metadata = JSON.parse(result.stdout.toString()) as {
			workspace_root: string;
			workspace_members: string[];
			packages: { id: string; manifest_path: string }[];
		};
		workspaces.add(path.join(metadata.workspace_root, "Cargo.toml"));
		const members = new Set(metadata.workspace_members);
		for (const pkg of metadata.packages) {
			if (members.has(pkg.id)) covered.add(pkg.manifest_path);
		}
		covered.add(manifest);
	}
	return [...workspaces].sort();
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Whether this branch touches Rust — uncommitted edits OR anything already committed on it.
 *
 * Committing used to switch the check off. `git status --porcelain` reports the working tree only, so the
 * moment Rust changes were committed the tree went clean, this returned false, and `check:rs` skipped
 * itself — precisely when someone is about to push. A real `cargo fmt` violation reached CI that way
 * (#2573), and the skip message reads like a considered decision rather than a gap.
 *
 * So the question is asked of the branch, not of the tree: uncommitted changes plus the diff against the
 * default branch. Anything that cannot be determined runs the task, matching the existing posture that a
 * broken git query must not silently disable a gate.
 */
async function hasRustAffectingChanges(taskName: RustTaskName): Promise<boolean> {
	const uncommitted = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (uncommitted.exitCode !== 0) {
		const stderr = uncommitted.stderr.toString().trim();
		const suffix = stderr === "" ? `exit ${uncommitted.exitCode}` : stderr;
		console.warn(`Warning: failed to inspect git status: ${suffix}. Running ${taskName} conservatively.`);
		return true;
	}
	if (getChangedPathsFromPorcelain(uncommitted.stdout).some(isRustAffectingPath)) return true;

	const base = await defaultBranchRef();
	if (base === undefined) {
		console.warn(`Warning: could not resolve the default branch. Running ${taskName} conservatively.`);
		return true;
	}
	// Three dots: compare against the merge base, so commits that merged into the default branch after
	// this one started are not mistaken for changes this branch made.
	//
	// `--no-renames` is load-bearing: with rename detection, `git diff --name-only` reports only the
	// destination, so `git mv src/foo.rs src/foo.txt` emitted just the .txt path and the branch looked
	// Rust-free while having deleted a module. Verified in a scratch repo. Without renames the same change
	// appears as a delete plus an add, so the .rs side is visible.
	const committed = await $`git diff --name-only --no-renames -z ${`${base}...HEAD`}`
		.cwd(repoRoot)
		.quiet()
		.nothrow();
	if (committed.exitCode !== 0) {
		const stderr = committed.stderr.toString().trim();
		const suffix = stderr === "" ? `exit ${committed.exitCode}` : stderr;
		console.warn(`Warning: failed to diff against ${base}: ${suffix}. Running ${taskName} conservatively.`);
		return true;
	}
	return new TextDecoder().decode(committed.stdout).split("\0").filter(Boolean).some(isRustAffectingPath);
}

/** The default branch's remote ref, preferring what the remote itself reports. */
async function defaultBranchRef(): Promise<string | undefined> {
	const symbolic = await $`git symbolic-ref --quiet refs/remotes/origin/HEAD`.cwd(repoRoot).quiet().nothrow();
	if (symbolic.exitCode === 0) {
		const ref = symbolic.stdout.toString().trim();
		if (ref !== "") return ref;
	}
	// A fresh clone may not have origin/HEAD set. Fall back to the conventional names, remote first,
	// and only to a local branch when there is no remote copy to compare against.
	for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
		const exists = await $`git rev-parse --verify --quiet ${`${candidate}^{commit}`}`.cwd(repoRoot).quiet().nothrow();
		if (exists.exitCode === 0) return candidate;
	}
	return undefined;
}

export function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

export function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized === "scripts/run-rs-task.ts" ||
		normalized.endsWith(".rs") ||
		normalized.startsWith(".cargo/") ||
		isNativeSource(normalized) ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

/**
 * C/C++ sources a `build.rs` compiles into a crate.
 *
 * `crates/tree-sitter-glimmer/build.rs` builds `parser.c` and `scanner.c`, so editing one changes what
 * Cargo produces — and clippy can fail on code that no longer links. Those files matched nothing here, so
 * a branch touching only them skipped the Rust checks entirely.
 *
 * Deliberately not scoped to `crates/`: a false positive costs one clippy run, while a false negative is
 * the gap this function exists to close. That is the same "when unsure, run" posture as the callers.
 */
function isNativeSource(normalizedPath: string): boolean {
	return [".c", ".h", ".cc", ".cpp", ".hpp", ".cxx"].some(extension => normalizedPath.endsWith(extension));
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function runCommand(command: readonly string[]): Promise<number> {
	const proc = Bun.spawn([...command], {
		cwd: repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
