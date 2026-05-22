# RecruitCRM AI Analytics - Current Architecture

This project is a conversational analytics proof of concept for Recruit CRM data.
The user asks a hiring or pipeline question in plain English, and the system
turns that question into a safe SQL query, runs it against MySQL, then returns
chart-ready data and a short written insight.

The important design decision is this: the LLM does not write SQL. It only
chooses a structured analytics plan. SQL is built later by a deterministic
compiler that knows the approved metrics, columns, joins, tenant rules, and
filters.

---

## At A Glance

```text
User
  |
  v
Next.js chat UI
  |
  | POST /query
  v
FastAPI backend
  |
  | 1. Retrieve likely metrics
  | 2. Ask Groq LLM to produce AnalyticsDSL
  | 3. Compile DSL to parameterized SQL
  | 4. Execute SQL through SQLAlchemy
  | 5. Shape result for frontend
  v
MySQL
```

The runtime path is mostly contained in these files:

| Area | Main files | Responsibility |
| --- | --- | --- |
| API entry point | `backend/app/main.py` | FastAPI app, CORS, `/`, `/query`, `/metrics` |
| Orchestration | `backend/app/query_engine.py` | Connects planner, compiler, executor, and response shaping |
| LLM planning | `backend/app/llm_engine.py` | Uses Groq tool calling to produce an `AnalyticsDSL` |
| Metric retrieval | `backend/app/retrieval.py` | Picks the top metric candidates before the LLM is called |
| SQL compilation | `backend/app/deterministic_compiler.py` | Converts DSL into safe MySQL SQL using `sqlglot` |
| SQL execution | `backend/app/executor.py` | Runs parameterized SQL through SQLAlchemy |
| Database setup | `backend/app/db.py` | Reads `DATABASE_URL` and creates the SQLAlchemy session factory |
| Frontend app | `frontend/src/app/page.tsx` | Chat screen, metric sidebar, account selector, request handling |
| API client | `frontend/src/lib/api.ts` | Axios client and browser session id helper |
| Charts | `frontend/src/components/ChartRenderer.tsx` | Bar, line, pie/donut, and table rendering |

---

## What The User Sees

The frontend is a chat-style analytics workspace.

On the left, `MetricsSidebar` loads the available metrics from `GET /metrics`.
Only executable metrics are shown there. On the right, the user can type a
question, change the active `account_id`, and review the returned chart or
table.

Example questions the current system is meant to handle:

- `Show hiring pipeline`
- `Compare recruiter placement rate by recruiter`
- `Show job creation trend by month`
- `List open jobs older than 30 days`
- `Show candidates in interview stage`

When a user sends a message, `frontend/src/app/page.tsx` posts this body to the
backend:

```json
{
  "message": "Compare recruiter placement rate by recruiter",
  "account_id": 3828832,
  "session_id": "browser-generated-session-id"
}
```

The `session_id` is stored in `localStorage`. The current frontend does not use
authentication yet; the account id is editable in the UI and defaults to the
test account configured in `page.tsx`.

---

## Backend Request Flow

The main backend flow lives in `QueryEngine.process()`.

### 1. The API receives the question

`backend/app/main.py` exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health check with LLM availability and metric count |
| `POST` | `/query` | Main natural-language analytics endpoint |
| `GET` | `/metrics` | Metric catalog for the frontend sidebar |

The request model is intentionally small:

```python
class QueryRequest(BaseModel):
    message: str
    account_id: int
    session_id: Optional[str] = None
```

`main.py` then passes the message to `QueryEngine`.

### 2. The retriever narrows the metric list

Before the LLM is called, `MetricRetriever` scans the YAML metric catalog and
selects the top matching metrics for the user's question. This is the project's
RAG step.

RAG usually stands for Retrieval-Augmented Generation. In many projects, that
means retrieving chunks from documents or a vector database before calling the
LLM. In this project, it is simpler and more specific: we retrieve the most
relevant metric definitions from the YAML knowledge base before asking the LLM
to plan the query.

We are not using vector embeddings yet. The current implementation uses
`rapidfuzz` lexical matching over:

- the metric id, such as `recruiter_placement_rate`
- the human description in `business_meaning`
- the category, such as `recruiter` or `funnel`

This step matters because the LLM does not see every metric in the system. It
sees only the top candidates for that question, usually up to five. Those
candidate metrics are injected into the Groq tool-calling prompt, and the tool
schema only allows the LLM to select from that retrieved list.

For example, with:

```text
Compare recruiter placement rate by recruiter
```

the retriever is likely to surface metrics such as:

```text
recruiter_placement_rate
recruiter_submission_rate
recruiter_pipeline_load
```

That keeps the model grounded. It also prevents the model from inventing an
unsupported metric, because the `metrics` enum in the tool schema is built from
the retrieved candidates.

In short, RAG in this project means:

```text
User question
  -> retrieve likely metric definitions from YAML
  -> give those candidates to the LLM
  -> force the LLM to choose one of those candidates
  -> compile that metric deterministically into SQL
```

The code path is:

1. `backend/app/retrieval.py` builds and searches the metric index.
2. `backend/app/llm_engine.py` calls the retriever before calling Groq.
3. `LLMEngine._build_tool_schema()` creates a tool schema where `metrics` is an
   enum containing only the retrieved metric names.

### 3. The LLM returns a structured DSL, not SQL

`LLMEngine` uses Groq's `llama-3.3-70b-versatile` model with structured tool
calling. The tool is named `build_analytics_query`.

The model must choose from closed enums:

- intent family, such as `ranking`, `trend`, or `funnel_analysis`
- one metric from the retrieved candidates
- allowed dimensions like `label`, `firstname`, `month`, `company_name`
- allowed chart types like `bar`, `line`, `pie`, `funnel`, `heatmap`
- allowed filter fields and operators

A typical planned DSL looks like this:

```json
{
  "intent_family": "ranking",
  "metrics": ["recruiter_placement_rate"],
  "dimensions": ["firstname"],
  "filters": [],
  "temporal_scope": {
    "type": "rolling"
  },
  "visualization_plan": {
    "type": "bar"
  },
  "account_id": 3828832
}
```

The backend injects `account_id` after the LLM response is parsed. It does not
trust the model to provide tenant information.

If `GROQ_AI_ANALYTICS_API_KEY` is missing, the planner is considered offline
and `/query` returns a planning error.

### 4. The compiler turns the DSL into SQL

`DeterministicCompiler` is the most important backend component. It takes the
validated `AnalyticsDSL` and builds a `CompiledQuery`.

```python
@dataclass
class CompiledQuery:
    sql: str
    params: dict
    visualization_type: str
    intent_family: str
```

The compiler loads its knowledge from `backend/knowledge`:

| Knowledge area | Directory | Used for |
| --- | --- | --- |
| Metrics | `knowledge/metrics` | Business definitions and executable SQL fragments |
| Safe joins | `knowledge/join_graph` | Approved table relationships |
| Table schema | `knowledge/schema_reality/tables` | Column checks before joins and filters |
| Transitions | `knowledge/transitions` | Funnel and stage semantics for future deeper replay logic |

For normal aggregate metrics, the compiler:

1. Finds the selected metric definition.
2. Chooses the metric's base table, defaulting to `tblassignjobcandidatelog`.
3. Adds dimension select expressions and joins.
4. Parses the metric's `numerator_sql` with `sqlglot`.
5. Adds mandatory tenant filtering.
6. Adds user filters as named parameters.
7. Adds grouping, ordering, and a default limit.
8. Walks the final AST to validate safety rules.

Example metric definition:

```yaml
recruiter_placement_rate:
  business_meaning: "Frequency of successful hires attributed to a recruiter."
  numerator: "COUNT(DISTINCT candidateid) WHERE reached_stage = 'Placed'"
  numerator_sql: "COUNT(DISTINCT CASE WHEN log.candidatestatusid = 9 THEN log.candidateid END)"
  required_partitions: ["accountid"]
```

The `numerator` field is the human explanation. The `numerator_sql` field is
the executable version the compiler actually parses.

For a recruiter placement leaderboard, the generated SQL is shaped like this:

```sql
SELECT
  u.firstname AS label,
  COUNT(DISTINCT CASE WHEN log.candidatestatusid = 9 THEN log.candidateid END) AS value
FROM tblassignjobcandidatelog AS log
INNER JOIN tbluser AS u
  ON log.createdby = u.id
  AND u.accountid = log.accountid
WHERE log.accountid = :account_id
GROUP BY u.firstname
ORDER BY value DESC
LIMIT 100
```

And the params stay separate:

```json
{
  "account_id": 3828832
}
```

### 5. The executor runs the query

`QueryExecutor` opens a SQLAlchemy session from `SessionLocal`, executes the
compiled SQL with bound parameters, and converts rows into dictionaries.

For chart results, the compiler usually returns rows like:

```json
[
  { "label": "Alice", "value": 12.0 },
  { "label": "Bob", "value": 8.0 }
]
```

For table-style metrics, rows can contain richer columns. For example, the
candidate list flow returns candidate details, job details, stage, and days in
stage.

### 6. The response is shaped for the current frontend contract

`QueryEngine._build_legacy_response()` maps the backend result into the shape
the React components expect:

```json
{
  "status": "success",
  "title": "Ranking",
  "insight": "Found 2 results for ranking. Top performer is Alice with 12.0.",
  "chart": {
    "type": "bar",
    "data": [
      { "label": "Alice", "value": 12.0 },
      { "label": "Bob", "value": 8.0 }
    ],
    "config": {
      "xLabel": "firstname",
      "yLabel": "Value"
    }
  },
  "intent": {
    "metric": "recruiter_placement_rate",
    "metric_label": "Recruiter Placement Rate",
    "dimensions": ["firstname"],
    "filters": [],
    "chart_type": "bar"
  },
  "suggestions": [
    "Show by department",
    "Compare by recruiter",
    "Show trend over time"
  ]
}
```

The suggestions are currently static. They are useful for UI testing, but they
are not yet generated from the selected metric.

---

## The DSL Contract

The DSL is the handoff point between "AI reasoning" and deterministic code.
It is defined in `backend/app/dsl.py`.

```python
class AnalyticsDSL(BaseModel):
    intent_family: str
    metrics: List[str]
    dimensions: List[str] = []
    filters: List[FilterClause] = []
    temporal_scope: TemporalScope = TemporalScope()
    replay_requirements: List[str] = []
    visualization_plan: VisualizationPlan
    clarification_requirements: List[str] = []
    validation_requirements: List[str] = []
    execution_dependencies: List[str] = []
    account_id: Optional[int] = None
```

A filter looks like this:

```json
{
  "field": "city",
  "operator": "eq",
  "value": "Pune"
}
```

The compiler supports common operators such as:

- `eq`
- `ne`
- `gt`
- `lt`
- `gte`
- `lte`
- `like`

The LLM schema also lists `in` and `between`, but the current compiler falls
back to equality for unsupported operators. That is worth noting during review.

---

## Metrics In This Version

The metric files contain more business definitions than the app currently
executes. The runtime catalog intentionally exposes only metrics with a
non-empty `numerator_sql`.

Executable metrics in this version:

| Category | Metric | What it measures | Typical output |
| --- | --- | --- | --- |
| Recruiter | `recruiter_submission_rate` | Unique candidate-job submissions | Bar chart by recruiter |
| Recruiter | `recruiter_placement_rate` | Candidates reaching placed stage | Bar chart by recruiter |
| Recruiter | `recruiter_pipeline_load` | Active non-terminal candidates | Bar chart by recruiter |
| Funnel | `stage_conversion_rate` | Current executable approximation of candidates per stage | Stage chart |
| Funnel | `funnel_dropoff_rate` | Current executable approximation of candidates per stage | Stage chart |
| Funnel | `pipeline_completion_rate` | Candidates that reached placed stage | Bar or grouped result |
| Funnel | `candidate_status_breakdown` | Current assigned candidates by status stage | Bar/funnel-style chart |
| Funnel | `candidate_list` | Candidate details in a stage/status | Table |
| Job | `job_creation_trend` | Monthly job creation count | Line chart |
| Job | `job_volume` | Total job count | Bar/chart result |
| Job | `open_jobs_list` | Active open jobs with days open | Table |

Source, time, and some operational-health metrics are present as business
knowledge, but they are not exposed unless they receive an executable
`numerator_sql`.

---

## Frontend Architecture

The frontend is a Next.js app using React, TypeScript, Tailwind CSS, Axios, and
Recharts.

### Page-level state

`frontend/src/app/page.tsx` owns:

- `messages`: chat history shown in the main panel
- `metrics`: catalog from `/metrics`
- `isLoading`: loading state during backend calls
- `sessionId`: browser-local session id
- `accountId`: active account id used in the request body

### API client

`frontend/src/lib/api.ts` creates an Axios client:

```ts
export const api = axios.create({
  baseURL: 'http://127.0.0.1:8000'
})
```

That means local development expects the backend on port `8000`.

### Rendering responses

`ChatMessage` handles four response states:

- a user message
- a backend error
- a clarification response shape, if one appears
- a normal chart/table response

`ChartRenderer` supports:

- `bar`
- `line`
- `pie`
- `donut`
- `table`

The LLM schema allows `funnel` and `heatmap`, but the renderer does not have
custom implementations for those yet. A `funnel` response currently falls
through to the default bar chart path.

---

## Security Model

The project has several important safety boundaries.

### The LLM cannot write SQL

The LLM only emits a tool call that becomes an `AnalyticsDSL`. It cannot send
raw SQL to the database.

### Tenant isolation is injected by the compiler

Every compiled query includes a base-table tenant filter:

```sql
WHERE log.accountid = :account_id
```

For most joins, the compiler also propagates the tenant boundary:

```sql
AND u.accountid = log.accountid
```

Lookup tables such as `tblcandidatestatus` and `tbljobstatus` are explicitly
exempted in code where the relationship is treated as scoped through the
foreign key.

### Joins are whitelisted

Before adding a join, the compiler checks the relationship against
`knowledge/join_graph/safe_join_paths.yaml`.

For example, these paths are currently approved:

- assignment log to candidate status
- assignment log to user through `createdby`
- assignment log to job
- current assignment to job
- current assignment to candidate
- job to job status

If a join is not listed, compilation fails before SQL is emitted.

### Values are parameterized

User filter values become named placeholders like `:f_0`, not interpolated SQL.

Example:

```json
{
  "field": "city",
  "operator": "eq",
  "value": "Pune"
}
```

becomes:

```sql
AND j.city = :f_0
```

with:

```json
{
  "f_0": "Pune"
}
```

### The final AST is validated

The compiler walks the `sqlglot` AST and rejects dangerous query types such as
insert, update, delete, drop, create, or alter. It also verifies that the final
query contains a `WHERE` clause and tenant filtering on the base table.

---

## Special Table Flows

Most metrics use the generic aggregate compiler path. Two metrics have custom
table-list flows because they return detailed rows instead of simple
`label/value` chart data.

### `candidate_list`

Base table: `tblassignjobcandidate`

The compiler joins:

- `tblcandidate` for name, email, and phone
- `tbljob` for job id and job name
- `tblcandidatestatus` for stage label

It also calculates:

```sql
ROUND((UNIX_TIMESTAMP() - ajc.stagedate) / 86400) AS days_in_stage
```

This is rendered as a table in the frontend.

### `open_jobs_list`

Base table: `tbljob`

The compiler joins `tbljobstatus` and returns:

- job id
- job name
- city
- country
- number of openings
- job status
- days open

It excludes deleted and archived jobs by default.

---

## Example End-to-End Walkthrough

Question:

```text
Show job creation trend by month
```

What happens:

1. The frontend posts the message, account id, and session id to `/query`.
2. The retriever matches the question to `job_creation_trend`.
3. The LLM returns a DSL with:

```json
{
  "intent_family": "trend",
  "metrics": ["job_creation_trend"],
  "dimensions": ["month"],
  "visualization_plan": {
    "type": "line"
  }
}
```

4. The compiler finds `job_creation_trend` in `job_metrics.yaml`.
5. It sees `source_table: "tbljob"` and `temporal_column: "createdon"`.
6. It builds a month label with:

```sql
FROM_UNIXTIME(j.createdon, '%Y-%m')
```

7. It counts jobs with:

```sql
COUNT(DISTINCT j.id)
```

8. It injects:

```sql
WHERE j.accountid = :account_id
```

9. The frontend renders the returned rows as a line chart.

---

## Running Locally

Backend:

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Required environment variables:

```bash
DATABASE_URL=mysql+pymysql://user:password@host:3306/database
GROQ_AI_ANALYTICS_API_KEY=your_groq_key
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The frontend expects the API at:

```text
http://127.0.0.1:8000
```

---

## Useful Checks

Database connectivity:

```bash
cd backend
python check_db_connection.py
```

Compiler and execution smoke test:

```bash
cd backend
python scripts/smoke_compiler.py
```

Filter resolution smoke test:

```bash
cd backend
python test_filters.py
```

Frontend lint:

```bash
cd frontend
npm run lint
```

Some of these checks require a valid database and environment variables.

---

## Adding A New Metric

Most new chart metrics should not require compiler code changes.

Add a metric under `backend/knowledge/metrics`:

```yaml
my_new_metric:
  business_meaning: "One clear sentence explaining the business question."
  source_table: "tblassignjobcandidatelog"
  numerator: "Human-readable business formula."
  numerator_sql: "COUNT(DISTINCT log.candidateid)"
  required_partitions: ["accountid"]
  recommended_visualizations: ["bar"]
```

Then check:

1. The `source_table` exists in `knowledge/schema_reality/tables`.
2. Any required join exists in `knowledge/join_graph/safe_join_paths.yaml`.
3. The SQL fragment parses with `sqlglot`.
4. The metric appears in `GET /metrics`.
5. The smoke compiler script can compile and execute it.

If `numerator_sql` is missing, the metric remains documentation-only. The
retriever and frontend sidebar will hide it.

---

## Current Limitations

These are not failures; they are the honest edges of the current version.

- Authentication is not wired in. The frontend sends an editable account id.
- The API base URL is hardcoded to `http://127.0.0.1:8000`.
- The response suggestions are static.
- `funnel` and `heatmap` are allowed by the planner schema but do not have
  dedicated frontend renderers yet.
- Some funnel metrics are executable approximations. True conversion/dropoff
  rates need per-candidate latest-stage or max-stage reconstruction.
- `in` and `between` are allowed in the LLM tool schema, but the compiler does
  not emit real `IN` or `BETWEEN` clauses yet.
- `company_name` is allowed by the planner as a dimension, but the compiler
  only has explicit dimension handling for `label`, `firstname`, and `month`.
- The metrics sidebar has a search input visually, but filtering behavior is
  not implemented.
- Evaluation files exist, but `evaluation/test_benchmark.py` currently uses a
  mock planner function instead of the live pipeline.
- `QueryEngine` stores `_sessions`, but session history is not used in planning.

---

## Reviewer Notes

The cleanest way to understand the project is to follow one request:

1. `frontend/src/app/page.tsx` sends the message.
2. `backend/app/main.py` receives `/query`.
3. `backend/app/query_engine.py` runs the pipeline.
4. `backend/app/llm_engine.py` creates the DSL.
5. `backend/app/deterministic_compiler.py` creates SQL.
6. `backend/app/executor.py` runs SQL.
7. `frontend/src/components/ChartRenderer.tsx` renders the result.

The architecture is strongest where it separates judgment from execution:

- the LLM decides what the user probably wants,
- the DSL records that decision in a small structured format,
- the compiler enforces what the system is allowed to run,
- the executor only receives parameterized SQL.

That separation is the main reason the project is reviewable and extendable.
