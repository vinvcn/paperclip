// Ticket 05 presentation contract: the three interruption copy templates inject
// the key slot, the model and the recovery time; degraded snapshots neither
// crash nor invent facts. All times in this file are fixture ISO strings.
import { describe, expect, it } from "vitest";
import { keyPoolFailureCopy, readKeyPoolFailureSnapshot } from "./key-pool-failure.js";

// Deterministic wall clock: every fixture recovery time renders as HH:MM.
const formatTime = (iso: string) => `${new Date(iso).getUTCHours()}:${String(new Date(iso).getUTCMinutes()).padStart(2, "0")}`;

describe("key pool failure copy", () => {
  it("renders the RPM template with the key slot and the model", () => {
    expect(keyPoolFailureCopy({
      reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash", state: "rpm_cooldown",
      cooldownUntil: "2026-11-06T18:01:30.000Z", connectionId: "conn-1",
    }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "key 3 × z-ai/glm-5.3-flash hit the RPM rate limit. The next retry automatically switches to another key slot.",
    );
  });

  it("renders the daily-limit template with the probe recovery time", () => {
    expect(keyPoolFailureCopy({
      reason: "rate_limited", slot: 2, model: "z-ai/glm-5.3-flash", state: "daily_cooldown",
      cooldownUntil: "2026-11-07T14:30:00.000Z", connectionId: "conn-1",
    }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "key 2 × z-ai/glm-5.3-flash hit its daily limit. A probe verifies recovery; it is expected back by 14:30.",
    );
  });

  it("renders the pool-exhausted template with occupancy and cooldown slots", () => {
    expect(keyPoolFailureCopy({
      reason: "pool_exhausted", connectionId: "conn-1", model: "z-ai/glm-5.3-flash",
      slots: [
        { slot: 5, state: "healthy", model: null, cooldownUntil: null, leasedByRunId: "run-x", leasedByAgentId: "agent-1", leasedByAgentName: "Chief" },
        { slot: 2, state: "rpm_cooldown", model: "z-ai/glm-5.3-flash", cooldownUntil: "2026-11-06T18:01:30.000Z", leasedByRunId: null, leasedByAgentId: null, leasedByAgentName: null },
        { slot: 7, state: "disabled", model: null, cooldownUntil: null, leasedByRunId: null, leasedByAgentId: null, leasedByAgentName: null },
      ],
    }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "All keys of this connection's pool are busy or cooling down: key 5 is in use by agent Chief; key 2 × z-ai/glm-5.3-flash hit the RPM rate limit and is expected back by 18:01; key 7 is disabled.",
    );
  });

  it("degrades without inventing facts when the cooldown row is missing", () => {
    // The pair is known but the cooldown row vanished (released or re-classified).
    expect(keyPoolFailureCopy({
      reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash", state: null,
      cooldownUntil: null, connectionId: "conn-1",
    }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "key 3 × z-ai/glm-5.3-flash was rate limited. The next retry automatically switches to another key slot when the pool cannot serve it.",
    );
    // Not pooled at all: no key, no slot-switch promise.
    expect(keyPoolFailureCopy({ reason: "rate_limited" }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "The AI provider rate limited this run (HTTP 429). Retry when the provider's limit resets.",
    );
  });

  it("drops a stale recovery time instead of promising a past minute", () => {
    expect(keyPoolFailureCopy({
      reason: "rate_limited", slot: 2, model: "z-ai/glm-5.3-flash", state: "daily_cooldown",
      cooldownUntil: "2026-11-06T10:00:00.000Z", connectionId: "conn-1",
    }, { formatTime, now: Date.parse("2026-11-06T18:00:00.000Z") })).toBe(
      "key 2 × z-ai/glm-5.3-flash hit its daily limit. A probe verifies recovery before the key returns.",
    );
  });

  it("renders an exhausted pool whose snapshot no longer shows an occupancy", () => {
    expect(keyPoolFailureCopy({ reason: "pool_exhausted", slots: [] }, { formatTime, now: 0 })).toBe(
      "The connection's key pool had no available key slot for this run. Retry to use the pool again.",
    );
  });

  it("parses persisted snapshots defensively and rejects garbage", () => {
    expect(readKeyPoolFailureSnapshot({
      reason: "rate_limited", slot: 3, model: "m", state: "rpm_cooldown",
      cooldownUntil: "2026-11-06T18:01:30.000Z", connectionId: "conn-1",
    })).toMatchObject({ reason: "rate_limited", slot: 3 });
    expect(readKeyPoolFailureSnapshot({ reason: "pool_exhausted", slots: [{ slot: 5, state: "healthy" }] }))
      .toMatchObject({ reason: "pool_exhausted", slots: [{ slot: 5, state: "healthy" }] });
    expect(readKeyPoolFailureSnapshot(null)).toBeNull();
    expect(readKeyPoolFailureSnapshot("429")).toBeNull();
    expect(readKeyPoolFailureSnapshot({ reason: "something_else" })).toBeNull();
    expect(readKeyPoolFailureSnapshot({ reason: "rate_limited", slot: "three" })).toBeNull();
  });
});
