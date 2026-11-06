import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerKeyPoolCooldownWork } from "../services/key-pool-cooldown-work.js";

const state = vi.hoisted(() => ({
  sweep: vi.fn(async () => 0),
  next: vi.fn<() => Promise<number | null>>(),
  probe: undefined as undefined | (() => string),
  unregister: vi.fn(),
}));
// The idle-local-work module is cycle-free, so a module mock reaches it; the
// cooldown state machine is not (see the worker's injectable deps), so the
// probe functions arrive as injected stubs instead of a vi.mock.
vi.mock("../services/idle-local-work.js", () => ({
  registerIdleLocalWorkProbe: (probe: () => string) => {
    state.probe = probe;
    return state.unregister;
  },
}));
let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => {
  await coordinator?.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("probes on its deadline, stays quiet between obligations, and discharges the sleep blocker", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  state.next.mockResolvedValue(null);
  const worker = registerKeyPoolCooldownWork(owner as unknown as Db, coordinator, () => true, {
    runDueProbes: state.sweep as unknown as (db: Db, now: Date, options: { signal?: AbortSignal }) => Promise<number>,
    nextWakeAt: state.next as unknown as (db: Db) => Promise<number | null>,
  });
  expect(state.probe!()).toBe("unknown");
  await worker.ready;
  expect(state.probe!()).toBe("none");
  expect(coordinator.nextWakeAt()).toBeNull();
  const initial = state.sweep.mock.calls.length;
  // With no daily cooldown the worker stays quiet; only the deadline probe ran once.
  await vi.advanceTimersByTimeAsync(300_000);
  expect(state.sweep).toHaveBeenCalledTimes(initial);
  expect(state.next).toHaveBeenCalledOnce();

  // A daily-cooldown write wakes the worker; it learns the deadline and
  // schedules the sweep for it.
  const deadline = Date.now() + 60_000;
  state.next.mockResolvedValue(deadline);
  worker.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.probe!()).toBe("present");
  expect(coordinator.nextWakeAt()).toBe(deadline);
  const scheduled = state.sweep.mock.calls.length;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(state.sweep).toHaveBeenCalledTimes(scheduled);
  state.next.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.sweep).toHaveBeenCalledTimes(scheduled + 1);
  expect(state.probe!()).toBe("none");
  expect(coordinator.nextWakeAt()).toBeNull();
  await worker.stop();
  expect(state.unregister).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});
