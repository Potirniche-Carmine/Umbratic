import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { advisoryDigest, reviewArchiveAdvisories, verifyArchiveToolPin } from "../../../scripts/audit-archive-tool.ts";

const source = fs.readFileSync(new URL("../../../third_party/7zip.json", import.meta.url));
const pin = JSON.parse(source.toString());
const review = JSON.parse(fs.readFileSync(new URL("../../../third_party/7zip-security.json", import.meta.url), "utf8"));

test("full archive tool rejects changed pins, foreign origins and incomplete executable/license payloads", () => {
  verifyArchiveToolPin(pin, review, source);
  assert.throws(() => verifyArchiveToolPin(pin, review, Buffer.concat([source, Buffer.from(" ")])), /requires security review/);
  for (const change of [
    (value: any) => { value.source.url = "https://example.com/source.tar.xz"; },
    (value: any) => { delete value.targets["win32-arm64"]; },
    (value: any) => { value.targets["win32-x64"].url = "https://example.com/tool.exe"; },
    (value: any) => { delete value.targets["win32-arm64"].files["License.txt"]; },
    (value: any) => { value.targets["win32-x64"].files["extra.exe"] = "a".repeat(64); },
    (value: any) => { value.targets["win32-x64"].bytes = 3 * 1024 * 1024; },
  ]) {
    const changed = structuredClone(pin);
    change(changed);
    const bytes = Buffer.from(JSON.stringify(changed));
    // Even a new review hash cannot permit an arbitrary origin or payload.
    const updated = { ...review, pinSha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    assert.throws(() => verifyArchiveToolPin(changed, updated, bytes), /Unreviewed|Incomplete/);
  }
});

test("primary archive advisories fail on new, changed, removed, duplicate or partial records", () => {
  const cve = { id: "CVE-2026-14266", lastModified: "2026-10-01T00:00:00.000", descriptions: [{ lang: "en", value: "Fixed before the reviewed release." }] };
  const record = { id: cve.id, modified: cve.lastModified, sha256: advisoryDigest(cve), reason: "Reviewed fixed release." };
  const reviewed = { records: [record] };
  const data = { format: "NVD_CVE", version: "2.0", startIndex: 0, resultsPerPage: 1, totalResults: 1, vulnerabilities: [{ cve }] };
  reviewArchiveAdvisories(data, reviewed);
  for (const changed of [
    { ...data, totalResults: 2 },
    { ...data, startIndex: 1 },
    { ...data, error: "upstream error" },
    { ...data, error: "upstream error", vulnerabilities: undefined },
    { ...data, vulnerabilities: [{ cve: { ...cve, id: "CVE-2026-58052" } }] },
    { ...data, vulnerabilities: [{ cve: { ...cve, lastModified: "2026-10-02T00:00:00.000" } }] },
    { ...data, vulnerabilities: [{ cve: { ...cve, descriptions: [] } }] },
    { ...data, resultsPerPage: 0, totalResults: 0, vulnerabilities: [] },
    { ...data, resultsPerPage: 2, totalResults: 2, vulnerabilities: [{ cve }, { cve }] },
  ]) assert.throws(() => reviewArchiveAdvisories(changed, reviewed), /Incomplete|requires review|inventory changed/);
  assert.throws(() => reviewArchiveAdvisories(data, { records: [record, record] }), /Incomplete/);
  assert.throws(() => reviewArchiveAdvisories(data, { records: [{ ...record, reason: "" }] }), /requires review/);
});
