import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, logger } from "@f5-sales-demo/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";

/**
 * Minimal terminal interface for TUI
 */

// Track active terminal for emergency cleanup on crash
let activeTerminal: ProcessTerminal | null = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;
let alternateScreenActive = false;
const EMERGENCY_MOUSE_RESTORE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

/** Track alternate-screen ownership so crash cleanup does not disturb the normal screen. */
export function setAlternateScreenActive(active: boolean): void {
	alternateScreenActive = active;
}

function emergencyScreenRestoreSequence(): string {
	const sequence = `${EMERGENCY_MOUSE_RESTORE}${alternateScreenActive ? "\x1b[?1049l" : ""}`;
	alternateScreenActive = false;
	return sequence;
}

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			process.stdout.write(emergencyScreenRestoreSequence());
			terminal.showCursor();
		} else if (terminalEverStarted) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				emergencyScreenRestoreSequence() +
					"\x1b[?2004l" + // Disable bracketed paste
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[>4;0m" + // Disable modifyOtherKeys fallback
					"\x1b[?25h", // Show cursor
			);
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {
		// Terminal may already be dead during crash cleanup - ignore errors
	}
}
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
	// Start the terminal with input, resize, and host-disconnect handlers.
	start(onInput: (data: string) => void, onResize: () => void, onDisconnect?: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes, including the initial detection.
	 */
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;

	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#kittyProtocolActive = false;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: ReturnType<typeof setTimeout>;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#disconnectHandler?: () => void;
	#stdinEndHandler = () => this.#markTerminalDisconnected("stdin ended");
	#stdinCloseHandler = () => this.#markTerminalDisconnected("stdin closed");
	#stdinErrorHandler = (error: Error) => this.#markTerminalDisconnected("stdin failed", error);
	#stdoutErrorHandler = (error: Error) => this.#markTerminalDisconnected("stdout failed", error);
	#dead = false;
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#windowsVTInputRestore?: () => void;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#osc11ResponseBuffer = "";
	#pendingDa1Sentinels = 0;
	#osc11PollTimer?: Timer;
	#mode2031Active = false;
	#mode2031DebounceTimer?: Timer;
	// Capability-probe results that persist across stop()/start() cycles. After
	// the first handshake, a restart (e.g. the credential-fix ui.stop()→cooked
	// subprocess→ui.start() cycle) must re-enable protocols WITHOUT re-querying:
	// a re-query's response lands during the cooked-mode window and the terminal
	// echoes it as visible "gibberish". These flags are deliberately NOT reset in
	// stop() — they remember what we already learned about the terminal.
	#hasProbedCapabilities = false;
	#kittySupported = false;
	#modifyOtherKeysSupported = false;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void, onDisconnect?: () => void): void {
		this.#resizeHandler = onResize;
		this.#disconnectHandler = onDisconnect;

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;

		// Save previous state and enable raw mode
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.on("end", this.#stdinEndHandler);
		process.stdin.on("close", this.#stdinCloseHandler);
		process.stdin.on("error", this.#stdinErrorHandler);
		process.stdout.on("error", this.#stdoutErrorHandler);
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.#resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol.
		// The query handler intercepts input temporarily, then installs the user's handler.
		// On a restart this re-enables the protocol directly from the cached result
		// instead of re-querying (a re-query response would echo as gibberish during
		// a stop/start cooked-mode window).
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();

		// Query terminal background color via OSC 11 for dark/light detection.
		// Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
		// sequences in order, so if DA1 arrives before OSC 11 response,
		// the terminal does not support OSC 11. This avoids indefinite hangs.
		// Technique used by Neovim, bat, fish, and terminal-colorsaurus.
		//
		// Only on the FIRST start: on a restart we keep the cached appearance and
		// rely on Mode 2031 notifications / the OSC 11 poll to pick up any change,
		// so the query response can never leak during a stop/start cycle.
		if (!this.#hasProbedCapabilities) {
			this.#queryBackgroundColor();
		}

		// Subscribe to Mode 2031 appearance change notifications.
		// When the terminal reports a change, we re-query OSC 11 to get the
		// actual background color (following Neovim convention) with 100ms debounce.
		this.#safeWrite("\x1b[?2031h");

		// Start periodic OSC 11 re-query for terminals without Mode 2031
		// (Warp, Alacritty, WezTerm, iTerm2). Self-disables once Mode 2031 fires.
		this.#startOsc11Poll();

		// Capabilities are now probed; subsequent start() calls re-enable from cache.
		this.#hasProbedCapabilities = true;

		// Defer activating the user input handler until terminal capability
		// queries have settled. Without this, query responses (Kitty, DA1,
		// OSC 11) race into the editor as typed text.
		setTimeout(() => {
			this.#inputHandler = onInput;
		}, 50);
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
	 * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
	 */
	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {
			// bun:ffi unavailable or console API unsupported; keep startup non-fatal.
		}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {
			// Ignore restore errors during terminal teardown.
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	#setupStdinBuffer(): void {
		// Use the default ESC-hold window (50ms) so escape sequences fragmented
		// across stdin reads under render load reassemble instead of leaking their
		// tail as editor text (e.g. modifyOtherKeys Ctrl+C \x1b[27;5;99~).
		this.#stdinBuffer = new StdinBuffer();

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Mode 2031 DSR response: \x1b[?997;{1=dark,2=light}n
		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// OSC 11 response: \x1b]11;rgb:RR/GG/BB or rgba:RR/GG/BB, terminated by BEL or ST.
		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		// DA1 (Primary Device Attributes) response: \x1b[?...c
		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		// Forward individual sequences to the input handler
		this.#stdinBuffer.on("data", (sequence: string) => {
			// Kitty protocol response — always swallow, enable protocol on first match
			const kittyMatch = sequence.match(kittyResponsePattern);
			if (kittyMatch) {
				// Remember support so a restart can re-enable without re-querying.
				this.#kittySupported = true;
				if (!this.#kittyProtocolActive) {
					if (this.#modifyOtherKeysTimeout) {
						clearTimeout(this.#modifyOtherKeysTimeout);
						this.#modifyOtherKeysTimeout = undefined;
					}
					// A late reply (heavy first-launch startup widens the query
					// window past the 150ms fallback) can arrive after the
					// modifyOtherKeys fallback already committed. Kitty supersedes
					// it, so tear the fallback down — leaving both active breaks the
					// single-protocol encoding contract in keys.ts (#1454).
					if (this.#modifyOtherKeysActive) {
						this.#safeWrite("\x1b[>4;0m");
						this.#modifyOtherKeysActive = false;
					}
					this.#kittyProtocolActive = true;
					setKittyProtocolActive(true);
					this.#safeWrite("\x1b[>7u");
				}
				return;
			}

			// DA1 response — always swallow; manage sentinel count if pending
			if (da1ResponsePattern.test(sequence)) {
				if (this.#pendingDa1Sentinels > 0) {
					this.#pendingDa1Sentinels--;
					if (this.#osc11Pending) {
						this.#osc11Pending = false;
						this.#osc11ResponseBuffer = "";
					}
					if (this.#osc11QueryQueued && !this.#dead) {
						this.#osc11QueryQueued = false;
						this.#startOsc11Query();
					}
				}
				return;
			}

			// OSC 11 replies can be split if the stdin buffer flushes a partial sequence.
			// Accumulate fragments until the BEL/ST terminator arrives, then parse once.
			// If a new escape sequence arrives (not the ST terminator), abort buffering
			// and forward it as normal input so user keystrokes are never swallowed.
			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					// New escape sequence arrived mid-buffer — not an OSC 11 continuation.
					this.#osc11ResponseBuffer = "";
					// Fall through to normal input handling below.
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!);
					return;
				}
			}

			// Mode 2031 change notification: re-query OSC 11 with 100ms debounce
			// (Neovim convention — coalesces rapid notifications during transitions)
			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				if (!this.#mode2031Active) {
					this.#mode2031Active = true;
					this.#stopOsc11Poll();
				}
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			// Drop stale terminal responses that leaked through the stdin buffer
			// timeout flush. These are incomplete DA1/DA2 replies, OSC 11
			// fragments, or Kitty protocol responses that arrived split across
			// data events and were flushed before their terminator arrived.
			if (
				/^\x1b\[\?[\d;]*[a-z]?$/i.test(sequence) || // DA1/Kitty responses: ESC[?...
				/^\x1b\](?:11|10|4);/.test(sequence) || // OSC color responses without terminator
				/^\x1b\[>[\d;]*[a-z]?$/i.test(sequence) // DA2 responses: ESC[>...
			) {
				return;
			}

			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/**
	 * Send OSC 11 background color query followed by DA1 sentinel.
	 * DA1 avoids indefinite hangs: if DA1 response arrives before OSC 11,
	 * the terminal does not support OSC 11.
	 */
	#queryBackgroundColor(): void {
		if (this.#dead) return;
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// increment the sentinel counter, and the old DA1 arrival would then
		// prematurely clear the new query's pending state.
		if (this.#osc11Pending || this.#pendingDa1Sentinels > 0) {
			this.#osc11QueryQueued = true;
			return;
		}
		this.#startOsc11Query();
	}

	#startOsc11Query(): void {
		this.#osc11Pending = true;
		this.#osc11ResponseBuffer = "";
		this.#pendingDa1Sentinels++;
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}
	/**
	 * Parse an OSC 11 background color response and compute BT.601 luminance.
	 * Handles 1-, 2-, 3-, and 4-digit XParseColor hex components.
	 */
	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		if (mode === this.#appearance) return;
		this.#appearance = mode;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	/**
	 * Start periodic OSC 11 re-queries for terminals without Mode 2031 (Warp, Alacritty, WezTerm).
	 * Self-disables once Mode 2031 fires (push-based is better than polling).
	 */
	#startOsc11Poll(): void {
		this.#stopOsc11Poll();
		this.#osc11PollTimer = setInterval(() => {
			if (this.#dead) {
				this.#stopOsc11Poll();
				return;
			}
			this.#queryBackgroundColor();
		}, 2_000);
		this.#osc11PollTimer.unref();
	}

	#stopOsc11Poll(): void {
		if (this.#osc11PollTimer) {
			clearInterval(this.#osc11PollTimer);
			this.#osc11PollTimer = undefined;
		}
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);

		// Restart path: capabilities are already known. Re-enable the keyboard
		// protocol directly — no query means no response means nothing to echo as
		// gibberish during the cooked-mode window of a stop/start cycle.
		if (this.#hasProbedCapabilities) {
			if (this.#kittySupported) {
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				this.#safeWrite("\x1b[>7u");
			} else if (this.#modifyOtherKeysSupported) {
				this.#safeWrite("\x1b[>4;2m");
				this.#modifyOtherKeysActive = true;
			}
			return;
		}

		this.#safeWrite("\x1b[?u");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) {
				return;
			}
			this.#safeWrite("\x1b[>4;2m");
			this.#modifyOtherKeysActive = true;
			this.#modifyOtherKeysSupported = true;
		}, 150);
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		// Stop the periodic OSC 11 poll first. drainInput precedes relinquishing
		// the TTY (exit, or a cooked-mode subprocess); a poll query fired now would
		// have its response echoed as gibberish once raw mode is gone.
		this.#stopOsc11Poll();
		if (this.#kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		// Disable bracketed paste mode
		this.#safeWrite("\x1b[?2004l");

		// Disable Mode 2031 appearance change notifications
		this.#safeWrite("\x1b[?2031l");
		this.#stopOsc11Poll();
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11QueryQueued = false;
		this.#osc11ResponseBuffer = "";
		this.#pendingDa1Sentinels = 0;
		this.#mode2031Active = false;

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		this.#restoreWindowsVTInput();
		// Clean up StdinBuffer
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		process.stdin.removeListener("end", this.#stdinEndHandler);
		process.stdin.removeListener("close", this.#stdinCloseHandler);
		process.stdin.removeListener("error", this.#stdinErrorHandler);
		process.stdout.removeListener("error", this.#stdoutErrorHandler);
		this.#disconnectHandler = undefined;
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// A revoked PTY cannot be restored. Suppress that failure only after a
		// disconnect; normal live-terminal restoration failures must still surface.
		try {
			process.stdin.setRawMode?.(this.#wasRaw);
		} catch (error) {
			if (!this.#dead) throw error;
		}
	}

	#markTerminalDisconnected(reason: string, error?: unknown): void {
		if (this.#dead) return;
		this.#dead = true;
		logger.warn("terminal disconnected; stopping interactive rendering", { reason, error });

		const disconnectHandler = this.#disconnectHandler;
		this.#disconnectHandler = undefined;
		if (!disconnectHandler) return;
		try {
			disconnectHandler();
		} catch (handlerError) {
			logger.error("terminal disconnect handler failed; exiting anyway", { error: handlerError });
		}

		if (process.platform === "win32") {
			process.exit(129);
		}
		try {
			process.kill(process.pid, "SIGHUP");
		} catch (signalError) {
			logger.error("terminal disconnect signal failed; exiting directly", { error: signalError });
			process.exit(129);
		}
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	#safeWrite(data: string): void {
		if (this.#dead) return;
		try {
			process.stdout.write(data);
		} catch (err) {
			this.#markTerminalDisconnected("stdout failed", err);
		}
	}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#safeWrite(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}
}
