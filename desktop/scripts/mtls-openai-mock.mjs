import * as fs from "node:fs";
import * as https from "node:https";

const host = process.env.UMBRATIC_MTLS_MOCK_HOST || "localhost";
const port = Number(process.env.UMBRATIC_MTLS_MOCK_PORT || "9443");
const certDir = process.env.UMBRATIC_MTLS_CERT_DIR || ".umbratic/mtls-local";
const passphrase = process.env.UMBRATIC_MTLS_PASSPHRASE || "umbratic-local-mtls";
const model = process.env.UMBRATIC_MTLS_MOCK_MODEL || "umbratic-mtls-local";

const options = {
  pfx: fs.readFileSync(`${certDir}/server.pfx`),
  passphrase,
  ca: fs.readFileSync(`${certDir}/ca.pem`),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: "TLSv1.2",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = https.createServer(options, async (request, response) => {
  if (!request.client.authorized) {
    sendJson(response, 401, { error: request.client.authorizationError || "client certificate required" });
    return;
  }

  const url = new URL(request.url || "/", `https://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [{ id: model, object: "model" }] });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readJson(request);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const text = `mTLS local mock received ${body.messages?.length ?? 0} message(s).`;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

server.listen(port, host, () => {
  console.log(`Umbratic AI mTLS mock listening at https://${host}:${port}/v1`);
});
