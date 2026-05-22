"""
LLM Engine — The Deterministic AI Planner (tool-calling + RAG edition).

Uses Groq's structured tool calling instead of JSON-mode prompting, and
dynamically scopes the tool schema's `metrics` enum to the top-K candidates
retrieved for the current question. This shrinks the model's decision space
from "all metrics" to "the few most relevant ones", and frees prompt budget
for their descriptions.

Public contract is unchanged:
    LLMEngine().resolve_intent(query, account_id, history=None) -> AnalyticsDSL
"""

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from groq import Groq

from app.dsl import AnalyticsDSL, DSLValidationError
from app.retrieval import MetricCandidate, MetricRetriever

logger = logging.getLogger(__name__)

# Static enums (intentionally small — mirrors what the compiler can execute).
INTENT_FAMILIES = [
    "funnel_analysis",
    "time_efficiency",
    "recruiter_productivity",
    "bottleneck_detection",
    "trend",
    "ranking",
]

# Dimensions that the deterministic compiler knows how to materialise.
# Keep in sync with DIMENSION_JOINS in deterministic_compiler.py + the
# special-cased 'month' time-series dimension.
ALLOWED_DIMENSIONS = ["label", "firstname", "month", "company_name"]
ALLOWED_FILTERS = [
    "job_title", "job_name", "role", "slug", "stage", "status", "job_status",
    "recruiter", "firstname", "deleted", "archived", "days_open",
    "city", "country", "job_type", "job_category",
]

ALLOWED_CHART_TYPES = ["funnel", "bar", "line", "heatmap", "pie"]

FILTER_OPERATORS = ["eq", "ne", "gt", "lt", "gte", "lte", "in", "between", "like"]

TOOL_NAME = "build_analytics_query"

# How many metric candidates to surface to the model per question.
RAG_TOP_K = 5

SYSTEM_PROMPT = (
    "You are the AI Planner for RecruitCRM Analytics. Translate the recruiter's "
    "question into a single call to the `{tool}` tool. Today is {today}. Map "
    "relative times (\"this month\", \"last quarter\") to concrete ISO start/end "
    "dates. Pick the single most relevant metric from the candidates below. Use "
    "`label` for pipeline stage breakdowns, `firstname` for recruiter leaderboards, "
    "and `month` for trends. Do not invent values — you may only use the enums "
    "declared in the tool schema.\n\n"
    "CANDIDATE METRICS (ranked by relevance to the question):\n{candidates}"
)


class LLMEngine:
    """AI Planner: natural-language question → validated AnalyticsDSL via tool calling."""

    def __init__(self):
        api_key = os.getenv("GROQ_AI_ANALYTICS_API_KEY")
        if not api_key:
            logger.warning("GROQ_AI_ANALYTICS_API_KEY missing. LLM will be unavailable.")
            self.client: Optional[Groq] = None
        else:
            self.client = Groq(api_key=api_key)

        self.model = "llama-3.3-70b-versatile"

        # Build the retriever once. It indexes the metric knowledge base on
        # construction; per-query retrieval is fast (rapidfuzz over ~25 entries).
        self._retriever: Optional[MetricRetriever] = self._build_retriever()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def resolve_intent(
        self,
        query: str,
        account_id: int,
        history: Optional[list] = None,
        request_id: Optional[str] = None,
    ) -> AnalyticsDSL:
        if not self.client:
            raise DSLValidationError("LLM Service unavailable (API Key missing)")

        logger.info(
            "[PLANNER] Step 1 started: resolve natural-language question into AnalyticsDSL | request_id=%s | query=%r | account_id=%s",
            request_id,
            query,
            account_id,
        )

        # 1. RAG retrieval — narrow the candidate set for this question.
        candidates = self._retrieve_candidates(query)
        candidate_names = [c.name for c in candidates]
        logger.info(
            "[PLANNER] Step 1.1 RAG candidates received | request_id=%s | query=%r | account_id=%s | candidates=%s",
            request_id,
            query,
            account_id,
            [
                {
                    "name": c.name,
                    "score": round(c.score, 2),
                    "category": c.category,
                    "description": c.description,
                }
                for c in candidates
            ],
        )

        # 2. Build a tool schema whose `metrics` enum is scoped to those candidates.
        tool = self._build_tool_schema(candidate_names)
        logger.info(
            "[PLANNER] Step 1.2 Tool schema constrained | request_id=%s | allowed_metrics=%s | allowed_dimensions=%s | allowed_chart_types=%s | allowed_filters=%s",
            request_id,
            candidate_names,
            ALLOWED_DIMENSIONS,
            ALLOWED_CHART_TYPES,
            ALLOWED_FILTERS,
        )

        # 3. Compose a focused system prompt with the candidates' descriptions.
        system_prompt = SYSTEM_PROMPT.format(
            tool=TOOL_NAME,
            today=datetime.now().strftime("%Y-%m-%d"),
            candidates=self._format_candidates(candidates),
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ]
        logger.info(
            "[PLANNER] Step 1.3 LLM request prepared | request_id=%s | model=%s | account_id=%s | messages=%s | tool_schema=%s",
            request_id,
            self.model,
            account_id,
            json.dumps(messages, ensure_ascii=False),
            json.dumps(tool, ensure_ascii=False),
        )

        print(f"\n[AI PLANNER] Processing Query: '{query}'")
        print(f"[AI PLANNER] Mode: tool-calling + RAG (top-{len(candidate_names)})")
        print(f"[AI PLANNER] Candidates: {candidate_names}")

        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": TOOL_NAME}},
            temperature=0.0,
        )
        usage = getattr(response, "usage", None)
        logger.info(
            "[PLANNER] Step 1.4 LLM raw response received | request_id=%s | model=%s | usage=%s | response=%s",
            request_id,
            self.model,
            self._format_usage(usage),
            self._safe_model_dump(response),
        )

        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls:
            content = getattr(message, "content", "") or ""
            logger.error(
                "[PLANNER] Step 1 failed: LLM response did not include required tool call | request_id=%s | content=%r",
                request_id,
                content,
            )
            raise DSLValidationError(
                f"Model did not invoke `{TOOL_NAME}`. Raw content: {content[:200]}"
            )

        raw_args = tool_calls[0].function.arguments
        logger.info(
            "[PLANNER] Step 1.5 Tool-call arguments extracted | request_id=%s | raw_args=%s",
            request_id,
            raw_args,
        )

        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError as e:
            logger.exception(
                "[PLANNER] Step 1 failed: LLM tool arguments were not valid JSON | request_id=%s",
                request_id,
            )
            raise DSLValidationError(f"Tool arguments were not valid JSON: {e}") from e

        # Inject account_id server-side — never trust the model for this.
        args["account_id"] = account_id
        logger.info(
            "[PLANNER] Step 1.6 Server-side account_id injected | request_id=%s | account_id=%s",
            request_id,
            account_id,
        )

        try:
            dsl = AnalyticsDSL(**args)
        except Exception as e:  # noqa: BLE001
            logger.exception(
                "[PLANNER] Step 1 failed: planner produced invalid DSL | request_id=%s | args=%s",
                request_id,
                args,
            )
            raise DSLValidationError(f"Planner produced invalid DSL: {e}") from e
        logger.info(
            "[PLANNER] Step 1 completed: AnalyticsDSL parsed | request_id=%s | dsl=%s",
            request_id,
            dsl.model_dump(),
        )

        print(f"[AI PLANNER] Resolved Intent: {dsl.intent_family}")
        print(f"[AI PLANNER] Selected Metric: {dsl.metrics}")
        return dsl

    @staticmethod
    def _format_usage(usage: Any) -> Dict[str, Any]:
        """Return token usage in a stable dict, regardless of SDK object shape."""
        if usage is None:
            return {}
        if hasattr(usage, "model_dump"):
            return usage.model_dump()
        if isinstance(usage, dict):
            return usage
        return {
            "prompt_tokens": getattr(usage, "prompt_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None),
        }

    @staticmethod
    def _safe_model_dump(value: Any) -> str:
        """Serialize SDK objects for logging without crashing the request path."""
        try:
            if hasattr(value, "model_dump_json"):
                return value.model_dump_json()
            if hasattr(value, "model_dump"):
                return json.dumps(value.model_dump(), ensure_ascii=False, default=str)
            return json.dumps(value, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            return repr(value)

    # ------------------------------------------------------------------ #
    # RAG retrieval
    # ------------------------------------------------------------------ #
    def _build_retriever(self) -> Optional[MetricRetriever]:
        try:
            from app.deterministic_compiler import get_compiler
            return MetricRetriever(get_compiler())
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to build metric retriever: %s", e)
            return None

    def _retrieve_candidates(self, query: str) -> List[MetricCandidate]:
        """Return the top-K candidate metrics. Re-attempts retriever build if needed."""
        if self._retriever is None:
            self._retriever = self._build_retriever()
        if self._retriever is None:
            raise RuntimeError(
                "Metric retriever unavailable — cannot build tool schema"
            )
        return self._retriever.retrieve(query, k=RAG_TOP_K)

    @staticmethod
    def _format_candidates(candidates: List[MetricCandidate]) -> str:
        """Render the retrieved candidates as a compact prompt block."""
        lines = []
        for c in candidates:
            desc = c.description or "(no description)"
            lines.append(f"- `{c.name}` [{c.category}]: {desc}")
        return "\n".join(lines)

    # ------------------------------------------------------------------ #
    # Tool schema construction
    # ------------------------------------------------------------------ #
    def _build_tool_schema(self, allowed_metrics: List[str]) -> Dict[str, Any]:
        """Build a tool schema whose `metrics` enum is scoped to `allowed_metrics`.

        Scoping the enum on every call (instead of caching one schema with all
        metrics) is what makes the model's decision space small and focused.
        """
        if not allowed_metrics:
            raise RuntimeError("No metrics available — cannot build tool schema")

        return {
            "type": "function",
            "function": {
                "name": TOOL_NAME,
                "description": (
                    "Build a structured analytics query plan that the deterministic "
                    "compiler will translate into safe parameterized SQL."
                ),
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["intent_family", "metrics", "visualization_plan"],
                    "properties": {
                        "intent_family": {
                            "type": "string",
                            "enum": INTENT_FAMILIES,
                            "description": "Analytical intent category.",
                        },
                        "metrics": {
                            "type": "array",
                            "items": {"type": "string", "enum": allowed_metrics},
                            "minItems": 1,
                            "maxItems": 1,
                            "description": "Exactly one metric from the retrieved candidates.",
                        },
                        "dimensions": {
                            "type": "array",
                            "items": {"type": "string", "enum": ALLOWED_DIMENSIONS},
                            "description": (
                                "Breakdown dimensions. Use `label` for pipeline stages, "
                                "`firstname` for recruiters, `month` for trends."
                            ),
                        },
                        "filters": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["field", "operator", "value"],
                                "properties": {
                                    "field": {
                                        "type": "string",
                                        "enum": ALLOWED_FILTERS,
                                    },
                                    "operator": {
                                        "type": "string",
                                        "enum": FILTER_OPERATORS,
                                    },
                                    "value": {},  # any
                                },
                            },
                        },
                        "temporal_scope": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "start": {"type": "string", "description": "ISO date"},
                                "end": {"type": "string", "description": "ISO date"},
                                "type": {
                                    "type": "string",
                                    "enum": ["rolling", "fixed", "latest"],
                                },
                            },
                        },
                        "replay_requirements": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "visualization_plan": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["type"],
                            "properties": {
                                "type": {"type": "string", "enum": ALLOWED_CHART_TYPES},
                                "config": {"type": "object"},
                            },
                        },
                        "clarification_requirements": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
        }
