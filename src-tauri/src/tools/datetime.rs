//! Built-in `datetime` tool — date parsing, formatting, arithmetic, and
//! timezone conversion the model can call instead of hallucinating.
//!
//! Local models routinely:
//!   * pick the wrong weekday for a given date,
//!   * misapply DST (e.g. `+2h` across a spring-forward),
//!   * fabricate ISO offsets that don't exist,
//!   * miscount business days beyond a week or two.
//! Off-loading those to chrono / chrono-tz removes a whole class of
//! confident-but-wrong answers without the user having to wire up an
//! MCP server for a single function.

use chrono::{
    DateTime, Datelike, Days, LocalResult, Months, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday,
};
use chrono_tz::{Tz, UTC};
use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "datetime";

/// Hard ceiling on `add` / `business_days_from` amounts so a hostile prompt
/// can't ask us to walk a billion business days one at a time. 1e8 days is
/// ~270k years which is well past chrono's representable range anyway —
/// this is purely a guard against pathological iteration counts.
const MAX_AMOUNT_ABS: i64 = 100_000_000;

/// Formats we try in order when the input lacks an explicit offset.
/// `parse_from_rfc3339` and `parse_from_rfc2822` are tried first; this
/// list covers the everyday "human-typed" shapes that come up in chat.
const NAIVE_FORMATS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M",
];

pub fn tool_description() -> &'static str {
    "Parse, format, and do arithmetic on dates, times, and timezones. \
     Use this rather than computing weekdays, DST shifts, or business-day \
     counts yourself — chrono is exact and DST-aware. Operations: \
     `now` (current datetime in a timezone), \
     `parse` (normalize a datetime string to RFC 3339), \
     `format` (render a datetime with a strftime pattern), \
     `add` (add or subtract a unit — use negative amount to subtract; \
     calendar units `years`, `months`, `weeks`, `days`, `business_days` \
     preserve wall-clock time across DST boundaries; duration units \
     `hours`, `minutes`, `seconds` preserve absolute elapsed time and \
     may shift the wall clock across DST), \
     `diff` (difference between two datetimes in a chosen unit), \
     `tz_convert` (convert a datetime to a target timezone, DST-aware), \
     `weekday` (weekday name for a date), \
     `business_days_from` (N business days forward or back from a date, \
     skipping Saturday and Sunday — does not account for holidays). \
     Datetime strings must be RFC 3339 (`2026-05-25T14:30:00Z`, \
     `2026-05-25T14:30:00+02:00`), ISO-8601 without offset \
     (`2026-05-25T14:30:00` — interpreted in `timezone` or UTC), or date \
     only (`2026-05-25`). Timezones are IANA names like \
     `Europe/Warsaw` or `America/New_York`. Units for add/diff: \
     `years`, `months`, `weeks`, `days`, `hours`, `minutes`, `seconds`, \
     `business_days`."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": [
                    "now", "parse", "format", "add", "diff",
                    "tz_convert", "weekday", "business_days_from"
                ],
                "description": "Which operation to perform."
            },
            "input": { "type": "string", "description": "Datetime string. Used by parse, format, add, tz_convert, weekday, business_days_from." },
            "from": { "type": "string", "description": "Source datetime for `diff`." },
            "to": { "type": "string", "description": "Target datetime for `diff`." },
            "timezone": { "type": "string", "description": "IANA timezone. For `now`, `parse`, `format`, `weekday`, `add`: the display tz and the tz a naïve input is interpreted in. For `tz_convert`: the target tz." },
            "unit": {
                "type": "string",
                "enum": ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "business_days"],
                "description": "Unit for `add` and `diff`."
            },
            "amount": { "type": "integer", "description": "Amount for `add` and `business_days_from`. Negative subtracts / goes backward." },
            "format": { "type": "string", "description": "strftime pattern for `format` (e.g. `%Y-%m-%d %H:%M`, `%A`, `%B %-d, %Y`)." }
        },
        "required": ["op"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let op = match args.get("op").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `op` argument"),
    };
    match op {
        "now" => op_now(args),
        "parse" => op_parse(args),
        "format" => op_format(args),
        "add" => op_add(args),
        "diff" => op_diff(args),
        "tz_convert" => op_tz_convert(args),
        "weekday" => op_weekday(args),
        "business_days_from" => op_business_days_from(args),
        other => err(format!("unknown op `{other}` — see tool description for valid ops")),
    }
}

// ---------- operations ----------

fn op_now(args: &Value) -> McpCallResult {
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    let now = Utc::now().with_timezone(&tz);
    if let Some(fmt) = args.get("format").and_then(|v| v.as_str()) {
        return ok(now.format(fmt).to_string());
    }
    ok(now.to_rfc3339())
}

fn op_parse(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    match parse_input(input, &tz) {
        Ok(dt) => ok(dt.with_timezone(&tz).to_rfc3339()),
        Err(e) => err(e),
    }
}

fn op_format(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let pattern = match args.get("format").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => return err("missing required `format` argument (strftime pattern)"),
    };
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    match parse_input(input, &tz) {
        Ok(dt) => ok(dt.with_timezone(&tz).format(pattern).to_string()),
        Err(e) => err(e),
    }
}

fn op_add(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let unit = match args.get("unit").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `unit` argument"),
    };
    let amount = match args.get("amount").and_then(|v| v.as_i64()) {
        Some(n) => n,
        None => return err("missing required `amount` argument (integer)"),
    };
    // The cap check compares unsigned magnitudes — `amount.unsigned_abs()`
    // returns a `u64` so it handles `i64::MIN` correctly (whereas `as i64`
    // would wrap to a negative value and bypass the cap). Same with
    // `amount.abs()` in the error message: that panics on `i64::MIN` in
    // debug builds, so we format the unsigned magnitude instead.
    let mag = amount.unsigned_abs();
    if mag > MAX_AMOUNT_ABS as u64 {
        return err(format!("amount magnitude {mag} exceeds cap of {MAX_AMOUNT_ABS}"));
    }
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    let start = match parse_input(input, &tz) {
        Ok(dt) => dt,
        Err(e) => return err(e),
    };
    let shifted = match add_unit(start, &tz, unit, amount) {
        Ok(dt) => dt,
        Err(e) => return err(e),
    };
    ok(shifted.with_timezone(&tz).to_rfc3339())
}

fn op_diff(args: &Value) -> McpCallResult {
    let from = match string_arg(args, "from") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let to = match string_arg(args, "to") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let unit = match args.get("unit").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `unit` argument"),
    };
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    let from_dt = match parse_input(from, &tz) {
        Ok(dt) => dt,
        Err(e) => return err(format!("could not parse `from`: {e}")),
    };
    let to_dt = match parse_input(to, &tz) {
        Ok(dt) => dt,
        Err(e) => return err(format!("could not parse `to`: {e}")),
    };
    match diff_unit(from_dt, to_dt, unit) {
        Ok(n) => ok(n.to_string()),
        Err(e) => err(e),
    }
}

fn op_tz_convert(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let target = match args.get("timezone").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `timezone` (target IANA timezone) for tz_convert"),
    };
    let target_tz = match resolve_tz(Some(target)) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    // Naïve inputs to tz_convert are interpreted in UTC — anything else
    // would silently misinterpret strings like `2026-05-25T14:30:00` as
    // wall-clock time in the *target* tz, which is the bug we're trying
    // to prevent. The model should add an offset for unambiguous input.
    let dt = match parse_input(input, &UTC) {
        Ok(dt) => dt,
        Err(e) => return err(e),
    };
    ok(dt.with_timezone(&target_tz).to_rfc3339())
}

fn op_weekday(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    match parse_input(input, &tz) {
        Ok(dt) => ok(weekday_name(dt.with_timezone(&tz).weekday())),
        Err(e) => err(e),
    }
}

fn op_business_days_from(args: &Value) -> McpCallResult {
    let input = match string_arg(args, "input") {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let amount = match args.get("amount").and_then(|v| v.as_i64()) {
        Some(n) => n,
        None => return err("missing required `amount` argument (integer, negative goes backward)"),
    };
    // Same `i64::MIN`-safe cap check as `op_add` — compare unsigned
    // magnitudes so a wrap on cast back to i64 can't bypass the limit.
    let mag = amount.unsigned_abs();
    if mag > MAX_AMOUNT_ABS as u64 {
        return err(format!("amount magnitude {mag} exceeds cap of {MAX_AMOUNT_ABS}"));
    }
    let tz = match resolve_tz(args.get("timezone").and_then(|v| v.as_str())) {
        Ok(tz) => tz,
        Err(e) => return err(e),
    };
    let start = match parse_input(input, &tz) {
        Ok(dt) => dt,
        Err(e) => return err(e),
    };
    let date = start.with_timezone(&tz).date_naive();
    let end = match add_business_days(date, amount) {
        Some(d) => d,
        None => return err("business-day arithmetic overflowed chrono's representable range"),
    };
    ok(end.format("%Y-%m-%d").to_string())
}

// ---------- helpers ----------

fn parse_input(s: &str, fallback_tz: &Tz) -> Result<DateTime<Utc>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("datetime input is empty".to_string());
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(s) {
        return Ok(dt.with_timezone(&Utc));
    }
    for fmt in NAIVE_FORMATS {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return resolve_naive(naive, fallback_tz);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let naive = date
            .and_hms_opt(0, 0, 0)
            .expect("00:00:00 is always a valid time");
        return resolve_naive(naive, fallback_tz);
    }
    Err(format!(
        "could not parse `{s}` as a datetime (try RFC 3339, ISO 8601, or `YYYY-MM-DD`)"
    ))
}

fn resolve_naive(naive: NaiveDateTime, tz: &Tz) -> Result<DateTime<Utc>, String> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Ok(dt.with_timezone(&Utc)),
        // DST spring-forward leaves no valid local time; fall-back ambiguity
        // (autumn-back) has two — we pick the earlier instant, which is
        // chrono's `earliest()`. Documented in the description.
        LocalResult::Ambiguous(early, _late) => Ok(early.with_timezone(&Utc)),
        LocalResult::None => Err(format!(
            "local time `{naive}` does not exist in timezone `{tz}` (likely a DST gap)"
        )),
    }
}

fn resolve_tz(name: Option<&str>) -> Result<Tz, String> {
    let n = name.unwrap_or("UTC");
    n.parse::<Tz>()
        .map_err(|_| format!("unknown timezone `{n}` — use an IANA name like `America/New_York`"))
}

/// Calendar-aware add for the date-ish units (years, months, weeks, days,
/// business_days): wall-clock time in `tz` is preserved across the shift,
/// so "+1 day" across a DST boundary stays at the same hour locally.
/// Duration-ish units (hours, minutes, seconds) add to the absolute
/// instant — `+2h` is exactly two hours of elapsed time, which may shift
/// the wall clock if it crosses a DST transition.
fn add_unit(start: DateTime<Utc>, tz: &Tz, unit: &str, amount: i64) -> Result<DateTime<Utc>, String> {
    let neg = amount < 0;
    let mag = amount.unsigned_abs();
    let local = start.with_timezone(tz);
    match unit {
        "years" => {
            let months = mag.checked_mul(12).ok_or_else(|| "years × 12 overflowed".to_string())?;
            let months = u32::try_from(months).map_err(|_| "year amount too large for chrono".to_string())?;
            apply_months_local(local, months, neg)
        }
        "months" => {
            let months = u32::try_from(mag).map_err(|_| "month amount too large for chrono".to_string())?;
            apply_months_local(local, months, neg)
        }
        "weeks" => {
            let days = mag.checked_mul(7).ok_or_else(|| "weeks × 7 overflowed".to_string())?;
            apply_days_local(local, days, neg)
        }
        "days" => apply_days_local(local, mag, neg),
        "hours" => {
            let secs = (mag as i64).checked_mul(3600).ok_or_else(|| "hours × 3600 overflowed".to_string())?;
            apply_seconds(start, secs, neg)
        }
        "minutes" => {
            let secs = (mag as i64).checked_mul(60).ok_or_else(|| "minutes × 60 overflowed".to_string())?;
            apply_seconds(start, secs, neg)
        }
        "seconds" => apply_seconds(start, mag as i64, neg),
        "business_days" => {
            // Wall-clock-preserving like the rest of the calendar units —
            // walk dates in the local tz, then recombine with the original
            // local time.
            let date = local.date_naive();
            let signed = if neg { -(mag as i64) } else { mag as i64 };
            let new_date = add_business_days(date, signed)
                .ok_or_else(|| "business-day arithmetic overflowed".to_string())?;
            let naive = new_date.and_time(local.time());
            match tz.from_local_datetime(&naive) {
                LocalResult::Single(dt) => Ok(dt.with_timezone(&Utc)),
                LocalResult::Ambiguous(early, _) => Ok(early.with_timezone(&Utc)),
                LocalResult::None => Err(format!(
                    "result lands on a DST gap in `{tz}` ({naive})"
                )),
            }
        }
        other => Err(format!("unknown unit `{other}`")),
    }
}

fn apply_months_local(local: DateTime<Tz>, months: u32, neg: bool) -> Result<DateTime<Utc>, String> {
    let m = Months::new(months);
    let out = if neg {
        local.checked_sub_months(m)
    } else {
        local.checked_add_months(m)
    };
    out.map(|d| d.with_timezone(&Utc))
        .ok_or_else(|| "result is outside chrono's supported range".to_string())
}

fn apply_days_local(local: DateTime<Tz>, days: u64, neg: bool) -> Result<DateTime<Utc>, String> {
    let d = Days::new(days);
    let out = if neg {
        local.checked_sub_days(d)
    } else {
        local.checked_add_days(d)
    };
    out.map(|d| d.with_timezone(&Utc))
        .ok_or_else(|| "result is outside chrono's supported range".to_string())
}

fn apply_seconds(start: DateTime<Utc>, secs: i64, neg: bool) -> Result<DateTime<Utc>, String> {
    let signed = if neg { -secs } else { secs };
    let dur = chrono::Duration::try_seconds(signed)
        .ok_or_else(|| "second amount overflowed chrono::Duration".to_string())?;
    start
        .checked_add_signed(dur)
        .ok_or_else(|| "result is outside chrono's supported range".to_string())
}

fn diff_unit(from: DateTime<Utc>, to: DateTime<Utc>, unit: &str) -> Result<i64, String> {
    match unit {
        // Calendar-based: subtract fields, not durations, so "Jan 31 → Feb 1"
        // is 1 month rather than ~0.97 of a month.
        "years" => Ok(to.year() as i64 - from.year() as i64),
        "months" => {
            let y = to.year() as i64 - from.year() as i64;
            let m = to.month() as i64 - from.month() as i64;
            Ok(y * 12 + m)
        }
        "weeks" => Ok(to.signed_duration_since(from).num_weeks()),
        "days" => Ok(to.signed_duration_since(from).num_days()),
        "hours" => Ok(to.signed_duration_since(from).num_hours()),
        "minutes" => Ok(to.signed_duration_since(from).num_minutes()),
        "seconds" => Ok(to.signed_duration_since(from).num_seconds()),
        "business_days" => {
            let from_date = from.date_naive();
            let to_date = to.date_naive();
            // Mirror the magnitude cap `op_add` / `op_business_days_from`
            // enforce: `business_days_between` walks the span one day at a
            // time, so an uncapped diff between two far-apart (but individually
            // valid) dates would spin through millions of iterations. Reject an
            // over-cap span up front rather than walk it.
            let span = (to_date - from_date).num_days().unsigned_abs();
            if span > MAX_AMOUNT_ABS as u64 {
                return Err(format!(
                    "date span of {span} days exceeds cap of {MAX_AMOUNT_ABS}"
                ));
            }
            Ok(business_days_between(from_date, to_date))
        }
        other => Err(format!("unknown unit `{other}`")),
    }
}

/// Add `n` business days (Mon–Fri) to `date`. Negative `n` walks backward.
/// Iterative because there's no fast closed-form once you respect the start
/// weekday — but capped by [`MAX_AMOUNT_ABS`] in the public ops.
fn add_business_days(mut date: NaiveDate, n: i64) -> Option<NaiveDate> {
    let step: i64 = if n >= 0 { 1 } else { -1 };
    let mut remaining = n.unsigned_abs();
    while remaining > 0 {
        date = if step > 0 {
            date.succ_opt()?
        } else {
            date.pred_opt()?
        };
        if !is_weekend(date.weekday()) {
            remaining -= 1;
        }
    }
    Some(date)
}

/// Count business days between two dates (sign preserved). `from == to`
/// is zero; same-week Mon→Fri is 4.
fn business_days_between(from: NaiveDate, to: NaiveDate) -> i64 {
    if from == to {
        return 0;
    }
    let step: i64 = if to > from { 1 } else { -1 };
    let mut cur = from;
    let mut count: i64 = 0;
    while cur != to {
        cur = if step > 0 {
            match cur.succ_opt() {
                Some(d) => d,
                None => return count * step,
            }
        } else {
            match cur.pred_opt() {
                Some(d) => d,
                None => return count * step,
            }
        };
        if !is_weekend(cur.weekday()) {
            count += 1;
        }
    }
    count * step
}

fn is_weekend(w: Weekday) -> bool {
    matches!(w, Weekday::Sat | Weekday::Sun)
}

fn weekday_name(w: Weekday) -> String {
    match w {
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
        Weekday::Sun => "Sunday",
    }
    .to_string()
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    match args.get(key).and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(format!("missing required `{key}` argument (string)")),
    }
}

fn ok(s: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: s.into(),
        is_error: false,
        ..Default::default()
    }
}

fn err(s: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: s.into(),
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn weekday_is_correct_for_a_known_date() {
        // 2026-05-25 is a Monday in any sane calendar.
        let r = dispatch(&json!({"op": "weekday", "input": "2026-05-25"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "Monday");
    }

    #[test]
    fn business_days_skip_weekends() {
        // 2026-05-25 is Monday. +5 business days lands on the *following*
        // Monday (skip Sat/Sun), i.e. 2026-06-01.
        let r = dispatch(&json!({
            "op": "business_days_from",
            "input": "2026-05-25",
            "amount": 5,
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "2026-06-01");
    }

    #[test]
    fn business_days_negative_walks_backward() {
        let r = dispatch(&json!({
            "op": "business_days_from",
            "input": "2026-05-25",
            "amount": -5,
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "2026-05-18");
    }

    #[test]
    fn add_days_preserves_wall_clock_across_dst() {
        // Adding 1 day across a spring-forward in Europe/Warsaw keeps the
        // wall-clock time at 10:00 — the offset changes from +01:00 to
        // +02:00, so the absolute instant shifts by 23 hours, not 24.
        // This is the right behaviour for "schedule for tomorrow at the
        // same time of day"; for "exactly 24 hours from now", use hours.
        let r = dispatch(&json!({
            "op": "add",
            "input": "2026-03-28T10:00:00",
            "timezone": "Europe/Warsaw",
            "unit": "days",
            "amount": 1,
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "2026-03-29T10:00:00+02:00");
    }

    #[test]
    fn add_hours_is_absolute_duration() {
        // Contrast with the previous test: `+24h` across a spring-forward
        // shifts the wall-clock by an extra hour because the absolute
        // duration is preserved, not the local time-of-day.
        let r = dispatch(&json!({
            "op": "add",
            "input": "2026-03-28T10:00:00",
            "timezone": "Europe/Warsaw",
            "unit": "hours",
            "amount": 24,
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "2026-03-29T11:00:00+02:00");
    }

    #[test]
    fn diff_days_signed() {
        let r = dispatch(&json!({
            "op": "diff",
            "from": "2026-05-25",
            "to": "2026-05-30",
            "unit": "days",
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "5");
    }

    #[test]
    fn diff_months_is_calendar_based() {
        let r = dispatch(&json!({
            "op": "diff",
            "from": "2026-01-31",
            "to": "2026-02-01",
            "unit": "months",
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "1");
    }

    #[test]
    fn tz_convert_keeps_instant() {
        // 2026-07-04T12:00:00Z is 08:00 EDT (UTC-4).
        let r = dispatch(&json!({
            "op": "tz_convert",
            "input": "2026-07-04T12:00:00Z",
            "timezone": "America/New_York",
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.starts_with("2026-07-04T08:00:00-04:00"), "got: {}", r.content_text);
    }

    #[test]
    fn unknown_op_is_an_error() {
        let r = dispatch(&json!({"op": "teleport"}));
        assert!(r.is_error);
        assert!(r.content_text.contains("unknown op"));
    }

    #[test]
    fn unknown_timezone_is_an_error() {
        let r = dispatch(&json!({"op": "now", "timezone": "Middle/Earth"}));
        assert!(r.is_error);
        assert!(r.content_text.contains("unknown timezone"));
    }

    #[test]
    fn add_rejects_i64_min_amount() {
        // Regression: `amount.unsigned_abs() as i64` wraps `i64::MIN` to
        // `i64::MIN` (negative), which would slip past the cap. The unsigned
        // comparison guards against it.
        let r = dispatch(&json!({
            "op": "add",
            "input": "2026-05-25",
            "unit": "business_days",
            "amount": i64::MIN,
        }));
        assert!(r.is_error, "got: {}", r.content_text);
        assert!(r.content_text.contains("exceeds cap"), "got: {}", r.content_text);
    }

    #[test]
    fn business_days_from_rejects_i64_min_amount() {
        let r = dispatch(&json!({
            "op": "business_days_from",
            "input": "2026-05-25",
            "amount": i64::MIN,
        }));
        assert!(r.is_error, "got: {}", r.content_text);
        assert!(r.content_text.contains("exceeds cap"), "got: {}", r.content_text);
    }

    #[test]
    fn diff_business_days_rejects_over_cap_span() {
        // `business_days_between` walks the span one day at a time, so the
        // `diff` arm must refuse an over-cap span up front instead of walking
        // it. Years beyond 9999 need an explicit sign for chrono's `%Y` —
        // these two parse fine and sit ~190M days apart, over the 100M cap.
        let r = dispatch(&json!({
            "op": "diff",
            "from": "-260000-01-01",
            "to": "+260000-01-01",
            "unit": "business_days",
        }));
        assert!(r.is_error, "got: {}", r.content_text);
        assert!(r.content_text.contains("exceeds cap"), "got: {}", r.content_text);
    }

    #[test]
    fn business_days_between_same_week() {
        // Monday → Friday is 4 business days apart.
        assert_eq!(
            business_days_between(
                NaiveDate::from_ymd_opt(2026, 5, 25).unwrap(),
                NaiveDate::from_ymd_opt(2026, 5, 29).unwrap(),
            ),
            4
        );
    }
}
