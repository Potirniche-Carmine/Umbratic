# Code intelligence evaluation

The first-release gate uses deterministic fixture evidence. It does not claim a model-token benchmark.

| Task | Search and read baseline | LSP treatment | Automated evidence |
|---|---|---|---|
| Definition | Finds lexical matches. It cannot identify a definition reliably. | Returns a typed, exact location. | Native runner stub test |
| References | Finds same-text matches, including unrelated text. | Returns bounded semantic locations. | Native runner stub test |
| Hover | Reads nearby source but has no server type result. | Returns bounded redacted markdown. | Native runner stub and Rust unit tests |
| Symbols | Can list text matches but has no symbol kinds. | Returns named, typed document or workspace symbols. | Native runner stub test |
| Missing or crashed server | Search and read stay available. | Tool is omitted when no probe succeeds. A later crash returns `degraded`. | Desktop gating and native runner crash tests |

The treatment improves all four semantic tasks without changing the search and read fallback. The release does not install a server, stream diagnostics, or use LSP results without a later `read` check.
