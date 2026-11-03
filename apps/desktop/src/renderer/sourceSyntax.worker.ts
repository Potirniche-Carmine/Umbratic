import { highlightSource } from "./sourceSyntax";

// Grammars and tokenization stay off the UI thread. Nothing leaves the device.
self.onmessage = async (event: MessageEvent<{ path: string; text: string }>) => {
  try { self.postMessage(await highlightSource(event.data.path, event.data.text)); }
  catch { self.postMessage(null); } // Unsupported grammars still show readable source.
};
