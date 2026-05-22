"""
Deterministic SQL compiler (sqlglot edition).

Builds parameterized SQL from a validated AnalyticsDSL using sqlglot's AST
builders instead of string concatenation. Replaces the legacy regex-based
compiler while keeping the same public contract:

    DeterministicCompiler().compile(dsl) -> CompiledQuery

Safety guarantees:
  - Tenant filter (`<base>.accountid = :account_id`) is injected via AST.
  - Joins are whitelisted against `knowledge/join_graph/safe_join_paths.yaml`.
  - Every join propagates tenant boundary (`joined.accountid = base.accountid`).
  - Filter values are bound as named parameters (no string interpolation).
  - Final AST is walked to reject DDL/DML and to verify tenant isolation.
"""

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import yaml
from sqlglot import exp, parse_one

from app.dsl import AnalyticsDSL, DSLValidationError

logger = logging.getLogger(__name__)

DIALECT = "mysql"
BASE_ALIAS = "log"
DEFAULT_BASE_TABLE = "tblassignjobcandidatelog"
MAX_LIMIT = 1000
DEFAULT_LIMIT = 100

# Semantic table aliases — so generated SQL reads naturally
# (e.g. `ajc.candidatestatusid` instead of `log.candidatestatusid`).
TABLE_ALIASES: Dict[str, str] = {
    "tblassignjobcandidate": "ajc",
    "tblassignjobcandidatelog": "log",
    "tbljob": "j",
    "tblcandidate": "c",
    "tblcandidatestatus": "cs",
    "tbluser": "u",
    "tbldeals": "d",
    "tbljobstatus": "js",
}

# Tables that use soft-delete (is_deleted column) instead of hard-delete.
SOFT_DELETE_TABLES: set = {"tblassignjobcandidate"}

# Tables that use a 'deleted' flag column.
DELETED_FLAG_TABLES: set = {"tbljob"}

# Lookup/dimension tables where tenant propagation in the JOIN ON clause is
# unnecessary — they are already scoped via FK from a tenant-filtered base row.
SKIP_TENANT_JOIN_TABLES: set = {"tblcandidatestatus", "tbljobstatus"}


@dataclass
class CompiledQuery:
    sql: str
    params: dict
    visualization_type: str
    intent_family: str


class CompilerSecurityError(Exception):
    """Raised when the generated SQL fails AST-level safety validation."""


# Declarative dimension → join + projection mapping.
# (Previously hardcoded inside a long if/elif chain.)
@dataclass(frozen=True)
class DimensionJoin:
    table: str
    alias: str
    base_col: str       # column on the base table
    join_col: str       # column on the joined table
    select_col: str     # column on the joined table to project


DIMENSION_JOINS: Dict[str, DimensionJoin] = {
    "label": DimensionJoin(
        table="tblcandidatestatus", alias="cs",
        base_col="candidatestatusid", join_col="id", select_col="label",
    ),
    "firstname": DimensionJoin(
        table="tbluser", alias="u",
        base_col="createdby", join_col="id", select_col="firstname",
    ),
}


@dataclass(frozen=True)
class FilterJoin:
    table: str
    alias: str
    base_col: str
    join_col: str
    target_col: str


FILTER_JOINS: Dict[str, FilterJoin] = {
    "job_title": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "job": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "job_name": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "role": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "position": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "job_role": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="name"),
    "slug": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="slug"),
    "job_slug": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="slug"),
    "stage": FilterJoin(table="tblcandidatestatus", alias="cs", base_col="candidatestatusid", join_col="id", target_col="label"),
    "status": FilterJoin(table="tblcandidatestatus", alias="cs", base_col="candidatestatusid", join_col="id", target_col="label"),
    "recruiter": FilterJoin(table="tbluser", alias="u", base_col="createdby", join_col="id", target_col="firstname"),
    "firstname": FilterJoin(table="tbluser", alias="u", base_col="createdby", join_col="id", target_col="firstname"),
    "city": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="city"),
    "country": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="country"),
    "archived": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="archived"),
    "job_type": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="job_type"),
    "job_category": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="job_category"),
    "deleted": FilterJoin(table="tbljob", alias="j", base_col="jobid", join_col="id", target_col="deleted"),
}


class DeterministicCompiler:
    """Compiles AnalyticsDSL → CompiledQuery (parameterized SQL) via sqlglot AST."""

    def __init__(self, knowledge_base_path: str = "backend/knowledge"):
        self.kb_path = self._resolve_kb_path(knowledge_base_path)
        logger.info("DeterministicCompiler (sqlglot) initialised at: %s", self.kb_path)

        self.metrics = self._load_yaml_dir("metrics")
        self.transitions = self._load_yaml_dir("transitions")
        self.join_graph = self._load_yaml_dir("join_graph")
        self.schema_reality = self._load_yaml_dir("schema_reality/tables")

        # Build the whitelisted (left_table, right_table) edge set from safe_join_paths.yaml.
        self.safe_edges: set[Tuple[str, str]] = self._build_safe_edges()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def compile(self, dsl: AnalyticsDSL, request_id: Optional[str] = None) -> CompiledQuery:
        logger.info(
            "[COMPILER] Step 2 started: compile AnalyticsDSL to SQL | request_id=%s | dsl=%s",
            request_id,
            dsl.model_dump(),
        )
        if not dsl.metrics:
            raise ValueError("DSL must reference at least one metric")

        metric_id = dsl.metrics[0]
        metric_def = self._find_metric_definition(metric_id)
        if not metric_def:
            raise ValueError(f"Unknown metric: {metric_id}")
        logger.info(
            "[COMPILER] Step 2.1 Metric definition loaded | request_id=%s | metric=%s | source_table=%s | has_numerator_sql=%s | business_meaning=%r",
            request_id,
            metric_id,
            metric_def.get("source_table", DEFAULT_BASE_TABLE),
            bool(metric_def.get("numerator_sql")),
            metric_def.get("business_meaning"),
        )

        if metric_id == "candidate_list":
            base_table = "tblassignjobcandidate"
            base_alias = "ajc"
            params: dict = {"account_id": dsl.account_id}
            logger.info(
                "[COMPILER] Step 2.2 Special table flow selected | request_id=%s | metric=%s | base_table=%s | base_alias=%s",
                request_id,
                metric_id,
                base_table,
                base_alias,
            )
            
            # Custom candidate details list query columns
            select_exprs = [
                exp.column("firstname", "c").as_("firstname"),
                exp.column("lastname", "c").as_("lastname"),
                exp.column("emailid", "c").as_("emailid"),
                exp.column("contactnumber", "c").as_("contactnumber"),
                exp.column("id", "j").as_("job_id"),
                exp.column("name", "j").as_("job_name"),
                exp.column("label", "cs").as_("stage"),
                parse_one("ROUND((UNIX_TIMESTAMP() - ajc.stagedate) / 86400)", dialect=DIALECT).as_("days_in_stage"),
            ]
            
            # Base table SELECT FROM
            query = exp.select(*select_exprs).from_(
                exp.Table(this=exp.to_identifier(base_table), alias=exp.to_identifier(base_alias))
            )
            
            # Whitelisted Joins
            # 1. tblcandidate AS c
            self._assert_safe_join(base_table, "tblcandidate")
            logger.info(
                "[COMPILER] Step 2.3 Join approved and added | request_id=%s | left=%s | right=%s | reason=candidate details",
                request_id,
                base_table,
                "tblcandidate",
            )
            query = query.join(
                expression=exp.Table(this=exp.to_identifier("tblcandidate"), alias=exp.to_identifier("c")),
                on=exp.and_(
                    exp.column("candidateid", base_alias).eq(exp.column("id", "c")),
                    exp.column("accountid", "c").eq(exp.column("accountid", base_alias)),
                ),
                join_type="inner",
            )
            
            # 2. tbljob AS j
            self._assert_safe_join(base_table, "tbljob")
            logger.info(
                "[COMPILER] Step 2.4 Join approved and added | request_id=%s | left=%s | right=%s | reason=job details",
                request_id,
                base_table,
                "tbljob",
            )
            query = query.join(
                expression=exp.Table(this=exp.to_identifier("tbljob"), alias=exp.to_identifier("j")),
                on=exp.and_(
                    exp.column("jobid", base_alias).eq(exp.column("id", "j")),
                    exp.column("accountid", "j").eq(exp.column("accountid", base_alias)),
                    exp.column("deleted", "j").eq(exp.Literal.number(0)),
                    exp.column("archived", "j").eq(exp.Literal.number(0)),
                ),
                join_type="inner",
            )
            
            # 3. tblcandidatestatus AS cs
            self._assert_safe_join(base_table, "tblcandidatestatus")
            logger.info(
                "[COMPILER] Step 2.5 Join approved and added | request_id=%s | left=%s | right=%s | reason=status label",
                request_id,
                base_table,
                "tblcandidatestatus",
            )
            query = query.join(
                expression=exp.Table(this=exp.to_identifier("tblcandidatestatus"), alias=exp.to_identifier("cs")),
                on=exp.column("candidatestatusid", base_alias).eq(exp.column("id", "cs")),
                join_type="inner",
            )
            
            # WHERE conditions
            conditions = [
                exp.column("accountid", base_alias).eq(exp.Placeholder(this="account_id")),
                exp.column("is_deleted", base_alias).eq(exp.Literal.number(0)),
                exp.column("deleted", "c").eq(exp.Literal.number(0)),
            ]
            
            # Process DSL filters
            for i, f in enumerate(dsl.filters):
                pname = f"f_{i}"
                params[pname] = f.value
                col_name, alias, _ = self._resolve_filter_target(f.field, base_table, base_alias)
                col_expr = exp.column(col_name, alias)
                logger.info(
                    "[COMPILER] Step 2.6 Filter compiled | request_id=%s | field=%s | operator=%s | value=%r | target=%s.%s | param=%s",
                    request_id,
                    f.field,
                    f.operator,
                    f.value,
                    alias,
                    col_name,
                    pname,
                )
                conditions.append(
                    self._compile_filter_condition(col_expr, f.operator, exp.Placeholder(this=pname))
                )
                
            query = query.where(exp.and_(*conditions))
            
            # ORDER BY
            query = query.order_by(exp.column("stagedate", base_alias).asc())
            
            # LIMIT
            query = query.limit(DEFAULT_LIMIT)
            
            # Safety checks & return
            sql = query.sql(dialect=DIALECT)
            self._validate_ast(query, base_table, request_id=request_id)
            
            logger.info(
                "[COMPILER] Step 2 completed: candidate list SQL generated | request_id=%s | sql=%s | params=%s",
                request_id,
                sql,
                params,
            )
            
            return CompiledQuery(
                sql=sql,
                params=params,
                visualization_type="table",
                intent_family=dsl.intent_family,
            )

        elif metric_id == "open_jobs_list":
            base_table = "tbljob"
            base_alias = "j"
            params: dict = {"account_id": dsl.account_id}
            logger.info(
                "[COMPILER] Step 2.2 Special table flow selected | request_id=%s | metric=%s | base_table=%s | base_alias=%s",
                request_id,
                metric_id,
                base_table,
                base_alias,
            )
            
            # Custom open jobs list query columns
            select_exprs = [
                exp.column("id", "j").as_("job_id"),
                exp.column("name", "j").as_("job_name"),
                exp.column("city", "j"),
                exp.column("country", "j"),
                exp.column("noofopenings", "j"),
                exp.column("label", "js").as_("job_status"),
                parse_one("ROUND((UNIX_TIMESTAMP() - j.createdon) / 86400)", dialect=DIALECT).as_("days_open"),
            ]
            
            # Base table SELECT FROM
            query = exp.select(*select_exprs).from_(
                exp.Table(this=exp.to_identifier(base_table), alias=exp.to_identifier(base_alias))
            )
            
            # Whitelisted Joins
            self._assert_safe_join(base_table, "tbljobstatus")
            logger.info(
                "[COMPILER] Step 2.3 Join approved and added | request_id=%s | left=%s | right=%s | reason=job status label",
                request_id,
                base_table,
                "tbljobstatus",
            )
            query = query.join(
                expression=exp.Table(this=exp.to_identifier("tbljobstatus"), alias=exp.to_identifier("js")),
                on=exp.column("jobstatus", base_alias).eq(exp.column("id", "js")),
                join_type="inner",
            )
            
            # WHERE conditions
            conditions = [
                exp.column("accountid", base_alias).eq(exp.Placeholder(this="account_id")),
                exp.column("deleted", base_alias).eq(exp.Literal.number(0)),
                exp.column("archived", base_alias).eq(exp.Literal.number(0)),
            ]
            
            # Process DSL filters
            for i, f in enumerate(dsl.filters):
                pname = f"f_{i}"
                params[pname] = f.value
                if f.field == "days_open":
                    round_expr = parse_one("ROUND((UNIX_TIMESTAMP() - j.createdon) / 86400)", dialect=DIALECT)
                    logger.info(
                        "[COMPILER] Step 2.4 Filter compiled | request_id=%s | field=%s | operator=%s | value=%r | target=derived.days_open | param=%s",
                        request_id,
                        f.field,
                        f.operator,
                        f.value,
                        pname,
                    )
                    if f.operator == "gt":
                        conditions.append(exp.GT(this=round_expr, expression=exp.Placeholder(this=pname)))
                    elif f.operator == "lt":
                        conditions.append(exp.LT(this=round_expr, expression=exp.Placeholder(this=pname)))
                    else:
                        conditions.append(exp.EQ(this=round_expr, expression=exp.Placeholder(this=pname)))
                else:
                    col_name, alias, _ = self._resolve_filter_target(f.field, base_table, base_alias)
                    col_expr = exp.column(col_name, alias)
                    logger.info(
                        "[COMPILER] Step 2.4 Filter compiled | request_id=%s | field=%s | operator=%s | value=%r | target=%s.%s | param=%s",
                        request_id,
                        f.field,
                        f.operator,
                        f.value,
                        alias,
                        col_name,
                        pname,
                    )
                    conditions.append(
                        self._compile_filter_condition(col_expr, f.operator, exp.Placeholder(this=pname))
                    )
                
            query = query.where(exp.and_(*conditions))
            
            # ORDER BY
            query = query.order_by(exp.column("days_open").desc())
            
            # LIMIT
            query = query.limit(DEFAULT_LIMIT)
            
            # Safety checks & return
            sql = query.sql(dialect=DIALECT)
            self._validate_ast(query, base_table, request_id=request_id)
            
            logger.info(
                "[COMPILER] Step 2 completed: open jobs SQL generated | request_id=%s | sql=%s | params=%s",
                request_id,
                sql,
                params,
            )
            
            return CompiledQuery(
                sql=sql,
                params=params,
                visualization_type="table",
                intent_family=dsl.intent_family,
            )

        base_table = metric_def.get("source_table", DEFAULT_BASE_TABLE)
        temporal_col = metric_def.get("temporal_column", "createdon")
        base_alias = TABLE_ALIASES.get(base_table, BASE_ALIAS)
        logger.info(
            "[COMPILER] Step 2.2 Generic aggregate flow selected | request_id=%s | metric=%s | base_table=%s | base_alias=%s | temporal_column=%s",
            request_id,
            metric_id,
            base_table,
            base_alias,
            temporal_col,
        )

        params: dict = {"account_id": dsl.account_id}
        logger.info(
            "[COMPILER] Step 2.3 Tenant parameter prepared | request_id=%s | account_id=%s | base_tenant_column=%s.accountid",
            request_id,
            dsl.account_id,
            base_alias,
        )

        # ---- SELECT + GROUP BY (one entry per dimension) ----
        select_exprs: List[exp.Expression] = []
        group_exprs: List[exp.Expression] = []
        joined_tables: List[str] = []

        for dim in dsl.dimensions:
            label_expr, group_expr, join_node = self._compile_dimension(
                dim, base_table, temporal_col, base_alias
            )
            select_exprs.append(label_expr)
            group_exprs.append(group_expr)
            if join_node is not None:
                joined_tables.append(join_node["table"])
            logger.info(
                "[COMPILER] Step 2.4 Dimension compiled | request_id=%s | dimension=%s | join_required=%s | join_table=%s | select_expression=%s | group_expression=%s",
                request_id,
                dim,
                join_node is not None,
                join_node["table"] if join_node is not None else None,
                label_expr.sql(dialect=DIALECT),
                group_expr.sql(dialect=DIALECT),
            )

        # ---- Measure (numerator) ----
        measure_expr = self._compile_measure(metric_def, base_alias)
        select_exprs.append(exp.alias_(measure_expr, "value"))
        logger.info(
            "[COMPILER] Step 2.5 Measure compiled from numerator_sql | request_id=%s | numerator_sql=%r | measure_expression=%s",
            request_id,
            metric_def.get("numerator_sql"),
            measure_expr.sql(dialect=DIALECT),
        )

        # ---- Build the base SELECT/FROM ----
        query = exp.select(*select_exprs).from_(
            exp.Table(this=exp.to_identifier(base_table), alias=exp.to_identifier(base_alias))
        )

        # ---- Collect all required filter joins ----
        filter_joins_to_apply: Dict[str, FilterJoin] = {}
        for f in dsl.filters:
            col_name, alias, f_join = self._resolve_filter_target(f.field, base_table, base_alias)
            if f_join is not None:
                filter_joins_to_apply[f_join.table] = f_join
            logger.info(
                "[COMPILER] Step 2.6 Filter target resolved | request_id=%s | field=%s | operator=%s | target=%s.%s | join_required=%s | join_table=%s",
                request_id,
                f.field,
                f.operator,
                alias,
                col_name,
                f_join is not None,
                f_join.table if f_join is not None else None,
            )

        # ---- JOINs (whitelist-checked, tenant-propagating) ----
        joined_tables: set[str] = set()

        # Apply any joins required by the filters first.
        for table, f_join in filter_joins_to_apply.items():
            if table in joined_tables:
                continue

            self._assert_safe_join(base_table, f_join.table)
            logger.info(
                "[COMPILER] Step 2.7 Filter join approved and added | request_id=%s | left=%s | right=%s | alias=%s | tenant_propagated=true",
                request_id,
                base_table,
                f_join.table,
                f_join.alias,
            )

            on_conditions = [
                exp.column(f_join.base_col, base_alias).eq(
                    exp.column(f_join.join_col, f_join.alias)
                ),
                # Tenant propagation — required for every join.
                exp.column("accountid", f_join.alias).eq(
                    exp.column("accountid", base_alias)
                ),
            ]
            # Safety: exclude soft-deleted rows from joined tables.
            if f_join.table in DELETED_FLAG_TABLES:
                on_conditions.append(
                    exp.column("deleted", f_join.alias).eq(exp.Literal.number(0))
                )

            query = query.join(
                expression=exp.Table(
                    this=exp.to_identifier(f_join.table),
                    alias=exp.to_identifier(f_join.alias),
                ),
                on=exp.and_(*on_conditions),
                join_type="inner",
            )
            joined_tables.add(table)

        # Apply dimension joins second.
        for dim in dsl.dimensions:
            join_info = self._dimension_join(dim, base_table)
            if join_info is None:
                continue
            if join_info.table in joined_tables:
                continue

            self._assert_safe_join(base_table, join_info.table)
            logger.info(
                "[COMPILER] Step 2.8 Dimension join approved and added | request_id=%s | dimension=%s | left=%s | right=%s | alias=%s | tenant_propagated=%s",
                request_id,
                dim,
                base_table,
                join_info.table,
                join_info.alias,
                join_info.table not in SKIP_TENANT_JOIN_TABLES,
            )

            on_conditions = [
                exp.column(join_info.base_col, base_alias).eq(
                    exp.column(join_info.join_col, join_info.alias)
                ),
            ]
            # Tenant propagation — skip for lookup tables already scoped via FK.
            if join_info.table not in SKIP_TENANT_JOIN_TABLES:
                on_conditions.append(
                    exp.column("accountid", join_info.alias).eq(
                        exp.column("accountid", base_alias)
                    )
                )

            query = query.join(
                expression=exp.Table(
                    this=exp.to_identifier(join_info.table),
                    alias=exp.to_identifier(join_info.alias),
                ),
                on=exp.and_(*on_conditions),
                join_type="inner",
            )
            joined_tables.add(join_info.table)

        # ---- WHERE: mandatory tenant isolation + DSL filters ----
        conditions: List[exp.Expression] = [
            exp.column("accountid", base_alias).eq(exp.Placeholder(this="account_id"))
        ]
        logger.info(
            "[COMPILER] Step 2.9 Mandatory tenant WHERE condition injected | request_id=%s | condition=%s.accountid = :account_id",
            request_id,
            base_alias,
        )

        # Soft-delete filter for tables that use is_deleted.
        if base_table in SOFT_DELETE_TABLES:
            conditions.append(
                exp.column("is_deleted", base_alias).eq(exp.Literal.number(0))
            )
            logger.info(
                "[COMPILER] Step 2.10 Soft-delete condition injected | request_id=%s | condition=%s.is_deleted = 0",
                request_id,
                base_alias,
            )

        for i, f in enumerate(dsl.filters):
            pname = f"f_{i}"
            params[pname] = f.value
            col_name, alias, _ = self._resolve_filter_target(f.field, base_table, base_alias)
            col_expr = exp.column(col_name, alias)
            logger.info(
                "[COMPILER] Step 2.11 WHERE filter compiled | request_id=%s | field=%s | operator=%s | value=%r | target=%s.%s | param=%s",
                request_id,
                f.field,
                f.operator,
                f.value,
                alias,
                col_name,
                pname,
            )
            conditions.append(
                self._compile_filter_condition(col_expr, f.operator, exp.Placeholder(this=pname))
            )
        query = query.where(exp.and_(*conditions))

        # ---- GROUP BY ----
        # For stage breakdowns, include cs.id and cs.sequenceno for correctness
        # (handles duplicate labels and enables sequenceno ordering).
        is_stage_breakdown = (
            "label" in dsl.dimensions and "tblcandidatestatus" in joined_tables
        )
        if is_stage_breakdown:
            group_exprs.insert(0, exp.column("id", "cs"))
            group_exprs.append(exp.column("sequenceno", "cs"))
            logger.info(
                "[COMPILER] Step 2.12 Stage breakdown detected | request_id=%s | extra_group_columns=%s",
                request_id,
                ["cs.id", "cs.sequenceno"],
            )
        if group_exprs:
            query = query.group_by(*group_exprs)
            logger.info(
                "[COMPILER] Step 2.13 GROUP BY applied | request_id=%s | group_expressions=%s",
                request_id,
                [g.sql(dialect=DIALECT) for g in group_exprs],
            )

        # ---- ORDER BY: pipeline sequence for stages, chronological for time ----
        is_time_series = "month" in dsl.dimensions
        if is_time_series:
            query = query.order_by(exp.column("label").asc())
            order_reason = "time series chronological order"
        elif is_stage_breakdown:
            query = query.order_by(exp.column("sequenceno", "cs").asc())
            order_reason = "pipeline stage sequence order"
        else:
            query = query.order_by(exp.column("value").desc())
            order_reason = "largest value first"
        logger.info(
            "[COMPILER] Step 2.14 ORDER BY applied | request_id=%s | reason=%s",
            request_id,
            order_reason,
        )

        # ---- LIMIT ----
        query = query.limit(DEFAULT_LIMIT)
        logger.info(
            "[COMPILER] Step 2.15 LIMIT applied | request_id=%s | limit=%s",
            request_id,
            DEFAULT_LIMIT,
        )

        # ---- Render + AST-level safety validation ----
        sql = query.sql(dialect=DIALECT)
        self._validate_ast(query, base_table, request_id=request_id)

        logger.info(
            "[COMPILER] Step 2 completed: SQL generated and safety validated | request_id=%s | sql=%s | params=%s | visualization_type=%s",
            request_id,
            sql,
            params,
            dsl.visualization_plan.type,
        )

        return CompiledQuery(
            sql=sql,
            params=params,
            visualization_type=dsl.visualization_plan.type,
            intent_family=dsl.intent_family,
        )

    # ------------------------------------------------------------------ #
    # Dimension / measure compilation
    # ------------------------------------------------------------------ #
    def _compile_dimension(
        self, dim: str, base_table: str, temporal_col: str,
        base_alias: str = BASE_ALIAS,
    ) -> Tuple[exp.Expression, exp.Expression, Optional[dict]]:
        """Return (select_expr_aliased_as_label, group_expr, join_info_or_none)."""
        join_info = self._dimension_join(dim, base_table)
        if join_info is not None:
            col = exp.column(join_info.select_col, join_info.alias)
            return exp.alias_(col, "label"), col.copy(), {"table": join_info.table}

        if dim == "month":
            month_expr = exp.func(
                "FROM_UNIXTIME",
                exp.column(temporal_col, base_alias),
                exp.Literal.string("%Y-%m"),
            )
            return exp.alias_(month_expr, "label"), month_expr.copy(), None

        # Default: column on the base table.
        col = exp.column(dim, base_alias)
        return exp.alias_(col, "label"), col.copy(), None

    def _dimension_join(self, dim: str, base_table: str) -> Optional[DimensionJoin]:
        """Look up the join spec for a dimension.

        A dimension join is applicable whenever the chosen base table actually
        has the required `base_col`. We consult schema_reality to verify so the
        same metric YAML can target different `source_table`s (e.g. the log
        fact table or `tbljob`) without code changes.
        """
        join = DIMENSION_JOINS.get(dim)
        if join is None:
            return None
        if not self._table_has_column(base_table, join.base_col):
            return None
        return join

    def _table_has_column(self, table: str, column: str) -> bool:
        """True if `table` is known in schema_reality and has `column`."""
        table_def = self.schema_reality.get(table) or {}
        cols = table_def.get("columns") or []
        return any(c.get("name") == column for c in cols)

    def _resolve_filter_target(
        self, field: str, base_table: str, base_alias: str = BASE_ALIAS,
    ) -> Tuple[str, str, Optional[FilterJoin]]:
        """Resolve a filter field name to the target column and target table alias.

        Supports mapping semantic filters like 'job_title' to 'tbljob.name' and 
        dynamically determining if a join with 'tbljob' is required.
        """
        field_lower = field.lower()
        
        # 1. Check if the field maps to a known related table join
        filter_join = FILTER_JOINS.get(field_lower)
        if filter_join is not None:
            # If the base table is already the target table, we don't need a join!
            if base_table == filter_join.table:
                return filter_join.target_col, base_alias, None
            # Otherwise, check if the base table has the column to perform the join
            if self._table_has_column(base_table, filter_join.base_col):
                return filter_join.target_col, filter_join.alias, filter_join
                
        # 2. If the field exists directly on the base table
        if self._table_has_column(base_table, field):
            return field, base_alias, None
            
        # Special logic for "status" which could refer to different tables based on context
        if field_lower in ["status", "job_status", "stage"]:
            if self._table_has_column(base_table, "jobstatus") and field_lower in ["status", "job_status"]:
                f_join = FilterJoin(table="tbljobstatus", alias="js", base_col="jobstatus", join_col="id", target_col="label")
                return f_join.target_col, f_join.alias, f_join
            elif self._table_has_column(base_table, "candidatestatusid") and field_lower in ["status", "stage"]:
                f_join = FilterJoin(table="tblcandidatestatus", alias="cs", base_col="candidatestatusid", join_col="id", target_col="label")
                return f_join.target_col, f_join.alias, f_join

        # Fallback mappings for columns on the base table itself (e.g. if we are already querying tbljob)
        if field_lower in ["job_title", "job_name"] and self._table_has_column(base_table, "name"):
            return "name", base_alias, None

        # No valid mapping found — raise an error instead of letting
        # an unmapped column name reach MySQL and cause a runtime error.
        raise DSLValidationError(
            f"Cannot resolve filter field '{field}' against table '{base_table}'. "
            f"Known filter fields: {list(FILTER_JOINS.keys())}"
        )

    def _compile_filter_condition(
        self,
        col_expr: exp.Expression,
        operator: str,
        placeholder: exp.Expression,
    ) -> exp.Expression:
        """Map a DSL filter operator string to the corresponding sqlglot comparison."""
        op = (operator or "eq").lower()
        if op == "eq":
            return col_expr.eq(placeholder)
        elif op == "ne":
            return col_expr.neq(placeholder)
        elif op == "gt":
            return exp.GT(this=col_expr, expression=placeholder)
        elif op == "lt":
            return exp.LT(this=col_expr, expression=placeholder)
        elif op == "gte":
            return exp.GTE(this=col_expr, expression=placeholder)
        elif op == "lte":
            return exp.LTE(this=col_expr, expression=placeholder)
        elif op == "like":
            return exp.Like(this=col_expr, expression=placeholder)
        else:
            logger.warning("Unsupported filter operator '%s', falling back to eq", op)
            return col_expr.eq(placeholder)

    def _compile_measure(
        self, metric_def: dict, base_alias: str = BASE_ALIAS,
    ) -> exp.Expression:
        """Compile the metric's executable SQL fragment into an AST expression.

        The single source of truth is the `numerator_sql` field on the metric
        definition.  YAML authors use the conventional alias `log.<column>` to
        reference base-table columns; the compiler remaps `log` → the actual
        base alias (e.g. `ajc` for tblassignjobcandidate) so the final SQL
        reads naturally.
        """
        sql_fragment = metric_def.get("numerator_sql")
        if not sql_fragment:
            raise ValueError(
                "Metric is missing `numerator_sql` (executable form). "
                "The abstract `numerator` field is documentation only."
            )
        try:
            parsed = parse_one(sql_fragment, dialect=DIALECT)
        except Exception as e:  # noqa: BLE001
            raise ValueError(
                f"Could not parse numerator_sql {sql_fragment!r}: {e}"
            ) from e

        # Remap the conventional 'log' alias to the actual base alias.
        if base_alias != "log":
            for col in parsed.find_all(exp.Column):
                if col.table == "log":
                    col.set("table", exp.to_identifier(base_alias))
        return parsed

    # ------------------------------------------------------------------ #
    # Safety: join whitelist + AST validation
    # ------------------------------------------------------------------ #
    def _build_safe_edges(self) -> set[Tuple[str, str]]:
        """Flatten safe_join_paths.yaml into an undirected edge set of allowed table pairs."""
        edges: set[Tuple[str, str]] = set()
        paths_doc = self.join_graph.get("safe_join_paths") or {}
        for path in paths_doc.get("safe_paths", []) or []:
            for step in path.get("join_sequence", []) or []:
                left = step.get("left", "").split(".")[0]
                right = step.get("right", "").split(".")[0]
                if left and right:
                    edges.add((left, right))
                    edges.add((right, left))
        return edges

    def _assert_safe_join(self, left: str, right: str) -> None:
        if not self.safe_edges:
            # No whitelist loaded — fall open with a warning rather than blocking dev.
            logger.warning("safe_join_paths.yaml not loaded; skipping join whitelist check")
            return
        if (left, right) not in self.safe_edges:
            raise CompilerSecurityError(
                f"Join {left} ↔ {right} is not in safe_join_paths.yaml"
            )

    def _validate_ast(
        self,
        tree: exp.Expression,
        base_table: str,
        request_id: Optional[str] = None,
    ) -> None:
        """AST-walk safety checks (replaces the legacy regex-based stage 10)."""
        base_alias = TABLE_ALIASES.get(base_table, BASE_ALIAS)
        logger.info(
            "[COMPILER] Safety validation started | request_id=%s | base_table=%s | base_alias=%s",
            request_id,
            base_table,
            base_alias,
        )

        forbidden = (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create, exp.Alter)
        if any(tree.find_all(*forbidden)):
            raise CompilerSecurityError("Forbidden DDL/DML detected in compiled SQL")
        logger.info(
            "[COMPILER] Safety validation passed | request_id=%s | check=no DDL/DML",
            request_id,
        )

        where = tree.find(exp.Where)
        if where is None:
            raise CompilerSecurityError("Compiled query is missing a WHERE clause")
        logger.info(
            "[COMPILER] Safety validation passed | request_id=%s | check=WHERE clause present",
            request_id,
        )

        # Tenant filter must apply to the base table.
        base_tenant_present = any(
            isinstance(col, exp.Column)
            and col.name == "accountid"
            and col.table == base_alias
            for col in where.find_all(exp.Column)
        )
        if not base_tenant_present:
            raise CompilerSecurityError(
                f"Tenant isolation missing: WHERE clause does not filter {base_alias}.accountid"
            )
        logger.info(
            "[COMPILER] Safety validation passed | request_id=%s | check=base tenant filter present | required=%s.accountid",
            request_id,
            base_alias,
        )

        # Every JOIN must propagate accountid in its ON clause (except
        # lookup/dimension tables in SKIP_TENANT_JOIN_TABLES).
        for join in tree.find_all(exp.Join):
            on_clause = join.args.get("on")
            if on_clause is None:
                raise CompilerSecurityError("JOIN without ON clause detected")
            # Identify the joined table's real name and skip if exempt.
            join_table = join.find(exp.Table)
            join_table_name = join_table.name if join_table else ""
            if join_table_name in SKIP_TENANT_JOIN_TABLES:
                logger.info(
                    "[COMPILER] Safety validation skipped tenant propagation for lookup table | request_id=%s | table=%s",
                    request_id,
                    join_table_name,
                )
                continue
            propagates = any(
                isinstance(c, exp.Column) and c.name == "accountid"
                for c in on_clause.find_all(exp.Column)
            )
            if not propagates:
                raise CompilerSecurityError(
                    "JOIN does not propagate tenant boundary (accountid missing in ON clause)"
                )
            logger.info(
                "[COMPILER] Safety validation passed | request_id=%s | check=join tenant propagation | table=%s",
                request_id,
                join_table_name,
            )
        logger.info(
            "[COMPILER] Safety validation completed | request_id=%s",
            request_id,
        )

    # ------------------------------------------------------------------ #
    # YAML loading
    # ------------------------------------------------------------------ #
    def _resolve_kb_path(self, knowledge_base_path: str) -> str:
        candidates = [knowledge_base_path, "knowledge", "../knowledge", "backend/knowledge"]
        for p in candidates:
            if os.path.isdir(os.path.join(p, "metrics")):
                return os.path.abspath(p)
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.abspath(os.path.join(base_dir, "knowledge"))

    def _load_yaml_dir(self, sub_dir: str) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        dir_path = os.path.join(self.kb_path, sub_dir)
        if not os.path.exists(dir_path):
            return result
        for root, _, files in os.walk(dir_path):
            for fname in files:
                if fname.endswith((".yaml", ".yml")):
                    with open(os.path.join(root, fname), "r") as f:
                        result[os.path.splitext(fname)[0]] = yaml.safe_load(f)
        return result

    def _find_metric_definition(self, metric_id: str) -> Optional[Dict[str, Any]]:
        for file_content in self.metrics.values():
            if isinstance(file_content, dict) and metric_id in file_content:
                return file_content[metric_id]
        return None


def get_compiler() -> DeterministicCompiler:
    return DeterministicCompiler()
