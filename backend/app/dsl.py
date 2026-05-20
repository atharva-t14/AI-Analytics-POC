"""
Analytics DSL — The deterministic intermediate representation.

This is the contract between the AI Planner and the Deterministic SQL Compiler.
It strictly adheres to the planner_dsl_schema.yaml specification.
"""

from __future__ import annotations

from typing import Any, List, Optional
from pydantic import BaseModel, Field


class FilterClause(BaseModel):
    """A single filter condition."""
    field: str
    operator: str = "eq"
    value: Any = None


class TemporalScope(BaseModel):
    """Temporal window for analysis."""
    start: Optional[str] = None
    end: Optional[str] = None
    type: str = "rolling" # rolling, fixed, latest


class VisualizationPlan(BaseModel):
    """Recommended visualization from the planner."""
    type: str
    config: Optional[dict] = Field(default_factory=dict)


class AnalyticsDSL(BaseModel):
    """The deterministic execution plan DSL.
    
    This is what the AI Planner must return. It is then compiled
    into SQL by the DeterministicCompiler.
    """
    intent_family: str
    metrics: List[str]
    dimensions: List[str] = Field(default_factory=list)
    filters: List[FilterClause] = Field(default_factory=list)
    temporal_scope: TemporalScope = Field(default_factory=TemporalScope)
    replay_requirements: List[str] = Field(default_factory=list)
    visualization_plan: VisualizationPlan
    
    # Metadata for observability and safety
    clarification_requirements: List[str] = Field(default_factory=list)
    validation_requirements: List[str] = Field(default_factory=list)
    execution_dependencies: List[str] = Field(default_factory=list)
    account_id: Optional[int] = None # Injected by runtime

class DSLValidationError(Exception):
    """Raised when a DSL object fails validation against the grounded knowledge."""
    pass
