# User Guide

A complete walkthrough of every feature in the AI Analytics POC. The app
has six top-level pages, all account-scoped by the `account_id` shown
in the top-right of the navigation bar.

> **Quick orientation**
>
> | Page | What it's for |
> |------|---------------|
> | **Chat** (`/`) | Ask analytics questions in plain English |
> | **Builder** (`/builder`) | Compose a metric-based query without typing |
> | **Query Builder** (`/query`) | Pick raw tables, columns, joins, and conditions |
> | **ER Diagram** (`/er-diagram`) | Visual map of allowed tables + joins + columns |
> | **Saved Charts** (`/charts`) | Library of every chart you've saved |
> | **Dashboards** (`/dashboard`) | Group saved charts into named dashboards |

---

## 1. Switching accounts

The header has an `account_id` input. Type a different ID and the whole
app re-scopes to that tenant. The active account is remembered in your
browser, so refreshes keep the same context.

The header also includes a **Dark/Light mode** toggle. Theme preference is
saved in your browser.

- **Default account**: `5` (has the most data in the seeded DB).
- **Recent prompts**, **saved charts**, and **dashboards** are all
  scoped per-account; switching accounts swaps these lists.

---

## 2. Chat (`/`)

The conversational analytics surface. Type a question, get a chart back.

### 2.1 Asking a question

Type any analytics question into the input bar. Examples:

- *"show job volume by status"*
- *"top 10 recruiters by submissions this quarter"*
- *"funnel from submission to placement"*
- *"how is hiring trending month over month"*

The planner (powered by an LLM) chooses the right metric, dimensions and
visualization, runs the query, and returns a chart plus a short
explanation.

### 2.2 Three response types

The chatbot can respond in three ways:

1. **Answered** — chart + explanation rendered inline.
2. **Clarification: ambiguous** — your question was too vague (*"show me
   data"*, *"how are we doing?"*). The bot returns a short message plus
   2–4 clickable suggestions to pick from.
3. **Clarification: out of scope** — your question isn't about
   recruiting analytics (*"what's the weather?"*, *"tell me a joke"*).
   The bot politely declines and suggests in-scope alternatives.

Click any suggestion to send it as your next message.

### 2.3 Metrics Catalogue sidebar

The left sidebar lists every metric the system knows, grouped by
category (Funnel, Recruiter Productivity, Time Efficiency, etc.).

- **Click a metric** to instantly ask a question about it (uses its
  primary alias as the prompt).
- **Search** the list using the search box at the top.

### 2.4 Recent prompts

Above the metrics list, the sidebar shows your **most recent successful
prompts** (up to 15, newest first):

- **Click** a prompt to re-run it.
- **Hover** to reveal a remove button — click to remove that single
  prompt from the list.
- **Clear** at the top wipes the entire recent list.
- Only prompts that actually produced an answer are remembered;
  ambiguous/out-of-scope/failed prompts are skipped.
- The list is persisted in your browser per account.

### 2.5 Per-message actions

Each chart message has actions below it:

- **CSV** — download the underlying rows as a CSV file.
- **PNG** — download the chart as a high-res PNG image. (Tables don't
  have a PNG export; CSV still works.)
- **+ Save chart** — opens a dialog to give the chart a title, optional
  description, and save it to your **Saved Charts** library.
- **Inspector** — expand the lineage panel under the chart to see:
  - The full DSL the planner produced
  - The SQL that was executed
  - The metric, dimensions, filters, and row count
  - Which knowledge files the planner relied on

### 2.6 Continuous assistant communication

While a query runs, chat now shows a staged progress panel (question
understanding, metric mapping, SQL validation, and response generation)
instead of a generic spinner.

After each response, a **Continue with** chip row suggests likely next
questions to keep exploration moving.

---

## 3. Builder (`/builder`)

A guided, point-and-click query composer driven by the **metrics
catalog**. Useful when you know roughly what you want but don't want to
phrase it in English.

### 3.1 Build a query

1. **Pick a metric** from the dropdown — e.g. "Submission count",
   "Time to first interview".
2. **Pick dimensions** (groupings) — e.g. by recruiter, by month, by
   pipeline stage. Suggested dimensions are derived from the metric;
   you can also type a custom dimension.
3. **Add filters** — pick a field, an operator (`is`, `is not`,
   `greater than`, `contains`, `matches text`, …) and a value.
4. **Pick a visualization** — Bar, Line, Funnel, Pie, Donut, Stacked
   Bar, or Table. Each option shows what it's best for.
5. **Pick the intent family** — Ranking, Trend, Funnel analysis,
   Recruiter productivity, Time efficiency, or Bottleneck detection.
   This shapes how the engine interprets the request.
6. **Run** — the chart renders inline.

### 3.2 Save and download

The same **+ Save chart**, **CSV**, and **PNG** actions from the chat
are available next to the rendered result.

---

## 4. Query Builder (`/query`)

A raw SQL builder for ad-hoc exploration. Pick tables, columns, joins,
conditions, group/order/limit — and run. Useful when no metric in the
catalog matches what you need.

### 4.1 Sections

- **From** — pick a primary table from the allowlist
  (`tbljob`, `tblcandidate`, `tbluser`, `tblassignjobcandidate`,
  `tblcandidatestatus`, `tbljobstatus`, `tbldeals`,
  `tbldealpipelinestages`).
- **+ Add JOIN** — add an `INNER`, `LEFT`, or `RIGHT JOIN` on another
  allowlisted table. Pick the join columns explicitly:
  `left_table.col = right_table.col`.
- **Select** — pick one or more columns. For each column you can:
  - Apply an aggregate (`count`, `count_distinct`, `sum`, `avg`,
    `min`, `max`).
  - Give it an alias.
- **Where** — add filters with typed operators:
  `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `not_like`,
  `in`, `not_in`, `is_null`, `is_not_null`.
  - `in`/`not_in` accept a comma-separated list (`a, b, c`).
  - `is_null`/`is_not_null` hide the value box.
- **Group by** — optional explicit grouping. When you have aggregates
  but no `GROUP BY`, the builder auto-groups by every non-aggregated
  column you selected.
- **Order by** — pick columns and `ASC`/`DESC` direction.
- **Limit** — defaults to 100, hard-capped at 1000.

### 4.2 Tenant scoping (automatic)

If the primary table has an `accountid` (or `account_id`) column, the
backend automatically adds `WHERE primary.accountid = <your account>`
to every query. You cannot accidentally see another tenant's rows.

### 4.3 Results

After you click **Run query** you get a panel with:

- A **Table / Chart** toggle.
- **Table** view — paginated row grid of the result.
- **Chart** view — pick a chart type (Bar, Line, Pie, Donut), a
  **Category (X)** column, and a **Value (Y)** column. Numeric columns
  are auto-detected and pre-selected.
- A collapsible **Show generated SQL** section so you can copy the
  exact statement the backend ran.
- A `truncated` indicator if the row count hit your `LIMIT`.

---

## 5. ER Diagram (`/er-diagram`)

The schema exploration page for informed querying.

### 5.1 What you can do

- View an ER diagram of **allowed tables only**.
- See relationship edges based on the allowlisted join graph.
- Use **Table Catalog + search** to quickly find tables.
- Click a table to open the **Column Panel**.
- Inspect relationship details and **copy JOIN snippets**.

### 5.2 Table Catalog

The catalog shows each table with:

- column count
- quick badges (`tenant`, `time`, `status`)
- join counts

Clicking any table card (or chip) updates the Column Panel immediately.

### 5.3 Column Panel

For the selected table, the panel shows:

- column name
- data type
- nullable yes/no
- connected tables summary

### 5.4 Relationship actions

In the Relationship Reference table, each edge includes:

- **Details** popover: cardinality, relationship type, confidence, source
- **Copy JOIN**: copies a SQL snippet like:
  `JOIN tblcandidate ON tblassignjobcandidate.candidateid = tblcandidate.id`

---

## 6. Saved Charts (`/charts`)

Your library of every chart you've saved from the chat or any builder.

### 5.1 What you see

Each saved chart is a tile that **re-runs its stored plan** against the
live database when you open the page, so the numbers are always current.

Inside each tile:

- The chart's title and description
- The freshly-rendered chart
- **CSV / PNG** download buttons
- The same **Inspector** panel as in the chat (DSL, SQL, lineage)

### 6.2 Renaming

- **Click the rename icon** next to the title, or **double-click the
  title**, to edit it inline.
- Press **Enter** to save, **Esc** to cancel.

### 6.3 Deleting

Click the delete icon in the top-right of any tile. You'll be asked to
confirm. Deleting a chart also removes it from any dashboards that
included it.

---

## 7. Dashboards (`/dashboard`)

Group your saved charts into named dashboards.

### 6.1 Sidebar

The left sidebar lists every dashboard you've created for the current
account, plus a built-in **All charts** entry that shows every saved
chart at once.

The main panel also includes a KPI strip (visible charts, coverage,
dashboard count, latest chart update).

### 6.2 Create a dashboard

1. Click **+ New** at the top of the sidebar.
2. Type a name and press **Enter** (or click **Create**).
3. The new dashboard opens, empty.

### 6.3 Add and remove charts

- Click **+ Add charts** in the dashboard's header. A picker opens
  showing every saved chart not already in the dashboard.
- Click any tile in the picker to add it.
- Click **Done** to close the picker.
- To remove a chart from the dashboard, **hover** the tile and click
  the small **Remove** label. (This only removes it from this
  dashboard; the chart itself stays in your library.)

### 6.4 Rename a dashboard

- Click **Rename** in the dashboard's header, or **double-click the
  dashboard's title**.
- Type the new name and click **Save** (or press **Enter**).

### 6.5 Delete a dashboard

Click **Delete dashboard**. You'll be asked to confirm. Charts inside
the dashboard are **not** deleted — only the dashboard itself.

### 6.6 In-tile actions

The dashboard renders each chart with the same **rename**, **CSV**,
**PNG**, **Inspector**, and **delete** affordances as the Saved Charts
page.

---

## 8. Tips and conventions

### 7.1 What counts as a "good" prompt for the chat

The planner does best with prompts that:

- Mention a clear metric or measurement (volume, count, time to,
  conversion, rate, share).
- Specify a grouping when you want a breakdown (`by stage`, `by month`,
  `by recruiter`).
- Optionally include a filter (`in 2025`, `for full-time jobs`).

If you're vague, you'll get a clarification with suggestions — pick one
and keep going.

### 7.2 Where to start for common tasks

| Task | Best surface |
|------|--------------|
| Quick exploration / "what does this look like?" | **Chat** |
| Reproduce the same chart with different filters | **Builder** |
| Ad-hoc raw-row inspection or a join across tables | **Query Builder** |
| A recurring view you want at hand | **Save** it, then add to a **Dashboard** |
| Sharing a snapshot | Use the **PNG** or **CSV** download on any chart |

### 7.3 Inspector — when to use it

Open the Inspector under any chart to:

- Verify the **metric** the planner chose matches your intent.
- See the exact **SQL** that was run (great for debugging or audit).
- Check the **filters** that were applied automatically.
- Understand which **knowledge files** shaped the plan (lineage).

### 7.4 Account safety

- The backend always enforces tenant scoping on every endpoint;
  cross-tenant access returns a `404` (not a `403`) to avoid leaking
  the existence of other accounts' data.
- Saved charts, dashboards, and recent prompts are partitioned by
  `account_id` — switching accounts gives you a clean view.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Chat keeps asking for clarification | Rephrase with a specific metric or grouping; try clicking one of the suggested chips. |
| Chart shows "No data" | Your filter combination has no matching rows — try removing a filter or expanding the time window. |
| Query Builder chart axis values are all 0 | Your `Value (Y)` column isn't numeric. Add an aggregate (e.g. `count`) to your SELECT for a numeric series. |
| Saved chart says "Failed to run chart" | The stored plan referenced a metric/column that's no longer available. Re-run the original prompt in the chat and re-save. |
| Tile/sidebar shows stale title after rename | Refresh the page; both pages update in place on success, so this is rare. |
| All charts empty after switching accounts | The new account has no data. Try account `5` (default). |
