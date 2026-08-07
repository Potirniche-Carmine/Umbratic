use serde_json::Value;

use crate::{events::run_queue_updated_event, session::InputPart};

pub const FOLLOW_UP_CAPACITY: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueAction {
    Steer,
    FollowUp,
    /// Removes one queued item by id. Editing a queued message is a drop plus a
    /// fresh enqueue, so the client never has to reconcile an id it changed.
    Drop,
    Cancel,
}

impl QueueAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
            Self::Drop => "drop",
            Self::Cancel => "cancel",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "steer" => Some(Self::Steer),
            "follow_up" => Some(Self::FollowUp),
            "drop" => Some(Self::Drop),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueDisposition {
    Accepted,
    Rejected,
    /// The running turn absorbed a steer at a step boundary. The client has
    /// nothing to launch: the prompt is already in the conversation.
    Applied,
    /// The client owns what happens next. A follow-up becomes a fresh turn, and
    /// so does a steer that outlived the run it was meant for.
    Dequeued,
    Cleared,
}

impl QueueDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Applied => "applied",
            Self::Dequeued => "dequeued",
            Self::Cleared => "cleared",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueuedAction {
    pub action_id: String,
    pub action: QueueAction,
    /// A steer's prompt, which the running turn injects itself. A follow-up
    /// carries none: it becomes a new turn, and its per-turn context (workspace
    /// preview, capability probe, attachment staging) is only correct when
    /// rebuilt at the moment that turn actually starts, so the client supplies
    /// it then. Storing a copy the runner would never read is what made the
    /// previous queue look functional while doing nothing.
    pub parts: Vec<InputPart>,
}

#[derive(Debug, Default)]
pub struct RunQueue {
    pending_steer: Option<QueuedAction>,
    follow_ups: Vec<QueuedAction>,
}

#[derive(Debug, Clone)]
pub struct QueueUpdate {
    pub action_id: String,
    pub action: QueueAction,
    pub disposition: QueueDisposition,
    pub pending_steer: bool,
    pub follow_up_count: usize,
    pub reason_code: Option<&'static str>,
    pub event: Value,
}

impl RunQueue {
    pub fn pending_steer(&self) -> bool {
        self.pending_steer.is_some()
    }

    pub fn follow_up_count(&self) -> usize {
        self.follow_ups.len()
    }

    pub fn has_work(&self) -> bool {
        self.pending_steer.is_some() || !self.follow_ups.is_empty()
    }

    fn snapshot_counts(&self) -> (bool, usize) {
        (self.pending_steer.is_some(), self.follow_ups.len())
    }

    #[allow(clippy::too_many_arguments)]
    fn make_update(
        &self,
        task_id: &str,
        session_id: &str,
        run_id: Option<&str>,
        action_id: &str,
        action: QueueAction,
        disposition: QueueDisposition,
        reason_code: Option<&'static str>,
    ) -> QueueUpdate {
        let (pending_steer, follow_up_count) = self.snapshot_counts();
        QueueUpdate {
            action_id: action_id.to_owned(),
            action,
            disposition,
            pending_steer,
            follow_up_count,
            reason_code,
            event: run_queue_updated_event(
                task_id,
                session_id,
                run_id,
                action_id,
                action.as_str(),
                disposition.as_str(),
                pending_steer,
                follow_up_count,
                FOLLOW_UP_CAPACITY,
                reason_code,
            ),
        }
    }

    pub fn enqueue(
        &mut self,
        task_id: &str,
        session_id: &str,
        run_id: Option<&str>,
        action: QueueAction,
        action_id: &str,
        parts: Vec<InputPart>,
    ) -> QueueUpdate {
        match action {
            QueueAction::Drop => {
                let dropped = self
                    .pending_steer
                    .as_ref()
                    .is_some_and(|steer| steer.action_id == action_id);
                if dropped {
                    self.pending_steer = None;
                } else {
                    self.follow_ups.retain(|item| item.action_id != action_id);
                }
                self.make_update(
                    task_id,
                    session_id,
                    run_id,
                    action_id,
                    action,
                    QueueDisposition::Cleared,
                    None,
                )
            }
            QueueAction::Cancel => self.make_update(
                task_id,
                session_id,
                run_id,
                action_id,
                action,
                QueueDisposition::Accepted,
                None,
            ),
            QueueAction::Steer => {
                if self.pending_steer.is_some() {
                    return self.make_update(
                        task_id,
                        session_id,
                        run_id,
                        action_id,
                        action,
                        QueueDisposition::Rejected,
                        Some("steer_already_pending"),
                    );
                }
                self.pending_steer = Some(QueuedAction {
                    action_id: action_id.to_owned(),
                    action: QueueAction::Steer,
                    parts,
                });
                self.make_update(
                    task_id,
                    session_id,
                    run_id,
                    action_id,
                    action,
                    QueueDisposition::Accepted,
                    None,
                )
            }
            QueueAction::FollowUp => {
                if self.follow_ups.len() >= FOLLOW_UP_CAPACITY {
                    return self.make_update(
                        task_id,
                        session_id,
                        run_id,
                        action_id,
                        action,
                        QueueDisposition::Rejected,
                        Some("follow_up_capacity_exceeded"),
                    );
                }
                self.follow_ups.push(QueuedAction {
                    action_id: action_id.to_owned(),
                    action: QueueAction::FollowUp,
                    parts,
                });
                self.make_update(
                    task_id,
                    session_id,
                    run_id,
                    action_id,
                    action,
                    QueueDisposition::Accepted,
                    None,
                )
            }
        }
    }

    /// Takes a pending steer for the running turn to inject. Follow-ups are
    /// deliberately not reachable here: they are new requests, and a new request
    /// belongs after the final answer, not in the middle of the work.
    pub fn take_steer(
        &mut self,
        task_id: &str,
        session_id: &str,
        run_id: Option<&str>,
    ) -> Option<(QueuedAction, QueueUpdate)> {
        let steer = self.pending_steer.take()?;
        let update = self.make_update(
            task_id,
            session_id,
            run_id,
            &steer.action_id,
            QueueAction::Steer,
            QueueDisposition::Applied,
            None,
        );
        Some((steer, update))
    }

    pub fn dequeue_next(
        &mut self,
        task_id: &str,
        session_id: &str,
        run_id: Option<&str>,
    ) -> Option<(QueuedAction, QueueUpdate)> {
        let next = self.pending_steer.take().or_else(|| {
            if self.follow_ups.is_empty() {
                None
            } else {
                Some(self.follow_ups.remove(0))
            }
        })?;
        let update = self.make_update(
            task_id,
            session_id,
            run_id,
            &next.action_id,
            next.action,
            QueueDisposition::Dequeued,
            None,
        );
        Some((next, update))
    }

    pub fn clear(
        &mut self,
        task_id: &str,
        session_id: &str,
        run_id: Option<&str>,
        _action_id: &str,
    ) -> Vec<QueueUpdate> {
        let mut updates = Vec::new();
        if let Some(steer) = self.pending_steer.take() {
            updates.push(self.make_update(
                task_id,
                session_id,
                run_id,
                &steer.action_id,
                QueueAction::Steer,
                QueueDisposition::Cleared,
                None,
            ));
        }
        let follow_ups = std::mem::take(&mut self.follow_ups);
        for follow_up in follow_ups {
            updates.push(self.make_update(
                task_id,
                session_id,
                run_id,
                &follow_up.action_id,
                QueueAction::FollowUp,
                QueueDisposition::Cleared,
                None,
            ));
        }
        updates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steer_capacity_is_one_and_follow_up_capacity_is_eight() {
        let mut queue = RunQueue::default();
        let accepted = queue.enqueue(
            "task",
            "session",
            Some("run-1"),
            QueueAction::Steer,
            "steer-1",
            vec![InputPart::Text {
                text: "redirect".into(),
            }],
        );
        assert_eq!(accepted.disposition, QueueDisposition::Accepted);
        assert!(accepted.pending_steer);
        let rejected = queue.enqueue(
            "task",
            "session",
            Some("run-1"),
            QueueAction::Steer,
            "steer-2",
            vec![InputPart::Text {
                text: "other".into(),
            }],
        );
        assert_eq!(rejected.disposition, QueueDisposition::Rejected);
        assert_eq!(rejected.reason_code, Some("steer_already_pending"));

        for index in 0..FOLLOW_UP_CAPACITY {
            let update = queue.enqueue(
                "task",
                "session",
                None,
                QueueAction::FollowUp,
                &format!("follow-{index}"),
                Vec::new(),
            );
            assert_eq!(update.disposition, QueueDisposition::Accepted);
        }
        let overflow = queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::FollowUp,
            "follow-overflow",
            Vec::new(),
        );
        assert_eq!(overflow.disposition, QueueDisposition::Rejected);
        assert_eq!(overflow.reason_code, Some("follow_up_capacity_exceeded"));
    }

    #[test]
    fn dequeue_prefers_steer_over_follow_up() {
        let mut queue = RunQueue::default();
        queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::FollowUp,
            "follow-1",
            Vec::new(),
        );
        queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::Steer,
            "steer-1",
            vec![InputPart::Text { text: "now".into() }],
        );
        let (next, update) = queue
            .dequeue_next("task", "session", Some("run-1"))
            .unwrap();
        assert_eq!(next.action_id, "steer-1");
        assert_eq!(next.action, QueueAction::Steer);
        assert_eq!(update.disposition, QueueDisposition::Dequeued);
        assert!(!update.pending_steer);
        assert_eq!(update.follow_up_count, 1);
        assert_eq!(update.event["type"], "run.queue.updated");
        assert!(!update.event["at"].as_str().unwrap().is_empty());
    }

    #[test]
    fn dropping_removes_one_queued_item_and_leaves_the_rest() {
        // Editing a queued message drops it and enqueues the replacement, so a
        // drop must be precise: clearing the whole queue would silently discard
        // messages the user never touched.
        let mut queue = RunQueue::default();
        for id in ["follow-1", "follow-2", "follow-3"] {
            queue.enqueue(
                "task",
                "session",
                None,
                QueueAction::FollowUp,
                id,
                Vec::new(),
            );
        }
        queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::Steer,
            "steer-1",
            vec![InputPart::Text { text: "now".into() }],
        );

        let update = queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::Drop,
            "follow-2",
            Vec::new(),
        );
        assert_eq!(update.disposition, QueueDisposition::Cleared);
        assert_eq!(update.follow_up_count, 2);
        assert!(
            update.pending_steer,
            "dropping a follow-up leaves the steer"
        );

        let dropped_steer = queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::Drop,
            "steer-1",
            Vec::new(),
        );
        assert!(!dropped_steer.pending_steer);
        assert_eq!(dropped_steer.follow_up_count, 2);

        // Release order is preserved around the hole the drop left.
        let (first, _) = queue.dequeue_next("task", "session", None).unwrap();
        assert_eq!(first.action_id, "follow-1");
        let (second, _) = queue.dequeue_next("task", "session", None).unwrap();
        assert_eq!(second.action_id, "follow-3");
        assert!(queue.dequeue_next("task", "session", None).is_none());
    }

    #[test]
    fn taking_a_steer_never_reaches_a_follow_up() {
        let mut queue = RunQueue::default();
        queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::FollowUp,
            "follow-1",
            Vec::new(),
        );
        assert!(queue.take_steer("task", "session", Some("run-1")).is_none());
        assert_eq!(queue.follow_up_count(), 1);
    }
}
