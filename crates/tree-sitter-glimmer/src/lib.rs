//! Glimmer grammar for tree-sitter (vendored with scanner fix).
//!
//! The published crate (0.0.1) has a bug where `scanner.c` is not compiled
//! by its `build.rs`, causing undefined symbol errors at runtime. This
//! vendored copy fixes that by compiling both `parser.c` and `scanner.c`.

use tree_sitter::Language;

extern "C" {
	fn tree_sitter_glimmer() -> Language;
}

/// Get the tree-sitter [Language][] for this grammar.
///
/// [Language]: https://docs.rs/tree-sitter/*/tree_sitter/struct.Language.html
pub fn language() -> Language {
	unsafe { tree_sitter_glimmer() }
}

/// The content of the [`node-types.json`][] file for this grammar.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers#static-node-types
pub const NODE_TYPES: &str = include_str!("node-types.json");

#[cfg(test)]
mod tests {
	#[test]
	fn test_can_load_grammar() {
		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&super::language())
			.expect("Error loading Glimmer grammar");
	}
}
