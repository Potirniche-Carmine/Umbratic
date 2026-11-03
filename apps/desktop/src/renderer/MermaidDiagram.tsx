import React, { useEffect, useRef, useState } from "react";
import { Code, Copy, Check, Maximize2, Minus, Plus, X } from "lucide-react";
import { copyPlainText } from "./copyPlainText";

// Mermaid has global configuration. Serialize renders so themes and temporary
// measurement nodes cannot race across simultaneous streamed diagrams.
let rendering = Promise.resolve();
export function MermaidDiagram({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [size, setSize] = useState({ width: 600, height: 240 });
  const [availableWidth, setAvailableWidth] = useState(720);
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const expanded = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState(() => typeof document === "undefined" ? "dark" : document.documentElement.dataset?.theme || "dark");
  const current = useRef(0);
  const imageUrl = useRef("");
  useEffect(() => () => { if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); }, []);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => setAvailableWidth(entries[0].contentRect.width));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [image, source, failed]);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const generation = ++current.current;
    setFailed(false);
    const timer = window.setTimeout(() => {
      rendering = rendering.then(async () => {
        if (generation !== current.current) return;
        const container = document.createElement("div");
        container.className = "mermaidMeasure";
        document.body.append(container);
        try {
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
            secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "flowchart", "theme", "look", "themeCSS", "themeVariables", "fontFamily"],
            maxTextSize: 40_000, maxEdges: 300, htmlLabels: false,
            theme: "base", look: "classic", fontFamily: "system-ui, sans-serif",
            themeVariables: { darkMode: theme === "dark", fontSize: "15px", fontFamily: "system-ui, sans-serif",
              background: theme === "dark" ? "#161a20" : "#ffffff", primaryColor: theme === "dark" ? "#232e3b" : "#edf3fc",
              primaryTextColor: theme === "dark" ? "#e5ecf5" : "#233249", primaryBorderColor: theme === "dark" ? "#52647b" : "#a6b8d0",
              secondaryColor: theme === "dark" ? "#243730" : "#eaf5ee", tertiaryColor: theme === "dark" ? "#262c36" : "#f2f4f7",
              lineColor: theme === "dark" ? "#94a6bc" : "#667a94", edgeLabelBackground: theme === "dark" ? "#161a20" : "#ffffff" },
            themeCSS: ".node rect { rx: 9px; ry: 9px; } .node rect, .node polygon, .node circle { filter: none !important; stroke-width: 1px; } .edgeLabel { font-size: 13px; } .flowchart-link { stroke-width: 1.3px; }",
            flowchart: { htmlLabels: false, useMaxWidth: false, nodeSpacing: 44, rankSpacing: 54, wrappingWidth: 150, padding: 14, curve: "basis" },
          });
          let result = await mermaid.render(`diagram-${crypto.randomUUID()}`, content, container);
          const initialBox = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
          // Wide flowcharts read vertically in the conversation. Only the
          // presentation direction changes; source and relationships stay intact.
          if (initialBox && initialBox[2] > 900 && initialBox[2] / initialBox[3] > 2.5 && /^\s*(?:flowchart|graph)\s+(?:LR|RL)\b/m.test(content)) {
            const portrait = content.replace(/^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m, "$1TB");
            result = await mermaid.render(`diagram-${crypto.randomUUID()}`, portrait, container);
          }
          if (generation !== current.current) return;
          const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
          const box = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
          if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) setSize({ width: box[2], height: box[3] });
          // Display as an image: diagram markup, links, and styles cannot act
          // on the application document. No CDN or remote renderer is used.
          const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = url; setImage(url);
        } catch {
          if (generation === current.current && !streaming) { setImage(""); setFailed(true); }
        } finally { container.remove(); }
      });
    }, streaming ? 350 : 0);
    return () => { current.current++; clearTimeout(timer); };
  }, [content, theme, streaming]);
  return <figure className="markdownDiagram">
    <div className="markdownDiagramActions">
      <button type="button" title={source ? "Show diagram" : "Show source"} aria-label={source ? "Show diagram" : "Show diagram source"} aria-pressed={source} onClick={() => setSource(!source)}><Code size={14}/></button>
      <button type="button" title="Copy diagram source" aria-label="Copy diagram source" onClick={() => void copyPlainText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
      {image && <button type="button" title="Expand diagram" aria-label="Expand diagram" onClick={() => { setZoom(1); expanded.current?.showModal(); }}><Maximize2 size={14}/></button>}
    </div>
    {source || failed ? <><pre className="markdownCode"><code>{content}</code></pre>{failed && <span className="markdownDiagramError">Couldn’t render this diagram.</span>}</> : image ? <div ref={viewport} className="markdownDiagramViewport" tabIndex={0} aria-label="Diagram"><img src={image} alt="Diagram" style={{ width: Math.max(size.width * .85, Math.min(size.width, availableWidth)) }}/></div> : <div className="markdownDiagramPending" role="status" aria-label="Rendering diagram"/>}
    <dialog ref={expanded} className="diagramExpanded" aria-label="Expanded diagram" onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) expanded.current?.close(); } }}>
      <header><span>Diagram</span><button type="button" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={16}/></button><button type="button" className="diagramZoom" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + .25))}><Plus size={16}/></button><button type="button" aria-label="Close diagram" onClick={() => expanded.current?.close()}><X size={18}/></button></header>
      <div className="diagramExpandedCanvas" tabIndex={0}>{image && <img src={image} alt="Diagram" style={{ width: size.width * zoom, height: size.height * zoom }}/>}</div>
    </dialog>
  </figure>;
}
