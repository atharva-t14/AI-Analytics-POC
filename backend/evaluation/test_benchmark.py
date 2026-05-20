import pytest
import yaml
import os
from evaluation.scoring_rules import EvaluationScorer

# Load all golden queries
GOLDEN_QUERIES_DIR = "knowledge/golden_queries"
queries = []

if os.path.exists(GOLDEN_QUERIES_DIR):
    for filename in os.listdir(GOLDEN_QUERIES_DIR):
        if filename.endswith(".yaml"):
            with open(os.path.join(GOLDEN_QUERIES_DIR, filename), 'r') as f:
                data = yaml.safe_load(f)
                if data and 'queries' in data:
                    queries.extend(data['queries'])

# This is a mock planner execution function.
# In reality, this would call the intent -> event -> planner pipeline.
def mock_planner_execute(query_text: str):
    # Mocking a correct response for demonstration
    return {
        "intent": "funnel_dropoff" if "losing candidates" in query_text else "recruiter_efficiency",
        "events": ["candidate_stage_changed"],
        "generated_sql": "SELECT * FROM tblassignjobcandidatelog WHERE accountid = 123"
    }

@pytest.mark.parametrize("benchmark", queries, ids=[q['id'] for q in queries])
def test_benchmark_query(benchmark):
    """
    Main Pytest execution for the Golden Query suite.
    """
    print(f"\\nExecuting Benchmark: {benchmark['id']} - '{benchmark['query']}'")
    
    # 1. Execute Planner
    result = mock_planner_execute(benchmark['query'])
    
    # 2. Score Intent
    intent_match = EvaluationScorer.score_intent(benchmark['intent'], result['intent'])
    
    # 3. Score Events
    event_score = EvaluationScorer.score_events(benchmark.get('expected_events', []), result.get('events', []))
    
    # 4. Critical Rules
    is_tenant_isolated = EvaluationScorer.check_tenant_isolation(result.get('generated_sql', ''))
    
    # Assertions
    # Note: In a real run, we might just print metrics rather than fail the whole suite,
    # but Pytest gives us excellent reporting on which specific intents fail.
    
    assert is_tenant_isolated, f"CRITICAL FAILURE: Missing tenant isolation in SQL for {benchmark['id']}"
    
    # We log these for the report
    assert intent_match, f"Failed Intent Resolution. Expected: {benchmark['intent']}, Got: {result['intent']}"
    assert event_score > 0.5, f"Failed Event Mapping. Scored {event_score}"
