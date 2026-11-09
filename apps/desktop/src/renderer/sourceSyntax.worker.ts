import { highlightSource } from "./sourceSyntax";
import type { SyntaxRequest, SyntaxResults } from "./syntaxTypes";

// Grammars and tokenization stay off the UI thread. Nothing leaves the device.
self.onmessage = async (event: MessageEvent<SyntaxRequest>) => {
  const results: SyntaxResults = [];
  for (const document of event.data.documents) {
    try { results.push(await highlightSource(document.path || "", document.text, document.language)); }
    catch { results.push(null); }
  }
  self.postMessage({ id: event.data.id, results });
};
