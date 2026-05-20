import os
import yaml
import time
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

TARGET_TABLES = [
    'tblcandidate', 'tbljob', 'tblassignjobcandidate', 'tbldeals',
    'tblcandidatestatus', 'tbljobstatus', 'tbldealpipelinestages', 'tbluser'
]

SCHEMA_REALITY_DIR = 'backend/knowledge/schema_reality'
DIRS = ['tables', 'relationships', 'temporal_patterns', 'distributions', 'column_roles']

def setup_dirs():
    for d in DIRS:
        os.makedirs(os.path.join(SCHEMA_REALITY_DIR, d), exist_ok=True)

def extract_schema(engine):
    with engine.connect() as conn:
        for table in TARGET_TABLES:
            print(f"Extracting metadata for {table}...", flush=True)
            
            # 1. Columns
            columns_query = text("""
                SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table
            """)
            result = conn.execute(columns_query, {"table": table})
            
            table_meta = {
                "table_name": table,
                "columns": []
            }
            
            columns = []
            for row in result:
                col = {
                    "name": row[0],
                    "type": row[1],
                    "is_nullable": row[2] == 'YES',
                    "key": row[3],
                    "extra": row[4]
                }
                columns.append(col)
                table_meta["columns"].append(col)
                
            with open(os.path.join(SCHEMA_REALITY_DIR, 'tables', f'{table}.yaml'), 'w') as f:
                yaml.dump(table_meta, f, sort_keys=False)

            # 2. Relationships (Foreign Keys)
            fk_query = text("""
                SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = DATABASE() 
                  AND TABLE_NAME = :table 
                  AND REFERENCED_TABLE_NAME IS NOT NULL
            """)
            fk_result = conn.execute(fk_query, {"table": table})
            relationships = []
            for row in fk_result:
                relationships.append({
                    "column": row[0],
                    "references_table": row[1],
                    "references_column": row[2]
                })
                
            if relationships:
                with open(os.path.join(SCHEMA_REALITY_DIR, 'relationships', f'{table}.yaml'), 'w') as f:
                    yaml.dump({"table": table, "foreign_keys": relationships}, f, sort_keys=False)

            # 3. Distributions & Semantics (Safe Profiling)
            distributions = []
            temporal = []
            roles = []
            
            for col in columns:
                col_name = col['name']
                col_type = col['type'].lower()
                
                # Check cardinality safely
                # Using approximate row count limit or sampling if supported, but COUNT(DISTINCT) is fast if indexed.
                # To be completely safe on massive tables, we'll just check if it's an FK or low card.
                is_fk = any(fk['column'] == col_name for fk in relationships)
                
                try:
                    # Let's get min/max/distinct safely (TIMEOUT 5s)
                    # We'll use a subquery with LIMIT to get a sample for free text, 
                    # but for INTs we can usually do MIN/MAX quickly.
                    if 'int' in col_type or 'time' in col_type or 'date' in col_type:
                        stat_q = text(f"SELECT MIN({col_name}), MAX({col_name}), COUNT(DISTINCT {col_name}) FROM (SELECT {col_name} FROM {table} WHERE {col_name} IS NOT NULL LIMIT 1000) sub")
                        stat_res = conn.execute(stat_q).fetchone()
                        min_val, max_val, distinct_val = stat_res
                        
                        # Temporal Unix Int check
                        # 946684800 = Jan 1 2000, 2145916800 = Jan 1 2038
                        is_unix_ts = ('int' in col_type and min_val and max_val and 
                                      isinstance(min_val, (int, float)) and isinstance(max_val, (int, float)) and
                                      946684800 < min_val < 2145916800 and 946684800 < max_val < 2145916800)
                        
                        if is_unix_ts or 'time' in col_type or 'date' in col_type:
                            temporal.append({
                                "column": col_name,
                                "type": col_type,
                                "inferred_behavior": "unix_timestamp" if is_unix_ts else "native_datetime",
                                "min_observed": min_val,
                                "max_observed": max_val
                            })
                            roles.append({"column": col_name, "role": "temporal_event"})
                        elif is_fk:
                            roles.append({"column": col_name, "role": "relationship_pointer"})
                        elif col['key'] == 'PRI':
                            roles.append({"column": col_name, "role": "identifier"})
                        else:
                            if distinct_val and distinct_val < 50:
                                roles.append({"column": col_name, "role": "categorical"})
                            else:
                                roles.append({"column": col_name, "role": "monetary_metric" if 'decimal' in col_type or 'float' in col_type else "numeric_value"})
                                
                    elif 'char' in col_type or 'text' in col_type:
                        # Check distinct in sample
                        stat_q = text(f"SELECT COUNT(DISTINCT {col_name}) FROM (SELECT {col_name} FROM {table} WHERE {col_name} IS NOT NULL AND {col_name} != '' LIMIT 1000) sub")
                        distinct_val = conn.execute(stat_q).scalar()
                        
                        if distinct_val and distinct_val < 50:
                            # Safe to profile exact distribution
                            dist_q = text(f"SELECT {col_name}, COUNT(*) as freq FROM {table} WHERE {col_name} IS NOT NULL GROUP BY {col_name} ORDER BY freq DESC LIMIT 50")
                            dist_res = conn.execute(dist_q)
                            dist_vals = [{"value": r[0], "frequency": r[1]} for r in dist_res]
                            
                            distributions.append({
                                "column": col_name,
                                "total_distinct_in_sample": distinct_val,
                                "top_values": dist_vals
                            })
                            roles.append({"column": col_name, "role": "categorical_or_lifecycle_state"})
                        else:
                            roles.append({"column": col_name, "role": "free_text"})
                            
                except Exception as e:
                    print(f"Error profiling {table}.{col_name}: {e}", flush=True)
                    
            if temporal:
                with open(os.path.join(SCHEMA_REALITY_DIR, 'temporal_patterns', f'{table}.yaml'), 'w') as f:
                    yaml.dump({"table": table, "temporal_columns": temporal}, f, sort_keys=False)
                    
            if distributions:
                with open(os.path.join(SCHEMA_REALITY_DIR, 'distributions', f'{table}.yaml'), 'w') as f:
                    yaml.dump({"table": table, "distributions": distributions}, f, sort_keys=False)
                    
            if roles:
                with open(os.path.join(SCHEMA_REALITY_DIR, 'column_roles', f'{table}.yaml'), 'w') as f:
                    yaml.dump({"table": table, "roles": roles}, f, sort_keys=False)

def main():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set", flush=True)
        return
        
    print("Connecting to DB...", flush=True)
    engine = create_engine(database_url, pool_recycle=3600)
    setup_dirs()
    extract_schema(engine)
    print("Schema Reality Extraction Complete.", flush=True)

if __name__ == "__main__":
    main()
