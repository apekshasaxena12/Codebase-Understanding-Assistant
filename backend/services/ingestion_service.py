import ast
import json
import os
import tempfile
import uuid

import git
import networkx as nx
from models.chunk import CodeChunk, FileSymbol, FileDependency
from sqlalchemy.orm import Session
from dotenv import load_dotenv

load_dotenv()

import requests

HF_API_URL = "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2"

def get_embeddings(texts: list[str]) -> list[list[float]]:
    headers = {"Authorization": f"Bearer {os.getenv('HF_TOKEN')}"}
    response = requests.post(HF_API_URL, headers=headers, json={"inputs": texts, "options": {"wait_for_model": True}})
    return response.json()

# supported file extensions and their types
SUPPORTED_EXTENSIONS = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rb": "ruby",
    ".rs": "rust",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "csharp",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".md": "markdown",
    ".ipynb": "notebook",
    ".ml": "ocaml",
    ".mli": "ocaml"
}

SKIP_DIRS = {"venv", "__pycache__", "node_modules", ".git", "dist", "build", ".next", "vendor"}


# ── 1. Clone ──────────────────────────────────────────────────

def clone_repo(repo_url: str) -> str:
    temp_dir = tempfile.mkdtemp()
    git.Repo.clone_from(repo_url, temp_dir, depth=1)
    return temp_dir


# ── 2a. Chunk .py files ───────────────────────────────────────

def chunk_python(file_path: str, source_code: str) -> list[dict]:
    chunks = []
    try:
        tree = ast.parse(source_code)
    except SyntaxError:
        return chunk_generic(file_path, source_code)

    lines = source_code.split("\n")
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            content = "\n".join(lines[node.lineno - 1:node.end_lineno])
            chunks.append({
                "file_path": file_path,
                "content": content,
                "start_line": node.lineno,
                "end_line": node.end_lineno,
            })

    if not chunks and source_code.strip():
        chunks.append({
            "file_path": file_path,
            "content": source_code,
            "start_line": 1,
            "end_line": len(source_code.split("\n")),
        })
    return chunks


# ── 2b. Chunk generic files by splitting into blocks ──────────

def chunk_generic(file_path: str, source_code: str, max_lines: int = 60) -> list[dict]:
    """Split any text file into overlapping chunks of max_lines."""
    chunks = []
    lines = source_code.split("\n")
    if not lines or not source_code.strip():
        return chunks

    step = max_lines - 10  # 10 line overlap
    for i in range(0, len(lines), step):
        block = lines[i:i + max_lines]
        content = "\n".join(block).strip()
        if content:
            chunks.append({
                "file_path": file_path,
                "content": content,
                "start_line": i + 1,
                "end_line": min(i + max_lines, len(lines)),
            })
    return chunks


# ── 2c. Chunk .ipynb notebooks ────────────────────────────────

def chunk_notebook(file_path: str) -> list[dict]:
    chunks = []
    try:
        with open(file_path, encoding="utf-8", errors="ignore") as f:
            nb = json.load(f)
    except (json.JSONDecodeError, OSError):
        return chunks

    for i, cell in enumerate(nb.get("cells", [])):
        if cell.get("cell_type") == "code":
            content = "".join(cell.get("source", []))
            if content.strip():
                chunks.append({
                    "file_path": file_path,
                    "content": content,
                    "start_line": i,
                    "end_line": i,
                })
    return chunks


# ── 2d. Extract AST symbols (Python only) ────────────────────

def extract_symbols(file_path: str, source_code: str) -> dict:
    try:
        tree = ast.parse(source_code)
    except SyntaxError:
        return {"functions": [], "classes": [], "imports": [], "top_level_docstring": None}

    functions = []
    classes = []
    imports = []
    top_level_docstring = ast.get_docstring(tree)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module)

    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append({
                "name": node.name,
                "line": node.lineno,
                "docstring": ast.get_docstring(node),
                "args": [arg.arg for arg in node.args.args],
            })
        elif isinstance(node, ast.ClassDef):
            methods = []
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append({
                        "name": child.name,
                        "line": child.lineno,
                        "docstring": ast.get_docstring(child),
                        "args": [arg.arg for arg in child.args.args],
                    })
            classes.append({
                "name": node.name,
                "line": node.lineno,
                "docstring": ast.get_docstring(node),
                "methods": methods,
            })

    return {
        "functions": functions,
        "classes": classes,
        "imports": list(set(imports)),
        "top_level_docstring": top_level_docstring,
    }


# ── 3. Embed ──────────────────────────────────────────────────

def embed_chunks(chunks: list[dict]) -> list[dict]:
    texts = [chunk["content"] for chunk in chunks]
    embeddings = get_embeddings(texts)
    for i, chunk in enumerate(chunks):
        chunk["embedding"] = embeddings[i]
    return chunks


# ── 4a. Store chunks ──────────────────────────────────────────

def store_vectors(chunks: list[dict], repo_id: str, db: Session):
    try:
        for chunk in chunks:
            db.add(CodeChunk(
                repo_id=repo_id,
                file_path=chunk["file_path"],
                content=chunk["content"],
                embedding=chunk["embedding"],
                start_line=chunk["start_line"],
                end_line=chunk["end_line"],
            ))
        db.commit()
        print(f"DEBUG store_vectors: committed {len(chunks)} chunks")
    except Exception as e:
        db.rollback()
        print(f"DEBUG store_vectors ERROR: {e}")
        raise


# ── 4b. Store AST symbols ─────────────────────────────────────

def store_symbols(file_symbols: list[dict], repo_id: str, db: Session):
    try:
        for sym in file_symbols:
            db.add(FileSymbol(
                repo_id=repo_id,
                file_path=sym["file_path"],
                functions=sym["functions"],
                classes=sym["classes"],
                imports=sym["imports"],
                top_level_docstring=sym["top_level_docstring"],
            ))
        db.commit()
        print(f"DEBUG store_symbols: committed {len(file_symbols)} symbols")
    except Exception as e:
        db.rollback()
        print(f"DEBUG store_symbols ERROR: {e}")
        raise


# ── 5. Build + store dependency graph (Python only) ──────────

def build_and_store_graph(file_contents: dict, repo_id: str, db: Session):
    graph = nx.DiGraph()

    for file_path, content in file_contents.items():
        graph.add_node(file_path)
        try:
            tree = ast.parse(content)
        except SyntaxError:
            continue

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = alias.name.replace(".", "/") + ".py"
                    graph.add_edge(file_path, target)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    target = node.module.replace(".", "/") + ".py"
                    graph.add_edge(file_path, target)

    try:
        for source, target in graph.edges():
            db.add(FileDependency(repo_id=repo_id, source=source, target=target))
        db.commit()
        print(f"DEBUG graph: stored {graph.number_of_edges()} edges")
    except Exception as e:
        db.rollback()
        print(f"DEBUG graph ERROR: {e}")
        raise

    return graph


# ── 6. Orchestrator ───────────────────────────────────────────

async def ingest(repo_url: str, db: Session) -> dict:
    repo_id = str(uuid.uuid4())
    temp_dir = clone_repo(repo_url)

    file_contents = {}  # python files only, for graph
    all_chunks = []
    all_symbols = []
    file_counts = {}

    for root, dirs, files in os.walk(temp_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
        for file in files:
            full_path = os.path.join(root, file)
            ext = os.path.splitext(file)[1].lower()

            if ext not in SUPPORTED_EXTENSIONS:
                continue

            file_type = SUPPORTED_EXTENSIONS[ext]
            file_counts[file_type] = file_counts.get(file_type, 0) + 1
            
            if sum(file_counts.values()) > 500:
                print(f"DEBUG ingest: file cap reached, stopping walk")
                break

            if file_type == "notebook":
                all_chunks.extend(chunk_notebook(full_path))
                continue

            try:
                source_code = open(full_path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue

            if file_type == "python":
                file_contents[full_path] = source_code
                all_chunks.extend(chunk_python(full_path, source_code))
                symbols = extract_symbols(full_path, source_code)
                symbols["file_path"] = full_path
                all_symbols.append(symbols)
            else:
                # all other languages: generic chunking
                all_chunks.extend(chunk_generic(full_path, source_code))

    print(f"DEBUG ingest: {len(all_chunks)} chunks, {len(all_symbols)} py symbols, file types: {file_counts}")

    if all_chunks:
        all_chunks = embed_chunks(all_chunks)
        store_vectors(all_chunks, repo_id, db)

    if all_symbols:
        store_symbols(all_symbols, repo_id, db)

    if file_contents:
        build_and_store_graph(file_contents, repo_id, db)

    return {"repo_id": repo_id, "file_counts": file_counts}