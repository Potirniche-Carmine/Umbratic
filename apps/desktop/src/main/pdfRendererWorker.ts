import * as fs from "node:fs";
import * as path from "node:path";

type PdfRenderRequest = {
  filePath: string;
  outputDir: string;
  pageLimit: number;
  scale: number;
  byteLimit: number;
};

type PdfRenderResult =
  | { ok: true; pageCount: number; pages: Array<{ pageNumber: number; filePath: string }> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requestFromMessage(message: unknown): PdfRenderRequest {
  if (!isRecord(message)) {
    throw new Error("Invalid PDF render request.");
  }
  const filePath = typeof message.filePath === "string" ? message.filePath : "";
  const outputDir = typeof message.outputDir === "string" ? message.outputDir : "";
  const pageLimit = typeof message.pageLimit === "number" ? Math.floor(message.pageLimit) : 0;
  const scale = typeof message.scale === "number" ? message.scale : 0;
  const byteLimit = typeof message.byteLimit === "number" ? Math.floor(message.byteLimit) : 0;
  if (!filePath || !outputDir || pageLimit < 1 || pageLimit > 50 || scale <= 0 || scale > 4 || byteLimit < 1) {
    throw new Error("Invalid PDF render request.");
  }
  return { filePath, outputDir, pageLimit, scale, byteLimit };
}

function sendAndExit(result: PdfRenderResult, code: number) {
  if (process.send) {
    process.send(result, () => process.exit(code));
    return;
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(code);
}

async function renderPdf(message: unknown): Promise<PdfRenderResult> {
  const request = requestFromMessage(message);
  const stat = fs.statSync(request.filePath);
  if (!stat.isFile() || stat.size > request.byteLimit) {
    throw new Error("PDF file is not renderable.");
  }
  fs.mkdirSync(request.outputDir, { recursive: true });

  const { pdf } = await import("pdf-to-img");
  const document = await pdf(request.filePath, { scale: request.scale });
  try {
    const rendered = Math.min(document.length, request.pageLimit);
    const pages: Array<{ pageNumber: number; filePath: string }> = [];
    for (let pageNumber = 1; pageNumber <= rendered; pageNumber += 1) {
      const png = await document.getPage(pageNumber);
      const pagePath = path.join(request.outputDir, `page-${pageNumber}.png`);
      fs.writeFileSync(pagePath, png);
      pages.push({ pageNumber, filePath: pagePath });
    }
    return { ok: true, pageCount: document.length, pages };
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

process.once("message", (message: unknown) => {
  renderPdf(message)
    .then((result) => sendAndExit(result, result.ok ? 0 : 1))
    .catch((error: unknown) => sendAndExit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1));
});
