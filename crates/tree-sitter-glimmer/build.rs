fn main() {
	let src_dir = std::path::Path::new("src");

	let mut c_config = cc::Build::new();
	c_config.std("c11").include(src_dir);

	#[cfg(target_env = "msvc")]
	c_config.flag("-utf-8");

	let parser_path = src_dir.join("parser.c");
	c_config.file(&parser_path);
	println!("cargo:rerun-if-changed={}", parser_path.to_str().unwrap());

	// FIX: The published crate 0.0.1 has this block commented out, causing
	// undefined symbol errors for the external scanner functions on platforms
	// using single-pass linkers (e.g., GNU ld during aarch64 cross-compilation).
	let scanner_path = src_dir.join("scanner.c");
	c_config.file(&scanner_path);
	println!("cargo:rerun-if-changed={}", scanner_path.to_str().unwrap());

	// Vendored code: suppress warnings.
	c_config.cargo_warnings(false);

	c_config.compile("tree-sitter-glimmer");
}
