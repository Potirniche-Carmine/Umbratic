//! TLS construction for the Veil client.
//!
//! Certificate pinning belongs in the handshake. Checking the pin on a
//! completed response is too late: the platform trust store has already
//! accepted the peer, and the session token and prompt have already been sent.

use std::{fs, net::ToSocketAddrs};

use crate::config::{MtlsConfig, ProviderConfig};

/// Certificate pinning inside the handshake. Verifying the pin on a completed
/// response is too late: by then the platform trust store has accepted the
/// peer and the session token and prompt have already been transmitted. A
/// mismatch here fails the handshake before any request bytes are written.
#[derive(Debug)]
pub(crate) struct PinnedServerCertVerifier {
    pub(crate) inner: std::sync::Arc<rustls::client::WebPkiServerVerifier>,
    pub(crate) expected: [u8; 32],
}

impl rustls::client::danger::ServerCertVerifier for PinnedServerCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls_pki_types::CertificateDer<'_>,
        intermediates: &[rustls_pki_types::CertificateDer<'_>],
        server_name: &rustls_pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use sha2::Digest;
        let actual = sha2::Sha256::digest(end_entity.as_ref());
        if actual.as_slice() != self.expected {
            return Err(rustls::Error::General(
                "Pinned server certificate mismatch.".into(),
            ));
        }
        // Chain, name, and expiry still have to hold. The pin narrows the
        // accepted certificate; it does not replace validation.
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

pub(crate) fn read_pem_certificates(
    path: &std::path::Path,
    label: &str,
) -> Result<Vec<rustls_pki_types::CertificateDer<'static>>, String> {
    use rustls_pki_types::pem::PemObject;
    let bytes = fs::read(path).map_err(|error| format!("Unable to read {label}: {error}"))?;
    rustls_pki_types::CertificateDer::pem_slice_iter(&bytes)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid {label}: {error}"))
}

/// Build the TLS configuration used when a pinned server certificate is
/// configured. Roots, client identity, and protocol versions are assembled here
/// because `use_preconfigured_tls` bypasses the equivalent reqwest builders.
pub(crate) fn pinned_tls_config(
    mtls: &MtlsConfig,
    expected: [u8; 32],
) -> Result<rustls::ClientConfig, String> {
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    if let Some(path) = &mtls.ca_path {
        for certificate in read_pem_certificates(path, "mTLS CA")? {
            roots
                .add(certificate)
                .map_err(|error| format!("Invalid mTLS CA: {error}"))?;
        }
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(
        std::sync::Arc::new(roots),
        provider.clone(),
    )
    .build()
    .map_err(|error| format!("Unable to build the certificate verifier: {error}"))?;
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(rustls::DEFAULT_VERSIONS)
        .map_err(|error| format!("Unable to select TLS versions: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(PinnedServerCertVerifier {
            inner: webpki,
            expected,
        }));
    match (&mtls.cert_path, &mtls.key_path) {
        (Some(cert), Some(key)) => {
            let chain = read_pem_certificates(cert, "mTLS certificate")?;
            let key_bytes =
                fs::read(key).map_err(|error| format!("Unable to read mTLS key: {error}"))?;
            use rustls_pki_types::pem::PemObject;
            let private_key = rustls_pki_types::PrivateKeyDer::from_pem_slice(&key_bytes)
                .map_err(|error| format!("Invalid mTLS key: {error}"))?;
            builder
                .with_client_auth_cert(chain, private_key)
                .map_err(|error| format!("Invalid mTLS identity: {error}"))
        }
        (None, None) => Ok(builder.with_no_client_auth()),
        _ => Err("mTLS certPath and keyPath must be configured together.".into()),
    }
}

pub(crate) fn resolve_server_name(
    builder: reqwest::ClientBuilder,
    provider: &ProviderConfig,
    server_name: &str,
) -> Result<reqwest::ClientBuilder, String> {
    let base = url::Url::parse(&provider.base_url).map_err(|error| error.to_string())?;
    let host = base
        .host_str()
        .ok_or_else(|| "Provider base URL has no host".to_owned())?;
    let port = base
        .port_or_known_default()
        .ok_or_else(|| "Provider base URL has no port".to_owned())?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Unable to resolve provider host: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("Provider host did not resolve to an address.".into());
    }
    Ok(builder.resolve_to_addrs(server_name, &addresses))
}

pub(crate) fn expected_pin(value: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_sha256_fingerprint(value);
    if normalized.len() != 64 {
        return Err(
            "Pinned server certificate SHA-256 must contain 64 hexadecimal characters.".into(),
        );
    }
    let mut expected = [0u8; 32];
    for (index, byte) in expected.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&normalized[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Pinned server certificate SHA-256 is not hexadecimal.".to_owned())?;
    }
    Ok(expected)
}

pub(crate) fn normalize_sha256_fingerprint(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("sha256:")
        .or_else(|| normalized.strip_prefix("sha256/"))
        .unwrap_or(&normalized);
    normalized.chars().filter(char::is_ascii_hexdigit).collect()
}

pub(crate) fn verify_certificate_pin(
    provider: &ProviderConfig,
    response: &reqwest::Response,
) -> Result<(), String> {
    let Some(expected) = provider
        .mtls
        .as_ref()
        .and_then(|mtls| mtls.pinned_server_certificate_sha256.as_deref())
    else {
        return Ok(());
    };
    let expected = normalize_sha256_fingerprint(expected);
    if expected.len() != 64 {
        return Err(
            "Pinned server certificate SHA-256 must contain 64 hexadecimal characters.".into(),
        );
    }
    let certificate = response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .and_then(reqwest::tls::TlsInfo::peer_certificate)
        .ok_or_else(|| {
            "Pinned server certificate was unavailable from the TLS connection.".to_owned()
        })?;
    use sha2::Digest;
    let actual = format!("{:x}", sha2::Sha256::digest(certificate));
    if actual != expected {
        return Err("Pinned server certificate mismatch.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pin has to be enforced by the TLS layer. A check on the completed
    /// response runs after the platform trust store accepted the peer and after
    /// the session token and prompt were already transmitted.
    #[test]
    fn certificate_pinning_runs_inside_the_handshake() {
        use rustls::client::danger::ServerCertVerifier;

        let hex = "ab".repeat(32);
        assert_eq!(expected_pin(&format!("sha256:{hex}")).unwrap(), [0xab; 32]);
        assert!(expected_pin("ab").is_err());
        assert!(expected_pin(&"zz".repeat(32)).is_err());

        let mtls = MtlsConfig {
            ca_path: None,
            cert_path: None,
            key_path: None,
            server_name: None,
            pinned_server_certificate_sha256: Some(hex.clone()),
        };
        // The pinned path builds a usable rustls configuration.
        assert!(pinned_tls_config(&mtls, expected_pin(&hex).unwrap()).is_ok());

        let certificate = rustls_pki_types::CertificateDer::from(vec![1, 2, 3, 4]);
        let expected: [u8; 32] = {
            use sha2::Digest;
            sha2::Sha256::digest(certificate.as_ref()).into()
        };
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(
            std::sync::Arc::new(roots),
            provider,
        )
        .build()
        .unwrap();
        let name = rustls_pki_types::ServerName::try_from("veil.example").unwrap();
        let now = rustls_pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(
            1_800_000_000,
        ));

        // A mismatched certificate is refused by the pin, ahead of chain
        // validation, so the handshake fails before any bytes are sent.
        let mismatched = PinnedServerCertVerifier {
            inner: inner.clone(),
            expected: [0u8; 32],
        };
        let error = mismatched
            .verify_server_cert(&certificate, &[], &name, &[], now)
            .unwrap_err();
        assert!(format!("{error}").contains("Pinned server certificate mismatch"));

        // A matching pin still has to pass ordinary chain validation, which
        // these bytes cannot: the pin narrows trust, it does not replace it.
        let matching = PinnedServerCertVerifier { inner, expected };
        let error = matching
            .verify_server_cert(&certificate, &[], &name, &[], now)
            .unwrap_err();
        assert!(!format!("{error}").contains("Pinned server certificate mismatch"));
    }

    #[test]
    fn certificate_fingerprints_normalize_common_notation() {
        let hex = "AB".repeat(32);
        assert_eq!(
            normalize_sha256_fingerprint(&format!("sha256/{hex}")),
            hex.to_lowercase()
        );
        assert_eq!(
            normalize_sha256_fingerprint(&format!(
                "sha256:{}",
                hex.as_bytes()
                    .chunks(2)
                    .map(|part| std::str::from_utf8(part).unwrap())
                    .collect::<Vec<_>>()
                    .join(":")
            )),
            hex.to_lowercase()
        );
    }
}
