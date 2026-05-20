from pydantic import BaseModel
from typing import Optional

class QueryRequest(BaseModel):
    message: str
    account_id: int
    session_id: Optional[str] = None