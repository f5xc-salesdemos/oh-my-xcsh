//! Landlock confinement for spawned commands, on Linux.
//!
//! An external command opens its files in its own address space, so nothing the shell checks can
//! confine it — only the OS can. On macOS that is `sandbox-exec`; here it is Landlock, applied to the
//! forked child immediately before `execve` so the restriction is inherited by everything it runs.
//!
//! The rule set comes from [`crate::containment::ContainmentFence::compile_grant_plan`], which does the
//! hard part: Landlock is allow-only, so the fence's denies are expressed by granting their complement.
//!
//! # What this deliberately does not restrict
//!
//! Only the rights in [`handled_rights`] are governed; anything absent from `handled_access_fs` is
//! completely unrestricted, which is what keeps the fence gentle. Left out on purpose:
//!
//! - **`EXECUTE`** — handling it would mean granting exec wherever binaries live, and a denied `$HOME`
//!   would make `~/.cargo/bin/cargo` and `~/.bun/bin/bun` unrunnable. Nothing is lost by omitting it:
//!   the exec'd child inherits this same domain and still cannot read a denied file.
//! - **`IOCTL_DEV`** (ABI 5) — `TIOCSPGRP` is not in the kernel's always-allowed ioctl list, so handling
//!   it would break [`crate::sys::terminal::move_self_to_foreground`] and job control.
//! - **network rights (ABI 4) and `scoped` (ABI 6)** — the fence has no notion of ports or signal
//!   scope. Enforced structurally rather than by discipline: [`RulesetAttr`] has a single field and is
//!   passed with `size = 8`, so those fields cannot be set even by mistake.
//!
//! `REFER` is the inverse trap and is the reason ABI 1 is refused outright: cross-directory
//! `rename`/`link` is denied by the kernel whenever *any* filesystem right is handled, **even if the
//! REFER bit is absent**. Without handling and granting it, every `mv` across directories and every
//! `git` tmp-file-then-rename would fail. ABI 1 has no REFER bit, so there is no way to be gentle on it.
//!
//! Landlock does not restrict `stat`, `access` or `chdir`, so unlike the seatbelt profile this needs no
//! metadata carve-out for `git init`'s ancestor walk.
//!
//! One caveat shared with seatbelt's `subpath`: a bind mount of a denied tree under a granted one is
//! reachable. Mounting requires `CAP_SYS_ADMIN` or a user namespace, so it is not a practical escape
//! for a confined child.

use std::io;
use std::os::fd::FromRawFd;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use nix::libc;

use crate::containment::GrantPlan;

/// `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` returns the supported ABI.
const CREATE_RULESET_VERSION: u32 = 1;
/// `LANDLOCK_RULE_PATH_BENEATH`.
const RULE_PATH_BENEATH: libc::c_int = 1;

const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_READ_FILE: u64 = 1 << 2;
const ACCESS_FS_READ_DIR: u64 = 1 << 3;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
/// ABI 2. See the module docs — denied by default even when unhandled, so it must be handled.
const ACCESS_FS_REFER: u64 = 1 << 13;
/// ABI 3.
const ACCESS_FS_TRUNCATE: u64 = 1 << 14;

/// The only rights the kernel accepts on a rule whose target is not a directory.
///
/// `landlock_add_rule` returns `EINVAL` for a non-directory carrying any other right, and the fence
/// really does grant files — `~/.gitconfig` is read-only in every session. Getting this wrong is not a
/// subtle degradation: one file root made `landlock_create_ruleset` succeed and then every single
/// `add_rule` fail, so every fenced command was refused with "cannot confine". Measured, not deduced.
///
/// `EXECUTE` belongs to this set in the kernel but is never handled here, so it cannot appear.
const FILE_ONLY_RIGHTS: u64 = ACCESS_FS_READ_FILE | ACCESS_FS_WRITE_FILE | ACCESS_FS_TRUNCATE;

/// The lowest ABI this backend will use. ABI 1 cannot express `REFER`; see the module docs.
const MINIMUM_ABI: u32 = 2;

/// `struct landlock_ruleset_attr`, restricted to the one field this backend sets.
///
/// Deliberately not the full struct. The kernel infers which ABI's layout it was given from `size`, and
/// a shorter struct is accepted on every ABI — so omitting `handled_access_net` and `scoped` makes it
/// impossible to restrict networking or signal scope by accident.
#[repr(C)]
struct RulesetAttr {
	handled_access_fs: u64,
}

/// `struct landlock_path_beneath_attr`.
///
/// **Packed, and that is not cosmetic.** The UAPI header declares it `__attribute__((packed))`, so it is
/// 12 bytes; a plain `#[repr(C)]` would be 16 and the kernel would misread every rule.
#[repr(C, packed)]
struct PathBeneathAttr {
	allowed_access: u64,
	parent_fd: i32,
}

/// Why Landlock cannot be used on this machine.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unavailable {
	/// `ENOSYS`: kernel older than 5.13, or the syscall is filtered away.
	SyscallMissing,
	/// `EOPNOTSUPP`: compiled into the kernel but not in the boot-time LSM list.
	DisabledAtBoot,
	/// ABI 1 cannot handle `REFER`, so every cross-directory rename would be denied.
	AbiTooOld(u32),
	/// Some other refusal from the probe, e.g. a seccomp filter returning `EPERM`.
	Blocked(i32),
}

impl Unavailable {
	/// A short reason, for reporting the active backend to the operator.
	#[must_use]
	pub const fn reason(self) -> &'static str {
		match self {
			Self::SyscallMissing => "kernel does not provide Landlock (needs 5.13 or newer)",
			Self::DisabledAtBoot => "Landlock is not enabled in this kernel's LSM list",
			Self::AbiTooOld(_) => "Landlock ABI 1 cannot allow cross-directory rename",
			Self::Blocked(_) => "Landlock was refused by this environment",
		}
	}
}

/// Whether this process can confine children with Landlock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Availability {
	/// Usable, at the given ABI version.
	Available(u32),
	/// Not usable, for this reason.
	Unavailable(Unavailable),
}

/// Probe Landlock once per process.
///
/// `EOPNOTSUPP` gates all three Landlock syscalls identically, so a probe that succeeds is sufficient
/// evidence that `landlock_restrict_self` will work — there is no state where the version query
/// succeeds and restriction is then refused for want of the LSM. That is why this does not fork a child
/// to test enforcement for real.
pub fn availability() -> Availability {
	static PROBED: OnceLock<Availability> = OnceLock::new();
	*PROBED.get_or_init(|| {
		// SAFETY: `landlock_create_ruleset` with a null attr, size 0 and the version flag is the
		// documented way to query the supported ABI. It creates nothing and touches no memory.
		let result = unsafe {
			libc::syscall(
				libc::SYS_landlock_create_ruleset,
				std::ptr::null::<RulesetAttr>(),
				0_usize,
				CREATE_RULESET_VERSION,
			)
		};
		if result >= 0 {
			let Ok(abi) = u32::try_from(result) else {
				return Availability::Unavailable(Unavailable::Blocked(0));
			};
			if abi < MINIMUM_ABI {
				return Availability::Unavailable(Unavailable::AbiTooOld(abi));
			}
			return Availability::Available(abi);
		}
		match io::Error::last_os_error().raw_os_error() {
			Some(libc::ENOSYS) => Availability::Unavailable(Unavailable::SyscallMissing),
			Some(libc::EOPNOTSUPP) => Availability::Unavailable(Unavailable::DisabledAtBoot),
			Some(errno) => Availability::Unavailable(Unavailable::Blocked(errno)),
			None => Availability::Unavailable(Unavailable::Blocked(0)),
		}
	})
}

/// The right granted for reading file contents in a subtree.
const fn read_file_rights() -> u64 {
	ACCESS_FS_READ_FILE
}

/// The right granted for reading directory entries in a subtree.
const fn enumerate_rights() -> u64 {
	ACCESS_FS_READ_DIR
}

/// The rights granted for writing a subtree, at the given ABI.
const fn write_rights(abi: u32) -> u64 {
	let mut rights = ACCESS_FS_WRITE_FILE
		| ACCESS_FS_REMOVE_DIR
		| ACCESS_FS_REMOVE_FILE
		| ACCESS_FS_MAKE_CHAR
		| ACCESS_FS_MAKE_DIR
		| ACCESS_FS_MAKE_REG
		| ACCESS_FS_MAKE_SOCK
		| ACCESS_FS_MAKE_FIFO
		| ACCESS_FS_MAKE_BLOCK
		| ACCESS_FS_MAKE_SYM;
	if abi >= 2 {
		rights |= ACCESS_FS_REFER;
	}
	if abi >= 3 {
		rights |= ACCESS_FS_TRUNCATE;
	}
	rights
}

/// Everything the ruleset governs — exactly the union of the rights any rule can grant.
///
/// Naming a right here that no rule grants would deny it everywhere; naming one the running ABI does not
/// know makes `landlock_create_ruleset` fail with `EINVAL`. Both are why this is derived from the probed
/// ABI rather than written out.
#[must_use]
pub const fn handled_rights(abi: u32) -> u64 {
	read_file_rights() | enumerate_rights() | write_rights(abi)
}

/// Whether truncation is governed at this ABI.
///
/// `false` on ABI 2, where `truncate(2)` on a denied path is not refused. That is destruction rather
/// than disclosure, and it is not reachable through `>` (which needs `WRITE_FILE` at open), but it is a
/// real gap and is reported rather than quietly accepted.
#[must_use]
pub const fn truncate_handled(abi: u32) -> bool {
	abi >= 3
}

/// Create a granted directory so a rule can attach to it, or leave the filesystem alone.
///
/// Only called for a path the operator's policy named explicitly *and* granted write on, so creating it
/// confers nothing the fence did not already intend. Bounded deliberately, each bound answering a way this
/// could otherwise reach outside the fence:
///
/// - **Every** component is checked, from the filesystem root down, and a symlink anywhere in the chain
///   refuses the whole operation. Checking only the deepest existing ancestor was not enough: with
///   `~/.config` a link and `~/.config/gh` existing through it, the deepest existing ancestor is an
///   ordinary directory and the link goes unnoticed.
/// - Created with mode `0o700` explicitly, not the process umask. Brush has a `umask` builtin, so
///   `umask 000; some-command` would otherwise produce a world-writable `~/.aws` or `~/.kube` and let
///   another local user plant credentials or command-bearing configuration.
/// - Directories only, since a rule on a file may carry only file rights.
/// - Silent, including on failure: this runs per spawn, so a line would be noise, and a failure drops the
///   grant exactly as before.
///
/// Residual: the check and the create are not atomic, so a symlink planted in between would still be
/// followed. Closing that needs per-component `mkdirat` with `O_NOFOLLOW`. It is left because the window
/// requires write access to the operator's own home, where an attacker has better options directly.
fn create_grantable_dir(path: &Path) {
	if path.symlink_metadata().is_ok() {
		return; // It exists; `open_path` failed for another reason and creating is not the answer.
	}
	if !path.is_absolute() || components_are_link_free(path) != Some(true) {
		return;
	}
	let mut builder = std::fs::DirBuilder::new();
	builder.recursive(true);
	std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
	let _ = builder.create(path);
}

/// Whether every existing component of `path` is an ordinary directory rather than a symlink.
///
/// `None` when the answer cannot be established, which callers must treat as "do not proceed".
fn components_are_link_free(path: &Path) -> Option<bool> {
	let mut walked = std::path::PathBuf::new();
	for component in path.components() {
		walked.push(component);
		match walked.symlink_metadata() {
			Ok(metadata) => {
				let kind = metadata.file_type();
				if kind.is_symlink() {
					return Some(false);
				}
				if !kind.is_dir() {
					// A file where a directory must be: creation would fail anyway, and following it is
					// not something to attempt.
					return Some(false);
				}
			},
			// Absent from here down, which is the ordinary case for the tail being created.
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(true),
			Err(_) => return None,
		}
	}
	Some(true)
}

/// Build a Landlock ruleset from a compiled grant plan.
///
/// Every syscall that can allocate or fail informatively happens here, before `fork`. The child is left
/// with two syscalls and no allocation — see [`arm`].
///
/// A grant whose path cannot be opened is skipped rather than fatal: an enumerated entry can be a
/// dangling symlink, and a plan may name a cache directory that does not exist yet. Skipping is the
/// fail-closed direction, because an ungranted path stays denied.
pub fn build_ruleset(plan: &GrantPlan, abi: u32, creatable: &[PathBuf]) -> io::Result<OwnedFd> {
	let attr = RulesetAttr { handled_access_fs: handled_rights(abi) };
	// SAFETY: `attr` is a live `#[repr(C)]` value and the size passed is its real size, which is how
	// the kernel selects the layout it reads. The call only creates a ruleset fd.
	let raw = unsafe {
		libc::syscall(
			libc::SYS_landlock_create_ruleset,
			std::ptr::from_ref(&attr),
			std::mem::size_of::<RulesetAttr>(),
			0_u32,
		)
	};
	if raw < 0 {
		// Descriptive rather than a bare errno: this runs before `fork`, so allocating is fine here, and
		// "cannot confine: Invalid argument" tells an operator nothing about which step objected.
		return Err(io::Error::other(format!(
			"landlock_create_ruleset(handled_access_fs={:#x}, size={}) failed: {}",
			handled_rights(abi),
			std::mem::size_of::<RulesetAttr>(),
			io::Error::last_os_error()
		)));
	}
	let fd = i32::try_from(raw).map_err(|_| {
		io::Error::other(format!("landlock_create_ruleset returned an out-of-range fd: {raw}"))
	})?;
	// SAFETY: `fd` was just returned by the kernel as a fresh, owned descriptor.
	let ruleset = unsafe { OwnedFd::from_raw_fd(fd) };

	let mut granted = 0_usize;
	for (path, rights) in &plan.grants {
		let mut allowed = 0_u64;
		if rights.read {
			allowed |= read_file_rights();
		}
		if rights.enumerate {
			allowed |= enumerate_rights();
		}
		if rights.write {
			allowed |= write_rights(abi);
		}
		if allowed == 0 {
			continue;
		}
		// A granted directory that does not exist yet cannot carry a rule: Landlock attaches to an inode,
		// so `open` fails and the grant is dropped while the home deny stays in force. On a fresh home
		// that left `~/.aws`, `~/.config/gh` and the package caches unreachable *and* uncreatable, so
		// first-run and login flows failed with a bare `EACCES` (#2588). Creating it first is within the
		// authority the fence already confers — it is a path the shell is being granted write on.
		// Only a root the fence named explicitly. `plan.grants` also holds entries discovered while
		// enumerating a split directory, and recreating one of those as a *directory* — after a
		// concurrent delete, say, or mid atomic-replace — would mutate a path the operator never asked
		// to be created and could be the wrong object type entirely.
		if rights.write && creatable.iter().any(|root| root == path) && open_path(path).is_none() {
			create_grantable_dir(path);
		}
		let Some(parent) = open_path(path) else {
			continue;
		};
		let Some(kind) = file_kind(&parent) else {
			continue;
		};
		// Never grant through a symlink: the rule would land on the target's inode, which is how a link
		// in a split directory defeated the entire deny. Skipping costs nothing, because Landlock
		// evaluates the *resolved* path — `/bin/ls` is still reachable through the `/usr` grant when
		// `/bin` is a symlink into it, which is exactly the common case on a systemd distribution.
		if kind == FileKind::Symlink {
			continue;
		}
		// A rule on a file may only carry the file rights; anything else is `EINVAL`.
		if kind != FileKind::Directory {
			allowed &= FILE_ONLY_RIGHTS;
			if allowed == 0 {
				continue;
			}
		}
		let beneath = PathBeneathAttr { allowed_access: allowed, parent_fd: parent.as_raw_fd() };
		// SAFETY: `beneath` is a live packed `#[repr(C)]` value matching the UAPI layout, and
		// `parent_fd` is open for the duration of the call. The kernel copies the rule, so the
		// descriptor may be closed immediately afterwards.
		let added = unsafe {
			libc::syscall(
				libc::SYS_landlock_add_rule,
				ruleset.as_raw_fd(),
				RULE_PATH_BENEATH,
				std::ptr::from_ref(&beneath),
				0_u32,
			)
		};
		drop(parent);
		if added != 0 {
			return Err(io::Error::other(format!(
				"landlock_add_rule(allowed_access={allowed:#x}, path={}) failed: {}",
				path.display(),
				io::Error::last_os_error()
			)));
		}
		granted += 1;
	}

	// A ruleset that governs reading and grants nothing cannot run the dynamic loader, so every command
	// would die with an `EACCES` that points at nothing. Refuse to build it instead.
	if granted == 0 {
		return Err(io::Error::other(format!(
			"the fence granted nothing openable ({} planned), so no command could run",
			plan.grants.len()
		)));
	}
	Ok(ruleset)
}

/// The kind of object a descriptor refers to, as far as rule-building cares.
#[derive(Clone, Copy, Eq, PartialEq)]
enum FileKind {
	Directory,
	Symlink,
	Other,
}

/// What an `O_PATH` descriptor refers to.
///
/// Asked of the descriptor, not the path, so it describes the object the rule will actually cover and a
/// swap between asking and acting cannot change the answer.
fn file_kind(fd: &OwnedFd) -> Option<FileKind> {
	// SAFETY: `stat` is a plain C struct filled in by the kernel; a zeroed value is a valid starting
	// state, and `fstat` writes it wholly on success. The descriptor is borrowed and stays open.
	let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
	// SAFETY: `fd` is a live descriptor and `stat` is a live, correctly-typed out-parameter. `fstat` is
	// permitted on an `O_PATH` descriptor.
	if unsafe { libc::fstat(fd.as_raw_fd(), &raw mut stat) } != 0 {
		return None;
	}
	Some(match stat.st_mode & libc::S_IFMT {
		libc::S_IFDIR => FileKind::Directory,
		libc::S_IFLNK => FileKind::Symlink,
		_ => FileKind::Other,
	})
}

/// Open a path for use as a rule's `parent_fd`, or `None` if it cannot be opened.
///
/// **`O_NOFOLLOW` is load-bearing, not defensive.** A Landlock rule attaches to the inode behind the
/// descriptor, so following a symlink here grants whatever it points at. Measured before this was added:
/// a symlink sitting in a split directory and aimed at the denied home — `/home/example -> /home/alice` — was
/// enumerated as an ordinary child, granted, and resolved to the home's inode. That did not merely expose
/// the path through the link; it made `cat /home/alice/secret.txt` succeed directly. The whole deny was gone.
///
/// Split directories lose write rights on their own inode, so a *confined* command cannot plant such a
/// link itself — but one already on disk is enough, and relying on that would be relying on an accident.
fn open_path(path: &Path) -> Option<OwnedFd> {
	use std::os::unix::ffi::OsStrExt;

	let mut bytes = path.as_os_str().as_bytes().to_vec();
	if bytes.contains(&0) {
		return None;
	}
	bytes.push(0);
	// SAFETY: `bytes` is NUL-terminated and contains no interior NUL, so it is a valid C string for
	// the duration of the call. `O_PATH` opens the directory without granting access to its contents.
	let raw = unsafe {
		libc::open(
			bytes.as_ptr().cast::<libc::c_char>(),
			libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if raw < 0 {
		return None;
	}
	// SAFETY: `raw` was just returned by `open` as a fresh, owned descriptor.
	Some(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// Arrange for `cmd`'s child to confine itself to `ruleset` immediately after `fork`.
///
/// **Register this before any other `pre_exec` on the command.** `command_fds`, used by
/// [`crate::sys::commands::CommandFdInjectionExt::inject_fds`], `dup2`s onto caller-chosen descriptor
/// numbers — `exec 3< file` produces child fd 3 — and closes whatever was already there. If the ruleset
/// descriptor were one of those numbers, restriction would fail or, worse, act on an unrelated fd.
/// Restricting first removes the hazard entirely, and is safe because Landlock governs no descriptor
/// operation: `dup2` and `fcntl` are unaffected by an active domain, and `chdir` has already happened
/// by the time any closure runs.
pub fn arm(cmd: &mut std::process::Command, ruleset: OwnedFd) {
	use std::os::unix::process::CommandExt;

	// SAFETY: `restrict_self` has been kept allocation- and lock-free specifically for this hook.
	unsafe {
		cmd.pre_exec(move || restrict_self(&ruleset));
	}
}

/// Apply a prepared ruleset to the current process.
///
/// This is the shared child-side half used by ordinary commands and PTY commands. It performs exactly
/// two direct syscalls and creates only errno-backed `io::Error` values, so it is safe to call from a
/// post-fork `pre_exec` hook in a multi-threaded process. The caller must keep `ruleset` alive until
/// this function returns.
pub fn restrict_self(ruleset: &OwnedFd) -> io::Result<()> {
	// SAFETY: Both calls use constant arguments plus the live ruleset descriptor. Neither allocates,
	// takes a lock, or invokes code outside libc/the kernel.
	unsafe {
		if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
			return Err(io::Error::last_os_error());
		}
		if libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0_u32) != 0 {
			return Err(io::Error::last_os_error());
		}
	}
	Ok(())
}
