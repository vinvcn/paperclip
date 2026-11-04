# LLM Request Logs & Usage Page

## Problem Statement

Paperclip can tell you what a run cost in total, but not **what the individual model calls did**. The only per-usage record is `cost_events` — one row per turn × model, written at run completion. That answers "how much did this task spend", and nothing else.

When a run is slow, flaky, or expensive, the questions people actually ask are per-request:

- Which model was called, and how often?
- How long did each call take, and how long until the first token?
- How many tokens were fresh input vs. cache hits vs. output?
- Which calls failed, and with what status?
- Where is my spend going across providers and models over the last 24 hours?

None of that exists today. Users fall back to reading raw run logs, or to the sandbox's internal OpenCode session store, which dies with the run.

## Solution

A new **Usage** surface in the sidebar (Org group, directly under Costs) that shows, for a selected time window:

1. Four headline cards — Total Cost, Total Requests, Tokens Processed, Cache Hit Rate — plus four secondary values: Fresh Input, Output, Cache Write, Cache Hit.
2. An hourly **Tokens** bar chart, bucketed in the viewer's timezone.
3. A **Request Logs** table: one row per provider HTTP call, with time, app, provider, model, cost, fresh input, output, cache hit, speed, first-token latency and status.
4. Filters: time range, app chips (data-driven), provider/model, status code, page size, with the last selection remembered.

The data is captured at the **provider proxy** the OpenCode runner already runs for `paperclip/*` and `openrouter/*` models, so no harness changes are needed and every request through the proxy is observed exactly once. Records are stored in a new `usage_request_logs` table, independent of the financial ledger.

## User Stories

1. As an engineer debugging a slow run, I want to see each provider request with its duration and time-to-first-token, so that I can tell whether latency comes from the provider or from the agent loop.
2. As an engineer debugging a failed run, I want to see which requests returned an error status, so that I can find the failing call without reading raw logs.
3. As a team lead, I want the total cost and total request count for a time window on one screen, so that I can judge spend at a glance.
4. As a team lead, I want to see tokens split into fresh input, output, cache write and cache hit, so that I understand where the token volume comes from.
5. As a team lead, I want a cache hit rate, so that I can tell whether prompt caching is working.
6. As a team lead, I want an hourly token chart, so that I can see bursty periods and correlate them with work.
7. As a team lead, I want the chart bucketed in my local timezone, so that the hours match my working day.
8. As a team lead, I want to switch the time range between 24h, 7d, 30d and a custom range, so that I can look at today or at the month.
9. As a team lead, I want my time-range and page-size choice remembered, so that I don't have to re-select it every visit.
10. As an engineer, I want to filter by app (harness), so that I can isolate OpenCode traffic.
11. As an engineer, I want to filter by provider and model, so that I can compare model behaviour.
12. As an engineer, I want to filter by status code, so that I can list only failed requests.
13. As an engineer, I want the app filter to list only apps that actually produced requests in the window, so that I never see empty dead options.
14. As an engineer, I want per-row cost, so that I can see which calls are expensive rather than only the total.
15. As an engineer, I want cost-less requests labelled `Unpriced` rather than shown as $0.00, so that I don't mistake unknown cost for free.
16. As a team lead, I want an `N unpriced` badge on the Total Cost card, so that I know the displayed total is incomplete.
17. As an engineer, I want speed and first-token columns to stay visible but show `—` when the data is unavailable, so that the table layout is stable and missing data is explicit.
18. As a team lead, I want the page to refresh on entry, on demand, and every 30 seconds while open, so that it stays current without me reloading.
19. As a viewer without cost permissions, I want the page to refuse me the same way Costs does, so that permission rules stay consistent.
20. As an operator, I want request detail kept for 90 days and then deleted, so that storage stays bounded.
21. As a new user, I want an empty state that explains no requests were seen yet, so that I don't think the page is broken.
22. As a user, I want the page to page through results without losing my filters, so that I can inspect older requests.

## Implementation Decisions

### Scope

- **P1 captures only traffic that goes through the runner's provider proxy** (`paperclip/*` and `openrouter/*` models), which today is the entire OpenCode path on this deployment.
- P1 covers the `paperclip_runner` harness only (`app = "opencode"`). Legacy adapters, Codex, Claude/Acpx capture is P2.
- P1 does not backfill from `cost_events`.

### Data model

- New table `usage_request_logs`, one row per provider HTTP call. `cost_events` is untouched (ADR-0001).
- Columns: company, run, agent, issue, project, app, provider, biller, model, input tokens, cached input tokens, cache write tokens, output tokens, cost cents (nullable), cost status, duration ms (nullable), time-to-first-token ms (nullable), HTTP status, provider request id, request id, occurred-at, metadata.
- Uniqueness: `(company_id, run_id, request_id)` — the runner generates the request id, so retries and re-delivery are idempotent.
- Indexes: `(company_id, occurred_at desc, id)` for the log list, `(company_id, app, occurred_at)`, `(company_id, provider, model, occurred_at)`, and `(run_id)` for cost allocation.
- Agent/issue/project are resolved **server-side from the run id** at insert time; the runner never sends them.
- Token columns are nullable: a request whose usage could not be observed keeps nulls and is excluded from token sums, rather than being recorded as zero.
- Detail rows are retained for 90 days by a retention sweep modelled on the existing provider-trace retention service.

### Capture

- The provider proxy in the OpenCode driver becomes the observation point (ADR-0002). For each accepted call it records: start time, upstream status, time-to-first-token (first upstream body byte), total duration, request body model, and any usage block found in the response.
- For streaming requests the proxy ensures `stream_options.include_usage = true` is forwarded upstream when the client did not ask for it. If the upstream rejects the request with the injected field, the proxy retries once without it and marks the record `usage_missing`.
- Usage is read from the OpenAI-compatible `usage` block (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `cache_creation_input_tokens`, `cost`), preferring explicitly reported cache fields over derivations.
- The driver buffers records for the duration of the run and delivers them to the server over the existing runner→server event channel as usage-family events (`kind = "provider_request"`), so no new transport or HTTP endpoint is introduced. Re-delivery is safe because of the request-id uniqueness.
- Server-side persistence reuses the accounting path's idempotency rules and the same company/run authorization as usage receipts.
- Failed, cancelled and aborted requests are recorded with their status and no token or cost data.

### Cost attribution

- The authoritative money stays in `cost_events`. Per-row cost is an **allocation**: when a run's cost accounting lands, each `cost_events` row for that run is distributed across that run's request rows for the same model, pro-rata by billed tokens (fresh input + cache write + output + cached input).
- Allocation sums exactly to the receipt: no rounding drift, and `SUM(request cost)` for a run equals that run's accounted cost.
- Request rows with no matching receipt, or with missing token counts, remain `Unpriced` — there is no basis to allocate against. Unpriced rows count toward request and token totals but contribute zero to Total Cost, and their count drives the `N unpriced` badge.
- Allocation runs once per run, when accounting closes; rows arriving after that stay `Unpriced` rather than reopening the ledger.

### Metrics

- `Fresh Input = input − cached input`.
- `Cache Hit Rate = cached input ÷ (fresh input + cached input)`; `null` when the denominator is zero.
- `Tokens Processed = fresh input + output + cached input`.
- `Speed = output tokens ÷ (duration − time-to-first-token)`; falls back to total duration when time-to-first-token is unknown; `null` when output or duration is missing.

### API

Two read endpoints under the company scope, reusing the Costs read permission and the existing date-range parser:

- **Summary** (`.../usage/summary`): accepts from/to, timezone (IANA name), app, provider, model. Returns the card totals, the hourly/daily series, the unpriced count, and facets (apps, providers, models with request counts) to drive the filters.
- **Logs** (`.../usage/logs`): accepts the same filters plus status and a keyset cursor `(occurred_at, id)`. Returns rows and a next cursor, plus the total matching count.
- Series bucketing uses PostgreSQL `date_trunc(... AT TIME ZONE :tz)`, so DST is handled correctly; buckets are hourly for windows up to 48 hours and daily beyond that.
- Both endpoints require the same authorization as `costs`.

### UI

- New route `/usage` inside the company-scoped app router, and a new nav item **Usage** in the sidebar's Org section, immediately after **Costs**.
- Cards: a single bordered block with a 4-up headline row (Total Cost with unpriced badge, Total Requests, Tokens Processed, Cache Hit Rate) and a 4-up secondary row (Fresh Input, Output, Cache Write, Cache Hit), matching the mock.
- Chart: hand-rolled SVG bar chart (no charting library exists in the UI), hourly buckets with zero-filled gaps, hover tooltip, and a y-axis that scales to the window maximum.
- Table tabs: **Request Logs** (implemented), **Providers** and **Models** (visible, marked P2, non-functional in P1, showing a short "coming in P2" panel instead of an empty table).
- Table columns: Time (local), App, Provider, Model, Cost, Fresh Input, Output, Cache Hit, Speed, First token. Cost renders `Unpriced` in a warning tone; Speed and First token render `—` when null. Rows are not clickable in P1.
- Filters: time range, data-driven app chips with an "All" option, provider/model select, status-code select, page size (20/50/100).
- Refresh: fetch on mount, manual refresh, and 30-second polling; polling pauses when the tab is hidden.
- Empty state explains that no requests were observed, and points at the known P1 boundary (only proxied traffic is captured).
- Time range, page size and last-used filters are persisted in local storage per company.

## Testing Decisions

Good tests here assert externally observable behaviour: what the proxy reports for a given upstream exchange, what the API returns for a given set of rows, and what the page renders for a given response. No test should assert internal helper structure or SQL shape.

Three seams, all with existing prior art:

1. **Provider proxy record extraction** (runner). Drive the proxy against a fake upstream HTTP server — the same approach as the existing performance-diagnostics tests — and assert the emitted record: status, duration ordering, first-token timing, token fields for streamed and non-streamed responses, `usage_missing` fallback when the upstream rejects `include_usage`, and no record for rejected requests (401/404/400).
2. **Usage service and routes** (server). Integration tests against the embedded Postgres used by the existing cost/usage tests: idempotent insertion on re-delivery, allocation summing exactly to the receipt, unpriced handling, timezone bucketing, and keyset pagination. Route tests follow the existing costs route tests for permission and validation.
3. **Usage page** (UI). Component test following the existing Costs page test: renders the cards and rows from a mocked response, shows `Unpriced` and `—` states, and applies filters. Sidebar navigation tests are updated for the new Org entry.

## Out of Scope

- CSV/JSON export.
- Server-sent events or live streaming of the log table.
- Capture for legacy adapters, Codex, Claude/Acpx, or direct-to-provider traffic that bypasses the proxy.
- Backfilling historical `cost_events` into request logs.
- Storing request or response bodies.
- Pricing estimation for unpriced models.
- A model price table or any local cost estimation.
- The Providers and Models tab contents.
- Row click-through to run or issue.
- Per-agent or per-project breakdown tabs on this page (Costs covers those views).

## Further Notes

- Known boundary: a request that bypasses the proxy, or a run whose records never reach the server, appears in `cost_events` but not in Usage. The Usage page is therefore a *request* view, not a second ledger; Costs remains the authoritative money view. This is recorded in ADR-0002.
- The `App` dimension is the harness, not the provider and not the agent. `Provider` is the API vendor and `Model` is the model id; this is fixed in `GLOSSARY.md`.
- Storage growth is roughly one row per model call — small compared to trace capture — but the 90-day sweep is still required because runs accumulate at heartbeat cadence.
- The page deliberately does not attempt to explain why a cost is unpriced; that remains the Costs page's data-quality notice.
