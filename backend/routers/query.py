from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from rate_limit import limiter
from services import query_service

router = APIRouter()


class QueryRequest(BaseModel):
    repo_id: str
    question: str


@router.post("/query")
@limiter.limit("30/minute")
async def query_repo(request: Request, body: QueryRequest, db: Session = Depends(get_db)):
    try:
        result = await query_service.answer(body.repo_id, body.question, db)
        return {
            "answer": result["answer"],
            "sources": result["sources"],
            "mermaid": result.get("mermaid"),
            "diagram_type": result.get("diagram_type"),
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
