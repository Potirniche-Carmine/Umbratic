import { useEffect, useState } from "react";
import { Download, Image, Loader2 } from "lucide-react";
import type { ChatAttachment, DesktopApi } from "../shared/desktopApi";
import type { ComposerTimelineItem } from "./rendererTypes";
import type { CommandRun } from "./commandDisplay";

type PreviewImage = (image: ChatAttachment) => void;

function GeneratedImage({ api, taskId, run, onPreview }: { api: DesktopApi; taskId: string; run: CommandRun; onPreview: PreviewImage }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const file = typeof run.details?.path === "string" ? run.details.path : "";
  const name = file.split(/[\\/]/).pop() || "Generated image";
  useEffect(() => {
    if (run.status !== "passed" || !file) return;
    let current = true;
    void api.readGeneratedImage({ taskId, path: file }).then((result) => {
      if (current) { setDataUrl(result.dataUrl); setLoaded(true); }
    }, () => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, [api, file, taskId, run.status]);
  return <figure className="generatedImageCard">
    {dataUrl ? <button className="generatedImagePreview" type="button" aria-label={`Preview ${name}`}
      onClick={() => onPreview({ path: file, name, kind: "file", previewDataUrl: dataUrl })}>
      <img src={dataUrl} alt={name} />
    </button> : <div className="generatedImagePlaceholder" role="status">
      {run.status === "running" ? <Loader2 size={24} className="spin" /> : <Image size={24} />}
      <span>{run.status === "running" ? "Creating your image…" : run.status === "failed" ? "Image generation failed" : loaded || !file ? "Image preview unavailable" : "Loading image…"}</span>
      {run.status === "failed" ? <small>{run.stderr || "Try again with a smaller image."}</small> : null}
    </div>}
    <figcaption><Image size={14} /><span>{file ? name : "Image generation"}</span>
      {dataUrl ? <a href={dataUrl} download={name} aria-label="Save image" title="Save image"><Download size={16} /></a> : null}
    </figcaption>
  </figure>;
}

export function GeneratedImages({ api, taskId, item, onPreview }: { api: DesktopApi; taskId: string; item: Extract<ComposerTimelineItem, { type: "activity" }>; onPreview: PreviewImage }) {
  return <>{item.segments.filter((segment) => segment.type === "command" && segment.run.toolKind === "generate_image").map((segment) =>
    segment.type === "command" ? <GeneratedImage key={segment.id} api={api} taskId={taskId} run={segment.run} onPreview={onPreview} /> : null)}</>;
}
