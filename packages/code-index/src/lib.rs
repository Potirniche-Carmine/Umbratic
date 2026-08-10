//! Producer for the workspace graph artifact the runner's `workspace_graph`
//! tool reads. One-shot, non-networked, and deterministic: the same tree
//! produces byte-identical output on every OS.

pub mod analyze;
pub mod build;
pub mod cache;
pub mod imports;
pub mod lang;
pub mod model;
pub mod resolve;
pub mod tsconfig;
pub mod update;
pub mod walk;
