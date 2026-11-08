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
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error; keyPoolActions?: React.ReactNode } = {}) => {
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
  it("names the admission hold a task that has not started waits for", async () => {
    await render({ ...failed, state: "working", canRetry: false, sourceRunIds: [], observedRunId: null,
      retryWait: { reason: "budget.blocked", message: "Waiting for the budget to allow new work. The task starts automatically when it does." } });
    expect(container.textContent).toBe("Waiting for the budget to allow new work. The task starts automatically when it does.");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the saved-work recovery step instead of a bare queue", async () => {
    await render({ ...failed, state: "working", canRetry: false, recoveryStep: "saving_previous_files" });
    expect(container.textContent).toBe("Saving files from the previous attempt…");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the step a scheduled recovery will retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run" });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it("names the recovery step inside a provider failure notice", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run",
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "startup", category: "overloaded",
        retryability: "unknown", message: "Try later." } });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.textContent).not.toContain("Paperclip will retry automatically.");
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

  // Ticket 06: the host supplies the dedicated recovery actions; the banner
  // mounts them beside the copy without owning their behavior.
  it("mounts the supplied key-pool actions beside the rate_limited copy", async () => {
    await render({
      ...failed, responsibility: "user", state: "waiting_for_user", userAction: "rate_limited",
      keyPool: { reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash", state: "rpm_cooldown",
        cooldownUntil: null, connectionId: "conn-1" },
    }, { keyPoolActions: <button type="button" data-testid="key-pool-switch-key">Switch key</button> });
    expect(container.querySelector('[data-testid="key-pool-switch-key"]')).not.toBeNull();
    expect(container.textContent).toContain("hit the RPM rate limit");
  });

  it("keeps the rate_limited banner button-free when no actions are supplied", async () => {
    await render({
      ...failed, responsibility: "user", state: "waiting_for_user", userAction: "rate_limited",
      keyPool: { reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash", state: "rpm_cooldown",
        cooldownUntil: null, connectionId: "conn-1" },
    });
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
  it("shows workspace preparation failures as plain text while keeping retry permissions", async () => {
    const workspaceFailure = { message: 'Could not prepare the project folder <img src=x onerror=alert(1)>.' };
    await render({ ...failed, workspaceFailure }, { canRetry: false });
    expect(container.textContent).toContain("Couldn’t prepare the task folders.");
    expect(container.textContent).toContain(workspaceFailure.message);
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, workspaceFailure });
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, workspaceFailure, state: "working" });
    expect(container.textContent).toBe("");
  });
  it("shows why an accepted Retry is waiting and keeps another attempt available", async () => {
    const retryWait = { reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved." };
    await render({ ...failed, retryWait });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, retryWait }, { canRetry: false });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows an unknown provider's original explanation as text and preserves read-only access", async () => {
    const providerFailure = { schema: "paperclip.provider-failure.v1" as const, provider: "new-provider", phase: "startup" as const,
      category: "unknown" as const, retryability: "unknown" as const, httpStatus: 429,
      message: "Upstream failure <img src=x onerror=alert(1)>" };
    await render({ ...failed, providerFailure }, { canRetry: false });
    expect(container.textContent).toContain(providerFailure.message);
    expect(container.textContent).toContain("Failed before work started");
    expect(container.textContent).toContain("HTTP 429");
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, providerFailure, state: "resolved" });
    expect(container.textContent).toBe("");
  });
});
