import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import * as d3 from "d3";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

function getMermaidConfig(theme) {
  const dark = theme !== "light";
  return {
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    themeVariables: {
      background:         dark ? "#0a0a0f" : "#f4f4f8",
      primaryColor:       dark ? "#111118" : "#ffffff",
      primaryTextColor:   dark ? "#e8e8f0" : "#0a0a1f",
      primaryBorderColor: dark ? "#7fff6e" : "#1a801a",
      lineColor:          dark ? "#44445a" : "#b0b0c0",
      secondaryColor:     dark ? "#1e1e2e" : "#e8e8f0",
      tertiaryColor:      dark ? "#0a0a0f" : "#f4f4f8",
      fontFamily:         "JetBrains Mono, monospace",
      fontSize:           "13px",
    },
  };
}

export default function DiagramPanel({ repoId, repoUrl, onClose, mode, theme }) {
  const wrapperRef      = useRef(null);
  const svgContainerRef = useRef(null);
  const zoomRef         = useRef(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [explanation, setExplanation] = useState("");
  const [mermaidCode, setMermaidCode] = useState("");
  const [fnInput, setFnInput]         = useState("");
  const [copiedMermaid, setCopiedMermaid] = useState(false);
  const [copiedText, setCopiedText]   = useState(false);
  const [copiedImg, setCopiedImg]     = useState(false);
  const [activeTab, setActiveTab]     = useState("diagram");
  const [scale, setScale]             = useState(1);
  // Trigger re-render of the diagram when theme changes
  const [renderKey, setRenderKey]     = useState(0);

  // Re-initialize mermaid and re-render the diagram when theme changes
  useEffect(() => {
    mermaid.initialize(getMermaidConfig(theme));
    if (mermaidCode) setRenderKey(k => k + 1);
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchDiagram(functionName) {
    setLoading(true);
    setError(null);
    setMermaidCode("");
    setExplanation("");
    try {
      let data;
      if (mode === "architecture") {
        const res = await fetch(`${API}/architecture/${repoId}`);
        data = await res.json();
      } else {
        const res = await fetch(`${API}/flow/${repoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ function_name: functionName }),
        });
        data = await res.json();
      }
      if (data.error) { setError(data.error); setLoading(false); return; }
      setMermaidCode(data.mermaid);
      setExplanation(data.explanation);
      setActiveTab("diagram");
      setLoading(false);
    } catch {
      setError("Failed to generate diagram. Check that the backend is running.");
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "architecture") fetchDiagram(null);
  }, [mode, repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render mermaid + set up D3 zoom (also re-runs on renderKey change = theme toggle)
  useEffect(() => {
    if (!mermaidCode || loading || activeTab !== "diagram" || !wrapperRef.current) return;

    async function render() {
      try {
        // Ensure mermaid is initialized with the current theme
        mermaid.initialize(getMermaidConfig(theme));

        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, mermaidCode);

        const container = svgContainerRef.current;
        container.innerHTML = svg;

        const svgEl = container.querySelector("svg");
        if (!svgEl) return;

        const naturalW = svgEl.viewBox?.baseVal?.width  || svgEl.clientWidth  || 800;
        const naturalH = svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || 600;

        // Set pixel attributes so D3 zoom's defaultExtent never sees a percentage SVGLength
        svgEl.setAttribute("width",  naturalW);
        svgEl.setAttribute("height", naturalH);
        svgEl.style.width  = naturalW + "px";
        svgEl.style.height = naturalH + "px";
        svgEl.style.display = "block";

        const wrapper = wrapperRef.current;
        const wW = wrapper.clientWidth;
        const wH = wrapper.clientHeight;

        const fitScale = Math.min((wW - 80) / naturalW, (wH - 80) / naturalH, 1);
        const tx = (wW - naturalW * fitScale) / 2;
        const ty = (wH - naturalH * fitScale) / 2;

        const zoom = d3.zoom()
          .scaleExtent([0.1, 5])
          .on("zoom", (e) => {
            container.style.transform = `translate(${e.transform.x}px, ${e.transform.y}px) scale(${e.transform.k})`;
            container.style.transformOrigin = "0 0";
            setScale(Math.round(e.transform.k * 100));
          });

        zoomRef.current = zoom;
        const sel = d3.select(wrapper);
        sel.call(zoom);
        sel.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(fitScale));
        setScale(Math.round(fitScale * 100));
      } catch {
        if (svgContainerRef.current) {
          svgContainerRef.current.innerHTML = `<pre style="color:var(--danger);font-size:11px;padding:16px;overflow:auto">${mermaidCode}</pre>`;
        }
      }
    }
    render();
  }, [mermaidCode, loading, activeTab, renderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function zoomBy(factor) {
    if (!zoomRef.current || !wrapperRef.current) return;
    d3.select(wrapperRef.current).transition().duration(200)
      .call(zoomRef.current.scaleBy, factor);
  }

  function fitDiagram() {
    if (!zoomRef.current || !wrapperRef.current || !svgContainerRef.current) return;
    const svgEl = svgContainerRef.current.querySelector("svg");
    if (!svgEl) return;
    const naturalW = svgEl.clientWidth  || 800;
    const naturalH = svgEl.clientHeight || 600;
    const wW = wrapperRef.current.clientWidth;
    const wH = wrapperRef.current.clientHeight;
    const fitScale = Math.min((wW - 80) / naturalW, (wH - 80) / naturalH, 1);
    const tx = (wW - naturalW * fitScale) / 2;
    const ty = (wH - naturalH * fitScale) / 2;
    d3.select(wrapperRef.current).transition().duration(300)
      .call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(fitScale));
  }

  async function getSVGBlob() {
    const svgEl = svgContainerRef.current?.querySelector("svg");
    if (!svgEl) return null;
    const cloned = svgEl.cloneNode(true);
    const vb = svgEl.getAttribute("viewBox");
    let w, h;
    if (vb) {
      const parts = vb.split(/[\s,]+/);
      w = parseFloat(parts[2]);
      h = parseFloat(parts[3]);
    } else {
      w = svgEl.scrollWidth || 1200;
      h = svgEl.scrollHeight || 800;
    }
    cloned.setAttribute("width", w);
    cloned.setAttribute("height", h);
    cloned.querySelectorAll("style").forEach(s => {
      s.textContent = s.textContent
        .replace(/@import[^;]+;/g, "")
        .replace(/url\(['"]?https?[^)]+\)/g, "");
    });
    cloned.querySelectorAll("[href]").forEach(el => {
      if (el.getAttribute("href")?.startsWith("http")) el.removeAttribute("href");
    });
    const svgStr  = new XMLSerializer().serializeToString(cloned);
    const encoded = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    return { encoded, w, h };
  }

  function downloadPNG() {
    const bgColor = theme === "light" ? "#f4f4f8" : "#0a0a0f";
    getSVGBlob().then(result => {
      if (!result) return;
      const { encoded, w, h } = result;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width  = w * 2;
        canvas.height = h * 2;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        const a = document.createElement("a");
        a.download = `${mode}-diagram-${repoUrl.split("/").pop()}.png`;
        a.href = canvas.toDataURL("image/png");
        a.click();
      };
      img.src = encoded;
    });
  }

  async function copyImage() {
    const bgColor = theme === "light" ? "#f4f4f8" : "#0a0a0f";
    const result = await getSVGBlob();
    if (!result) return;
    const { encoded, w, h } = result;
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width  = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(async (pngBlob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
          setCopiedImg(true);
          setTimeout(() => setCopiedImg(false), 2000);
        } catch {}
      });
    };
    img.src = encoded;
  }

  async function copyMermaid() {
    await navigator.clipboard.writeText(mermaidCode);
    setCopiedMermaid(true);
    setTimeout(() => setCopiedMermaid(false), 2000);
  }

  async function copyExplanation() {
    await navigator.clipboard.writeText(explanation);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  }

  const btnStyle = {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "5px 12px",
    color: "var(--text-dim)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    transition: "all 0.15s",
    whiteSpace: "nowrap",
  };

  const tabStyle = (active) => ({
    background: "transparent",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    padding: "10px 18px",
    color: active ? "var(--accent)" : "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    transition: "all 0.15s",
  });

  const zoomBtnStyle = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    width: 32,
    height: 32,
    display: "grid",
    placeItems: "center",
    color: "var(--text-dim)",
    cursor: "pointer",
    transition: "all 0.15s",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 9999, display: "flex", flexDirection: "column" }}>

      {/* header */}
      <div className="panel-header">
        <div className="panel-header-left">
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>
            {mode === "architecture" ? "Architecture Diagram" : "Code Flow Tracer"}
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
        </div>
        <div className="panel-header-right">
          {mermaidCode && (
            <>
              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
                onClick={downloadPNG}>↓ PNG</button>
              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
                onClick={copyImage}>{copiedImg ? "✓ Copied!" : "Copy Image"}</button>
              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent2)"; e.currentTarget.style.color = "var(--accent2)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
                onClick={copyMermaid}>{copiedMermaid ? "✓ Copied!" : "Copy Mermaid"}</button>
            </>
          )}
          <button onClick={onClose} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--danger)"; e.currentTarget.style.color = "var(--danger)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>
            ✕ Close
          </button>
        </div>
      </div>

      {/* flow: function input */}
      {mode === "flow" && !mermaidCode && !loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ width: "min(480px, 100%)" }}>
            <div style={{ marginBottom: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em" }}>
              ENTER FUNCTION NAME TO TRACE
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={fnInput}
                onChange={e => setFnInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fnInput.trim() && fetchDiagram(fnInput.trim())}
                placeholder="e.g. fetch_comments, handleSubmit, processOrder"
                autoFocus
                style={{ flex: 1, minWidth: 200, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: "10px 14px", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 13, outline: "none" }}
                onFocus={e => e.target.style.borderColor = "var(--accent)"}
                onBlur={e => e.target.style.borderColor = "var(--border)"}
              />
              <button
                onClick={() => fnInput.trim() && fetchDiagram(fnInput.trim())}
                style={{ background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 4, padding: "10px 20px", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Trace →
              </button>
            </div>
            {error && (
              <div style={{ marginTop: 12, color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11 }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 13 }}>
          Generating diagram…
        </div>
      )}

      {!loading && mermaidCode && (
        <>
          {/* tabs */}
          <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", flexShrink: 0, overflowX: "auto" }}>
            <button style={tabStyle(activeTab === "diagram")}     onClick={() => setActiveTab("diagram")}>Diagram</button>
            <button style={tabStyle(activeTab === "explanation")} onClick={() => setActiveTab("explanation")}>Explanation</button>
            <button style={tabStyle(activeTab === "code")}        onClick={() => setActiveTab("code")}>Mermaid Source</button>
            {mode === "flow" && (
              <button style={{ ...tabStyle(false), marginLeft: "auto" }}
                onClick={() => { setMermaidCode(""); setExplanation(""); setFnInput(""); setError(null); }}>
                ← New Trace
              </button>
            )}
          </div>

          {/* diagram tab */}
          {activeTab === "diagram" && (
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {/* zoom controls */}
              <div className="zoom-controls" style={{ position: "absolute", bottom: 24, right: 24, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button style={{ ...zoomBtnStyle, fontSize: 18 }} onClick={() => zoomBy(1.3)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>+</button>
                <button style={{ ...zoomBtnStyle, fontSize: 11, fontFamily: "var(--mono)" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
                  onClick={fitDiagram}>{scale}%</button>
                <button style={{ ...zoomBtnStyle, fontSize: 18 }} onClick={() => zoomBy(0.77)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}>−</button>
              </div>

              <div className="graph-hint" style={{ position: "absolute", bottom: 24, left: 24, fontFamily: "var(--mono)", fontSize: 10, color: "var(--border)", zIndex: 10 }}>
                <span className="graph-hint-desktop">scroll to zoom · drag to pan · click % to fit</span>
                <span className="graph-hint-touch">pinch to zoom · drag to pan</span>
              </div>

              <div ref={wrapperRef} style={{ width: "100%", height: "100%", cursor: "grab", userSelect: "none", touchAction: "none" }}>
                <div ref={svgContainerRef} style={{ transformOrigin: "0 0", display: "inline-block" }} />
              </div>
            </div>
          )}

          {/* explanation tab */}
          {activeTab === "explanation" && (
            <div style={{ flex: 1, overflow: "auto", padding: 32 }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                  <button
                    onClick={copyExplanation}
                    style={{ ...btnStyle, borderColor: copiedText ? "var(--accent)" : "var(--border)", color: copiedText ? "var(--accent)" : "var(--text-dim)" }}
                    onMouseEnter={e => { if (!copiedText) { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}}
                    onMouseLeave={e => { if (!copiedText) { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}}>
                    {copiedText ? "✓ Copied!" : "Copy Text"}
                  </button>
                </div>
                <p style={{ fontFamily: "var(--mono)", fontSize: 13, lineHeight: 1.9, color: "var(--text)", whiteSpace: "pre-wrap", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 24, userSelect: "text" }}>
                  {explanation}
                </p>
              </div>
            </div>
          )}

          {/* mermaid source tab */}
          {activeTab === "code" && (
            <div style={{ flex: 1, overflow: "auto", padding: 32 }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <pre style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 20, fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent2)", overflow: "auto", lineHeight: 1.6 }}>
                  {mermaidCode}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
