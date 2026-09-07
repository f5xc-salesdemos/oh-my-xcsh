//! Does the Landlock grant compiler mean the same thing as the fence it
//! compiles?
//!
//! Landlock is allow-only with no deny primitive, while the fence is
//! allow-by-default with targeted denies, so `compile_grant_plan` has to
//! express the denies by granting their complement. That translation is the
//! part that can be subtly wrong, and it is pure — no kernel, no privileges —
//! so it is tested here against `permits_resolved` as the oracle, on every
//! platform.
//!
//! Two properties, and the asymmetry between them is the point:
//!
//! - **Safety** — the plan must never permit what the fence denies. A failure
//!   here is a sandbox escape.
//! - **Fidelity** — for anything else, the plan must agree with the fence. A
//!   failure here is the fence refusing ordinary work, which is how a security
//!   feature gets switched off.
//!
//! Fidelity has one legitimate exception: a *split directory*, which a
//! recursive-only rule model cannot grant without also granting its denied
//! children. Those are enumerated by the compiler and asserted to be strictly
//! stricter, never laxer.

use std::{
	collections::BTreeSet,
	ffi::OsString,
	path::{Path, PathBuf},
};

use brush_core::containment::{ContainmentFence, DirLister, FenceAccess, GrantPlan};

/// A synthetic directory tree, so the compiler can be driven without touching a
/// filesystem.
struct FakeFs {
	paths: BTreeSet<PathBuf>,
}

impl FakeFs {
	fn new(paths: &[&str]) -> Self {
		let mut all = BTreeSet::new();
		for path in paths {
			// Insert every ancestor too, so the tree is well-formed however it was listed.
			let mut current = PathBuf::from(path);
			loop {
				all.insert(current.clone());
				match current.parent() {
					Some(parent) if parent != current => current = parent.to_path_buf(),
					_ => break,
				}
			}
		}
		Self { paths: all }
	}

	fn contains(&self, path: &Path) -> bool {
		self.paths.contains(path)
	}
}

impl DirLister for FakeFs {
	fn entries(&self, dir: &Path) -> std::io::Result<Vec<OsString>> {
		if !self.paths.contains(dir) {
			return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
		}
		Ok(self
			.paths
			.iter()
			.filter(|path| path.parent() == Some(dir))
			.filter_map(|path| path.file_name().map(std::ffi::OsStr::to_os_string))
			.collect())
	}
}

/// The shape a real Linux fence has: home denied, a workspace re-allowed inside
/// it, package caches carved back out, a leak root denied *inside* the
/// workspace, and read-only / write-only roots.
fn realistic() -> (FakeFs, ContainmentFence) {
	let fs = FakeFs::new(&[
		"/usr/bin/env",
		"/etc/hosts",
		"/tmp/scratch",
		"/opt/shared/ctx.md",
		"/opt/other/thing",
		"/drop/out.log",
		"/home/example/notes.md",
		"/home/alice/.ssh/id_rsa",
		"/home/alice/Documents/tax.pdf",
		"/home/alice/.gitconfig",
		"/home/alice/.cargo/registry/index",
		"/home/alice/.cargo/credentials.toml",
		"/home/alice/GIT/custB/secret.env",
		"/home/alice/GIT/custA/notes.md",
		"/home/alice/GIT/custA/sub/deep.txt",
		"/home/alice/GIT/custA/.xcsh/sessions/other.jsonl",
	]);
	let fence = ContainmentFence {
		allow: vec![
			PathBuf::from("/home/alice/GIT/custA"),
			PathBuf::from("/home/alice/.cargo/registry"),
		],
		allow_read_only: vec![PathBuf::from("/home/alice/.gitconfig"), PathBuf::from("/opt/shared")],
		allow_write_only: vec![PathBuf::from("/drop")],
		// `/home/alice/GIT` nested inside `/home/alice` exercises deny-inside-deny; the
		// `.xcsh/sessions` root is a deny inside an allow inside a deny, which is the case
		// seatbelt handles by rule order and Landlock cannot.
		deny: vec![
			PathBuf::from("/home/alice"),
			PathBuf::from("/home/alice/GIT"),
			PathBuf::from("/home/alice/GIT/custA/.xcsh/sessions"),
		],
		deny_on_seatbelt: Vec::new(),
		deny_enumerate: Vec::new(),
	};
	(fs, fence)
}

fn candidates(fs: &FakeFs) -> Vec<PathBuf> {
	let mut out: Vec<PathBuf> = fs.paths.iter().cloned().collect();
	// Paths that do not exist yet, because a write target usually does not.
	for extra in [
		"/home/alice/GIT/custA/created-later.txt",
		"/home/alice/GIT/custA/sub/created-later.txt",
		"/home/alice/GIT/custB/planted.env",
		"/tmp/new-file",
		"/drop/new.log",
		"/home/alice/.ssh/planted",
	] {
		out.push(PathBuf::from(extra));
	}
	out
}

#[test]
fn plan_never_permits_what_the_fence_denies() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	let mut escapes = Vec::new();
	for path in candidates(&fs) {
		for access in [FenceAccess::Read, FenceAccess::Write, FenceAccess::Enumerate] {
			if plan.permits(&path, access) && !fence.permits_resolved(&path, access) {
				escapes.push(format!("{access:?} {}", path.display()));
			}
		}
	}
	assert!(escapes.is_empty(), "grant plan is laxer than the fence for: {escapes:#?}");
}

#[test]
fn plan_agrees_with_the_fence_except_on_split_directories() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);
	let split: BTreeSet<&PathBuf> = plan.split_dirs.iter().collect();

	let mut disagreements = Vec::new();
	for path in candidates(&fs) {
		if split.contains(&path) {
			continue;
		}
		// A path that does not exist and sits directly inside a split directory was
		// never enumerated, so it is denied. That is the documented cost, asserted on
		// its own below.
		if path
			.parent()
			.is_some_and(|parent| split.contains(&parent.to_path_buf()))
			&& !fs.contains(&path)
		{
			continue;
		}
		for access in [FenceAccess::Read, FenceAccess::Write, FenceAccess::Enumerate] {
			let planned = plan.permits(&path, access);
			let fenced = fence.permits_resolved(&path, access);
			if planned != fenced {
				disagreements
					.push(format!("{access:?} {}: plan={planned} fence={fenced}", path.display()));
			}
		}
	}
	assert!(disagreements.is_empty(), "grant plan disagrees with the fence: {disagreements:#?}");
}

#[test]
fn split_directories_are_only_ever_stricter() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	for dir in &plan.split_dirs {
		for access in [FenceAccess::Read, FenceAccess::Write, FenceAccess::Enumerate] {
			assert!(
				!plan.permits(dir, access) || fence.permits_resolved(dir, access),
				"split dir {} is laxer than the fence for {access:?}",
				dir.display()
			);
		}
	}
}

#[test]
fn everything_outside_the_fence_stays_reachable() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	// The whole point of the complement: paths the fence never mentions must keep
	// working, in both directions. If this fails, the backend has turned a gentle
	// fence into a deny-by-default one.
	for path in
		["/usr/bin/env", "/etc/hosts", "/tmp/scratch", "/tmp/new-file", "/home/example/notes.md"]
	{
		let path = PathBuf::from(path);
		assert!(plan.permits(&path, FenceAccess::Read), "{} should be readable", path.display());
		assert!(plan.permits(&path, FenceAccess::Write), "{} should be writable", path.display());
	}
}

#[test]
fn the_denied_home_and_sibling_checkout_are_unreachable() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	for path in [
		"/home/alice/.ssh/id_rsa",
		"/home/alice/Documents/tax.pdf",
		"/home/alice/.cargo/credentials.toml",
		"/home/alice/GIT/custB/secret.env",
		"/home/alice/GIT/custA/.xcsh/sessions/other.jsonl",
	] {
		let path = PathBuf::from(path);
		assert!(!plan.permits(&path, FenceAccess::Read), "{} must not be readable", path.display());
		assert!(!plan.permits(&path, FenceAccess::Write), "{} must not be writable", path.display());
	}
}

#[test]
fn the_workspace_and_its_carve_outs_are_fully_usable() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	for path in [
		"/home/alice/GIT/custA/notes.md",
		"/home/alice/GIT/custA/sub/deep.txt",
		"/home/alice/GIT/custA/sub/created-later.txt",
		"/home/alice/.cargo/registry/index",
	] {
		let path = PathBuf::from(path);
		assert!(plan.permits(&path, FenceAccess::Read), "{} should be readable", path.display());
		assert!(plan.permits(&path, FenceAccess::Write), "{} should be writable", path.display());
	}
}

#[test]
fn read_only_and_write_only_roots_keep_their_direction() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	let gitconfig = PathBuf::from("/home/alice/.gitconfig");
	assert!(plan.permits(&gitconfig, FenceAccess::Read));
	assert!(!plan.permits(&gitconfig, FenceAccess::Write));

	let shared = PathBuf::from("/opt/shared/ctx.md");
	assert!(plan.permits(&shared, FenceAccess::Read));
	assert!(!plan.permits(&shared, FenceAccess::Write));

	let drop = PathBuf::from("/drop/out.log");
	assert!(plan.permits(&drop, FenceAccess::Write));
	assert!(!plan.permits(&drop, FenceAccess::Read));
}

/// A read-only root under an *allowed* parent must not cost that parent its
/// read rights.
///
/// This is why the plan is compiled once per direction. Compiling both at once
/// would make `/opt` a split directory for reads as well, so `ls /opt` would
/// fail for no reason at all.
#[test]
fn a_read_only_root_splits_only_the_write_direction() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);

	let opt = PathBuf::from("/opt");
	assert!(plan.permits(&opt, FenceAccess::Read), "/opt must stay readable, so `ls /opt` works");
	assert!(
		!plan.permits(&opt, FenceAccess::Write),
		"/opt itself is not writable: /opt/shared is RO"
	);
	// And the sibling that the fence never mentions keeps both directions.
	let other = PathBuf::from("/opt/other/thing");
	assert!(plan.permits(&other, FenceAccess::Read));
	assert!(plan.permits(&other, FenceAccess::Write));
}

/// The accepted costs, asserted so they are known properties rather than future
/// bug reports.
#[test]
fn the_documented_costs_hold() {
	let (fs, fence) = realistic();
	let plan = fence.compile_grant_plan(&fs);
	let split: BTreeSet<&PathBuf> = plan.split_dirs.iter().collect();

	// `/` and `/home` hold both granted and denied children, so neither can be
	// granted as a subtree — which is exactly why `ls /` and `ls /home` fail under
	// a fence.
	assert!(
		split.contains(&PathBuf::from("/")),
		"/ should be a split dir, got {:?}",
		plan.split_dirs
	);
	assert!(split.contains(&PathBuf::from("/home")), "/home should be a split dir");
	assert!(!plan.permits(Path::new("/"), FenceAccess::Read), "`ls /` is expected to fail");
	assert!(!plan.permits(Path::new("/home"), FenceAccess::Read), "`ls /home` is expected to fail");

	// A leak root denied inside the workspace makes the workspace itself a split
	// dir, so a file created directly in the workspace root afterwards is
	// unreachable.
	//
	// The backend confines anyway rather than falling back. Of the three options —
	// confine and lose new files at the workspace root, run unconfined, or refuse
	// every command — only the first keeps the boundary, and it is reachable only
	// when the workspace *is* the agent directory, which no ordinary session does.
	// Running unconfined while still reporting `landlock` would be the worst of the
	// three; refusing every command turns a narrow cost into a dead session.
	let workspace = PathBuf::from("/home/alice/GIT/custA");
	assert!(split.contains(&workspace), "a deny inside the workspace splits the workspace");
	assert!(!plan.permits(Path::new("/home/alice/GIT/custA/created-later.txt"), FenceAccess::Write));
}

/// A directory that has to be enumerated but cannot be grants nothing, and says
/// so.
#[test]
fn unenumerable_directories_fail_closed() {
	struct Blind;
	impl DirLister for Blind {
		fn entries(&self, _dir: &Path) -> std::io::Result<Vec<OsString>> {
			Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
		}
	}
	let fence = ContainmentFence {
		allow: vec![PathBuf::from("/home/alice/GIT/custA")],
		deny: vec![PathBuf::from("/home/alice")],
		..ContainmentFence::default()
	};
	let plan = fence.compile_grant_plan(&Blind);

	assert!(!plan.unenumerable.is_empty(), "a failed readdir must be reported");
	// Nothing outside the explicit allow is granted, because nothing could be
	// enumerated.
	assert!(!plan.permits(Path::new("/usr/bin/env"), FenceAccess::Read));
	// The explicit allow still lands, because it needs no enumeration.
	assert!(plan.permits(Path::new("/home/alice/GIT/custA/notes.md"), FenceAccess::Read));
}

/// An empty fence restricts nothing, and must compile to a plan that says so.
#[test]
fn an_empty_fence_grants_the_whole_tree() {
	let fs = FakeFs::new(&["/usr/bin/env", "/home/alice/x"]);
	let plan = ContainmentFence::default().compile_grant_plan(&fs);

	assert!(plan.split_dirs.is_empty(), "nothing splits when nothing is denied");
	for path in ["/usr/bin/env", "/home/alice/x", "/anything/at/all"] {
		assert!(plan.permits(Path::new(path), FenceAccess::Read));
		assert!(plan.permits(Path::new(path), FenceAccess::Write));
		assert!(plan.permits(Path::new(path), FenceAccess::Enumerate));
	}
}

#[test]
fn an_exact_enumeration_deny_keeps_named_descendants_reachable() {
	let fs = FakeFs::new(&[
		"/home/alice/customers/example-a/notes.md",
		"/home/alice/customers/example-b/context.md",
	]);
	let parent = PathBuf::from("/home/alice/customers");
	let sibling = PathBuf::from("/home/alice/customers/example-b/context.md");
	let sibling_dir = PathBuf::from("/home/alice/customers/example-b");
	let fence =
		ContainmentFence { deny_enumerate: vec![parent.clone()], ..ContainmentFence::default() };
	let plan = fence.compile_grant_plan(&fs);

	assert!(!fence.permits_resolved(&parent, FenceAccess::Enumerate));
	assert!(!plan.permits(&parent, FenceAccess::Enumerate));
	assert!(fence.permits_resolved(&sibling, FenceAccess::Read));
	assert!(plan.permits(&sibling, FenceAccess::Read));
	assert!(fence.permits_resolved(&sibling_dir, FenceAccess::Enumerate));
	assert!(plan.permits(&sibling_dir, FenceAccess::Enumerate));
}

#[test]
fn production_enumeration_isolation_preserves_direct_parent_creation() {
	let fs = FakeFs::new(&[
		"/tmp/existing",
		"/tmp/xcsh-local/other-session/state.json",
		"/tmp/xcsh-tasks/other-task/artifact",
		"/home/alice/existing",
		"/home/alice/.xcsh/agent/sessions/other.jsonl",
	]);
	let fence = ContainmentFence {
		allow: vec![PathBuf::from("/home/alice")],
		deny_enumerate: vec![
			PathBuf::from("/tmp/xcsh-local"),
			PathBuf::from("/tmp/xcsh-tasks"),
			PathBuf::from("/home/alice/.xcsh/agent/sessions"),
		],
		..ContainmentFence::default()
	};
	let plan = fence.compile_grant_plan(&fs);

	for direct_child in ["/tmp/terraform-provider-new", "/home/alice/new-config"] {
		assert!(
			plan.permits(Path::new(direct_child), FenceAccess::Write),
			"{direct_child} must remain directly creatable"
		);
	}
	for private_root in ["/tmp/xcsh-local", "/tmp/xcsh-tasks", "/home/alice/.xcsh/agent/sessions"] {
		assert!(!plan.permits(Path::new(private_root), FenceAccess::Enumerate));
	}
	assert!(
		plan.permits(Path::new("/home/alice/.xcsh/agent/sessions/other.jsonl"), FenceAccess::Read)
	);
}

#[test]
fn discovery_only_fences_do_not_require_landlock() {
	let discovery_only = ContainmentFence {
		allow: vec![PathBuf::from("/home/alice")],
		deny_enumerate: vec![PathBuf::from("/home/alice/customers")],
		..ContainmentFence::default()
	};
	assert!(!discovery_only.requires_landlock());

	let recursive = ContainmentFence {
		deny: vec![PathBuf::from("/home/alice/customers")],
		..ContainmentFence::default()
	};
	assert!(recursive.requires_landlock());

	let directional = ContainmentFence {
		allow_read_only: vec![PathBuf::from("/shared")],
		..ContainmentFence::default()
	};
	assert!(directional.requires_landlock());
}

#[test]
fn seatbelt_customer_container_deny_is_recursive_but_deeper_grants_win() {
	let parent = PathBuf::from("/Users/alice/customers");
	let workspace = parent.join("example-a");
	let trusted = parent.join("shared-handoff");
	let fence = ContainmentFence {
		allow: vec![workspace.clone(), trusted.clone()],
		deny_on_seatbelt: vec![parent.clone()],
		..ContainmentFence::default()
	};

	let profile = fence.to_seatbelt_profile();
	let deny = format!("(deny file-read* file-write* (subpath \"{}\"))", parent.display());
	let workspace_allow =
		format!("(allow file-read* file-write* (subpath \"{}\"))", workspace.display());
	let trusted_allow =
		format!("(allow file-read* file-write* (subpath \"{}\"))", trusted.display());

	let deny_at = profile
		.find(&deny)
		.expect("customer container must be recursively denied");
	let workspace_at = profile
		.find(&workspace_allow)
		.expect("workspace must be restored");
	let trusted_at = profile
		.find(&trusted_allow)
		.expect("trusted sibling grant must be restored");
	assert!(deny_at < workspace_at);
	assert!(deny_at < trusted_at);
	assert!(!fence.requires_landlock(), "a Seatbelt-only rule must not arm Landlock");
	assert!(
		!profile.contains(&format!("(allow file-read-metadata (subpath \"{}\"))", parent.display())),
		"the sibling container itself must not stay traversable"
	);
}

#[test]
fn seatbelt_in_process_checks_apply_customer_deny_and_deeper_grants() {
	let parent = PathBuf::from("/Users/alice/customers");
	let workspace = parent.join("example-a");
	let sibling = parent.join("example-b");
	let trusted = parent.join("shared-handoff");
	let fence = ContainmentFence {
		allow: vec![workspace.clone(), trusted.clone()],
		deny_on_seatbelt: vec![parent],
		..ContainmentFence::default()
	};

	assert!(
		fence.permits_resolved(&sibling.join("planted.env"), FenceAccess::Write),
		"the portable policy deliberately ignores the Seatbelt-only customer deny"
	);
	#[cfg(not(target_os = "macos"))]
	assert!(
		fence.permits_resolved_for_host(&sibling.join("planted.env"), FenceAccess::Write),
		"non-macOS hosts must retain the portable policy"
	);
	assert!(
		!fence.permits_resolved_on_seatbelt(&sibling.join("planted.env"), FenceAccess::Write),
		"an in-process macOS redirection must enforce the same deny as sandbox-exec"
	);
	assert!(
		fence.permits_resolved_on_seatbelt(&workspace.join("notes.md"), FenceAccess::Write),
		"the deeper workspace grant must win"
	);
	assert!(
		fence.permits_resolved_on_seatbelt(&trusted.join("output.txt"), FenceAccess::Write),
		"an explicit deeper trusted grant must win"
	);
}

/// Two lists naming the same path must resolve the way `permits_resolved` does:
/// deny wins.
#[test]
fn deny_wins_when_two_lists_name_the_same_root() {
	let fs = FakeFs::new(&["/work/shared/f"]);
	let fence = ContainmentFence {
		allow: vec![PathBuf::from("/work/shared")],
		deny: vec![PathBuf::from("/work/shared")],
		..ContainmentFence::default()
	};
	let plan = fence.compile_grant_plan(&fs);
	let path = PathBuf::from("/work/shared/f");

	assert!(!fence.permits_resolved(&path, FenceAccess::Read), "oracle: deny wins the tie");
	assert!(!plan.permits(&path, FenceAccess::Read), "plan must agree that deny wins");
}

/// The plan must be usable as the source of truth for the ruleset, so it has to
/// be deterministic.
#[test]
fn compilation_is_deterministic() {
	let (fs, fence) = realistic();
	let first: Vec<_> = fence.compile_grant_plan(&fs).grants;
	let second: Vec<_> = fence.compile_grant_plan(&fs).grants;
	assert_eq!(first, second);
}

/// Sanity on the shape: a realistic fence should stay in the tens of rules, not
/// the thousands.
#[test]
fn the_rule_count_stays_small() {
	let (fs, fence) = realistic();
	let plan: GrantPlan = fence.compile_grant_plan(&fs);
	// Both bounds matter. An empty plan would satisfy every "must not permit"
	// assertion in this file while confining nothing usable, so the lower bound is
	// what stops the suite passing vacuously.
	assert!(!plan.grants.is_empty(), "a fence with denies must still grant the complement");
	assert!(
		plan.grants.len() < 64,
		"expected tens of grants, got {}: {:#?}",
		plan.grants.len(),
		plan.grants
	);
}
