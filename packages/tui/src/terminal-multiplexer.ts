/** True when this process is running inside a Herdr pane. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.HERDR_ENV === "1") return true;
	return Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
}

/** Detect terminal multiplexers that own the current screen grid and scrollback. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.TMUX || env.STY || env.ZELLIJ || isInsideHerdr(env)) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}
