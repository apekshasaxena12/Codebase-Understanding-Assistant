# codebase.ai

> Understand any GitHub repository instantly through natural language, interactive graphs, and AI-powered code analysis.

![codebase.ai](https://img.shields.io/badge/status-active-brightgreen) ![Python](https://img.shields.io/badge/python-3.11-blue) ![React](https://img.shields.io/badge/react-18-61dafb) ![FastAPI](https://img.shields.io/badge/fastapi-latest-009688) ![pgvector](https://img.shields.io/badge/pgvector-PostgreSQL-336791)

---

## What it does

Paste any public GitHub URL and instantly get:

- **Natural language Q&A** — ask anything about the codebase and get precise answers with file references
- **Hybrid search** — combines vector similarity search + keyword search for accurate retrieval
- **AST-based code understanding** — extracts functions, classes, imports, and docstrings from Python files
- **Knowledge Graph** — interactive graph of all symbols (files, classes, functions) with click-to-inspect and ask-about-node
- **Dependency Graph** — visualizes which files import which, with hover tooltips and PNG export
- **Architecture Diagram** — auto-generated Mermaid diagram showing file structure and relationships
- **Code Flow Tracer** — traces execution flow from any function with a visual flowchart
- **Export** — download graphs as PNG/SVG, export chat as .txt or .csv

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, D3.js, Mermaid.js |
| Backend | FastAPI, Python 3.11 |
| Database | PostgreSQL + pgvector |
| Embeddings | `all-MiniLM-L6-v2` (sentence-transformers, runs locally) |
| LLM | Llama 3.1 8B via Groq API |
| Ingestion | GitPython, AST parsing |

---

## Supported Languages

Python, JavaScript, TypeScript, Java, Go, Ruby, Rust, C, C++, C#, PHP, Swift, Kotlin, OCaml, Jupyter Notebooks, Markdown

> AST-based symbol extraction (functions, classes, imports) is Python-only. All other languages use semantic chunking for search.

---

## Local Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- PostgreSQL with pgvector extension
- Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Clone the repo

```bash
git clone https://github.com/your-username/codebase-assistant.git
cd codebase-assistant
```

### 2. Backend setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env`:

```env
GROQ_API_KEY=your_groq_api_key_here
DATABASE_URL=postgresql://your_user@/codebase_assistant?host=/tmp
```

### 3. Database setup

```bash
# Start PostgreSQL
brew services start postgresql@17  # macOS

# Create database and enable pgvector
createdb codebase_assistant
psql codebase_assistant -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 4. Run the backend

```bash
cd backend
source venv/bin/activate
python -m uvicorn main:app --reload
```

Backend runs at `http://localhost:8000`

### 5. Frontend setup

```bash
cd frontend
npm install
npm start
```

Frontend runs at `http://localhost:3000`

---

## How it works

```
GitHub URL
    │
    ▼
Clone repo (shallow, depth=1)
    │
    ▼
Walk files → chunk by language
    │         ├── Python: AST function-level chunks
    │         ├── Other: 60-line overlapping blocks
    │         └── Notebooks: cell-by-cell
    ▼
Embed chunks (all-MiniLM-L6-v2, local)
    │
    ▼
Store in PostgreSQL + pgvector
    │         ├── code_chunks (embeddings)
    │         ├── file_symbols (AST metadata)
    │         └── file_dependencies (import graph)
    ▼
Query: Hybrid search (vector + BM25 keyword + RRF fusion)
    │
    ▼
LLM answer (Llama 3.1 8B via Groq)
```

---

## Deployment

### Free tier deployment

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| [Neon](https://neon.tech) | PostgreSQL + pgvector | 0.5GB, free forever |
| [Render](https://render.com) | FastAPI backend | 512MB RAM, spins down after inactivity |
| [Vercel](https://vercel.com) | React frontend | Free forever |

### Steps

1. **Neon** — create a project, enable pgvector:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Render** — connect GitHub repo, set root to `backend`
   - Build: `pip install -r requirements.txt`
   - Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - Env vars: `DATABASE_URL`, `GROQ_API_KEY`

3. **Vercel** — connect GitHub repo, set root to `frontend`
   - Env var: `REACT_APP_API_URL=https://your-app.onrender.com/api`

---

## Project Structure

```
codebase-assistant/
├── backend/
│   ├── models/
│   │   └── chunk.py          # SQLAlchemy models (CodeChunk, FileSymbol, FileDependency)
│   ├── routers/
│   │   ├── ingest.py         # /api/ingest, /api/graph, /api/flow, /api/architecture
│   │   └── query.py          # /api/query
│   ├── services/
│   │   ├── ingestion_service.py  # Clone, chunk, embed, store
│   │   ├── query_service.py      # Hybrid search + LLM answer
│   │   └── flow_service.py       # Architecture + flow diagrams
│   ├── database.py           # SQLAlchemy engine + session
│   ├── main.py               # FastAPI app
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── App.jsx            # Main app + chat UI
│       ├── GraphPanel.jsx     # Dependency graph (D3)
│       ├── KnowledgeGraph.jsx # Knowledge graph (D3)
│       └── DiagramPanel.jsx   # Architecture + flow (Mermaid + D3)
├── docker-compose.yml
└── README.md
```

---

## Features in detail

### Hybrid Retrieval
Combines vector search (semantic similarity) and PostgreSQL full-text search (keyword matching), merged using Reciprocal Rank Fusion (RRF). This means exact function name searches and conceptual questions both work well.

### Knowledge Graph
Interactive force-directed graph showing files, classes, and functions as nodes with call relationships as edges. Click any node to see its docstring, arguments, methods, and ask questions about it specifically.

### Dependency Graph
Shows which files import which other files. Nodes are color-coded: green for your files, teal for stdlib, grey for external libraries. Node size scales with number of connections.

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GROQ_API_KEY` | Groq API key for LLM inference | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |

---

## License

MIT