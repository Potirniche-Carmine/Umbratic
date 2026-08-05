use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    events::{increment, now_iso},
    session::{EventSink, Session},
};

// Progress text describes runner orchestration state, not the assistant's own
// speech. Keep it a short neutral label so the desktop can render it as status
// instead of prose.
//
// Compaction is the only progress worth announcing. A pre-tool label like
// "Reading files" only restates the tool rows that render directly beneath it,
// so it is noise in the activity log rather than information.
const CONTEXT_RECOVERY_PROGRESS: &str = "Compacting earlier context to fit the request";

#[derive(Default)]
pub(crate) struct PublicProgressSchedule {
    last_text: Option<String>,
}

impl PublicProgressSchedule {
    pub(crate) fn before_context_recovery(
        &mut self,
        session: &Arc<Session>,
        sink: &EventSink,
        summary: &mut Value,
    ) {
        self.emit(session, sink, summary, CONTEXT_RECOVERY_PROGRESS);
    }

    fn emit(&mut self, session: &Arc<Session>, sink: &EventSink, summary: &mut Value, text: &str) {
        if session.is_aborted() || self.last_text.as_deref() == Some(text) {
            return;
        }
        self.last_text = Some(text.to_owned());
        increment(summary, "progressTextChars", text.len() as u64);
        sink.emit(json!({
            "type": "assistant.progress.delta",
            "taskId": session.task_id,
            "text": text,
            "at": now_iso()
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_progress_never_speaks_in_the_assistant_voice() {
        let lowered = CONTEXT_RECOVERY_PROGRESS.to_ascii_lowercase();
        assert!(
            !lowered.contains(" i "),
            "progress narrates in first person"
        );
        assert!(
            !lowered.starts_with("i "),
            "progress narrates in first person"
        );
        assert!(
            !lowered.contains("model"),
            "progress exposes model orchestration state"
        );
        assert!(
            !CONTEXT_RECOVERY_PROGRESS.contains('.'),
            "progress should be a label, not prose"
        );
    }

    #[test]
    fn a_repeated_phase_is_emitted_once() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let mut summary = crate::events::empty_summary();
        let mut schedule = PublicProgressSchedule::default();

        schedule.before_context_recovery(&session, &sink, &mut summary);
        schedule.before_context_recovery(&session, &sink, &mut summary);

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        let progress = observed
            .iter()
            .filter(|event| event["type"] == "assistant.progress.delta")
            .collect::<Vec<_>>();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0]["text"], CONTEXT_RECOVERY_PROGRESS);
    }

    #[test]
    fn an_aborted_session_stops_emitting_progress() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let mut summary = crate::events::empty_summary();
        let mut schedule = PublicProgressSchedule::default();
        let _run = session.try_begin_run().unwrap();
        session.abort();

        schedule.before_context_recovery(&session, &sink, &mut summary);

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(
            !observed
                .iter()
                .any(|event| event["type"] == "assistant.progress.delta")
        );
    }
}
