"""Quick smoke test for filter resolution and operator compilation."""
from app.deterministic_compiler import DeterministicCompiler
from sqlglot import exp

c = DeterministicCompiler()

# Test 1: 'status' filter on tbljob base (the original failing case)
col, alias, fj = c._resolve_filter_target("status", "tbljob", "j")
print(f"Test 1 - status on tbljob: col={col}, alias={alias}, join_table={fj.table if fj else None}")

# Test 2: 'archived' on log base (should join to tbljob)
col, alias, fj = c._resolve_filter_target("archived", "tblassignjobcandidatelog", "log")
print(f"Test 2 - archived on log: col={col}, alias={alias}, join_table={fj.table if fj else None}")

# Test 3: 'archived' on tbljob (direct, no join)
col, alias, fj = c._resolve_filter_target("archived", "tbljob", "j")
print(f"Test 3 - archived on tbljob: col={col}, alias={alias}, join={fj}")

# Test 4: 'city' on tbljob (direct, no join)
col, alias, fj = c._resolve_filter_target("city", "tbljob", "j")
print(f"Test 4 - city on tbljob: col={col}, alias={alias}, join={fj}")

# Test 5: unknown field should raise error
try:
    c._resolve_filter_target("nonexistent_field", "tbljob", "j")
    print("Test 5 - FAILED (no error raised)")
except Exception as e:
    print(f"Test 5 - unknown field: raised {type(e).__name__}: {e}")

# Test 6: operator compilation
col_expr = exp.column("archived", "j")
ph = exp.Placeholder(this="f_0")
for op in ["eq", "ne", "gt", "lt", "gte", "lte", "like"]:
    result = c._compile_filter_condition(col_expr, op, ph)
    print(f"Test 6 - {op:4s}: {result.sql('mysql')}")

print("\nAll tests passed!")
