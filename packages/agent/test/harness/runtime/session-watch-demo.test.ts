import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentLane, SessionSnapshot, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { createAgentHarness } from "../../../src/harness/runtime/harness.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { deferred } from "./test-utils.ts";

describe("session watch consumer demo", () => {
	it("refreshes two dynamically created lanes from lifecycle notifications", async () => {
		const session = new StorageBackedSession(
			{ id: "session-watch-demo", createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await createAgentHarness({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
		const modelStarted = deferred();
		const releaseModel = deferred();
		let watch: WatchHandle<SessionSnapshot> | undefined;
		let mainDrive: ReturnType<AgentLane["drive"]> | undefined;
		try {
			const handle = await harness.watchSession(BACKGROUND_CONTEXT);
			watch = handle;
			let overview = handle.snapshot;
			expect(overview).toEqual({ lanes: [], faulted: false });

			// These gates pace the workload so each advertised state can be observed.
			// The consumer refreshes only inside its listener, never at workload stages.
			const observed = new Map(
				[
					"lane_created:main",
					"lane_created:worker",
					"run_start:main",
					"run_end:main",
					"run_start:worker",
					"operation_abort:worker",
					"run_end:worker",
				].map((stage) => [stage, deferred()]),
			);
			const refreshErrors: unknown[] = [];
			const stages: { event: string; lanes: { name: string; status: string | null }[] }[] = [];
			handle.start(async (event, context) => {
				if (
					event.type !== "lane_created" &&
					event.type !== "run_start" &&
					event.type !== "operation_abort" &&
					event.type !== "run_end"
				) {
					return;
				}
				const stage = `${event.type}:${event.lane}`;
				try {
					// This is a current overview, not an audit log. Resnapshot can skip
					// queued notifications; these event types do not invalidate every field.
					overview = await handle.resnapshot(context);
					stages.push({
						event: stage,
						lanes: overview.lanes.map((lane) => ({ name: lane.name, status: lane.operation?.status ?? null })),
					});
				} catch (error) {
					refreshErrors.push(error);
				} finally {
					observed.get(stage)?.resolve();
				}
			});

			async function waitForObservation(stage: string): Promise<void> {
				const gate = observed.get(stage);
				if (gate === undefined) throw new Error(`Unknown demo stage: ${stage}`);
				await gate.promise;
				// Listener exceptions are isolated by the bus, so assertions belong here.
				expect(refreshErrors).toEqual([]);
			}

			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			await waitForObservation("lane_created:main");
			const worker = await harness.lane("worker", BACKGROUND_CONTEXT);
			await waitForObservation("lane_created:worker");

			const mainAdmission = await main.accept(
				{ kind: "prompt", operationId: "main-run", prompt: "Complete the main task" },
				BACKGROUND_CONTEXT,
			);
			expect(mainAdmission).toMatchObject({ ok: true });
			await waitForObservation("run_start:main");
			// open means an accepted, unfinished operation, even before drive starts.
			expect(overview.lanes[0]?.operation).toMatchObject({ id: "main-run", kind: "run", status: "open" });
			expect(faux.state.callCount).toBe(0);
			faux.setResponses([
				async () => {
					modelStarted.resolve();
					await releaseModel.promise;
					return fauxAssistantMessage("Main task complete");
				},
			]);
			mainDrive = main.drive({ operationId: "main-run" }, BACKGROUND_CONTEXT);
			await modelStarted.promise;
			// We do not infer capturedModel freshness from the earlier run_start.
			releaseModel.resolve();
			expect(await mainDrive).toMatchObject({
				ok: true,
				value: { kind: "settled", outcome: { operationId: "main-run", status: "completed" } },
			});
			await waitForObservation("run_end:main");
			expect(overview.lanes[0]?.operation).toBeNull();

			const workerAdmission = await worker.accept(
				{ kind: "prompt", operationId: "worker-run", prompt: "Prepare a worker task" },
				BACKGROUND_CONTEXT,
			);
			expect(workerAdmission).toMatchObject({ ok: true });
			await waitForObservation("run_start:worker");
			expect(await worker.requestAbort("worker-run", BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { newlyRequested: true },
			});
			await waitForObservation("operation_abort:worker");
			expect(overview.lanes[1]?.operation).toMatchObject({ id: "worker-run", kind: "run", status: "aborting" });
			expect(await worker.drive({ operationId: "worker-run" }, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { kind: "settled", outcome: { operationId: "worker-run", status: "aborted" } },
			});
			await waitForObservation("run_end:worker");
			expect(overview.lanes[1]?.operation).toBeNull();
			expect(faux.state.callCount).toBe(1);
			expect(stages).toEqual([
				{ event: "lane_created:main", lanes: [{ name: "main", status: null }] },
				{
					event: "lane_created:worker",
					lanes: [
						{ name: "main", status: null },
						{ name: "worker", status: null },
					],
				},
				{
					event: "run_start:main",
					lanes: [
						{ name: "main", status: "open" },
						{ name: "worker", status: null },
					],
				},
				{
					event: "run_end:main",
					lanes: [
						{ name: "main", status: null },
						{ name: "worker", status: null },
					],
				},
				{
					event: "run_start:worker",
					lanes: [
						{ name: "main", status: null },
						{ name: "worker", status: "open" },
					],
				},
				{
					event: "operation_abort:worker",
					lanes: [
						{ name: "main", status: null },
						{ name: "worker", status: "aborting" },
					],
				},
				{
					event: "run_end:worker",
					lanes: [
						{ name: "main", status: null },
						{ name: "worker", status: null },
					],
				},
			]);
		} finally {
			releaseModel.resolve();
			watch?.unsubscribe();
			await harness.close(BACKGROUND_CONTEXT);
			await mainDrive?.catch(() => undefined);
			await session.close(BACKGROUND_CONTEXT);
		}
	});
});
