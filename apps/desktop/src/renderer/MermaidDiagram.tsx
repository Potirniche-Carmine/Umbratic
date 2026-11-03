import React, { useEffect, useRef, useState } from "react";
import { Code, Copy, Check } from "lucide-react";
import { copyPlainText } from "./copyPlainText";

// Mermaid has global configuration. Serialize renders so themes and temporary
// measurement nodes cannot race across simultaneous streamed diagrams.
let rendering = Promise.resolve();
export function MermaidDiagram({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(() => typeof document === "undefined" ? "dark" : document.documentElement.dataset?.theme || "dark");
  const current = useRef(0);
  const imageUrl = useRef("");
  useEffect(() => () => { if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); }, []);
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
            secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "flowchart", "theme", "themeCSS", "themeVariables", "fontFamily"],
            maxTextSize: 40_000, maxEdges: 300, htmlLabels: false,
            theme: theme === "dark" ? "dark" : "neutral", fontFamily: "system-ui, sans-serif",
            flowchart: { htmlLabels: false, useMaxWidth: true, nodeSpacing: 60, rankSpacing: 100, wrappingWidth: 160 },
          });
          const result = await mermaid.render(`diagram-${crypto.randomUUID()}`, content, container);
          if (generation !== current.current) return;
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
    </div>
    {source || failed ? <><pre className="markdownCode"><code>{content}</code></pre>{failed && <span className="markdownDiagramError">Couldn’t render this diagram.</span>}</> : image ? <img src={image} alt="Diagram"/> : <div className="markdownDiagramPending" role="status" aria-label="Rendering diagram"/>}
  </figure>;
}
