from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from database import get_db
from sqlalchemy.orm import Session
from sqlalchemy import text
from services import ingestion_service
from services import flow_service

router = APIRouter()


class RepoRequest(BaseModel):
    repo_url: str


class FlowRequest(BaseModel):
    function_name: str


@router.post("/ingest")
async def ingest_repo(request: RepoRequest, db: Session = Depends(get_db)):
    try:
        result = await ingestion_service.ingest(request.repo_url, db)
        return {"status": "success", "repo_id": result["repo_id"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/graph/{repo_id}")
def get_graph(repo_id: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT source, target FROM file_dependencies
        WHERE repo_id = :repo_id
    """), {"repo_id": repo_id}).fetchall()

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

@router.post("/flow/{repo_id}")
async def get_flow(repo_id: str, request: FlowRequest, db: Session = Depends(get_db)):
    try:
        result = await flow_service.get_flow(repo_id, request.function_name, db)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/architecture/{repo_id}")
async def get_architecture(repo_id: str, db: Session = Depends(get_db)):
    try:
        result = await flow_service.get_architecture(repo_id, db)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debug")
def debug_db(db: Session = Depends(get_db)):
    rows = db.execute(text("SELECT repo_id, COUNT(*) as cnt FROM code_chunks GROUP BY repo_id")).fetchall()
    return [{"repo_id": str(r.repo_id), "count": r.cnt} for r in rows]


@router.get("/debug-symbols")
def debug_symbols(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT repo_id, file_path, json_array_length(functions::json) as fn_count
        FROM file_symbols
    """)).fetchall()
    return [{"repo_id": str(r.repo_id), "file": r.file_path.split("/")[-1], "functions": r.fn_count} for r in rows]


# Add this to routers/ingest.py

@router.get("/knowledge-graph/{repo_id}")
def get_knowledge_graph(repo_id: str, db: Session = Depends(get_db)):
    """
    Returns nodes and edges for the interactive knowledge graph.
    Nodes: files, classes, functions
    Edges: file-contains-class, file-contains-function, function-calls-function
    """
    # fetch symbols
    symbol_rows = db.execute(text("""
        SELECT file_path, functions, classes FROM file_symbols
        WHERE repo_id = :repo_id
    """), {"repo_id": repo_id}).fetchall()

    # fetch chunks for call graph (Python repos)
    chunk_rows = db.execute(text("""
        SELECT file_path, content FROM code_chunks
        WHERE repo_id = :repo_id AND file_path LIKE '%.py'
        LIMIT 100
    """), {"repo_id": repo_id}).fetchall()

    nodes = []
    edges = []
    seen_nodes = set()

    def add_node(node_id, label, node_type, **kwargs):
        if node_id not in seen_nodes:
            seen_nodes.add(node_id)
            nodes.append({"id": node_id, "label": label, "type": node_type, **kwargs})

    # build nodes from symbols
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

    # build call edges from chunk content
    import ast as _ast
    func_id_map = {n["label"]: n["id"] for n in nodes if n["type"] == "function"}

    for chunk in chunk_rows:
        file_name = chunk.file_path.split("/")[-1]
        try:
            tree = _ast.parse(chunk.content)
        except SyntaxError:
            continue
        for node in _ast.walk(tree):
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                caller_id = func_id_map.get(node.name)
                if not caller_id:
                    continue
                for child in _ast.walk(node):
                    if isinstance(child, _ast.Call):
                        call_name = None
                        if isinstance(child.func, _ast.Name):
                            call_name = child.func.id
                        elif isinstance(child.func, _ast.Attribute):
                            call_name = child.func.attr
                        if call_name and call_name in func_id_map:
                            callee_id = func_id_map[call_name]
                            if caller_id != callee_id:
                                edges.append({"source": caller_id, "target": callee_id, "type": "calls"})

    # for non-Python repos: just show file nodes with chunk-based connections
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

    # deduplicate edges
    seen_edges = set()
    deduped = []
    for e in edges:
        key = f"{e['source']}→{e['target']}"
        if key not in seen_edges:
            seen_edges.add(key)
            deduped.append(e)

    return {"nodes": nodes, "edges": deduped}