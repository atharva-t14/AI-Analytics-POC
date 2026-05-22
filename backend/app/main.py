import logging
from logging.handlers import TimedRotatingFileHandler
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.schemas import QueryRequest
from app.query_engine import QueryEngine

# Configure logging
log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
if not os.path.exists(log_dir):
    os.makedirs(log_dir)

log_file = os.path.join(log_dir, "analytics.log")
file_handler = TimedRotatingFileHandler(
    log_file,
    when="midnight",
    interval=1,
    backupCount=30,
    encoding="utf-8",
)
file_handler.suffix = "%Y-%m-%d"
console_handler = logging.StreamHandler()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[file_handler, console_handler]
)

app = FastAPI(title="AI Analytics POC")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize query engine at startup
engine = QueryEngine()


@app.get("/")
def health_check():
    return {
        "status": "ok",
        "llm_available": engine.llm is not None,
        "metrics_count": (
            len(engine.llm._retriever.all_names())
            if engine.llm and engine.llm._retriever
            else 0
        ),
    }


@app.post("/query")
def query(data: QueryRequest):
    return engine.process(data.message, data.account_id, data.session_id)


@app.get("/metrics")
def list_metrics():
    """List all available metrics for the frontend sidebar."""
    return engine.get_metrics_summary()
