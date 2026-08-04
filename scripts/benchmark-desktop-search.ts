import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.env.UMBRATIC_BENCH_LABEL || "typescript";
const samples = Number(process.env.UMBRATIC_BENCH_SAMPLES || "30");
const outputPath = process.env.UMBRATIC_BENCH_OUTPUT ? path.resolve(process.env.UMBRATIC_BENCH_OUTPUT) : null;
const modulePath = path.join(root, "apps/desktop/dist-electron/main/fileSearch.js");

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function stats(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    mean: Number(mean.toFixed(3)),
    median: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    min: Number(Math.min(...values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
  };
}

async function main() {
  const loaded = await import(modulePath) as { searchRootFiles(rootPath: string, query: string, limit: number): Promise<Array<{ path: string; match: string }>> };
  const queries = ["runner", "workspace", "package", "policy", "review"];
  const timings: number[] = [];
  let resultCount = 0;
  let checksum = 0;
  for (let index = 0; index < samples; index += 1) {
    const query = queries[index % queries.length] ?? "runner";
    const started = performance.now();
    const results = await loaded.searchRootFiles(root, query, 30);
    timings.push(performance.now() - started);
    resultCount += results.length;
    checksum += results.reduce((sum, result) => sum + result.path.length + result.match.length, 0);
  }
  const report = {
    label,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    workload: { repository: root, queries, limit: 30, latencyMs: stats(timings), totalResults: resultCount, checksum },
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text, "utf8");
  }
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
