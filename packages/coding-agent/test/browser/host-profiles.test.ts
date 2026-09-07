import { describe, expect, it } from "bun:test";
import {
	CLIENT_HOSTS,
	type ClientHost,
	DEFAULT_HOST,
	HOST_PROFILES,
	hostProfile,
	isClientHost,
} from "../../src/browser/host-profiles";

/** Substrings that must NEVER leak into a document (Office) host prompt — they
 * are Chrome-extension-only concepts that would confuse an Office assistant. */
const BROWSER_ONLY_TERMS = ["Chrome", "browser", "port 19222", "catalog_workflow_runner"] as const;

describe("host profiles", () => {
	it("exposes every ClientHost in CLIENT_HOSTS", () => {
		expect([...CLIENT_HOSTS].sort()).toEqual(["chrome", "excel", "powerpoint", "word"]);
	});

	it("has a profile for every ClientHost", () => {
		for (const host of CLIENT_HOSTS) {
			expect(HOST_PROFILES[host]).toBeDefined();
			expect(typeof HOST_PROFILES[host].systemPrompt).toBe("string");
			expect(HOST_PROFILES[host].systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("chrome is a browser profile that mentions Chrome", () => {
		const p = HOST_PROFILES.chrome;
		expect(p.kind).toBe("browser");
		expect(p.systemPrompt).toContain("Chrome");
	});

	for (const host of ["excel", "powerpoint", "word"] as const) {
		it(`${host} is a document profile that mentions its app and no browser-only terms`, () => {
			const p = HOST_PROFILES[host];
			expect(p.kind).toBe("document");
			const app = { excel: "Excel", powerpoint: "PowerPoint", word: "Word" }[host];
			expect(p.systemPrompt).toContain(app);
			for (const term of BROWSER_ONLY_TERMS) {
				expect(p.systemPrompt).not.toContain(term);
			}
		});
	}

	it("excel prompt thinks in cells/ranges/formulas", () => {
		const t = HOST_PROFILES.excel.systemPrompt;
		expect(t).toContain("workbook");
		expect(t.toLowerCase()).toContain("formula");
	});

	it("excel prompt advertises the depth-tool catalog and get_workbook_info-first prefetch", () => {
		const t = HOST_PROFILES.excel.systemPrompt;
		// Prefetch hint: discover structure first.
		expect(t).toContain("get_workbook_info");
		expect(t.toLowerCase()).toContain("first");
		// Depth tools are named so the model knows to reach for them.
		for (const name of ["read_table", "get_formulas", "get_cell_metadata", "read_named_range", "sort_filter_table"]) {
			expect(t).toContain(name);
		}
	});

	it("excel prompt tells the agent to build reports on their own tab", () => {
		// Without this the model writes a report over whatever sheet happens to be
		// active, destroying the user's data to produce it.
		const t = HOST_PROFILES.excel.systemPrompt;
		expect(t).toContain("add_sheet");
		expect(t).toContain("idempotent");
		// Filling a template is ~117 individual merged anchors; a loop of range writes is
		// the wrong shape and the prompt has to say so.
		expect(t).toContain("write_cells");
	});

	it("powerpoint prompt thinks in slides", () => {
		const t = HOST_PROFILES.powerpoint.systemPrompt;
		expect(t).toContain("presentation");
		expect(t.toLowerCase()).toContain("slide");
	});

	it("powerpoint prompt advertises the depth-tool catalog and get_presentation_info-first prefetch", () => {
		const t = HOST_PROFILES.powerpoint.systemPrompt;
		// Prefetch hint: discover structure first.
		expect(t).toContain("get_presentation_info");
		expect(t.toLowerCase()).toContain("first");
		// Depth + read/write tools are named so the model knows to reach for them.
		for (const name of [
			"read_slide_shapes",
			"read_slide_layout",
			"modify_shape_text",
			"read_slides",
			"add_text_box",
			"add_slide",
		]) {
			expect(t).toContain(name);
		}
	});

	it("word prompt thinks in the document", () => {
		const t = HOST_PROFILES.word.systemPrompt;
		expect(t).toContain("document");
	});

	it("word prompt advertises the depth-tool catalog and get_document_info-first prefetch", () => {
		const t = HOST_PROFILES.word.systemPrompt;
		// Prefetch hint: discover structure first.
		expect(t).toContain("get_document_info");
		expect(t.toLowerCase()).toContain("first");
		// Depth tools are named so the model knows to reach for them.
		for (const name of [
			"read_paragraphs",
			"read_selection",
			"get_comments",
			"get_tracked_changes",
			"insert_paragraph",
			"insert_text",
		]) {
			expect(t).toContain(name);
		}
	});

	// --- Issue #2201: host framing must be authoritative + additive ---

	/** An identity-continuity token proving the profile REAFFIRMS the base xcsh/F5
	 * role rather than replacing it. */
	const IDENTITY_CONTINUITY = /still xcsh|remain xcsh|xcsh[\s\S]*F5 Distributed Cloud/i;

	for (const host of CLIENT_HOSTS) {
		it(`${host} uses the authoritative <system-directive> tag, never the [System: pseudo-tag`, () => {
			const t = HOST_PROFILES[host].systemPrompt;
			// The `[System:]` bracket is an UNBLESSED pseudo-tag the model reads as a spoofed
			// system note (→ Office pushback). It must be gone.
			expect(t).not.toContain("[System:");
			// `<system-directive>` is the tag system-prompt.md line 11 blesses as authoritative
			// even inside a user turn.
			expect(t).toContain("<system-directive>");
			expect(t).toContain("</system-directive>");
		});

		it(`${host} is ADDITIVE — reaffirms the xcsh/F5 identity`, () => {
			const t = HOST_PROFILES[host].systemPrompt;
			expect(t).toMatch(IDENTITY_CONTINUITY);
		});
	}

	it("chrome retains its behavioral rules and keeps authentication operator-owned", () => {
		const t = HOST_PROFILES.chrome.systemPrompt;
		for (const keyword of [
			"COMMENTARY POLICY",
			"No commentary for trivial no-tool work",
			"catalog_workflow_runner",
			"DEPENDENCY ORDER",
			"port 19222",
			"authenticate directly in the browser",
			"Do NOT open new tabs",
		]) {
			expect(t).toContain(keyword);
		}
		expect(t).not.toContain("ALWAYS respond with TEXT FIRST");
		expect(t).not.toContain("login tool");
	});

	it("each doc host layers its own app context", () => {
		expect(HOST_PROFILES.excel.systemPrompt).toContain("Excel");
		expect(HOST_PROFILES.powerpoint.systemPrompt).toContain("PowerPoint");
		expect(HOST_PROFILES.word.systemPrompt).toContain("Word");
	});

	it("isClientHost accepts the wire values and rejects others", () => {
		for (const host of CLIENT_HOSTS) expect(isClientHost(host)).toBe(true);
		expect(isClientHost("outlook")).toBe(false);
		expect(isClientHost("Excel")).toBe(false);
		expect(isClientHost(null)).toBe(false);
		expect(isClientHost(undefined)).toBe(false);
		expect(isClientHost(42)).toBe(false);
	});

	it("hostProfile falls back to the DEFAULT_HOST (chrome) for null/undefined", () => {
		expect(DEFAULT_HOST).toBe("chrome");
		expect(hostProfile(null)).toBe(HOST_PROFILES.chrome);
		expect(hostProfile(undefined)).toBe(HOST_PROFILES.chrome);
		const excel: ClientHost = "excel";
		expect(hostProfile(excel)).toBe(HOST_PROFILES.excel);
	});
	for (const host of ["excel", "powerpoint", "word"] as const) {
		it(`${host} tells the agent it has native CLI tools and NO MCP/plugins`, () => {
			const prompt = HOST_PROFILES[host].systemPrompt;
			// Native tool-calling parity: the agent must know it can shell out.
			expect(prompt).toContain("bash");
			expect(prompt).toContain("az");
			expect(prompt).toContain("gh");
			// …and that its file tools are sandbox-confined to the launch dir.
			expect(prompt).toContain("confined to the folder");
			// No-MCP guidance: prevents a wasted turn hunting for an MCP server and the
			// scary "plugin manifest failed to load" narration in a live demo.
			expect(prompt).toContain("NO MCP servers");
			expect(prompt).toContain("NO plugin-provided TOOLS");
		});

		it(`${host} permits plugin RESOURCES even though plugin TOOLS are absent`, () => {
			// The earlier wording ("do not look for, read, or report on plugin/MCP
			// manifests") over-reached: it forbade the very thing an installed plugin
			// exists to provide. A pane told that cannot read a plugin's schema, run its
			// engine, or follow its slash command.
			const prompt = HOST_PROFILES[host].systemPrompt;
			expect(prompt).toContain("xcsh://plugin/");
			expect(prompt).toMatch(/Plugin RESOURCES .*ARE available/);
			expect(prompt).not.toMatch(/[Dd]o not look for, read, or report on plugin/);
		});
	}
});
