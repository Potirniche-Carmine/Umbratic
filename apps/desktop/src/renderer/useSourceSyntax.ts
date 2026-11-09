import { useEffect, useMemo, useState } from "react";
import sourceWorkerUrl from "./sourceSyntax.worker.ts?worker&url";
import { SyntaxRequests } from "./syntaxRequests";
import type { SyntaxDocument, SyntaxResults } from "./syntaxTypes";

const requests = new SyntaxRequests(() => new Worker(sourceWorkerUrl, { type: "module" }));

export function useSourceSyntax(documents: SyntaxDocument[]): SyntaxResults | null {
  const key = JSON.stringify(documents);
  // Keep the last completed tokens while streaming. SourceTokens checks every
  // line against its current text, so changed lines cannot show stale content.
  const [snapshot, setSnapshot] = useState<{ documents: SyntaxDocument[]; results: SyntaxResults }>();
  useEffect(() => {
    let cancelled = false;
    const request = requests.request(documents);
    void request.promise.then(results => { if (!cancelled && results) setSnapshot({ documents, results }); });
    return () => { cancelled = true; request.cancel(); };
  }, [key]);
  return useMemo(() => {
    if (!snapshot || snapshot.documents.length !== documents.length) return null;
    return documents.map((document, index) => {
      const prior = snapshot.documents[index];
      return document.path === prior.path && document.language === prior.language ? snapshot.results[index] : null;
    });
  }, [snapshot, key]);
}
