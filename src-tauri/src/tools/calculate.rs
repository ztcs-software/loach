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

use exmex::{
    literal_matcher_from_pattern, BinOp, Express, FlatEx, FloatOpsFactory, MakeOperators,
    MatchLiteral, Operator,
};
use serde_json::{json, Value};

use crate::mcp::McpCallResult;

/// exmex's default float operators, with the multiplicative tier rebuilt and
/// two additions this tool's own description promises: the `%` remainder
/// operator, and a lowercase `pi` (exmex ships `PI` and `π`, and a model
/// reading our description writes `pi`).
///
/// `*`, `/` and `%` all sit at one priority so they evaluate strictly left to
/// right, as every other language groups them. They must also all be marked
/// non-commutative: exmex gives a *commutative* operator between two literals
/// a priority boost (`prio * 10 + 5`) to fold constants, which would reorder
/// `100 / 5 * 2` into `100 / (5 * 2)`. The stock set dodges that only because
/// it parks `/` a whole tier above `*`, which is safe for division (regrouping
/// preserves the value) but not for remainder — `2 * 10 % 4` came out as
/// `2 * (10 % 4)`.
///
/// Everything else — the trig family, sqrt/exp, `ln`, `log` (base e) and
/// `log10`, abs/floor/ceil/round/signum, and the `e` constant — comes from the
/// default set already.
#[derive(Clone, Debug)]
struct CalcOps;

impl MakeOperators<f64> for CalcOps {
    fn make<'a>() -> Vec<Operator<'a, f64>> {
        let mut ops: Vec<Operator<'a, f64>> = FloatOpsFactory::<f64>::make()
            .into_iter()
            .filter(|op| op.repr() != "*" && op.repr() != "/")
            .collect();
        for (repr, apply) in [
            ("*", (|a, b| a * b) as fn(f64, f64) -> f64),
            ("/", |a, b| a / b),
            ("%", |a, b| a % b),
        ] {
            ops.push(Operator::make_bin(
                repr,
                BinOp {
                    apply,
                    prio: 2,
                    is_commutative: false,
                },
            ));
        }
        ops.push(Operator::make_constant("pi", std::f64::consts::PI));
        ops
    }
}

// exmex's stock literal matcher accepts digits and dots only, so `6.022e23`
// parsed as `6.022` followed by the variable `e23` and failed. meval read
// e-notation, and a model asked for Avogadro's number writes it that way.
literal_matcher_from_pattern!(CalcLiterals, r"^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?");

type CalcExpr = FlatEx<f64, CalcOps, CalcLiterals>;

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

fn skip_spaces(cs: &[char], mut i: usize) -> usize {
    while i < cs.len() && cs[i].is_whitespace() {
        i += 1;
    }
    i
}

/// End (exclusive) of the single operand starting at `i`: leading signs, a
/// number or identifier, and any parenthesised group that follows — which
/// covers both `(1 + 2)` and a function's argument list in `sin(1)`.
fn operand_end(cs: &[char], mut i: usize) -> usize {
    while i < cs.len() && (cs[i].is_whitespace() || cs[i] == '-' || cs[i] == '+') {
        i += 1;
    }
    while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '.' || cs[i] == '_') {
        i += 1;
    }
    let open = skip_spaces(cs, i);
    if open < cs.len() && cs[open] == '(' {
        let mut depth = 0usize;
        for (j, c) in cs.iter().enumerate().skip(open) {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return j + 1;
                    }
                }
                _ => {}
            }
        }
        // Unbalanced — hand the whole tail to exmex so it reports the error.
        return cs.len();
    }
    i
}

/// End of an operand *plus* any `^` chain hanging off it, which is the extent
/// a unary minus has to cover to bind looser than exponentiation.
fn power_operand_end(cs: &[char], i: usize) -> usize {
    let mut end = operand_end(cs, i);
    loop {
        let next = skip_spaces(cs, end);
        if next < cs.len() && cs[next] == '^' {
            end = operand_end(cs, next + 1);
        } else {
            return end;
        }
    }
}

/// Re-parenthesise `^` chains right to left: `2^3^2` becomes `2^(3^2)`.
/// exmex applies equal-priority operators left to right, which would give
/// `(2^3)^2` — 64 where standard notation (and meval) says 512.
fn rewrite_pow_chains(src: &str) -> String {
    let cs: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '^' {
            let end = power_operand_end(&cs, i + 1);
            if end > operand_end(&cs, i + 1) {
                let body: String = cs[i + 1..end].iter().collect();
                out.push('^');
                out.push('(');
                out.push_str(&rewrite_pow_chains(&body));
                out.push(')');
                i = end;
                continue;
            }
        }
        out.push(cs[i]);
        i += 1;
    }
    out
}

/// Rewrite unary minus as `(0 - operand)`. exmex applies unary operators to
/// the operand *before* any binary one, so `-2^2` would be `(-2)^2` = 4;
/// wrapping the operand together with its `^` chain restores the standard
/// reading, `-(2^2)` = -4. Taking the operand's real extent (rather than
/// multiplying by -1) also keeps `6/-3` and `10%-3` correct.
fn rewrite_unary_minus(src: &str) -> String {
    let cs: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        // A `-` is unary unless it follows something an operand can end with.
        let unary = c == '-'
            && match prev {
                None => true,
                Some(p) => !(p.is_alphanumeric() || p == '.' || p == ')' || p == '_'),
            };
        if unary {
            let end = power_operand_end(&cs, i + 1);
            let body: String = cs[i + 1..end].iter().collect();
            out.push_str("(0-");
            out.push_str(&rewrite_unary_minus(&body));
            out.push(')');
            prev = Some(')');
            i = end;
            continue;
        }
        out.push(c);
        if !c.is_whitespace() {
            prev = Some(c);
        }
        i += 1;
    }
    out
}

/// Bring the expression in line with standard math notation before handing it
/// to exmex. Chains first, so that the parentheses they insert are in place
/// when the unary pass walks the result.
fn normalize_expression(src: &str) -> String {
    rewrite_unary_minus(&rewrite_pow_chains(src))
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
    match CalcExpr::parse(&normalize_expression(trimmed)).and_then(|expr| expr.eval(&[])) {
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

    /// Assert a whole table of expressions in one go — every one of these is a
    /// case where exmex's stock semantics disagree with standard notation (and
    /// with meval, which this tool used before), so they must not drift back.
    fn assert_evaluates(cases: &[(&str, &str)]) {
        for (expr, want) in cases {
            let r = dispatch(&json!({ "expression": expr }));
            assert!(!r.is_error, "`{expr}` errored: {}", r.content_text);
            assert_eq!(r.content_text, *want, "`{expr}`");
        }
    }

    /// `%` is advertised in the tool description but isn't part of exmex's
    /// default operator set — [`CalcOps`] adds it. `*`, `/` and `%` share one
    /// left-associative tier, so all of these group strictly left to right.
    #[test]
    fn multiplicative_operators_group_left_to_right() {
        assert_evaluates(&[
            ("7 % 3", "1"),
            ("10 % 4 * 2", "4"),
            // Regression: `%` used to outrank `*`, giving 2 * (10 % 4) == 4.
            ("2 * 10 % 4", "0"),
            ("6 * 7 % 4", "2"),
            ("10 % 4 / 2", "1"),
            // Regression: exmex's constant-folding boost reorders commutative
            // operators, which turned this into 100 / (5 * 2) == 10.
            ("100 / 5 * 2", "40"),
            ("100 / 5 / 2", "10"),
            ("24 / 2 / 3 * 4", "16"),
            ("2 * 3 * 4", "24"),
        ]);
    }

    /// exmex applies unary operators to their operand before any binary
    /// operator, and evaluates `^` chains left to right. Both disagree with
    /// standard notation, so [`normalize_expression`] rewrites them.
    #[test]
    fn exponent_and_unary_minus_follow_standard_notation() {
        assert_evaluates(&[
            // Unary minus binds looser than `^` …
            ("-2^2", "-4"),
            ("-2^3", "-8"),
            ("-2^2*3", "-12"),
            ("-sqrt(4)^2", "-4"),
            // … but parentheses still win, and `^` still takes a negative
            // exponent.
            ("(-2)^2", "4"),
            ("2^-3", "0.125"),
            ("-2^-3", "-0.125"),
            // `^` is right-associative: 2^(3^2), not (2^3)^2.
            ("2^3^2", "512"),
            ("2^2^3", "256"),
            ("(2^3)^2", "64"),
            ("1 + 2^3^2", "513"),
            ("-2^3^2", "-512"),
            // Unary minus as a right-hand operand must not escape its operator.
            ("6/-3", "-2"),
            ("10%-3", "1"),
            ("2*-3", "-6"),
            ("3--2", "5"),
            ("--3", "3"),
            ("-(2+3)", "-5"),
            // Ordinary binary minus is untouched.
            ("1-2", "-1"),
            ("10-2-3", "5"),
            ("2 - -3", "5"),
        ]);
    }

    /// meval read scientific notation; exmex's stock literal matcher stops at
    /// digits and dots, so `6.022e23` parsed as `6.022` and a variable `e23`.
    #[test]
    fn scientific_notation_literals_parse() {
        assert_evaluates(&[
            ("1e3", "1000"),
            ("1e+3", "1000"),
            ("2.5E-3", "0.0025"),
            ("1.5e2", "150"),
            ("-1e3", "-1000"),
            (".5 + 1", "1.5"),
            ("5. + 1", "6"),
        ]);
        // Avogadro's number is beyond the exact-integer window, so it renders
        // through the float path rather than as an integer.
        let r = dispatch(&json!({"expression": "6.022e23 / 2"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.starts_with("301100000000"), "got: {}", r.content_text);
        // The `e` constant still resolves when it isn't part of a literal.
        assert_evaluates(&[("log(e)", "1"), ("e^0", "1")]);
    }

    /// The rewrites are textual, so they must leave non-ASCII identifiers and
    /// ordinary subtraction alone.
    #[test]
    fn normalization_leaves_unrelated_text_alone() {
        assert_eq!(normalize_expression("3 - 2"), "3 - 2");
        assert_eq!(normalize_expression("2^2"), "2^2");
        assert_eq!(normalize_expression("-2^2"), "(0-2^2)");
        assert_eq!(normalize_expression("2^3^2"), "2^(3^2)");
        // `π` is alphanumeric, so the `-` after it stays binary.
        let r = dispatch(&json!({"expression": "π-1"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.starts_with("2.14159"), "got: {}", r.content_text);
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
