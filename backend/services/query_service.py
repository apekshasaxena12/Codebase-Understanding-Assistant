import os
import re
from dotenv import load_dotenv

load_dotenv()

import httpx
from sqlalchemy.orm import Session
from sqlalchemy import text

from clients import groq_client, JINA_API_URL
from services import flow_service


async def get_embedding(text_input: str) -> list[float]:
    api_key = os.getenv("JINA_API_KEY")
    if not api_key:
        raise Exception("JINA_API_KEY missing")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            JINA_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "jina-embeddings-v3",
                "task": "retrieval.query",
                "input": [text_input],
            },
            timeout=30,
        )

    if response.status_code != 200:
        raise Exception(f"Jina API error: {response.status_code} {response.text}")

    return response.json()["data"][0]["embedding"]


def reciprocal_rank_fusion(vector_results, keyword_results, k=60):
    scores = {}
    for rank, row in enumerate(vector_results):
        key = row.file_path + ":" + str(row.start_line)
        scores[key] = scores.get(key, {"row": row, "score": 0})
        scores[key]["score"] += 1 / (k + rank + 1)
    for rank, row in enumerate(keyword_results):
        key = row.file_path + ":" + str(row.start_line)
        if key not in scores:
            scores[key] = {"row": row, "score": 0}
        scores[key]["score"] += 1 / (k + rank + 1)
    ranked = sorted(scores.values(), key=lambda x: x["score"], reverse=True)
    return [entry["row"] for entry in ranked[:5]]


def get_symbol_context(repo_id: str, file_paths: list[str], db: Session) -> str:
    if not file_paths:
        return ""
    rows = db.execute(text("""
        SELECT file_path, functions, classes, imports, top_level_docstring
        FROM file_symbols
        WHERE repo_id = :repo_id AND file_path = ANY(:paths)
    """), {"repo_id": repo_id, "paths": file_paths}).fetchall()

    if not rows:
        return ""

    parts = ["## File Structure (AST Analysis)\n"]
    for row in rows:
        short_path = row.file_path.split("/")[-1]
        parts.append(f"### {short_path}")
        if row.top_level_docstring:
            parts.append(f"_{row.top_level_docstring}_\n")
        if row.imports:
            parts.append(f"**Imports:** {', '.join(row.imports[:10])}")
        if row.classes:
            for cls in row.classes:
                method_names = [m["name"] for m in cls.get("methods", [])]
                parts.append(f"**Class `{cls['name']}`** (line {cls['line']})")
                if cls.get("docstring"):
                    parts.append(f"  - {cls['docstring']}")
                if method_names:
                    parts.append(f"  - Methods: {', '.join(method_names)}")
        if row.functions:
            for fn in row.functions:
                args = ", ".join(fn.get("args", []))
                parts.append(f"**Function `{fn['name']}({args})`** (line {fn['line']})")
                if fn.get("docstring"):
                    parts.append(f"  - {fn['docstring']}")
        parts.append("")
    return "\n".join(parts)


_SMALLTALK_PATTERNS = [
    r"^(hi+|hey+|hello+|hola|sup|what'?s up|yo+|howdy|greetings|good\s*(morning|afternoon|evening|day))\W*$",
    r"^(thanks?|thank\s*you|ty|thx|thank\s*u|cheers|much\s*appreciated)\W*$",
    r"^(bye+|goodbye+|see\s*ya|see\s*you|cya|later|take\s*care|farewell)\W*$",
    r"^(ok+|okay+|got\s*it|alright|sure|cool|nice|great|awesome|perfect|sounds?\s*good)\W*$",
    r"who\s+are\s+you|what\s+are\s+you|what\s+(can|do)\s+you\s+do|your\s+purpose",
]

_CONVERSATIONAL_SYSTEM = (
    "You are Codebase Assistant, an AI that helps developers understand GitHub repositories. "
    "You can explain architecture, trace function flows, find where logic lives, and answer "
    "questions about any ingested codebase. "
    "When the user sends a greeting, thanks, farewell, or any non-code question, "
    "respond naturally and briefly in a friendly tone. "
    "Do not produce code snippets or file references unless the user asks a code question. "
    "Keep replies concise — 1-3 sentences max."
)


def is_smalltalk(question: str) -> bool:
    q = question.strip().lower()
    return any(re.search(p, q) for p in _SMALLTALK_PATTERNS)


def detect_intent(question: str) -> tuple[str, str | None]:
    q = question.lower()

    arch_patterns = [
        "architecture", "overview diagram", "system diagram",
        "how does the system", "high level", "overall structure", "architecture diagram",
    ]
    if any(p in q for p in arch_patterns):
        return "architecture", None

    flow_patterns = [
        "trace", "flow", "execution", "how does .* work",
        "walk me through", "step by step", "call chain", "how is .* called",
    ]
    for pattern in flow_patterns:
        if re.search(pattern, q):
            fn_match = re.search(r'`([^`]+)`|"([^"]+)"|(\b\w+(?:_\w+)*)\(\)', question)
            if fn_match:
                fn_name = fn_match.group(1) or fn_match.group(2) or fn_match.group(3)
                return "flow", fn_name
            return "flow", None

    return "normal", None


async def answer(repo_id: str, question: str, db: Session) -> dict:
    if is_smalltalk(question):
        llm_response = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": _CONVERSATIONAL_SYSTEM},
                {"role": "user", "content": question},
            ],
        )
        return {"answer": llm_response.choices[0].message.content, "sources": [], "mermaid": None}

    intent, fn_name = detect_intent(question)

    if intent == "architecture":
        result = await flow_service.get_architecture(repo_id, db)
        if "error" in result:
            return {"answer": result["error"], "sources": [], "mermaid": None}
        answer_text = result["explanation"] + "\n\n*Architecture diagram rendered below.*"
        return {"answer": answer_text, "sources": [], "mermaid": result["mermaid"], "diagram_type": "architecture"}

    if intent == "flow" and fn_name:
        result = await flow_service.get_flow(repo_id, fn_name, db)
        if "error" not in result:
            answer_text = result["explanation"] + "\n\n*Flow diagram rendered below.*"
            return {"answer": answer_text, "sources": [], "mermaid": result["mermaid"], "diagram_type": "flow"}

    # ── normal Q&A ────────────────────────────────────────────

    has_embeddings = db.execute(text("""
        SELECT 1 FROM code_chunks
        WHERE repo_id = :repo_id AND embedding IS NOT NULL
        LIMIT 1
    """), {"repo_id": repo_id}).fetchone() is not None

    if has_embeddings:
        question_vector = await get_embedding(question)
        vector_results = db.execute(text(f"""
            SELECT file_path, content, start_line, end_line
            FROM code_chunks
            WHERE repo_id = :repo_id AND embedding IS NOT NULL
            ORDER BY embedding <=> '[{",".join(map(str, question_vector))}]'::vector
            LIMIT 10
        """), {"repo_id": repo_id}).fetchall()
    else:
        vector_results = []

    keyword_results = db.execute(text("""
        SELECT file_path, content, start_line, end_line
        FROM code_chunks
        WHERE repo_id = :repo_id
          AND to_tsvector('english', content) @@ plainto_tsquery('english', :query)
        ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', :query)) DESC
        LIMIT 10
    """), {"repo_id": repo_id, "query": question}).fetchall()

    all_chunks = reciprocal_rank_fusion(vector_results, keyword_results)

    if not all_chunks:
        llm_response = await groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": _CONVERSATIONAL_SYSTEM},
                {"role": "user", "content": question},
            ],
        )
        return {"answer": llm_response.choices[0].message.content, "sources": [], "mermaid": None}

    matched_files = list(set(c.file_path for c in all_chunks))
    symbol_context = get_symbol_context(repo_id, matched_files, db)
    code_context = "\n\n".join([
        f"# {c.file_path} (lines {c.start_line}–{c.end_line})\n{c.content}"
        for c in all_chunks
    ])
    full_context = (
        (symbol_context + "\n---\n\n## Relevant Code Snippets\n\n" + code_context)
        if symbol_context else code_context
    )

    llm_response = await groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful code assistant with deep understanding of code structure. "
                    "You are given both a structural summary of files (classes, functions, imports) "
                    "and the actual relevant code snippets. "
                    "Use both to give precise, accurate answers. "
                    "Always mention which file(s) and function/class names are relevant. "
                    "Format your answer clearly using markdown."
                ),
            },
            {"role": "user", "content": f"Here is the codebase context:\n\n{full_context}\n\nQuestion: {question}"},
        ],
    )

    final_answer = llm_response.choices[0].message.content
    sources = list(set(c.file_path for c in all_chunks))
    return {"answer": final_answer, "sources": sources, "mermaid": None}
