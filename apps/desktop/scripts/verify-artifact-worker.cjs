// Run by verify-package with Electron so the archived service and its real
// utility process are exercised, including startup and the message round trip.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const [archive, workspaceRoot] = process.argv.slice(2);
app.setPath("userData", path.join(workspaceRoot, "electron-data"));
app.whenReady().then(async () => {
  try {
    const { runArtifactJob, localTransport } = require(path.join(archive, "dist-electron/main/artifacts/service.js"));
    const out = ".umbratic/artifacts/docx/package-smoke.docx";
    const absoluteOut = path.join(workspaceRoot, out);
    const created = await runArtifactJob({
      artifactId: "package-create",
      action: "create",
      format: "docx",
      out,
      absoluteOut,
      spec: { blocks: [{ type: "paragraph", text: "Packaged document worker verification." }] },
      timeoutMs: 8_000,
    }, localTransport(workspaceRoot));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(fs.statSync(absoluteOut).size > 0);
    const inspected = await runArtifactJob({
      artifactId: "package-inspect",
      action: "inspect",
      format: "docx",
      path: out,
      absolutePath: absoluteOut,
      timeoutMs: 8_000,
    }, localTransport(workspaceRoot));
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.outline.blocks.length, 1);
    console.log("Packaged document worker created and inspected a DOCX.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
