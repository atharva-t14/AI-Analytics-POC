# Solution Architecture

A detailed technical overview of how the AI Analytics POC is put
together: the system's layers, the request flows behind each user-facing
feature, the safety mechanisms, and a candid list of where the design
should be hardened next.

> Companion docs: [USER_GUIDE.md](USER_GUIDE.md) for end-user features,
> [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md) for the original
> design notes.

---

## 1. High-level shape

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js 16 / React 19 / Tailwind v4)                     │
│  ─ pages: Chat • Builder • Query Builder • ER • Saved • Boards     │
│  ─ axios client  →  http://127.0.0.1:8000                          │
└──────────────────────────────┬─────────────────────────────────────┘
                               │  REST/JSON
┌──────────────────────────────▼─────────────────────────────────────┐
│  FastAPI app (uvicorn)                                             │
│                                                                    │
│  Conversational path                Ad-hoc path     Persistence    │
│  ┌──────────────┐                   ┌────────────┐  ┌────────────┐ │
│  │ QueryEngine  │──┐                │ raw_query  │  │ JsonStore  │ │
│  │  ├ LLM       │  │                │  ├ allow-  │  │  ├ charts  │ │
│  │  ├ retrieval │  │                │  │  list   │  │  └ boards  │ │
│  │  ├ DSL       │  │                │  └ INFO-   │  └────────────┘ │
│  │  ├ compiler  │  │                │     SCHEMA │                 │
│  │  └ executor  │  │                └─────┬──────┘                 │
│  └──────────────┘  │                      │                        │
│        ▲           │                      │                        │
│        │   Knowledge YAML (metrics,       │                        │
│        │   joins, transitions, schema)    │                        │
│        │                                  ▼                        │
│        └──────────► SQLAlchemy engine ◄────                        │
└──────────────────────────────┬─────────────────────────────────────┘
                               │  unix socket
                       ┌───────▼────────┐
                       │ MySQL (Recruit │
                       │ CRM normalized)│
                       └────────────────┘
```

Two distinct request paths share the same database engine, tenant model,
and chart rendering:

1. **Conversational path** — natural language → LLM planner → DSL →
   compiler → SQL → execution → response. Used by Chat, Builder, and
   Saved Chart replay.
2. **Ad-hoc path** — point-and-click table/column picker → validated
   payload → SQL → execution → response. Used by Query Builder.

---

## 2. Backend layers

### 2.1 Knowledge base (`backend/knowledge/*.yaml`)

Hand-authored YAML files that encode domain knowledge the LLM cannot
infer reliably from the schema alone:

| Folder | Purpose |
|--------|---------|
| `metrics/` | Each business metric: name, aliases, intent family, default visualization, numerator SQL fragment, allowed dimensions, validation rules. |
| `join_graph/` | Safe and forbidden join paths between tables, plus relationship cardinalities. |
| `transitions/` | Funnel / pipeline semantics (which status sequence means "moved to interview", how to reconstruct timelines from event tables, edge cases). |
| `schema_reality/` | Per-table column roles, distributions, observed relationships, sampled values. The "ground truth" the planner is grounded in. |
| `golden_queries/` | Reference NL→DSL→SQL examples used in regression tests. |

These files are read once at startup and serve two roles: they constrain
the planner's tool schema (so it can only choose real metrics) and they
feed the audit reports in `backend/audit/`.

### 2.2 LLM planner (`app/llm_engine.py`)

A retrieval-augmented planner powered by Groq's `llama-3.3-70b-versatile`.

- **Two tools, one decision per turn**:
  - `build_analytics_query` — produce a valid DSL.
  - `clarify_or_decline` — return `out_of_scope` or `ambiguous` with
    suggestions when the question can't be answered as-is.
- `tool_choice="auto"`; the model picks one, the engine dispatches on
  `tool_calls[0].function.name`, and `clarify_or_decline` raises a
  typed `ClarificationNeeded` exception so the API can map it to a
  structured `is_clarification: true` payload.
- **Dynamic tool-schema scoping**: before each call, `retrieval.py`
  scores the user's message against every executable metric (TF-IDF +
  alias boost) and picks the top-K candidates. The tool schema's
  `metrics` enum is then *constrained* to those K — so the model
  literally cannot hallucinate a metric that doesn't exist.
- **SSL escape hatch**: `GROQ_INSECURE_SSL=1` swaps in an `httpx.Client(verify=False)`
  for corporate networks with TLS interception.

### 2.3 DSL (`app/dsl.py`)

A Pydantic model — `AnalyticsDSL` — that is the contract between the
planner and the executor. It captures: `metric`, `dimensions`,
`filters`, `intent_family`, `visualization_type`, `account_id`,
`limit`, `time_range`, etc. Every downstream layer reads from this one
object, which makes the pipeline reproducible and testable.

### 2.4 Deterministic compiler + executor (`deterministic_compiler.py`, `executor.py`)

Given a DSL, the compiler emits SQL with `sqlglot`, splices the
metric's `numerator_sql` fragment, applies dimensions/filters with
parameterized placeholders, and pins the tenant scope to the DSL's
`account_id`. The executor runs it through a pooled SQLAlchemy engine
and returns rows + the compiled SQL string + lineage metadata.

> Why "deterministic" matters: the same DSL always produces the same
> SQL. That lets us cache, replay saved charts months later, and
> regression-test the planner without needing a live DB connection.

### 2.5 Query engine glue (`app/query_engine.py`)

A thin orchestrator that owns the LLM + retrieval + compiler +
executor lifecycle and exposes three methods:

- `plan(message, account_id)` — NL → DSL (no DB hit). Handles
  `ClarificationNeeded` and returns a clarification payload.
- `execute(dsl)` — DSL → rows + SQL + lineage.
- `process(message, account_id, session_id)` — convenience wrapper
  used by `/query`: plan, execute, and shape the response for the
  chat UI.

### 2.6 Ad-hoc query layer (`app/raw_query.py`)

Independent of the metric/DSL flow. Used only by the Query Builder.

- **Allowlist**: `ALLOWED_TABLES` is a hardcoded list of the 8 tables
  we've audited. Any other table name is rejected.
- **Live introspection**: columns are pulled from
  `INFORMATION_SCHEMA.COLUMNS` on first call and cached in-process —
  so adding a column in MySQL surfaces in the UI automatically.
- **Validation**: every `table.column` reference in the incoming
  payload is checked against the introspected schema before any SQL
  is composed.
- **Compilation rules**: only enum operators (`eq`, `lte`, `like`,
  `in`, `is_null`, …), only enum aggregates (`count`, `count_distinct`,
  `sum`, `avg`, `min`, `max`), only `INNER`/`LEFT`/`RIGHT` joins,
  values always bound as `:p0, :p1, …`, identifiers always
  backtick-quoted, `LIMIT` hard-capped at 1000.
- **Tenant scoping**: if the primary table has an `accountid` (or
  `account_id`) column, `WHERE primary.accountid = :tenant_account_id`
  is auto-injected.

### 2.7 Persistence (`app/storage.py`)

Saved charts and dashboards live in atomic JSON files under
`backend/data/`. `JsonStore` is a tiny generic CRUD layer:

- `_read` / `_write` reload the whole file on every call (fine for
  POC scale).
- `create` assigns a UUIDv4 `id` and `created_at` / `updated_at`
  timestamps.
- `list(**filters)` does in-memory filtering (used for `account_id`
  scope).

Trade-offs: zero infrastructure, easy to grep, terrible at concurrency.
This is the most obvious thing to swap for SQLite / Postgres when this
graduates from a POC.

### 2.8 API surface (`app/main.py`)

A flat FastAPI app. All endpoints are unauthenticated for the POC; the
"tenant" is whatever `account_id` the caller sends.

| Endpoint | Used by |
|----------|---------|
| `POST /query`   | Chat (full plan + execute + format) |
| `POST /plan`    | Builder (plan only, no execution) |
| `POST /execute` | Builder + Saved Chart replay (DSL → rows) |
| `GET  /metrics` | Sidebar / Builder metric pickers |
| `POST/GET/PATCH/DELETE /charts[/{id}]` + `POST /charts/{id}/run` | Saved Charts CRUD + live replay |
| `POST/GET/PATCH/DELETE /dashboards[/{id}]` | Dashboards CRUD |
| `GET  /raw/schema`   | Query Builder + ER Column Panel bootstrap |
| `GET  /raw/relationships` | ER diagram/table relationships |
| `POST /raw/execute`  | Query Builder run-button |

Cross-tenant access on any item endpoint returns **404** (not 403) so
attackers can't enumerate IDs.

---

## 3. Frontend layers

### 3.1 Stack

- **Next.js 16 / React 19** App Router, all routes are client
  components (`'use client'`). No SSR data fetching — the backend is
  the single source of truth.
- **Tailwind v4** for styling, **recharts** for visualization,
  **axios** for HTTP.

### 3.2 Shared modules

- `src/lib/api.ts` — every HTTP call lives here; one axios instance,
  typed helpers for each endpoint.
- `src/lib/useAccountId.ts` — `useAccountId()` hook backed by
  `localStorage`, with a migration that rewrites legacy default
  `3828832` → `5`.
- `src/types/analytics.ts` — TypeScript mirrors of the backend
  Pydantic models (`AnalyticsDSL`, `ExecuteResponse`, `SavedChart`,
  `Dashboard`, etc.).
- `src/components/ChartRenderer.tsx` — single recharts wrapper used
  everywhere. Auto-detects `xKey` and measures, uses theme-aware chart
  tokens, custom tooltip styling, and gradient series rendering.

### 3.3 Reusable chart actions

- `ChartInspector` — collapsible lineage / DSL / SQL panel.
- `ChartDownloads` — CSV (RFC-4180 quoted, union of row keys) +
  PNG (clones the first SVG, draws to a 2× canvas with `#09090b`
  background, exports `image/png`).
- `SaveChartButton` — modal for title/description, POSTs to
  `/charts`.

These three are imported by Chat, Builder, Query Builder (CSV/PNG),
Saved Charts, and Dashboards — guaranteeing consistent UX.

### 3.4 Page-level state

State is held locally per page; nothing is hoisted into a global
store. Per-account caches in `localStorage`:

- `analytics_account_id`
- `analytics_session_id` (random per-browser ID, sent on every
  chat message)
- `analytics_recent_prompts_{accountId}` (Recent Prompts list)

---

## 4. Request flows per feature

### 4.1 Chat (`/`)

```
ChatInput.onSubmit("show job volume by status")
   │
   ▼
POST /query { message, account_id, session_id }
   │
   ▼ QueryEngine.process
   ├─ retrieval.top_k_metrics(message)
   ├─ llm.tool_call(scoped_schema)
   │     └─ tool=build_analytics_query → DSL
   │       (or tool=clarify_or_decline → ClarificationNeeded)
   ├─ compiler.compile(DSL) → SQL + params
   ├─ executor.run(SQL, params) → rows
   └─ assemble {rows, dsl, sql, lineage, visualization_type}
   │
   ▼
ChatMessage renders ChartRenderer + Inspector + Downloads + Save
   │
   ▼  on success (not is_clarification, no error)
rememberPrompt(text) → localStorage → MetricsSidebar.Recent
```

### 4.2 Builder (`/builder`)

The user picks metric/dimensions/filters/viz manually. The frontend
constructs a DSL directly and `POST /execute`s it. No LLM involved.
Same execution path → same rendering.

### 4.3 Query Builder (`/query`)

```
On mount:  GET /raw/schema  →  {tables[8], operators, aggregates, max_limit}
   │
   ▼
User picks primary_table, columns (+aggregate/alias), joins,
filters (op + value), group_by, order_by, limit
   │
   ▼
POST /raw/execute { account_id, primary_table, columns, joins, filters, … }
   │
   ▼ raw_query.build_and_run
   ├─ validate every table/column against introspected schema
   ├─ enforce enum operators / aggregates / join types
   ├─ inject tenant filter on primary table if accountid exists
   ├─ build SQL with backticked identifiers + bound params
   └─ engine.execute → rows
   │
   ▼
ResultsPanel toggles Table view ↔ Chart view (ChartRenderer with picker)
```

### 4.4 ER Diagram (`/er-diagram`)

```
On mount: GET /raw/relationships + GET /raw/schema
  │
  ▼
Render Mermaid ER map (allowlisted tables + edges)
  │
  ├─ Table Catalog + search (column count + badges)
  ├─ Click table -> Column Panel (name/type/nullable)
  └─ Relationship row actions:
      - Details popover (cardinality/type/confidence/source)
      - Copy JOIN snippet
```

### 4.5 Saved Charts (`/charts`)

`listCharts(accountId)` → grid of `SavedChartTile`s. Each tile calls
`POST /charts/{id}/run` on mount, which re-executes the stored DSL with
the live tenant. The stored DSL → live rows guarantees freshness without
caching layers.

Rename uses `PATCH /charts/{id}` with just `{title}`; the parent page
merges the response into its local list.

### 4.6 Dashboards (`/dashboard`)

A two-column layout. The sidebar lists `listDashboards(accountId)` plus
an "All charts" pseudo-entry. The main panel:

- Renders only the charts whose IDs appear in
  `dashboard.chart_ids` (preserving order; skips deleted ones).
- **+ Add charts** opens a picker of every chart not currently in the
  dashboard; clicking one calls `PATCH /dashboards/{id}` with the new
  `chart_ids` (optimistic update with rollback).
- **Remove** on a tile shrinks `chart_ids` (chart itself untouched).
- **Rename** / **Delete dashboard** use the same PATCH/DELETE
  endpoints.

### 4.7 Recent prompts

Pure frontend feature. Persisted in `localStorage`, scoped by
`accountId`, capped at 15. Only prompts that produced a non-error,
non-clarification response are remembered. The sidebar component
exposes click / remove / clear handlers that the page wires to setters.

### 4.8 Clarification flow

```
User: "how are we doing?"
   │
   ▼ /query
   │
   ▼ QueryEngine.plan
   ├─ LLM picks clarify_or_decline(reason="ambiguous",
   │     message=..., suggestions=[...])
   └─ raises ClarificationNeeded
   │
   ▼ process maps to {is_clarification: true, message, options,
   │                  clarification_reason}
   ▼
ChatMessage renders the message + suggestion chips.
Clicking a chip is just another POST /query with that text.
```

---

## 5. Cross-cutting concerns

### 5.1 Tenant isolation

- Every authenticated-equivalent endpoint takes `account_id` as a
  query param or in the body.
- Persistence reads filter by `account_id` server-side.
- Cross-tenant reads return **404**.
- DSL `account_id` is **overridden** by the request's `account_id` on
  `/execute` and `/charts/{id}/run`, so saved charts can never leak
  across tenants even if their stored DSL was tampered with.
- Raw queries inject the `accountid` filter server-side; the frontend
  cannot opt out.

### 5.2 SQL safety

| Surface | Defense |
|---------|---------|
| DSL path | Numerator SQL fragments are hand-authored in YAML; dimensions/filters use `sqlglot` AST construction; values bound as params. |
| Raw path | Allowlisted tables, schema-validated columns, enum operators/aggregates/joins, backticked identifiers, bound params, hard `LIMIT` cap. |

There is currently **no** code path where a user-supplied string is
concatenated into SQL.

### 5.3 Observability

- File-rotating logs under `backend/logs/analytics.log` (daily, 30
  days retained).
- Each request gets a `request_id`; the planner emits structured
  multi-line traces (`[RAG]`, `[PLANNER]`, `[COMPILER]`,
  `[EXECUTOR]`, `[RAW]`) tagging steps with the same id so a full
  request can be reconstructed from logs.
- Token usage is captured from the Groq response.

### 5.4 Auditability

`backend/audit/` holds yaml snapshots — `audit_report`,
`contradiction_report`, `system_scorecard`. The audit runner walks the
knowledge base and flags missing/inconsistent metric definitions before
the planner ever sees them.

### 5.5 Evaluation

`backend/evaluation/test_benchmark.py` runs the `golden_queries/`
suite end-to-end (NL → DSL → SQL → rows) and scores planner output
against expected DSL shape. This is the regression net when changing
the system prompt or tool schema.

---

## 6. How features map back to architecture

| Feature | Backend pieces it relies on | Frontend pieces |
|---------|-----------------------------|-----------------|
| Chat answer | LLM + retrieval + compiler + executor + knowledge | `ChatMessage`, `ChartRenderer`, `Inspector` |
| Clarification | LLM `clarify_or_decline` tool + `ClarificationNeeded` mapping | suggestion chips in `ChatMessage` |
| Recent prompts | — (pure client) | `MetricsSidebar` + `localStorage` |
| Builder | `/plan` (optional) + `/execute` + `/metrics` | metric pickers, filter rows |
| Query Builder | `raw_query` allowlist + introspection + safe compiler | tables/columns/joins/filters UI, `ResultsPanel` toggle |
| Save chart | `POST /charts` (DSL stored verbatim) | `SaveChartButton` modal |
| Replay saved chart | `POST /charts/{id}/run` (DSL re-executed with live tenant) | `SavedChartTile` on mount |
| Rename chart / dashboard | `PATCH /charts/{id}` / `PATCH /dashboards/{id}` | inline editor in tile / header |
| Dashboards | `dashboards_store` + `chart_ids: []` patch | sidebar + picker + grid in `dashboard/page.tsx` |
| CSV / PNG export | — (pure client) | `ChartDownloads` (RFC-4180 + SVG→canvas→PNG) |
| Lineage inspector | `lineage` field on `ExecuteResponse` (compiler-emitted) | `ChartInspector` |
| Tenant safety | `_ensure_account_scope`, `account_id` overrides, raw tenant injection | `useAccountId` hook |

---

## 7. Potential improvements

Ordered roughly by ROI. Items marked **★** are the highest-leverage.

### 7.1 Persistence and concurrency ★

- Replace `JsonStore` with SQLite (zero ops) or Postgres. Real
  transactions, indexed `account_id` lookups, no whole-file rewrites,
  safe concurrent writers.
- Add `unique(account_id, name)` for dashboards and per-account
  ordering hints (for the sidebar).

### 7.2 AuthN / AuthZ ★

- Today there is no auth — `account_id` is whatever the client sends.
  Add JWT (or session cookie) issuance, derive `account_id` from the
  authenticated principal, drop it from query params entirely.
- Role-based gating for the Query Builder (it can read raw rows of
  any allowlisted table — appropriate for analysts, not necessarily
  every user).

### 7.3 Raw query layer ★

- Add **aggregate-on-joined-column** safety: today a SUM over a
  one-to-many joined table inflates counts. Either warn in the UI or
  detect cardinality from the join graph and refuse.
- Surface **column descriptions** from `schema_reality/column_roles/`
  in the column picker so users know what each column means.
- Persist saved raw queries (parallel to saved charts) so a Query
  Builder result can also be added to a dashboard.
- Per-account `MAX_LIMIT` and a query timeout (`SET STATEMENT
  max_execution_time = …`).

### 7.4 Planner quality

- Replace TF-IDF retrieval with an embedding model
  (`text-embedding-3-small` or local SBERT) for better metric
  matching on paraphrases.
- Few-shot prompt the model with the closest `golden_queries/`
  example.
- Add a **planner self-check** turn: after producing a DSL, ask the
  model to validate it against the user's intent in a single
  cheap call, and surface low-confidence answers as soft
  clarifications.
- Cache plans by `(message, account_id)` for repeat questions
  (e.g. recent-prompts re-clicks).

### 7.5 Dashboards

- Drag-and-drop reordering of charts within a dashboard
  (`chart_ids` is already an ordered list, the UI just needs the
  reorder).
- Grid layout with resize handles (`react-grid-layout`).
- Per-dashboard global filters (date range, recruiter, etc.) that
  override per-chart DSL filters at run time.
- Public share links (signed, tenant-scoped, read-only).
- Dashboard-level export (PDF/zip-of-PNGs).

### 7.6 Saved charts

- Edit the **stored DSL** in-place from the inspector, not just the
  title (today renaming/redescribing is the only mutation; to change
  the chart you have to delete and re-save).
- Version history when DSL is edited.
- "Pin to top" / favorites.

### 7.7 Frontend resilience

- Replace per-page `useEffect` fetches with React Query / SWR for
  request dedup, retries, optimistic mutations, and stale-while-
  revalidate.
- Show a non-blocking toast on background errors instead of inline
  red text in some places.
- Real loading skeletons on `SavedChartTile` instead of "Running
  query…" text.

### 7.8 Observability

- Ship structured logs to a JSON sink (or `loguru`) so request_id
  filtering is trivial.
- Add OpenTelemetry spans across plan → compile → execute; surface
  step timings in the Inspector.
- Persist planner traces (input, candidates, chosen tool, DSL, SQL,
  row count, latency, tokens) so we can mine them for regressions.

### 7.9 Tests

- `backend/scripts/test_regression.py` exists — wire it into a
  GitHub Actions job that runs against a seeded test DB on every PR.
- Frontend: Playwright smoke for each page's happy path; Vitest
  units for `api.ts` URL/payload construction.

### 7.10 LLM provider abstraction

- Today `llm_engine.py` is hardcoded to Groq. Wrap it behind a thin
  interface (`plan(message) -> DSL | Clarification`) and add an
  OpenAI / Anthropic adapter. Useful both for failover and for
  comparing planner quality.

### 7.11 Schema sync

- Allowlist changes today require a backend restart. Either:
  - bust the schema cache on a TTL, or
  - expose a `/raw/schema/refresh` admin endpoint, or
  - watch `INFORMATION_SCHEMA` change events.

### 7.12 Polish

- Per-chart **edit visualization** in the Saved Chart inspector
  (change bar → line without re-saving).
- Keyboard shortcuts (`?` for command palette, `↑` to recall last
  prompt in chat).
- Dark/light theme toggle (the design is dark-first; light mode would
  need a token sweep).
- i18n scaffolding — all UI strings are currently inline English.

---

## 8. Quick build / run reference

```bash
# Backend (port 8000)
cd backend
python3.9 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# .env: DATABASE_URL=mysql+pymysql://root@localhost/recruitcrm_normlized?unix_socket=/tmp/mysql.sock
#       GROQ_API_KEY=...
#       GROQ_INSECURE_SSL=1   # if your network MITMs TLS
uvicorn app.main:app --reload --port 8000

# Frontend (port 3000)
cd frontend
npm install
npm run dev
```

Key environment toggles:

| Var | Effect |
|-----|--------|
| `DATABASE_URL` | SQLAlchemy URL; supports `unix_socket=` query param for local MySQL. |
| `GROQ_API_KEY` | LLM access. Without it, the chat falls back to error responses. |
| `GROQ_INSECURE_SSL=1` | Bypass TLS verification when corporate proxies break the Groq cert chain. |
