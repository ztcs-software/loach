//! App-lock subsystem.
//!
//! Stores a single JSON blob in the OS credential store (Windows Credential
//! Manager / Linux Secret Service via the same `keyring` crate we use for the
//! OpenAI key). The blob carries:
//!
//!   - the lock method (PIN, password, or both),
//!   - argon2id PHC strings for whichever credentials are configured,
//!   - the optional user-provided hint (plaintext — by design, since hints
//!     are only useful if the user can read them after a failed unlock).
//!
//! The actual PIN / password is never persisted in plaintext, never sent to
//! the frontend, and never written to SQLite. Verification is performed in
//! Rust against the argon2 hash.

use anyhow::{anyhow, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use keyring::Entry;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.loach.app";
const ACCOUNT: &str = "app_lock";

/// Which credentials gate access to the app.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LockMethod {
    /// PIN required, password not in use.
    Pin,
    /// Password required, PIN not in use.
    Password,
    /// Both PIN and password required to unlock — most secure option.
    Both,
}

/// Persisted lock blob — what we serialize into the keyring.
#[derive(Debug, Serialize, Deserialize)]
struct LockConfig {
    method: LockMethod,
    /// 4 / 6 / 8 — only present when the method involves a PIN.
    pin_length: Option<u8>,
    /// argon2id PHC string. Only present when the method involves a PIN.
    pin_hash: Option<String>,
    /// argon2id PHC string. Only present when the method involves a password.
    password_hash: Option<String>,
    /// Optional hint shown on the lock screen via "Show hint". Plaintext,
    /// stored in the same secure blob — users should treat it as a public
    /// reminder, not a recovery secret.
    hint: Option<String>,
}

/// What the frontend gets to see — never the hashes themselves.
#[derive(Debug, Serialize, Deserialize)]
pub struct LockStatus {
    pub configured: bool,
    pub method: Option<LockMethod>,
    pub pin_length: Option<u8>,
    pub has_hint: bool,
}

fn entry() -> Result<Entry> {
    Ok(Entry::new(SERVICE, ACCOUNT)?)
}

fn load() -> Result<Option<LockConfig>> {
    match entry()?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save(cfg: &LockConfig) -> Result<()> {
    let json = serde_json::to_string(cfg)?;
    entry()?.set_password(&json)?;
    Ok(())
}

/// Hash a secret with argon2id + a fresh random salt. Returns a PHC string
/// that embeds the algorithm parameters, salt, and digest — so future
/// verifications work even if we tweak parameters.
fn hash(secret: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let phc = argon2
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|e| anyhow!("argon2 hash failed: {e}"))?
        .to_string();
    Ok(phc)
}

fn verify(secret: &str, phc: &str) -> bool {
    if let Ok(parsed) = PasswordHash::new(phc) {
        Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok()
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Public API — wired through `commands.rs` to the frontend.
// ---------------------------------------------------------------------------

pub fn status() -> Result<LockStatus> {
    Ok(match load()? {
        None => LockStatus {
            configured: false,
            method: None,
            pin_length: None,
            has_hint: false,
        },
        Some(c) => LockStatus {
            configured: true,
            method: Some(c.method),
            pin_length: c.pin_length,
            has_hint: c.hint.is_some(),
        },
    })
}

/// Validate inputs against the chosen method and persist a fresh config.
/// Always replaces any prior config — there's no partial update path because
/// rotating a hash invalidates the whole entry anyway.
pub fn setup(
    method: LockMethod,
    pin: Option<&str>,
    password: Option<&str>,
    pin_length: Option<u8>,
    hint: Option<String>,
) -> Result<()> {
    let needs_pin = matches!(method, LockMethod::Pin | LockMethod::Both);
    let needs_pw = matches!(method, LockMethod::Password | LockMethod::Both);

    if needs_pin {
        let p = pin.ok_or_else(|| anyhow!("PIN is required for this method"))?;
        let len = pin_length.ok_or_else(|| anyhow!("PIN length is required"))?;
        if !matches!(len, 4 | 6 | 8) {
            return Err(anyhow!("PIN length must be 4, 6, or 8"));
        }
        if p.len() != len as usize {
            return Err(anyhow!("PIN must be exactly {len} digits"));
        }
        if !p.chars().all(|c| c.is_ascii_digit()) {
            return Err(anyhow!("PIN must contain digits only"));
        }
    }
    if needs_pw {
        let pw = password.ok_or_else(|| anyhow!("Password is required for this method"))?;
        if pw.chars().count() < 6 {
            return Err(anyhow!("Password must be at least 6 characters"));
        }
    }

    let cfg = LockConfig {
        method,
        pin_length: if needs_pin { pin_length } else { None },
        pin_hash: if needs_pin { Some(hash(pin.unwrap())?) } else { None },
        password_hash: if needs_pw {
            Some(hash(password.unwrap())?)
        } else {
            None
        },
        hint: hint
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    };
    save(&cfg)
}

/// Verify supplied credentials against the stored hashes. Both required
/// factors must match for the call to return `true`. Returns `true` when no
/// lock is configured at all.
pub fn unlock(pin: Option<&str>, password: Option<&str>) -> Result<bool> {
    let cfg = match load()? {
        Some(c) => c,
        None => return Ok(true),
    };

    let pin_ok = match cfg.method {
        LockMethod::Password => true,
        _ => match (cfg.pin_hash.as_deref(), pin) {
            (Some(h), Some(p)) => verify(p, h),
            _ => false,
        },
    };
    let pw_ok = match cfg.method {
        LockMethod::Pin => true,
        _ => match (cfg.password_hash.as_deref(), password) {
            (Some(h), Some(p)) => verify(p, h),
            _ => false,
        },
    };
    Ok(pin_ok && pw_ok)
}

pub fn get_hint() -> Result<Option<String>> {
    Ok(load()?.and_then(|c| c.hint))
}

pub fn clear() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
