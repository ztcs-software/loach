use anyhow::{anyhow, Result};
use keyring::Entry;

const SERVICE: &str = "dev.loach.app";
const OPENAI_ACCOUNT: &str = "openai_api_key";

/// Hard cap on the stored OpenAI API key. Real keys are a few dozen
/// characters; this gives a lot of headroom for future longer-key formats
/// while still rejecting a renderer that tries to OOM the keyring (or
/// log file) by stuffing megabytes of garbage in.
const MAX_KEY_BYTES: usize = 2048;

fn entry() -> Result<Entry> {
    Ok(Entry::new(SERVICE, OPENAI_ACCOUNT)?)
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
    if trimmed.len() > MAX_KEY_BYTES {
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
