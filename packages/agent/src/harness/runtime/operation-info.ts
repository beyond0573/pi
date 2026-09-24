import type { CurrentOperationInfo, ModelIdentity } from "../agent-harness.ts";
import type { Operation } from "../session/types.ts";

export function currentOperationInfo(operation: Operation | null): CurrentOperationInfo | null {
	if (operation === null) return null;
	const { state } = operation;
	let capturedModel: ModelIdentity | undefined;
	switch (state.at) {
		case "assistant.ready":
		case "assistant.effect_pending":
		case "assistant.retry_wait":
			capturedModel = state.generationContext.configuration.model;
			break;
		case "tools":
			capturedModel = state.batch.configuration.model;
			break;
		case "deferred.suspended":
		case "deferred.effect_pending":
			capturedModel = state.configuration.model;
			break;
		case "summary.ready":
		case "summary.effect_pending":
		case "summary.retry_wait":
			capturedModel = state.summaryContext.configuration.model;
			break;
	}
	return {
		id: operation.meta.operationId,
		kind: operation.meta.intent.kind,
		startedAt: operation.meta.startedAt,
		status: operation.state.control.status === "cancel_requested" ? "aborting" : "open",
		...(capturedModel === undefined ? {} : { capturedModel: { ...capturedModel } }),
	};
}
