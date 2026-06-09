import ast
import asyncio
import json
import os
import re
import shutil
import tempfile
import uuid

import anyio
import git
import httpx
import networkx as nx
from models.chunk import CodeChunk, FileSymbol, FileDependency, CallEdge
from sqlalchemy.orm import Session
from dotenv import load_dotenv

load_dotenv()

JINA_API_URL = "https://api.jina.ai/v1/embeddings"

MAX_FILE_SIZE   = int(os.getenv("MAX_FILE_BYTES", str(500_000)))   # 500 KB
MAX_FILES       = int(os.getenv("MAX_FILES", "1500"))
EMBED_BATCH     = 100   # embed + store every N chunks to cap memory use
USE_EMBEDDINGS  = os.getenv("USE_EMBEDDINGS", "true").lower() == "true"

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
    ".mli": "ocaml",
}

SKIP_DIRS = {"venv", "__pycache__", "node_modules", ".git", "dist", "build", ".next", "vendor"}


# ── 1. Clone ──────────────────────────────────────────────────

def clone_repo(repo_url: str) -> str:
    temp_dir = tempfile.mkdtemp()
    git.Repo.clone_from(
        repo_url,
        temp_dir,
        depth=1,
        single_branch=True,
        env={"GIT_TERMINAL_PROMPT": "0"},
    )
    return temp_dir


# ── 2. File walker ────────────────────────────────────────────

def _iter_files(temp_dir: str):
    """Yield (full_path, file_type) up to MAX_FILES, skipping oversized files."""
    count = 0
    for root, dirs, files in os.walk(temp_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
        for file in files:
            if count >= MAX_FILES:
                return
            full_path = os.path.join(root, file)
            ext = os.path.splitext(file)[1].lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            try:
                if os.path.getsize(full_path) > MAX_FILE_SIZE:
                    continue
            except OSError:
                continue
            count += 1
            yield full_path, SUPPORTED_EXTENSIONS[ext]


# ── 3a. Chunk .py files ───────────────────────────────────────

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


# ── 3b. Chunk generic files ───────────────────────────────────

def chunk_generic(file_path: str, source_code: str, max_lines: int = 60) -> list[dict]:
    chunks = []
    lines = source_code.split("\n")
    if not lines or not source_code.strip():
        return chunks

    step = max_lines - 10
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


# ── 3c. Chunk .ipynb notebooks ────────────────────────────────

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


# ── 4a. Extract imports / symbols from JS/TS (regex-based) ───

_JS_IMPORT_RE = re.compile(
    r"""from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
    re.MULTILINE,
)
_JS_FN_PATTERNS = [
    re.compile(r'(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[(<]'),
    # Allow optional TypeScript type annotation (`: SomeType`) between name and `=`
    re.compile(r'(?:export\s+)?(?:const|let|var)\s+(\w+)[^=\n]*=\s*(?:async\s*)?\('),
    re.compile(r'(?:export\s+)?(?:const|let|var)\s+(\w+)[^=\n]*=\s*(?:async\s+)?function'),
]
_JS_CLASS_RE = re.compile(r'(?:export\s+)?(?:default\s+)?class\s+(\w+)')


def extract_js_imports(source_code: str) -> list[str]:
    seen: dict[str, None] = {}
    for m in _JS_IMPORT_RE.finditer(source_code):
        path = m.group(1) or m.group(2)
        if path:
            seen[path] = None
    return list(seen)


def extract_js_symbols(file_path: str, source_code: str) -> dict:
    functions: list[dict] = []
    classes: list[dict] = []
    seen_fns: set[str] = set()
    seen_cls: set[str] = set()

    for lineno, line in enumerate(source_code.split("\n"), 1):
        for pat in _JS_FN_PATTERNS:
            m = pat.search(line)
            if m:
                name = m.group(1)
                if name and name not in seen_fns:
                    seen_fns.add(name)
                    functions.append({"name": name, "line": lineno, "docstring": None, "args": []})
                break
        m = _JS_CLASS_RE.search(line)
        if m:
            name = m.group(1)
            if name not in seen_cls:
                seen_cls.add(name)
                classes.append({"name": name, "line": lineno, "docstring": None, "methods": []})

    return {
        "functions": functions,
        "classes": classes,
        "imports": extract_js_imports(source_code),
        "top_level_docstring": None,
    }


# ── 4b. Extract AST symbols (Python only) ────────────────────

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


# ── 5. Embed (parallel async via httpx, with retry) ──────────

MAX_EMBED_CHARS   = int(os.getenv("MAX_EMBED_CHARS", "1500"))
EMBED_BATCH_SIZE  = int(os.getenv("EMBED_BATCH_SIZE", "32"))
EMBED_CONCURRENCY = int(os.getenv("EMBED_CONCURRENCY", "2"))
# Max chunks to embed — chunks beyond this are stored without vectors (keyword-searchable).
# Prevents multi-hour embedding runs on huge repos on Jina free tier.
MAX_EMBED_CHUNKS  = int(os.getenv("MAX_EMBED_CHUNKS", "500"))


async def _embed_single_batch(
    client: httpx.AsyncClient,
    batch: list[str],
    headers: dict,
) -> list[list[float]]:
    payload = {
        "model": "jina-embeddings-v3",
        "task": "retrieval.passage",
        "input": batch,
    }
    for attempt in range(5):
        try:
            response = await client.post(JINA_API_URL, headers=headers, json=payload, timeout=60)
            if response.status_code == 200:
                return [item["embedding"] for item in response.json()["data"]]
            if response.status_code == 429:
                # Respect Retry-After if present, otherwise short exponential backoff
                retry_after = response.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else min(4 * (2 ** attempt), 30)
                await anyio.sleep(wait)
                continue
            if response.status_code in (500, 502, 503, 504) and attempt < 4:
                await anyio.sleep(2 ** attempt)
                continue
            raise Exception(f"Jina API error {response.status_code}: {response.text[:200]}")
        except httpx.TimeoutException:
            if attempt < 4:
                await anyio.sleep(2 ** attempt)
            else:
                raise
    raise Exception("Jina API: max retries exceeded")


async def get_embeddings(texts: list[str]) -> list[list[float]]:
    jina_key = os.getenv("JINA_API_KEY", "").strip()
    if not jina_key:
        raise Exception("JINA_API_KEY is not configured")

    headers = {
        "Authorization": f"Bearer {jina_key}",
        "Content-Type": "application/json",
    }

    batches = [
        [t[:MAX_EMBED_CHARS] for t in texts[i:i + EMBED_BATCH_SIZE]]
        for i in range(0, len(texts), EMBED_BATCH_SIZE)
    ]

    results: list[list[list[float]] | None] = [None] * len(batches)
    sem = asyncio.Semaphore(EMBED_CONCURRENCY)

    async def embed_with_sem(idx: int, batch: list[str], cl: httpx.AsyncClient) -> None:
        async with sem:
            results[idx] = await _embed_single_batch(cl, batch, headers)

    async with httpx.AsyncClient() as client:
        async with anyio.create_task_group() as tg:
            for i, batch in enumerate(batches):
                tg.start_soon(embed_with_sem, i, batch, client)

    all_embeddings: list[list[float]] = []
    for r in results:
        if r:
            all_embeddings.extend(r)
    return all_embeddings


async def embed_chunks(chunks: list[dict]) -> list[dict]:
    texts = [chunk["content"] for chunk in chunks]
    embeddings = await get_embeddings(texts)
    for i, chunk in enumerate(chunks):
        chunk["embedding"] = embeddings[i] if i < len(embeddings) else None
    return chunks


# ── 6a. Store chunks ──────────────────────────────────────────

def store_vectors(chunks: list[dict], repo_id: str, db: Session):
    try:
        for chunk in chunks:
            db.add(CodeChunk(
                repo_id=repo_id,
                file_path=chunk["file_path"],
                content=chunk["content"],
                embedding=chunk.get("embedding"),
                start_line=chunk["start_line"],
                end_line=chunk["end_line"],
            ))
        db.commit()
    except Exception:
        db.rollback()
        raise


# ── 6b. Store AST symbols ─────────────────────────────────────

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
    except Exception:
        db.rollback()
        raise


# ── 6c. Resolve @/ path alias to an actual file ──────────────

def _resolve_alias(rel: str, file_contents: dict, lang: str) -> str | None:
    """Resolve a path-alias-relative path (e.g. from @/components/Foo) to a full path."""
    exts = (".ts", ".tsx", ".js", ".jsx")
    candidates = [rel] + [rel + e for e in exts]
    for fpath in file_contents:
        for c in candidates:
            if fpath.endswith("/" + c) or fpath.endswith(os.sep + c):
                return fpath
        # Also try index file
        for ext in exts:
            if fpath.endswith("/" + rel + "/index" + ext) or fpath.endswith(os.sep + rel + "/index" + ext):
                return fpath
    return None


# ── 7. Build + store dependency graph (Python + JS/TS) ───────

def build_and_store_graph(file_contents: dict, repo_id: str, db: Session, file_languages: dict = None):
    if file_languages is None:
        file_languages = {}

    graph = nx.DiGraph()

    for file_path, content in file_contents.items():
        graph.add_node(file_path)
        lang = file_languages.get(file_path, "python")

        if lang == "python":
            try:
                tree = ast.parse(content)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        graph.add_edge(file_path, alias.name.replace(".", "/") + ".py")
                elif isinstance(node, ast.ImportFrom):
                    if node.module:
                        graph.add_edge(file_path, node.module.replace(".", "/") + ".py")

        elif lang in ("javascript", "typescript"):
            for imp in extract_js_imports(content):
                if imp.startswith("."):
                    source_dir = os.path.dirname(file_path)
                    resolved = os.path.normpath(os.path.join(source_dir, imp))
                    if not os.path.splitext(resolved)[1]:
                        # Try direct extension first, then index file
                        for ext in (".ts", ".tsx", ".js", ".jsx"):
                            if resolved + ext in file_contents:
                                resolved += ext
                                break
                        else:
                            for ext in (".ts", ".tsx", ".js", ".jsx"):
                                index_path = os.path.join(resolved, "index" + ext)
                                if index_path in file_contents:
                                    resolved = index_path
                                    break
                            else:
                                resolved += ".ts" if lang == "typescript" else ".js"
                    graph.add_edge(file_path, resolved)
                elif imp.startswith("@/") or imp.startswith("~/"):
                    # Path alias — search file_contents for a matching suffix
                    rel = imp[2:]
                    target = _resolve_alias(rel, file_contents, lang)
                    graph.add_edge(file_path, target if target else imp)
                else:
                    graph.add_edge(file_path, imp)

    try:
        for source, target in graph.edges():
            db.add(FileDependency(repo_id=repo_id, source=source, target=target))
        db.commit()
    except Exception:
        db.rollback()
        raise

    return graph


# ── 8. Precompute call edges (Python only) ───────────────────

def store_call_edges(file_contents: dict, all_symbols: list[dict], repo_id: str, db: Session):
    # Key: (file_name, func_name) → id, to avoid collisions when multiple files
    # define functions with the same name (e.g. __init__, main, run).
    func_id_map: dict[tuple[str, str], str] = {}
    for sym in all_symbols:
        file_name = sym["file_path"].split("/")[-1]
        for fn in sym.get("functions", []):
            func_id_map[(file_name, fn["name"])] = f"fn::{file_name}::{fn['name']}"

    if not func_id_map:
        return

    seen_edges: set[str] = set()
    try:
        for full_path, source_code in file_contents.items():
            try:
                tree = ast.parse(source_code)
            except SyntaxError:
                continue

            caller_file = full_path.split("/")[-1]
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    caller_id = func_id_map.get((caller_file, node.name))
                    if not caller_id:
                        continue
                    for child in ast.walk(node):
                        if isinstance(child, ast.Call):
                            call_name = None
                            if isinstance(child.func, ast.Name):
                                call_name = child.func.id
                            elif isinstance(child.func, ast.Attribute):
                                call_name = child.func.attr
                            if call_name:
                                # Match callee against any file that defines this function name
                                callee_id = None
                                for (f, fn), fid in func_id_map.items():
                                    if fn == call_name:
                                        callee_id = fid
                                        break
                                if callee_id and caller_id != callee_id:
                                    key = f"{caller_id}→{callee_id}"
                                    if key not in seen_edges:
                                        seen_edges.add(key)
                                        db.add(CallEdge(
                                            repo_id=repo_id,
                                            caller_id=caller_id,
                                            callee_id=callee_id,
                                        ))
        db.commit()
    except Exception:
        db.rollback()
        raise


# ── 9. Orchestrator ───────────────────────────────────────────

async def ingest(
    repo_url: str,
    db: Session,
    repo_id: str = None,
    on_progress=None,
) -> dict:
    if repo_id is None:
        repo_id = str(uuid.uuid4())

    def progress(msg: str):
        if on_progress:
            on_progress(msg)

    # Auto-disable embeddings when the API key is absent so ingestion
    # always completes (falls back to keyword-only search).
    jina_key = os.getenv("JINA_API_KEY", "").strip()
    effective_use_embeddings = USE_EMBEDDINGS and bool(jina_key)
    if USE_EMBEDDINGS and not jina_key:
        progress("JINA_API_KEY not set — using keyword search (no vector embeddings)")

    progress("Cloning repository…")
    temp_dir = await anyio.to_thread.run_sync(clone_repo, repo_url)

    try:
        file_contents: dict[str, str] = {}
        file_languages: dict[str, str] = {}
        all_symbols: list[dict] = []
        file_counts: dict[str, int] = {}
        pending_chunks: list[dict] = []
        total_files = 0
        total_embedded = 0   # tracks how many chunks have been embedded so far

        JS_TS = {"javascript", "typescript"}

        for full_path, file_type in _iter_files(temp_dir):
            total_files += 1
            file_counts[file_type] = file_counts.get(file_type, 0) + 1

            if file_type == "notebook":
                pending_chunks.extend(chunk_notebook(full_path))
            else:
                try:
                    with open(full_path, encoding="utf-8", errors="ignore") as fh:
                        source_code = fh.read()
                except OSError:
                    continue

                if file_type == "python":
                    file_contents[full_path] = source_code
                    file_languages[full_path] = "python"
                    pending_chunks.extend(chunk_python(full_path, source_code))
                    symbols = extract_symbols(full_path, source_code)
                    symbols["file_path"] = full_path
                    all_symbols.append(symbols)

                elif file_type in JS_TS:
                    file_contents[full_path] = source_code
                    file_languages[full_path] = file_type
                    pending_chunks.extend(chunk_generic(full_path, source_code))
                    symbols = extract_js_symbols(full_path, source_code)
                    symbols["file_path"] = full_path
                    all_symbols.append(symbols)

                else:
                    pending_chunks.extend(chunk_generic(full_path, source_code))

            # Flush in batches to keep memory bounded
            if len(pending_chunks) >= EMBED_BATCH:
                embed_this_batch = (
                    effective_use_embeddings and total_embedded < MAX_EMBED_CHUNKS
                )
                if embed_this_batch:
                    progress(f"Embedding… ({total_files} files, {total_embedded + len(pending_chunks)} chunks so far)")
                    pending_chunks = await embed_chunks(pending_chunks)
                    total_embedded += len(pending_chunks)
                else:
                    progress(f"Storing… ({total_files} files processed)")
                store_vectors(pending_chunks, repo_id, db)
                pending_chunks = []

        # Flush remaining chunks
        if pending_chunks:
            embed_this_batch = (
                effective_use_embeddings and total_embedded < MAX_EMBED_CHUNKS
            )
            if embed_this_batch:
                progress(f"Finalizing embeddings… ({total_files} files total)")
                pending_chunks = await embed_chunks(pending_chunks)
            store_vectors(pending_chunks, repo_id, db)

        if all_symbols:
            progress("Storing symbols…")
            store_symbols(all_symbols, repo_id, db)

        if file_contents:
            progress("Building dependency graph…")
            build_and_store_graph(file_contents, repo_id, db, file_languages)

        py_contents = {p: c for p, c in file_contents.items() if file_languages.get(p) == "python"}
        py_symbols  = [s for s in all_symbols if s["file_path"] in py_contents]
        if py_contents and py_symbols:
            progress("Precomputing call edges…")
            store_call_edges(py_contents, py_symbols, repo_id, db)

        return {"repo_id": repo_id, "file_counts": file_counts}

    finally:
        if os.path.isdir(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
