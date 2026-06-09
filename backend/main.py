from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text
from routers import ingest, query
from dotenv import load_dotenv
from auth import require_api_key
from rate_limit import limiter
import logging
import os

load_dotenv()

log_level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(level=log_level)

from database import engine, Base
import models.chunk

Base.metadata.create_all(bind=engine)


def _migrate_embedding_dim():
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT atttypmod FROM pg_attribute "
                "JOIN pg_class ON attrelid = pg_class.oid "
                "WHERE relname = 'code_chunks' AND attname = 'embedding'"
            )
        ).fetchone()
        if row is None or row[0] == 1024:
            return
        logging.info("Migrating embedding column from old dim to 1024 — truncating stale chunks")
        conn.execute(text("TRUNCATE TABLE code_chunks"))
        conn.execute(text("DROP INDEX IF EXISTS ix_code_chunks_embedding_hnsw"))
        conn.execute(text(
            "ALTER TABLE code_chunks ALTER COLUMN embedding TYPE vector(1024)"
        ))
        conn.execute(text(
            "CREATE INDEX ix_code_chunks_embedding_hnsw ON code_chunks "
            "USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)"
        ))
        conn.commit()
        logging.info("Embedding column migration complete")


_migrate_embedding_dim()

app = FastAPI(title="Codebase Understanding Assistant")

# Rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

allowed_origins = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://localhost:3001",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest.router, prefix="/api", dependencies=[Depends(require_api_key)])
app.include_router(query.router, prefix="/api", dependencies=[Depends(require_api_key)])


@app.get("/health")
def health():
    return {"status": "ok"}
