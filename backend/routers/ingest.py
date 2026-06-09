import re
import uuid

from cachetools import TTLCache
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import text

from database import SessionLocal
from rate_limit import limiter
from services import flow_service, ingestion_service

router = APIRouter()

# In-process job store — 30-minute TTL, max 500 jobs
_jobs: TTLCache = TTLCache(maxsize=500, ttl=1800)

_GITHUB_RE = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+(\.git)?/?$"
)


class RepoRequest(BaseModel):
    repo_url: str

    @field_validator("repo_url")
    @classmethod
    def validate_github_url(cls, v: str) -> str:
        v = v.strip()
        if not _GITHUB_RE.match(v):
            raise ValueError(
                "repo_url must be a valid https://github.com/<owner>/<repo> URL"
            )
        return v


class FlowRequest(BaseModel):
    function_name: str


# ── Ingest ────────────────────────────────────────────────────

@router.post("/ingest")
@limiter.limit("20/hour")
async def ingest_repo(
    request: Request,
    body: RepoRequest,
    background_tasks: BackgroundTasks,
):
    job_id  = str(uuid.uuid4())
    repo_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "queued", "repo_id": repo_id, "progress": "Queued…"}
    background_tasks.add_task(_run_ingest_bg, job_id, repo_id, body.repo_url)
    return {"job_id": job_id, "repo_id": repo_id}


async def _run_ingest_bg(job_id: str, repo_id: str, repo_url: str):
    _jobs[job_id]["status"] = "running"

    def on_progress(msg: str):
        if job_id in _jobs:
            _jobs[job_id]["progress"] = msg

    db = SessionLocal()
    try:
        await ingestion_service.ingest(repo_url, db, repo_id=repo_id, on_progress=on_progress)
        _jobs[job_id] = {"status": "done", "repo_id": repo_id, "progress": "Complete"}
    except Exception as e:
        _jobs[job_id] = {"status": "error", "repo_id": repo_id, "error": str(e)}
    finally:
        db.close()


@router.get("/ingest/status/{job_id}")
def get_ingest_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="Job not found — server may have restarted or job expired. Please re-ingest.",
        )
    return job


# ── Dependency Graph ──────────────────────────────────────────

@router.get("/graph/{repo_id}")
def get_graph(repo_id: str):
    db = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT source, target FROM file_dependencies
            WHERE repo_id = :repo_id
        """), {"repo_id": repo_id}).fetchall()
    finally:
        db.close()

    def short(path):
        return path.split("/")[-1]

    nodes = set()
    edges = []
    for row in rows:
        src, tgt = short(row.source), short(row.target)
        nodes.add(src)
        nodes.add(tgt)
        edges.append({"source": src, "target": tgt})

    return {"nodes": [{"id": n} for n in nodes], "edges": edges}


# ── Knowledge Graph ───────────────────────────────────────────

@router.get("/knowledge-graph/{repo_id}")
def get_knowledge_graph(repo_id: str):
    db = SessionLocal()
    try:
        symbol_rows = db.execute(text("""
            SELECT file_path, functions, classes FROM file_symbols
            WHERE repo_id = :repo_id
        """), {"repo_id": repo_id}).fetchall()

        nodes: list[dict] = []
        edges: list[dict] = []
        seen_nodes: set[str] = set()

        def add_node(node_id, label, node_type, **kwargs):
            if node_id not in seen_nodes:
                seen_nodes.add(node_id)
                nodes.append({"id": node_id, "label": label, "type": node_type, **kwargs})

        for row in symbol_rows:
            file_name = row.file_path.split("/")[-1]
            file_id = f"file::{file_name}"
            add_node(file_id, file_name, "file", file=file_name)

            for fn in (row.functions or []):
                fn_id = f"fn::{file_name}::{fn['name']}"
                add_node(fn_id, fn["name"], "function",
                         file=file_name, line=fn.get("line"),
                         docstring=fn.get("docstring"), args=fn.get("args", []))
                edges.append({"source": file_id, "target": fn_id, "type": "contains"})

            for cls in (row.classes or []):
                cls_id = f"cls::{file_name}::{cls['name']}"
                add_node(cls_id, cls["name"], "class",
                         file=file_name, line=cls.get("line"),
                         docstring=cls.get("docstring"), methods=cls.get("methods", []))
                edges.append({"source": file_id, "target": cls_id, "type": "contains"})

        call_edge_rows = db.execute(text("""
            SELECT caller_id, callee_id FROM call_edges
            WHERE repo_id = :repo_id
        """), {"repo_id": repo_id}).fetchall()

        for row in call_edge_rows:
            edges.append({"source": row.caller_id, "target": row.callee_id, "type": "calls"})

        if not symbol_rows:
            chunk_files = db.execute(text("""
                SELECT DISTINCT file_path FROM code_chunks
                WHERE repo_id = :repo_id
            """), {"repo_id": repo_id}).fetchall()

            if not chunk_files:
                return {"error": "No data found. Re-ingest the repo."}

            for row in chunk_files:
                file_name = row.file_path.split("/")[-1]
                file_id = f"file::{file_name}"
                add_node(file_id, file_name, "file", file=file_name)

        seen_edges: set[str] = set()
        deduped: list[dict] = []
        for e in edges:
            key = f"{e['source']}→{e['target']}"
            if key not in seen_edges:
                seen_edges.add(key)
                deduped.append(e)

        return {"nodes": nodes, "edges": deduped}
    finally:
        db.close()


# ── Flow / Architecture ───────────────────────────────────────

@router.post("/flow/{repo_id}")
async def get_flow(repo_id: str, request: FlowRequest):
    try:
        db = SessionLocal()
        try:
            result = await flow_service.get_flow(repo_id, request.function_name, db)
        finally:
            db.close()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/architecture/{repo_id}")
async def get_architecture(repo_id: str):
    try:
        db = SessionLocal()
        try:
            result = await flow_service.get_architecture(repo_id, db)
        finally:
            db.close()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Debug ─────────────────────────────────────────────────────

@router.get("/debug")
def debug_db():
    db = SessionLocal()
    try:
        rows = db.execute(text(
            "SELECT repo_id, COUNT(*) as cnt FROM code_chunks GROUP BY repo_id"
        )).fetchall()
    finally:
        db.close()
    return [{"repo_id": str(r.repo_id), "count": r.cnt} for r in rows]


@router.get("/debug-symbols")
def debug_symbols():
    db = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT repo_id, file_path, json_array_length(functions::json) as fn_count
            FROM file_symbols
        """)).fetchall()
    finally:
        db.close()
    return [
        {"repo_id": str(r.repo_id), "file": r.file_path.split("/")[-1], "functions": r.fn_count}
        for r in rows
    ]
