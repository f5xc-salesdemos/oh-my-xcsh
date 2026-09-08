# Vendored Rust validation repairs

The vendored crates retain their upstream package metadata, repository attribution,
and licenses. See each crate's `Cargo.toml` for its upstream source and version.

The #3765 consolidation makes the following local source repairs:

- `brush-core` 0.4.0: extract completion, expansion, assignment, and initialization
  helpers; remove unnecessary allocations and references; correct documentation.
  Seatbelt rule ordering and emitted policy remain unchanged. Mac containment
  behavior still requires validation under #3759.
- `brush-builtins` 0.1.0: use lazy futures for synchronous command implementations,
  preserving execution on polling; split option processing and factory registration.
  Standalone checks resolve the same local patched `brush-core` as the root workspace.
- `portable-pty` 0.9.0: apply reference and conversion corrections, and remove
  unreachable empty-input writing examples while retaining EOF timing.
- `tree-sitter-glimmer`: declare its standalone workspace boundary so a nested
  Git worktree does not accidentally adopt the enclosing checkout's workspace.

No lint levels are reduced. The local Rust gate discovers all standalone manifests
and deduplicates workspace members. Run `bun run check:rs` and `bun run test:rs`.

The #3717 dependency update pins `homedir` to 0.3.6. Its standalone lockfile patch
was applied exactly, after the baseline `brush-core` lint and test repairs passed.
Root and builtin lockfiles also resolve that patched dependency consistently.
