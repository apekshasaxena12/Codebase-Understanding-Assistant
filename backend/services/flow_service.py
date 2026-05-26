"""
Code Flow & Architecture diagram service.
"""
import ast
import os
from sqlalchemy.orm import Session
from sqlalchemy import text
from groq import Groq
from dotenv import load_dotenv
import re

load_dotenv()
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))


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
    seen_edges = set()
    seen_nodes = set()

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


def build_architecture_mermaid(symbols_rows, dependency_rows) -> str:
    lines = ["graph LR"]
    seen_edges = set()
    local_files = {}

    for row in symbols_rows:
        file_short = row.file_path.split("/")[-1].replace(".py", "")
        safe_id = file_short.replace("-", "_").replace(".", "_")
        fns = [f["name"] for f in (row.functions or [])[:4]]
        cls = [c["name"] for c in (row.classes or [])[:2]]
        items = fns + cls
        label = "\\n".join(items) if items else file_short
        lines.append(f'    {safe_id}["{file_short}\\n─────\\n{label}"]')
        local_files[file_short] = safe_id

    for row in dependency_rows:
        src = row.source.split("/")[-1].replace(".py", "")
        tgt = row.target.split("/")[-1].replace(".py", "")
        if src in local_files and tgt in local_files and src != tgt:
            edge = f"    {local_files[src]} --> {local_files[tgt]}"
            if edge not in seen_edges:
                seen_edges.add(edge)
                lines.append(edge)

    lines.append("    classDef default fill:#111118,stroke:#7fff6e,color:#e8e8f0,font-family:monospace")
    return "\n".join(lines)


async def get_flow(repo_id: str, function_name: str, db: Session) -> dict:
    # fetch all chunks to build call graph
    all_chunks = db.execute(text("""
        SELECT file_path, content FROM code_chunks
        WHERE repo_id = :repo_id
        LIMIT 200
    """), {"repo_id": repo_id}).fetchall()

    if not all_chunks:
        return {"error": "No code found. Re-ingest the repo."}

    # detect if repo is Python or not
    py_chunks = [c for c in all_chunks if c.file_path.endswith(".py")]

    if not py_chunks:
        # non-Python repo: use LLM to trace flow
        code_sample = "\n\n".join([
            f"// {c.file_path.split('/')[-1]}\n{c.content[:500]}"
            for c in all_chunks[:8]
        ])
        llm = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "You are a code analyst. Trace execution flows and generate Mermaid flowchart diagrams. Return ONLY valid Mermaid flowchart TD syntax, nothing else."},
                {"role": "user", "content": f"Generate a Mermaid flowchart showing the execution flow of the function or feature '{function_name}' based on this code:\n\n{code_sample}\n\nReturn only the mermaid diagram code starting with 'flowchart TD'"}
            ]
        )
        mermaid = llm.choices[0].message.content.strip()
        mermaid = re.sub(r'[^\x00-\x7F]+', '', mermaid)

        if not mermaid.startswith("flowchart"):
            mermaid = "flowchart TD\n    A[\"" + function_name + "\"] --> B[\"Could not trace - function not found\"]"

        llm2 = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "You are a code analyst. Explain code flows in plain English, no markdown formatting."},
                {"role": "user", "content": f"Explain the execution flow of '{function_name}' in this codebase in plain text:\n\n{code_sample}"}
            ]
        )
        return {
            "function": function_name,
            "steps": [],
            "mermaid": mermaid,
            "explanation": llm2.choices[0].message.content,
        }

    # Python repo: AST-based call graph
    call_graphs = {}
    for chunk in py_chunks:
        file_short = chunk.file_path.split("/")[-1]
        cg = extract_calls_from_source(chunk.content)
        if file_short not in call_graphs:
            call_graphs[file_short] = {}
        call_graphs[file_short].update(cg)

    # find entry function
    func_map = {}
    for file_short, cg in call_graphs.items():
        for fn, calls in cg.items():
            func_map[fn] = {"file": file_short, "calls": calls}

    if function_name not in func_map:
        all_fns = list(func_map.keys())[:10]
        return {"error": f"Function '{function_name}' not found. Available functions: {', '.join(all_fns)}"}

    # BFS trace
    visited = set()
    steps = []
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
    mermaid = re.sub(r'[^\x00-\x7F]+', '', mermaid)


    steps_text = "\n".join([
        f"- {s['function']}() in {s['file']}" +
        (f" calls: {', '.join(s['calls'])}" if s['calls'] else " (leaf function)")
        for s in steps
    ])

    llm = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "system", "content": "You are a code flow analyst. Explain execution flows in plain English. No markdown, no bullet points, no headers. Just clear paragraphs."},
            {"role": "user", "content": f"Explain this execution flow starting from {function_name}() in plain text:\n\n{steps_text}"}
        ]
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

    # fetch chunks for non-python repos
    all_chunks = db.execute(text("""
        SELECT file_path, content FROM code_chunks
        WHERE repo_id = :repo_id
        LIMIT 20
    """), {"repo_id": repo_id}).fetchall()

    is_python = any(c.file_path.endswith(".py") for c in all_chunks)

    if not symbols_rows and not is_python:
        # non-python repo: generate architecture from chunks via LLM
        code_sample = "\n\n".join([
            f"// {c.file_path.split('/')[-1]}\n{c.content[:400]}"
            for c in all_chunks[:10]
        ])

        llm_mermaid = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "Generate a Mermaid graph LR architecture diagram. Return ONLY valid Mermaid syntax starting with 'graph LR', nothing else."},
                {"role": "user", "content": f"Generate a Mermaid architecture diagram for this codebase:\n\n{code_sample}"}
            ]
        )

        llm_explain = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": "You are a software architect. Describe architecture in plain English paragraphs. No markdown formatting, no bullet points, no headers. Just clear readable text."},
                {"role": "user", "content": f"Describe the architecture of this codebase in plain text:\n\n{code_sample}"}
            ]
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

    mermaid = build_architecture_mermaid(symbols_rows, dependency_rows)
    mermaid = re.sub(r'[^\x00-\x7F]+', '', mermaid)


    file_summaries = "\n".join([
        f"{row.file_path.split('/')[-1]}: functions={[f['name'] for f in (row.functions or [])]}, classes={[c['name'] for c in (row.classes or [])]}"
        for row in symbols_rows
    ])

    llm = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "system", "content": "You are a software architect. Describe the architecture in plain English paragraphs. No markdown, no bullet points, no headers, no bold text. Just clear readable paragraphs explaining what each file does and how they connect."},
            {"role": "user", "content": f"Describe the architecture of this codebase in plain text:\n\n{file_summaries}"}
        ]
    )

    return {
        "mermaid": mermaid,
        "explanation": llm.choices[0].message.content,
    }