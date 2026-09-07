import { formatModelSelectorValue } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import type { ModelSelection } from "../components/model-selector";

/** Commit a picker selection only after persistence succeeds. */
export async function applyModelSelection(session: AgentSession, selection: ModelSelection): Promise<void> {
	const { model, thinkingLevel, selector, scope } = selection;
	const previousModel = session.model;
	const previousThinking = session.thinkingLevel;
	const previousRoles = { ...session.settings.get("modelRoles") };
	const previousRouting = session.getRoutingState();
	let switched = false;
	const role = scope === "default" ? "default" : selection.role;
	if (scope === "role" && !role) throw new Error("A role is required");
	// Validate the exact transport before changing saved assignments or conversation state.
	if (!(await session.modelRegistry.getApiKey(model, session.sessionId))) {
		throw new Error(`No API key for ${selector}`);
	}
	try {
		if (scope !== "conversation") {
			session.settings.setModelRole(role!, formatModelSelectorValue(selector, thinkingLevel));
			await session.settings.flush({ throwOnError: true });
		}
		if (scope !== "role") {
			switched = true;
			await session.setModelTemporary(model, thinkingLevel);
			session.routingCoordinator.getStateMachine().setManualPin(`${model.provider}/${model.id}`);
			session.sessionManager.appendCustomEntry("routing_event", {
				type: "routing_skipped",
				epochId: `selection-${Date.now()}`,
				reasons: ["user_model_pin"],
				state: session.getRoutingState(),
			});
			await session.sessionManager.flush();
		}
	} catch (error) {
		if (scope !== "conversation") {
			session.settings.set("modelRoles", previousRoles);
			await session.settings.flush({ throwOnError: true }).catch(() => {});
		}
		if (switched && previousModel) await session.setModelTemporary(previousModel, previousThinking);
		session.restoreRoutingState(previousRouting);
		if (switched) {
			session.sessionManager.appendCustomEntry("routing_event", {
				type: "routing_skipped",
				epochId: `selection-rollback-${Date.now()}`,
				reasons: ["user_model_pin"],
				state: previousRouting,
			});
			await session.sessionManager.flush().catch(() => {});
		}
		throw error;
	}
}
