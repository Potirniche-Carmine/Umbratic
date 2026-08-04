use serde_json::Value;

use crate::events::run_queue_updated_event;

pub const FOLLOW_UP_CAPACITY: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueAction {
    Steer,
    FollowUp,
    Cancel,
}

impl QueueAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
            Self::Cancel => "cancel",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "steer" => Some(Self::Steer),
            "follow_up" => Some(Self::FollowUp),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueDisposition {
    Accepted,
    Rejected,
    Dequeued,
    Cleared,
}

impl QueueDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Dequeued => "dequeued",
            Self::Cleared => "cleared",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueuedAction {
    pub action_id: String,
    pub action: QueueAction,
    pub prompt: String,
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
        prompt: Option<String>,
    ) -> QueueUpdate {
        match action {
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
                let prompt = prompt.unwrap_or_default();
                self.pending_steer = Some(QueuedAction {
                    action_id: action_id.to_owned(),
                    action: QueueAction::Steer,
                    prompt,
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
                let prompt = prompt.unwrap_or_default();
                self.follow_ups.push(QueuedAction {
                    action_id: action_id.to_owned(),
                    action: QueueAction::FollowUp,
                    prompt,
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
            Some("redirect".into()),
        );
        assert_eq!(accepted.disposition, QueueDisposition::Accepted);
        assert!(accepted.pending_steer);
        let rejected = queue.enqueue(
            "task",
            "session",
            Some("run-1"),
            QueueAction::Steer,
            "steer-2",
            Some("other".into()),
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
                Some(format!("prompt {index}")),
            );
            assert_eq!(update.disposition, QueueDisposition::Accepted);
        }
        let overflow = queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::FollowUp,
            "follow-overflow",
            Some("too many".into()),
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
            Some("later".into()),
        );
        queue.enqueue(
            "task",
            "session",
            None,
            QueueAction::Steer,
            "steer-1",
            Some("now".into()),
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
}
