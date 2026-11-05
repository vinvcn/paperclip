import type { Db } from "@paperclipai/db";
import { usageRequestRetentionService } from "./usage-request-retention.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";

/**
 * The Usage request log's retention worker (docs/specs/usage-request-logs.md,
 * Data model), wired like the provider-trace retention worker: a deadline
 * task on the delivery coordinator whose `run` sweeps expired request rows
 * and whose `next` re-probes the oldest surviving row's expiry. Producers
 * signal the queue on insert so the worker re-probes after a table that was
 * empty (no deadline) receives its first row.
 */
export function registerUsageRequestRetentionWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
) {
  const retention = usageRequestRetentionService(db);
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.usageRequestRetention, {
    canRun,
    retryMs: 30_000,
    run: (signal) =>
      signal.aborted
        ? Promise.resolve()
        : retention.cleanupExpired(new Date(), signal).then(() => undefined),
    next: () => retention.nextRetentionDeadline(),
  });
}
