"""
Query Executor — Runs compiled SQL against MySQL.

Handles connection management, parameterized execution, and error handling.
"""

import logging
from dataclasses import dataclass

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

    def execute(self, compiled: CompiledQuery) -> QueryResult:
        """Execute a compiled query and return structured results."""
        db = SessionLocal()
        try:
            logger.info("--- DB EXECUTION START ---")
            logger.info(f"SQL: {compiled.sql}")
            logger.info(f"Parameters: {compiled.params}")

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

            logger.info(f"Query returned {len(rows)} rows")
            return QueryResult(
                rows=rows,
                row_count=len(rows),
                compiled=compiled,
            )

        except Exception as e:
            logger.error(f"Query execution failed: {e}")
            raise
        finally:
            db.close()
