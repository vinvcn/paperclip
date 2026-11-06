// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error } = {}) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...options} />));
  };
  it("offers one Retry without delegating infrastructure chores", async () => {
    await render();
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector("a, details, input, textarea")).toBeNull();
    expect(container.textContent).not.toMatch(/service attention|process|receipt|workspace/i);
  });
  it("shows persisted backoff with a usable Retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z" });
    expect(container.textContent).toContain("Trying again in 30s");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(container.textContent).toContain("Trying again in 25s");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it.each(["working", "resolved"] as const)("does not duplicate the thread indicator for %s", async state => {
    await render({ ...failed, state }); expect(container.textContent).toBe("");
  });
  it("leaves genuine user decisions to their specific action surface", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "approval", canRetry: false });
    expect(container.textContent).toBe("");
  });
  it("does not give read-only users a mutation", async () => {
    await render(failed, { canRetry: false }); expect(container.querySelector("button")).toBeNull();
  });
  it("removes the stale failure immediately while admission is pending", async () => {
    await render(failed, { optimistic: true }); expect(container.textContent).toBe("");
    await render(failed, { optimistic: true, takingLonger: true });
    expect(container.textContent).toContain("Taking longer than usual…");
  });
  it("shows a definitive admission rejection instead of silently dropping Retry", async () => {
    await render(failed, { error: new Error("Your task access changed. Refresh the task.") });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your task access changed.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  // Ticket 05 (demo): pooled-key failures surface the pool snapshot inline
  // without a retry action yet.
  it("renders the rate_limited pool snapshot without a retry action", async () => {
    await render({
      ...failed, responsibility: "user", state: "waiting_for_user", userAction: "rate_limited",
      keyPool: { reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash", state: "rpm_cooldown",
        cooldownUntil: null, connectionId: "conn-1" },
    });
    expect(container.textContent).toContain("key 3 × z-ai/glm-5.3-flash hit the RPM rate limit. The next retry automatically switches to another key slot.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the exhausted-pool occupancy copy for pool_exhausted snapshots", async () => {
    await render({
      ...failed, responsibility: "user", state: "waiting_for_user", userAction: "rate_limited",
      keyPool: { reason: "pool_exhausted", slots: [{ slot: 5, state: "healthy", model: null, cooldownUntil: null,
        leasedByRunId: "run-x", leasedByAgentId: null, leasedByAgentName: "Chief" }] },
    });
    expect(container.textContent).toContain("key 5 is in use by agent Chief");
    expect(container.querySelector("button")).toBeNull();
  });

  it("degrades the rate_limited banner to the generic sentence without a snapshot", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "rate_limited" });
    expect(container.textContent).toContain("rate limited this run");
    expect(container.querySelector("button")).toBeNull();
  });

  it("hides the rate_limited banner while an attempt is optimistic or taking longer", async () => {
    const rateLimited = { ...failed, responsibility: "user" as const, state: "waiting_for_user" as const, userAction: "rate_limited" as const };
    await render(rateLimited, { optimistic: true });
    expect(container.textContent).toBe("");
    await render(rateLimited, { takingLonger: true });
    expect(container.textContent).toContain("Taking longer than usual…");
  });
});
