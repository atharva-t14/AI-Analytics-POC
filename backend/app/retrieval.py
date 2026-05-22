"""
Metric retriever — selects the K most relevant metrics for a user question.

Used by the LLM engine to dynamically scope the tool-schema `metrics` enum,
shrinking the model's decision space from "all metrics" to "the few most
likely candidates", with their descriptions injected into the prompt.

Default implementation is lexical (rapidfuzz). The interface is intentionally
small so it can be swapped for an embedding-based retriever (e.g. sentence-
transformers + cosine similarity) without touching `llm_engine.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import List

from rapidfuzz import fuzz

logger = logging.getLogger(__name__)

# Knowledge-base files that live under knowledge/metrics/ but contain
# meta-configuration rather than metric definitions.
_META_FILES = {"metric_validation_rules", "metric_dependency_graph"}


def _is_compilable(defn: dict) -> bool:
    """A metric is executable iff it declares a `numerator_sql` fragment.

    `numerator` (the abstract form with virtual columns like `is_active` or
    `reached_stage_seq`) is documentation only; the compiler refuses to
    execute it. Surfacing non-compilable metrics to the LLM would let it
    pick something the compiler emits as broken SQL.
    """
    return isinstance(defn.get("numerator_sql"), str) and bool(defn["numerator_sql"].strip())


@dataclass(frozen=True)
class MetricCandidate:
    name: str
    score: float
    description: str
    category: str


class MetricRetriever:
    """Lightweight lexical retriever over the metric knowledge base."""

    def __init__(self, compiler) -> None:
        self._entries: List[tuple[str, str, str, str]] = self._build_index(compiler)
        logger.info(
            "[RAG] Metric retriever ready | indexed_executable_metrics=%s | metrics=%s",
            len(self._entries),
            [name for name, _, _, _ in self._entries],
        )

    @staticmethod
    def _build_index(compiler) -> List[tuple[str, str, str, str]]:
        """Flatten the compiler's loaded knowledge base into a searchable index.

        Each entry is (name, search_text, description, category).
        """
        entries: List[tuple[str, str, str, str]] = []
        for filename, content in compiler.metrics.items():
            if filename in _META_FILES or not isinstance(content, dict):
                continue
            category = filename.replace("_metrics", "")
            for name, defn in content.items():
                if not isinstance(defn, dict):
                    continue
                if not _is_compilable(defn):
                    # Skip metrics the deterministic compiler can't execute
                    # (threshold-based, references, event-based, etc.).
                    continue
                description = str(defn.get("business_meaning", "")).strip()
                # Build the search corpus: humanised name + description + category.
                # Replacing underscores helps lexical matching of phrases like
                # "stage conversion" against `stage_conversion_rate`.
                search_text = f"{name.replace('_', ' ')} {description} {category}"
                entries.append((name, search_text, description, category))
        return entries

    def all_names(self) -> List[str]:
        return [name for name, _, _, _ in self._entries]

    # Weighting: matches on the metric *name* are far more discriminating than
    # matches on the description (descriptions share lots of vocabulary like
    # "candidates", "recruiter", "rate"). Tuned empirically.
    _NAME_WEIGHT = 0.7
    _DESC_WEIGHT = 0.3
    # Noise floor for the combined token-set score. Below this, retrieval is
    # essentially random and we fall back to the full catalogue.
    _NOISE_FLOOR = 25.0

    def retrieve(self, query: str, k: int = 5) -> List[MetricCandidate]:
        """Return the top-K metrics ranked by lexical similarity to `query`.

        Scoring uses `token_set_ratio` (better at "needle in document" matching
        than `WRatio`, which over-weights overall string-length similarity).
        Name and description are scored separately and combined so that a
        keyword hit on the metric name dominates incidental word overlap in
        the description.
        """
        logger.info(
            "[RAG] Retrieval started | query=%r | top_k=%s | searchable_metrics=%s",
            query,
            k,
            [name for name, _, _, _ in self._entries],
        )
        if not query or not self._entries:
            logger.info(
                "[RAG] Empty query or empty metric index; falling back to all executable metrics"
            )
            return self._fallback_all()

        q = query.lower()
        scored: List[MetricCandidate] = []
        scoring_debug = []
        for (name, _text, desc, category) in self._entries:
            humanised_name = name.replace("_", " ").lower()
            name_score = fuzz.token_set_ratio(q, humanised_name)
            desc_score = fuzz.token_set_ratio(q, desc.lower()) if desc else 0.0
            combined = self._NAME_WEIGHT * name_score + self._DESC_WEIGHT * desc_score
            scoring_debug.append({
                "metric": name,
                "name_score": round(float(name_score), 2),
                "description_score": round(float(desc_score), 2),
                "combined_score": round(float(combined), 2),
            })
            scored.append(
                MetricCandidate(
                    name=name,
                    score=float(combined),
                    description=desc,
                    category=category,
                )
            )
        scored.sort(key=lambda c: c.score, reverse=True)
        scoring_debug.sort(key=lambda item: item["combined_score"], reverse=True)
        logger.info("[RAG] Metric scoring completed | scores=%s", scoring_debug)

        top = [c for c in scored[:k] if c.score >= self._NOISE_FLOOR]
        if not top:
            logger.info(
                "[RAG] No metric met noise floor | noise_floor=%s | action=fallback_all",
                self._NOISE_FLOOR,
            )
            return self._fallback_all()
        logger.info(
            "[RAG] Retrieval selected candidate metrics | selected=%s",
            [
                {
                    "name": c.name,
                    "score": round(c.score, 2),
                    "category": c.category,
                }
                for c in top
            ],
        )
        return top

    def _fallback_all(self) -> List[MetricCandidate]:
        fallback = [
            MetricCandidate(name=name, score=0.0, description=desc, category=cat)
            for (name, _, desc, cat) in self._entries
        ]
        logger.info(
            "[RAG] Returning all executable metrics as fallback | metrics=%s",
            [c.name for c in fallback],
        )
        return fallback
