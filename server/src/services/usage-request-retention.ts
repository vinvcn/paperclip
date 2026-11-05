import { and, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { usageRequestLogs } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * The request log's retention window (docs/specs/usage-request-logs.md,
 * Data model): detail rows are kept for 90 days, then deleted. One named
 * constant — every reader of the window, including the sweep, the deadline
 * probe and the tests, resolves it from here.
 */
export const USAGE_REQUEST_LOG_RETENTION_DAYS = 90;
export const USAGE_REQUEST_LOG_RETENTION_MS = USAGE_REQUEST_LOG_RETENTION_DAYS * 86_400_000;

/**
 * Rows deleted per chunked DELETE (docs/specs/usage-request-logs.md,
 * Data model): the sweep is bounded so a large backlog never holds one
 * long transaction. Each chunk is its own short autocommitted statement.
 */
export const USAGE_REQUEST_LOG_SWEEP_CHUNK = 500;

/**
 * Chunk cap per sweep invocation. A backlog larger than
 * `maxChunks * chunkSize` is left for the deadline scheduler, which
 * re-drives the sweep while its deadline still reads as due.
 */
export const USAGE_REQUEST_LOG_SWEEP_MAX_CHUNKS = 100;

export interface UsageRequestRetentionOptions {
  /** Rows per chunked DELETE; tests shrink it to observe multi-chunk drains. */
  chunkSize?: number;
  /** Chunk cap per invocation; tests shrink it to observe the re-drive hand-off. */
  maxChunks?: number;
}

/**
 * Retention for the Usage request log (docs/specs/usage-request-logs.md,
 * Data model), modelled on the provider-trace retention service: a bounded
 * sweep that physically deletes rows strictly older than the retention
 * window, plus the deadline probe the delivery coordinator schedules by.
 * Only `usage_request_logs` is ever touched — `cost_events` is the
 * authoritative ledger and stays out of scope (ADR-0001); the allocated
 * per-row costs die with their rows, which is the point of a *request
 * detail* window.
 */
export function usageRequestRetentionService(db: Db, options: UsageRequestRetentionOptions = {}) {
  const chunkSize = options.chunkSize ?? USAGE_REQUEST_LOG_SWEEP_CHUNK;
  const maxChunks = options.maxChunks ?? USAGE_REQUEST_LOG_SWEEP_MAX_CHUNKS;

  /**
   * Delete every request row strictly older than the window relative to
   * `now` (the boundary instant itself is kept), chunk by chunk. Each chunk
   * is one autocommitted DELETE — the loop never spans a transaction — and
   * stops once a chunk comes back short. Returns the total deleted.
   */
  async function cleanupExpired(now = new Date(), signal?: AbortSignal): Promise<number> {
    const cutoff = new Date(now.getTime() - USAGE_REQUEST_LOG_RETENTION_MS);
    const expired = lt(usageRequestLogs.occurredAt, cutoff);
    let totalDeleted = 0;
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
      signal?.throwIfAborted();
      const deleted = await db
        .delete(usageRequestLogs)
        .where(and(
          expired,
          inArray(
            usageRequestLogs.id,
            db.select({ id: usageRequestLogs.id })
              .from(usageRequestLogs)
              .where(expired)
              .limit(chunkSize),
          ),
        ))
        .returning({ id: usageRequestLogs.id });
      totalDeleted += deleted.length;
      if (deleted.length < chunkSize) {
        if (totalDeleted > 0) {
          logger.info(
            { totalDeleted, retentionDays: USAGE_REQUEST_LOG_RETENTION_DAYS },
            "Pruned expired usage request logs",
          );
        }
        return totalDeleted;
      }
    }
    logger.warn(
      { totalDeleted, chunkSize, maxChunks },
      "Usage request log retention hit its chunk cap; the scheduler re-drives the remainder",
    );
    return totalDeleted;
  }

  /**
   * When the oldest surviving row crosses the window, in epoch millis — the
   * deadline the retention worker schedules against. Epoch extraction
   * sidesteps drizzle's transparent timestamp parsers (which return
   * session-timezone text on postgres.js). A row already past the window
   * yields a past deadline, so the worker re-runs promptly; an empty table
   * yields none.
   */
  async function nextRetentionDeadline(): Promise<number | null> {
    const [row] = await db
      .select({
        oldestMs: sql<number | null>`extract(epoch from min(${usageRequestLogs.occurredAt}))::double precision * 1000`,
      })
      .from(usageRequestLogs);
    return row?.oldestMs == null ? null : row.oldestMs + USAGE_REQUEST_LOG_RETENTION_MS;
  }

  return { cleanupExpired, nextRetentionDeadline };
}
