/**
 * Presentation contract for pooled-key failures (ticket 05). The server
 * persists a structured snapshot on the failed run (`resultJson.keyPoolFailure`)
 * and the interruption projection attaches it to the `rate_limited` user
 * action; the UI renders the operator-facing copy from the snapshot through
 * `keyPoolFailureCopy`. The snapshot never contains key material — only slot
 * numbers, model ids, occupancy and cooldown times.
 */

/** Display of one pool slot at snapshot time. Mirrors the assignment matrix's
 * view: an exclusive lease (per key) or a (slot, model) cooldown. */
export interface KeyPoolFailureSlotView {
  slot: number;
  state: "healthy" | "rpm_cooldown" | "daily_cooldown" | "disabled";
  /** The cooldown's model (bare upstream id); leases are per key, not per model. */
  model: string | null;
  cooldownUntil: string | null;
  leasedByRunId: string | null;
  leasedByAgentId: string | null;
  leasedByAgentName: string | null;
}

export interface KeyPoolFailureSnapshot {
  reason: "rate_limited" | "pool_exhausted";
  /** The (slot, model) pair that hit the limit, for run-internal 429s. */
  slot?: number | null;
  model?: string | null;
  state?: "rpm_cooldown" | "daily_cooldown" | null;
  cooldownUntil?: string | null;
  connectionId?: string | null;
  /** Full slot display for assignment-time exhaustion fast-fails. */
  slots?: KeyPoolFailureSlotView[];
}

export interface KeyPoolFailureCopyOptions {
  /** Renders a cooldown deadline as HH:MM. Defaults to the runtime locale. */
  formatTime?: (iso: string) => string;
  /** Clock for staleness checks; defaults to Date.now(). */
  now?: number;
}

const defaultFormatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

const modelPair = (snapshot: KeyPoolFailureSnapshot): string | null =>
  typeof snapshot.slot === "number" && typeof snapshot.model === "string" && snapshot.model.length > 0
    ? `key ${snapshot.slot} × ${snapshot.model}`
    : null;

function exhaustedSlotPart(view: KeyPoolFailureSlotView, formatTime: (iso: string) => string): string | null {
  // Occupancy first: a leased slot reports the deprecated slot-level "healthy".
  if (view.leasedByRunId || view.leasedByAgentName)
    return `key ${view.slot} is in use by ${view.leasedByAgentName ? `agent ${view.leasedByAgentName}` : `run ${view.leasedByRunId}`}`;
  if (view.state === "healthy") return null;
  const pair = typeof view.model === "string" && view.model.length > 0 ? `key ${view.slot} × ${view.model}` : `key ${view.slot}`;
  if (view.state === "daily_cooldown")
    return view.cooldownUntil ? `${pair} hit its daily limit and is expected back by ${formatTime(view.cooldownUntil)}` : `${pair} hit its daily limit and awaits its recovery probe`;
  if (view.state === "rpm_cooldown")
    return view.cooldownUntil ? `${pair} hit the RPM rate limit and is expected back by ${formatTime(view.cooldownUntil)}` : `${pair} hit the RPM rate limit`;
  return `key ${view.slot} is disabled`;
}

/**
 * The interruption copy for one pooled-key failure. Templates (plan §10: the
 * key and the model are both injected):
 * - RPM: "key 3 × model M hit the RPM rate limit. The next retry automatically
 *   switches to another key slot."
 * - Daily: "key 2 × model M hit its daily limit. A probe verifies recovery; it
 *   is expected back by HH:MM." A stale or missing deadline degrades to the
 *   probe sentence instead of promising a past minute.
 * - Exhausted: "All keys of this connection's pool are busy or cooling down:
 *   key 5 is in use by agent A; key 2 × model M …"
 */
export function keyPoolFailureCopy(snapshot: KeyPoolFailureSnapshot, options?: KeyPoolFailureCopyOptions): string {
  const formatTime = options?.formatTime ?? defaultFormatTime;
  const now = options?.now ?? Date.now();
  if (snapshot.reason === "rate_limited") {
    const pair = modelPair(snapshot);
    if (snapshot.state === "daily_cooldown") {
      const lead = pair ? `${pair} hit its daily limit.` : "A pooled key hit its daily limit.";
      const pending = typeof snapshot.cooldownUntil === "string" && Date.parse(snapshot.cooldownUntil) > now;
      return pending
        ? `${lead} A probe verifies recovery; it is expected back by ${formatTime(snapshot.cooldownUntil!)}.`
        : `${lead} A probe verifies recovery before the key returns.`;
    }
    if (pair) {
      return typeof snapshot.state === "string"
        ? `${pair} hit the RPM rate limit. The next retry automatically switches to another key slot.`
        : `${pair} was rate limited. The next retry automatically switches to another key slot when the pool cannot serve it.`;
    }
    return "The AI provider rate limited this run (HTTP 429). Retry when the provider's limit resets.";
  }
  const parts = (Array.isArray(snapshot.slots) ? snapshot.slots : [])
    .map((view) => exhaustedSlotPart(view, formatTime))
    .filter((part): part is string => part !== null);
  return parts.length
    ? `All keys of this connection's pool are busy or cooling down: ${parts.join("; ")}.`
    : "The connection's key pool had no available key slot for this run. Retry to use the pool again.";
}

const FAILURE_REASONS = new Set(["rate_limited", "pool_exhausted"]);
const SLOT_STATES = new Set(["healthy", "rpm_cooldown", "daily_cooldown", "disabled"]);

/** Defensive read of the persisted `resultJson.keyPoolFailure`: known shapes
 * pass through, anything else (old runs, corrupted payloads) renders nothing. */
export function readKeyPoolFailureSnapshot(value: unknown): KeyPoolFailureSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.reason !== "string" || !FAILURE_REASONS.has(entry.reason)) return null;
  if (entry.slot !== undefined && entry.slot !== null && (typeof entry.slot !== "number" || !Number.isInteger(entry.slot))) return null;
  if (entry.slots !== undefined && entry.slots !== null && !Array.isArray(entry.slots)) return null;
  const snapshot: KeyPoolFailureSnapshot = { reason: entry.reason as KeyPoolFailureSnapshot["reason"] };
  if (typeof entry.slot === "number" && Number.isInteger(entry.slot)) snapshot.slot = entry.slot;
  if (typeof entry.model === "string" && entry.model.length > 0) snapshot.model = entry.model;
  if (typeof entry.state === "string" && (entry.state === "rpm_cooldown" || entry.state === "daily_cooldown")) snapshot.state = entry.state;
  if (typeof entry.cooldownUntil === "string" && entry.cooldownUntil.length > 0) snapshot.cooldownUntil = entry.cooldownUntil;
  if (typeof entry.connectionId === "string" && entry.connectionId.length > 0) snapshot.connectionId = entry.connectionId;
  if (Array.isArray(entry.slots)) {
    const slots: KeyPoolFailureSlotView[] = [];
    for (const item of entry.slots) {
      if (typeof item !== "object" || item === null) continue;
      const view = item as Record<string, unknown>;
      if (typeof view.slot !== "number" || !Number.isInteger(view.slot) || typeof view.state !== "string" || !SLOT_STATES.has(view.state)) continue;
      slots.push({
        slot: view.slot,
        state: view.state as KeyPoolFailureSlotView["state"],
        model: typeof view.model === "string" && view.model.length > 0 ? view.model : null,
        cooldownUntil: typeof view.cooldownUntil === "string" && view.cooldownUntil.length > 0 ? view.cooldownUntil : null,
        leasedByRunId: typeof view.leasedByRunId === "string" && view.leasedByRunId.length > 0 ? view.leasedByRunId : null,
        leasedByAgentId: typeof view.leasedByAgentId === "string" && view.leasedByAgentId.length > 0 ? view.leasedByAgentId : null,
        leasedByAgentName: typeof view.leasedByAgentName === "string" && view.leasedByAgentName.length > 0 ? view.leasedByAgentName : null,
      });
    }
    snapshot.slots = slots;
  }
  return snapshot;
}
