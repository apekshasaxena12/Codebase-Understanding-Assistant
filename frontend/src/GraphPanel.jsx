import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

export default function GraphPanel({ repoId, repoUrl, onClose }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [copied, setCopied] = useState(false);
  const simulationRef = useRef(null);
  const graphDataRef = useRef(null);

  const renderGraph = useCallback((data, width, height) => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // categorize nodes
    const stdlibs = new Set(["os", "sys", "re", "json", "time", "csv", "math", "io", "abc", "copy", "datetime", "collections", "itertools", "functools", "pathlib", "typing", "uuid", "tempfile", "ast"]);
    const getNodeType = (id) => {
      if (id.endsWith(".py")) return "local";
      if (stdlibs.has(id.replace(".py", ""))) return "stdlib";
      return "external";
    };

    const nodeColors = {
      local: { fill: "#111118", stroke: "#7fff6e", label: "#7fff6e" },
      stdlib: { fill: "#111118", stroke: "#4ef0c0", label: "#4ef0c0" },
      external: { fill: "#111118", stroke: "#888899", label: "#888899" },
    };

    // compute node degrees for sizing
    const degree = {};
    data.nodes.forEach(n => { degree[n.id] = 0; });
    data.edges.forEach(e => {
      degree[e.source] = (degree[e.source] || 0) + 1;
      degree[e.target] = (degree[e.target] || 0) + 1;
    });
    const maxDegree = Math.max(...Object.values(degree), 1);
    const nodeRadius = (id) => 14 + (degree[id] / maxDegree) * 14;

    const g = svg.append("g");

    // zoom
    const zoom = d3.zoom()
      .scaleExtent([0.2, 4])
      .on("zoom", e => g.attr("transform", e.transform));
    svg.call(zoom);

    // arrow marker
    const defs = svg.append("defs");
    ["local", "stdlib", "external"].forEach(type => {
      defs.append("marker")
        .attr("id", `arrow-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 28)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", nodeColors[type].stroke)
        .attr("opacity", 0.5);
    });

    const nodes = data.nodes.map(d => ({ ...d }));
    const edges = data.edges.map(d => ({ ...d }));

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id(d => d.id).distance(d => {
        const sourceType = getNodeType(d.source.id || d.source);
        return sourceType === "local" ? 150 : 200;
      }))
      .force("charge", d3.forceManyBody().strength(-600))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide(d => nodeRadius(d.id) + 10));

    simulationRef.current = simulation;

    // edges
    const link = g.append("g").selectAll("line")
      .data(edges).enter().append("line")
      .attr("stroke", d => {
        const type = getNodeType(d.target.id || d.target);
        return nodeColors[type].stroke;
      })
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.3)
      .attr("marker-end", d => {
        const type = getNodeType(d.target.id || d.target);
        return `url(#arrow-${type})`;
      });

    // node groups
    const node = g.append("g").selectAll("g")
      .data(nodes).enter().append("g")
      .style("cursor", "pointer")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    // glow filter
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // outer glow ring (for local files)
    node.filter(d => getNodeType(d.id) === "local")
      .append("circle")
      .attr("r", d => nodeRadius(d.id) + 4)
      .attr("fill", "none")
      .attr("stroke", "#7fff6e")
      .attr("stroke-width", 0.5)
      .attr("stroke-opacity", 0.2)
      .attr("filter", "url(#glow)");

    // main circle
    node.append("circle")
      .attr("r", d => nodeRadius(d.id))
      .attr("fill", d => nodeColors[getNodeType(d.id)].fill)
      .attr("stroke", d => nodeColors[getNodeType(d.id)].stroke)
      .attr("stroke-width", 1.5)
      .on("mouseover", function(e, d) {
        d3.select(this)
          .attr("stroke-width", 2.5)
          .attr("filter", "url(#glow)");
        // highlight connected edges
        link.attr("stroke-opacity", l =>
          (l.source.id === d.id || l.target.id === d.id) ? 0.9 : 0.05
        ).attr("stroke-width", l =>
          (l.source.id === d.id || l.target.id === d.id) ? 2 : 1
        );
        const deps = edges.filter(l => l.source.id === d.id).map(l => l.target.id);
        const used_by = edges.filter(l => l.target.id === d.id).map(l => l.source.id);
        setTooltip({ x: e.offsetX, y: e.offsetY, id: d.id, deps, used_by });
      })
      .on("mouseout", function(e, d) {
        d3.select(this).attr("stroke-width", 1.5).attr("filter", null);
        link.attr("stroke-opacity", 0.3).attr("stroke-width", 1);
        setTooltip(null);
      });

    // labels
    node.append("text")
      .text(d => d.id.replace(".py", ""))
      .attr("text-anchor", "middle")
      .attr("dy", d => nodeRadius(d.id) + 14)
      .attr("fill", d => nodeColors[getNodeType(d.id)].label)
      .attr("font-size", d => getNodeType(d.id) === "local" ? 11 : 10)
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-weight", d => getNodeType(d.id) === "local" ? "500" : "400")
      .attr("pointer-events", "none");

    simulation.on("tick", () => {
      link
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // auto-fit after simulation settles
    simulation.on("end", () => {
      const bounds = g.node().getBBox();
      const padding = 120;
      const scale = Math.min(
        (width - padding * 2) / bounds.width,
        (height - padding * 2) / bounds.height,
        0.9
      );
      const tx = (width - bounds.width * scale) / 2 - bounds.x * scale;
      const ty = (height - bounds.height * scale) / 2 - bounds.y * scale;
      svg.transition().duration(600)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    });
  }, []);

  useEffect(() => {
    async function fetchAndRender() {
      try {
        const res = await fetch(`${API}/graph/${repoId}`);
        const data = await res.json();
        graphDataRef.current = data;
        setStats({ nodes: data.nodes.length, edges: data.edges.length });

        const width = svgRef.current.clientWidth;
        const height = svgRef.current.clientHeight;
        renderGraph(data, width, height);
        setLoading(false);
      } catch (e) {
        setError("Failed to load graph. Try re-ingesting the repo.");
        setLoading(false);
      }
    }
    fetchAndRender();

    return () => { if (simulationRef.current) simulationRef.current.stop(); };
  }, [repoId, renderGraph]);

  function downloadSVG() {
    const svg = svgRef.current;
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);
    // add font
    source = source.replace('<svg', `<svg xmlns:xlink="http://www.w3.org/1999/xlink"`);
    const style = `<style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap'); text { font-family: 'JetBrains Mono', monospace; }</style>`;
    source = source.replace('</svg>', `${style}</svg>`);
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dependency-graph-${repoUrl.split("/").pop()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPNG() {
    const svg = svgRef.current;
    const cloned = svg.cloneNode(true);
    // get full content bounds
    const g = svg.querySelector("g");
    const bbox = g ? g.getBBox() : { x: 0, y: 0, width: 800, height: 600 };
    const pad = 40;
    const w = bbox.width + pad * 2;
    const h = bbox.height + pad * 2;
    cloned.setAttribute("width", w);
    cloned.setAttribute("height", h);
    cloned.setAttribute("viewBox", `${bbox.x - pad} ${bbox.y - pad} ${w} ${h}`);
    cloned.querySelectorAll("style").forEach(s => {
      s.textContent = s.textContent.replace(/@import[^;]+;/g, "");
    });
    const svgStr = new XMLSerializer().serializeToString(cloned);
    const encoded = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
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
      a.download = `dependency-graph-${repoUrl.split("/").pop()}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    };
    img.src = encoded;
  }

  async function copyAsDot() {
    if (!graphDataRef.current) return;
    const { nodes, edges } = graphDataRef.current;
    const lines = [
      'digraph dependencies {',
      '  rankdir=LR;',
      '  node [shape=box, fontname="monospace"];',
      ...edges.map(e => `  "${e.source}" -> "${e.target}";`),
      '}'
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "#0a0a0f",
      zIndex: 9999,
      display: "flex",
      flexDirection: "column",
    }}>
      {/* header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 24px",
        borderBottom: "1px solid #1e1e2e",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "-0.02em" }}>Dependency Graph</span>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#888899" }}>
            {repoUrl.replace("https://github.com/", "")}
          </span>
          {stats && (
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#44445a" }}>
              {stats.nodes} files · {stats.edges} imports
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
            onClick={downloadSVG}>↓ SVG</button>
          <button style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#7fff6e"; e.currentTarget.style.color = "#7fff6e"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
            onClick={downloadPNG}>↓ PNG</button>
          <button style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#4ef0c0"; e.currentTarget.style.color = "#4ef0c0"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
            onClick={copyAsDot}>
            {copied ? "✓ Copied!" : "Copy DOT"}
          </button>
          <button onClick={onClose} style={{ ...btnStyle, borderColor: "#1e1e2e" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#ff6b6b"; e.currentTarget.style.color = "#ff6b6b"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888899"; }}
          >✕ Close</button>
        </div>
      </div>

      {/* legend */}
      <div style={{
        display: "flex", gap: 24, alignItems: "center",
        padding: "8px 24px",
        borderBottom: "1px solid #1e1e2e",
        flexShrink: 0,
      }}>
        {[
          ["#7fff6e", "your .py files (size = connections)"],
          ["#4ef0c0", "stdlib modules"],
          ["#888899", "external libraries"],
        ].map(([color, label]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${color}` }} />
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#44445a" }}>{label}</span>
          </div>
        ))}
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#2a2a3a", marginLeft: "auto" }}>
          scroll to zoom · drag to pan · drag nodes · hover to highlight
        </span>
      </div>

      {/* graph area */}
      <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#888899", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }}>
            Building graph…
          </div>
        )}
        {error && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ff6b6b", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }}>
            {error}
          </div>
        )}
        <svg ref={svgRef} style={{ width: "100%", height: "100%", display: loading || error ? "none" : "block" }} />

        {/* hover tooltip */}
        {tooltip && (
          <div style={{
            position: "absolute",
            left: Math.min(tooltip.x + 16, window.innerWidth - 220),
            top: Math.min(tooltip.y + 16, window.innerHeight - 200),
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 6,
            padding: "10px 14px",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11,
            pointerEvents: "none",
            zIndex: 10,
            minWidth: 180,
          }}>
            <div style={{ color: "#7fff6e", fontWeight: 500, marginBottom: 6 }}>{tooltip.id}</div>
            {tooltip.deps.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: "#44445a" }}>imports: </span>
                <span style={{ color: "#e8e8f0" }}>{tooltip.deps.slice(0, 5).join(", ")}{tooltip.deps.length > 5 ? ` +${tooltip.deps.length - 5}` : ""}</span>
              </div>
            )}
            {tooltip.used_by.length > 0 && (
              <div>
                <span style={{ color: "#44445a" }}>used by: </span>
                <span style={{ color: "#4ef0c0" }}>{tooltip.used_by.slice(0, 5).join(", ")}{tooltip.used_by.length > 5 ? ` +${tooltip.used_by.length - 5}` : ""}</span>
              </div>
            )}
            {tooltip.deps.length === 0 && tooltip.used_by.length === 0 && (
              <div style={{ color: "#44445a" }}>no connections</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}