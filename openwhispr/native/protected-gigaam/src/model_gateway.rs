//! Client for the isolated proprietary-model API.
//!
//! Existing `/register`, `/me`, DeepSeek, and SaluteSpeech routes are untouched. The old
//! install JWT is used only as bootstrap authorization; this module obtains a short-lived,
//! DPoP-bound model token and uses it to fetch release metadata and a per-device wrapped CEK.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use once_cell::sync::Lazy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::model_identity::{dpop_proof, HardwareIdentity, ModelDeviceIdentity, WrappedContentKey};
use crate::protected::ContentKey;

const MODEL_API: &str = "/model/v1";
const MODEL_KEYCHAIN_SERVICE: &str = "ai.gigatype.model-access";
const MAX_JSON_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
static ACCESS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseDescriptor {
    pub schema: u32,
    pub model_id: String,
    pub release_id: String,
    pub key_id: String,
    pub container_url: String,
    pub container_size: u64,
    pub container_sha256: String,
    pub min_client_version: String,
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    model_id: &'a str,
    device: &'a ModelDeviceIdentity,
    client_version: &'a str,
    platform: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelTokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    signing_fingerprint: String,
}

#[derive(Serialize)]
struct KeyRequest<'a> {
    model_id: &'a str,
    release_id: &'a str,
    key_id: &'a str,
    wrapping_fingerprint: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyResponse {
    wrapped_key: WrappedContentKey,
}

#[derive(Deserialize)]
struct GatewayError {
    error: Option<String>,
    detail: Option<String>,
}

pub struct ReleaseAccess {
    pub release: ReleaseDescriptor,
    pub content_key: ContentKey,
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("build protected-model HTTP client")
}

fn exact_url(base: &str, path: &str) -> Result<String> {
    let base = reqwest::Url::parse(base).context("parse gateway URL")?;
    if base.scheme() != "https" || !base.username().is_empty() || base.password().is_some() {
        bail!("model gateway must be an HTTPS origin without credentials");
    }
    let mut url = base.join(path).context("build model gateway URL")?;
    url.set_fragment(None);
    Ok(url.into())
}

async fn parse_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = response
        .bytes()
        .await
        .context("read model gateway response")?;
    if bytes.len() > MAX_JSON_BYTES {
        bail!("model gateway response is too large");
    }
    if !content_type.contains("json") || bytes.starts_with(b"<") {
        bail!("model gateway returned a non-JSON response (HTTP {status})");
    }
    if !status.is_success() {
        let error: GatewayError = serde_json::from_slice(&bytes).unwrap_or(GatewayError {
            error: None,
            detail: None,
        });
        let reason = error
            .error
            .or(error.detail)
            .unwrap_or_else(|| "request rejected".to_string());
        bail!("model gateway rejected the request (HTTP {status}): {reason}");
    }
    serde_json::from_slice(&bytes).context("parse model gateway JSON")
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("release container SHA-256 is malformed");
    }
    Ok(())
}

fn validate_release(release: &ReleaseDescriptor, expected_model: &str) -> Result<()> {
    if release.schema != 1 || release.model_id != expected_model {
        bail!("model gateway returned the wrong release identity");
    }
    if release.release_id.is_empty() || release.key_id.is_empty() || release.container_size == 0 {
        bail!("model gateway returned incomplete release metadata");
    }
    validate_sha256(&release.container_sha256)?;
    let url = reqwest::Url::parse(&release.container_url).context("parse model container URL")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        bail!("model container URL must be HTTPS and contain no credentials");
    }
    Ok(())
}

fn cache_account(key_id: &str) -> String {
    let digest = Sha256::digest(key_id.as_bytes());
    format!("wrapped-cek-{}", STANDARD.encode(&digest[..18]))
}

fn save_wrapped_key(wrapped: &WrappedContentKey) -> Result<()> {
    let value = serde_json::to_string(wrapped)?;
    keyring::Entry::new(MODEL_KEYCHAIN_SERVICE, &cache_account(&wrapped.key_id))
        .context("open model credential entry")?
        .set_password(&value)
        .context("save wrapped model key")
}

fn read_wrapped_key(key_id: &str) -> Result<Option<WrappedContentKey>> {
    let entry = keyring::Entry::new(MODEL_KEYCHAIN_SERVICE, &cache_account(key_id))
        .context("open model credential entry")?;
    match entry.get_password() {
        Ok(value) => Ok(Some(
            serde_json::from_str(&value).context("parse cached wrapped model key")?,
        )),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!("read cached wrapped model key: {error}")),
    }
}

pub async fn cached_content_key(release_id: &str, key_id: &str) -> Result<Option<ContentKey>> {
    let release_id = release_id.to_owned();
    let key_id = key_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some(wrapped) = read_wrapped_key(&key_id)? else {
            return Ok(None);
        };
        if wrapped.release_id != release_id || wrapped.key_id != key_id {
            bail!("cached wrapped model key has mismatched release metadata");
        }
        let identity = HardwareIdentity::load()?;
        identity.unwrap(&wrapped).map(Some)
    })
    .await
    .context("join hardware key task")?
}

pub async fn acquire_release(model_id: &str, expected_release_id: &str) -> Result<ReleaseAccess> {
    let _single_flight = ACCESS_LOCK.lock().await;
    if expected_release_id.is_empty()
        || expected_release_id.len() > 128
        || !expected_release_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("bundled protected-model release id is unsafe");
    }
    let model_id = model_id.to_owned();
    let (identity, device) = tokio::task::spawn_blocking(|| {
        let identity = HardwareIdentity::load()?;
        let device = identity.public_identity()?;
        Ok::<_, anyhow::Error>((identity, device))
    })
    .await
    .context("join hardware identity task")??;
    let (install_token, base) = crate::gateway_identity::install_token()
        .await
        .map_err(|error| anyhow!(error))?;
    let http = client()?;

    let token_url = exact_url(&base, &format!("{MODEL_API}/token"))?;
    let token_dpop = dpop_proof(&identity, "POST", &token_url, Some(&install_token))?;
    let token: ModelTokenResponse = parse_json(
        http.post(&token_url)
            .bearer_auth(&install_token)
            .header("DPoP", token_dpop)
            .json(&TokenRequest {
                model_id: &model_id,
                device: &device,
                client_version: env!("CARGO_PKG_VERSION"),
                platform: std::env::consts::OS,
            })
            .send()
            .await
            .context("request model access token")?,
    )
    .await?;
    if token.token_type != "DPoP"
        || token.access_token.is_empty()
        || token.expires_in == 0
        || token.signing_fingerprint != device.signing_fingerprint
    {
        bail!("model gateway returned an invalid or unbound access token");
    }

    // A bundled app may be installed for the first time after a newer model becomes current.
    // Resolve the exact signed release carried by this build instead of making old installers
    // permanently unable to obtain their first wrapped CEK.
    let mut release_url = reqwest::Url::parse(&exact_url(
        &base,
        &format!("{MODEL_API}/releases/{expected_release_id}"),
    )?)?;
    release_url
        .query_pairs_mut()
        .append_pair("model_id", &model_id);
    let release_url = release_url.to_string();
    let release_dpop = dpop_proof(&identity, "GET", &release_url, Some(&token.access_token))?;
    let release: ReleaseDescriptor = parse_json(
        http.get(&release_url)
            .header("Authorization", format!("DPoP {}", token.access_token))
            .header("DPoP", release_dpop)
            .send()
            .await
            .context("request protected model release")?,
    )
    .await?;
    validate_release(&release, &model_id)?;
    if release.release_id != expected_release_id {
        bail!("model gateway returned a different release than the bundled container");
    }

    let key_url = exact_url(
        &base,
        &format!("{MODEL_API}/releases/{}/key", release.release_id),
    )?;
    let key_dpop = dpop_proof(&identity, "POST", &key_url, Some(&token.access_token))?;
    let key: KeyResponse = parse_json(
        http.post(&key_url)
            .header("Authorization", format!("DPoP {}", token.access_token))
            .header("DPoP", key_dpop)
            .json(&KeyRequest {
                model_id: &model_id,
                release_id: &release.release_id,
                key_id: &release.key_id,
                wrapping_fingerprint: &device.wrapping_fingerprint,
            })
            .send()
            .await
            .context("request wrapped model key")?,
    )
    .await?;
    if key.wrapped_key.release_id != release.release_id
        || key.wrapped_key.key_id != release.key_id
        || key.wrapped_key.wrapping_fingerprint != device.wrapping_fingerprint
    {
        bail!("model gateway returned a wrapped key for another release or device");
    }
    let content_key = identity.unwrap(&key.wrapped_key)?;
    let wrapped = key.wrapped_key;
    tokio::task::spawn_blocking(move || save_wrapped_key(&wrapped))
        .await
        .context("join wrapped-key persistence task")??;
    Ok(ReleaseAccess {
        release,
        content_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_rejects_non_https_and_wrong_identity() {
        let release = ReleaseDescriptor {
            schema: 1,
            model_id: "expected".into(),
            release_id: "r1".into(),
            key_id: "k1".into(),
            container_url: "http://disk.yandex.ru/model".into(),
            container_size: 42,
            container_sha256: "ab".repeat(32),
            min_client_version: "0.6.0".into(),
        };
        assert!(validate_release(&release, "expected").is_err());
        let mut https = release;
        https.container_url = "https://disk.yandex.ru/model".into();
        assert!(validate_release(&https, "other").is_err());
        assert!(validate_release(&https, "expected").is_ok());
    }

    #[test]
    fn gateway_url_cannot_smuggle_credentials() {
        assert!(exact_url("https://user:pass@example.com", "/model/v1/token").is_err());
        assert_eq!(
            exact_url("https://gw.example", "/model/v1/token").unwrap(),
            "https://gw.example/model/v1/token"
        );
    }
}
