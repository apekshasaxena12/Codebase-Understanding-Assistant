import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

const TYPE = {
  file:     { stroke: "#7fff6e", fill: "#0d1f0d", r: 28, label: "#7fff6e" },
  class:    { stroke: "#4ef0c0", fill: "#0d1a1f", r: 18, label: "#4ef0c0" },
  function: { stroke: "#6666aa", fill: "#111118", r: 11, label: "#888899" },
};

export default function KnowledgeGraph({ repoId, repoUrl, onClose }) {
  const svgRef       = useRef(null);
  const gRef         = useRef(null);
  const zoomRef      = useRef(null);
  const simRef       = useRef(null);
  const linkSel      = useRef(null);
  const nodeSel      = useRef(null);

  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [stats, setStats]       = useState(null);
  const [selected, setSelected] = useState(null);
  const [search, setSearch]     = useState("");
  const [filterType, setFilterType] = useState("all"); // all | file | class | function
  const [answer, setAnswer]     = useState("");
  const [asking, setAsking]     = useState(false);
  const [question, setQuestion] = useState("");
  const [graphData, setGraphData] = useState(null);

  // ── fetch + render ────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const res  = await fetch(`${API}/knowledge-graph/${repoId}`);
        const data = await res.json();
        if (data.error) { setError(data.error); setLoading(false); return; }
        setStats({ nodes: data.nodes.length, edges: data.edges.length });
        setGraphData(data);
        renderGraph(data);
        setLoading(false);
      } catch {
        setError("Failed to load knowledge graph. Make sure the repo is ingested.");
        setLoading(false);
      }
    }
    load();
    return () => { simRef.current?.stop(); };
  }, [repoId]);

  function renderGraph(data) {
    const svg    = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const W = svgRef.current.clientWidth;
    const H = svgRef.current.clientHeight;

    // ── defs ──
    const defs = svg.append("defs");
    const glow = defs.append("filter").attr("id", "kg-glow");
    glow.append("feGaussianBlur").attr("stdDeviation", 4).attr("result", "blur");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "blur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    // radial gradient per type
    Object.entries(TYPE).forEach(([t, c]) => {
      const grad = defs.append("radialGradient").attr("id", `grad-${t}`);
      grad.append("stop").attr("offset", "0%").attr("stop-color", c.stroke).attr("stop-opacity", 0.15);
      grad.append("stop").attr("offset", "100%").attr("stop-color", c.fill);
    });

    const g = svg.append("g");
    gRef.current = g;

    // ── zoom ──
    const zoom = d3.zoom().scaleExtent([0.15, 5])
      .on("zoom", e => g.attr("transform", e.transform));
    zoomRef.current = zoom;
    svg.call(zoom);
    svg.on("click", () => { setSelected(null); });

    // ── data ──
    const nodes = data.nodes.map(d => ({ ...d }));
    const edges = data.edges.map(d => ({ ...d }));

    // group files at fixed positions around center
    const fileNodes = nodes.filter(n => n.type === "file");
    const angle = (2 * Math.PI) / Math.max(fileNodes.length, 1);
    const ring  = Math.min(W, H) * 0.28;
    fileNodes.forEach((n, i) => {
      n.fx_init = W / 2 + ring * Math.cos(i * angle - Math.PI / 2);
      n.fy_init = H / 2 + ring * Math.sin(i * angle - Math.PI / 2);
    });

    // ── simulation ──
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id(d => d.id)
        .distance(d => d.type === "contains" ? 70 : 120)
        .strength(d => d.type === "contains" ? 0.8 : 0.3))
      .force("charge", d3.forceManyBody()
        .strength(d => d.type === "file" ? -800 : d.type === "class" ? -200 : -80))
      .force("center", d3.forceCenter(W / 2, H / 2).strength(0.05))
      .force("collision", d3.forceCollide(d => (TYPE[d.type]?.r || 12) + 12))
      .alpha(1).alphaDecay(0.02);

    simRef.current = sim;

    // nudge file nodes toward their initial ring positions
    sim.force("ring", () => {
      fileNodes.forEach(n => {
        if (n.fx_init === undefined) return;
        n.vx += (n.fx_init - n.x) * 0.05;
        n.vy += (n.fy_init - n.y) * 0.05;
      });
    });

    // ── edges ──
    const link = g.append("g").attr("class", "links").selectAll("line")
      .data(edges).enter().append("line")
      .attr("stroke", d => d.type === "contains" ? "#2a2a3a" : "#3a3a6a")
      .attr("stroke-width", d => d.type === "contains" ? 1 : 1.5)
      .attr("stroke-dasharray", d => d.type === "contains" ? "5,3" : null)
      .attr("stroke-opacity", 0.5);
    linkSel.current = link;

    // ── nodes ──
    const node = g.append("g").attr("class", "nodes").selectAll("g")
      .data(nodes).enter().append("g")
      .attr("class", d => `node node-${d.type}`)
      .style("cursor", "pointer")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on("click", (e, d) => { e.stopPropagation(); setSelected(d); setAnswer(""); setQuestion(""); highlight(d, link, node); });
    nodeSel.current = node;

    // outer pulse ring for files
    node.filter(d => d.type === "file")
      .append("circle")
      .attr("r", d => TYPE[d.type].r + 6)
      .attr("fill", "none")
      .attr("stroke", d => TYPE[d.type].stroke)
      .attr("stroke-width", 0.5)
      .attr("stroke-opacity", 0.25)
      .attr("filter", "url(#kg-glow)");

    // main circle with gradient fill
    node.append("circle")
      .attr("r", d => TYPE[d.type]?.r || 12)
      .attr("fill", d => `url(#grad-${d.type})`)
      .attr("stroke", d => TYPE[d.type]?.stroke || "#888899")
      .attr("stroke-width", 1.5)
      .on("mouseover", function(e, d) {
        d3.select(this).attr("stroke-width", 3).attr("filter", "url(#kg-glow)");
      })
      .on("mouseout", function() {
        d3.select(this).attr("stroke-width", 1.5).attr("filter", null);
      });

    // type icon
    node.append("text")
      .text(d => d.type === "file" ? "F" : d.type === "class" ? "C" : "f")
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", d => d.type === "file" ? 12 : d.type === "class" ? 10 : 8)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-weight", "700")
      .attr("fill", d => TYPE[d.type]?.stroke || "#888899")
      .attr("pointer-events", "none");

    // label
    node.append("text")
      .text(d => d.label.length > 20 ? d.label.slice(0, 18) + "…" : d.label)
      .attr("text-anchor", "middle")
      .attr("dy", d => (TYPE[d.type]?.r || 12) + 16)
      .attr("fill", d => TYPE[d.type]?.label || "#888899")
      .attr("font-size", d => d.type === "file" ? 11 : d.type === "class" ? 10 : 9)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-weight", d => d.type === "file" ? "500" : "400")
      .attr("pointer-events", "none");

    sim.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // auto-fit after settle
    sim.on("end", () => fitGraph(g, svg, zoom, W, H));
  }

  function highlight(d, link, node) {
    const connected = new Set();
    link.each(l => {
      if (l.source.id === d.id) connected.add(l.target.id);
      if (l.target.id === d.id) connected.add(l.source.id);
    });
    link.attr("stroke-opacity", l =>
      l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.05)
      .attr("stroke-width", l =>
        l.source.id === d.id || l.target.id === d.id ? 2.5 : 1);
    node.attr("opacity", n => n.id === d.id || connected.has(n.id) ? 1 : 0.2);
  }

  function resetHighlight() {
    if (!linkSel.current || !nodeSel.current) return;
    linkSel.current.attr("stroke-opacity", 0.5).attr("stroke-width", d => d.type === "contains" ? 1 : 1.5);
    nodeSel.current.attr("opacity", 1);
  }

  function fitGraph(g, svg, zoom, W, H) {
    try {
      const bounds = g.node().getBBox();
      if (!bounds.width) return;
      const pad = 60;
      const scale = Math.min((W - pad * 2) / bounds.width, (H - pad * 2) / bounds.height, 1);
      const tx = (W - bounds.width * scale) / 2 - bounds.x * scale;
      const ty = (H - bounds.height * scale) / 2 - bounds.y * scale;
      svg.transition().duration(700)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    } catch {}
  }

  // ── search ────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current) return;
    const s = search.toLowerCase().trim();
    if (!s) { resetHighlight(); return; }
    const svg = d3.select(svgRef.current);
    svg.selectAll(".node circle").attr("filter", null).attr("stroke-width", 1.5);
    svg.selectAll(".node").attr("opacity", d => d?.label?.toLowerCase().includes(s) ? 1 : 0.15);
    svg.selectAll(".node circle")
      .filter(d => d?.label?.toLowerCase().includes(s))
      .attr("filter", "url(#kg-glow)").attr("stroke-width", 3);

    // fly to first match
    const match = d3.select(svgRef.current).selectAll(".node")
      .filter(d => d?.label?.toLowerCase().includes(s)).datum();
    if (match && zoomRef.current && svgRef.current) {
      const W = svgRef.current.clientWidth;
      const H = svgRef.current.clientHeight;
      d3.select(svgRef.current).transition().duration(500)
        .call(zoomRef.current.transform,
          d3.zoomIdentity.translate(W / 2 - match.x, H / 2 - match.y).scale(1.5));
    }
  }, [search]);

  // ── filter by type ────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    if (filterType === "all") {
      svg.selectAll(".node").attr("opacity", 1).attr("display", null);
      svg.selectAll(".links line").attr("opacity", 0.5);
    } else {
      svg.selectAll(".node").attr("opacity", d => d?.type === filterType ? 1 : 0.08);
      svg.selectAll(".links line").attr("opacity", 0.05);
    }
  }, [filterType]);

  // ── ask ───────────────────────────────────────────────────
  async function askAboutNode() {
    if (!question.trim() || !selected) return;
    setAsking(true); setAnswer("");
    try {
      const res = await fetch(`${API}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: repoId,
          question: `About the ${selected.type} "${selected.label}": ${question}`,
        }),
      });
      const data = await res.json();
      setAnswer(data.answer);
    } catch { setAnswer("Failed to get answer."); }
    finally { setAsking(false); }
  }

  // ── styles ────────────────────────────────────────────────
  const btnStyle = {
    background: "transparent", border: "1px solid #1e1e2e", borderRadius: 4,
    padding: "5px 12px", color: "#888899", fontFamily: "JetBrains Mono, monospace",
    fontSize: 11, cursor: "pointer", transition: "all 0.15s",
  };
  const filterBtn = (t) => ({
    ...btnStyle,
    borderColor: filterType === t ? TYPE[t]?.stroke || "#7fff6e" : "#1e1e2e",
    color:       filterType === t ? TYPE[t]?.stroke || "#7fff6e" : "#44445a",
    padding: "4px 10px", fontSize: 10,
  });
  const TLABEL = { file: "FILE", class: "CLASS", function: "FUNCTION" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0a0f", zIndex: 9999, display: "flex", flexDirection: "column" }}>

      {/* ── header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: "#e8e8f0", letterSpacing: "-0.02em" }}>Knowledge Graph</span>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#44445a" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
          {stats && (
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#2a2a3a" }}>
              {stats.nodes} symbols · {stats.edges} connections
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search symbols…"
            style={{ background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, padding: "5px 12px", color: "#e8e8f0", fontFamily: "JetBrains Mono, monospace", fontSize: 11, outline: "none", width: 200 }}
            onFocus={e => e.target.style.borderColor = "#7fff6e"}
            onBlur={e => e.target.style.borderColor = "#1e1e2e"} />
          <button onClick={onClose} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#ff6b6b"; e.currentTarget.style.color = "#ff6b6b"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>
            ✕ Close
          </button>
        </div>
      </div>

      {/* ── toolbar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 24px", borderBottom: "1px solid #1e1e2e", flexShrink: 0 }}>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#44445a", marginRight: 4 }}>FILTER:</span>
        {["all", "file", "class", "function"].map(t => (
          <button key={t} style={filterBtn(t)} onClick={() => setFilterType(t)}
            onMouseEnter={e => { if (filterType !== t) e.currentTarget.style.borderColor = "#444"; }}
            onMouseLeave={e => { if (filterType !== t) e.currentTarget.style.borderColor = "#1e1e2e"; }}>
            {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1) + "s"}
          </button>
        ))}
        <div style={{ display: "flex", gap: 16, marginLeft: 16 }}>
          {[["#7fff6e", "Files"], ["#4ef0c0", "Classes"], ["#6666aa", "Functions"]].map(([c, l]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: c, opacity: 0.7 }} />
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#44445a" }}>{l}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 14, borderTop: "1px dashed #2a2a3a" }} />
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#44445a" }}>contains</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 14, borderTop: "1.5px solid #3a3a6a" }} />
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#44445a" }}>calls</span>
          </div>
        </div>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#2a2a3a", marginLeft: "auto" }}>
          click node · scroll to zoom · drag to pan
        </span>
      </div>

      {/* ── main ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* graph canvas */}
        <div style={{ flex: 1, position: "relative" }}>
          {loading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#888899", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }}>
              <div>
                <div style={{ marginBottom: 8 }}>Building knowledge graph…</div>
                <div style={{ fontSize: 10, color: "#44445a", textAlign: "center" }}>This may take a moment</div>
              </div>
            </div>
          )}
          {error && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ff6b6b", fontFamily: "JetBrains Mono, monospace", fontSize: 13, padding: 40, textAlign: "center" }}>
              {error}
            </div>
          )}
          <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />

          {/* zoom controls */}
          {!loading && !error && (
            <div style={{ position: "absolute", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                ["+", () => d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1.4)],
                ["⊙", () => { resetHighlight(); setSelected(null); setSearch(""); setFilterType("all"); fitGraph(gRef.current, d3.select(svgRef.current), zoomRef.current, svgRef.current.clientWidth, svgRef.current.clientHeight); }],
                ["−", () => d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 0.7)],
              ].map(([label, fn]) => (
                <button key={label} onClick={fn} style={{ background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, width: 32, height: 32, color: "#888899", fontSize: label === "⊙" ? 14 : 18, cursor: "pointer", display: "grid", placeItems: "center", fontFamily: "monospace" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── side panel ── */}
        {selected ? (
          <div style={{ width: 360, borderLeft: "1px solid #1e1e2e", display: "flex", flexDirection: "column", flexShrink: 0, background: "#0a0a0f" }}>

            {/* node identity */}
            <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid #1e1e2e" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "0.1em", color: TYPE[selected.type]?.stroke, background: "#0a0a0f", border: `1px solid ${TYPE[selected.type]?.stroke}`, borderRadius: 3, padding: "2px 7px" }}>
                  {TLABEL[selected.type]}
                </span>
                <button onClick={() => { setSelected(null); resetHighlight(); }} style={{ ...btnStyle, marginLeft: "auto", padding: "2px 8px" }}>✕</button>
              </div>
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 15, color: TYPE[selected.type]?.stroke, fontWeight: 600, wordBreak: "break-all", marginBottom: 6 }}>
                {selected.label}
              </div>
              {selected.file && selected.type !== "file" && (
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#44445a" }}>
                  in {selected.file} {selected.line ? `· line ${selected.line}` : ""}
                </div>
              )}
            </div>

            {/* details scroll area */}
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>

              {selected.docstring && (
                <Section label="DOCSTRING">
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#888899", background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, padding: "10px 12px", lineHeight: 1.7 }}>
                    {selected.docstring}
                  </div>
                </Section>
              )}

              {selected.args?.length > 0 && (
                <Section label="PARAMETERS">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {selected.args.map(a => (
                      <span key={a} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#4ef0c0", background: "#0a0a0f", border: "1px solid #1e2e2e", borderRadius: 3, padding: "2px 8px" }}>
                        {a}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {selected.methods?.length > 0 && (
                <Section label={`METHODS (${selected.methods.length})`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {selected.methods.map(m => (
                      <div key={m.name} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, padding: "6px 0", borderBottom: "1px solid #111118", display: "flex", alignItems: "baseline", gap: 4 }}>
                        <span style={{ color: "#7fff6e" }}>{m.name}</span>
                        {m.args?.length > 0 && <span style={{ color: "#44445a", fontSize: 10 }}>({m.args.filter(a => a !== "self").join(", ")})</span>}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* ask section */}
              <Section label={`ASK ABOUT THIS ${TLABEL[selected.type]}`}>
                <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                  <input value={question} onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && askAboutNode()}
                    placeholder="What does this do?"
                    style={{ flex: 1, background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, padding: "7px 10px", color: "#e8e8f0", fontFamily: "JetBrains Mono, monospace", fontSize: 11, outline: "none" }}
                    onFocus={e => e.target.style.borderColor = "#7fff6e"}
                    onBlur={e => e.target.style.borderColor = "#1e1e2e"} />
                  <button onClick={askAboutNode} disabled={asking}
                    style={{ background: asking ? "#1e1e2e" : "#7fff6e", color: "#0a0a0f", border: "none", borderRadius: 4, padding: "7px 14px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700, cursor: asking ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                    {asking ? "…" : "Ask →"}
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                  {["What does this do?", "What calls this?", "What does this return?", "Any issues here?"].map(q => (
                    <button key={q} onClick={() => setQuestion(q)}
                      style={{ ...btnStyle, fontSize: 10, padding: "3px 8px" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}>
                      {q}
                    </button>
                  ))}
                </div>
                {answer && (
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#c8c8d8", background: "#111118", border: "1px solid #1e1e2e", borderRadius: 4, padding: "12px 14px", lineHeight: 1.8, whiteSpace: "pre-wrap", maxHeight: 280, overflow: "auto" }}>
                    {answer}
                  </div>
                )}
              </Section>
            </div>
          </div>
        ) : (
          /* empty state hint */
          !loading && !error && (
            <div style={{ width: 260, borderLeft: "1px solid #1e1e2e", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, flexShrink: 0 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>◎</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#2a2a3a", lineHeight: 1.7 }}>
                  Click any node to inspect its details and ask questions about it
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#44445a", letterSpacing: "0.1em", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}