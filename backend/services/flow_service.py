"""
Code Flow & Architecture diagram service.
"""
import ast
import os
import re
from sqlalchemy.orm import Session
from sqlalchemy import text

from clients import groq_client


def extract_calls_from_source(source_code: str) -> dict:
    """Extract {func_name: [called_funcs]} from Python source."""
    call_graph = {}
    try:
        tree = ast.parse(source_code)
    except SyntaxError:
        return call_graph

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            calls = []
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    if isinstance(child.func, ast.Name):
                        calls.append(child.func.id)
                    elif isinstance(child.func, ast.Attribute):
                        calls.append(child.func.attr)
            call_graph[node.name] = list(set(calls))
    return call_graph


def steps_to_mermaid_flowchart(steps: list[dict]) -> str:
    lines = ["flowchart TD"]
    seen_edges: set[str] = set()
    seen_nodes: set[str] = set()

    for step in steps:
        file_short = step["file"].replace(".py", "").replace("-", "_")
        func_id = f"{file_short}__{step['function']}".replace("-", "_")

        if func_id not in seen_nodes:
            seen_nodes.add(func_id)
            lines.append(f'    {func_id}["{step["function"]}()\\n{file_short}"]')

        for call in step["calls"]:
            call_file = file_short
            for s in steps:
                if s["function"] == call:
                    call_file = s["file"].replace(".py", "").replace("-", "_")
                    break
            full_call_id = f"{call_file}__{call}".replace("-", "_")
            edge = f"    {func_id} --> {full_call_id}"
            if edge not in seen_edges:
                seen_edges.add(edge)
                lines.append(edge)

    return "\n".join(lines)


def build_architecture_mermaid(symbols_rows, dependency_rows, max_nodes: int = 60) -> str:
    # Count dependency degree per file to pick the most connected ones
    degree: dict[str, int] = {}
    for row in dependency_rows:
        for path in (row.source, row.target):
            name = path.split("/")[-1]
            degree[name] = degree.get(name, 0) + 1

    # Files present in symbols table
    symbol_files = {row.file_path.split("/")[-1]: row for row in symbols_rows}

    # Select top files by degree, fall back to any symbol file to fill up to max_nodes
    top_by_degree = sorted(symbol_files, key=lambda f: -degree.get(f, 0))
    selected = set(top_by_degree[:max_nodes])

    def safe_id(filename: str) -> str:
        no_ext = re.sub(r"\.[^.]+$", "", filename)
        return re.sub(r"[^a-zA-Z0-9]", "_", no_ext)

    def display_name(filename: str) -> str:
        return re.sub(r"\.[^.]+$", "", filename)

    lines = ["graph LR"]
    seen_edges: set[str] = set()
    id_map: dict[str, str] = {}  # filename → mermaid node id

    for fname in selected:
        row = symbol_files[fname]
        sid = safe_id(fname)
        # Ensure uniqueness if two files collide after sanitisation
        base = sid
        counter = 1
        while sid in id_map.values():
            sid = f"{base}_{counter}"
            counter += 1
        id_map[fname] = sid

        fns = [f["name"] for f in (row.functions or [])[:3]]
        cls = [c["name"] for c in (row.classes or [])[:2]]
        items = fns + cls
        dname = display_name(fname)
        label = "\\n".join(items) if items else dname
        lines.append(f'    {sid}["{dname}\\n─────\\n{label}"]')

    for row in dependency_rows:
        src_name = row.source.split("/")[-1]
        tgt_name = row.target.split("/")[-1]
        if src_name in id_map and tgt_name in id_map and src_name != tgt_name:
            edge = f"    {id_map[src_name]} --> {id_map[tgt_name]}"
            if edge not in seen_edges:
                seen_edges.add(edge)
                lines.append(edge)

    lines.append("    classDef default fill:#111118,stroke:#7fff6e,color:#e8e8f0,font-family:monospace")
    return "\n".join(lines)


async def get_flow(repo_id: str, function_name: str, db: Session) -> dict:
    # ── Try precomputed call_edges first (fast, accurate) ────
    edge_rows = db.execute(text("""
        SELECT caller_id, callee_id FROM call_edges WHERE repo_id = :repo_id
    """), {"repo_id": repo_id}).fetchall()

    if edge_rows:
        adj: dict[str, list[str]] = {}
        all_node_ids: set[str] = set()

        for row in edge_rows:
            adj.setdefault(row.caller_id, []).append(row.callee_id)
            all_node_ids.add(row.caller_id)
            all_node_ids.add(row.callee_id)

        # Find starting node by matching the function name suffix
        start_node = next(
            (nid for nid in all_node_ids if nid.split("::")[-1] == function_name),
            None,
        )

        if start_node:
            visited: set[str] = set()
            steps: list[dict] = []
            queue = [(start_node, 0)]

            while queue:
                node_id, depth = queue.pop(0)
                if node_id in visited or depth > 6:
                    continue
                visited.add(node_id)
                parts = node_id.split("::")
                func_name = parts[-1] if len(parts) >= 3 else node_id
                file_name = parts[1] if len(parts) >= 3 else "unknown"
                callees = adj.get(node_id, [])
                relevant_calls = [c.split("::")[-1] for c in callees if c not in visited]
                steps.append({
                    "function": func_name,
                    "file": file_name,
                    "calls": relevant_calls,
                    "depth": depth,
                })
                for callee_id in callees:
                    if callee_id not in visited:
                        queue.append((callee_id, depth + 1))

            if steps:
                mermaid = steps_to_mermaid_flowchart(steps)
                mermaid = re.sub(r"[^\x00-\x7F]+", "", mermaid)

                steps_text = "\n".join([
                    f"- {s['function']}() in {s['file']}"
                    + (f" calls: {', '.join(s['calls'])}" if s["calls"] else " (leaf function)")
                    for s in steps
                ])
                llm = await groq_client.chat.completions.create(
                    model="llama-3.1-8b-instant",
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a code flow analyst. Explain execution flows in plain English. No markdown, no bullet points, no headers. Just clear paragraphs.",
                        },
                        {
                            "role": "user",
                            "content": f"Explain this execution flow starting from {function_name}() in plain text:\n\n{steps_text}",
                        },
                    ],
                )
                return {
                    "function": function_name,
                    "steps": steps,
                    "mermaid": mermaid,
                    "explanation": llm.choices[0].message.content,
                }

    # ── Fallback: AST re-parse from stored chunks ────────────
    all_chunks = db.execute(text("""
        SELECT file_path, content FROM code_chunks
        WHERE repo_id = :repo_id
        LIMIT 200
    """), {"repo_id": repo_id}).fetchall()

    if not all_chunks:
        return {"error": "No code found. Re-ingest the repo."}

    py_chunks = [c for c in all_chunks if c.file_path.endswith(".py")]

    if not py_chunks:
        code_sample = "\n\n".join([
            f"// {c.file_path.split('/')[-1]}\n{c.content[:500]}"
            for c in all_chunks[:8]
        ])
        llm = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {
                    "role": "system",
                    "content": "You are a code analyst. Trace execution flows and generate Mermaid flowchart diagrams. Return ONLY valid Mermaid flowchart TD syntax, nothing else.",
                },
                {
                    "role": "user",
                    "content": f"Generate a Mermaid flowchart showing the execution flow of the function or feature '{function_name}' based on this code:\n\n{code_sample}\n\nReturn only the mermaid diagram code starting with 'flowchart TD'",
                },
            ],
        )
        mermaid = llm.choices[0].message.content.strip()
        mermaid = re.sub(r"[^\x00-\x7F]+", "", mermaid)
        if not mermaid.startswith("flowchart"):
            mermaid = f'flowchart TD\n    A["{function_name}"] --> B["Could not trace - function not found"]'

        llm2 = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "You are a code analyst. Explain code flows in plain English, no markdown formatting."},
                {"role": "user", "content": f"Explain the execution flow of '{function_name}' in this codebase in plain text:\n\n{code_sample}"},
            ],
        )
        return {
            "function": function_name,
            "steps": [],
            "mermaid": mermaid,
            "explanation": llm2.choices[0].message.content,
        }

    # Python repo without precomputed edges: AST call graph from chunks
    call_graphs: dict[str, dict] = {}
    for chunk in py_chunks:
        file_short = chunk.file_path.split("/")[-1]
        cg = extract_calls_from_source(chunk.content)
        if file_short not in call_graphs:
            call_graphs[file_short] = {}
        call_graphs[file_short].update(cg)

    func_map: dict[str, dict] = {}
    for file_short, cg in call_graphs.items():
        for fn, calls in cg.items():
            func_map[fn] = {"file": file_short, "calls": calls}

    if function_name not in func_map:
        all_fns = list(func_map.keys())[:10]
        return {"error": f"Function '{function_name}' not found. Available functions: {', '.join(all_fns)}"}

    visited: set[str] = set()
    steps: list[dict] = []
    queue = [(function_name, 0)]

    while queue:
        func, depth = queue.pop(0)
        if func in visited or depth > 6:
            continue
        visited.add(func)
        info = func_map.get(func, {"file": "unknown", "calls": []})
        relevant_calls = [c for c in info["calls"] if c in func_map]
        steps.append({
            "function": func,
            "file": info["file"],
            "calls": relevant_calls,
            "depth": depth,
        })
        for called in relevant_calls:
            if called not in visited:
                queue.append((called, depth + 1))

    mermaid = steps_to_mermaid_flowchart(steps)
    mermaid = re.sub(r"[^\x00-\x7F]+", "", mermaid)

    steps_text = "\n".join([
        f"- {s['function']}() in {s['file']}"
        + (f" calls: {', '.join(s['calls'])}" if s["calls"] else " (leaf function)")
        for s in steps
    ])
    llm = await groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {
                "role": "system",
                "content": "You are a code flow analyst. Explain execution flows in plain English. No markdown, no bullet points, no headers. Just clear paragraphs.",
            },
            {
                "role": "user",
                "content": f"Explain this execution flow starting from {function_name}() in plain text:\n\n{steps_text}",
            },
        ],
    )
    return {
        "function": function_name,
        "steps": steps,
        "mermaid": mermaid,
        "explanation": llm.choices[0].message.content,
    }


async def get_architecture(repo_id: str, db: Session) -> dict:
    symbols_rows = db.execute(text("""
        SELECT file_path, functions, classes FROM file_symbols
        WHERE repo_id = :repo_id
    """), {"repo_id": repo_id}).fetchall()

    dependency_rows = db.execute(text("""
        SELECT source, target FROM file_dependencies
        WHERE repo_id = :repo_id
    """), {"repo_id": repo_id}).fetchall()

    all_chunks = db.execute(text("""
        SELECT file_path, content FROM code_chunks
        WHERE repo_id = :repo_id
        LIMIT 20
    """), {"repo_id": repo_id}).fetchall()

    is_python = any(c.file_path.endswith(".py") for c in all_chunks)

    if not symbols_rows and not is_python:
        code_sample = "\n\n".join([
            f"// {c.file_path.split('/')[-1]}\n{c.content[:400]}"
            for c in all_chunks[:10]
        ])

        llm_mermaid = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "Generate a Mermaid graph LR architecture diagram. Return ONLY valid Mermaid syntax starting with 'graph LR', nothing else."},
                {"role": "user", "content": f"Generate a Mermaid architecture diagram for this codebase:\n\n{code_sample}"},
            ],
        )

        llm_explain = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "You are a software architect. Describe architecture in plain English paragraphs. No markdown formatting, no bullet points, no headers. Just clear readable text."},
                {"role": "user", "content": f"Describe the architecture of this codebase in plain text:\n\n{code_sample}"},
            ],
        )

        mermaid = llm_mermaid.choices[0].message.content.strip()
        if not mermaid.startswith("graph"):
            mermaid = "graph LR\n    A[Could not generate diagram]"

        return {
            "mermaid": mermaid,
            "explanation": llm_explain.choices[0].message.content,
        }

    if not symbols_rows:
        return {"error": "No symbols found. Re-ingest the repo."}

    mermaid = build_architecture_mermaid(symbols_rows, dependency_rows, max_nodes=60)
    mermaid = re.sub(r"[^\x00-\x7F]+", "", mermaid)

    # Cap LLM input to top 60 files
    summary_rows = sorted(
        symbols_rows,
        key=lambda r: len(r.functions or []) + len(r.classes or []),
        reverse=True,
    )[:60]
    file_summaries = "\n".join([
        f"{row.file_path.split('/')[-1]}: "
        f"functions={[f['name'] for f in (row.functions or [])[:6]]}, "
        f"classes={[c['name'] for c in (row.classes or [])[:3]]}"
        for row in summary_rows
    ])

    llm = await groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {
                "role": "system",
                "content": "You are a software architect. Describe the architecture in plain English paragraphs. No markdown, no bullet points, no headers, no bold text. Just clear readable paragraphs explaining what each file does and how they connect.",
            },
            {"role": "user", "content": f"Describe the architecture of this codebase in plain text:\n\n{file_summaries}"},
        ],
    )

    return {
        "mermaid": mermaid,
        "explanation": llm.choices[0].message.content,
    }
