import { type Component, matchesKey, routeSgrMouseInput, truncateToWidth, visibleWidth } from "@f5-sales-demo/pi-tui";
import type { SessionMessageEntry } from "../../session/session-manager";
import { getHyperlinkPolicyGeneration } from "../../tui/hyperlink";
import { highlightCode, theme } from "../theme/theme";
import { buildCopyTargets, type CopyBlock, type CopyTarget, initialCopyEntries } from "../utils/copy-targets";

export interface CopySelectorDeps {
	requestRender: () => void;
	onPick: (content: string, label: string) => void | Promise<void>;
	onOpen?: (href: string, label: string) => void;
	onCancel: () => void;
	viewportRows?: () => number;
	initialHistoryTruncated?: boolean;
	loadAllEntries?: () => readonly SessionMessageEntry[];
}

interface ControlRegion {
	action: "copy" | "open";
	blockIndex: number;
	start: number;
	end: number;
}

const INITIAL_ENTRIES = 600;
const CONTENT_TOP = 2;
const CHROME_ROWS = 3;
const PREVIEW_LINES = 12;
const themeIdentities = new WeakMap<object, number>();
let nextThemeIdentity = 1;

function themeIdentity(): number {
	const value = theme as object;
	let identity = themeIdentities.get(value);
	if (identity === undefined) {
		identity = nextThemeIdentity++;
		themeIdentities.set(value, identity);
	}
	return identity;
}

function preview(text: string): string {
	return text.replace(/\s+/gu, " ").trim() || "(empty)";
}

export class CopySelectorComponent implements Component {
	readonly #allEntries: readonly SessionMessageEntry[];
	readonly #deps: CopySelectorDeps;
	#targets: CopyTarget[];
	#truncated: boolean;
	#requiresAllHistory: boolean;
	#selected = 0;
	#blocks: CopyBlock[] | undefined;
	#blockSelected = 0;
	#scrollOffset = 0;
	#maxScrollOffset = 0;
	#ensureSelectionVisible = true;
	#controls = new Map<number, ControlRegion[]>();
	#cache = new Map<string, { rows: string[]; controls: Map<number, ControlRegion[]>; selectedRow: number }>();
	#disposed = false;

	constructor(entries: readonly SessionMessageEntry[], deps: CopySelectorDeps) {
		this.#allEntries = entries;
		this.#deps = deps;
		const initial = initialCopyEntries(entries, INITIAL_ENTRIES, deps.initialHistoryTruncated);
		this.#truncated = initial.truncated;
		this.#requiresAllHistory = initial.requiresAllHistory;
		this.#targets = buildCopyTargets(initial.entries);
		this.#selected = Math.max(0, this.#targets.length - 1);
	}

	get targetCount(): number {
		return this.#targets.length;
	}

	get canLoadEarlier(): boolean {
		return this.#truncated;
	}

	get touchedEntryCount(): number {
		return this.#requiresAllHistory
			? INITIAL_ENTRIES
			: this.#targets.reduce((count, target) => count + target.entries.length, 0);
	}

	invalidate(): void {
		this.#cache.clear();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cache.clear();
		this.#controls.clear();
	}

	#loadAll(): void {
		if (!this.#truncated) return;
		const selectedId = this.#targets[this.#selected]?.id;
		this.#targets = buildCopyTargets(this.#deps.loadAllEntries?.() ?? this.#allEntries);
		this.#selected = selectedId
			? Math.max(
					0,
					this.#targets.findIndex(target => target.id === selectedId),
				)
			: 0;
		this.#truncated = false;
		this.#requiresAllHistory = false;
		this.#blocks = undefined;
		this.#scrollOffset = 0;
		this.#ensureSelectionVisible = true;
		this.invalidate();
		this.#deps.requestRender();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					const before = this.#scrollOffset;
					this.#scrollOffset = Math.max(0, Math.min(this.#maxScrollOffset, this.#scrollOffset + event.wheel * 3));
					if (before !== this.#scrollOffset) this.#deps.requestRender();
					return true;
				}
				if (event.leftClick) this.#click(event.row, event.col);
				return true;
			});
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#blocks) {
				this.#blocks = undefined;
				this.#blockSelected = 0;
				this.#scrollOffset = 0;
				this.#deps.requestRender();
			} else {
				this.#deps.onCancel();
			}
			return;
		}
		if ((data === "a" || data === "A") && !this.#blocks) return this.#loadAll();
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const delta = matchesKey(data, "up") ? -1 : 1;
			if (this.#blocks) {
				this.#blockSelected = Math.max(0, Math.min(this.#blocks.length - 1, this.#blockSelected + delta));
			} else {
				this.#selected = Math.max(0, Math.min(this.#targets.length - 1, this.#selected + delta));
			}
			this.#ensureSelectionVisible = true;
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(data, "right") && !this.#blocks) {
			const blocks = this.#targets[this.#selected]?.blocks;
			if (blocks?.length) {
				this.#blocks = blocks;
				this.#blockSelected = 0;
				this.#scrollOffset = 0;
				this.#ensureSelectionVisible = true;
				this.#deps.requestRender();
			}
			return;
		}
		if (matchesKey(data, "left") && this.#blocks) {
			this.#blocks = undefined;
			this.#scrollOffset = 0;
			this.#ensureSelectionVisible = true;
			this.#deps.requestRender();
			return;
		}
		if ((data === "o" || data === "O") && this.#blocks) {
			const block = this.#blocks[this.#blockSelected];
			if (block?.href) this.#deps.onOpen?.(block.href, block.label);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#blocks) {
				const block = this.#blocks[this.#blockSelected];
				if (block) void this.#deps.onPick(block.content, block.label);
			} else {
				const target = this.#targets[this.#selected];
				if (target)
					void this.#deps.onPick(
						target.content || target.blocks.map(block => block.content).join("\n\n"),
						target.label,
					);
			}
		}
	}

	#click(row: number, col: number): void {
		if (!this.#blocks) return;
		const absoluteRow = row - CONTENT_TOP + this.#scrollOffset;
		const region = this.#controls.get(absoluteRow)?.find(item => col >= item.start && col < item.end);
		if (!region) return;
		const block = this.#blocks[region.blockIndex];
		if (!block) return;
		this.#blockSelected = region.blockIndex;
		if (region.action === "open" && block.href) this.#deps.onOpen?.(block.href, block.label);
		else void this.#deps.onPick(block.content, block.label);
	}

	#targetRows(width: number): string[] {
		return this.#targets.map((target, index) => {
			const marker = index === this.#selected ? theme.fg("success", "▶") : " ";
			return truncateToWidth(` ${marker} ${target.label} · ${preview(target.content)}`, width);
		});
	}

	#blockRows(width: number): { rows: string[]; selectedRow: number } {
		const target = this.#targets[this.#selected];
		if (!target || !this.#blocks) return { rows: [], selectedRow: 0 };
		const key = `${target.id}:${this.#blockSelected}:${width}:${themeIdentity()}:${getHyperlinkPolicyGeneration()}`;
		const cached = this.#cache.get(key);
		if (cached) {
			this.#controls = new Map(cached.controls);
			return { rows: cached.rows, selectedRow: cached.selectedRow };
		}
		const rows: string[] = [];
		let selectedRow = 0;
		this.#controls.clear();
		for (let index = 0; index < this.#blocks.length; index++) {
			const block = this.#blocks[index]!;
			const marker = index === this.#blockSelected ? theme.fg("success", "▶") : " ";
			const copy = "⧉ copy";
			const open = block.href ? "  ↗ open" : "";
			const caption = ` ${marker} ${index + 1}/${this.#blocks.length} ${block.label}  ${copy}${open}`;
			const captionRow = rows.length;
			if (index === this.#blockSelected) selectedRow = captionRow;
			rows.push(truncateToWidth(caption, width));
			const copyStart = visibleWidth(` ${marker} ${index + 1}/${this.#blocks.length} ${block.label}  `);
			const controls: ControlRegion[] = [
				{ action: "copy", blockIndex: index, start: copyStart, end: copyStart + visibleWidth(copy) },
			];
			if (block.href) {
				const start = copyStart + visibleWidth(copy) + 2;
				controls.push({ action: "open", blockIndex: index, start, end: start + visibleWidth("↗ open") });
			}
			this.#controls.set(captionRow, controls);
			const previewRows = block.language ? highlightCode(block.content, block.language) : block.content.split("\n");
			for (const line of previewRows.slice(0, PREVIEW_LINES)) rows.push(truncateToWidth(`   ${line}`, width));
			if (previewRows.length > PREVIEW_LINES)
				rows.push(theme.fg("dim", `   … +${previewRows.length - PREVIEW_LINES} more lines`));
		}
		this.#cache.set(key, { rows, controls: new Map(this.#controls), selectedRow });
		return { rows, selectedRow };
	}

	render(width: number): string[] {
		const height = Math.max(3, (this.#deps.viewportRows?.() ?? process.stdout.rows ?? 40) - CHROME_ROWS);
		const blockModel = this.#blocks ? this.#blockRows(width) : undefined;
		let rows = blockModel?.rows ?? this.#targetRows(width);
		if (this.#requiresAllHistory)
			rows = [theme.fg("dim", " Earlier turn exceeds the 600-entry preview; press a to load all history.")];
		this.#maxScrollOffset = Math.max(0, rows.length - height);
		const selectedRow = this.#requiresAllHistory ? 0 : (blockModel?.selectedRow ?? this.#selected);
		if (this.#ensureSelectionVisible) {
			if (selectedRow < this.#scrollOffset) this.#scrollOffset = selectedRow;
			else if (selectedRow >= this.#scrollOffset + height) this.#scrollOffset = selectedRow - height + 1;
			this.#ensureSelectionVisible = false;
		}
		this.#scrollOffset = Math.min(this.#scrollOffset, this.#maxScrollOffset);
		const visible = rows.slice(this.#scrollOffset, this.#scrollOffset + height);
		const hint = this.#blocks
			? " ↑/↓ block  ←/esc back  enter/click copy  o/click open"
			: ` ↑/↓ target  → blocks  enter copy  ${this.#truncated ? "a earlier history  " : ""}esc close`;
		return [
			theme.bold(" Copy transcript"),
			theme.fg("dim", "────────────────────────────────"),
			...visible,
			theme.fg("dim", truncateToWidth(hint, width)),
		];
	}
}
