# RecruitCRM AI Analytics — Backend

FastAPI service that turns recruiter questions into safe, parameterised SQL
against a multi-tenant MySQL database. The model never writes SQL — it
produces a validated DSL, and a deterministic sqlglot-based compiler builds
the query.

This document reflects the **current implementation** after the three-phase
modernisation (sqlglot AST compiler · Groq tool calling · RAG retriever) and
the `numerator_sql` refactor.

---

## Pipeline

```
question ─► LLMEngine ─► AnalyticsDSL ─► DeterministicCompiler ─► CompiledQuery ─► QueryExecutor ─► rows
                                                                                              │
                                                                                              ▼
                                                                                       ResponseBuilder
```

| Stage | Module | What it does |
|-------|--------|--------------|
| 1. Retrieve | [app/retrieval.py](app/retrieval.py) | rapidfuzz over metric ids, display names, business meanings → top-K candidates |
| 2. Plan | [app/llm_engine.py](app/llm_engine.py) | Groq `llama-3.3-70b-versatile` tool call; per-request `metrics` enum scoped to top-K |
| 3. Compile | [app/deterministic_compiler.py](app/deterministic_compiler.py) | DSL → sqlglot AST → MySQL SQL with parameterised placeholders |
| 4. Execute | [app/executor.py](app/executor.py) | SQLAlchemy session → MySQL, returns `QueryResult.rows` |
| 5. Respond | [app/response_builder.py](app/response_builder.py) | Insight string + follow-up suggestions + chart metadata |

The full orchestration lives in [`QueryEngine.process`](app/query_engine.py).

---

## The metric YAML pattern

Each metric is one entry in a YAML file under `knowledge/metrics/`. The
catalogue separates **documentation** from **executable form**:

```yaml
# knowledge/metrics/recruiter_metrics.yaml
recruiter_placement_rate:
  business_meaning: "Frequency of successful hires attributed to a recruiter."
  numerator:     "COUNT(DISTINCT candidateid) WHERE reached_stage = 'Placed'"   # docs
  numerator_sql: "COUNT(DISTINCT CASE WHEN log.candidatestatusid = 9 THEN log.candidateid END)"   # executed
  required_partitions: ["accountid"]
```

| Field | Role |
|-------|------|
| `business_meaning` | Surfaced in the sidebar (`description`) |
| `source_table` | Base FROM table; alias is always `log`. Defaults to `tblassignjobcandidatelog`. |
| `temporal_column` | Used by the `month` dimension (`FROM_UNIXTIME(log.<col>, '%Y-%m')`) |
| `numerator` | Abstract human-readable formula. Documentation only — never executed. |
| `numerator_sql` | **The actual SQL aggregate.** Parsed by sqlglot, must reference `log.<col>` or already-joined dimension aliases. |
| `recommended_visualizations` | First entry becomes `default_chart_type` in the API |

### Why two numerator fields?

The abstract `numerator` (with virtual stages like `reached_stage = 'Placed'`
and pseudo-columns like `is_active`) is the canonical business definition.
The executable `numerator_sql` is the concrete grounding for the current
schema. Keeping both gives:

- **Auditability** — reviewers see the business intent and the SQL that
  realises it side-by-side.
- **Portability** — a future metadata layer can re-ground the abstract form
  for a different physical schema without touching compiler code.
- **No grounding shims** in the compiler. It used to do `.replace("is_active = true", "1=1")`
  chains; that pattern is gone. If a metric isn't grounded, it just doesn't
  have `numerator_sql` — and the retriever automatically hides it from the
  LLM and the sidebar.

### Executable metrics in this build

Only metrics with a non-empty `numerator_sql` are surfaced. Today that is:

| Category | Metric | Base table |
|----------|--------|------------|
| Job | `job_volume`, `job_creation_trend` | `tbljob` |
| Recruiter | `recruiter_submission_rate`, `recruiter_placement_rate`, `recruiter_pipeline_load` | `tblassignjobcandidatelog` |
| Funnel | `stage_conversion_rate`, `funnel_dropoff_rate`, `pipeline_completion_rate` | `tblassignjobcandidatelog` |

Source-based metrics are intentionally excluded — the underlying schema has
no source column. Re-introducing them is a YAML change: add `numerator_sql`
and they re-enter the catalogue automatically.

---

## Compiler internals

[app/deterministic_compiler.py](app/deterministic_compiler.py) is the only
component that writes SQL.

### Dimensions

Three are supported, declaratively:

```python
DIMENSION_JOINS = {
    "label": DimensionJoin(table="tblcandidatestatus", alias="s",
                           base_col="candidatestatusid", join_col="id",
                           select_col="label"),
    "firstname": DimensionJoin(table="tbluser", alias="u",
                               base_col="createdby", join_col="id",
                               select_col="firstname"),
}
# "month" is special-cased to FROM_UNIXTIME(log.<temporal_col>, '%Y-%m')
```

`_dimension_join()` is **schema-aware**: it consults
`knowledge/schema_reality/tables/<base_table>.yaml` and only applies a join
when the chosen `source_table` actually has the required `base_col`. So the
same `firstname` dimension works for both `tblassignjobcandidatelog.createdby`
and `tbljob.createdby`, with no per-metric branching in code.

### Join safety

Every join is checked against an undirected edge set built from
`knowledge/join_graph/safe_join_paths.yaml`. Joins outside the whitelist
raise at compile time, before SQL is emitted.

### Tenant propagation

Two invariants enforced by the compiler:

1. Every query has `log.accountid = :account_id` in `WHERE`.
2. Every JOIN includes `joined.accountid = log.accountid`.

These are AST-checked in `_validate_ast()` after rendering — not just trusted
to have been added.

### Measure compilation

```python
def _compile_measure(self, metric_def):
    sql_fragment = metric_def.get("numerator_sql")
    if not sql_fragment:
        raise ValueError("Metric is missing `numerator_sql`")
    return parse_one(sql_fragment, dialect=DIALECT)
```

That's the whole thing. No `.replace()` chains, no regex, no special cases.
Syntax errors fail at compile time, not at MySQL.

---

## LLM Planner

[app/llm_engine.py](app/llm_engine.py) calls Groq with **structured tool
calling**, not JSON-mode prompting:

- The tool schema declares `intent_family`, `metrics`, `dimensions`, `chart_type`,
  `filters` — each as a strict enum.
- The `metrics` enum is **scoped per request** to the top-`RAG_TOP_K` (default
  5) candidates returned by `MetricRetriever`. This shrinks the decision space
  from the whole catalogue to "the few most relevant ones" and frees prompt
  budget for their descriptions.
- The tool call response is parsed into an `AnalyticsDSL` (Pydantic) which the
  compiler consumes verbatim. The model has no path to emit SQL.

If `GROQ_AI_ANALYTICS_API_KEY` is missing, the engine is disabled and
`/query` returns a structured "AI Planner offline" error.

---

## HTTP API

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/`  | — | `{status, llm_available, metrics_count}` |
| POST | `/query` | `{message, account_id, session_id?}` | `{insight, chart, suggestions}` or `{error}` |
| GET | `/metrics` | — | `{metrics: MetricSummary[]}` for the sidebar |

`MetricSummary` shape (matches the frontend `MetricSummary` type):

```ts
{ name, display_name, description, category, dimensions, filters,
  default_chart_type, aliases }
```

Only metrics with `numerator_sql` are returned — the UI can't offer something
the compiler can't answer.

---

## Local development

### 1. Install

```bash
cd backend
pip install -r requirements.txt
```

### 2. Environment

Create `backend/.env`:

```bash
GROQ_AI_ANALYTICS_API_KEY=gsk_...                       # console.groq.com
# Unix socket DSN (matches Homebrew MySQL on Apple Silicon with skip_networking=ON)
DATABASE_URL=mysql+pymysql://root:devpass@/ai_analytics?unix_socket=/tmp/mysql.sock
```

For TCP-mode MySQL use the standard `mysql+pymysql://user:pass@host:3306/db`
DSN instead.

### 3. Bootstrap the dev database

```bash
mysql -uroot -pdevpass < sql/bootstrap_dev_db.sql
```

This drops and recreates four tables (`tbluser`, `tblcandidatestatus`,
`tbljob`, `tblassignjobcandidatelog`) shaped to match
`knowledge/schema_reality/tables/*.yaml`, then seeds a deterministic dataset
for `accountid=1`: 4 recruiters (Alice/Bob/Chitra/Devesh), 9 candidate
statuses (id=9 ⇒ Placed), 6 jobs (501–506) spread across ~120 days, and ~22
stage-transition events.

### 4. Run

```bash
uvicorn app.main:app --reload --port 8000
```

### 5. Smoke-test the compiler end-to-end

```bash
python scripts/smoke_compiler.py
```

Compiles **and executes** every catalogued metric against the dev DB. The
expected output is `8 passed, 0 failed`.

---

## Repository layout

```
backend/
├── app/
│   ├── main.py                    # FastAPI app (/, /query, /metrics)
│   ├── query_engine.py            # Top-level orchestrator + /metrics shaping
│   ├── llm_engine.py              # Groq tool calling + scoped RAG enum
│   ├── retrieval.py               # MetricRetriever (rapidfuzz over YAML catalogue)
│   ├── deterministic_compiler.py  # DSL → sqlglot AST → MySQL SQL
│   ├── executor.py                # SQLAlchemy execution
│   ├── response_builder.py        # Insight + suggestion shaping
│   ├── dsl.py                     # AnalyticsDSL / FilterClause / VisualizationPlan
│   ├── schemas.py                 # FastAPI request/response models
│   ├── tenant_context.py          # Per-account enum hydration
│   └── db.py                      # SQLAlchemy engine + SessionLocal
├── knowledge/
│   ├── metrics/                   # Metric YAMLs (incl. numerator_sql)
│   ├── schema_reality/tables/     # Column-level table descriptions
│   ├── join_graph/                # safe_join_paths.yaml (whitelist)
│   ├── transitions/               # Temporal event mappings
│   └── golden_queries/            # Benchmark inputs
├── compiler/                      # Compiler-pipeline YAML configs (reference)
├── planner/                       # Planner DSL schema YAML (reference)
├── audit/                         # Audit runner + reports
├── evaluation/                    # Golden-query benchmark
├── scripts/
│   └── smoke_compiler.py          # End-to-end compile+execute test
└── sql/
    └── bootstrap_dev_db.sql       # Dev MySQL schema + seed
```

---

## Security guarantees

- **Tenant isolation** — `accountid` is injected into `WHERE` and every JOIN
  by the compiler. AST-verified post-render.
- **Parameterised SQL** — every user value is bound via SQLAlchemy
  placeholders. No string interpolation in the SQL path.
- **Join whitelist** — only edges from `safe_join_paths.yaml` are allowed.
- **No LLM SQL** — the model emits a tool call; SQL is produced from a
  validated DSL.
- **Closed enums** — intent family, metrics, dimensions, chart type, and
  filter operators are all enum-constrained at the tool-schema level.
- **Executable-only catalogue** — metrics without `numerator_sql` are hidden
  from both the LLM (RAG retriever) and the UI (`/metrics`).

---

## Adding a metric

1. Add the entry to the appropriate file in `knowledge/metrics/`:

   ```yaml
   my_metric:
     business_meaning: "What this measures, in one sentence."
     source_table: "tblassignjobcandidatelog"   # or "tbljob", etc.
     numerator: "<abstract definition for humans>"
     numerator_sql: "<concrete SQL aggregate against log.* / dim aliases>"
     required_partitions: ["accountid"]
     recommended_visualizations: ["bar", "line"]
   ```

2. If `source_table` is new, drop a column manifest in
   `knowledge/schema_reality/tables/<table>.yaml`.
3. If a new join is needed, extend `knowledge/join_graph/safe_join_paths.yaml`.
4. Restart uvicorn (YAMLs are loaded once per process).

No compiler changes. No registry edits. The retriever, the `/metrics`
sidebar feed, and the LLM tool schema all pick it up automatically.

---

## Known limitations

- **Funnel semantics are approximate.** `stage_conversion_rate` /
  `funnel_dropoff_rate` count candidates per stage today; a true window-based
  per-candidate latest-stage subquery is not yet wired in.
- **Filters: `eq` only.** `gt/lt/in/between/like` exist in the DSL but the
  compiler currently emits equality predicates.
- **No caching.** Identical queries hit MySQL every time; the metrics
  catalogue is rebuilt on every `/metrics` call.
- **Chart types.** Only `bar`, `pie`, and `line` render in the frontend;
  `funnel` and `heatmap` are reserved in the DSL.
- **15 catalogue metrics are non-executable** (threshold-only, event-based,
  or pointing at columns the dev schema doesn't have). They are hidden until
  given a `numerator_sql`.
