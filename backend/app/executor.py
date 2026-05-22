"""
Query Executor — Runs compiled SQL against MySQL.

Handles connection management, parameterized execution, and error handling.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text

from app.db import SessionLocal
from app.deterministic_compiler import CompiledQuery

logger = logging.getLogger(__name__)


@dataclass
class QueryResult:
    """Result of a database query execution."""
    rows: list[dict]
    row_count: int
    compiled: CompiledQuery


class QueryExecutor:
    """Executes compiled SQL queries against the database."""

    def execute(self, compiled: CompiledQuery, request_id: Optional[str] = None) -> QueryResult:
        """Execute a compiled query and return structured results."""
        db = SessionLocal()
        try:
            logger.info(
                "[EXECUTOR] Step 3 started: opening database session | request_id=%s",
                request_id,
            )
            logger.info(
                "[EXECUTOR] Step 3.1 Executing parameterized SQL | request_id=%s | sql=%s | params=%s",
                request_id,
                compiled.sql,
                compiled.params,
            )

            result = db.execute(text(compiled.sql), compiled.params)
            rows = []
            for row in result.fetchall():
                mapping = dict(row._mapping)
                # Ensure label is a string and value is numeric
                if "label" in mapping and mapping["label"] is None:
                    mapping["label"] = "Unknown"
                if "value" in mapping and mapping["value"] is not None:
                    mapping["value"] = float(mapping["value"])
                rows.append(mapping)

            logger.info(
                "[EXECUTOR] Step 3.2 Rows fetched and normalized | request_id=%s | row_count=%s | sample_rows=%s",
                request_id,
                len(rows),
                rows[:5],
            )
            return QueryResult(
                rows=rows,
                row_count=len(rows),
                compiled=compiled,
            )

        except Exception as e:
            logger.exception(
                "[EXECUTOR] Step 3 failed: query execution failed | request_id=%s | error=%s",
                request_id,
                e,
            )
            raise
        finally:
            logger.info(
                "[EXECUTOR] Step 3 finished: closing database session | request_id=%s",
                request_id,
            )
            db.close()
