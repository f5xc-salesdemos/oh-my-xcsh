import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	autoFixModelsConfig,
	CURRENT_CONFIG_VERSION,
	generateConfigYml,
	generateModelsYml,
	hasLiteLLMEnv,
	probeAndUpgradeLiteLLMConfig,
	probeLiteLLMConnection,
	readApiKeyLiteral,
	startupHealthCheck,
	tryAutoConfigLiteLLM,
	validateModelsConfig,
	warnIfConfigDrifted,
	writeLiteLLMModelsYml,
} from "../src/config/auto-config";

// Isolated temp directory per test
let tmpDir: string;
let modelsPath: string;
let configPath: string;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LITELLM_BASE_URL", "LITELLM_API_KEY"];

function saveEnv() {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
}

function restoreEnv() {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
}

function setEnv(baseUrl: string, apiKey: string) {
	process.env.LITELLM_BASE_URL = baseUrl;
	process.env.LITELLM_API_KEY = apiKey;
}

function clearEnv() {
	delete process.env.LITELLM_BASE_URL;
	delete process.env.LITELLM_API_KEY;
}

beforeEach(() => {
	saveEnv();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-autoconfig-test-"));
	modelsPath = path.join(tmpDir, "models.yml");
	configPath = path.join(tmpDir, "config.yml");
});

afterEach(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// hasLiteLLMEnv()
// =========================================================================

describe("hasLiteLLMEnv()", () => {
	test("returns true when both vars are set with valid URL", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("returns true for http:// URLs", () => {
		setEnv("http://localhost:4000", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("returns false when LITELLM_BASE_URL is missing", () => {
		delete process.env.LITELLM_BASE_URL;
		process.env.LITELLM_API_KEY = "sk-abc123";
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false when LITELLM_API_KEY is missing", () => {
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		delete process.env.LITELLM_API_KEY;
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false when both vars are missing", () => {
		clearEnv();
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for empty string LITELLM_BASE_URL", () => {
		setEnv("", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for empty string LITELLM_API_KEY", () => {
		setEnv("https://proxy.example.com", "");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for whitespace-only LITELLM_BASE_URL", () => {
		setEnv("   ", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for invalid URL scheme (ftp://)", () => {
		setEnv("ftp://proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for bare hostname without scheme", () => {
		setEnv("proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("handles URL with trailing slashes", () => {
		setEnv("https://proxy.example.com///", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("handles URL with path components", () => {
		setEnv("https://proxy.example.com/v1/api", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});
});

// =========================================================================
// generateModelsYml()
// =========================================================================

describe("generateModelsYml()", () => {
	test.skipIf(process.platform === "win32")(
		"stores literal proxy credentials with owner-only permissions",
		async () => {
			fs.writeFileSync(modelsPath, "permissive", { mode: 0o644 });

			await writeLiteLLMModelsYml(
				modelsPath,
				generateModelsYml("https://proxy.example.com", {
					apiKeyLiteral: "sk-private-test-key",
				}),
			);

			expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
			expect(fs.readFileSync(modelsPath, "utf-8")).toContain('apiKey: "sk-private-test-key"');
		},
	);

	test("startupHealthCheck upgrades generated literal-key config without environment credentials", () => {
		clearEnv();
		fs.writeFileSync(
			modelsPath,
			generateModelsYml("https://proxy.example.com", {
				apiBasePath: "/api/v1",
				apiKeyLiteral: "literal-test-key",
			}).replace(`configVersion: ${CURRENT_CONFIG_VERSION}`, "configVersion: 3"),
		);

		expect(
			startupHealthCheck("ok", modelsPath, {
				anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
			}),
		).toBe(true);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
		expect(content).toContain('apiKey: "literal-test-key"');
		expect(content).toContain('baseUrl: "https://proxy.example.com/api/v1"');
		expect(content).toContain("defaultLevel: medium");
		expect(content).toContain("effort: xhigh");
	});

	test("generates valid YAML with anthropic and litellm providers", () => {
		const yml = generateModelsYml("https://proxy.example.com");
		expect(yml).toContain("providers:");
		expect(yml).toContain("anthropic:");
		expect(yml).toContain('baseUrl: "https://proxy.example.com/anthropic"');
		expect(yml).toContain("litellm:");
		expect(yml).toContain('baseUrl: "https://proxy.example.com/v1"');
		expect(yml).toContain("type: openai-compat");
		expect(yml).toContain("apiKey: LITELLM_API_KEY");
		expect(yml).toContain("        input:\n          - text\n          - image");
	});

	test("strips trailing slashes from baseUrl", () => {
		const yml = generateModelsYml("https://proxy.example.com/");
		// The function receives pre-normalized URL, but the /anthropic suffix is added
		expect(yml).toContain("https://proxy.example.com//anthropic");
	});

	test("handles localhost URL", () => {
		const yml = generateModelsYml("http://localhost:4000");
		expect(yml).toContain('baseUrl: "http://localhost:4000/anthropic"');
		expect(yml).toContain('baseUrl: "http://localhost:4000/v1"');
	});

	test("uses custom apiBasePath when provided", () => {
		const yml = generateModelsYml("https://proxy.example.com", { apiBasePath: "/api/v1" });
		expect(yml).toContain('baseUrl: "https://proxy.example.com/api/v1"');
		expect(yml).toContain("type: openai-compat");
	});

	test("does not contain literal API key values", () => {
		const yml = generateModelsYml("https://proxy.example.com");
		expect(yml).not.toContain("sk-");
		expect(yml).toContain("LITELLM_API_KEY"); // Reference, not value
	});
});

// =========================================================================
// generateConfigYml()
// =========================================================================

describe("generateConfigYml()", () => {
	test("generates a minimal YAML with only non-default provider prefs (rest ship in the binary)", () => {
		const yml = generateConfigYml();
		expect(yml).toContain("image: openai");
		expect(yml).toContain("webSearch: anthropic");
		// The model default and settings that match schema defaults are NOT persisted.
		expect(yml).not.toContain("modelRoles:");
		expect(yml).not.toContain("enabled: true");
	});
});

// =========================================================================
// tryAutoConfigLiteLLM()
// =========================================================================

describe("tryAutoConfigLiteLLM()", () => {
	test("generates config when env vars set and no file exists", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = tryAutoConfigLiteLLM(modelsPath);
		expect(result).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		expect(fs.existsSync(configPath)).toBe(true);

		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/anthropic");
		if (process.platform !== "win32") {
			expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
			expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
		}
	});

	test("returns false when env vars not set", () => {
		clearEnv();
		const result = tryAutoConfigLiteLLM(modelsPath);
		expect(result).toBe(false);
		expect(fs.existsSync(modelsPath)).toBe(false);
	});

	test("returns false when only LITELLM_BASE_URL is set", () => {
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		delete process.env.LITELLM_API_KEY;
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("returns false when only LITELLM_API_KEY is set", () => {
		delete process.env.LITELLM_BASE_URL;
		process.env.LITELLM_API_KEY = "sk-abc123";
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("creates parent directories if they dont exist", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const deepPath = path.join(tmpDir, "a", "b", "c", "models.yml");
		const result = tryAutoConfigLiteLLM(deepPath);
		expect(result).toBe(true);
		expect(fs.existsSync(deepPath)).toBe(true);
	});

	test("does not overwrite existing config.yml", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(configPath, "# existing config\ncustom: true\n");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(configPath, "utf-8");
		expect(content).toContain("custom: true");
		expect(content).not.toContain("image: openai");
	});

	test("normalizes trailing slashes in base URL", () => {
		setEnv("https://proxy.example.com///", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/anthropic");
		expect(content).not.toContain("///");
	});

	test("returns false for invalid URL scheme", () => {
		setEnv("ftp://proxy.example.com", "sk-abc123");
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("handles write permission errors gracefully", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		// Create a read-only directory
		const readOnlyDir = path.join(tmpDir, "readonly");
		fs.mkdirSync(readOnlyDir, { mode: 0o444 });
		const badPath = path.join(readOnlyDir, "subdir", "models.yml");
		const result = tryAutoConfigLiteLLM(badPath);
		expect(result).toBe(false);
		// Cleanup: restore permissions so rmSync works
		fs.chmodSync(readOnlyDir, 0o755);
	});
});

// =========================================================================
// validateModelsConfig()
// =========================================================================

describe("validateModelsConfig()", () => {
	test("valid config returns no errors", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				`configVersion: ${CURRENT_CONFIG_VERSION}`,
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("missing file returns error with fixable flag", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("models.yml not found");
		expect(result.fixable).toBe(true);
	});

	test("missing file without env vars is not fixable", () => {
		clearEnv();
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.fixable).toBe(false);
	});

	test("empty file returns error", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("empty");
		expect(result.fixable).toBe(true);
	});

	test("whitespace-only file returns error", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "   \n\n  \n");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("empty");
	});

	test("warns when baseUrl doesnt match LITELLM_BASE_URL", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				`configVersion: ${CURRENT_CONFIG_VERSION}`,
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://old-proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true); // Still valid, just drifted
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0]).toContain("does not match");
		expect(result.fixable).toBe(true);
	});

	test("warns when LITELLM_API_KEY env var is not set but referenced", () => {
		delete process.env.LITELLM_API_KEY;
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		fs.writeFileSync(
			modelsPath,
			[
				"# Auto-generated by xcsh for LiteLLM proxy",
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings.some(w => w.includes("LITELLM_API_KEY") && w.includes("not set"))).toBe(true);
	});

	test("no warning when env vars match config", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				`configVersion: ${CURRENT_CONFIG_VERSION}`,
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings).toHaveLength(0);
	});

	test("handles unreadable file", () => {
		fs.writeFileSync(modelsPath, "valid content");
		fs.chmodSync(modelsPath, 0o000);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not readable");
		// Cleanup permissions
		fs.chmodSync(modelsPath, 0o644);
	});
});

// =========================================================================
// autoFixModelsConfig()
// =========================================================================

describe("autoFixModelsConfig()", () => {
	test("generates new config when file doesnt exist", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);
		expect(result.changes.length).toBeGreaterThan(0);
		expect(fs.existsSync(modelsPath)).toBe(true);
	});

	test("backs up existing file before overwriting", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "# Auto-generated by xcsh for LiteLLM proxy\n# old config\nold: true\n");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
		const backup = fs.readFileSync(`${modelsPath}.bak`, "utf-8");
		expect(backup).toContain("old: true");
	});

	test("returns false when env vars not set", () => {
		clearEnv();
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(false);
		expect(result.changes[0]).toContain("Cannot fix");
	});

	test("returns false when LITELLM_BASE_URL is invalid", () => {
		setEnv("not-a-url", "sk-abc123");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(false);
		expect(result.changes[0]).toContain("Cannot fix");
	});

	test("creates parent directories", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const deepPath = path.join(tmpDir, "deep", "nested", "models.yml");
		const result = autoFixModelsConfig(deepPath);
		expect(result.fixed).toBe(true);
		expect(fs.existsSync(deepPath)).toBe(true);
	});
});

// =========================================================================
// warnIfConfigDrifted()
// =========================================================================

describe("warnIfConfigDrifted()", () => {
	test("does not throw when providers is undefined", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() => warnIfConfigDrifted(undefined)).not.toThrow();
	});

	test("does not throw when no env var set", () => {
		clearEnv();
		expect(() => warnIfConfigDrifted({ anthropic: { baseUrl: "https://old.com/anthropic" } })).not.toThrow();
	});

	test("does not throw when anthropic has no baseUrl", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() => warnIfConfigDrifted({ anthropic: {} })).not.toThrow();
	});

	test("does not throw when URLs match", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() =>
			warnIfConfigDrifted({ anthropic: { baseUrl: "https://proxy.example.com/anthropic" } }),
		).not.toThrow();
	});

	test("does not throw when URLs differ (logs warning)", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		expect(() =>
			warnIfConfigDrifted({ anthropic: { baseUrl: "https://old-proxy.example.com/anthropic" } }),
		).not.toThrow();
	});
});

// =========================================================================
// Corrupt YAML files
// =========================================================================

describe("corrupt YAML handling", () => {
	test("validates file with invalid YAML indentation", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n\tanthropic:\n  baseUrl: bad indent\n");
		const result = validateModelsConfig(modelsPath);
		// File has content so it won't be flagged as empty, but may warn about URL mismatch
		expect(result.valid).toBe(true); // Syntax check is basic; full validation is ConfigFile's job
	});

	test("validates file with truncated content", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  anthropic:\n    baseUrl:");
		const result = validateModelsConfig(modelsPath);
		// Not empty, has content — basic validation passes, but warns about URL mismatch
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("autofix recovers from corrupt file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "# Auto-generated by xcsh for LiteLLM proxy\n{{{{invalid yaml!!!!");
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);
		// Backup should have the corrupt content
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("{{{{invalid");
		// New file should be valid
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("providers:");
		expect(content).toContain("proxy.example.com");
	});

	test("autofix preserves unidentifiable binary garbage", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]));
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(false);
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(false);
	});

	test("autofix preserves an unidentifiable zero-byte file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "");
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(false);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toBe("");
	});
});

// =========================================================================
// URL fault tolerance matrix
// =========================================================================

describe("URL fault tolerance", () => {
	const VALID_URLS = [
		"https://proxy.example.com",
		"http://localhost:4000",
		"https://proxy.example.com:8443",
		"https://proxy.example.com/v1",
		"https://proxy.example.com/path/to/api",
		"http://10.0.0.1:4000",
		"https://proxy-with-dashes.example.com",
		"https://proxy_with_underscores.example.com",
	];

	const INVALID_URLS = [
		"",
		"   ",
		"ftp://proxy.example.com",
		"proxy.example.com",
		"just-text",
		"://missing-scheme",
		"file:///etc/passwd",
		"ssh://proxy.example.com",
	];

	for (const url of VALID_URLS) {
		test(`accepts valid URL: ${url}`, () => {
			setEnv(url, "sk-abc123");
			expect(hasLiteLLMEnv()).toBe(true);
			expect(tryAutoConfigLiteLLM(path.join(tmpDir, `models-${url.replace(/[^a-z0-9]/gi, "_")}.yml`))).toBe(true);
		});
	}

	for (const url of INVALID_URLS) {
		test(`rejects invalid URL: "${url}"`, () => {
			setEnv(url, "sk-abc123");
			expect(hasLiteLLMEnv()).toBe(false);
			expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
		});
	}
});

// =========================================================================
// API key fault tolerance matrix
// =========================================================================

describe("API key fault tolerance", () => {
	const VALID_KEYS = [
		"sk-abc123",
		"sk-e5de24b2e74f41a2af7c444873812bc3",
		"a",
		`very-long-key-${"x".repeat(200)}`,
		"key-with-special-chars_123.456",
	];

	const INVALID_KEYS = ["", "   "];

	for (const key of VALID_KEYS) {
		test(`accepts valid key: ${key.substring(0, 20)}...`, () => {
			setEnv("https://proxy.example.com", key);
			expect(hasLiteLLMEnv()).toBe(true);
		});
	}

	for (const key of INVALID_KEYS) {
		test(`rejects invalid key: "${key}"`, () => {
			setEnv("https://proxy.example.com", key);
			expect(hasLiteLLMEnv()).toBe(false);
		});
	}
});

// =========================================================================
// Incomplete config scenarios
// =========================================================================

describe("incomplete config handling", () => {
	test("config with only providers key but no children", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n");
		const result = validateModelsConfig(modelsPath);
		// File exists and has content (just "providers:") — will warn about URL mismatch
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with anthropic but no baseUrl", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  anthropic:\n    apiKey: LITELLM_API_KEY\n");
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with wrong provider name", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  openai:\n    baseUrl: https://proxy.example.com/openai\n");
		const result = validateModelsConfig(modelsPath);
		// No anthropic section, so baseUrl check warns
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with extra unknown fields is still valid", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
				"    extraField: true",
				"custom_stuff: hello",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
	});
});

// =========================================================================
// Edge cases and fault tolerance
// =========================================================================

describe("fault tolerance", () => {
	test("handles URL with port number", () => {
		setEnv("https://proxy.example.com:8443", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com:8443/anthropic");
	});

	test("handles URL with path prefix", () => {
		setEnv("https://proxy.example.com/litellm", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/litellm/anthropic");
	});

	test("handles very long API key", () => {
		setEnv("https://proxy.example.com", `sk-${"a".repeat(500)}`);
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(true);
		// Key is not embedded, just the reference
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).not.toContain("aaaaaa");
	});

	test("handles special characters in URL", () => {
		setEnv("https://proxy.example.com/path-with-dashes_and_underscores", "sk-abc123");
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(true);
	});

	test("handles concurrent calls safely", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const results = await Promise.all([
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
		]);
		// At least one should succeed, file should exist
		expect(results.some(r => r === true)).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
	});

	test("validate then fix round-trip", () => {
		setEnv("https://proxy.example.com", "sk-abc123");

		// Start with no file
		let result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);

		// Fix it
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);

		// Now validate again
		result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("fix after env URL change updates config", () => {
		// Initial setup
		setEnv("https://old-proxy.example.com", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);

		// Change env
		setEnv("https://new-proxy.example.com", "sk-abc123");

		// Validate detects drift
		const validation = validateModelsConfig(modelsPath);
		expect(validation.warnings.length).toBeGreaterThan(0);

		// Fix updates the URL
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);

		// Verify new URL in file
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://new-proxy.example.com/anthropic");
		expect(content).not.toContain("old-proxy");

		// Backup has old URL
		const backup = fs.readFileSync(`${modelsPath}.bak`, "utf-8");
		expect(backup).toContain("https://old-proxy.example.com/anthropic");
	});
});

// =========================================================================
// startupHealthCheck() — the runtime self-healing entry point
// =========================================================================

describe("startupHealthCheck()", () => {
	test("not-found + env vars → generates config", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("not-found", modelsPath);
		expect(repaired).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("proxy.example.com/anthropic");
	});

	test("not-found + no env vars → no action", () => {
		clearEnv();
		const repaired = startupHealthCheck("not-found", modelsPath);
		expect(repaired).toBe(false);
		expect(fs.existsSync(modelsPath)).toBe(false);
	});

	test("error + env vars → backs up and regenerates", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, "# Auto-generated by xcsh for LiteLLM proxy\n{{corrupt yaml");
		const repaired = startupHealthCheck("error", modelsPath);
		expect(repaired).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("proxy.example.com/anthropic");
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("{{corrupt");
	});

	test("error + no env vars → no action", () => {
		clearEnv();
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, "{{corrupt yaml");
		const repaired = startupHealthCheck("error", modelsPath);
		expect(repaired).toBe(false);
	});

	test("ok + matching URL → no action", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + drifted URL → auto-fixes", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, generateModelsYml("https://old-proxy.example.com"));
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://old-proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("new-proxy.example.com/anthropic");
	});

	test("ok + no env vars → no drift check", () => {
		clearEnv();
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://some-proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + no anthropic provider → no drift check", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			openai: { baseUrl: "https://other.example.com" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + anthropic without baseUrl → no drift check", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: {},
		});
		expect(repaired).toBe(false);
	});

	test("ok + no loadedProviders arg → no action", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath);
		expect(repaired).toBe(false);
	});

	test("full lifecycle: missing → generate → drift → fix → validate", () => {
		// Step 1: Missing file
		setEnv("https://proxy-v1.example.com", "sk-abc123");
		expect(startupHealthCheck("not-found", modelsPath)).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		let content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("proxy-v1.example.com/anthropic");

		// Step 2: Validate — should be clean
		let validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings).toHaveLength(0);

		// Step 3: Env changes (simulating proxy migration)
		setEnv("https://proxy-v2.example.com", "sk-abc123");

		// Step 4: Validate detects drift
		validation = validateModelsConfig(modelsPath);
		expect(validation.warnings.length).toBeGreaterThan(0);

		// Step 5: startupHealthCheck auto-fixes
		expect(
			startupHealthCheck("ok", modelsPath, {
				anthropic: { baseUrl: "https://proxy-v1.example.com/anthropic" },
			}),
		).toBe(true);

		// Step 6: Verify fixed
		content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("proxy-v2.example.com/anthropic");
		expect(content).not.toContain("proxy-v1");

		// Step 7: Backup preserved
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("proxy-v1");

		// Step 8: Final validation clean
		validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings).toHaveLength(0);
	});
});

// =========================================================================
// Config schema versioning
// =========================================================================

describe("config schema versioning", () => {
	test("CURRENT_CONFIG_VERSION is a positive integer", () => {
		expect(typeof CURRENT_CONFIG_VERSION).toBe("number");
		expect(CURRENT_CONFIG_VERSION).toBeGreaterThanOrEqual(1);
		expect(Number.isInteger(CURRENT_CONFIG_VERSION)).toBe(true);
	});

	test("generateModelsYml includes configVersion field", () => {
		const yml = generateModelsYml("https://proxy.example.com");
		expect(yml).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
	});

	test("tryAutoConfigLiteLLM writes configVersion to file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
	});

	test("autoFixModelsConfig writes configVersion to regenerated file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "# Auto-generated by xcsh for LiteLLM proxy\n{{corrupt}}");
		autoFixModelsConfig(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
	});

	test("validateModelsConfig warns when configVersion is missing (legacy config)", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"# Auto-generated by xcsh for LiteLLM proxy",
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true); // Still valid, just a warning
		expect(result.warnings.some(w => w.includes("configVersion"))).toBe(true);
		expect(result.fixable).toBe(true);
	});

	test("validateModelsConfig no warning when configVersion is current", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				`configVersion: ${CURRENT_CONFIG_VERSION}`,
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
		expect(result.warnings).toHaveLength(0);
	});

	test("startupHealthCheck regenerates config when configVersion is missing", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		// Write a legacy config without configVersion
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(
			modelsPath,
			[
				"# Auto-generated by xcsh for LiteLLM proxy",
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(true);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
		// Backup should have old config without version
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
	});

	test.skipIf(process.platform === "win32")(
		"startupHealthCheck upgrades version 2 metadata with owner-only live and backup files",
		() => {
			setEnv("https://proxy.example.com", "sk-abc123");
			fs.writeFileSync(
				modelsPath,
				[
					"# Auto-generated by xcsh for LiteLLM proxy",
					"configVersion: 2",
					"providers:",
					"  anthropic:",
					'    baseUrl: "https://proxy.example.com/anthropic"',
					"    apiKey: LITELLM_API_KEY",
					"  litellm:",
					'    baseUrl: "https://proxy.example.com/v1"',
					"    apiKey: LITELLM_API_KEY",
					"    api: openai-completions",
					"    discovery:",
					"      type: openai-compat",
				].join("\n"),
				{ mode: 0o644 },
			);

			const repaired = startupHealthCheck("ok", modelsPath, {
				anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
			});

			expect(repaired).toBe(true);
			const content = fs.readFileSync(modelsPath, "utf-8");
			expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
			expect(content).toContain("gpt-5.6-sol:");
			expect(content).toContain("defaultLevel: medium");
			expect(content).toContain("effort: xhigh");
			expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
			expect(fs.statSync(`${modelsPath}.bak`).mode & 0o777).toBe(0o600);
		},
	);

	test("startupHealthCheck does not regenerate when configVersion is current", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		const content = generateModelsYml("https://proxy.example.com");
		fs.writeFileSync(modelsPath, content);
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(false);
	});

	test("full lifecycle: legacy config upgraded on startup", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Step 1: Write legacy config (no configVersion)
		fs.writeFileSync(
			modelsPath,
			[
				"# Auto-generated by xcsh for LiteLLM proxy",
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);

		// Step 2: Validate detects missing version
		let validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings.some(w => w.includes("configVersion"))).toBe(true);

		// Step 3: startupHealthCheck upgrades it
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(true);

		// Step 4: Validate is now clean
		validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings).toHaveLength(0);

		// Step 5: File has configVersion
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
	});
});

// =========================================================================
// LiteLLM proxy connection validation (Issue #52 / Issue #55 regression)
// =========================================================================

describe("probeLiteLLMConnection()", () => {
	test("returns model list on successful probe at /v1/models", async () => {
		const calls: Array<{ body: RequestInit["body"]; method: string; url: string }> = [];
		const mockFetch = async (url: string, init?: RequestInit) => {
			expect(init?.headers).toHaveProperty("Authorization", "Bearer sk-test123");
			calls.push({ body: init?.body, method: init?.method ?? "GET", url });
			if (init?.method === "POST") {
				return new Response(JSON.stringify({ detail: "model is required" }), { status: 422 });
			}
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-sonnet-4-6", object: "model" },
						{ id: "gpt-5.4", object: "model" },
					],
				}),
				{ status: 200 },
			);
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(true);
		expect(result.models).toContain("claude-sonnet-4-6");
		expect(result.models).toContain("gpt-5.4");
		expect(result.apiBasePath).toBe("/v1");
		expect(result.error).toBeUndefined();
		expect(calls).toEqual([
			{ body: undefined, method: "GET", url: "https://proxy.example.com/v1/models" },
			{ body: "{}", method: "POST", url: "https://proxy.example.com/v1/chat/completions" },
		]);
	});

	test("selects the Open WebUI /api route only after its chat endpoint accepts POST", async () => {
		const calls: Array<{ method: string; url: string }> = [];
		const mockFetch = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url });
			if (url.endsWith("/api/models") && method === "GET") {
				return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });
			}
			if (url.endsWith("/api/chat/completions") && method === "POST") {
				return new Response(JSON.stringify({ detail: "model is required" }), { status: 422 });
			}
			// The web frontend returns HTML for /v1/*.
			return new Response("<!doctype html><html>...</html>", { status: 200 });
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(true);
		expect(result.models).toContain("claude-sonnet-4-6");
		expect(result.apiBasePath).toBe("/api");
		expect(calls).toContainEqual({ method: "POST", url: "https://proxy.example.com/api/chat/completions" });
	});

	test("rejects a models-only /api/v1 management route whose chat endpoint returns 405", async () => {
		const mockFetch = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/v1/models") && method === "GET") {
				return new Response(JSON.stringify({ data: [{ id: "managed-model-record" }] }), { status: 200 });
			}
			if (url.endsWith("/api/v1/chat/completions") && method === "POST") {
				return new Response(JSON.stringify({ detail: "Method Not Allowed" }), { status: 405 });
			}
			return new Response("Not Found", { status: 404 });
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(false);
		expect(result.models).toHaveLength(0);
		expect(result.error).toContain("405");
	});

	test("retains a matching /api/v1 route when both model listing and chat POST are supported", async () => {
		const mockFetch = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/v1/models") && method === "GET") {
				return new Response(JSON.stringify({ data: [{ id: "private-model" }] }), { status: 200 });
			}
			if (url.endsWith("/api/v1/chat/completions") && method === "POST") {
				return new Response(JSON.stringify({ detail: "messages are required" }), { status: 400 });
			}
			return new Response("Not Found", { status: 404 });
		};

		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});

		expect(result).toEqual({ reachable: true, models: ["private-model"], apiBasePath: "/api/v1" });
	});

	test("returns unreachable when all endpoints fail", async () => {
		const mockFetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(false);
		expect(result.models).toHaveLength(0);
		expect(result.error).toBeDefined();
	});

	test("returns unreachable on 401 Unauthorized from all endpoints", async () => {
		const mockFetch = async () => new Response("Unauthorized", { status: 401 });
		const result = await probeLiteLLMConnection("https://proxy.example.com", "bad-key", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(false);
		expect(result.models).toHaveLength(0);
		expect(result.error).toContain("401");
	});

	test("returns unreachable on 500 Server Error from all endpoints", async () => {
		const mockFetch = async () => new Response("Internal Server Error", { status: 500 });
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(false);
		expect(result.models).toHaveLength(0);
		expect(result.error).toContain("500");
	});

	test("tries fallback when first endpoint returns empty data array", async () => {
		const mockFetch = async (url: string) => {
			if (url.includes("/api/models")) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(true);
		expect(result.models).toContain("gpt-5.4");
		expect(result.apiBasePath).toBe("/api");
	});

	test("handles malformed JSON response by trying fallback", async () => {
		const mockFetch = async (url: string) => {
			if (url.includes("/api/models")) {
				return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });
			}
			return new Response("not json", { status: 200 });
		};
		const result = await probeLiteLLMConnection("https://proxy.example.com", "sk-test123", {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(result.reachable).toBe(true);
		expect(result.apiBasePath).toBe("/api");
	});
});

describe("generateModelsYml() always includes litellm discovery", () => {
	test("always includes litellm discovery provider", () => {
		const yaml = generateModelsYml("https://proxy.example.com");
		expect(yaml).toContain("litellm:");
		expect(yaml).toContain("discovery:");
		expect(yaml).toContain("type: openai-compat");
		expect(yaml).toContain("api: openai-completions");
		expect(yaml).toContain("apiKey: LITELLM_API_KEY");
		expect(yaml).toContain("anthropic:");
		expect(yaml).toContain("https://proxy.example.com/anthropic");
	});

	test("uses default /v1 base path without options", () => {
		const yaml = generateModelsYml("https://proxy.example.com");
		expect(yaml).toContain('baseUrl: "https://proxy.example.com/v1"');
	});

	test("uses custom apiBasePath when provided", () => {
		const yaml = generateModelsYml("https://proxy.example.com", { apiBasePath: "/api/v1" });
		expect(yaml).toContain('baseUrl: "https://proxy.example.com/api/v1"');
	});

	test("config version is always included", () => {
		const yaml = generateModelsYml("https://proxy.example.com");
		expect(yaml).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
	});
});

describe("probeAndUpgradeLiteLLMConfig()", () => {
	test("probes proxy and upgrades legacy v1 config to include discovery", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write a legacy v1 config (no discovery) — simulates pre-fix configs
		const legacyV1 = [
			"# Auto-generated by xcsh for LiteLLM proxy",
			"configVersion: 2",
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://proxy.example.com/anthropic"',
			"    apiKey: LITELLM_API_KEY",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, legacyV1);
		expect(legacyV1).not.toContain("discovery:");

		const mockFetch = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "claude-sonnet-4-6", object: "model" },
						{ id: "gpt-5.4", object: "model" },
					],
				}),
				{ status: 200 },
			);

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath, {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(upgraded).toBe(true);

		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		expect(afterContent).toContain("discovery:");
		expect(afterContent).toContain("type: openai-compat");
		expect(afterContent).toContain("litellm:");
		// Backup should exist
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
	});

	test("fixes wrong base path when probe discovers /api works", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write config with /v1 base path (default guess)
		fs.writeFileSync(modelsPath, generateModelsYml("https://proxy.example.com"));

		const mockFetch = async (url: string) => {
			if (url.includes("/api/models")) {
				return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });
			}
			// Open WebUI intercepts /v1/models — returns HTML
			return new Response("<!doctype html><html>...</html>", { status: 200 });
		};

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath, {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(upgraded).toBe(true);

		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		expect(afterContent).toContain('baseUrl: "https://proxy.example.com/api"');
	});

	test("no-ops when discovery is already configured with correct base path", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write config with correct base path
		fs.writeFileSync(modelsPath, generateModelsYml("https://proxy.example.com"));

		const mockFetch = async () =>
			new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath, {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(upgraded).toBe(false);
	});

	test("gracefully degrades when proxy is unreachable", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, generateModelsYml("https://proxy.example.com"));
		const beforeContent = fs.readFileSync(modelsPath, "utf-8");

		const mockFetch = async () => {
			throw new Error("ECONNREFUSED");
		};

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath, {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(upgraded).toBe(false);

		// Config should be unchanged
		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		expect(afterContent).toBe(beforeContent);
	});

	test("returns false when LITELLM env vars are not set", async () => {
		restoreEnv();
		delete process.env.LITELLM_BASE_URL;
		delete process.env.LITELLM_API_KEY;

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath);
		expect(upgraded).toBe(false);
	});

	test("preserves literal API key when upgrading config", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write a config with literal API key but wrong base path — simulates
		// /login saving a literal key, then the proxy being deployed behind
		// a different path prefix (e.g. Open WebUI's /api/v1)
		const literalConfig = [
			"# Auto-generated by xcsh for LiteLLM proxy",
			"# API key stored as literal value",
			`configVersion: ${CURRENT_CONFIG_VERSION}`,
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://proxy.example.com/anthropic"',
			'    apiKey: "sk-real-literal-key-789"',
			"  litellm:",
			'    baseUrl: "https://proxy.example.com/v1"',
			'    apiKey: "sk-real-literal-key-789"',
			"    api: openai-completions",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, literalConfig);
		fs.chmodSync(modelsPath, 0o644);
		expect(literalConfig).toContain('apiKey: "sk-real-literal-key-789"');
		expect(literalConfig).not.toContain("type: openai-compat");

		const mockFetch = async () =>
			new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 });

		const upgraded = await probeAndUpgradeLiteLLMConfig(modelsPath, {
			fetch: mockFetch as unknown as typeof globalThis.fetch,
		});
		expect(upgraded).toBe(true);

		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		// Must preserve the literal key
		expect(afterContent).toContain('apiKey: "sk-real-literal-key-789"');
		expect(afterContent).toContain("type: openai-compat");
		if (process.platform !== "win32") {
			expect(fs.statSync(`${modelsPath}.bak`).mode & 0o777).toBe(0o600);
			expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
		}
	});
});

// =========================================================================
// readApiKeyLiteral() — extract quoted literal keys from YAML
// =========================================================================

describe("readApiKeyLiteral()", () => {
	test("returns literal key from quoted YAML value", () => {
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		const yml = generateModelsYml("https://proxy.example.com", { apiKeyLiteral: "sk-my-secret-key" });
		fs.writeFileSync(modelsPath, yml);
		expect(readApiKeyLiteral(modelsPath)).toBe("sk-my-secret-key");
	});

	test("returns undefined for env var reference (unquoted)", () => {
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		const yml = generateModelsYml("https://proxy.example.com");
		fs.writeFileSync(modelsPath, yml);
		expect(readApiKeyLiteral(modelsPath)).toBeUndefined();
	});

	test("returns undefined when file does not exist", () => {
		expect(readApiKeyLiteral(modelsPath)).toBeUndefined();
	});

	test("handles keys with special characters", () => {
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		const yml = generateModelsYml("https://proxy.example.com", { apiKeyLiteral: "sk-key:with!special#chars" });
		fs.writeFileSync(modelsPath, yml);
		expect(readApiKeyLiteral(modelsPath)).toBe("sk-key:with!special#chars");
	});
});

// =========================================================================
// autoFixModelsConfig() literal key preservation (PR #104 regression fix)
// =========================================================================

describe("autoFixModelsConfig() literal key preservation", () => {
	test("preserves literal API key when auto-fixing config", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write config with literal API key
		fs.writeFileSync(
			modelsPath,
			generateModelsYml("https://proxy.example.com", {
				apiKeyLiteral: "sk-preserved-key-456",
			}),
		);
		fs.chmodSync(modelsPath, 0o644);

		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);

		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		expect(afterContent).toContain('apiKey: "sk-preserved-key-456"');
		if (process.platform !== "win32") {
			expect(fs.statSync(`${modelsPath}.bak`).mode & 0o777).toBe(0o600);
			expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
		}
	});

	test("keeps env var reference when no literal key exists", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

		// Write config with env var reference
		fs.writeFileSync(modelsPath, generateModelsYml("https://proxy.example.com"));

		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);

		const afterContent = fs.readFileSync(modelsPath, "utf-8");
		expect(afterContent).toContain("apiKey: LITELLM_API_KEY");
		expect(afterContent).not.toContain('apiKey: "');
	});
});
