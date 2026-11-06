import {
  keyPoolFailureCopy,
  readKeyPoolFailureSnapshot,
  type KeyPoolFailureSnapshot,
  type TaskInterruptionPresentation,
} from "@paperclipai/shared";

/**
 * Presentation glue for pooled-key failures in the task thread (ticket 05).
 * The failure markers render the dedicated label plus the operator-facing
 * pool summary; the pool snapshot itself is shared contract
 * (`KeyPoolFailureSnapshot`), persisted on the run and refreshed live by the
 * interruption projection. No recovery actions here yet — ticket 06.
 */

/** Marker label for the two pooled-key error codes. Null for any other code,
 * so the existing failure-marker chains keep their own labels. */
export function keyPoolFailureMarkerLabel(
  code: string | null | undefined,
): string | null {
  if (code === "provider_rate_limited") return "Rate limited";
  if (code === "provider_key_pool_exhausted") return "Key pool exhausted";
  return null;
}

/** The pool snapshot behind a pooled-key failure marker: the live-refreshed
 * interruption snapshot wins when the marker's run is the interruption's
 * source run; otherwise the snapshot the run persisted at terminal time. */
export function keyPoolFailureMarkerSnapshot(
  interruption: Pick<TaskInterruptionPresentation, "keyPool" | "sourceRunIds"> | null | undefined,
  runId: string,
  resultJson: Record<string, unknown> | null | undefined,
): KeyPoolFailureSnapshot | null {
  if (interruption?.keyPool && interruption.sourceRunIds?.includes(runId)) {
    return interruption.keyPool;
  }
  return readKeyPoolFailureSnapshot(resultJson?.keyPoolFailure);
}

/** Marker detail for a pooled-key failure: the shared copy over the resolved
 * snapshot, degrading to the generic sentence when no snapshot survived.
 * Null for any other code. */
export function keyPoolFailureMarkerCopy(
  code: string | null | undefined,
  interruption: Pick<TaskInterruptionPresentation, "keyPool" | "sourceRunIds"> | null | undefined,
  runId: string,
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!keyPoolFailureMarkerLabel(code)) return null;
  const snapshot = keyPoolFailureMarkerSnapshot(interruption, runId, resultJson) ?? {
    reason: code === "provider_key_pool_exhausted" ? ("pool_exhausted" as const) : ("rate_limited" as const),
  };
  return keyPoolFailureCopy(snapshot);
}
