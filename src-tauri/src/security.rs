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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use keyring::Entry;
use once_cell::sync::Lazy;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.loach.app";
const ACCOUNT: &str = "app_lock";

// ---------------------------------------------------------------------------
// Rate-limit state for `unlock`.
//
// Tracks consecutive failed attempts and, once `LOCKOUT_THRESHOLD` is
// exceeded, refuses further attempts for an escalating window. The state is
// held in-memory at module scope — surviving across IPC calls but reset on
// app restart, which is the right trade-off for a desktop app: persisting
// the counter to disk would let an attacker reset it by deleting a file,
// while not persisting it means the bound applies to the (short-lived) IPC
// session the attacker has — they still pay the wall-clock cost on each
// fresh launch.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct UnlockState {
    consecutive_failures: u32,
    locked_until: Option<Instant>,
}

static UNLOCK_STATE: Lazy<Mutex<UnlockState>> =
    Lazy::new(|| Mutex::new(UnlockState::default()));

const LOCKOUT_THRESHOLD: u32 = 5;
/// First lockout is 30 s; each additional failure doubles, capped at ~2 h.
const BASE_LOCKOUT_SECS: u64 = 30;
const MAX_LOCKOUT_SECS: u64 = 2 * 60 * 60;

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

/// Check whether we're currently inside the rate-limit cool-down. Returns
/// an error with the remaining time when locked; `Ok(())` otherwise. Used
/// before any argon2 verification so brute-force callers can't even trigger
/// a hash during the window.
fn check_lockout() -> Result<()> {
    let st = UNLOCK_STATE.lock().unwrap();
    if let Some(until) = st.locked_until {
        let now = Instant::now();
        if until > now {
            let remaining = (until - now).as_secs().max(1);
            bail!(
                "Too many failed attempts. Try again in {} second{}.",
                remaining,
                if remaining == 1 { "" } else { "s" }
            );
        }
    }
    Ok(())
}

/// Record the outcome of a credential-verification attempt and update the
/// lockout state. On success, the counter is reset. On failure, the counter
/// is bumped and, once past the threshold, an exponentially-growing cool-
/// down window is set.
fn record_attempt(ok: bool) {
    let mut st = UNLOCK_STATE.lock().unwrap();
    if ok {
        st.consecutive_failures = 0;
        st.locked_until = None;
    } else {
        st.consecutive_failures = st.consecutive_failures.saturating_add(1);
        if st.consecutive_failures >= LOCKOUT_THRESHOLD {
            let over = st.consecutive_failures - LOCKOUT_THRESHOLD;
            let shift = over.min(12);
            let secs = BASE_LOCKOUT_SECS
                .saturating_mul(1u64 << shift)
                .min(MAX_LOCKOUT_SECS);
            st.locked_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }
}

/// Verify pin + password against a loaded config. Returns true only when
/// every factor the method requires checks out.
fn verify_against_config(
    cfg: &LockConfig,
    pin: Option<&str>,
    password: Option<&str>,
) -> bool {
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
    pin_ok && pw_ok
}

/// Validate inputs against the chosen method and persist a fresh config.
///
/// When a lock is already configured this is a *replace* and the caller MUST
/// supply the current credentials in `current_pin` / `current_password` —
/// otherwise an attacker with a renderer-bug foothold could just overwrite
/// the existing lock with one they know. The initial-setup case (no existing
/// config) ignores the `current_*` fields.
pub fn setup(
    method: LockMethod,
    pin: Option<&str>,
    password: Option<&str>,
    pin_length: Option<u8>,
    hint: Option<String>,
    current_pin: Option<&str>,
    current_password: Option<&str>,
) -> Result<()> {
    // Replace-vs-init gate. If there's a current config, demand the current
    // credentials before we wipe the row. Funnel the verification through
    // the same rate-limit counter `unlock` uses so an attacker that can
    // call `setup` directly (compromised renderer, IPC handle reuse, etc.)
    // can't brute-force the current credentials without paying the same
    // exponential cool-down. The initial-setup case (no existing config)
    // skips both checks because there's nothing to brute-force.
    if let Some(existing) = load()? {
        check_lockout()?;
        let ok = verify_against_config(&existing, current_pin, current_password);
        record_attempt(ok);
        if !ok {
            bail!("Current credentials are required to change the app lock.");
        }
    }

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
    save(&cfg)?;
    // A fresh setup also resets any in-flight lockout — the new credentials
    // are valid by construction and there's no reason to keep the user
    // locked out from their own keyring entry.
    reset_unlock_state();
    Ok(())
}

/// Verify supplied credentials against the stored hashes. Both required
/// factors must match for the call to return `true`. Returns `true` when no
/// lock is configured at all.
///
/// Rate-limited: after `LOCKOUT_THRESHOLD` consecutive failures the call
/// rejects further attempts (without even hashing) for an exponentially
/// growing window. A successful unlock resets the counter.
pub fn unlock(pin: Option<&str>, password: Option<&str>) -> Result<bool> {
    check_lockout()?;

    let cfg = match load()? {
        Some(c) => c,
        None => return Ok(true),
    };

    let ok = verify_against_config(&cfg, pin, password);
    record_attempt(ok);
    Ok(ok)
}

fn reset_unlock_state() {
    let mut st = UNLOCK_STATE.lock().unwrap();
    st.consecutive_failures = 0;
    st.locked_until = None;
}

pub fn get_hint() -> Result<Option<String>> {
    Ok(load()?.and_then(|c| c.hint))
}

/// Internal, unchecked clear. Used by `factory_reset`, which has its own
/// destructive-action gate. Renderer code MUST go through
/// `clear_with_credentials` instead.
pub fn clear() -> Result<()> {
    let result = match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    };
    // Clearing the lock invalidates any in-flight lockout — the keyring
    // entry that the cool-down was guarding is now gone.
    reset_unlock_state();
    result
}

/// Renderer-facing clear that demands the current credentials before
/// deleting the keyring entry. Idempotent when no lock is configured.
/// Rate-limited via the shared counter so a renderer-driven brute-force
/// can't bypass the cool-down by switching from `unlock` to `clear`.
pub fn clear_with_credentials(
    current_pin: Option<&str>,
    current_password: Option<&str>,
) -> Result<()> {
    if let Some(cfg) = load()? {
        check_lockout()?;
        let ok = verify_against_config(&cfg, current_pin, current_password);
        record_attempt(ok);
        if !ok {
            bail!("Current credentials are required to remove the app lock.");
        }
    }
    clear()
}

/// Boundary check used by destructive renderer commands (`factory_reset`,
/// `wipe_user_data`, `import_data_with_dialog`, …). When a lock is
/// configured, the renderer must hand us the user's current credentials so
/// we can prove the action was authorised by a human at the keyboard.
/// When no lock is configured, the gate is a no-op — the user already opted
/// out of authenticated access.
///
/// Same rate-limit gate as `unlock` — destructive commands are exactly the
/// surface an attacker would prefer to brute-force credentials against
/// (one successful guess wipes the user's data), so they get the same
/// exponential cool-down on failure.
pub fn require_unlocked(
    current_pin: Option<&str>,
    current_password: Option<&str>,
) -> Result<()> {
    if let Some(cfg) = load()? {
        check_lockout()?;
        let ok = verify_against_config(&cfg, current_pin, current_password);
        record_attempt(ok);
        if !ok {
            bail!("Current app-lock credentials are required for this action.");
        }
    }
    Ok(())
}
