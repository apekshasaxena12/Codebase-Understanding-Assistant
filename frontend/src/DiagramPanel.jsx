import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import * as d3 from "d3";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    background: "#0a0a0f",
    primaryColor: "#111118",
    primaryTextColor: "#e8e8f0",
    primaryBorderColor: "#7fff6e",
    lineColor: "#44445a",
    secondaryColor: "#1e1e2e",
    tertiaryColor: "#0a0a0f",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: "13px",
  },
});

export default function DiagramPanel({ repoId, repoUrl, onClose, mode }) {
  const wrapperRef = useRef(null);
  const svgContainerRef = useRef(null);
  const zoomRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [explanation, setExplanation] = useState("");
  const [mermaidCode, setMermaidCode] = useState("");
  const [fnInput, setFnInput] = useState("");
  const [copiedMermaid, setCopiedMermaid] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedImg, setCopiedImg] = useState(false);
  const [activeTab, setActiveTab] = useState("diagram");
  const [scale, setScale] = useState(1);

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
    } catch (e) {
      setError("Failed to generate diagram. Check that the backend is running.");
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "architecture") fetchDiagram(null);
  }, [mode, repoId]);

  // render mermaid + set up D3 zoom
  useEffect(() => {
    if (!mermaidCode || loading || activeTab !== "diagram" || !wrapperRef.current) return;

    async function render() {
      try {
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidCode);

        // inject into a container div inside the wrapper
        const container = svgContainerRef.current;
        container.innerHTML = svg;

        const svgEl = container.querySelector("svg");
        if (!svgEl) return;

        // get natural size
        const bbox = svgEl.getBBox?.() || { width: 800, height: 600 };
        const naturalW = svgEl.viewBox?.baseVal?.width || svgEl.clientWidth || 800;
        const naturalH = svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || 600;

        // make SVG fill the container but be transformable
        svgEl.style.width = naturalW + "px";
        svgEl.style.height = naturalH + "px";
        svgEl.style.display = "block";

        // wrapper is the zoom viewport
        const wrapper = wrapperRef.current;
        const wW = wrapper.clientWidth;
        const wH = wrapper.clientHeight;

        // fit-to-screen initial scale
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

      } catch (e) {
        svgContainerRef.current.innerHTML = `<pre style="color:#ff6b6b;font-size:11px;padding:16px;overflow:auto">${mermaidCode}</pre>`;
      }
    }
    render();
  }, [mermaidCode, loading, activeTab]);

  function zoomBy(factor) {
    if (!zoomRef.current || !wrapperRef.current) return;
    d3.select(wrapperRef.current).transition().duration(200)
      .call(zoomRef.current.scaleBy, factor);
  }

  function resetZoom() {
    if (!zoomRef.current || !wrapperRef.current) return;
    d3.select(wrapperRef.current).transition().duration(300)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  }

  function fitDiagram() {
    if (!zoomRef.current || !wrapperRef.current || !svgContainerRef.current) return;
    const svgEl = svgContainerRef.current.querySelector("svg");
    if (!svgEl) return;
    const naturalW = svgEl.clientWidth || 800;
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
  // get actual content dimensions from viewBox or bBox
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
  // strip external font imports — this is what causes tainted canvas
  cloned.querySelectorAll("style").forEach(s => {
    s.textContent = s.textContent.replace(/@import[^;]+;/g, "").replace(/url\(['"]?https?[^)]+\)/g, "");
  });
  cloned.querySelectorAll("[href]").forEach(el => {
    if (el.getAttribute("href")?.startsWith("http")) el.removeAttribute("href");
  });
  const svgStr = new XMLSerializer().serializeToString(cloned);
  const encoded = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  return { encoded, w, h };
}

function downloadPNG() {
  getSVGBlob().then(({ encoded, w, h }) => {
    if (!encoded) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0a0a0f";
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
  const result = await getSVGBlob();
  if (!result) return;
  const { encoded, w, h } = result;
  const img = new Image();
  img.onload = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(async (pngBlob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        setCopiedImg(true);
        setTimeout(() => setCopiedImg(false), 2000);
      } catch { console.error("Clipboard write failed"); }
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
    border: "1px solid #1e1e2e",
    borderRadius: 4,
    padding: "5px 12px",
    color: "#888899",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    cursor: "pointer",
    transition: "all 0.15s",
  };

  const tabStyle = (active) => ({
    background: "transparent",
    border: "none",
    borderBottom: active ? "2px solid #7fff6e" : "2px solid transparent",
    padding: "10px 18px",
    color: active ? "#7fff6e" : "#44445a",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    cursor: "pointer",
    transition: "all 0.15s",
  });

  const zoomBtnStyle = {
    background: "#111118",
    border: "1px solid #1e1e2e",
    borderRadius: 4,
    width: 32,
    height: 32,
    display: "grid",
    placeItems: "center",
    color: "#888899",
    fontSize: 16,
    cursor: "pointer",
    transition: "all 0.15s",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0a0f", zIndex: 9999, display: "flex", flexDirection: "column" }}>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#e8e8f0" }}>
            {mode === "architecture" ? "Architecture Diagram" : "Code Flow Tracer"}
          </span>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#44445a" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {mermaidCode && (
            <>
              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
                onClick={downloadPNG}>↓ PNG</button>

              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
                onClick={copyImage}>{copiedImg ? "✓ Copied!" : "Copy Image"}</button>
              <button style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#4ef0c0"; e.currentTarget.style.color = "#4ef0c0"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
                onClick={copyMermaid}>{copiedMermaid ? "✓ Copied!" : "Copy Mermaid"}</button>
            </>
          )}
          <button onClick={onClose} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#ff6b6b"; e.currentTarget.style.color = "#ff6b6b"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>
            ✕ Close
          </button>
        </div>
      </div>

      {/* flow: function input */}
      {mode === "flow" && !mermaidCode && !loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 480 }}>
            <div style={{ marginBottom: 8, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#44445a", letterSpacing: "0.08em" }}>
              ENTER FUNCTION NAME TO TRACE
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={fnInput}
                onChange={e => setFnInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fnInput.trim() && fetchDiagram(fnInput.trim())}
                placeholder="e.g. fetch_comments, handleSubmit, processOrder"
                autoFocus
                style={{ flex: 1, background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, padding: "10px 14px", color: "#e8e8f0", fontFamily: "JetBrains Mono, monospace", fontSize: 13, outline: "none" }}
                onFocus={e => e.target.style.borderColor = "#7fff6e"}
                onBlur={e => e.target.style.borderColor = "#1e1e2e"}
              />
              <button onClick={() => fnInput.trim() && fetchDiagram(fnInput.trim())}
                style={{ background: "#7fff6e", color: "#0a0a0f", border: "none", borderRadius: 4, padding: "10px 20px", fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Trace →
              </button>
            </div>
            {error && <div style={{ marginTop: 12, color: "#ff6b6b", fontFamily: "JetBrains Mono, monospace", fontSize: 11 }}>{error}</div>}
          </div>
        </div>
      )}

      {loading && (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "#888899", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }}>
          Generating diagram…
        </div>
      )}

      {!loading && mermaidCode && (
        <>
          {/* tabs */}
          <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
            <button style={tabStyle(activeTab === "diagram")} onClick={() => setActiveTab("diagram")}>Diagram</button>
            <button style={tabStyle(activeTab === "explanation")} onClick={() => setActiveTab("explanation")}>Explanation</button>
            <button style={tabStyle(activeTab === "code")} onClick={() => setActiveTab("code")}>Mermaid Source</button>
            {mode === "flow" && (
              <button style={{ ...tabStyle(false), marginLeft: "auto" }}
                onClick={() => { setMermaidCode(""); setExplanation(""); setFnInput(""); setError(null); }}>
                ← New Trace
              </button>
            )}
          </div>

          {/* diagram tab — pannable/zoomable viewport */}
          {activeTab === "diagram" && (
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {/* zoom controls */}
              <div style={{ position: "absolute", bottom: 24, right: 24, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button style={zoomBtnStyle} onClick={() => zoomBy(1.3)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>+</button>
                <button style={{ ...zoomBtnStyle, fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
                  onClick={fitDiagram}>{scale}%</button>
                <button style={zoomBtnStyle} onClick={() => zoomBy(0.77)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>−</button>
              </div>

              {/* hint */}
              <div style={{ position: "absolute", bottom: 24, left: 24, fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#2a2a3a", zIndex: 10 }}>
                scroll to zoom · drag to pan · click % to fit
              </div>

              {/* zoom viewport */}
              <div ref={wrapperRef} style={{ width: "100%", height: "100%", cursor: "grab", userSelect: "none" }}>
                <div ref={svgContainerRef} style={{ transformOrigin: "0 0", display: "inline-block" }} />
              </div>
            </div>
          )}

          {/* explanation tab */}
          {activeTab === "explanation" && (
            <div style={{ flex: 1, overflow: "auto", padding: 32 }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                  <button onClick={copyExplanation}
                    style={{ ...btnStyle, borderColor: copiedText ? "#7fff6e" : "#1e1e2e", color: copiedText ? "#7fff6e" : "#888899" }}
                    onMouseEnter={e => { if (!copiedText) { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}}
                    onMouseLeave={e => { if (!copiedText) { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}}>
                    {copiedText ? "✓ Copied!" : "Copy Text"}
                  </button>
                </div>
                <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 13, lineHeight: 1.9, color: "#c8c8d8", whiteSpace: "pre-wrap", background: "#111118", border: "1px solid #1e1e2e", borderRadius: 6, padding: 24, userSelect: "text" }}>
                  {explanation}
                </p>
              </div>
            </div>
          )}

          {/* mermaid source tab */}
          {activeTab === "code" && (
            <div style={{ flex: 1, overflow: "auto", padding: 32 }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <pre style={{ background: "#111118", border: "1px solid #1e1e2e", borderRadius: 6, padding: 20, fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#4ef0c0", overflow: "auto", lineHeight: 1.6 }}>
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