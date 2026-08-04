import assert from "node:assert/strict";
import http from "node:http";

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function requestBody(request: http.IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk.toString("utf8");
  return body ? JSON.parse(body) : {};
}

const scenarioTable = [
  ["required-inspection", "REQUIRED_INSPECTION_RETRY"],
  ["lsp-degraded", "LSP_DEGRADED"],
  ["lsp-code-intelligence", "LSP_CODE_INTELLIGENCE"],
  ["read-file", "READ_FILE"],
  ["write-file", "WRITE_FILE"],
  ["block-network", "BLOCK_NETWORK"],
  ["rejected-command", "REJECTED_COMMAND"],
  ["approved-executable", "APPROVED_EXECUTABLE"],
  ["duplicate-ids", "DUPLICATE_IDS"],
  ["long-continuity", "LONG_CONTINUITY"],
  ["attachment-file", "ATTACHMENT_FILE"],
  ["recover-after-failures", "RECOVER_AFTER_FAILURES"],
  ["repeat-tool", "REPEAT_TOOL"],
  ["malformed-tool-syntax", "MALFORMED_TOOL_SYNTAX"],
  ["missing-done", "MISSING_DONE"],
  ["done-without-newline", "DONE_WITHOUT_NEWLINE"],
  ["split-utf8", "SPLIT_UTF8"],
] as const;

function scenarioName(encoded: string) {
  if (encoded.includes("what can you do and who are you")) return "streamed-direct-answer";
  return scenarioTable.find(([, marker]) => encoded.includes(marker))?.[0] ?? "default";
}

export async function startProvider() {
  const requests: Array<{ path?: string; body: Record<string, unknown>; authorization?: string; contentType?: string }> = [];
  const server = http.createServer(async (request, response) => {
    const body = await requestBody(request) as Record<string, unknown>;
    requests.push({
      path: request.url,
      body,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
    });
    if (request.url === "/api/internal/context/compact") {
      const source = JSON.stringify(body.messages ?? []);
      const recalledFacts = Array.from(source.matchAll(/(?:PRIOR_FAILURE|CHANGED_FILE|LAST_VERIFICATION)_\d+/g), (match) => match[0]);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        summary: [
          "## Goal and current request", recalledFacts.join(" "),
          "## Constraints and decisions", "Keep context bounded and factual.",
          "## Work completed", "Prior work is compacted.",
          "## Files and verification", recalledFacts.join(" "),
          "## Errors or blockers", "Preserve recorded failures.",
          "## Next work", "Continue from the latest request.",
          "bounded factual summary ".repeat(20),
        ].join("\n"),
        sourceDigest: body.sourceDigest,
      }));
      return;
    }
    const encoded = JSON.stringify(body.messages ?? []);
    const scenario = scenarioName(encoded);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-Umbratic-Stream-Version": "2",
    });
    if (scenario === "required-inspection") {
      response.end(sse({ choices: [{ delta: { content: "I can explain this directly without changing or inspecting the workspace." } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "lsp-degraded" && !encoded.includes("freshness")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "lsp-degraded-1",
        function: { name: "lsp", arguments: "{\"action\":\"hover\",\"path\":\"main.ts\",\"line\":1,\"character\":1}" },
      }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "lsp-code-intelligence" && !encoded.includes("freshness")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [
        {
          index: 0,
          id: "lsp-definition-1",
          function: { name: "lsp", arguments: "{\"action\":\"definition\",\"path\":\"main.ts\",\"line\":2,\"character\":16}" },
        },
        {
          index: 1,
          id: "lsp-references-1",
          function: { name: "lsp", arguments: "{\"action\":\"references\",\"path\":\"main.ts\",\"line\":2,\"character\":16}" },
        },
        {
          index: 2,
          id: "lsp-hover-1",
          function: { name: "lsp", arguments: "{\"action\":\"hover\",\"path\":\"main.ts\",\"line\":2,\"character\":16}" },
        },
        {
          index: 3,
          id: "lsp-symbols-1",
          function: { name: "lsp", arguments: "{\"action\":\"symbols\",\"path\":\"main.ts\"}" },
        },
      ] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "read-file" && !encoded.includes("read: README.md (ok)")) {
      response.end(sse({ choices: [{ delta: {
        content: "I will read the requested file before I answer.",
        reasoning_content: "RAW_REASONING_MARKER",
        tool_calls: [{ index: 0, id: "read-1", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":2}" } }],
      } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "write-file" && !encoded.includes("write: note.txt (ok)")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write-1", function: { name: "write", arguments: "{\"path\":\"note.txt\",\"content\":\"native write\\n\"}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "block-network" && !encoded.includes("policy_blocked")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "command-1", function: { name: "command", arguments: "{\"command\":\"curl https://example.com; printf spawned > blocked-command-spawned.txt\"}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "rejected-command" && !encoded.toLowerCase().includes("user rejected")) {
      response.end(sse({ choices: [{ delta: { content: "I will request approval before I run this command.", tool_calls: [{ index: 0, id: "rejected-command-1", function: { name: "command", arguments: "{\"command\":\"echo should-not-run > rejected-command.txt\"}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "rejected-command") {
      response.end(sse({ choices: [{ delta: { content: "The command was rejected and was not run." } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "approved-executable" && !encoded.includes("approved-runtime-ok")) {
      response.end(sse({ choices: [{ delta: { content: "I will use the declared runtime and report its result.", tool_calls: [{
        index: 0,
        id: "approved-command-1",
        function: {
          name: "run_program",
          arguments: JSON.stringify({
            programId: "node",
            args: ["-e", "console.log('approved-runtime-ok')"],
          }),
        },
      }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "duplicate-ids" && !encoded.includes("a unique id for each tool call")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "duplicate", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":1}" } },
        { index: 1, id: "duplicate", function: { name: "read", arguments: "{\"path\":\"README.md\",\"offset\":2,\"limit\":1}" } },
      ] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "duplicate-ids" && !encoded.includes("read: README.md (ok)")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "duplicate-fixed-1", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":1}" } },
        { index: 1, id: "duplicate-fixed-2", function: { name: "read", arguments: "{\"path\":\"README.md\",\"offset\":2,\"limit\":1}" } },
      ] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "long-continuity") {
      const completed = new Set(
        Array.from(encoded.matchAll(/read: file-(\d+)\.txt \(ok\)/g), (match) => Number(match[1])),
      );
      if (completed.size < 35) {
        const index = completed.size;
        response.end(sse({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: `continuity-${index}`,
          function: { name: "read", arguments: JSON.stringify({ path: `file-${index}.txt` }) },
        }] } }] }) + "data: [DONE]\n\n");
      } else {
        response.end(sse({ choices: [{ delta: { content: "Continuity retained file-0.txt and file-34.txt." } }] }) + "data: [DONE]\n\n");
      }
    } else if (scenario === "attachment-file" && !encoded.includes("Read status: complete")) {
      const offsets = Array.from(encoded.matchAll(/continue with offset (\d+)/g), (match) => Number(match[1]));
      const offset = offsets.at(-1) ?? 0;
      response.end(sse({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `attachment-${offset}`,
        function: { name: "read_attachment", arguments: JSON.stringify({ attachmentId: "complete-plan.md", offset, limit: 1024 }) },
      }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "recover-after-failures" && Array.isArray(body.tools)) {
      const failedAttempts = new Set(
        Array.from(encoded.matchAll(/missing-(\d+)\.txt/g), (match) => match[1]),
      ).size;
      if (failedAttempts < 9) {
        response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `recover-${failedAttempts}`, function: { name: "read", arguments: JSON.stringify({ path: `missing-${failedAttempts}.txt` }) } }] } }] }) + "data: [DONE]\n\n");
      } else if (!encoded.includes("read: README.md (ok)")) {
        response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "recover-success", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":1}" } }] } }] }) + "data: [DONE]\n\n");
      } else {
        response.end(sse({ choices: [{ delta: { content: "Recovered after distinct failures." } }] }) + "data: [DONE]\n\n");
      }
    } else if (scenario === "recover-after-failures") {
      response.end(sse({ choices: [{ delta: { content: "Recovered after distinct failures." } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "repeat-tool" && Array.isArray(body.tools)) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "repeat", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":1}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "repeat-tool") {
      response.end(sse({ choices: [{ delta: { content: "<|toolcall>call:command{programId:'python3'}<toolcall|>" } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "malformed-tool-syntax" && !encoded.includes("raw tool syntax")) {
      response.end(sse({ choices: [{ delta: { content: "<|tool*call>call:read{path:'README.md'}<tool*call|>" } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "malformed-tool-syntax" && !encoded.includes("read: README.md (ok)")) {
      response.end(sse({ choices: [{ delta: { content: "I corrected the call and will inspect the workspace now.", tool_calls: [{ index: 0, id: "malformed-recovery-read", function: { name: "read", arguments: "{\"path\":\"README.md\",\"limit\":2}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "malformed-tool-syntax") {
      response.end(sse({ choices: [{ delta: { content: "Recovered from the malformed tool call." } }] }) + "data: [DONE]\n\n");
    } else if (scenario === "missing-done") {
      response.end(sse({ choices: [{ delta: { content: "incomplete" } }] }));
    } else if (scenario === "done-without-newline") {
      response.end(sse({ choices: [{ delta: { content: "complete without newline" } }] }) + "data:[DONE]");
    } else if (scenario === "streamed-direct-answer") {
      response.write(sse({ choices: [{ delta: { content: "Hello " } }] }));
      setTimeout(() => {
        response.end(sse({ choices: [{ delta: { content: "there." } }] }) + "data: [DONE]\n\n");
      }, 40);
    } else if (scenario === "split-utf8") {
      const payload = Buffer.from(sse({ choices: [{ delta: { content: "café" } }] }) + "data: [DONE]\n\n", "utf8");
      const marker = Buffer.from("é", "utf8");
      const markerIndex = payload.indexOf(marker);
      response.write(payload.subarray(0, markerIndex + 1));
      setImmediate(() => response.end(payload.subarray(markerIndex + 1)));
    } else {
      response.end(sse({ choices: [{ delta: { content: "Native runner complete." } }] }) + sse({ choices: [], usage: { prompt_tokens: 16, completion_tokens: 4 } }) + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
