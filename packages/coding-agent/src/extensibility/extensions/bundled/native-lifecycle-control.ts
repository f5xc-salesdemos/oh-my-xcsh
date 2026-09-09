import { postmortem } from "@f5-sales-demo/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "@f5-sales-demo/xcsh";

export const NATIVE_LIFECYCLE_CONTROL_FLAG = "--native-lifecycle-control";
export const NATIVE_LIFECYCLE_CONTINUATION_TITLE = "Native lifecycle continuation";

type NativeLifecycleControl = "await-user";

let activeManagedCancellation: ((reason: string) => void) | undefined;

/**
 * Abort an acceptance prompt at its real ExtensionUIController signal boundary.
 * The protocol-22 reporter also aborts the AgentSession through its current
 * ExtensionContext; this hook only owns the interactive prompt that would
 * otherwise remain open while the session cancellation unwinds.
 */
export function requestNativeLifecycleCancellation(reason: string): boolean {
	if (!activeManagedCancellation) return false;
	activeManagedCancellation(reason);
	return true;
}

function configuredControl(pi: ExtensionAPI): NativeLifecycleControl | undefined {
	const value = pi.getFlag(NATIVE_LIFECYCLE_CONTROL_FLAG);
	return value === "await-user" ? value : undefined;
}

/**
 * Explicit acceptance-only control loaded from the compiled XCSH bundle.
 *
 * The extension is inert unless its registered flag is present.  It asks through
 * the ordinary interactive ExtensionUiController, so TurnPhaseController and the
 * bundled reporter observe the same awaiting-user boundary as any other native
 * extension prompt.  SIGINT aborts that prompt and the active AgentSession; it
 * never manufactures a turn-phase or semantic-journal frame.
 */
export default function nativeLifecycleControl(pi: ExtensionAPI): void {
	pi.registerFlag(NATIVE_LIFECYCLE_CONTROL_FLAG, {
		type: "string",
		description: "Acceptance-only native lifecycle control (supported: await-user)",
	});

	let activeController: AbortController | undefined;
	let activeContext: ExtensionContext | undefined;
	let removeSigintInterceptor: (() => void) | undefined;

	const onSigint = (): void => {
		activeController?.abort("native lifecycle SIGINT");
		activeContext?.abort();
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		if (configuredControl(pi) !== "await-user") return;
		if (!ctx.hasUI) {
			ctx.abort();
			throw new Error("--native-lifecycle-control await-user requires interactive mode");
		}

		const controller = new AbortController();
		activeController = controller;
		activeContext = ctx;
		const managedCancellation = (reason: string): void => {
			controller.abort(reason);
		};
		activeManagedCancellation = managedCancellation;
		removeSigintInterceptor = postmortem.interceptSignal(postmortem.Reason.SIGINT, () => {
			onSigint();
			return true;
		});
		try {
			const continuation = await ctx.ui.input(NATIVE_LIFECYCLE_CONTINUATION_TITLE, "Enter the continuation label", {
				signal: controller.signal,
			});
			if (continuation === undefined) {
				ctx.abort();
				return;
			}
			return {
				message: {
					customType: "native-lifecycle-continuation",
					content: `Native lifecycle continuation: ${continuation}`,
					display: false,
				},
			};
		} finally {
			if (activeManagedCancellation === managedCancellation) activeManagedCancellation = undefined;
			removeSigintInterceptor?.();
			removeSigintInterceptor = undefined;
			activeController = undefined;
			activeContext = undefined;
		}
	});

	pi.on("session_shutdown", () => {
		activeManagedCancellation = undefined;
		removeSigintInterceptor?.();
		removeSigintInterceptor = undefined;
		activeController?.abort("native lifecycle shutdown");
		activeController = undefined;
		activeContext = undefined;
	});
}
