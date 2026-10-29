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
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use keyring::Entry;
use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.loach.app";
const ACCOUNT: &str = "app_lock";

// ---------------------------------------------------------------------------
// Lock marker.
//
// A copy of the non-secret `LockStatus`, kept in the app data dir, so the
// startup probe can tell whether a lock is configured without reading the
// keyring. Reading the keyring there let the lock fail open: the probe ran
// before anything was shown, and a keychain access prompt (macOS asks again
// after every update of an ad-hoc-signed build) that was denied or answered
// slowly made the renderer treat the app as unlocked. With the marker the
// lock screen shows at once and the keyring is first read on unlock, where
// a refused read keeps the app locked.
//
// The keyring stays the source of truth: the marker is rewritten whenever
// the lock changes, removed when it can't be, and when it's missing (first
// launch on this version, or a fresh install) `status` reads the keyring
// and writes it.
// ---------------------------------------------------------------------------

static MARKER_PATH: OnceCell<PathBuf> = OnceCell::new();

/// Point the marker — and the saved rate-limit state, see below — at the app
/// data dir, and load that state. Called once from `lib.rs` setup; until
/// then (and in tests) the marker is skipped and `status` reads the keyring
/// every time, as before, and the rate limit lives in memory only.
pub fn init_marker(data_dir: &Path) {
    let _ = MARKER_PATH.set(data_dir.join("app_lock.json"));
    let _ = ATTEMPTS_PATH.set(data_dir.join("app_lock_attempts.json"));
    *UNLOCK_STATE.lock() = load_attempts();
}

fn read_marker() -> Option<LockStatus> {
    let raw = std::fs::read_to_string(MARKER_PATH.get()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Best effort. A marker that can't be written is removed instead, so it
/// never outlives the keyring entry it describes.
fn write_marker(status: &LockStatus) {
    let Some(path) = MARKER_PATH.get() else {
        return;
    };
    let written = serde_json::to_string(status)
        .map_err(anyhow::Error::from)
        .and_then(|json| std::fs::write(path, json).map_err(anyhow::Error::from));
    if let Err(e) = written {
        tracing::warn!("couldn't write the app-lock marker: {e:#}");
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Rate-limit state for `unlock`.
//
// Tracks consecutive failed attempts and, once `LOCKOUT_THRESHOLD` is
// exceeded, refuses further attempts for an escalating window. Every check
// runs through `rate_limited`, which holds the state lock from the lockout
// check through the verify to recording the outcome — otherwise parallel
// calls (`unlock` racing `require_unlocked`, …) all passed the check before
// any of them recorded a failure.
//
// The state is also saved next to the marker (`app_lock_attempts.json`) and
// loaded on start. Kept in memory only, it reset on every restart, and the
// renderer can restart the app (`process:default` grants `request_restart`)
// — so a compromised renderer could brute-force the lock by restarting
// between bursts. Deleting the file still resets it, but that takes access
// to the user's files, not just the renderer; a missing or unreadable file
// means no lockout, so a damaged one can never lock the user out for good.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct UnlockState {
    consecutive_failures: u32,
    locked_until: Option<Instant>,
}

static UNLOCK_STATE: Lazy<Mutex<UnlockState>> =
    Lazy::new(|| Mutex::new(UnlockState::default()));

static ATTEMPTS_PATH: OnceCell<PathBuf> = OnceCell::new();

/// [`UnlockState`] as it's saved: an `Instant` means nothing to the next
/// process, so the window's end is kept as wall-clock milliseconds.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct SavedAttempts {
    consecutive_failures: u32,
    locked_until_ms: Option<i64>,
}

impl UnlockState {
    fn to_saved(&self, now: Instant, now_ms: i64) -> SavedAttempts {
        SavedAttempts {
            consecutive_failures: self.consecutive_failures,
            locked_until_ms: self.locked_until.map(|until| {
                now_ms + i64::try_from(until.saturating_duration_since(now).as_millis()).unwrap_or(0)
            }),
        }
    }

    /// The remaining window is capped at the longest one ever handed out, so
    /// a clock set back since the save can't stretch it.
    fn from_saved(saved: SavedAttempts, now: Instant, now_ms: i64) -> Self {
        let max_ms = MAX_LOCKOUT_SECS as i64 * 1000;
        UnlockState {
            consecutive_failures: saved.consecutive_failures,
            locked_until: saved.locked_until_ms.map(|until_ms| {
                now + Duration::from_millis((until_ms - now_ms).clamp(0, max_ms) as u64)
            }),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn load_attempts() -> UnlockState {
    ATTEMPTS_PATH
        .get()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .map(|saved| UnlockState::from_saved(saved, Instant::now(), now_ms()))
        .unwrap_or_default()
}

/// Best effort, like the marker. A clean slate is saved as no file at all.
fn save_attempts(st: &UnlockState) {
    let Some(path) = ATTEMPTS_PATH.get() else {
        return;
    };
    let result = if st.consecutive_failures == 0 {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(anyhow::Error::from(e)),
            _ => Ok(()),
        }
    } else {
        serde_json::to_string(&st.to_saved(Instant::now(), now_ms()))
            .map_err(anyhow::Error::from)
            .and_then(|json| std::fs::write(path, json).map_err(anyhow::Error::from))
    };
    if let Err(e) = result {
        tracing::warn!("couldn't save the app-lock attempt count: {e:#}");
    }
}

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
    // Not `Entry::new`: see `keyring_entry` for the Linux retry.
    Ok(crate::secrets::keyring_entry(SERVICE, ACCOUNT)?)
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
    write_marker(&status_of(Some(cfg)));
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
    // `hash_password` draws the salt from the OS RNG itself.
    let phc: PasswordHash = argon2_instance()
        .hash_password(secret.as_bytes())
        .map_err(|e| anyhow!("argon2 hash failed: {e}"))?;
    Ok(phc.to_string())
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

/// Whether a lock is configured, for the startup probe. Answers from the
/// marker when there is one; see the "Lock marker" note above.
pub fn status() -> Result<LockStatus> {
    if let Some(marker) = read_marker() {
        return Ok(marker);
    }
    let status = status_of(load()?.as_ref());
    write_marker(&status);
    Ok(status)
}

fn status_of(cfg: Option<&LockConfig>) -> LockStatus {
    match cfg {
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
    }
}

/// Check whether we're currently inside the rate-limit cool-down. Returns
/// an error with the remaining time when locked; `Ok(())` otherwise. Used
/// before any argon2 verification so brute-force callers can't even trigger
/// a hash during the window.
fn check_lockout(st: &UnlockState) -> Result<()> {
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
fn record_attempt(st: &mut UnlockState, ok: bool) {
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

/// One credential check under the rate limit: refused during a cool-down,
/// otherwise `verify` runs and its outcome is recorded and saved — all with
/// the state locked, so concurrent checks queue up behind each other (see
/// the "Rate-limit state" note).
fn rate_limited(verify: impl FnOnce() -> bool) -> Result<bool> {
    let mut st = UNLOCK_STATE.lock();
    check_lockout(&st)?;
    let ok = verify();
    record_attempt(&mut st, ok);
    save_attempts(&st);
    Ok(ok)
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
        if !rate_limited(|| verify_against_config(&existing, current_pin, current_password))? {
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
    // Early out before the keyring read; `rate_limited` checks again.
    check_lockout(&UNLOCK_STATE.lock())?;

    let cfg = match load()? {
        Some(c) => c,
        None => {
            // The keyring entry is gone (removed outside the app) while the
            // marker still put up the lock screen. Correct the marker, or
            // every launch would show a lock that any input opens.
            write_marker(&status_of(None));
            return Ok(true);
        }
    };

    rate_limited(|| verify_against_config(&cfg, pin, password))
}

fn reset_unlock_state() {
    let mut st = UNLOCK_STATE.lock();
    st.consecutive_failures = 0;
    st.locked_until = None;
    save_attempts(&st);
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
    if result.is_ok() {
        write_marker(&status_of(None));
    }
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
        if !rate_limited(|| verify_against_config(&cfg, current_pin, current_password))? {
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
        if !rate_limited(|| verify_against_config(&cfg, current_pin, current_password))? {
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
    fn status_answers_from_the_marker_without_the_keyring() {
        // The marker path is process-wide and set once; this is the only test
        // that sets it, and the only one that calls `status`. Setting it also
        // loads `UNLOCK_STATE`, hence the lock.
        let _g = LOCKOUT_TEST_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        init_marker(dir.path());
        let cfg = LockConfig {
            method: LockMethod::Pin,
            pin_length: Some(4),
            pin_hash: Some("unused".into()),
            password_hash: None,
            hint: Some("the usual".into()),
        };
        write_marker(&status_of(Some(&cfg)));

        // With a marker present the keyring is never read, so a keychain
        // prompt can't stand between startup and the lock screen.
        let s = status().expect("answered from the marker");
        assert!(s.configured);
        assert_eq!(s.method, Some(LockMethod::Pin));
        assert_eq!(s.pin_length, Some(4));
        assert!(s.has_hint);

        // A torn write reads as no marker, which sends `status` back to the
        // keyring instead of trusting a half-written answer.
        std::fs::write(dir.path().join("app_lock.json"), "{\"configured\":tr").unwrap();
        assert!(read_marker().is_none());

        // The attempt count lives beside the marker, so a restart — which
        // the renderer can ask for — doesn't wipe a lockout…
        let attempts = dir.path().join("app_lock_attempts.json");
        for _ in 0..LOCKOUT_THRESHOLD {
            rate_limited(|| false).unwrap();
        }
        assert!(attempts.exists());
        *UNLOCK_STATE.lock() = load_attempts(); // as the next launch would
        assert!(check_lockout(&UNLOCK_STATE.lock()).is_err(), "the lockout didn't survive");
        // …a clean slate is no file at all…
        reset_unlock_state();
        assert!(!attempts.exists());
        // …and a damaged file means no lockout rather than a permanent one.
        std::fs::write(&attempts, "{\"consecutive_failures\":9,\"locked_until_ms\":").unwrap();
        assert!(check_lockout(&load_attempts()).is_ok());
        reset_unlock_state();
    }

    /// Saved and loaded across a restart, the window keeps its end — but a
    /// clock set back since can't stretch it past the longest window.
    #[test]
    fn saved_attempts_keep_the_window_and_cap_it() {
        let now = Instant::now();
        let st = UnlockState {
            consecutive_failures: 6,
            locked_until: Some(now + Duration::from_secs(60)),
        };
        let saved = st.to_saved(now, 1_000_000);
        assert_eq!(
            saved,
            SavedAttempts { consecutive_failures: 6, locked_until_ms: Some(1_060_000) }
        );

        // Twenty seconds later, in the next process.
        let later = Instant::now();
        let loaded = UnlockState::from_saved(saved, later, 1_020_000);
        assert_eq!(loaded.consecutive_failures, 6);
        assert_eq!(loaded.locked_until, Some(later + Duration::from_secs(40)));
        assert!(check_lockout(&loaded).is_err());

        // Already over: no lockout. Clock moved back a day: capped.
        let over = SavedAttempts { consecutive_failures: 6, locked_until_ms: Some(900_000) };
        assert!(check_lockout(&UnlockState::from_saved(over, later, 1_000_000)).is_ok());
        let skewed = SavedAttempts {
            consecutive_failures: 6,
            locked_until_ms: Some(1_000_000 + 24 * 3600 * 1000),
        };
        let capped = UnlockState::from_saved(skewed, later, 1_000_000);
        assert_eq!(capped.locked_until, Some(later + Duration::from_secs(MAX_LOCKOUT_SECS)));
    }

    /// Regression: the lockout check, the verify and the recording weren't
    /// one step, so parallel checks all got past the check before any of
    /// them recorded its failure. Now only `LOCKOUT_THRESHOLD` get to verify.
    #[test]
    fn concurrent_checks_cannot_outrun_the_lockout() {
        let _g = LOCKOUT_TEST_LOCK.lock();
        reset_unlock_state();
        let verified = std::sync::atomic::AtomicU32::new(0);
        let refused = std::thread::scope(|s| {
            let calls: Vec<_> = (0..LOCKOUT_THRESHOLD * 3)
                .map(|_| {
                    s.spawn(|| {
                        rate_limited(|| {
                            verified.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(5));
                            false
                        })
                    })
                })
                .collect();
            calls.into_iter().map(|c| c.join().unwrap()).filter(Result::is_err).count()
        });
        assert_eq!(verified.into_inner(), LOCKOUT_THRESHOLD);
        assert_eq!(refused as u32, LOCKOUT_THRESHOLD * 2);
        reset_unlock_state();
    }

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
    fn verify_accepts_hashes_stored_by_argon2_0_5() {
        // Made by argon2 0.5.3, the version that shipped up to Loach 1.5.0,
        // and sitting in users' credential stores. A crate bump that stops
        // verifying them locks those users out of the app.
        let current_params = "$argon2id$v=19$m=65536,t=3,p=1$Hr9IRw89uglbWlWcxOZrJw$rr0xcfZgwJYES0b7Kf1M8bnY2m1csUk30fTLYapBVzI";
        assert!(verify("1234", current_params));
        assert!(!verify("0000", current_params));

        // `Argon2::default()` parameters, from before the cost was raised.
        let default_params = "$argon2id$v=19$m=19456,t=2,p=1$FXKWcHr77AyDYYzmY+CrwA$Zto6EKKlbuktJuMGNwUMpdpmdpC/dM9Ir+XeawQvRx4";
        assert!(verify("correct-horse", default_params));
        assert!(!verify("wrong", default_params));
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
        let mut st = UnlockState::default();

        // Below threshold: still allowed to attempt.
        for _ in 0..(LOCKOUT_THRESHOLD - 1) {
            record_attempt(&mut st, false);
            check_lockout(&st).expect("not yet locked out below threshold");
        }
        // Threshold-th failure trips the lockout window.
        record_attempt(&mut st, false);
        let err = check_lockout(&st)
            .err()
            .expect("expected lockout after threshold");
        let msg = err.to_string();
        assert!(
            msg.contains("Too many failed attempts"),
            "unexpected message: {msg}"
        );

        // A successful attempt clears the counter and the lockout.
        record_attempt(&mut st, true);
        check_lockout(&st).expect("lockout cleared after success");
    }

    #[test]
    fn lockout_window_scales_exponentially_up_to_cap() {
        let mut st = UnlockState::default();

        // Push the counter way past the cap-shift threshold (12). The
        // `locked_until` instant should never exceed `MAX_LOCKOUT_SECS` in
        // the future, even at unbounded failure counts.
        for _ in 0..(LOCKOUT_THRESHOLD + 20) {
            record_attempt(&mut st, false);
        }
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
    }
}
