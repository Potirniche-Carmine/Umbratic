use std::sync::Arc;

use serde_json::Value;

use crate::{
    events::increment,
    loop_runtime::prepared_messages,
    session::{EventSink, Session},
    veil_client::{VeilRequestOptions, stream_veil_chat},
};

pub async fn stream_public_progress(session: &Arc<Session>, sink: &EventSink, summary: &mut Value) {
    let Ok(prepared) = prepared_messages(session, &[]).await else {
        return;
    };
    let response = stream_veil_chat(
        session,
        sink,
        &prepared.messages,
        &[],
        VeilRequestOptions {
            max_output_tokens: prepared.max_output_tokens.min(192),
            include_tools: false,
            require_tool_call: false,
            suppress_output: false,
            public_progress: true,
        },
    )
    .await;
    if let Ok(result) = response {
        increment(
            summary,
            "progressTextChars",
            result.content.len().min(2 * 1024) as u64,
        );
    }
}
