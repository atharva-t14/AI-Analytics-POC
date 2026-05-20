"""Smoke-test the refactored compiler: every indexed metric must compile and
execute against the dev DB without errors."""

import sys
sys.path.insert(0, '.')

from app.deterministic_compiler import get_compiler
from app.executor import QueryExecutor
from app.dsl import AnalyticsDSL, VisualizationPlan
from app.retrieval import MetricRetriever

compiler = get_compiler()
executor = QueryExecutor()
retriever = MetricRetriever(compiler)

DIMENSIONS_PER_METRIC = {
    'recruiter_submission_rate': ['firstname'],
    'recruiter_placement_rate': ['firstname'],
    'recruiter_pipeline_load': ['firstname'],
    'stage_conversion_rate': ['label'],
    'funnel_dropoff_rate': ['label'],
    'pipeline_completion_rate': ['firstname'],
    'job_volume': ['firstname'],
    'job_creation_trend': ['month'],
    'candidate_status_breakdown': ['label'],
}

ok, fail = 0, 0
for name in retriever.all_names():
    dims = DIMENSIONS_PER_METRIC.get(name, ['label'])
    dsl = AnalyticsDSL(
        intent_family='ranking',
        metrics=[name],
        dimensions=dims,
        account_id=1,
        visualization_plan=VisualizationPlan(type='bar'),
    )
    try:
        compiled = compiler.compile(dsl)
        result = executor.execute(compiled)
        rows = result.rows
        print(f'OK   {name:35s} dims={dims}  rows={len(rows)}  sample={rows[:2]}')
        ok += 1
    except Exception as e:
        print(f'FAIL {name:35s} dims={dims}  err={e}')
        fail += 1

print(f'\n{ok} passed, {fail} failed')
