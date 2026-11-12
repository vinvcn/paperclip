import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import { closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, usageRequestLogs } from "../../packages/db/src/index.ts";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function e2eDb() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const url = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${(await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8")).split("\n")[3]}/paperclip`;
  return createDb(url);
}

async function setupIssue(request: APIRequestContext, name: string) {
  const company = await json(await request.post("/api/companies", { data: { name } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Metrics fixture", adapterType: "process", adapterConfig: { command: process.execPath, args: ["--version"] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
    title: "Measure one run", status: "in_progress", assigneeAgentId: agent.id,
  } }));
  return { company, agent, issue };
}

async function archiveCompany(request: APIRequestContext, id: string) {
  const response = await request.patch(`/api/companies/${id}`, { data: { status: "archived" } });
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
}

test.afterEach(async () => {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const url = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${(await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8")).split("\n")[3]}/paperclip`;
  await closeRegisteredClients(url);
});

test("Usage shows each provider request's TTFT, total time and TPS", async ({ page, request }, info) => {
  const { company, agent, issue } = await setupIssue(request, "Request performance metrics E2E");
  const db = await e2eDb();
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id, issueId: issue.id,
    status: "succeeded", runtimeMode: "native", invocationSource: "issue", startedAt: new Date("2026-11-12T08:00:00Z"),
    finishedAt: new Date("2026-11-12T08:00:16Z"), contextSnapshot: { issueId: issue.id } });
  await db.insert(usageRequestLogs).values({ companyId: company.id, runId, agentId: agent.id, issueId: issue.id,
    app: "opencode", provider: "openrouter", model: "gpt-5.1-codex-mini", outputTokens: 1120,
    durationMs: 16_000, ttftMs: 4_000, httpStatus: 200, requestId: "e2e-request-1", occurredAt: new Date("2026-11-12T08:00:02Z") });
  await page.goto(`/${company.issuePrefix}/usage`);
  await expect(page.getByRole("columnheader", { name: "TTFT", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total time", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "TPS", exact: true })).toBeVisible();
  const row = page.getByRole("row", { name: /gpt-5\.1-codex-mini/ });
  await expect(row).toContainText("4.0s");
  await expect(row).toContainText("16.0s");
  await expect(row).toContainText("93.3 TPS");
  await page.screenshot({ path: info.outputPath("usage-performance.png"), fullPage: true });
  await archiveCompany(request, company.id);
});

test("Task chat shows a live TPS and a frozen full-run average with TTFT", async ({ page, request }, info) => {
  const company = await json(await request.post("/api/companies", { data: { name: "Chat performance metrics E2E" } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Live TPS fixture", adapterType: "process", adapterConfig: { command: process.execPath, args: ["--version"] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
    title: "Measure a run", status: "in_progress", assigneeAgentId: agent.id,
  } }));
  const db = await e2eDb();
  const runId = randomUUID();
  const startedAt = new Date();
  await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id, issueId: issue.id,
    status: "running", runtimeMode: "native", invocationSource: "issue", startedAt,
    contextSnapshot: { issueId: issue.id } });
  const event = (seq: number, eventType: string, emittedAt: string, payload: Record<string, unknown>) => ({
    companyId: company.id, runId, agentId: agent.id, seq, eventType,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId, eventType, sourceEventId: `metric-${seq}`, emittedAt, itemId: "message-1", payload } },
  });
  const firstUsageAt = new Date(Date.now() - 2_000);
  await db.insert(heartbeatRunEvents).values([
    event(1, "item.delta", firstUsageAt.toISOString(), { kind: "agentMessage", channel: "progress", text: "Generating" }),
    { companyId: company.id, runId, agentId: agent.id, seq: 2, eventType: "usage.reported",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId, eventType: "usage.reported", sourceEventId: "usage-1", emittedAt: new Date(firstUsageAt).toISOString(), payload: { runDeltaAvailable: true, runDelta: { inputTokens: 0, outputTokens: 20 } } } },
    },
  ]);
  await db.insert(heartbeatRunEvents).values([
    { companyId: company.id, runId, agentId: agent.id, seq: 3, eventType: "usage.reported",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId, eventType: "usage.reported", sourceEventId: "usage-2", emittedAt: new Date(firstUsageAt.getTime() + 2_000).toISOString(), payload: { runDeltaAvailable: true, runDelta: { inputTokens: 0, outputTokens: 90 } } } },
    },
  ]);
  await expect.poll(async () => {
    const rows = await db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    return rows.length;
  }, { timeout: 10_000 }).toBe(3);
  // This fixture changes the durable event store directly, not the runner's
  // websocket transport. Re-read the persisted history like a page reopen.
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await expect(page.getByTestId("task-chat-tps")).toContainText("45.0 TPS", { timeout: 15_000 });
  await page.screenshot({ path: info.outputPath("chat-live-tps.png"), fullPage: true });
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(startedAt.getTime() + 16_000) }).where(eq(heartbeatRuns.id, runId));
  await page.reload();
  await expect(page.getByTestId("task-chat-tps")).toHaveText(/平均 6\.9 TPS/);
  await page.reload();
  await expect(page.getByTestId("task-chat-tps")).toHaveText(/平均 6\.9 TPS/);
  await page.screenshot({ path: info.outputPath("chat-performance.png"), fullPage: true });
  await archiveCompany(request, company.id);
});
