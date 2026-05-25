//! Built-in `calculate` tool — a real math evaluator the model can call.
//!
//! Local models are notoriously bad at arithmetic (especially beyond two-
//! digit multiplication, decimals, and order-of-operations on longer
//! chains). Exposing a deterministic evaluator as a tool lets the model
//! off-load the math instead of hallucinating an answer.
//!
//! Wiring lives in [`super::builtin`] — the chat pipeline pulls every
//! enabled built-in tool from there and the MCP dispatcher routes by
//! bare tool name. This file only owns the schema, the description, and
//! the math.
//!
//! Safety surface is tiny: meval is pure-compute, no I/O, no allocation
//! patterns that scale with input size beyond the expression's own length.
//! We still cap the input string so a runaway prompt can't ship a 10 MB
//! expression at us.

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

/// Hard cap on the expression length. Real-world calls are <100 chars;
/// anything beyond a few hundred is almost certainly malformed or
/// adversarial. Bounded up front so meval's parser doesn't have to walk
/// a multi-MB string.
const MAX_EXPR_CHARS: usize = 1024;

/// Tool name as the model sees it. Lives here so the catalogue injection
/// and the dispatch short-circuit can't drift.
pub const TOOL_NAME: &str = "calculate";

/// Description and JSON-Schema sent to the model with the rest of the
/// tools catalogue. Keep the description prescriptive — local models
/// otherwise hand us `2x + 3` (no `*`) or `5!` (no factorial) and the
/// parser rejects it, which the model then has to recover from.
pub fn tool_description() -> &'static str {
    "Evaluate a mathematical expression and return the numeric result. \
     Prefer this over computing arithmetic in your head — it is exact and \
     deterministic. Supports + - * / ^ % parentheses; functions sin, cos, \
     tan, asin, acos, atan, sinh, cosh, tanh, sqrt, exp, ln, log (base e), \
     log10, abs, floor, ceil, round, signum; constants pi and e. Trig \
     functions take radians. Use `*` for multiplication explicitly; \
     juxtaposition (`2pi`) is not supported."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "expression": {
                "type": "string",
                "description": "The math expression to evaluate, e.g. `2 * (3 + 4)` or `sqrt(2) * sin(pi/4)`."
            }
        },
        "required": ["expression"],
        "additionalProperties": false
    })
}

/// Evaluate `expression` and return a stringified result suitable for
/// feeding back to the model as a `tool`-role message. The wrapper
/// returns an `McpCallResult` so dispatch can splice this in alongside
/// real MCP calls without a special-case shape on the provider side.
///
/// Errors are returned as `is_error: true` (not `Err`) so the model sees
/// the failure text and can self-correct — same convention `tools/call`
/// uses for MCP errors.
pub fn dispatch(arguments: &Value) -> McpCallResult {
    let Some(expr) = arguments.get("expression").and_then(|v| v.as_str()) else {
        return err("missing required argument `expression` (string)");
    };
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return err("expression is empty");
    }
    if trimmed.chars().count() > MAX_EXPR_CHARS {
        return err(format!(
            "expression too long ({} chars; max {MAX_EXPR_CHARS})",
            trimmed.chars().count()
        ));
    }
    match meval::eval_str(trimmed) {
        Ok(value) => McpCallResult {
            content_text: format_result(value),
            is_error: false,
        },
        Err(e) => err(format!("could not evaluate `{trimmed}`: {e}")),
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
    }
}

/// Print a `f64` so integer-valued results show as `42` not `42.0`, but
/// genuine fractions keep their precision. NaN/inf are surfaced as
/// strings rather than the default `NaN` / `inf` so the model has a
/// clearer signal that the input is degenerate (e.g. `1/0`, `ln(-1)`).
fn format_result(value: f64) -> String {
    if value.is_nan() {
        return "NaN (the expression has no real-number result, e.g. ln of a non-positive number)".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity (the expression overflows the negative range, e.g. division by zero)"
        } else {
            "Infinity (the expression overflows the positive range, e.g. division by zero)"
        }
        .to_string();
    }
    // Integer-valued floats render as integers. The 1e15 guard keeps us
    // inside the range where f64 can represent every integer exactly —
    // beyond that, displaying as "integer" would be a lie.
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    // Default Display gives ~17 significant digits for round-trippability.
    // That's noisy for chat output; trim to 12 significant digits which
    // is still well beyond what the user can verify by hand.
    let s = format!("{value:.12}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn evaluates_basic_arithmetic() {
        let r = dispatch(&json!({"expression": "2 + 3 * 4"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "14");
    }

    #[test]
    fn integer_results_render_without_trailing_zero() {
        let r = dispatch(&json!({"expression": "100 / 4"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "25");
    }

    #[test]
    fn keeps_fractional_precision() {
        let r = dispatch(&json!({"expression": "1 / 3"}));
        assert!(!r.is_error);
        assert!(
            r.content_text.starts_with("0.3333333333"),
            "got: {}",
            r.content_text
        );
    }

    #[test]
    fn supports_functions_and_constants() {
        let r = dispatch(&json!({"expression": "sin(pi / 2)"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "1");
        let r = dispatch(&json!({"expression": "sqrt(2)"}));
        assert!(!r.is_error);
        assert!(r.content_text.starts_with("1.4142"), "got: {}", r.content_text);
    }

    #[test]
    fn surfaces_parse_errors() {
        // Unclosed paren — meval rejects this rather than recovering.
        // (Note: `2 ++ 3` is *not* malformed in meval — the second `+` is
        // parsed as a unary plus, so the expression evaluates to 5.)
        let r = dispatch(&json!({"expression": "(2 + 3"}));
        assert!(r.is_error, "got: {}", r.content_text);
        assert!(r.content_text.contains("could not evaluate"));
    }

    #[test]
    fn rejects_missing_expression() {
        let r = dispatch(&json!({}));
        assert!(r.is_error);
        assert!(r.content_text.contains("missing required argument"));
    }

    #[test]
    fn rejects_empty_expression() {
        let r = dispatch(&json!({"expression": "   "}));
        assert!(r.is_error);
        assert!(r.content_text.contains("empty"));
    }

    #[test]
    fn rejects_overlong_expression() {
        let huge = "1+".repeat(MAX_EXPR_CHARS) + "1";
        let r = dispatch(&json!({"expression": huge}));
        assert!(r.is_error);
        assert!(r.content_text.contains("too long"));
    }

    #[test]
    fn reports_division_by_zero_as_infinity() {
        let r = dispatch(&json!({"expression": "1 / 0"}));
        // meval treats this as f64 inf; we want a model-readable hint.
        assert!(!r.is_error);
        assert!(r.content_text.contains("Infinity"), "got: {}", r.content_text);
    }

    #[test]
    fn reports_nan_for_invalid_domain() {
        let r = dispatch(&json!({"expression": "sqrt(-1)"}));
        // sqrt of negative is NaN in f64; surface it with context.
        assert!(!r.is_error);
        assert!(r.content_text.contains("NaN"), "got: {}", r.content_text);
    }
}
