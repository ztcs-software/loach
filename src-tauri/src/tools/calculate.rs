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
//! Safety surface is tiny: exmex is pure-compute, no I/O, no allocation
//! patterns that scale with input size beyond the expression's own length.
//! We still cap the input string so a runaway prompt can't ship a 10 MB
//! expression at us.

use exmex::{BinOp, Express, FlatEx, FloatOpsFactory, MakeOperators, Operator};
use serde_json::{json, Value};

use crate::mcp::McpCallResult;

/// exmex's default float operators, plus the two things this tool's own
/// description promises that they don't cover: the `%` remainder operator,
/// and a lowercase `pi` (exmex ships `PI` and `π`, and a model reading our
/// description writes `pi`).
///
/// `%` takes the same priority as `/` so `10 % 4 * 2` groups the way every
/// other language groups it. Everything else — the trig family, sqrt/exp,
/// `ln`, `log` (base e) and `log10`, abs/floor/ceil/round/signum, and the
/// `e` constant — comes from the default set already.
#[derive(Clone, Debug)]
struct CalcOps;

impl MakeOperators<f64> for CalcOps {
    fn make<'a>() -> Vec<Operator<'a, f64>> {
        let mut ops = FloatOpsFactory::<f64>::make();
        ops.push(Operator::make_bin(
            "%",
            BinOp {
                apply: |a, b| a % b,
                prio: 3,
                is_commutative: false,
            },
        ));
        ops.push(Operator::make_constant("pi", std::f64::consts::PI));
        ops
    }
}

type CalcExpr = FlatEx<f64, CalcOps>;

/// Hard cap on the expression length. Real-world calls are <100 chars;
/// anything beyond a few hundred is almost certainly malformed or
/// adversarial. Bounded up front so the parser doesn't have to walk
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
    // Parse and evaluate with no variables bound. A bare identifier the
    // operator set doesn't define (`x + 1`, a mistyped function name) parses
    // as a variable and then fails here for want of a value — which is the
    // error we want, since this tool only ever evaluates closed expressions.
    match CalcExpr::parse(trimmed).and_then(|expr| expr.eval(&[])) {
        Ok(value) => McpCallResult {
            content_text: format_result(value),
            is_error: false,
            ..Default::default()
        },
        Err(e) => err(format!("could not evaluate `{trimmed}`: {e}")),
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
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
    // `value` is non-zero here (an exact zero takes the integer branch
    // above), but a tiny magnitude can still round away to "0" / "-0" at
    // 12 decimals. Surface those in scientific notation so a real result
    // like 1.2e-15 isn't reported as a flat "0".
    if trimmed.is_empty() || trimmed == "-" || trimmed == "0" || trimmed == "-0" {
        return format!("{value:e}");
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The catalogue advertises `log` (base e) and `log10`; both must resolve
    /// for a model that simply believed the tool description.
    #[test]
    fn advertised_logarithms_are_available() {
        let r = dispatch(&json!({"expression": "log10(100)"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "2");

        // `log` is documented as base e — same as `ln`.
        let r = dispatch(&json!({"expression": "log(e)"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "1");

        // The builtin the default context DID have still works.
        let r = dispatch(&json!({"expression": "ln(1)"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "0");
    }

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
        // Unclosed paren — rejected rather than recovered from.
        let r = dispatch(&json!({"expression": "(2 + 3"}));
        assert!(r.is_error, "got: {}", r.content_text);
        assert!(r.content_text.contains("could not evaluate"));
    }

    /// `%` is advertised in the tool description but isn't part of exmex's
    /// default operator set — [`CalcOps`] adds it. Priority has to match `/`
    /// so the grouping matches every other language's.
    #[test]
    fn remainder_operator_is_available_and_binds_like_division() {
        let r = dispatch(&json!({"expression": "7 % 3"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "1");

        // Left-to-right with `*` at the same tier: (10 % 4) * 2 == 4.
        let r = dispatch(&json!({"expression": "10 % 4 * 2"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "4");
    }

    /// Lowercase `pi` is what the description tells the model to write;
    /// exmex only ships `PI` and `π`, so [`CalcOps`] adds it.
    #[test]
    fn lowercase_pi_constant_is_available() {
        let r = dispatch(&json!({"expression": "pi"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.starts_with("3.14159"), "got: {}", r.content_text);
    }

    /// This tool only evaluates closed expressions. A bare identifier parses
    /// as a variable, which must surface as an error rather than silently
    /// evaluating to something.
    #[test]
    fn free_variables_are_rejected() {
        for expr in ["x + 1", "bogusfn(2)", "2 * unknown"] {
            let r = dispatch(&json!({ "expression": expr }));
            assert!(r.is_error, "`{expr}` should not evaluate, got: {}", r.content_text);
        }
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
        // f64 division by zero is inf; we want a model-readable hint.
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

    #[test]
    fn tiny_values_use_scientific_notation() {
        // A magnitude far below the 12-decimal threshold must not collapse
        // to a flat "0" — that would silently lose a real result.
        let s = format_result(1.2e-15);
        assert!(s.contains('e'), "expected scientific notation, got: {s}");
        assert_ne!(s, "0");
        // The negative tiny case is covered too (used to render "-0").
        assert!(format_result(-1.2e-15).contains('e'));
        // Exact zero still renders as a plain integer 0.
        assert_eq!(format_result(0.0), "0");
        // Ordinary fractions are untouched by the new branch.
        assert!(format_result(1.0 / 3.0).starts_with("0.3333"));
    }
}
