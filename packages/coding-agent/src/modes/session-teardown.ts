import { logger } from "@f5-sales-demo/pi-utils";

export interface SessionTeardownDeps {
	getDraftText: () => string;
	beginDispose: () => void;
	saveDraft: (text: string) => Promise<void>;
	disposeSession: () => Promise<void>;
}

export type SessionTeardown = () => Promise<void>;

/** Build a one-shot teardown shared by interactive and postmortem exits. */
export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (): Promise<void> => {
		const draft = deps.getDraftText();
		deps.beginDispose();
		try {
			await deps.saveDraft(draft);
		} catch (error) {
			logger.warn("Failed to save session draft during teardown", { error: String(error) });
		}
		await deps.disposeSession();
	};
	return () => (pending ??= run());
}
