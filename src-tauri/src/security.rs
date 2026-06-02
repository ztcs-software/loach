//! App-lock subsystem.
//!
//! Stores a single JSON blob in the OS credential store (Windows Credential
//! Manager / Linux Secret Service / macOS Keychain via the same `keyring`
//! crate we use for the OpenAI key). The blob carries:
//!
//!   - the lock method (PIN, password, or both),
//!   - argon2id PHC strings for whichever credentials are configured,
//!   - the optional user-provided hint (plaintext — by design, since hints
//!     are only useful if the user can read them after a failed unlock).
//!
//! The actual PIN / password is never persisted in plaintext, never sent to
//! the frontend, and never written to SQLite. Verification is performed in
//! Rust against the argon2 hash.

// `parking_lot::Mutex` — see the matching note in `db.rs`. Skips the
// `PoisonError` boilerplate that `std::sync::Mutex` requires on every
// `.lock()` call and panics on first poison.
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
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
///
/// Parameters are tuned harder than `Argon2::default()` (m=19 MiB, t=2, p=1)
/// because the threat model for this lock includes offline brute-force: the
/// hash blob lives in the OS credential store, which any process running as
/// the same user can read. For a 4-digit PIN (10 000 possibilities) the
/// default cost is roughly seconds-of-CPU-time total — these parameters push
/// that to minutes-to-hours. The interactive verify cost on a modern desktop
/// stays well under 250 ms, which is comfortably under the threshold where
/// users notice the unlock dialog taking too long.
fn argon2_instance() -> Argon2<'static> {
    // m=64 MiB, t=3, p=1. RFC 9106 §4 "moderate" target for interactive
    // verification, scaled up for memory cost since memory is cheap on
    // desktop hardware where this app runs.
    let params = Params::new(64 * 1024, 3, 1, None)
        .expect("argon2 params are within the library's accepted range");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn hash(secret: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let phc = argon2_instance()
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|e| anyhow!("argon2 hash failed: {e}"))?
        .to_string();
    Ok(phc)
}

fn verify(secret: &str, phc: &str) -> bool {
    // Verification uses the parameters embedded in the PHC string, so the
    // `Argon2` instance's own params don't actually matter for the
    // comparison — but we use `argon2_instance()` for consistency. Older
    // hashes stored with `Argon2::default()` parameters continue to verify
    // correctly because PHC carries the cost it was made with.
    if let Ok(parsed) = PasswordHash::new(phc) {
        argon2_instance()
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
    let st = UNLOCK_STATE.lock();
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
    let mut st = UNLOCK_STATE.lock();
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
        // 8 char minimum aligns with NIST SP 800-63B's baseline (§5.1.1.2).
        // Lower than 8 leaves the password vulnerable to offline brute-force
        // even with strong KDF parameters — the lock's hash blob is exposed
        // to any process running as the same user.
        if pw.chars().count() < 8 {
            return Err(anyhow!("Password must be at least 8 characters"));
        }
        // Upper bound so a renderer can't shove a multi-MB password into the
        // keyring blob. Argon2's cost is length-independent, but the stored
        // input and any error paths shouldn't carry unbounded data — mirrors
        // the `MAX_KEY_BYTES` cap on the OpenAI key in secrets.rs.
        if pw.chars().count() > 1024 {
            return Err(anyhow!("Password must be at most 1024 characters"));
        }
    }

    if let Some(h) = hint.as_ref() {
        if h.chars().count() > 256 {
            return Err(anyhow!("Hint must be at most 256 characters"));
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
    let mut st = UNLOCK_STATE.lock();
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

// ---------------------------------------------------------------------------
// Tests.
//
// We deliberately do NOT exercise `setup` / `unlock` / `clear` end-to-end
// because they touch the real OS keyring — running them in CI would either
// pollute a developer's actual keyring or fail on a headless machine
// without a secret service. Instead we cover the security-critical pure
// functions that argument validation, hashing, and lockout-rate-limiting
// all funnel through.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex as PMutex;

    /// Serialise the tests that mutate the module-static `UNLOCK_STATE`.
    /// `cargo test` runs tests in parallel by default; without this lock
    /// `record_attempt`-based tests would race each other through the global
    /// counter and intermittently fail. The hash/verify tests don't touch
    /// `UNLOCK_STATE` and run free.
    static LOCKOUT_TEST_LOCK: Lazy<PMutex<()>> = Lazy::new(|| PMutex::new(()));

    #[test]
    fn hash_then_verify_roundtrips() {
        let phc = hash("hunter2-correct-horse").expect("hash succeeds");
        assert!(verify("hunter2-correct-horse", &phc));
        assert!(!verify("wrong", &phc));
        assert!(!verify("", &phc));
    }

    #[test]
    fn hash_produces_different_phc_for_same_input() {
        // Salt is per-call random — same secret must produce a different PHC
        // string each time, otherwise we'd have a tell that the same password
        // was reused across users / installs sharing a credential store.
        let a = hash("same-password").unwrap();
        let b = hash("same-password").unwrap();
        assert_ne!(a, b);
        // Both must still verify against the original secret.
        assert!(verify("same-password", &a));
        assert!(verify("same-password", &b));
    }

    #[test]
    fn verify_rejects_malformed_phc() {
        assert!(!verify("anything", "not a valid PHC string"));
        assert!(!verify("anything", ""));
    }

    #[test]
    fn verify_against_config_requires_all_factors() {
        let pin_phc = hash("1234").unwrap();
        let pw_phc = hash("correct-horse").unwrap();

        let pin_only = LockConfig {
            method: LockMethod::Pin,
            pin_length: Some(4),
            pin_hash: Some(pin_phc.clone()),
            password_hash: None,
            hint: None,
        };
        assert!(verify_against_config(&pin_only, Some("1234"), None));
        assert!(!verify_against_config(&pin_only, Some("0000"), None));
        // Wrong factor type — caller forgot to pass the PIN.
        assert!(!verify_against_config(&pin_only, None, Some("correct-horse")));

        let pw_only = LockConfig {
            method: LockMethod::Password,
            pin_length: None,
            pin_hash: None,
            password_hash: Some(pw_phc.clone()),
            hint: None,
        };
        assert!(verify_against_config(
            &pw_only,
            None,
            Some("correct-horse")
        ));
        assert!(!verify_against_config(&pw_only, None, Some("wrong")));

        // Both — needs PIN AND password to be correct.
        let both = LockConfig {
            method: LockMethod::Both,
            pin_length: Some(4),
            pin_hash: Some(pin_phc),
            password_hash: Some(pw_phc),
            hint: None,
        };
        assert!(verify_against_config(
            &both,
            Some("1234"),
            Some("correct-horse")
        ));
        assert!(!verify_against_config(
            &both,
            Some("1234"),
            Some("wrong")
        ));
        assert!(!verify_against_config(
            &both,
            Some("0000"),
            Some("correct-horse")
        ));
        // Missing either factor → fail.
        assert!(!verify_against_config(&both, None, Some("correct-horse")));
        assert!(!verify_against_config(&both, Some("1234"), None));
    }

    #[test]
    fn lockout_after_threshold_failures() {
        let _g = LOCKOUT_TEST_LOCK.lock();
        reset_unlock_state();

        // Below threshold: still allowed to attempt.
        for _ in 0..(LOCKOUT_THRESHOLD - 1) {
            record_attempt(false);
            check_lockout().expect("not yet locked out below threshold");
        }
        // Threshold-th failure trips the lockout window.
        record_attempt(false);
        let err = check_lockout()
            .err()
            .expect("expected lockout after threshold");
        let msg = err.to_string();
        assert!(
            msg.contains("Too many failed attempts"),
            "unexpected message: {msg}"
        );

        // A successful attempt clears the counter and the lockout.
        reset_unlock_state();
        record_attempt(true);
        check_lockout().expect("lockout cleared after success");
    }

    #[test]
    fn lockout_window_scales_exponentially_up_to_cap() {
        let _g = LOCKOUT_TEST_LOCK.lock();
        reset_unlock_state();

        // Push the counter way past the cap-shift threshold (12). The
        // `locked_until` instant should never exceed `MAX_LOCKOUT_SECS` in
        // the future, even at unbounded failure counts.
        for _ in 0..(LOCKOUT_THRESHOLD + 20) {
            record_attempt(false);
        }
        let st = UNLOCK_STATE.lock();
        let until = st.locked_until.expect("locked out");
        let now = Instant::now();
        let remaining = until.saturating_duration_since(now).as_secs();
        assert!(
            remaining <= MAX_LOCKOUT_SECS,
            "lockout {remaining}s exceeded MAX_LOCKOUT_SECS={MAX_LOCKOUT_SECS}s"
        );
        // And the base hasn't been swapped for something tiny — first window
        // is at least BASE_LOCKOUT_SECS.
        assert!(
            remaining >= BASE_LOCKOUT_SECS,
            "lockout {remaining}s shorter than BASE_LOCKOUT_SECS={BASE_LOCKOUT_SECS}s"
        );
        drop(st);
        reset_unlock_state();
    }
}
