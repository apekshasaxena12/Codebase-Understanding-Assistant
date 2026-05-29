import GraphPanel from "./GraphPanel";
import ReactMarkdown from 'react-markdown';
import { useState, useEffect, useRef } from "react";
import DiagramPanel from "./DiagramPanel";
import KnowledgeGraph from "./KnowledgeGraph";


const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

// ── design tokens (inline so no build step needed) ────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       #0a0a0f;
    --surface:  #111118;
    --border:   #1e1e2e;
    --accent:   #7fff6e;
    --accent2:  #4ef0c0;
    --muted:    #44445a;
    --text:     #e8e8f0;
    --text-dim: #888899;
    --danger:   #ff6b6b;
    --radius:   6px;
    --mono:     'JetBrains Mono', monospace;
    --sans:     'Syne', sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    min-height: 100vh;
  }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 2px; }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }
`;

// ── Header ────────────────────────────────────────────────────

function Header() {
  return (
    <header style={{
      borderBottom: "1px solid var(--border)",
      padding: "20px 32px",
      display: "flex",
      alignItems: "center",
      gap: 12,
      position: "sticky",
      top: 0,
      background: "rgba(10,10,15,0.92)",
      backdropFilter: "blur(12px)",
      zIndex: 100,
    }}>
      <div style={{
        width: 32, height: 32,
        background: "var(--accent)",
        borderRadius: 4,
        display: "grid",
        placeItems: "center",
      }}>
        <span style={{ fontSize: 16 }}>⌥</span>
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em" }}>codebase.ai</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)", marginTop: 1 }}>
          understand any repo instantly
        </div>
      </div>
    </header>
  );
}

// ── IngestPanel ───────────────────────────────────────────────

function IngestPanel({ onIngested }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle");
  const [repoId, setRepoId] = useState(null);

  async function handleIngest() {
    if (!url.trim()) return;
    setStatus("loading");
    try {
      const res = await fetch(`${API}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setRepoId(data.repo_id);
      setStatus("done");
      onIngested(data.repo_id, url);
    } catch (e) {
      setStatus("error");
    }
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 640, margin: "64px auto 0", padding: "0 24px" }}>
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 48px)", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.1 }}>
          Ask anything about<br />
          <span style={{ color: "var(--accent)" }}>any codebase.</span>
        </h1>
        <p style={{ marginTop: 16, color: "var(--text-dim)", fontSize: 15, fontFamily: "var(--mono)", lineHeight: 1.6 }}>
          Paste a GitHub URL → ask natural language questions → get precise answers with file references.
        </p>
      </div>

      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 24 }}>
        <label style={{ display: "block", fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-dim)", marginBottom: 8, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          GitHub Repository URL
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleIngest()}
            placeholder="https://github.com/owner/repo"
            style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 14px", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 13, outline: "none", transition: "border-color 0.2s" }}
            onFocus={e => e.target.style.borderColor = "var(--accent)"}
            onBlur={e => e.target.style.borderColor = "var(--border)"}
          />
          <button
            onClick={handleIngest}
            disabled={status === "loading"}
            style={{ background: status === "loading" ? "var(--muted)" : "var(--accent)", color: "#0a0a0f", border: "none", borderRadius: "var(--radius)", padding: "10px 20px", fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, cursor: status === "loading" ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
          >
            {status === "loading" ? "Ingesting…" : "Ingest →"}
          </button>
        </div>
        {status === "error" && (
          <p style={{ marginTop: 10, color: "var(--danger)", fontSize: 12, fontFamily: "var(--mono)" }}>
            ✗ Failed to ingest repo. Check the URL and try again.
          </p>
        )}
        {status === "done" && (
          <p style={{ marginTop: 10, color: "var(--accent)", fontSize: 12, fontFamily: "var(--mono)" }}>
            ✓ Repo ingested — repo_id: {repoId}
          </p>
        )}
      </div>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)", marginBottom: 12, letterSpacing: "0.08em" }}>
          EXAMPLE QUESTIONS YOU CAN ASK
        </div>
        {[
          "Explain the overall architecture",
          "Where is authentication handled?",
          "Which functions touch the database?",
          "How does the request lifecycle work?",
        ].map(q => (
          <div key={q} style={{ padding: "8px 12px", marginBottom: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: 13, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>
            "{q}"
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MermaidBlock ──────────────────────────────────────────────

function MermaidBlock({ code }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    import("mermaid").then(m => {
      m.default.initialize({ startOnLoad: false, theme: "dark", themeVariables: { fontFamily: "JetBrains Mono, monospace" } });
      const id = `mermaid-${Date.now()}`;
      m.default.render(id, code).then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg;
      }).catch(() => {
        if (ref.current) ref.current.innerHTML = `<pre style="color:#4ef0c0;font-size:11px;overflow:auto">${code}</pre>`;
      });
    });
  }, [code]);
  return (
    <div ref={ref} style={{
      marginTop: 12,
      background: "#0a0a0f",
      border: "1px solid #1e1e2e",
      borderRadius: 6,
      padding: 16,
      overflow: "auto",
    }} />
  );
}

// ── QueryPanel ────────────────────────────────────────────────

function QueryPanel({ repoId, repoUrl, onShowGraph, onShowDiagram, onShowKnowledgeGraph }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  async function handleQuery() {
    if (!question.trim() || loading) return;
    const q = question;
    setQuestion("");
    setMessages(prev => [...prev, { role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await fetch(`${API}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_id: repoId, question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setMessages(prev => [...prev, {
        role: "assistant",
        text: data.answer,
        sources: data.sources,
        mermaid: data.mermaid || null,
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: "Something went wrong. Please try again.", error: true }]);
    } finally {
      setLoading(false);
    }
  }

  function exportTxt() {
    const lines = messages.map(m => {
      const role = m.role === "user" ? "You" : "Assistant";
      const sources = m.sources?.length ? `\nSources: ${m.sources.join(", ")}` : "";
      return `[${role}]\n${m.text}${sources}`;
    });
    const blob = new Blob([lines.join("\n\n---\n\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${repoUrl.split("/").pop()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const header = "role,message,sources";
    const rows = messages.map(m => {
      const role = m.role;
      const message = `"${m.text.replace(/"/g, '""')}"`;
      const sources = `"${(m.sources || []).join("; ")}"`;
      return `${role},${message},${sources}`;
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${repoUrl.split("/").pop()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const btnStyle = {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "6px 12px",
    color: "var(--text-dim)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    transition: "border-color 0.2s, color 0.2s",
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 24px", display: "flex", flexDirection: "column", height: "calc(100vh - 73px)", animation: "fadeUp 0.4s ease both" }}>

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "blink 2s infinite" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onShowGraph} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent2)"; e.currentTarget.style.color = "var(--accent2)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
            View Graph
          </button>
          <button onClick={() => onShowDiagram("architecture")} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
            Architecture
          </button>
          <button onClick={onShowKnowledgeGraph} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
            Knowledge Graph
          </button>
          {messages.length > 0 && (
            <>
              <button onClick={exportTxt} style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
                Export .txt
              </button>
              <button onClick={exportCsv} style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
                Export .csv
              </button>
            </>
          )}
        </div>
      </div>

      {/* messages */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20, paddingBottom: 16 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 13, marginTop: 40, textAlign: "center" }}>
            Ask anything about this codebase ↓
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ animation: "fadeUp 0.3s ease both", alignSelf: msg.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
            <div style={{
              background: msg.role === "user" ? "var(--accent)" : "var(--surface)",
              color: msg.role === "user" ? "#0a0a0f" : "var(--text)",
              border: msg.role === "assistant" ? "1px solid var(--border)" : "none",
              borderRadius: "var(--radius)",
              padding: "12px 16px",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: msg.role === "user" ? "var(--sans)" : "var(--mono)",
              fontWeight: msg.role === "user" ? 600 : 400,
            }}>
              <ReactMarkdown>{msg.text}</ReactMarkdown>
              {msg.mermaid && <MermaidBlock code={msg.mermaid} />}
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {msg.sources.map((src, j) => (
                  <span key={j} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "3px 8px", fontSize: 11, fontFamily: "var(--mono)", color: "var(--accent2)" }}>
                    {src}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: "flex-start", display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 13 }}>
            <div style={{ width: 14, height: 14, border: "2px solid var(--muted)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            Searching codebase…
          </div>
        )}
      </div>

      {/* input */}
      <div style={{ display: "flex", gap: 10, padding: "16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleQuery()}
          placeholder="Ask anything, or try: trace the flow of fetch_comments()"
          style={{ flex: 1, background: "transparent", border: "none", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 14, outline: "none" }}
        />
        <button onClick={handleQuery} disabled={loading}
          style={{ background: "var(--accent)", color: "#0a0a0f", border: "none", borderRadius: "var(--radius)", padding: "8px 16px", fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.5 : 1 }}>
          Ask →
        </button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────

export default function App() {
  const [repoId, setRepoId] = useState(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [showGraph, setShowGraph] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [diagramMode, setDiagramMode] = useState("architecture");
  const [showKnowledgeGraph, setShowKnowledgeGraph] = useState(false);


  return (
    <>
      <style>{css}</style>
      <Header />
      {!repoId
        ? <IngestPanel onIngested={(id, url) => { setRepoId(id); setRepoUrl(url); }} />
        : <QueryPanel
            repoId={repoId}
            repoUrl={repoUrl}
            onShowGraph={() => setShowGraph(true)}
            onShowDiagram={(mode) => { setDiagramMode(mode); setShowDiagram(true); }}
            onShowKnowledgeGraph={() => setShowKnowledgeGraph(true)}

          />
      }
      {showGraph && <GraphPanel repoId={repoId} repoUrl={repoUrl} onClose={() => setShowGraph(false)} />}
      {showDiagram && <DiagramPanel repoId={repoId} repoUrl={repoUrl} mode={diagramMode} onClose={() => setShowDiagram(false)} />}
      {showKnowledgeGraph && <KnowledgeGraph repoId={repoId} repoUrl={repoUrl} onClose={() => setShowKnowledgeGraph(false)} />}
    </>
  );
}