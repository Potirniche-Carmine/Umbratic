use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    events::{increment, now_iso},
    session::{EventSink, Session},
    tools::ToolCall,
};

// Progress text describes runner orchestration state, not the assistant's own
// speech. Keep it a short neutral label so the desktop can render it as status
// instead of prose.
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

    pub(crate) fn before_tools(
        &mut self,
        session: &Arc<Session>,
        sink: &EventSink,
        summary: &mut Value,
        calls: &[ToolCall],
    ) {
        self.emit(session, sink, summary, &progress_for_calls(calls));
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

pub(crate) fn progress_for_calls(calls: &[ToolCall]) -> String {
    let progress = if calls.len() != 1 {
        "Running workspace actions"
    } else {
        match calls[0].name.as_str() {
            "read" | "read_attachment" | "retrieve_context" | "read_skill" => "Reading files",
            "search" => "Searching the codebase",
            "lsp" | "workspace_graph" => "Inspecting code relationships",
            "write" | "edit" | "apply_patch" => "Editing files",
            "command" | "run_program" => "Running a command",
            _ => "Working in the workspace",
        }
    };
    progress.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "call".into(),
            name: name.into(),
            arguments: json!({}),
            index: 0,
        }
    }

    #[test]
    fn progress_names_the_active_tool_phase() {
        assert_eq!(
            progress_for_calls(&[call("search")]),
            "Searching the codebase"
        );
        assert_eq!(progress_for_calls(&[call("command")]), "Running a command");
        assert_eq!(progress_for_calls(&[call("edit")]), "Editing files");
        assert_eq!(
            progress_for_calls(&[call("read"), call("search")]),
            "Running workspace actions"
        );
    }

    #[test]
    fn progress_never_speaks_in_the_assistant_voice() {
        let phases = [
            progress_for_calls(&[call("read")]),
            progress_for_calls(&[call("search")]),
            progress_for_calls(&[call("lsp")]),
            progress_for_calls(&[call("write")]),
            progress_for_calls(&[call("run_program")]),
            progress_for_calls(&[call("unknown")]),
            progress_for_calls(&[call("read"), call("read")]),
            CONTEXT_RECOVERY_PROGRESS.to_owned(),
        ];
        for phase in phases {
            let lowered = phase.to_ascii_lowercase();
            assert!(!lowered.contains(" i "), "{phase} narrates in first person");
            assert!(
                !lowered.starts_with("i "),
                "{phase} narrates in first person"
            );
            assert!(
                !lowered.contains("model"),
                "{phase} exposes model orchestration state"
            );
            assert!(!phase.contains('.'), "{phase} should be a label, not prose");
        }
    }

    #[test]
    fn a_repeated_phase_is_emitted_once() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let mut summary = crate::events::empty_summary();
        let mut schedule = PublicProgressSchedule::default();
        let read = call("read");

        schedule.before_tools(&session, &sink, &mut summary, std::slice::from_ref(&read));
        schedule.before_tools(&session, &sink, &mut summary, std::slice::from_ref(&read));

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        let progress = observed
            .iter()
            .filter(|event| event["type"] == "assistant.progress.delta")
            .collect::<Vec<_>>();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0]["text"], "Reading files");
    }

    #[test]
    fn a_changed_phase_is_emitted_again() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let mut summary = crate::events::empty_summary();
        let mut schedule = PublicProgressSchedule::default();

        schedule.before_tools(&session, &sink, &mut summary, &[call("read")]);
        schedule.before_tools(&session, &sink, &mut summary, &[call("edit")]);
        schedule.before_tools(&session, &sink, &mut summary, &[call("read")]);

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        let texts = observed
            .iter()
            .filter(|event| event["type"] == "assistant.progress.delta")
            .map(|event| event["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(texts, ["Reading files", "Editing files", "Reading files"]);
    }

    #[test]
    fn an_aborted_session_stops_emitting_progress() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let mut summary = crate::events::empty_summary();
        let mut schedule = PublicProgressSchedule::default();
        let _turn = session.try_begin_turn().unwrap();
        session.abort();

        schedule.before_tools(&session, &sink, &mut summary, &[call("read")]);
        schedule.before_context_recovery(&session, &sink, &mut summary);

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(
            !observed
                .iter()
                .any(|event| event["type"] == "assistant.progress.delta")
        );
    }
}
