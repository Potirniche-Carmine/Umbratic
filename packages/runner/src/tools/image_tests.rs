use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn session(root: &Path, port: u16, enabled: bool) -> Arc<Session> {
    let mut session = crate::session::test_session(root);
    let config = Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config).unwrap();
    config.provider.base_url = format!("http://127.0.0.1:{port}");
    config.provider.image_generation = enabled;
    config.provider.api_key = Arc::new(std::sync::RwLock::new("image-test-token".into()));
    config.permission_mode = PermissionMode::AutoSafe;
    session
}

async fn run(session: Arc<Session>, args: Value) -> ToolResult {
    let sink = crate::session::test_sink(&session.config.cwd);
    execute_tool(
        session,
        sink,
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "image-call".into(),
            name: "generate_image".into(),
            arguments: args,
            index: 0,
        },
    )
    .await
}

#[tokio::test]
async fn image_tool_is_feature_gated_and_validates_before_network_or_permission() {
    let root = tempfile::tempdir().unwrap();
    let args = json!({"prompt":"sphere","path":"sphere.png"});
    assert_eq!(
        run(session(root.path(), 1, false), args).await.status,
        "validation_error"
    );
    for args in [
        json!({"prompt":"sphere","path":"../escape.png"}),
        json!({"prompt":"sphere","path":".env"}),
        json!({"prompt":"sphere","path":"sphere.png","width":257}),
        json!({"prompt":"sphere","path":"sphere.png","height":2048}),
        json!({"prompt":"sphere","path":"sphere.png","model":"private"}),
    ] {
        let result = run(session(root.path(), 1, true), args).await;
        assert_ne!(result.status, "success");
        assert_ne!(result.status, "runtime_error");
    }
    assert!(!root.path().join("sphere.png").exists());
}

#[tokio::test]
async fn image_tool_sends_only_bounded_content_to_veil_and_saves_png() {
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend(512_u32.to_be_bytes());
    png.extend(512_u32.to_be_bytes());
    let expected = png.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        let mut buffer = [0; 1024];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&buffer[..n]);
            let text = String::from_utf8_lossy(&bytes);
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .map(|(_, v)| v.trim().parse().unwrap())
                    })
                    .unwrap();
                if body.len() >= length {
                    break;
                }
            }
        }
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            png.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(&png).await.unwrap();
        String::from_utf8(bytes).unwrap()
    });
    let result = run(
        session(root.path(), port, true),
        json!({"prompt":"a red sphere","path":"sphere.png"}),
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert_eq!(fs::read(root.path().join("sphere.png")).unwrap(), expected);
    assert_eq!(result.details.as_ref().unwrap()["image"], true);
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /api/images/generate HTTP/1.1"));
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer image-test-token")
    );
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body,
        json!({"prompt":"a red sphere","width":512,"height":512})
    );
    let result = run(
        session(root.path(), 1, true),
        json!({"prompt":"replacement","path":"sphere.png"}),
    )
    .await;
    assert_eq!(result.status, "validation_error");
    assert_eq!(fs::read(root.path().join("sphere.png")).unwrap(), expected);
}
