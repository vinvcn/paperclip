import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerUsageRequestRetentionWork } from "../services/usage-request-retention-work.js";

const state = vi.hoisted(() => ({
  cleanup: vi.fn(async () => 0),
  next: vi.fn<() => Promise<number | null>>(),
}));
vi.mock("../services/usage-request-retention.js", () => ({
  usageRequestRetentionService: () => ({ cleanupExpired: state.cleanup, nextRetentionDeadline: state.next }),
}));
let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => {
  await coordinator?.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("sweeps on its deadline, stays quiet between obligations, and re-probes after each run", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  state.next.mockResolvedValue(null);
  const worker = registerUsageRequestRetentionWork(owner as unknown as Db, coordinator, () => true);
  await worker.ready;
  expect(coordinator.nextWakeAt()).toBeNull();
  const initial = state.cleanup.mock.calls.length;
  // With no deadline the worker stays quiet; only the deadline probe ran once.
  await vi.advanceTimersByTimeAsync(300_000);
  expect(state.cleanup).toHaveBeenCalledTimes(initial);
  expect(state.next).toHaveBeenCalledOnce();

  // A producer wake learns the deadline and schedules the sweep for it.
  const deadline = Date.now() + 60_000;
  state.next.mockResolvedValue(deadline);
  worker.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.nextWakeAt()).toBe(deadline);
  const scheduled = state.cleanup.mock.calls.length;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(state.cleanup).toHaveBeenCalledTimes(scheduled);
  state.next.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.cleanup).toHaveBeenCalledTimes(scheduled + 1);
  expect(coordinator.nextWakeAt()).toBeNull();
  await worker.stop();
  expect(onError).not.toHaveBeenCalled();
});
