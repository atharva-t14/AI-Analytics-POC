# Implementation Changelog

## Update: ER Explorer + UX/Theme Refresh

The following shipped after the initial split-pipeline implementation.

### Added

- New route: `/er-diagram`
- New backend endpoint: `GET /raw/relationships`
- Mermaid-based ER rendering for allowlisted tables and joins
- Table Catalog + search on ER page
- Click-to-open Column Panel (powered by `/raw/schema`)
- Relationship row actions:
  - edge detail popover (cardinality/type/confidence/source)
  - copy JOIN snippet

### Frontend UX improvements

- Dark/Light mode toggle in app header with persisted preference
- Chat "continuous communication" flow:
  - staged in-flight progress panel while query runs
  - proactive "Continue with" follow-up chips
  - clearer clarification prompts
  - lightweight streaming reveal for insight text
- Dashboard enhancements:
  - KPI strip cards
  - chart grid capped to 2 charts per row on large screens

### Visual/accessibility updates

- Added theme-aware chart tokens (surface/axis/grid/tooltip)
- Replaced hardcoded dark-only/zinc classes with semantic token classes
- Improved light-mode contrast across chat, chart actions, dashboard, query, and ER pages

### Backend wiring

- `raw_query.py` now exposes allowlisted relationship metadata from
  `knowledge/join_graph/join_relationships.yaml` via `get_relationships()`.

### Files introduced/updated in this wave

- `frontend/src/app/er-diagram/page.tsx` (new)
- `backend/app/raw_query.py`
- `backend/app/main.py`
- `frontend/src/lib/api.ts`
- `frontend/src/components/AppNav.tsx`
- `frontend/src/app/layout.tsx`
- `frontend/src/app/globals.css`
- `frontend/src/components/ChartRenderer.tsx`
- `frontend/src/components/ChartDownloads.tsx`
- `frontend/src/components/ChatMessage.tsx`
- `frontend/src/app/page.tsx`
- `frontend/src/components/SavedChartTile.tsx`
- `frontend/src/components/ChartInspector.tsx`
- `frontend/src/components/SaveChartButton.tsx`
- `frontend/src/app/dashboard/page.tsx`
- `frontend/src/app/query/page.tsx`
- `frontend/src/app/builder/page.tsx`

This document covers the work done to unblock frontend items **#2** (lineage
display), **#3** (Save chart → POST /charts + replay via /execute), and **#5**
(query builder → DSL → /execute), plus the supporting backend persistence layer
and the CSV/PNG download feature.

---

## 1. Architecture summary

```
User input ─┬─► Chat (/) ──────────► POST /plan   ──► DSL
            ├─► Builder (/builder) ─────────────────► DSL
            └─► Saved tile replay  ──► POST /charts/{id}/run
                                                      │
                                                      ▼
                                                POST /execute (DSL → SQL → rows)
                                                      │
                                                      ▼
                                          ChartRenderer + ChartInspector
                                                      │
                                                      ▼
                                        SaveChartButton → POST /charts → JsonStore
```

The same `AnalyticsDSL` flows through every entrypoint, so there is a single
deterministic execution surface. Saved charts store the **DSL**, not the SQL or
the rows — replay always re-runs `QueryEngine.execute()` so compiler fixes /
schema changes are picked up automatically.

---

## 2. Backend changes

### 2.1 New: `backend/app/storage.py`
Thread-safe JSON file persistence used as the POC backing store for saved
charts and dashboards.

- Class `JsonStore` with `list(**filters)`, `get(id)`, `create(item)`,
  `update(id, patch)`, `delete(id)`.
- `create()` auto-injects `id` (uuid4), `created_at`, `updated_at` (UTC ISO).
- Writes are atomic (temp file + rename) and guarded by a per-store lock.
- Module-level singletons: `charts_store`, `dashboards_store`.
- Data files: `backend/data/charts.json`, `backend/data/dashboards.json`
  (directory created on first run).

The interface is intentionally small so the JSON backend can be swapped for a
real DB later without touching the endpoints.

### 2.2 New endpoints in `backend/app/main.py`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/plan` | NL → DSL only (no execution). |
| POST | `/execute` | DSL → SQL → rows (no planning). |
| POST | `/charts` | Save chart (`account_id` query param overrides body). |
| GET  | `/charts` | List charts for `account_id`. |
| GET  | `/charts/{id}` | Get one (404 cross-tenant). |
| PATCH | `/charts/{id}` | Update fields (title/description/dsl/viz). |
| DELETE | `/charts/{id}` | Delete. |
| POST | `/charts/{id}/run` | Replay stored DSL through `/execute`, returns rows + `chart_meta`. |
| POST | `/dashboards` | Save dashboard. |
| GET  | `/dashboards` | List. |
| GET/PATCH/DELETE | `/dashboards/{id}` | CRUD. |

Helper: `_ensure_account_scope(item, account_id)` raises **404** (not 403) on
cross-tenant access to avoid existence leaks.

### 2.3 `backend/app/schemas.py`
Added Pydantic models: `PlanRequest`, `ExecuteRequest`, `SavedChartCreate`,
`SavedChartUpdate`, `DashboardCreate`, `DashboardUpdate`.

### 2.4 `backend/app/query_engine.py` — pipeline split

Previously a single `process()`. Now:

- `plan(message, account_id, session_id, request_id)` →
  `{dsl, planner_source: "llm"|"fallback", request_id}` or `{error, request_id}`.
- `execute(dsl, request_id)` →
  `{sql, params, rows, row_count, visualization_type, intent_family, dsl,
    lineage, request_id, _query_result}` or `{error, request_id}`.
- `process()` is now a thin composer of `plan` + `execute` that also enriches
  the legacy response with `request_id`, `planner_source`, `dsl`, `sql`,
  `params`, `lineage`.
- New `_extract_lineage(compiled, dsl)` walks the sqlglot AST:
  - First `Table` from `find_all` → `base_table`.
  - The rest → `joined_tables`.
  - Returns `{metric_id, intent_family, base_table, joined_tables, tables,
    dimensions, filters}`.

### 2.5 Verified backend smoke test

```text
'show job volume by status'   rows=N   viz=bar
'job creation trend'          rows=19  viz=line
'candidate status breakdown'  rows=5   viz=funnel
```

(Run with `account_id=5`, the populated tenant in the local dump.)

---

## 3. Frontend changes

### 3.1 Types — `frontend/src/types/analytics.ts`
Added: `FilterClause`, `VisualizationPlan`, `AnalyticsDSL`, `QueryLineage`,
`ExecuteResponse`, `SavedChart`, `Dashboard`. Extended `QueryResponse` with
`request_id`, `planner_source`, `dsl`, `sql`, `params`, `lineage`.

### 3.2 API client — `frontend/src/lib/api.ts`
New helpers: `planQuery`, `executeDsl`, `saveChart`, `listCharts`, `getChart`,
`deleteChart`, `runChart`, `listDashboards`, `getDashboard`, `createDashboard`,
`updateDashboard`, `deleteDashboard`.

Account state:
- `DEFAULT_ACCOUNT_ID = 5` (was `3828832` — empty tenant; switched to the
  populated dump tenant).
- `getAccountId()` migrates the legacy `3828832` value out of `localStorage` so
  existing browser sessions self-heal on next page load.
- `setAccountId(id)` persists to `localStorage` (key `analytics_account_id`).

### 3.3 Hook — `frontend/src/lib/useAccountId.ts`
`useAccountId(): [number, (id: number) => void]`. Subscribes to a custom window
event `'analytics-account-changed'` so account changes propagate across pages
without reload.

### 3.4 New components

- **`AppNav.tsx`** — sticky top nav (h-14). Links: `/`, `/builder`, `/charts`,
  `/dashboard`. Account input on the right. Active state via `usePathname`.
- **`ChartInspector.tsx`** — collapsible panel with tabs:
  - `lineage` (grid of metric / intent / base_table / joined_tables /
    dimensions / filters)
  - `dsl` (JSON pre)
  - `sql` (pre, whitespace-pre-wrap)

  Header shows `planner_source` and `rowCount` badges.
- **`SaveChartButton.tsx`** — inline popover with title + description. Calls
  `saveChart()`. Shows "Saved ✓" on success.
- **`SavedChartTile.tsx`** — auto-runs `runChart(chart.id, accountId)` on
  mount, renders the result with `ChartRenderer` + `ChartInspector`, includes
  delete (✕) with `confirm()`.
- **`ChartDownloads.tsx`** — CSV + PNG export buttons:
  - **CSV**: union of all row keys for headers, RFC-4180 quoting, downloads
    `<filename>.csv`.
  - **PNG**: finds the first `<svg>` inside a supplied `chartRef`, clones it,
    sets explicit width/height from `getBoundingClientRect`, serializes →
    base64 data URL → `Image` → 2× canvas with `#09090b` background →
    `toBlob('image/png')`.
  - Filename is sanitized (`[^a-z0-9._-]` → `_`).
  - Tables (no SVG) gracefully show "tables only support CSV" inline; CSV still
    works.

### 3.5 Updated components / pages

- **`ChatMessage.tsx`** — accepts `accountId?`, `userQuery?`. New actions row
  below the chart with `ChartDownloads` (left) + `SaveChartButton` (right).
  `ChartInspector` shown when any of `lineage / dsl / sql` is present.
- **`MetricsSidebar.tsx`** — `h-screen` → `h-full`, retitled to
  "Metrics Catalogue".
- **`layout.tsx`** — wraps children with `<AppNav />` inside
  `flex flex-col h-screen`.
- **`page.tsx`** (chat) — uses `useAccountId()`; removed duplicate account
  selector. Resolves `userQuery` for each assistant message by scanning
  backwards for the previous user message; passes `accountId` + `userQuery` to
  `ChatMessage`. Root `h-screen` → `h-full`.

### 3.6 New pages

- **`/charts`** (`app/charts/page.tsx`) — 2-col grid of `SavedChartTile`s with
  empty / loading / error states. Removes deleted charts from local list.
- **`/dashboard`** (`app/dashboard/page.tsx`) — same shape, 3-col on xl; framed
  as the "default dashboard" (all charts). Named dashboards via `/dashboards`
  API are not yet wired into the UI.
- **`/builder`** (`app/builder/page.tsx`) — metric-first DSL editor:
  - Left (sticky): Metric `<select>` from `/metrics`; breakdown chips
    (`label / firstname / month / week / day`) + custom dimension input;
    filter rows (`field`, op from
    `[eq,neq,gt,lt,gte,lte,contains]`, value); visualization
    (`[table,bar,line,pie,donut,funnel]`); intent family input; Run button.
  - Right: empty / error / result panel with `ChartRenderer` +
    `ChartDownloads` + `SaveChartButton` + `ChartInspector`.
  - DSL built reactively via `useMemo`; on run calls `executeDsl(dsl,
    accountId)`; adopts `result.visualization_type` if the compiler overrides
    (e.g. `candidate_list` forces table).

---

## 4. Save-chart flow (end-to-end)

1. User clicks **Save chart** in chat / builder.
2. Popover collects title + description.
3. `saveChart()` → `POST /charts?account_id=<id>` with body
   `{ account_id, title, description, natural_language_query, dsl,
     visualization_type, lineage }`.
4. Endpoint forces `account_id` from the query param onto the record (body
   can't lie about tenant), then calls `charts_store.create(payload)`.
5. `JsonStore.create()` injects `id` + timestamps, atomically appends to
   `backend/data/charts.json`.
6. UI flips button to "Saved ✓".
7. `/charts` and `/dashboard` later list the record; each `SavedChartTile`
   calls `POST /charts/{id}/run`, which re-hydrates the stored DSL (forcing
   the current `account_id`) and pipes it through `QueryEngine.execute()` —
   **DSL replay, not SQL replay**.

**Stored**: title, description, NL query, DSL, viz type, lineage, tenant,
timestamps.
**Not stored**: SQL, params, rows. All recomputed per run.

---

## 5. Files touched

### Backend
- `backend/app/storage.py` *(new)*
- `backend/app/schemas.py`
- `backend/app/main.py`
- `backend/app/query_engine.py`

### Frontend — new
- `frontend/src/lib/useAccountId.ts`
- `frontend/src/components/AppNav.tsx`
- `frontend/src/components/ChartInspector.tsx`
- `frontend/src/components/SaveChartButton.tsx`
- `frontend/src/components/SavedChartTile.tsx`
- `frontend/src/components/ChartDownloads.tsx`
- `frontend/src/app/builder/page.tsx`
- `frontend/src/app/charts/page.tsx`
- `frontend/src/app/dashboard/page.tsx`

### Frontend — modified
- `frontend/src/types/analytics.ts`
- `frontend/src/lib/api.ts`
- `frontend/src/components/ChatMessage.tsx`
- `frontend/src/components/MetricsSidebar.tsx`
- `frontend/src/app/layout.tsx`
- `frontend/src/app/page.tsx`

---

## 6. Tenant safety

- Every chart/dashboard endpoint requires `account_id` (query param).
- POST handlers force `account_id` from the query param onto the persisted
  record so a client cannot save into another tenant.
- GET/PATCH/DELETE return **404** (not 403) on cross-tenant access to avoid
  existence leaks.
- JWT-based auth replacing the query param is still pending.

---

## 7. Known limitations / next steps

- **Named dashboards**: the `/dashboards` CRUD exists but the UI only shows a
  "default dashboard" containing all saved charts. Naming + chart selection UI
  is the next iteration.
- **Result caching**: `/charts/{id}/run` re-runs SQL on every page load. Add a
  short-lived in-memory cache keyed by `(chart_id, dsl_hash, account_id)` if
  this becomes noticeable.
- **Viz-type switching on saved charts**: stored `visualization_type` is
  authoritative; no UI to change it after save yet.
- **Auth**: still query-param tenancy. Replace with JWT before any non-local
  deployment.
- **LLM SSL**: Groq is currently unreachable from the dev box, so the
  deterministic fallback planner is the active code path. The split between
  `plan` and `execute` means swapping the planner is a one-line change.

---

## 8. Possible improvements (showcase-worthy)

A backlog of features that would meaningfully extend the product. Grouped by
theme; ordered roughly by "demo wow-factor per unit of effort".

Status tags in this section:

- `[shipped]` implemented in current codebase
- `[partial]` implemented in part, with follow-on scope remaining
- `[pending]` not yet implemented

### 8.1 Conversational & AI

- **[pending] Follow-up turn awareness** — pass the last N (DSL, result-summary) pairs
  to the planner so "now break that down by recruiter" works.
- **[pending] Clarification loop UX** — when the planner returns multiple metric
  candidates, render them as chips the user can pick, then re-plan with the
  choice locked in.
- **[pending] Auto-insight narration** — after every query, a short LLM call summarises
  the result ("Hiring slowed 32% in Q1; sourcing channel concentration is
  highest in March") and surfaces anomalies.
- **[partial] Suggested next questions** — follow-up chips are shown after
  results; next step is making them lineage/result-shape driven
  (e.g. seeing `funnel` → suggest "stage conversion rates" and "time in each
  stage").
- **[pending] Voice input** — Web Speech API → planner. Cheap, very demo-friendly.
- **[pending] Multilingual NL** — planner system prompt already model-agnostic; just
  translate `metric.description` lists on the fly.
- **[pending] "Explain this number" drill-down** — click any datapoint → planner gets
  `(metric, filter_to_this_cell)` → returns the row-level list backing it.
- **[pending] Forecasting** — for time-series metrics, add a Prophet/statsforecast pass
  and overlay a dashed forecast line with confidence band.
- **[pending] Anomaly detection** — z-score / STL decomposition on time-series, mark
  outlier bars in red with hover explanation.

### 8.2 Query builder & DSL

- **[partial] Visual join graph** — ER graph is implemented for allowlisted
  relationships; next step is using `safe_join_paths.yaml` directly and letting
  node clicks add dimensions/filters.
- **Schema-aware field picker** — replace freetext `field` input with a typed
  picker driven by `column_roles/*.yaml`.
- **Filter values from distinct query** — for low-cardinality columns
  (`status`, `source`), fetch distinct values and render a multiselect.
- **Date-range presets** — Last 7d / 30d / QTD / YTD / custom with a
  calendar picker; emit as DSL `filters`.
- **Saved DSL snippets / templates** — "starter queries" library.
- **Multi-metric compare** — DSL already supports `metrics: [...]`; render as
  grouped bars / multi-line.
- **Cross-filter** — clicking a bar in one chart applies it as a filter
  across other charts on the page.

### 8.3 Dashboards

- **Named dashboards** — wire the existing `/dashboards` CRUD; users can
  create, rename, share.
- **Drag-and-drop layout** — react-grid-layout; persist `(x, y, w, h)` per
  chart in the dashboard record.
- **Global dashboard filters** — date range / recruiter applied to every
  chart, merged into each DSL at execute time.
- **Scheduled email digests** — APScheduler job runs dashboard charts on a
  cron, emails PNG screenshots + CSV attachments.
- **Public share link** — signed URL with read-only token, scoped to one
  dashboard.
- **Embed mode** — `?embed=1` strips chrome; iframe-friendly.
- **Snapshots / time-travel** — store a `result_snapshot` row per chart per
  day so users can compare "this week vs last week" without re-querying.

### 8.4 Visualization

- **Viz auto-recommend** — already partly there (compiler overrides); extend
  with rules (≤6 categories → pie/donut; time dim → line; >1 metric → grouped
  bar; >20 categories → horizontal bar; geo dim → map).
- **More chart types** — stacked/grouped bar, area, heatmap, scatter, funnel
  with conversion %s, Sankey for stage transitions, choropleth for locations.
- **[shipped] Theme toggle** — light/dark mode is implemented app-wide with
  palette-aware chart and surface tokens.
- **Custom palette per dashboard**.
- **Chart annotations** — pinpoint events ("offer accepted spike on
  2026-03-14") with hover notes; stored alongside the chart record.
- **Conditional formatting in tables** — heatmap cells, status pills.
- **Pivot table** — for table viz, drag dimensions between rows/columns/values.

### 8.5 Performance & data engineering

- **Query result cache** — keyed by `sha256(sql+params)`, TTL 5-15 min, in
  Redis. Surfaces a `cache_hit` badge in the inspector.
- **Materialized aggregates** — nightly job pre-computes the heavy funnel /
  transition metrics; planner adds a `prefer_materialized: true` flag.
- **Read replica routing** — analytics traffic → replica DSN.
- **Streaming results** — for large result sets, stream rows via SSE so the
  table renders progressively.
- **Server-side pagination + sorting** for tables.
- **Query cost estimation** — `EXPLAIN` parsed → warning badge before run if
  cost > threshold.
- **Slow-query log + autoindex suggester** — log everything > 1s with the
  generated SQL; suggest indexes based on `WHERE` / `JOIN` columns.

### 8.6 Auth, multi-tenancy & permissions

- **JWT auth** with refresh; remove the `account_id` query param.
- **Role-based access** — viewer / editor / admin per dashboard.
- **Per-metric access policies** — e.g. hide salary metrics from non-HR
  roles; enforced in compiler, not just UI.
- **Row-level security** — recruiter sees only their own jobs; injected as a
  forced filter into the DSL by the planner.
- **Audit log** — who ran what, when, against which tenant; surfaced as a
  searchable view.
- **SSO** (Google / Okta) via NextAuth.

### 8.7 Observability & quality

- **Request-id propagation banner** — already plumbed through; surface in the
  inspector + log link.
- **OpenTelemetry traces** — span per planner / compiler / executor stage.
- **Prometheus metrics** — `queries_total`, `planner_fallback_ratio`,
  `execute_latency_seconds`, `compile_errors_total`.
- **Golden-query CI** — already have `evaluation/test_benchmark.py`; run on
  every PR, post pass/fail summary as a check.
- **Visual regression** for charts (Playwright + image diff).
- **LLM-as-judge eval** — score generated SQL against a target SQL for
  semantic equivalence, not just text match.
- **Error tracking** — Sentry on both Next.js and FastAPI.

### 8.8 Collaboration & sharing

- **Comments / threads on charts** — Slack-style replies attached to a chart;
  highlight a datapoint to anchor a comment.
- **Mentions + notifications** — `@alex look at this anomaly`.
- **"Pin to Slack/Teams"** — webhook posts the PNG + title + link.
- **Public read-only embed** for blog posts / wikis.
- **Versioning** — each PATCH on a chart bumps a version; show a diff of the
  DSL between versions.

### 8.9 Power-user features

- **SQL escape hatch** — toggle the inspector's SQL pane to editable, run
  arbitrary SQL (still tenant-scoped at the engine level).
- **DSL JSON editor** with schema-aware Monaco intellisense.
- **Keyboard shortcuts** — `⌘K` command palette ("save chart", "switch
  account", "open dashboard X"), `r` re-run, `e` open inspector.
- **Bulk export** — download an entire dashboard as a single XLSX with one
  sheet per chart + a cover sheet of metadata.
- **API tokens** — let users hit `/execute` from notebooks / Zapier.
- **Webhooks** — fire on threshold breach ("offer_accept_rate < 0.4").

### 8.10 Onboarding & UX polish

- **Empty-state walkthrough** — first-run, autoload three sample saved charts
  + a tour pointing at chat / builder / dashboard.
- **Inline metric glossary** — hover any metric chip to see its definition,
  formula, and source table.
- **"What can I ask?" panel** — categorised example prompts pulled from
  `golden_queries/*.yaml`.
- **Loading skeletons** for all charts (currently only some).
- **Optimistic UI** for save/delete with rollback on error.
- **Mobile layout** — current grids break on narrow viewports.
- **Recently viewed** rail on the homepage.

### 8.11 Quick wins (low effort, high signal)

These are an afternoon of work each:

1. **[shipped]** Hover on a `SavedChartTile` shows last-run timestamp + row count.
2. **[shipped]** "Duplicate chart" button (clone DSL + open builder pre-filled).
3. **[shipped]** "Copy as cURL" in the inspector — replays the exact `/execute` request.
4. **[shipped]** Toast notifications for save / delete / error (replace alerts).
5. **[shipped]** Sort + search on the `/charts` list.
6. **[shipped]** Color-code the planner-source badge (`llm` green, `fallback` amber).
7. **[partial]** Show the SQL diff when a saved chart's compiled SQL changes between runs
   (catches drift visibly).
8. **[shipped]** CSV download includes a header comment row with metric + DSL hash.
