"""Regression test for all compilable metrics."""
from app.deterministic_compiler import get_compiler
from app.dsl import AnalyticsDSL, FilterClause, VisualizationPlan

c = get_compiler()
tests = [
    ("stage_conversion_rate", ["label"], [], "funnel"),
    ("funnel_dropoff_rate", ["label"], [], "funnel"),
    ("pipeline_completion_rate", [], [], "bar"),
    ("job_creation_trend", ["month"], [], "line"),
    ("job_volume", [], [], "bar"),
    ("candidate_status_breakdown", ["label"], [FilterClause(field="job_title", operator="eq", value="SDE")], "bar"),
    ("recruiter_submission_rate", ["firstname"], [], "bar"),
    ("recruiter_placement_rate", ["firstname"], [], "bar"),
    ("recruiter_pipeline_load", ["firstname"], [], "bar"),
    ("candidate_list", [], [FilterClause(field="stage", operator="eq", value="Assigned")], "table"),
]

passed = failed = 0
for metric, dims, filters, chart in tests:
    try:
        dsl = AnalyticsDSL(
            intent_family="funnel_analysis", metrics=[metric], dimensions=dims,
            filters=filters, visualization_plan=VisualizationPlan(type=chart), account_id=1,
        )
        result = c.compile(dsl)
        print(f"PASS: {metric}")
        print(f"  {result.sql}")
        passed += 1
    except Exception as e:
        print(f"FAIL: {metric} - {e}")
        failed += 1

print(f"\n{passed} passed, {failed} failed")
