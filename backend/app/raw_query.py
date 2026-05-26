"""Safe ad-hoc query builder backend.

Exposes a strictly-validated SQL execution path for the frontend "Query
Builder" page. The user picks from a fixed allowlist of tables, columns
discovered live from `INFORMATION_SCHEMA`, a small set of operators, and
optional joins. Every identifier is validated against the discovered
schema before being inlined into SQL; every value is sent as a bound
parameter. Tenant scoping is auto-injected when the primary table has an
`account_id` column.

This intentionally bypasses the metric/DSL layer because the goal of
this page is exploration of raw rows, not metric computation.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import text
import yaml

from app.db import engine

log = logging.getLogger(__name__)

# Hardcoded allowlist of explorable tables. Matches the set we already
# document under knowledge/schema_reality/column_roles/.
ALLOWED_TABLES: List[str] = [
    "tblassignjobcandidate",
    "tblcandidate",
    "tblcandidatestatus",
    "tbldealpipelinestages",
    "tbldeals",
    "tbljob",
    "tbljobstatus",
    "tbluser",
]

ALLOWED_OPERATORS: Dict[str, str] = {
    "eq": "=",
    "neq": "!=",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
    "like": "LIKE",
    "not_like": "NOT LIKE",
    "in": "IN",
    "not_in": "NOT IN",
    "is_null": "IS NULL",
    "is_not_null": "IS NOT NULL",
}

# Operators that don't accept a value
UNARY_OPERATORS = {"is_null", "is_not_null"}
# Operators that accept a list of values
LIST_OPERATORS = {"in", "not_in"}

ALLOWED_AGGREGATES = {"count", "count_distinct", "sum", "avg", "min", "max"}

# Hard caps so a curious user can't OOM the DB
MAX_LIMIT = 1000
DEFAULT_LIMIT = 100

# Cache the introspected schema once at first use.
_SCHEMA_CACHE: Optional[Dict[str, List[Dict[str, Any]]]] = None
_RELATIONSHIP_CACHE: Optional[List[Dict[str, Any]]] = None


def _introspect_schema() -> Dict[str, List[Dict[str, Any]]]:
    """Return {table: [{name, type, nullable}, ...]} for every allowed table.

    Uses INFORMATION_SCHEMA so we don't have to maintain a hand-written
    column list.
    """
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is not None:
        return _SCHEMA_CACHE

    placeholders = ", ".join([f":t{i}" for i in range(len(ALLOWED_TABLES))])
    params = {f"t{i}": t for i, t in enumerate(ALLOWED_TABLES)}
    sql = text(
        f"""
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ({placeholders})
        ORDER BY TABLE_NAME, ORDINAL_POSITION
        """
    )

    result: Dict[str, List[Dict[str, Any]]] = {t: [] for t in ALLOWED_TABLES}
    with engine.connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    for tn, cn, dt, nullable in rows:
        result.setdefault(tn, []).append(
            {"name": cn, "type": dt, "nullable": nullable == "YES"}
        )

    # Drop tables that didn't actually exist in the DB (e.g. dev envs).
    result = {k: v for k, v in result.items() if v}
    _SCHEMA_CACHE = result
    log.info(
        "[RAW] Schema introspected | tables=%s",
        {t: len(cols) for t, cols in result.items()},
    )
    return result


def get_schema() -> Dict[str, Any]:
    """Public read API for the frontend."""
    schema = _introspect_schema()
    return {
        "tables": [
            {"name": t, "columns": cols} for t, cols in schema.items()
        ],
        "operators": [
            {"id": k, "sql": v, "unary": k in UNARY_OPERATORS, "list": k in LIST_OPERATORS}
            for k, v in ALLOWED_OPERATORS.items()
        ],
        "aggregates": sorted(ALLOWED_AGGREGATES),
        "max_limit": MAX_LIMIT,
    }


def _load_relationships() -> List[Dict[str, Any]]:
    """Load join relationships from knowledge/join_graph and filter to allowed tables."""
    global _RELATIONSHIP_CACHE
    if _RELATIONSHIP_CACHE is not None:
        return _RELATIONSHIP_CACHE

    allowed = set((_introspect_schema() or {}).keys())
    relationships_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "knowledge",
        "join_graph",
        "join_relationships.yaml",
    )

    with open(relationships_path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}

    out: List[Dict[str, Any]] = []
    seen = set()
    for rel in raw.get("direct_joins", []):
        left_table = rel.get("left_table")
        right_table = rel.get("right_table")
        join_columns = rel.get("join_columns") or {}
        left_col = join_columns.get("left")
        right_col = join_columns.get("right")
        if not left_table or not right_table or not left_col or not right_col:
            continue
        if left_table not in allowed or right_table not in allowed:
            continue

        key = (left_table, right_table, left_col, right_col)
        if key in seen:
            continue
        seen.add(key)

        out.append(
            {
                "left_table": left_table,
                "right_table": right_table,
                "left_column": left_col,
                "right_column": right_col,
                "relationship_type": rel.get("relationship_type"),
                "cardinality": rel.get("cardinality"),
                "confidence_level": rel.get("confidence_level"),
                "source_of_truth": rel.get("source_of_truth"),
            }
        )

    _RELATIONSHIP_CACHE = out
    return out


def get_relationships() -> Dict[str, Any]:
    """Public read API for frontend ER diagram."""
    schema = _introspect_schema()
    return {
        "tables": sorted(schema.keys()),
        "relationships": _load_relationships(),
    }


# --- Validation helpers --------------------------------------------------- #

def _require_table(name: str) -> None:
    if name not in ALLOWED_TABLES:
        raise ValueError(f"Table '{name}' is not allowed")


def _column_exists(table: str, column: str) -> bool:
    schema = _introspect_schema()
    cols = schema.get(table) or []
    return any(c["name"] == column for c in cols)


def _require_column(table: str, column: str) -> None:
    _require_table(table)
    if not _column_exists(table, column):
        raise ValueError(f"Column '{column}' does not exist on table '{table}'")


def _qualify(table: str, column: str) -> str:
    """Return a safely-quoted backticked qualified identifier."""
    _require_column(table, column)
    return f"`{table}`.`{column}`"


# --- Query compilation ---------------------------------------------------- #

def build_and_run(payload: Dict[str, Any], account_id: int) -> Dict[str, Any]:
    """Compile and execute a builder payload.

    Payload shape (all fields validated below):
      {
        "primary_table": "tbljob",
        "joins": [{"table": "tbljobstatus", "left": {"table": "tbljob", "column": "status"},
                   "right": {"table": "tbljobstatus", "column": "id"}, "type": "INNER"}],
        "columns": [{"table": "tbljob", "column": "id"},
                    {"table": "tbljob", "column": "name", "aggregate": null, "alias": null}],
        "filters": [{"table": "tbljob", "column": "city", "op": "eq", "value": "Boston"}],
        "group_by": [{"table": "tbljob", "column": "status"}],
        "order_by": [{"table": "tbljob", "column": "created_on", "direction": "DESC"}],
        "limit": 100
      }
    """
    primary = payload.get("primary_table")
    if not primary:
        raise ValueError("primary_table is required")
    _require_table(primary)

    joins = payload.get("joins") or []
    raw_columns = payload.get("columns") or []
    raw_filters = payload.get("filters") or []
    raw_group_by = payload.get("group_by") or []
    raw_order_by = payload.get("order_by") or []
    limit = payload.get("limit") or DEFAULT_LIMIT

    # Resolve set of tables in play (primary + joins) so we can validate
    # that every column reference is for a participating table.
    tables_in_query = {primary}
    for j in joins:
        jt = j.get("table")
        _require_table(jt)
        tables_in_query.add(jt)

    def _check_in_play(t: str) -> None:
        if t not in tables_in_query:
            raise ValueError(
                f"Column references table '{t}' which is not in the query. "
                f"Add a join for it first."
            )

    # --- SELECT clause -------------------------------------------------- #
    if not raw_columns:
        raise ValueError("At least one column must be selected")

    select_parts: List[str] = []
    has_aggregate = False
    for i, c in enumerate(raw_columns):
        t = c.get("table")
        col = c.get("column")
        agg = (c.get("aggregate") or "").lower() or None
        alias = c.get("alias")

        _check_in_play(t)
        qualified = _qualify(t, col)

        if agg:
            if agg not in ALLOWED_AGGREGATES:
                raise ValueError(f"Aggregate '{agg}' is not allowed")
            has_aggregate = True
            if agg == "count_distinct":
                expr = f"COUNT(DISTINCT {qualified})"
            else:
                expr = f"{agg.upper()}({qualified})"
        else:
            expr = qualified

        if alias:
            # Validate alias is a simple identifier
            if not _safe_ident(alias):
                raise ValueError(f"Invalid alias '{alias}'")
            expr = f"{expr} AS `{alias}`"
        select_parts.append(expr)

    # --- FROM + JOINs --------------------------------------------------- #
    from_clause = f"`{primary}`"
    for j in joins:
        jt = j["table"]
        left = j.get("left") or {}
        right = j.get("right") or {}
        jtype = (j.get("type") or "INNER").upper()
        if jtype not in {"INNER", "LEFT", "RIGHT"}:
            raise ValueError(f"Join type '{jtype}' is not allowed")
        l_qual = _qualify(left.get("table"), left.get("column"))
        r_qual = _qualify(right.get("table"), right.get("column"))
        from_clause += f" {jtype} JOIN `{jt}` ON {l_qual} = {r_qual}"

    # --- WHERE clause --------------------------------------------------- #
    where_parts: List[str] = []
    params: Dict[str, Any] = {}
    param_counter = 0

    # Auto-inject account_id scoping when the primary table has a tenant column.
    # In this schema the column is `accountid` (no underscore); fall back to
    # `account_id` for any tables that diverge.
    tenant_col = None
    if _column_exists(primary, "accountid"):
        tenant_col = "accountid"
    elif _column_exists(primary, "account_id"):
        tenant_col = "account_id"
    if tenant_col:
        where_parts.append(f"`{primary}`.`{tenant_col}` = :tenant_account_id")
        params["tenant_account_id"] = account_id

    for f in raw_filters:
        t = f.get("table")
        col = f.get("column")
        op_key = f.get("op")
        value = f.get("value")

        _check_in_play(t)
        qualified = _qualify(t, col)
        if op_key not in ALLOWED_OPERATORS:
            raise ValueError(f"Operator '{op_key}' is not allowed")
        sql_op = ALLOWED_OPERATORS[op_key]

        if op_key in UNARY_OPERATORS:
            where_parts.append(f"{qualified} {sql_op}")
            continue

        if op_key in LIST_OPERATORS:
            if not isinstance(value, list) or not value:
                raise ValueError(f"Operator '{op_key}' requires a non-empty list")
            placeholders = []
            for v in value:
                key = f"p{param_counter}"
                param_counter += 1
                placeholders.append(f":{key}")
                params[key] = v
            where_parts.append(f"{qualified} {sql_op} ({', '.join(placeholders)})")
            continue

        # Scalar operator
        if value is None:
            raise ValueError(f"Operator '{op_key}' requires a value")
        key = f"p{param_counter}"
        param_counter += 1
        params[key] = value
        where_parts.append(f"{qualified} {sql_op} :{key}")

    where_sql = ""
    if where_parts:
        where_sql = " WHERE " + " AND ".join(where_parts)

    # --- GROUP BY ------------------------------------------------------- #
    group_sql = ""
    if raw_group_by:
        gbs = []
        for g in raw_group_by:
            _check_in_play(g.get("table"))
            gbs.append(_qualify(g.get("table"), g.get("column")))
        group_sql = " GROUP BY " + ", ".join(gbs)
    elif has_aggregate:
        # If aggregates are present, group by every non-aggregated column.
        gbs = []
        for c in raw_columns:
            if c.get("aggregate"):
                continue
            gbs.append(_qualify(c.get("table"), c.get("column")))
        if gbs:
            group_sql = " GROUP BY " + ", ".join(gbs)

    # --- ORDER BY ------------------------------------------------------- #
    order_sql = ""
    if raw_order_by:
        obs = []
        for o in raw_order_by:
            _check_in_play(o.get("table"))
            qualified = _qualify(o.get("table"), o.get("column"))
            direction = (o.get("direction") or "ASC").upper()
            if direction not in {"ASC", "DESC"}:
                raise ValueError(f"Order direction '{direction}' is not allowed")
            obs.append(f"{qualified} {direction}")
        order_sql = " ORDER BY " + ", ".join(obs)

    # --- LIMIT ---------------------------------------------------------- #
    try:
        limit_int = int(limit)
    except (TypeError, ValueError):
        raise ValueError("limit must be an integer")
    if limit_int < 1:
        limit_int = 1
    if limit_int > MAX_LIMIT:
        limit_int = MAX_LIMIT

    sql = (
        f"SELECT {', '.join(select_parts)} "
        f"FROM {from_clause}"
        f"{where_sql}{group_sql}{order_sql} "
        f"LIMIT {limit_int}"
    )

    log.info(
        "[RAW] Executing | account_id=%s | sql=%s | params=%s",
        account_id, sql, {k: v for k, v in params.items()},
    )

    # --- Execute -------------------------------------------------------- #
    with engine.connect() as conn:
        result = conn.execute(text(sql), params)
        rows: List[Dict[str, Any]] = [dict(r._mapping) for r in result]
        columns_out = list(result.keys())

    return {
        "sql": sql,
        "params": params,
        "columns": columns_out,
        "rows": rows,
        "row_count": len(rows),
        "truncated": len(rows) == limit_int,
    }


def _safe_ident(s: str) -> bool:
    """True if `s` is a safe SQL identifier we can backtick-quote."""
    if not s or len(s) > 64:
        return False
    return all(ch.isalnum() or ch == "_" for ch in s)
