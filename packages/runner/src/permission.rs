use std::{collections::HashMap, sync::Mutex};

use serde_json::json;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{events::now_iso, session::EventSink};

struct PendingPermission {
    task_id: String,
    sender: oneshot::Sender<String>,
}

#[derive(Default)]
pub struct PermissionBroker {
    pending: Mutex<HashMap<String, PendingPermission>>,
}

impl PermissionBroker {
    pub async fn request(
        &self,
        sink: &EventSink,
        task_id: &str,
        permission_kind: &str,
        summary: &str,
        auto_allow: bool,
    ) -> String {
        let id = format!("perm-{}", Uuid::new_v4());
        let requested = json!({ "type": "permission.requested", "taskId": task_id, "permissionId": id, "permissionKind": permission_kind, "summary": summary, "at": now_iso() });
        if auto_allow {
            sink.emit(requested);
            sink.emit(json!({ "type": "permission.resolved", "taskId": task_id, "permissionId": id, "decision": "allow", "at": now_iso() }));
            return "allow".to_owned();
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            pending.insert(
                id,
                PendingPermission {
                    task_id: task_id.to_owned(),
                    sender,
                },
            );
            // A consumer can answer as soon as the event is published. Keep
            // registration and publication ordered with replies and aborts.
            sink.emit(requested);
        }
        receiver.await.unwrap_or_else(|_| "deny".to_owned())
    }

    pub fn reply(&self, sink: &EventSink, permission_id: &str, decision: &str) -> bool {
        let Some(pending) = self.pending.lock().unwrap().remove(permission_id) else {
            return false;
        };
        let decision = match decision {
            "allow" => "allow",
            "abort" => "abort",
            _ => "deny",
        }
        .to_owned();
        let task_id = pending.task_id.clone();
        sink.emit(json!({ "type": "permission.resolved", "taskId": task_id, "permissionId": permission_id, "decision": decision, "at": now_iso() }));
        let _ = pending.sender.send(decision);
        true
    }

    pub fn abort_all(&self, sink: &EventSink, task_id: &str) {
        let ids: Vec<_> = self
            .pending
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, pending)| pending.task_id == task_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.reply(sink, &id, "abort");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn immediate_replies_are_registered_and_resolve_before_the_tool_resumes() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(PermissionBroker::default());
        for _ in 0..2_000 {
            let request = {
                let broker = broker.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    let decision = broker
                        .request(&sink, "task-a", "edit", "write", false)
                        .await;
                    sink.emit(json!({ "type": "tool.resumed" }));
                    decision
                })
            };
            let event = events.recv().await.unwrap();
            assert_eq!(event["type"], "permission.requested");
            assert!(broker.reply(&sink, event["permissionId"].as_str().unwrap(), "allow"));
            assert_eq!(events.recv().await.unwrap()["type"], "permission.resolved");
            assert_eq!(events.recv().await.unwrap()["type"], "tool.resumed");
            assert_eq!(request.await.unwrap(), "allow");
        }
    }

    #[tokio::test]
    async fn auto_allow_emits_requested_and_resolved_events() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = PermissionBroker::default();

        assert_eq!(
            broker
                .request(&sink, "task-a", "edit", "write note.txt", true)
                .await,
            "allow"
        );
        let requested = events.recv().await.unwrap();
        let resolved = events.recv().await.unwrap();
        assert_eq!(requested["type"], "permission.requested");
        assert_eq!(resolved["type"], "permission.resolved");
        assert_eq!(requested["permissionId"], resolved["permissionId"]);
        assert_eq!(resolved["decision"], "allow");
    }

    #[tokio::test]
    async fn replies_resolve_exactly_one_pending_request() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(PermissionBroker::default());
        let request = {
            let broker = broker.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                broker
                    .request(&sink, "task-a", "edit", "write note.txt", false)
                    .await
            })
        };
        let event = events.recv().await.unwrap();
        let permission_id = event["permissionId"].as_str().unwrap();
        assert!(broker.reply(&sink, permission_id, "allow"));
        // A resolved request is gone: the second reply finds nothing to resolve.
        assert!(!broker.reply(&sink, permission_id, "allow"));
        assert_eq!(request.await.unwrap(), "allow");
        let resolved = events.recv().await.unwrap();
        assert_eq!(resolved["taskId"], "task-a");
        assert_eq!(resolved["decision"], "allow");
    }

    #[tokio::test]
    async fn abort_all_resolves_pending_with_abort() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let broker = Arc::new(PermissionBroker::default());
        let request = {
            let broker = broker.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                broker
                    .request(&sink, "task-a", "edit", "write", false)
                    .await
            })
        };
        let _ = events.recv().await.unwrap();
        broker.abort_all(&sink, "task-a");
        assert_eq!(request.await.unwrap(), "abort");
        let resolved = events.recv().await.unwrap();
        assert_eq!(resolved["decision"], "abort");
        // Nothing is left pending: a reply to the aborted id finds no request.
        assert!(!broker.reply(&sink, resolved["permissionId"].as_str().unwrap(), "allow"));
    }
}
