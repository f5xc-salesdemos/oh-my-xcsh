import {
	type Component,
	Container,
	Input,
	type MouseRoutable,
	matchesKey,
	padding,
	replaceTabs,
	type SgrMouseEvent,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@f5-sales-demo/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo } from "../../session/session-manager";
import { fuzzyFilter } from "../../utils/fuzzy";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	readonly #searchInput: Input;
	onSelect?: (sessionPath: string) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	#hitRows: (number | undefined)[] = [];

	onDeleteRequest?: (session: SessionInfo) => void;

	constructor(
		private readonly allSessions: SessionInfo[],
		private readonly showCwd = false,
		private readonly getTerminalRows: () => number = () => 24,
	) {
		this.#filteredSessions = allSessions;
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			if (this.#filteredSessions[this.#selectedIndex]) {
				const selected = this.#filteredSessions[this.#selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.path);
				}
			}
		};
	}

	#maxVisible(): number {
		return Math.max(2, Math.floor((this.getTerminalRows() - 13) / 4));
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	handleWheel(delta: -1 | 1): void {
		this.#selectedIndex = Math.max(0, Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + delta));
	}

	selectAndConfirm(index: number): void {
		const session = this.#filteredSessions[index];
		if (!session) return;
		this.#selectedIndex = index;
		this.onSelect?.(session.path);
	}

	#filterSessions(query: string): void {
		this.#filteredSessions = fuzzyFilter(this.allSessions, query, session => {
			const parts = [
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.allMessagesText,
				session.path,
			];
			return parts.filter(Boolean).join(" ");
		});
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	removeSession(sessionPath: string): void {
		const index = this.allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.allSessions.splice(index, 1);
		// Re-filter to update filteredSessions
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selectedIndex if we deleted the last item or beyond
		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#filteredSessions.length === 0) {
			if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling
		const maxVisible = this.#maxVisible();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredSessions.length);

		// Render visible sessions (2-3 lines per session + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const rowStart = lines.length;
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("chromeAccent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = width - cursorWidth; // Account for cursor width

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				lines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				lines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				lines.push(messageLine);
			}

			// Metadata line: date + message count
			const modified = formatDate(session.modified);
			const msgCount = `${session.messageCount} message${session.messageCount !== 1 ? "s" : ""}`;
			const metadata = `  ${modified} ${theme.sep.dot} ${msgCount}`;
			const metadataLine = theme.fg("dim", truncateToWidth(metadata, width));

			lines.push(metadataLine);
			for (let row = rowStart; row < lines.length; row++) this.#hitRows[row] = i;
			lines.push(""); // Blank separator is intentionally not clickable.
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.#filteredSessions.length) {
			const scrollText = `  (${this.#selectedIndex + 1}/${this.#filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width));
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Delete key - request delete confirmation from parent
		if (matchesKey(keyData, "delete")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}

		// Up arrow
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		// Down arrow
		if (matchesKey(keyData, "down")) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible());
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#maxVisible());
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.path);
			}
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions {
	fillHeight?: boolean;
	getTerminalRows?: () => number;
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent extends Container implements MouseRoutable {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#messageContainer: Container;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	#listLineOffset = 0;
	#footerStart = 0;
	readonly #fillHeight: boolean;
	readonly #getTerminalRows: () => number;
	readonly #bottomBorder = new DynamicBorder();

	constructor(
		sessions: SessionInfo[],
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		onDelete?: (session: SessionInfo) => Promise<boolean>,
		options: SessionSelectorOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = onDelete;
		this.#fillHeight = options.fillHeight ?? false;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list
		this.#sessionList = new SessionList(sessions, false, this.#getTerminalRows);
		this.#sessionList.onSelect = onSelect;
		this.#sessionList.onCancel = onCancel;
		this.#sessionList.onExit = onExit;
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		this.addChild(this.#sessionList);
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			if (this.#confirmationDialog && child === this.#sessionList) continue;
			if (child === this.#sessionList) this.#listLineOffset = lines.length;
			lines.push(...child.render(width));
		}
		const footer = [
			"",
			theme.fg("muted", "  [Del to delete, Enter to select, Esc to cancel]"),
			"",
			...this.#bottomBorder.render(width),
		];
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else while (lines.length < target) lines.push("");
		}
		this.#footerStart = lines.length;
		lines.push(...footer);
		return lines;
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				// Close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
			() => {
				// Cancel - close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
		);
		// Show confirmation dialog
		this.addChild(this.#confirmationDialog);
	}

	handleInput(keyData: string): void {
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	routeMouse(event: SgrMouseEvent, _line: number, _col: number): void {
		if (this.#confirmationDialog) return;
		if (event.wheel !== null) {
			this.#sessionList.handleWheel(event.wheel);
			return;
		}
		if (!event.leftClick || event.row >= this.#footerStart) return;
		const index = this.#sessionList.hitTest(event.row - this.#listLineOffset);
		if (index !== undefined) this.#sessionList.selectAndConfirm(index);
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
