use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    events::{increment, now_iso},
    session::{EventSink, Session},
};

pub(crate) async fn record_answer(session: &Arc<Session>, summary: &mut Value, answer: &str) {
    increment(summary, "assistantTextChars", answer.len() as u64);
    session
        .messages
        .lock()
        .await
        .push(json!({"role":"assistant","content":answer}));
}

pub(crate) async fn emit_fallback_answer(
    session: &Arc<Session>,
    sink: &EventSink,
    summary: &mut Value,
    fallback: &str,
) {
    sink.emit(
        json!({"type":"assistant.delta","taskId":session.task_id,"text":fallback,"at":now_iso()}),
    );
    record_answer(session, summary, fallback).await;
}
