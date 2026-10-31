/** A privileged release must never promote a fork, PR or unverified commit. */
export function selectVerifiedReleaseRun(runs: Array<{
  head_sha: string; event: string; head_branch: string; head_repository: { full_name: string };
  conclusion: string; path: string;
}>, main: string, repository: string) {
  if (!/^[0-9a-f]{40}$/.test(main)) throw new Error("Invalid main commit.");
  const run = runs.find((candidate) => candidate.head_sha === main && candidate.event === "push"
    && candidate.head_branch === "main" && candidate.head_repository?.full_name === repository
    && candidate.conclusion === "success" && candidate.path === ".github/workflows/verify.yml");
  if (!run) throw new Error("Current main must have a successful CI push run before release.");
  return run;
}
