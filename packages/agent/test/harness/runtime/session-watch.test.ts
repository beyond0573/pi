import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HarnessClosed,
	type HarnessEvent,
	HarnessFault,
	type SessionSnapshot,
	type WatchHandle,
} from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context, createContextKey, withContextValue } from "../../../src/harness/context.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime/harness.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { Session } from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { ControlledMemoryStorage, deferred, FailingMemoryStorage } from "./test-utils.ts";

const context = BACKGROUND_CONTEXT;
const harnesses: Harness<object | undefined>[] = [];
const watches: WatchHandle<SessionSnapshot>[] = [];

async function setup(storage = new MemoryStorage(), session?: Session) {
	session ??= new StorageBackedSession(
		{ id: `session-watch-${harnesses.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("done")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const created = await createAgentHarness({ session, models, model: faux.getModel() }, context);
	if (!(created.harness instanceof Harness)) throw new Error("Expected runtime Harness");
	harnesses.push(created.harness);
	return { harness: created.harness, session, storage, faux };
}

async function watch(harness: Harness<object | undefined>) {
	const handle = await harness.watchSession(context);
	watches.push(handle);
	return handle;
}

async function holdLine(session: Session) {
	const entered = deferred();
	const release = deferred();
	const done = session.mutate(async () => {
		entered.resolve();
		await release.promise;
	}, context);
	await entered.promise;
	return { release: release.resolve, done };
}

afterEach(async () => {
	for (const handle of watches.splice(0)) handle.unsubscribe();
	for (const harness of harnesses.splice(0)) await harness.close(context);
	vi.restoreAllMocks();
});

describe("runtime Session watch", () => {
	it("captures an empty Session without creating a lane", async () => {
		const { harness, session } = await setup();
		const handle = await watch(harness);
		expect(handle.snapshot).toEqual({ lanes: [], faulted: false });
		expect(await session.branch("main", context)).toBeUndefined();
	});
	it("sorts only configured lanes by JavaScript string order and does no storage reads or commits", async () => {
		const { harness, session, storage } = await setup();
		await session.mutate(
			(mutator) => mutator.commit([storedValues.setValue(storedValues.branchTip("bare"), null)], context),
			context,
		);
		for (const name of ["é", "z", "Z", "a"]) await harness.lane(name, context);
		const calls = [
			vi.spyOn(storage, "commit"),
			vi.spyOn(storage, "scanBranch"),
			vi.spyOn(storage, "getEntries"),
			vi.spyOn(storage, "getValue"),
			vi.spyOn(storage, "readList"),
			vi.spyOn(storage, "getStats"),
		];
		const handle = await watch(harness);
		expect(handle.snapshot).toEqual({
			lanes: ["Z", "a", "z", "é"].map((name) => ({ name, tipId: null, operation: null })),
			faulted: false,
		});
		expect(await handle.resnapshot(context)).toEqual(handle.snapshot);
		for (const call of calls) expect(call).not.toHaveBeenCalled();
	});
	it("restores an open operation without driving it and isolates all snapshot layers", async () => {
		const session = new StorageBackedSession(
			{ id: "restored-session", createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
		const configuration = {
			model: { provider: "captured", modelId: "original" },
			thinkingLevel: "off" as const,
			activeToolNames: [],
		};
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.branchTip("main"), null),
						storedValues.setValue(storedValues.laneConfig("main"), configuration),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: "restored-run",
							lastOperationId: null,
							inbox: [],
						}),
						storedValues.setValue(storedValues.operationMeta("restored-run"), {
							operationId: "restored-run",
							lane: "main",
							sourceTipId: null,
							startedAt: 123,
							intent: { kind: "run", promptEntryIds: [] },
						}),
						storedValues.setValue(storedValues.operationState("restored-run"), {
							control: { status: "running" },
							settings: {
								compaction: DEFAULT_COMPACTION_SETTINGS,
								steeringMode: "all",
								followUpMode: "all",
								toolExecution: "parallel",
							},
							latestAssistantEntryId: null,
							at: "assistant.ready",
							nextAttempt: 1,
							generationContext: {
								stepId: "step",
								triggerEntryId: "trigger",
								configuration,
								streamOptions: {},
								retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
								overflowRecoveryUsed: false,
							},
						}),
						storedValues.setValue(storedValues.branchTip("worker"), null),
						storedValues.setValue(storedValues.laneConfig("worker"), configuration),
						storedValues.setValue(storedValues.laneState("worker"), {
							currentOperationId: null,
							lastOperationId: null,
							inbox: [],
						}),
					],
					context,
				),
			context,
		);
		const restored = await setup(undefined, session);
		const first = await watch(restored.harness);
		const second = await watch(restored.harness);
		const original = structuredClone(second.snapshot);
		expect(first.snapshot.lanes[0]?.operation).toMatchObject({
			id: "restored-run",
			kind: "run",
			status: "open",
			capturedModel: { provider: "captured", modelId: "original" },
		});
		first.snapshot.lanes[0]!.operation!.capturedModel!.modelId = "mutated";
		first.snapshot.lanes[0]!.operation!.id = "mutated";
		first.snapshot.lanes[0]!.name = "mutated";
		first.snapshot.lanes.length = 0;
		first.snapshot.faulted = true;
		expect(second.snapshot).toEqual(original);
		expect(await first.resnapshot(context)).toEqual(original);
		const execution = await (await restored.harness.lane("main", context)).inspectExecution(context);
		expect(execution.current).toEqual(original.lanes[0]!.operation);
		expect(execution.lastOperationId).toBeNull();
		expect(original.lanes.map((lane) => lane.name)).toEqual(["main", "worker"]);
		expect(restored.faux.state.callCount).toBe(0);
	});
	it("buffers all lanes and global events before start, preserving batches and source Context", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const source = withContextValue(createContextKey<string>("source"), "publisher", context);
		const main = await harness.lane("main", source);
		await harness.lane("worker", source);
		await main.accept({ kind: "prompt", prompt: "hello" }, source);
		await harness.setName("named", source);
		await harness.setSteeringMode("one-at-a-time", source);
		const delivered = deferred();
		const seen: HarnessEvent[] = [];
		const contexts: Context[] = [];
		handle.start((event, eventContext) => {
			seen.push(event);
			contexts.push(eventContext);
			if (event.type === "config_update") delivered.resolve();
		});
		await delivered.promise;
		expect(seen.map((event) => event.type)).toEqual([
			"lane_created",
			"lane_created",
			"run_start",
			"message_start",
			"message_end",
			"entry_added",
			"value_update",
			"config_update",
		]);
		expect(contexts.every((received) => received === source)).toBe(true);
		expect(handle.snapshot.lanes).toEqual([]);
	});
	it("captures before creation and receives exactly one creation notification", async () => {
		const { harness, session } = await setup();
		const gate = await holdLine(session);
		const pending = watch(harness);
		const created = harness.lane("worker", context);
		gate.release();
		const handle = await pending;
		await created;
		await harness.lane("worker", context);
		const seen: string[] = [];
		const done = deferred();
		handle.start((event) => {
			seen.push(event.type);
			if (event.type === "value_update") done.resolve();
		});
		await harness.setName("sentinel", context);
		await done.promise;
		expect(handle.snapshot.lanes).toEqual([]);
		expect(seen).toEqual(["lane_created", "value_update"]);
		await gate.done;
	});
	it.each(["run", "compaction", "navigation"] as const)(
		"captures %s admission, cancellation, and terminal boundaries",
		async (kind) => {
			const { harness } = await setup();
			const lane = await harness.lane("main", context);
			await harness.setCompactionSettings({ enabled: true, reserveTokens: 100, keepRecentTokens: 1 }, context);
			await lane.appendMessage({ role: "user", content: "old history ".repeat(50), timestamp: 1 }, context);
			await lane.appendMessage(fauxAssistantMessage("old answer"), context);
			await lane.appendMessage({ role: "user", content: "recent message", timestamp: 2 }, context);
			const handle = await watch(harness);
			const seen: string[] = [];
			const done = deferred();
			handle.start((event) => {
				seen.push(event.type);
				if (event.type === "value_update") done.resolve();
			});
			const admission = await lane.accept(
				kind === "run"
					? { kind: "prompt", prompt: "hello" }
					: kind === "compaction"
						? { kind: "compaction" }
						: { kind: "navigation", targetId: null },
				context,
			);
			if (!admission.ok) throw admission.error;
			const opened = await handle.resnapshot(context);
			expect(opened.lanes[0]!.operation).toEqual({
				id: admission.value.operationId,
				kind,
				status: "open",
				startedAt: admission.value.startedAt,
			});
			expect(opened.lanes[0]!.operation).toEqual((await lane.inspectExecution(context)).current);
			expect((await lane.requestAbort(admission.value.operationId, context)).ok).toBe(true);
			expect((await handle.resnapshot(context)).lanes[0]!.operation?.status).toBe("aborting");
			expect((await lane.drive({ operationId: admission.value.operationId }, context)).ok).toBe(true);
			await harness.setName("sentinel", context);
			await done.promise;
			expect((await handle.resnapshot(context)).lanes[0]!.operation).toBeNull();
			expect(seen).toContain(`${kind}_start`);
			expect(seen).toContain(`${kind}_end`);
			expect(seen).toContain("operation_abort");
			expect(opened.lanes[0]!.operation?.status).toBe("open");
		},
	);
	it("keeps a deferred suspended run open", async () => {
		const { harness, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("eventual answer")]);
		await harness.setStreamOptions({ deferred: true }, context);
		const lane = await harness.lane("main", context);
		const handle = await watch(harness);
		const suspended = deferred();
		handle.start((event) => {
			if (event.type === "run_suspend") suspended.resolve();
		});
		const result = await lane.prompt("hello", undefined, context);
		await suspended.promise;
		expect(result).toMatchObject({ ok: true, value: { status: "suspended" } });
		expect((await handle.resnapshot(context)).lanes[0]!.operation).toMatchObject({
			kind: "run",
			status: "open",
			capturedModel: { provider: "faux", modelId: "faux-1" },
		});
	});
	it("does not clear a run when its internal compaction ends", async () => {
		const { harness, faux } = await setup();
		await harness.setCompactionSettings(
			{ enabled: true, reserveTokens: faux.getModel().contextWindow, keepRecentTokens: 1 },
			context,
		);
		harness.hooks.on("before_compaction", () => ({ decline: true }));
		const providerEntered = deferred();
		const releaseProvider = deferred();
		faux.setResponses([
			async () => {
				providerEntered.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		const lane = await harness.lane("main", context);
		await lane.appendMessage({ role: "user", content: "history ".repeat(50), timestamp: 1 }, context);
		await lane.appendMessage(fauxAssistantMessage("old answer"), context);
		const handle = await watch(harness);
		const compacted = deferred();
		let compaction: HarnessEvent | undefined;
		handle.start((event) => {
			if (event.type === "compaction_end") {
				compaction = event;
				compacted.resolve();
			}
		});
		const running = lane.prompt("continue", undefined, context);
		await Promise.all([providerEntered.promise, compacted.promise]);
		const snapshot = await handle.resnapshot(context);
		expect(compaction).toMatchObject({ type: "compaction_end", reason: "threshold", status: "declined" });
		expect(snapshot.lanes[0]!.operation).toMatchObject({ kind: "run", status: "open" });
		expect(snapshot.lanes[0]!.operation).toEqual((await lane.inspectExecution(context)).current);
		releaseProvider.resolve();
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
		expect((await handle.resnapshot(context)).lanes[0]!.operation).toBeNull();
	});
	it.each(["compaction", "navigation"] as const)(
		"observes a normally completed %s without synthesizing a run",
		async (kind) => {
			const { harness } = await setup();
			const lane = await harness.lane("main", context);
			await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, context);
			const handle = await watch(harness);
			const seen: string[] = [];
			const ended = deferred();
			handle.start((event) => {
				seen.push(event.type);
				if (event.type === `${kind}_end`) ended.resolve();
			});
			const admission = await lane.accept(kind === "compaction" ? { kind } : { kind, targetId: null }, context);
			if (!admission.ok) throw admission.error;
			expect((await handle.resnapshot(context)).lanes[0]!.operation?.kind).toBe(kind);
			expect(await lane.drive({ operationId: admission.value.operationId }, context)).toMatchObject({
				ok: true,
				value: { kind: "settled", outcome: { kind, status: "completed" } },
			});
			await ended.promise;
			expect((await handle.resnapshot(context)).lanes[0]!.operation).toBeNull();
			expect(seen).toContain(`${kind}_start`);
			expect(seen).toContain(`${kind}_end`);
			expect(seen).not.toContain("run_end");
		},
	);
	it("refreshes inside a listener and drops old queued notifications while preserving boundary-after events", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const entered = deferred();
		const release = deferred();
		const refreshed = deferred();
		const done = deferred();
		const seen: string[] = [];
		let observed: SessionSnapshot | undefined;
		handle.start(async (event) => {
			if (event.type !== "lane_created") return;
			seen.push(event.lane);
			if (event.lane === "first") {
				entered.resolve();
				await release.promise;
				observed = await handle.resnapshot(context);
				refreshed.resolve();
			} else if (event.lane === "after") done.resolve();
		});
		await harness.lane("first", context);
		await entered.promise;
		await harness.lane("old", context);
		release.resolve();
		await refreshed.promise;
		await harness.lane("after", context);
		await done.promise;
		expect(observed?.lanes.map((lane) => lane.name)).toEqual(["first", "old"]);
		expect(handle.snapshot).toBe(observed);
		expect(seen).toEqual(["first", "after"]);
	});
	it("replaces the pre-start snapshot and may skip a complete operation lifecycle", async () => {
		const { harness } = await setup();
		const lane = await harness.lane("main", context);
		const handle = await watch(harness);
		expect((await lane.prompt("hello", undefined, context)).ok).toBe(true);
		const next = await handle.resnapshot(context);
		expect(next.lanes[0]!.operation).toBeNull();
		const seen: string[] = [];
		const done = deferred();
		handle.start((event) => {
			seen.push(event.type);
			done.resolve();
		});
		await harness.setName("sentinel", context);
		await done.promise;
		expect(seen).toEqual(["value_update"]);
		expect(handle.snapshot).toBe(next);
	});
	it("holds notifications published after capture until the new snapshot is installed", async () => {
		const { harness, session } = await setup();
		const handle = await watch(harness);
		const busEntered = deferred();
		const busRelease = deferred();
		harness.events.on("value_update", async () => {
			busEntered.resolve();
			await busRelease.promise;
		});
		const old = harness.setName("old", context);
		await busEntered.promise;
		const refreshing = handle.resnapshot(context);
		await session.mutate(() => undefined, context); // Capture has marked its boundary; the bus is still blocked.
		const after = harness.lane("after", context);
		await session.mutate(() => undefined, context); // Creation has published behind the boundary.
		const done = deferred();
		const seen: Array<{ type: string; snapshot: SessionSnapshot }> = [];
		handle.start((event) => {
			seen.push({ type: event.type, snapshot: handle.snapshot });
			done.resolve();
		});
		busRelease.resolve();
		const captured = await refreshing;
		await Promise.all([old, after, done.promise]);
		expect(seen).toEqual([{ type: "lane_created", snapshot: captured }]);
		expect(captured.lanes).toEqual([]);
	});
	it("buffers post-boundary events in holding phase until capture returns to the watcher", async () => {
		const { harness, session } = await setup();
		const handle = await watch(harness);
		const originalSnapshot = handle.snapshot;
		const originalMutate = session.mutate.bind(session);
		const captured = deferred();
		const releaseCapture = deferred();
		vi.spyOn(session, "mutate").mockImplementationOnce(async (callback, captureContext) => {
			const value = await originalMutate(callback, captureContext);
			captured.resolve();
			await releaseCapture.promise;
			return value;
		});
		const seen: SessionSnapshot[] = [];
		const delivered = deferred();
		handle.start(() => {
			seen.push(handle.snapshot);
			delivered.resolve();
		});
		const refreshing = handle.resnapshot(context);
		await captured.promise;
		await harness.lane("after", context); // Bus delivery after its capture barrier has completed.
		expect(seen).toEqual([]);
		expect(handle.snapshot).toBe(originalSnapshot);
		releaseCapture.resolve();
		const next = await refreshing;
		await delivered.promise;
		expect(next).not.toBe(originalSnapshot);
		expect(next.lanes).toEqual([]);
		expect(seen).toEqual([next]);
	});
	it.each([
		["run", true],
		["run", false],
		["compaction", true],
		["compaction", false],
		["navigation", true],
		["navigation", false],
	] as const)("orders %s admission and settlement against capture (capture first: %s)", async (kind, captureFirst) => {
		const storage = new ControlledMemoryStorage();
		const { harness, session } = await setup(storage);
		const lane = await harness.lane("main", context);
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, context);
		const handle = await watch(harness);
		const request =
			kind === "run"
				? { kind: "prompt" as const, prompt: "hello" }
				: kind === "compaction"
					? { kind }
					: { kind, targetId: null };
		const gate = await holdLine(session);
		const capturedAdmission = captureFirst ? handle.resnapshot(context) : undefined;
		const accepting = lane.accept(request, context);
		const capturedAfterAdmission = captureFirst ? undefined : handle.resnapshot(context);
		gate.release();
		const admission = await accepting;
		if (!admission.ok) throw admission.error;
		const admittedSnapshot = await (capturedAdmission ?? capturedAfterAdmission)!;
		if (captureFirst) expect(admittedSnapshot.lanes[0]!.operation).toBeNull();
		else
			expect(admittedSnapshot.lanes[0]!.operation).toMatchObject({
				id: admission.value.operationId,
				kind,
				status: "open",
			});
		await lane.requestAbort(admission.value.operationId, context);
		let terminalSnapshot: SessionSnapshot;
		if (captureFirst) {
			const beforeTerminal = await holdLine(session);
			const capture = handle.resnapshot(context);
			const driving = lane.drive({ operationId: admission.value.operationId }, context);
			beforeTerminal.release();
			terminalSnapshot = await capture;
			expect(terminalSnapshot.lanes[0]!.operation).toMatchObject({
				id: admission.value.operationId,
				status: "aborting",
			});
			expect((await driving).ok).toBe(true);
		} else {
			const commitEntered = deferred();
			const releaseCommit = deferred();
			storage.beforeNextCommit = async () => {
				commitEntered.resolve();
				await releaseCommit.promise;
			};
			const driving = lane.drive({ operationId: admission.value.operationId }, context);
			await commitEntered.promise;
			const capture = handle.resnapshot(context);
			releaseCommit.resolve();
			terminalSnapshot = await capture;
			expect((await driving).ok).toBe(true);
			expect(terminalSnapshot.lanes[0]!.operation).toBeNull();
		}
		expect((await handle.resnapshot(context)).lanes[0]!.operation).toBeNull();
	});
	it("rejects concurrent refresh and duplicate start without faulting, and unsubscribe wins an in-flight refresh", async () => {
		const { harness, session } = await setup();
		const handle = await watch(harness);
		const seen = vi.fn();
		handle.start(seen);
		expect(() => handle.start(seen)).toThrow("only once");
		const gate = await holdLine(session);
		const refreshing = handle.resnapshot(context);
		await expect(handle.resnapshot(context)).rejects.toThrow("already in progress");
		handle.unsubscribe();
		handle.unsubscribe();
		gate.release();
		await refreshing;
		await expect(handle.resnapshot(context)).rejects.toThrow("unsubscribed");
		const other = await watch(harness);
		const done = deferred();
		other.start(() => done.resolve());
		await harness.setName("sentinel", context);
		await done.promise;
		expect(seen).not.toHaveBeenCalled();
	});
	it("keeps watcher epochs independent and isolates mutable event payloads", async () => {
		const { harness } = await setup();
		const first = await watch(harness);
		const second = await watch(harness);
		await harness.lane("worker", context);
		await first.resnapshot(context);
		const firstSeen: string[] = [];
		const secondSeen: string[] = [];
		const firstDone = deferred();
		const secondDone = deferred();
		first.start((event) => {
			firstSeen.push(event.type);
			if (event.type === "value_update" && event.value === "session_name") {
				event.name = "mutated";
				firstDone.resolve();
			}
		});
		second.start((event) => {
			secondSeen.push(event.type === "value_update" && event.value === "session_name" ? event.name! : event.type);
			if (event.type === "value_update") secondDone.resolve();
		});
		await harness.setName("sentinel", context);
		await Promise.all([firstDone.promise, secondDone.promise]);
		expect(firstSeen).toEqual(["value_update"]);
		expect(secondSeen).toEqual(["lane_created", "sentinel"]);
	});
	it("allows a watcher to read, create a lane, unsubscribe and close from its callback", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const done = deferred();
		let result: unknown;
		let error: unknown;
		handle.start(async () => {
			try {
				await harness.getName(context);
				const lane = await harness.lane("nested", context);
				result = await lane.inspectExecution(context);
				handle.unsubscribe();
				await harness.close(context);
			} catch (caught) {
				error = caught;
			} finally {
				done.resolve();
			}
		});
		await harness.setName("trigger", context);
		await done.promise;
		expect(error).toBeUndefined();
		expect(result).toMatchObject({ lane: "nested", current: null });
	});
	it("isolates slow listeners and reports failures without recursively reporting handler_error", async () => {
		const { harness } = await setup();
		const slow = await watch(harness);
		const bad = await watch(harness);
		const observer = await watch(harness);
		const entered = deferred();
		const release = deferred();
		const caught = deferred();
		const done = deferred();
		const seen: HarnessEvent[] = [];
		slow.start(async () => {
			entered.resolve();
			await release.promise;
		});
		bad.start((event) => {
			if (event.type === "lane_created" || event.type === "handler_error") throw new Error("listener failed");
		});
		observer.start((event) => {
			seen.push(event);
			if (event.type === "handler_error") caught.resolve();
			if (event.type === "value_update") done.resolve();
		});
		await harness.lane("worker", context);
		await Promise.all([entered.promise, caught.promise]);
		await harness.setName("sentinel", context);
		await done.promise;
		release.resolve();
		expect(seen.map((event) => event.type)).toEqual(["lane_created", "handler_error", "value_update"]);
		expect(seen[1]).toMatchObject({ kind: "event", event: "lane_created", error: "listener failed" });
		expect((await observer.resnapshot(context)).faulted).toBe(false);
	});
	it("forwards an unknown lane event without inventing a lane or fault", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const done = deferred();
		const seen: HarnessEvent[] = [];
		handle.start((event) => {
			seen.push(event);
			done.resolve();
		});
		await harness.events.emit({ type: "run_start", lane: "external", runId: "external-run", startedAt: 1 }, context);
		await done.promise;
		expect(seen).toEqual([{ type: "run_start", lane: "external", runId: "external-run", startedAt: 1 }]);
		expect(await handle.resnapshot(context)).toEqual({ lanes: [], faulted: false });
	});
	it("publishes one creation under concurrent repeated acquisition", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const done = deferred();
		const seen: string[] = [];
		handle.start((event) => {
			seen.push(event.type);
			if (event.type === "value_update") done.resolve();
		});
		const lanes = await Promise.all([
			harness.lane("worker", context),
			harness.lane("worker", context),
			harness.lane("worker", context),
		]);
		await harness.setName("sentinel", context);
		await done.promise;
		expect(lanes[0]).toBe(lanes[1]);
		expect(lanes[1]).toBe(lanes[2]);
		expect(seen).toEqual(["lane_created", "value_update"]);
	});
	it.each(["watch", "resnapshot"] as const)(
		"normalizes a queued %s rejected by close to HarnessClosed",
		async (kind) => {
			const { harness, session } = await setup();
			const handle = await watch(harness);
			const gate = await holdLine(session);
			const pending = kind === "watch" ? harness.watchSession(context) : handle.resnapshot(context);
			const rejected = expect(pending).rejects.toBeInstanceOf(HarnessClosed);
			const closing = harness.close(context);
			gate.release();
			await Promise.all([rejected, closing, gate.done]);
			await expect(harness.watchSession(context)).rejects.toBeInstanceOf(HarnessClosed);
			await expect(handle.resnapshot(context)).rejects.toBeInstanceOf(HarnessClosed);
		},
	);
	it("allows an admitted capture to return its historical boundary when close follows on the line", async () => {
		const { harness, session } = await setup();
		const gate = await holdLine(session);
		const pending = watch(harness);
		let closing: Promise<void> | undefined;
		const closeOnLine = session.mutate(() => {
			closing = harness.close(context);
		}, context);
		gate.release();
		const handle = await pending;
		await closeOnLine;
		await closing;
		expect(handle.snapshot).toEqual({ lanes: [], faulted: false });
		await expect(handle.resnapshot(context)).rejects.toBeInstanceOf(HarnessClosed);
	});
	it("drains buffered events even when started after close and does not synthesize terminal events or writes", async () => {
		const { harness, storage } = await setup();
		const handle = await watch(harness);
		const lane = await harness.lane("main", context);
		await lane.accept({ kind: "prompt", prompt: "open" }, context);
		await harness.setName("last", context);
		const writes = vi.spyOn(storage, "commit");
		await harness.close(context);
		await harness.events.emit({ type: "lane_created", lane: "too-late", at: null }, context);
		const seen: string[] = [];
		const done = deferred();
		handle.start((event) => {
			seen.push(event.type);
			if (event.type === "value_update") done.resolve();
		});
		await done.promise;
		expect(seen).toEqual([
			"lane_created",
			"run_start",
			"message_start",
			"message_end",
			"entry_added",
			"value_update",
		]);
		expect(writes).not.toHaveBeenCalled();
		expect(handle.snapshot.faulted).toBe(false);
	});
	it("close returns while a callback is blocked; unsubscribe cancels callbacks that have not begun", async () => {
		const { harness } = await setup();
		const handle = await watch(harness);
		const entered = deferred();
		const release = deferred();
		const ended = deferred();
		const seen: string[] = [];
		handle.start(async (event) => {
			seen.push(event.type);
			entered.resolve();
			await release.promise;
			ended.resolve();
		});
		await harness.lane("main", context);
		await entered.promise;
		await harness.setName("queued", context);
		await harness.close(context);
		handle.unsubscribe();
		release.resolve();
		await ended.promise;
		// Released promise delivery tails drain before this next-turn sentinel.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(["lane_created"]);
	});
	it("publishes one fault, rejects further captures, and keeps old snapshots unchanged", async () => {
		const storage = new FailingMemoryStorage();
		const { harness } = await setup(storage);
		const handle = await watch(harness);
		storage.failure = new Error("durability failed");
		await expect(harness.setName("fails", context)).rejects.toBeInstanceOf(HarnessFault);
		await expect(harness.watchSession(context)).rejects.toBeInstanceOf(HarnessFault);
		await expect(harness.setName("again", context)).rejects.toBeInstanceOf(HarnessFault);
		const faults: HarnessEvent[] = [];
		const done = deferred();
		handle.start((event) => {
			faults.push(event);
			done.resolve();
		});
		await done.promise;
		expect(faults).toEqual([expect.objectContaining({ type: "fault", code: "harness_fault" })]);
		expect(handle.snapshot).toEqual({ lanes: [], faulted: false });
		await expect(handle.resnapshot(context)).rejects.toBeInstanceOf(HarnessFault);
	});
	it("reports a fault during queued refresh through HarnessFault even when its old notification is dropped", async () => {
		const storage = new ControlledMemoryStorage();
		const { harness } = await setup(storage);
		const handle = await watch(harness);
		const entered = deferred();
		const release = deferred();
		storage.beforeNextCommit = async () => {
			entered.resolve();
			await release.promise;
			throw new Error("commit failed");
		};
		const failedWrite = expect(harness.setName("fails", context)).rejects.toBeInstanceOf(HarnessFault);
		await entered.promise;
		const failedRefresh = expect(handle.resnapshot(context)).rejects.toBeInstanceOf(HarnessFault);
		release.resolve();
		await Promise.all([failedWrite, failedRefresh]);
		expect(handle.snapshot.faulted).toBe(false);
		await expect(harness.watchSession(context)).rejects.toBeInstanceOf(HarnessFault);
	});
	it("faults projection failures before installing a watcher", async () => {
		const { harness } = await setup();
		const install = vi.spyOn(harness.events, "watch");
		vi.spyOn(harness.lanesByName, "values").mockImplementationOnce(() => {
			throw new Error("invalid projection");
		});
		await expect(harness.watchSession(context)).rejects.toBeInstanceOf(HarnessFault);
		expect(install).not.toHaveBeenCalled();
		await expect(harness.watchSession(context)).rejects.toBeInstanceOf(HarnessFault);
	});
	it("captures after creation without replaying the event still blocked on the bus", async () => {
		const { harness, session } = await setup();
		const busEntered = deferred();
		const busRelease = deferred();
		harness.events.on("lane_created", async () => {
			busEntered.resolve();
			await busRelease.promise;
		});
		const gate = await holdLine(session);
		const created = harness.lane("worker", context);
		const pending = watch(harness);
		gate.release();
		await busEntered.promise;
		const handle = await pending;
		expect(handle.snapshot.lanes).toEqual([{ name: "worker", tipId: null, operation: null }]);
		const seen: string[] = [];
		const done = deferred();
		handle.start((event) => {
			seen.push(event.type);
			if (event.type === "value_update") done.resolve();
		});
		busRelease.resolve();
		await created;
		await harness.setName("sentinel", context);
		await done.promise;
		expect(seen).toEqual(["value_update"]);
	});
});
