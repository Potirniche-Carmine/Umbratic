# Workspace graph evaluation

The release gate uses deterministic fixture evidence, the same way the LSP
rubric next door does (`code-intel/evaluation.md`). It does not claim a
model-token benchmark, and every row names the test that proves it.

The baseline column is an honest one: the same question answered with
`search` + `read`, which is what the harness actually does without the graph —
never a "read the whole repository" strawman.

## Structural questions

| Task | Search and read baseline | Graph treatment | Automated evidence |
|---|---|---|---|
| Which symbol does X? | Lexical matches, one call per guess, no way to tell a definition from a mention. | One `query` call returns the symbol with its kind and `file:line`. | `evaluation_tasks_pass_through_real_tool_dispatch` |
| How does A reach B? | Repeated greps following names by hand; misses indirection. | One `path` call returns the connecting edges with their evidence tier. | Same |
| What breaks if I change X? | Grep for the name, then read each hit to see whether it is really a caller. | One `affected` call returns scored dependents, ambiguous edges excluded. | Same, plus `affected_scores_nearer_dependents_above_further_ones` |
| Where is something that does not exist? | Several empty searches before concluding. | One call, empty result. | `evaluation-tasks.json` `no-answer` row, asserted empty |
| What should I review first? | No answer available at all. | One `changes` call returns changed symbols in priority order with untested counts. | `changes_reports_absence_rather_than_failing_when_no_insights_exist`, `analyze` unit tests |

## Extraction coverage

Every supported language has a fixture whose exact extracted symbols and edges
are asserted, so a grammar that renames a node type fails a test instead of
silently extracting nothing: `packages/code-index/tests/fixtures.rs` over
`typescript/`, `javascript/`, `python/`, `go/`, `c/`, `csharp/`, `cmake/`, and
`mixed/`. Rust is covered by the crate's own unit tests.

## Degradation

| Failure | Behaviour | Evidence |
|---|---|---|
| No indexer binary | No config fragment, tool never admits, harness is exactly today's. | `no artifact means no runner config fragment` |
| No artifact yet | Same. | Same |
| Artifact from another workspace | `freshness: degraded`, empty result, no graph data leaked. | `fingerprint_mismatch_degrades_without_exposing_graph_data` |
| Files edited after the build | `freshness: stale` with a verify-with-read warning. | `changed_workspace_files_mark_graph_stale` |
| Artifact over 32 MiB | Build fails toward no graph rather than writing a partial one. | `write_graph` budget check |
| No insights for this diff | `changes` says so; the review panel keeps path ordering with no caption. | `changes_reports_absence…`, `prioritizedReviewFiles` |

## Budgets

Measured by `build_and_update_meet_their_time_budgets` on a 5,000-file
synthetic tree, with the limits scaled for unoptimized test builds:

| Measure | Release gate |
|---|---|
| Full build, 5,000 files | ≤ 5s |
| Incremental update, one changed file | ≤ 300ms |
| Determinism | Two builds byte-identical excluding timestamps |

## Tuning status

The §5 traversal weights and the §6.2 risk factors are documented starting
points, not measured optima. They are recorded here as such: the ordering they
produce is asserted (nearer dependents outrank further ones; untested
security-named symbols outrank ordinary ones), the exact constants are not.
Tuning them is a change to the constants and this table, not to the machinery.

## What this gate does not establish

Whether a small local model reliably *chooses* to call the tool. That depends
on the three steering layers (tool description, bucket playbooks, the
security-review skill), and the honest answer is that it needs observation on
real sessions. If a small model will not use it, the steering text is what
gets iterated. The review panel ordering is model-free and stands on its own
either way.
