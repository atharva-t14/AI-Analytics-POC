import os
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

def check_connection():
    # Load environment variables
    load_dotenv()
    
    database_url = os.getenv("DATABASE_URL")
    
    if not database_url:
        print("❌ Error: DATABASE_URL not found in environment variables.")
        return

    print(f"Attempting to connect to database...")
    
    try:
        # Create engine
        engine = create_engine(database_url)
        
        # Try to connect and execute a simple read-only query
        with engine.connect() as connection:
            result = connection.execute(text("SELECT 1"))
            val = result.scalar()
            if val == 1:
                print("SUCCESS: Connection successful! Database is reachable and responding.")
            else:
                print(f"WARNING: Connection established, but unexpected result from 'SELECT 1': {val}")
                
    except Exception as e:
        print(f"FAILURE: Connection failed: {str(e)}")

if __name__ == "__main__":
    check_connection()
