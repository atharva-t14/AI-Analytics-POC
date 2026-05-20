from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv
import os
import urllib.parse

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_recycle=3600,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine)