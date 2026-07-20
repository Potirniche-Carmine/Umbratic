import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { createGitCheckpoint, materializeCheckpointWorktree, removeManagedWorktree } from "../src/main/checkpoints/gitAdapter.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))];
}

const SAMPLE_COUNT = 20;

function writeCheckpointFiles(repository: string, label: string): void {
  for (let index = 0; index < 1_000; index += 1) {
    const directory = path.join(repository, "benchmark", String(Math.floor(index / 100)));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file-${index}.txt`), `${label} file ${index}\n`);
  }
}

const repository = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-checkpoint-benchmark-"));
const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-fork-benchmark-"));
try {
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Checkpoint Benchmark"]);
  git(repository, ["config", "user.email", "benchmark@umbratic.local"]);
  fs.writeFileSync(path.join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  let seedCommit = git(repository, ["rev-parse", "HEAD"]);
  writeCheckpointFiles(repository, "warmup");
  seedCommit = (await createGitCheckpoint({
    workspacePath: repository,
    taskId: "benchmark-task",
    checkpointId: "checkpoint-warmup",
    seedCommit,
  })).commitOid;
  const checkpointMs: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    writeCheckpointFiles(repository, `sample ${sample}`);
    const startedAt = performance.now();
    const checkpoint = await createGitCheckpoint({
      workspacePath: repository,
      taskId: "benchmark-task",
      checkpointId: `checkpoint-${sample}`,
      seedCommit,
    });
    checkpointMs.push(performance.now() - startedAt);
    seedCommit = checkpoint.commitOid;
  }

  const forkMs: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const target = path.join(managedRoot, `fork-${sample}`);
    const startedAt = performance.now();
    await materializeCheckpointWorktree({
      repositoryPath: repository,
      checkpointCommit: seedCommit,
      branch: `umbratic/benchmark-fork-${sample}`,
      targetPath: target,
      managedRoot,
    });
    forkMs.push(performance.now() - startedAt);
    await removeManagedWorktree(repository, target, managedRoot);
  }

  const checkpointP95 = percentile(checkpointMs, 0.95);
  const forkP95 = percentile(forkMs, 0.95);
  const result = {
    methodology: { warmupSamples: 1, measuredSamples: SAMPLE_COUNT, percentile: 95 },
    checkpoint1000Files: { samplesMs: checkpointMs.map((value) => Number(value.toFixed(1))), p95Ms: Number(checkpointP95.toFixed(3)), limitMs: 500 },
    forkObjectsPresent: { samplesMs: forkMs.map((value) => Number(value.toFixed(1))), p95Ms: Number(forkP95.toFixed(3)), limitMs: 2_000 },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (checkpointP95 >= result.checkpoint1000Files.limitMs
    || forkP95 >= result.forkObjectsPresent.limitMs) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(managedRoot, { recursive: true, force: true });
  fs.rmSync(repository, { recursive: true, force: true });
}
