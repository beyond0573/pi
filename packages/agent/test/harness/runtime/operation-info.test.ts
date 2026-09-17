import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { currentOperationInfo } from "../../../src/harness/runtime/operation-info.ts";
import type {
	GenerationContext,
	LaneConfiguration,
	Operation,
	OperationScope,
	OperationState,
	SummaryContext,
} from "../../../src/harness/session/types.ts";

const scope: OperationScope = {
	control: { status: "running" },
	settings: {
		compaction: DEFAULT_COMPACTION_SETTINGS,
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: "parallel",
	},
	latestAssistantEntryId: null,
};
const meta: Operation["meta"] = {
	operationId: "run-1",
	lane: "main",
	sourceTipId: null,
	startedAt: 123,
	intent: { kind: "run", promptEntryIds: [] },
};
const configuration: LaneConfiguration = {
	model: { provider: "captured-provider", modelId: "captured-model" },
	thinkingLevel: "off",
	activeToolNames: [],
};
const generationContext: GenerationContext = {
	configuration,
	stepId: "step",
	triggerEntryId: "trigger",
	streamOptions: {},
	retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
	overflowRecoveryUsed: false,
};
const summaryContext: SummaryContext = {
	configuration,
	resultEntryId: "summary",
	streamOptions: {},
	retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
};
const task = { taskId: "task", boundary: { kind: "finish" as const } };
const retry = { nextAttempt: 2, notBefore: 789, errorMessage: "retry" };
const deferred = { stepId: "step", sourceEntryId: "source", poll: 1, configuration, streamOptions: {} };
const capturedStates: OperationState[] = [
	{ ...scope, at: "assistant.ready", generationContext, nextAttempt: 1 },
	{
		...scope,
		at: "assistant.effect_pending",
		generationContext,
		attempt: 1,
		responseEntryId: "response",
		usageId: "usage",
		intendedOutputLimit: 10,
		contextWindow: 100,
	},
	{ ...scope, at: "assistant.retry_wait", generationContext, ...retry },
	{ ...scope, at: "tools", batch: { configuration, assistantEntryId: "assistant", turnId: "turn", calls: [] } },
	{ ...scope, at: "deferred.suspended", ...deferred },
	{ ...scope, at: "deferred.effect_pending", ...deferred, responseEntryId: "response", usageId: "usage" },
	{ ...scope, at: "summary.ready", summaryContext, task, nextAttempt: 1 },
	{ ...scope, at: "summary.effect_pending", summaryContext, task, attempt: 1, usageIds: [] },
	{ ...scope, at: "summary.retry_wait", summaryContext, task, ...retry },
];

describe("currentOperationInfo", () => {
	it("returns null for an idle lane", () => {
		expect(currentOperationInfo(null)).toBeNull();
	});
	it("projects admission metadata and durable cancellation without inventing running status", () => {
		const operation: Operation = { meta, state: { ...scope, at: "starting" } };
		expect(currentOperationInfo(operation)).toEqual({ id: "run-1", kind: "run", startedAt: 123, status: "open" });
		operation.state = { ...operation.state, control: { status: "cancel_requested", requestedAt: 456 } };
		expect(currentOperationInfo(operation)).toEqual({ id: "run-1", kind: "run", startedAt: 123, status: "aborting" });
	});
	it.each(capturedStates)("copies the captured model for $at under both control states", (state) => {
		for (const control of [{ status: "running" }, { status: "cancel_requested", requestedAt: 456 }] as const) {
			const operation = structuredClone({ meta, state: { ...state, control } });
			const before = structuredClone(operation);
			const info = currentOperationInfo(operation)!;
			expect(info).toEqual({
				id: "run-1",
				kind: "run",
				startedAt: 123,
				status: control.status === "running" ? "open" : "aborting",
				capturedModel: { provider: "captured-provider", modelId: "captured-model" },
			});
			const second = currentOperationInfo(operation);
			info.id = "changed";
			info.capturedModel!.provider = "changed";
			info.capturedModel!.modelId = "changed";
			expect(operation).toEqual(before);
			expect(second?.capturedModel).toEqual({ provider: "captured-provider", modelId: "captured-model" });
			expect(currentOperationInfo(operation)).toEqual(second);
		}
	});
	it.each<OperationState>([
		{ ...scope, at: "starting" },
		{
			...scope,
			at: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: "trigger",
		},
		{ ...scope, at: "summary.deciding", task },
		{ ...scope, at: "navigation.ready_to_commit", targetId: null },
	])("does not infer a captured model for $at", (state) => {
		expect(currentOperationInfo({ meta, state })).not.toHaveProperty("capturedModel");
	});
	it.each<Operation["meta"]["intent"]>([
		{ kind: "compaction" },
		{ kind: "navigation", targetId: null, summarize: false },
	])("preserves the $kind intent", (intent) => {
		expect(currentOperationInfo({ meta: { ...meta, intent }, state: { ...scope, at: "starting" } })?.kind).toBe(
			intent.kind,
		);
	});
});
