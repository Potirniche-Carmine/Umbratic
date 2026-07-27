pub mod config;
pub mod context;
pub mod context_state;
pub mod diagnostics;
pub mod events;
pub mod loop_runtime;
pub mod lsp;
pub mod permission;
pub mod policy;
pub mod safety;
pub mod server;
pub mod session;
pub mod tools;
pub mod veil_client;
pub mod workspace_graph;

pub const RUNNER_NAME: &str = "UmbraticRunner";
pub const RUNNER_VERSION: &str = "rust-1";
pub const RUNNER_CONTRACT_VERSION: &str = "umbratic-runner-1";
