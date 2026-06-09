import './App.css';
import GraphPanel from "./GraphPanel";
import ReactMarkdown from 'react-markdown';
import { useState, useEffect, useRef } from "react";
import DiagramPanel from "./DiagramPanel";
import KnowledgeGraph from "./KnowledgeGraph";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

// ── Header ────────────────────────────────────────────────────

function Header({ theme, onToggleTheme }) {
  return (
    <header className="glass" style={{
      borderBottom: "1px solid var(--border)",
      padding: "16px 32px",
      display: "flex",
      alignItems: "center",
      gap: 12,
      position: "sticky",
      top: 0,
      zIndex: 100,
    }}>
      <div style={{
        width: 32, height: 32,
        background: "var(--accent)",
        borderRadius: 4,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 16 }}>⌥</span>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em", color: "var(--text)" }}>
          codebase.ai
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)", marginTop: 1 }}>
          understand any repo instantly
        </div>
      </div>
      <button
        className="theme-toggle"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </header>
  );
}

// ── IngestPanel ───────────────────────────────────────────────

function IngestPanel({ onIngested }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle");   // idle | loading | done | error
  const [progress, setProgress] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  async function handleIngest() {
    if (!url.trim() || status === "loading") return;
    setStatus("loading");
    setProgress("Starting…");
    setErrorMsg("");
    try {
      const res = await fetch(`${API}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Request failed");
      const { job_id, repo_id } = data;

      function poll() {
        fetch(`${API}/ingest/status/${job_id}`)
          .then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.detail || "Status check failed"); });
            return r.json();
          })
          .then(s => {
            if (s.status === "done") {
              setStatus("done");
              onIngested(s.repo_id, url);
            } else if (s.status === "error") {
              setStatus("error");
              setErrorMsg(s.error || "Ingestion failed.");
            } else {
              setProgress(s.progress || "Processing…");
              pollRef.current = setTimeout(poll, 2000);
            }
          })
          .catch(err => {
            setStatus("error");
            setErrorMsg(err.message || "Lost connection to server. Please try again.");
          });
      }
      pollRef.current = setTimeout(poll, 1000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Failed to start ingestion.");
    }
  }

  return (
    <div className="ingest-panel">
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 48px)", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.1, color: "var(--text)" }}>
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
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleIngest()}
            placeholder="https://github.com/owner/repo"
            style={{ flex: 1, minWidth: 0, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 14px", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 13, outline: "none", transition: "border-color 0.2s" }}
            onFocus={e => e.target.style.borderColor = "var(--accent)"}
            onBlur={e => e.target.style.borderColor = "var(--border)"}
          />
          <button
            onClick={handleIngest}
            disabled={status === "loading"}
            style={{ background: status === "loading" ? "var(--muted)" : "var(--accent)", color: "var(--bg)", border: "none", borderRadius: "var(--radius)", padding: "10px 20px", fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, cursor: status === "loading" ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
          >
            {status === "loading" ? "Ingesting…" : "Ingest →"}
          </button>
        </div>
        {status === "loading" && progress && (
          <p style={{ marginTop: 10, color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--mono)", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid var(--muted)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
            {progress}
          </p>
        )}
        {status === "error" && (
          <p style={{ marginTop: 10, color: "var(--danger)", fontSize: 12, fontFamily: "var(--mono)" }}>
            ✗ {errorMsg || "Failed to ingest repo. Check the URL and try again."}
          </p>
        )}
        {status === "done" && (
          <p style={{ marginTop: 10, color: "var(--accent)", fontSize: 12, fontFamily: "var(--mono)" }}>
            ✓ Repo ingested successfully.
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

function MermaidBlock({ code, theme }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    import("mermaid").then(m => {
      const mermaidTheme = theme === "light" ? "default" : "dark";
      m.default.initialize({
        startOnLoad: false,
        theme: mermaidTheme,
        themeVariables: {
          fontFamily: "JetBrains Mono, monospace",
          ...(theme === "light" ? {
            background: "#f4f4f8",
            primaryColor: "#ffffff",
            primaryTextColor: "#0a0a1f",
            primaryBorderColor: "#1a801a",
            lineColor: "#b0b0c0",
          } : {
            background: "#0a0a0f",
            primaryColor: "#111118",
            primaryTextColor: "#e8e8f0",
            primaryBorderColor: "#7fff6e",
            lineColor: "#44445a",
          }),
        },
      });
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      m.default.render(id, code).then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg;
      }).catch(() => {
        if (ref.current) ref.current.innerHTML = `<pre style="color:var(--accent2);font-size:11px;overflow:auto">${code}</pre>`;
      });
    });
  }, [code, theme]);
  return (
    <div ref={ref} style={{
      marginTop: 12,
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 6,
      padding: 16,
      overflow: "auto",
    }} />
  );
}

// ── QueryPanel ────────────────────────────────────────────────

function QueryPanel({ repoId, repoUrl, theme, onShowGraph, onShowDiagram, onShowKnowledgeGraph }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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
    } catch {
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
    a.href = url; a.download = `chat-${repoUrl.split("/").pop()}.txt`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const header = "role,message,sources";
    const rows = messages.map(m => {
      const msg = `"${m.text.replace(/"/g, '""')}"`;
      const srcs = `"${(m.sources || []).join("; ")}"`;
      return `${m.role},${msg},${srcs}`;
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `chat-${repoUrl.split("/").pop()}.csv`; a.click();
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
    whiteSpace: "nowrap",
  };

  return (
    <div className="query-panel">
      {/* top bar */}
      <div className="query-top-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", minWidth: 0 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "blink 2s infinite", flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
        </div>

        <div className="query-btn-group">
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
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20, paddingBottom: 16 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 13, marginTop: 40, textAlign: "center" }}>
            Ask anything about this codebase ↓
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ animation: "fadeUp 0.3s ease both", alignSelf: msg.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", minWidth: 0 }}>
            <div style={{
              background: msg.role === "user" ? "var(--accent)" : "var(--surface)",
              color: msg.role === "user" ? "var(--bg)" : "var(--text)",
              border: msg.role === "assistant" ? "1px solid var(--border)" : "none",
              borderRadius: "var(--radius)",
              padding: "12px 16px",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: msg.role === "user" ? "var(--sans)" : "var(--mono)",
              fontWeight: msg.role === "user" ? 600 : 400,
            }}>
              <ReactMarkdown
                components={{
                  pre: ({ children, ...props }) => (
                    <pre style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "10px 14px",
                      overflowX: "auto",
                      margin: "8px 0",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }} {...props}>{children}</pre>
                  ),
                  code: ({ node, inline, children, ...props }) => inline
                    ? <code style={{ fontFamily: "var(--mono)", fontSize: "0.9em", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 5px" }} {...props}>{children}</code>
                    : <code style={{ fontFamily: "var(--mono)", fontSize: 12 }} {...props}>{children}</code>,
                  p: ({ children, ...props }) => <p style={{ marginBottom: 8 }} {...props}>{children}</p>,
                }}
              >{msg.text}</ReactMarkdown>
              {msg.mermaid && <MermaidBlock code={msg.mermaid} theme={theme} />}
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {msg.sources.map((src, j) => (
                  <span key={j} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "3px 8px", fontSize: 11, fontFamily: "var(--mono)", color: "var(--accent2)" }}>
                    {src.split("/").pop()}
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
        <div ref={bottomRef} />
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
          style={{ background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: "var(--radius)", padding: "8px 16px", fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.5 : 1 }}>
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
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme(t => t === "dark" ? "light" : "dark");
  }

  return (
    <>
      <Header theme={theme} onToggleTheme={toggleTheme} />
      {!repoId
        ? <IngestPanel onIngested={(id, url) => { setRepoId(id); setRepoUrl(url); }} />
        : <QueryPanel
            repoId={repoId}
            repoUrl={repoUrl}
            theme={theme}
            onShowGraph={() => setShowGraph(true)}
            onShowDiagram={(mode) => { setDiagramMode(mode); setShowDiagram(true); }}
            onShowKnowledgeGraph={() => setShowKnowledgeGraph(true)}
          />
      }
      {showGraph && (
        <GraphPanel repoId={repoId} repoUrl={repoUrl} theme={theme} onClose={() => setShowGraph(false)} />
      )}
      {showDiagram && (
        <DiagramPanel repoId={repoId} repoUrl={repoUrl} mode={diagramMode} theme={theme} onClose={() => setShowDiagram(false)} />
      )}
      {showKnowledgeGraph && (
        <KnowledgeGraph repoId={repoId} repoUrl={repoUrl} theme={theme} onClose={() => setShowKnowledgeGraph(false)} />
      )}
    </>
  );
}
