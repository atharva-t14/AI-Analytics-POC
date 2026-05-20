import os
import json
from app.query_engine import QueryEngine

def test_v2():
    engine = QueryEngine()
    
    # Test case 1: Clear query with specific account
    print("--- Test Case 1: Clear Query (Account 1) ---")
    res1 = engine.process("Show hiring pipeline", account_id=1)
    print(json.dumps(res1, indent=2))
    
    # Test case 2: Clear query with another account
    print("\n--- Test Case 2: Clear Query (Account 2) ---")
    res2 = engine.process("Show hiring pipeline", account_id=2)
    # The SQL should have been generated with account_id=2
    # We can't easily see the SQL here without more logging, but we've updated the compiler
    print(f"Confidence: {res2.get('confidence')}")

    # Test case 3: Vague query (Clarification Flow)
    print("\n--- Test Case 3: Vague Query ---")
    res3 = engine.process("analytics", account_id=1)
    print(json.dumps(res3, indent=2))

if __name__ == "__main__":
    test_v2()
