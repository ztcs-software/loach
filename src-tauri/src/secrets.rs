use anyhow::{anyhow, Result};
use keyring::Entry;

const SERVICE: &str = "dev.loach.app";
const OPENAI_ACCOUNT: &str = "openai_api_key";

/// Hard cap on the stored OpenAI API key. Real keys are a few dozen
/// characters; this gives a lot of headroom for future longer-key formats
/// while still rejecting a renderer that tries to OOM the keyring (or
/// log file) by stuffing megabytes of garbage in.
const MAX_KEY_BYTES: usize = 2048;

/// Windows Credential Manager stores the key as UTF-16 in a blob of at most
/// 2560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), so there anything over 1280
/// UTF-16 units fails inside the keyring with a raw `TooLong`. Checked up
/// front so such a key gets the same message as any other over-long one.
const WINDOWS_MAX_BLOB_BYTES: usize = 2560;

fn key_fits(key: &str) -> bool {
    key.len() <= MAX_KEY_BYTES
        && (!cfg!(windows) || key.encode_utf16().count() * 2 <= WINDOWS_MAX_BLOB_BYTES)
}

/// A keyring entry for `service` / `user`.
///
/// keyring's `v1` feature sets the platform store up once per process (a
/// `LazyLock`) and keeps a failure for good. On Linux that's a Secret Service
/// connect, so a session bus or keyring daemon that wasn't up yet at the first
/// call failed every later one with `NoDefaultStore` until a restart — the
/// lock read as unconfigured on installs without the marker file, and the
/// OpenAI key couldn't be read or saved. keyring-core's default store can be
/// replaced at any time, so on that error connect again and build the entry
/// on the new store; a connect that still fails is retried on the next call.
pub fn keyring_entry(service: &str, user: &str) -> keyring::Result<Entry> {
    let entry = Entry::new(service, user);
    #[cfg(target_os = "linux")]
    if matches!(entry, Err(keyring::Error::NoDefaultStore)) {
        if keyring_core::get_default_store().is_none() {
            keyring_core::set_default_store(zbus_secret_service_keyring_store::Store::new()?);
        }
        return Ok(Entry {
            inner: keyring_core::Entry::new(service, user)?,
        });
    }
    entry
}

fn entry() -> Result<Entry> {
    Ok(keyring_entry(SERVICE, OPENAI_ACCOUNT)?)
}

pub fn set_openai_key(key: &str) -> Result<()> {
    // Reject empty strings up-front. The keyring would happily store
    // `""` and `has_openai_key()` would then return `true`, leading to
    // `bearer_auth("")` being sent to OpenAI on every request — confusing
    // 401 to debug. Trim first so a key that's all whitespace also fails.
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("OpenAI API key is empty"));
    }
    if !key_fits(trimmed) {
        return Err(anyhow!(
            "OpenAI API key is unusually long ({} chars) — refusing to store",
            trimmed.len()
        ));
    }
    entry()?.set_password(trimmed)?;
    Ok(())
}

pub fn get_openai_key() -> Result<Option<String>> {
    match entry()?.get_password() {
        // Defensive: if an older build (or a manually-edited keyring
        // entry) somehow left an empty string in place, treat it as
        // "no key set" so callers don't send a bare `Authorization:
        // Bearer ` header.
        Ok(v) if v.trim().is_empty() => Ok(None),
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn has_openai_key() -> bool {
    matches!(get_openai_key(), Ok(Some(_)))
}

pub fn clear_openai_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key Windows Credential Manager can't hold is refused here with the
    /// friendly message, not by the keyring with a raw `TooLong`.
    #[test]
    fn key_length_matches_the_platform_limit() {
        assert!(key_fits("sk-proj-abc"));
        assert!(key_fits(&"k".repeat(1280)));
        assert_eq!(key_fits(&"k".repeat(1281)), !cfg!(windows));
        assert_eq!(key_fits(&"k".repeat(MAX_KEY_BYTES)), !cfg!(windows));
        assert!(!key_fits(&"k".repeat(MAX_KEY_BYTES + 1)));
    }
}
