//! The round trip between the `artifact` tool and the desktop that owns the
//! document engines.
//!
//! The engines are a Node worker and a Rust sidecar shipped inside the desktop
//! app; in server mode the remote host has neither. Rather than push an engine
//! to every host, the runner keeps what it is good at — path confinement,
//! permission, timeouts, repeat detection — and hands the build itself to the
//! desktop over the event stream it already maintains. This is the same shape
//! as [`crate::permission::PermissionBroker`]: emit a request, park a oneshot,
//! resolve it from an HTTP reply.
//!
//! The distinction from permission is the timeout. A permission request waits
//! for a human and may wait a long time; an artifact job waits for a machine
//! that has agreed to answer, so a job that goes quiet is a failure with a
//! typed reason rather than a run that hangs.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tokio::{sync::oneshot, time::timeout};
use uuid::Uuid;

use crate::{events::now_iso, session::EventSink};

/// The default a job gets when the tool call names none.
pub const DEFAULT_ARTIFACT_TIMEOUT_MS: u64 = 120_000;
/// The ceiling on what a tool call may ask for. A build that needs longer than
/// this is a build that should have been split.
pub const MAX_ARTIFACT_TIMEOUT_MS: u64 = 600_000;

struct PendingArtifact {
    task_id: String,
    sender: oneshot::Sender<Value>,
}

/// Why a job produced no result. Every variant means nothing was written: the
/// desktop stages its output and installs it atomically, so a job that did not
/// reply cannot have half-installed a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactFailure {
    /// No reply within the job's timeout.
    Timeout,
    /// The run was aborted, or the desktop dropped the stream mid-job.
    Transport,
}

impl ArtifactFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Timeout => "artifact_timeout",
            Self::Transport => "transport",
        }
    }
}

#[derive(Default)]
pub struct ArtifactBroker {
    pending: Mutex<HashMap<String, PendingArtifact>>,
}

impl ArtifactBroker {
    /// Emits one `artifact.requested` event and waits for the matching reply.
    ///
    /// `job` is the already-validated, already-confined description of the
    /// work: absolute paths resolved, permission granted, sizes checked. The
    /// desktop is trusted to build what it is handed, so everything the policy
    /// layer has to say is said before this call, not after it.
    pub async fn request(
        &self,
        sink: &EventSink,
        task_id: &str,
        job: Value,
        wait: Duration,
    ) -> Result<Value, ArtifactFailure> {
        let id = format!("artifact-{}", Uuid::new_v4());
        let (sender, receiver) = oneshot::channel();
        let mut event = json!({
            "type": "artifact.requested",
            "taskId": task_id,
            "artifactId": id,
            "at": now_iso(),
        });
        if let (Some(fields), Some(job)) = (event.as_object_mut(), job.as_object()) {
            for (key, value) in job {
                fields.insert(key.clone(), value.clone());
            }
        }
        {
            let mut pending = self.pending.lock().unwrap();
            pending.insert(
                id.clone(),
                PendingArtifact {
                    task_id: task_id.to_owned(),
                    sender,
                },
            );
            // Replies and aborts must observe the request before resolving it.
            sink.emit(event);
        }
        match timeout(wait, receiver).await {
            Ok(Ok(reply)) => Ok(reply),
            // The sender was dropped: abort_all took it, or the store shut down.
            Ok(Err(_)) => Err(ArtifactFailure::Transport),
            Err(_) => {
                self.forget(&id);
                Err(ArtifactFailure::Timeout)
            }
        }
    }

    /// Resolves one pending job. Returns false when the id is unknown, which is
    /// how a duplicate or late reply is distinguished from a live one.
    pub fn reply(&self, sink: &EventSink, artifact_id: &str, result: Value) -> bool {
        let Some(pending) = self.pending.lock().unwrap().remove(artifact_id) else {
            return false;
        };
        let task_id = pending.task_id.clone();
        let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
        sink.emit(json!({
            "type": "artifact.resolved",
            "taskId": task_id,
            "artifactId": artifact_id,
            "ok": ok,
            "at": now_iso(),
        }));
        let _ = pending.sender.send(result);
        true
    }

    /// Drops every job belonging to an aborted task. The waiting tool call sees
    /// its sender vanish and reports `transport`.
    pub fn abort_all(&self, sink: &EventSink, task_id: &str) {
        self.pending.lock().unwrap().retain(|id, pending| {
            if pending.task_id != task_id {
                return true;
            }
            sink.emit(json!({
                "type": "artifact.resolved",
                "taskId": task_id,
                "artifactId": id,
                "ok": false,
                "reason": "aborted",
                "at": now_iso(),
            }));
            // Dropping the sender resumes the tool, after the resolved event.
            false
        });
    }

    fn forget(&self, artifact_id: &str) {
        self.pending.lock().unwrap().remove(artifact_id);
    }
}

/// Clamps a caller-supplied timeout into the contract's range.
pub fn artifact_timeout(requested_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        requested_ms
            .unwrap_or(DEFAULT_ARTIFACT_TIMEOUT_MS)
            .clamp(1_000, MAX_ARTIFACT_TIMEOUT_MS),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn immediate_replies_and_aborts_resolve_before_the_tool_resumes() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(ArtifactBroker::default());
        for iteration in 0..1_000 {
            let job = {
                let broker = broker.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    let result = broker
                        .request(
                            &sink,
                            "task-a",
                            json!({"action":"create"}),
                            Duration::from_secs(5),
                        )
                        .await;
                    sink.emit(json!({"type":"tool.resumed"}));
                    result
                })
            };
            let requested = events.recv().await.unwrap();
            assert_eq!(requested["type"], "artifact.requested");
            let id = requested["artifactId"].as_str().unwrap();
            let abort = iteration % 2 == 0;
            if abort {
                broker.abort_all(&sink, "task-a");
            } else {
                assert!(broker.reply(&sink, id, json!({"ok":true})));
            }
            let resolved = events.recv().await.unwrap();
            assert_eq!(resolved["type"], "artifact.resolved");
            assert_eq!(resolved["artifactId"], id);
            assert_eq!(resolved["ok"], !abort);
            assert_eq!(events.recv().await.unwrap()["type"], "tool.resumed");
            let result = job.await.unwrap();
            if abort {
                assert_eq!(result, Err(ArtifactFailure::Transport));
            } else {
                assert_eq!(result.unwrap(), json!({"ok":true}));
            }
            assert!(!broker.reply(&sink, id, json!({"ok":true})));
        }
    }

    #[tokio::test]
    async fn a_reply_resolves_exactly_one_job() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(ArtifactBroker::default());
        let job = {
            let broker = broker.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                broker
                    .request(
                        &sink,
                        "task-a",
                        json!({"action":"create","format":"pptx"}),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        let requested = events.recv().await.unwrap();
        assert_eq!(requested["type"], "artifact.requested");
        assert_eq!(requested["action"], "create");
        let id = requested["artifactId"].as_str().unwrap().to_owned();
        assert!(broker.reply(&sink, &id, json!({"ok":true,"bytes":10})));
        // A resolved job is gone; a second reply finds nothing.
        assert!(!broker.reply(&sink, &id, json!({"ok":true})));
        assert_eq!(job.await.unwrap().unwrap()["bytes"], 10);
        assert_eq!(events.recv().await.unwrap()["type"], "artifact.resolved");
    }

    #[tokio::test]
    async fn a_job_that_is_never_answered_times_out() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let broker = ArtifactBroker::default();
        let failure = broker
            .request(
                &sink,
                "task-a",
                json!({"action":"inspect"}),
                Duration::from_millis(20),
            )
            .await
            .unwrap_err();
        assert_eq!(failure, ArtifactFailure::Timeout);
        // The timed-out job is not left pending, so a late reply is a no-op.
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn abort_drops_pending_jobs_as_transport_failures() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(ArtifactBroker::default());
        let job = {
            let broker = broker.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                broker
                    .request(
                        &sink,
                        "task-a",
                        json!({"action":"edit"}),
                        Duration::from_secs(30),
                    )
                    .await
            })
        };
        let _requested = events.recv().await.unwrap();
        broker.abort_all(&sink, "task-a");
        assert_eq!(job.await.unwrap().unwrap_err(), ArtifactFailure::Transport);
    }

    #[test]
    fn timeouts_clamp_into_the_contract_range() {
        assert_eq!(
            artifact_timeout(None),
            Duration::from_millis(DEFAULT_ARTIFACT_TIMEOUT_MS)
        );
        assert_eq!(
            artifact_timeout(Some(9_999_999)),
            Duration::from_millis(MAX_ARTIFACT_TIMEOUT_MS)
        );
        assert_eq!(artifact_timeout(Some(5)), Duration::from_millis(1_000));
    }
}
