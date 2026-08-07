use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    compaction::CompactionOutcome,
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

/// Announces the summarization tier of compaction as a lifecycle, not a label.
///
/// The deterministic tier is local and finishes in milliseconds, so it is not
/// worth interrupting the UI for. The semantic tier is a whole extra model
/// round-trip taken *before* the turn's real request goes out, and rewriting
/// the prefix also discards the provider's prefix cache, so the next response
/// starts from a cold prefill. That is seconds of apparent silence with no tool
/// row to explain it, which is exactly the case a status affordance exists for.
///
/// Started and finished are separate events because the UI has to show elapsed
/// time while it runs; a single after-the-fact label cannot.
pub(crate) fn compaction_started(session: &Session, sink: &EventSink) {
    if session.is_aborted() {
        return;
    }
    sink.emit(json!({
        "type": "context.compaction",
        "taskId": session.task_id,
        "phase": "started",
        "at": now_iso()
    }));
}

/// Reports how the attempt ended, including when it changed nothing.
///
/// A refused compaction still costs the user the wait, so it is reported rather
/// than left as a status line that silently disappears.
pub(crate) fn compaction_finished(
    session: &Session,
    sink: &EventSink,
    outcome: CompactionOutcome,
    before_tokens: u64,
    after_tokens: u64,
) {
    if session.is_aborted() {
        return;
    }
    let compacted = outcome.compacted();
    sink.emit(json!({
        "type": "context.compaction",
        "taskId": session.task_id,
        "phase": "finished",
        // A round-trip that came back unusable is reported as such rather than
        // as a no-op: the user waited for it either way, and only one of the two
        // is a fault worth showing.
        "outcome": match outcome {
            CompactionOutcome::Compacted => "compacted",
            CompactionOutcome::Refused => "unchanged",
            CompactionOutcome::Failed => "failed",
        },
        // Reclaim is only meaningful when the prefix was actually replaced, and
        // it is an estimate on both sides — the same heuristic that decided to
        // compact, never a measurement it does not have yet.
        "reclaimedTokens": if compacted { before_tokens.saturating_sub(after_tokens) } else { 0 },
        "at": now_iso()
    }));
}

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
    fn a_compaction_that_changed_nothing_still_reports_finishing() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();

        compaction_started(&session, &sink);
        compaction_finished(&session, &sink, CompactionOutcome::Refused, 50_000, 50_000);

        let observed = std::iter::from_fn(|| events.try_recv().ok())
            .filter(|event| event["type"] == "context.compaction")
            .collect::<Vec<_>>();
        assert_eq!(observed.len(), 2);
        assert_eq!(observed[0]["phase"], "started");
        assert_eq!(observed[1]["phase"], "finished");
        assert_eq!(observed[1]["outcome"], "unchanged");
        // A refused compaction must never claim it freed anything.
        assert_eq!(observed[1]["reclaimedTokens"], 0);
    }

    #[test]
    fn a_successful_compaction_reports_what_it_reclaimed() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();

        compaction_finished(
            &session,
            &sink,
            CompactionOutcome::Compacted,
            50_000,
            18_000,
        );

        let observed = std::iter::from_fn(|| events.try_recv().ok())
            .find(|event| event["type"] == "context.compaction")
            .unwrap();
        assert_eq!(observed["outcome"], "compacted");
        assert_eq!(observed["reclaimedTokens"], 32_000);
    }

    #[test]
    fn an_aborted_session_announces_no_compaction() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let _run = session.try_begin_run().unwrap();
        session.abort();

        compaction_started(&session, &sink);
        compaction_finished(
            &session,
            &sink,
            CompactionOutcome::Compacted,
            50_000,
            18_000,
        );

        assert!(
            !std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| event["type"] == "context.compaction")
        );
    }

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
