use super::*;

/// A bounded PNG from the configured Veil image route. Runtime identity and
/// filesystem locations stay on Veil; this transport only carries user content.
pub async fn generate_image(
    session: &Session,
    prompt: &str,
    width: u64,
    height: u64,
) -> Result<Vec<u8>, String> {
    if !session.config.provider.image_generation {
        return Err("Image generation is not available.".into());
    }
    let (mut endpoint, host_header) = request_endpoint(&session.config.provider)?;
    endpoint.set_path("/api/images/generate");
    endpoint.set_query(None);
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint)
        .timeout(std::time::Duration::from_secs(910));
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let response = request
        .json(&json!({"prompt":prompt,"width":width,"height":height}))
        .send()
        .await
        .map_err(|_| "The image service could not be reached.")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            404 => "Image generation is not configured. Choose a model in Settings → Image.",
            429 => "An image is already being generated. Try again when it finishes.",
            _ => "Image generation failed. Try a smaller image or free some memory.",
        }
        .into());
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        != Some("image/png")
    {
        return Err("The image service returned an invalid image.".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Image transfer interrupted.")?;
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Image exceeds the size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() < 24
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16] != b"IHDR"
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as u64 != width
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as u64 != height
    {
        return Err("The image service returned an invalid image.".into());
    }
    Ok(bytes)
}
