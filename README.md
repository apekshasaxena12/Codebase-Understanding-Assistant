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
- **Background ingestion** — ingest runs asynchronously with live status polling so the UI stays responsive
- **Dark / Light theme** — toggle between themes, preference is persisted
- **Mobile-friendly** — fully responsive layout with touch support
- **Export** — download graphs as PNG/SVG, export chat as .txt or .csv

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, D3.js, Mermaid.js |
| Backend | FastAPI, Python 3.11 |
| Database | PostgreSQL + pgvector |
| Embeddings | Jina AI API (`jina-embeddings-v3`) |
| LLM | Llama 3.1 8B via Groq API |
| Ingestion | GitPython, AST parsing |
| Rate limiting | slowapi |

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
- Jina AI API key (free at [jina.ai](https://jina.ai))

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

Copy `.env.example` and fill in your keys:

```bash
cp .env.example .env
```

Minimum required values in `backend/.env`:

```env
DATABASE_URL=postgresql://localhost/codebase_assistant
GROQ_API_KEY=your_groq_api_key_here
JINA_API_KEY=your_jina_api_key_here
ALLOWED_ORIGINS=http://localhost:3000
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
```

Copy `.env.example`:

```bash
cp frontend/.env.example frontend/.env
```

```bash
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
Embed chunks (Jina AI API, batched + concurrent)
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

Ingestion runs in the background — the frontend polls `/api/ingest/status` until complete so large repos don't block the UI.

---

## Deployment

### One-click deploy (Render + Vercel + Neon)

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| [Neon](https://neon.tech) | PostgreSQL + pgvector | 0.5 GB, free forever |
| [Render](https://render.com) | FastAPI backend | 512 MB RAM, spins down after inactivity |
| [Vercel](https://vercel.com) | React frontend | Free forever |

### Steps

1. **Neon** — create a project, enable pgvector:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Render** — the repo includes `render.yaml` for one-click deploy.
   Connect your GitHub repo on Render and it will auto-configure the web service and database.
   Add these env vars manually in the Render dashboard:
   - `JINA_API_KEY`
   - `GROQ_API_KEY`
   - `ALLOWED_ORIGINS` → your Vercel URL, e.g. `https://your-app.vercel.app`
   - `API_KEY` → optional secret to require `X-API-Key` header on all `/api/*` requests

3. **Vercel** — connect GitHub repo, set root to `frontend`
   - Env var: `REACT_APP_API_URL=https://your-app.onrender.com`

---

## Project Structure

```
codebase-assistant/
├── backend/
│   ├── models/
│   │   └── chunk.py              # SQLAlchemy models (CodeChunk, FileSymbol, FileDependency)
│   ├── routers/
│   │   ├── ingest.py             # /api/ingest, /api/graph, /api/flow, /api/architecture
│   │   └── query.py              # /api/query
│   ├── services/
│   │   ├── ingestion_service.py  # Clone, chunk, embed (Jina), store
│   │   ├── query_service.py      # Hybrid search + LLM answer
│   │   └── flow_service.py       # Architecture + flow diagrams
│   ├── auth.py                   # Optional X-API-Key guard
│   ├── clients.py                # Shared Groq + Jina client instances
│   ├── rate_limit.py             # slowapi limiter setup
│   ├── database.py               # SQLAlchemy engine + session
│   ├── main.py                   # FastAPI app
│   ├── .env.example              # Environment variable template
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── App.jsx               # Main app + chat UI + dark/light theme
│       ├── GraphPanel.jsx        # Dependency graph (D3)
│       ├── KnowledgeGraph.jsx    # Knowledge graph (D3)
│       └── DiagramPanel.jsx      # Architecture + flow (Mermaid + D3)
├── render.yaml                   # Render one-click deploy config
└── README.md
```

---

## Features in detail

### Hybrid Retrieval
Combines vector search (semantic similarity via Jina embeddings) and PostgreSQL full-text search (keyword matching), merged using Reciprocal Rank Fusion (RRF). Exact function name searches and conceptual questions both work well.

### Knowledge Graph
Interactive force-directed graph showing files, classes, and functions as nodes with call relationships as edges. Click any node to see its docstring, arguments, methods, and ask questions about it specifically.

### Dependency Graph
Shows which files import which other files. Nodes are color-coded: green for your files, teal for stdlib, grey for external libraries. Node size scales with number of connections.

### Rate Limiting
Backend uses `slowapi` to rate-limit ingestion and query endpoints, preventing abuse on public deployments.

### Optional API Key Auth
Set the `API_KEY` env var to require an `X-API-Key` header on all `/api/*` requests. Leave it unset to allow open access (e.g. during local development).

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `GROQ_API_KEY` | Groq API key for LLM inference | Yes |
| `JINA_API_KEY` | Jina AI API key for embeddings | Yes |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins | Yes |
| `API_KEY` | Secret for `X-API-Key` header guard (leave blank to disable) | No |
| `LOG_LEVEL` | Logging verbosity: `DEBUG`, `INFO`, `WARNING`, `ERROR` (default: `INFO`) | No |
| `MAX_FILES` | Max files to ingest per repo (default: `1000`) | No |
| `MAX_FILE_BYTES` | Max file size in bytes (default: `500000`) | No |
| `USE_EMBEDDINGS` | Set to `false` to skip Jina and use full-text search only (default: `true`) | No |
| `MAX_EMBED_CHARS` | Characters per chunk sent to Jina (default: `1500`) | No |
| `EMBED_BATCH_SIZE` | Chunks per Jina API call (default: `32`) | No |
| `EMBED_CONCURRENCY` | Parallel Jina API calls (default: `3`) | No |

---

## License

MIT
