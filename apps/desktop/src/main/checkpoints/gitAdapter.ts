import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CHECKPOINT_FILES = 25_000;
const MAX_CHECKPOINT_LOGICAL_BYTES = 1024 * 1024 * 1024;

export type CheckpointGitResult = {
  commitOid: string;
  treeOid: string;
  indexTreeOid: string;
  ref: string;
  changedFiles: number;
  logicalBytes: number;
};

type CheckpointGitInput = {
  workspacePath: string;
  taskId: string;
  checkpointId: string;
  seedCommit: string;
};

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, trim = true): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return trim ? result.stdout.trim() : result.stdout;
}

async function gitWithInput(cwd: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin?.end(input);
  });
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function blockedCheckpointPath(relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  const base = path.posix.basename(normalized);
  return normalized === ".git" || normalized.startsWith(".git/") || normalized.startsWith(".umbratic/")
    || base === ".env" || base.startsWith(".env.") || /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/.test(normalized);
}

function fileBytes(target: string): Buffer | null {
  try { return fs.readFileSync(target); } catch { return null; }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

async function checkpointPaths(workspacePath: string, seedCommit: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(workspacePath, ["diff", "--name-only", "--no-renames", "-z", seedCommit, "--"], undefined, false),
    git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"], undefined, false),
  ]);
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

async function pathsUseContentFilters(workspacePath: string, paths: string[]): Promise<boolean> {
  if (!paths.length) return false;
  const attributes = await gitWithInput(
    workspacePath,
    ["check-attr", "-z", "--stdin", "filter"],
    `${paths.join("\0")}\0`,
  );
  const fields = attributes.split("\0");
  for (let index = 2; index < fields.length; index += 3) {
    const value = fields[index];
    if (value && value !== "unspecified" && value !== "unset") return true;
  }
  return false;
}

async function assertEligible(workspacePath: string, seed: string): Promise<{ root: string; indexPath: string; seedCommit: string }> {
  const [repositoryOutput, submodules] = await Promise.all([
    git(workspacePath, [
      "rev-parse", "--show-toplevel", "--is-bare-repository", "--git-common-dir", "--git-path", "index", `${seed}^{commit}`,
    ]),
    fs.existsSync(path.join(workspacePath, ".gitmodules"))
      ? git(workspacePath, ["submodule", "status", "--recursive"]).catch(() => "")
      : Promise.resolve(""),
  ]);
  const repositoryFacts = repositoryOutput.split(/\r?\n/);
  if (repositoryFacts.length !== 5) throw new Error("Checkpoint repository identity is unavailable.");
  const [topLevel, bare, commonDirectory, indexFile, seedCommit] = repositoryFacts;
  const root = fs.realpathSync(path.resolve(topLevel));
  if (root !== fs.realpathSync(path.resolve(workspacePath))) throw new Error("Checkpoint workspace must be the Git worktree root.");
  if (bare !== "false") throw new Error("Bare repositories cannot be checkpointed.");
  const commonDir = path.resolve(root, commonDirectory);
  if (!fs.existsSync(commonDir)) throw new Error("Git common directory is unavailable.");
  if (submodules.split(/\r?\n/).some((line) => /^[+\-U]/.test(line))) {
    throw new Error("Checkpointing is unavailable with missing or dirty submodules.");
  }
  const indexPath = path.resolve(root, indexFile);
  return { root, indexPath, seedCommit };
}

export async function createGitCheckpoint(input: CheckpointGitInput): Promise<CheckpointGitResult> {
  const taskId = safeIdentifier(input.taskId, "task id");
  const checkpointId = safeIdentifier(input.checkpointId, "checkpoint id");
  const workspacePath = path.resolve(input.workspacePath);
  const stableSeed = /^[a-f0-9]{40,64}$/i.test(input.seedCommit);
  const [eligibility, preloadedPaths] = stableSeed
    ? await Promise.all([
        assertEligible(workspacePath, input.seedCommit),
        checkpointPaths(workspacePath, input.seedCommit),
      ])
    : [await assertEligible(workspacePath, input.seedCommit), undefined];
  const { root, indexPath, seedCommit } = eligibility;
  const paths = preloadedPaths ?? await checkpointPaths(root, seedCommit);
  const beforeIndex = fileBytes(indexPath);
  const indexTreeOid = await git(root, ["write-tree"]);
  if (paths.length > MAX_CHECKPOINT_FILES) throw new Error("Checkpoint exceeds the 25,000-file limit.");
  if (paths.some(blockedCheckpointPath)) throw new Error("Checkpoint contains a blocked credential or runtime path.");
  if (await pathsUseContentFilters(root, paths)) {
    throw new Error("Checkpointing is unavailable for files that use Git content filters.");
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-checkpoint-"));
  const temporaryIndex = path.join(temporary, "index");
  const checkpointEnv: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: temporaryIndex,
    GIT_AUTHOR_NAME: "Umbratic Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@umbratic.local",
    GIT_COMMITTER_NAME: "Umbratic Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@umbratic.local",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.looseCompression",
    GIT_CONFIG_VALUE_0: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const ref = `refs/umbratic/checkpoints/${taskId}/${checkpointId}`;
  const readTree = git(root, ["read-tree", seedCommit], checkpointEnv);
  try {
    let logicalBytes = 0;
    const presentPaths: string[] = [];
    const deletedPaths: string[] = [];
    for (const relative of paths) {
      const target = path.resolve(root, relative);
      const relation = path.relative(root, target);
      if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("Checkpoint path escapes the workspace.");
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
          throw new Error("Checkpoint refuses symbolic links or junctions.");
        }
        // Refuse symlink path components (e.g. nested/link/file.txt).
        let cursor = root;
        for (const part of relation.split(path.sep).filter(Boolean)) {
          cursor = path.join(cursor, part);
          if (fs.lstatSync(cursor).isSymbolicLink()) {
            throw new Error("Checkpoint refuses symbolic links or junctions.");
          }
        }
        if (!stat.isFile()) {
          throw new Error("Checkpoint path is not a regular file.");
        }
        presentPaths.push(relative);
        logicalBytes += stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Deletions have no current logical bytes.
        deletedPaths.push(relative);
      }
    }
    if (logicalBytes > MAX_CHECKPOINT_LOGICAL_BYTES) throw new Error("Checkpoint exceeds the 1 GiB logical input limit.");
    await readTree;
    if (presentPaths.length) {
      await gitWithInput(root, ["update-index", "--add", "-z", "--stdin"], `${presentPaths.join("\0")}\0`, checkpointEnv);
    }
    if (deletedPaths.length) {
      await gitWithInput(root, ["update-index", "--force-remove", "-z", "--stdin"], `${deletedPaths.join("\0")}\0`, checkpointEnv);
    }
    const treeOid = await git(root, ["write-tree"], checkpointEnv);
    // Stash-shaped commits keep HEAD, the staged tree, and the working tree
    // reachable together. Previous checkpoints are not parents: retention must
    // be able to release their objects independently.
    const head = await git(root, ["rev-parse", "HEAD"]);
    const indexCommit = await git(root, ["commit-tree", indexTreeOid, "-p", head, "-m", "Checkpoint index"], checkpointEnv);
    const commitOid = await git(root, ["commit-tree", treeOid, "-p", head, "-p", indexCommit, "-m", `Umbratic checkpoint ${checkpointId}`], checkpointEnv);
    await git(root, ["update-ref", ref, commitOid, "0".repeat(commitOid.length)], checkpointEnv);
    // `commit-tree <treeOid>` validates and embeds this exact tree; `update-ref` atomically
    // publishes only the private checkpoint ref. Git can refresh harmless index stat data, so
    // compare the staged tree if the index bytes change.
    if (!sameBytes(beforeIndex, fileBytes(indexPath)) && await git(root, ["write-tree"]) !== indexTreeOid) {
      throw new Error("Checkpoint changed visible Git state.");
    }
    return { commitOid, treeOid, indexTreeOid, ref, changedFiles: paths.length, logicalBytes };
  } catch (error) {
    await readTree.catch(() => undefined);
    await git(root, ["update-ref", "-d", ref]).catch(() => undefined);
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Validate the entire undo before restoring any file or its staging state. */
export async function restoreGitCheckpointPaths(input: {
  workspacePath: string;
  checkpointCommit: string;
  relativePaths: string[];
}): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(input.checkpointCommit)) {
    throw new Error("Checkpoint object identity is invalid.");
  }
  const { root } = await assertEligible(input.workspacePath, input.checkpointCommit);
  const indexTree = await git(root, ["rev-parse", `${input.checkpointCommit}^2^{tree}`]);
  const entries: { relative: string; target: string; entry: string; indexEntry: string }[] = [];
  for (const file of input.relativePaths) {
    const relative = file.replaceAll("\\", "/");
    if (!relative || path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "")) {
      throw new Error("Invalid path to restore.");
    }
    if (blockedCheckpointPath(relative)) throw new Error(`Refusing to restore ${relative}.`);
    const target = path.resolve(root, relative);
    if (!inside(root, target) || target === root) throw new Error("Refusing to restore a path outside the worktree.");
    for (let directory = target; inside(root, directory) && directory !== root; directory = path.dirname(directory)) {
      if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Refusing to restore through a symbolic link.");
      }
    }
    const entry = await git(root, ["--literal-pathspecs", "ls-tree", input.checkpointCommit, "--", relative]);
    const indexEntry = await git(root, ["--literal-pathspecs", "ls-tree", indexTree, "--", relative]);
    for (const value of [entry, indexEntry]) {
      if (value && !/^100(644|755) blob [a-f0-9]+\t/.test(value)) throw new Error("Checkpoint path is not a regular file.");
    }
    entries.push({ relative, target, entry, indexEntry });
  }
  if (await pathsUseContentFilters(root, entries.map(({ relative }) => relative))) {
    throw new Error("Checkpoint restore refuses Git content filters.");
  }
  for (const { relative, target, entry, indexEntry } of entries) {
    if (entry) {
      await git(root, ["--literal-pathspecs", "restore", `--source=${input.checkpointCommit}`, "--worktree", "--", relative]);
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    // A file that was untracked before the prompt must remain untracked.
    if (indexEntry) {
      await git(root, ["--literal-pathspecs", "restore", `--source=${indexTree}`, "--staged", "--", relative]);
    } else {
      await gitWithInput(root, ["update-index", "--force-remove", "-z", "--stdin"], `${relative}\0`);
    }
  }
}

export async function materializeCheckpointWorktree(input: {
  repositoryPath: string;
  checkpointCommit: string;
  branch: string;
  targetPath: string;
  managedRoot: string;
}): Promise<void> {
  const repository = path.resolve(input.repositoryPath);
  const target = path.resolve(input.targetPath);
  const managedRoot = path.resolve(input.managedRoot);
  if (!inside(managedRoot, target) || target === managedRoot) throw new Error("Checkpoint worktree target is outside the managed root.");
  if (fs.existsSync(target)) throw new Error("Checkpoint worktree target already exists.");
  const commit = await git(repository, ["rev-parse", `${input.checkpointCommit}^{commit}`]);
  const head = await git(repository, ["rev-parse", `${commit}^1^{commit}`]);
  const indexTree = await git(repository, ["rev-parse", `${commit}^2^{tree}`]);
  let created = false;
  try {
    await git(repository, ["worktree", "add", "-b", input.branch, target, head]);
    created = true;
    await git(target, ["read-tree", "--reset", "-u", commit]);
    await git(target, ["read-tree", indexTree]);
    if (fs.realpathSync(path.resolve(await git(target, ["rev-parse", "--show-toplevel"]))) !== fs.realpathSync(target)
      || await git(target, ["rev-parse", "HEAD"]) !== head
      || await git(target, ["write-tree"]) !== indexTree) {
      throw new Error("Materialized checkpoint worktree failed validation.");
    }
  } catch (error) {
    if (created && inside(managedRoot, target) && fs.existsSync(target)) {
      await git(repository, ["worktree", "remove", "--force", target]).catch(() => undefined);
    }
    throw error;
  }
}

export async function deleteGitCheckpointRef(repositoryPath: string, ref: string): Promise<void> {
  if (!/^refs\/umbratic\/checkpoints\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}$/.test(ref)) {
    throw new Error("Invalid Umbratic checkpoint ref.");
  }
  await git(path.resolve(repositoryPath), ["update-ref", "-d", ref]);
}

export async function removeManagedWorktree(repositoryPath: string, targetPath: string, managedRoot: string): Promise<void> {
  const target = path.resolve(targetPath);
  const root = path.resolve(managedRoot);
  if (!inside(root, target) || target === root) throw new Error("Worktree cleanup target is outside the managed root.");
  await git(path.resolve(repositoryPath), ["worktree", "remove", "--force", target]);
}
