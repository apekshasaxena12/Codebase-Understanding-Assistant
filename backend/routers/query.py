from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from database import get_db
from services import query_service

router = APIRouter()

class QueryRequest(BaseModel):
    repo_id: str
    question: str

@router.post("/query")
async def query_repo(request: QueryRequest, db: Session = Depends(get_db)):
    try:
        result = await query_service.answer(request.repo_id, request.question, db)
        return {"answer": result["answer"], "sources": result["sources"]}
    except Exception as e:
        import traceback
        traceback.print_exc()  # ← add this line
        raise HTTPException(status_code=500, detail=str(e))