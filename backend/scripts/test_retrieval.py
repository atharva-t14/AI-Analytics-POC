"""Test which prompts match candidate_status_breakdown via RAG retriever."""
from app.deterministic_compiler import get_compiler
from app.retrieval import MetricRetriever

c = get_compiler()
r = MetricRetriever(c)

queries = [
    "Candidates in each stage for SDE",
    "candidate status breakdown for a job",
    "how many candidates in each pipeline stage",
    "show pipeline for SDE job",
    "stage wise candidate count for SDE",
    "where are candidates stuck for SDE",
    "funnel for Software Engineer role",
]

for q in queries:
    results = r.retrieve(q, k=3)
    top = results[0]
    hit = "YES" if top.name == "candidate_status_breakdown" else "NO"
    print(f'Query: "{q}"')
    print(f"  Top match: {top.name} (score: {top.score:.1f})")
    print(f"  Correct metric? {hit}")
    if hit == "NO":
        # Check if it's in top 3 at all
        names = [r.name for r in results]
        if "candidate_status_breakdown" in names:
            idx = names.index("candidate_status_breakdown")
            print(f"  (candidate_status_breakdown is #{idx+1} with score {results[idx].score:.1f})")
        else:
            print(f"  (candidate_status_breakdown NOT in top 3)")
    print()
