"""
Query Engine — Main orchestrator for the deterministic analytics pipeline.

Wires together: AI Planner (LLM) → Deterministic SQL Compiler → Executor → Result Formatter
"""

import logging
import time
import uuid
from typing import Optional, Dict, Any

from app.deterministic_compiler import DeterministicCompiler, get_compiler
from app.executor import QueryExecutor, QueryResult
from app.dsl import AnalyticsDSL, DSLValidationError
from app.llm_engine import LLMEngine

logger = logging.getLogger(__name__)

class QueryEngine:
    """Main analytics pipeline orchestrator using deterministic foundations."""

    def __init__(self):
        self.compiler = get_compiler()
        self.executor = QueryExecutor()
        
        try:
            self.llm = LLMEngine()
            logger.info("Deterministic AI Planner initialized.")
        except Exception as e:
            logger.warning(f"AI Planner unavailable: {e}")
            self.llm = None

        self._sessions: dict[str, list[dict]] = {}

    # YAML files under knowledge/metrics/ that hold meta-config rather than
    # actual metric definitions. Must be excluded from the frontend catalogue.
    _META_FILES = {"metric_validation_rules", "metric_dependency_graph"}

    def get_metrics_summary(self) -> dict:
        """Expose the list of grounded metrics for the frontend sidebar.

        Only metrics with an executable `numerator_sql` are advertised, so the
        UI never offers a metric the compiler cannot answer.
        """
        summary = []
        for file_name, file_content in self.compiler.metrics.items():
            if file_name in self._META_FILES or not isinstance(file_content, dict):
                continue
            for m_id, m_def in file_content.items():
                if not isinstance(m_def, dict):
                    continue
                if not (isinstance(m_def.get("numerator_sql"), str)
                        and m_def["numerator_sql"].strip()):
                    continue
                display_name = m_id.replace("_", " ").title()
                description = m_def.get("business_meaning") or ""
                summary.append({
                    "name": m_id,
                    "display_name": display_name,
                    "description": description,
                    "category": file_name.replace("_metrics", "").title(),
                    "dimensions": [],
                    "filters": [],
                    "default_chart_type": (
                        (m_def.get("recommended_visualizations") or ["bar"])[0]
                    ),
                    "aliases": [m_id, display_name],
                })
        return {"metrics": summary}

    def process(self, message: str, account_id: int, session_id: Optional[str] = None) -> dict:
        """Process a natural language analytics query with full terminal audit trail."""
        start_time = time.time()
        request_id = str(uuid.uuid4())
        logger.info(
            "[REQUEST] Step 0 started: frontend query received | request_id=%s | account_id=%s | session_id=%s | message=%r",
            request_id,
            account_id,
            session_id,
            message,
        )
        print("\n" + "="*60)
        print(f"NEW ANALYTICS REQUEST | Request: {request_id} | Account: {account_id}")
        print(f"Query: \"{message}\"")
        print("="*60)

        # Step 1: AI Planner (LLM) - Resolve intent
        try:
            if not self.llm:
                raise DSLValidationError("AI Planner is offline (API Key Missing)")
            
            dsl = self.llm.resolve_intent(message, account_id, request_id=request_id)
            logger.info(
                "[REQUEST] Step 1 completed: planning finished | request_id=%s | dsl=%s",
                request_id,
                dsl.model_dump(),
            )
        except Exception as e:
            print(f"[ERROR] Planning Stage Failed: {e}")
            logger.exception("[REQUEST] Step 1 failed: planning failed | request_id=%s", request_id)
            return {"error": f"Failed to plan query: {str(e)}"}

        # Step 2: Deterministic Compilation
        print("\n[COMPILER] Expanding metrics and resolving safe join paths...")
        try:
            compiled = self.compiler.compile(dsl, request_id=request_id)
            print(f"[COMPILER] SQL Generated Successfully.")
            print(f"[COMPILER] SQL:\n{compiled.sql}")
            logger.info(
                "[REQUEST] Step 2 completed: deterministic compilation finished | request_id=%s | sql=%s | params=%s | visualization_type=%s",
                request_id,
                compiled.sql,
                compiled.params,
                compiled.visualization_type,
            )
        except Exception as e:
            print(f"[ERROR] Compilation Stage Failed: {e}")
            logger.exception("[REQUEST] Step 2 failed: compilation failed | request_id=%s", request_id)
            return {"error": f"Failed to build SQL: {str(e)}"}

        # Step 3: Database Execution
        print("\n[EXECUTOR] Running query against MySQL...")
        try:
            query_result = self.executor.execute(compiled, request_id=request_id)
            print(f"[EXECUTOR] Success. {len(query_result.rows)} rows returned.")
            logger.info(
                "[REQUEST] Step 3 completed: database execution finished | request_id=%s | row_count=%s | rows_sample=%s",
                request_id,
                query_result.row_count,
                query_result.rows[:5],
            )
        except Exception as e:
            print(f"[ERROR] Execution Stage Failed: {e}")
            logger.exception("[REQUEST] Step 3 failed: database execution failed | request_id=%s", request_id)
            return {"error": f"Database query failed: {str(e)}"}

        # Step 4: Formatting
        logger.info(
            "[RESPONSE] Step 4 started: shaping rows for frontend contract | request_id=%s | row_count=%s",
            request_id,
            query_result.row_count,
        )
        response = self._build_legacy_response(query_result, dsl)
        logger.info(
            "[RESPONSE] Step 4 completed: response ready | request_id=%s | chart_type=%s | title=%s | suggestions=%s",
            request_id,
            response.get("chart", {}).get("type"),
            response.get("title"),
            response.get("suggestions"),
        )
        
        duration = time.time() - start_time
        logger.info(
            "[REQUEST] Completed successfully | request_id=%s | duration_seconds=%.3f | status=success",
            request_id,
            duration,
        )
        print(f"\n[SUMMARY] Request completed in {duration:.2f}s")
        print("="*60 + "\n")

        return response

    def _build_legacy_response(self, result: QueryResult, dsl: AnalyticsDSL) -> dict:
        """Maps new deterministic results back to the old frontend contract."""
        chart_data = result.rows
        chart_type = result.compiled.visualization_type or dsl.visualization_plan.type
        
        if chart_type == "table":
            insight = f"Found {len(chart_data)} candidates matching the status stage criteria."
        else:
            insight = f"Found {len(chart_data)} results for {dsl.intent_family.replace('_', ' ')}."
            if chart_data:
                top = chart_data[0]
                insight += f" Top performer is {top.get('label', 'Unknown')} with {top.get('value', 0):,.1f}."

        return {
            "chart": {
                "type": chart_type,
                "data": chart_data,
                "config": {
                    "xLabel": dsl.dimensions[0] if dsl.dimensions else "Category",
                    "yLabel": "Value",
                },
            },
            "title": f"{dsl.intent_family.replace('_', ' ').title()}",
            "insight": insight,
            "intent": {
                "metric": dsl.metrics[0],
                "metric_label": dsl.metrics[0].replace('_', ' ').title(),
                "dimensions": dsl.dimensions,
                "filters": [f.model_dump() for f in dsl.filters],
                "chart_type": chart_type,
            },
            "suggestions": [
                "Show by department",
                "Compare by recruiter",
                "Show trend over time"
            ],
            "status": "success"
        }
