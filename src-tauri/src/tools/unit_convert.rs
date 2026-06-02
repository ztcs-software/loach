//! Built-in `unit_convert` tool — exact unit conversion via a static
//! factor table. Models hallucinate conversion factors all the time
//! (especially for less common units: furlongs, troy ounces, parsecs).
//! A table is cheaper than pulling `uom` for a few dozen lookups.
//!
//! Temperature is handled separately because it's affine (offsets, not
//! just scale). Everything else converts via a base unit: input × from
//! factor → base, then ÷ to factor → output.

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "unit_convert";

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum Category {
    Length,
    Mass,
    Volume,
    Speed,
    Time,
    Area,
    Energy,
    Pressure,
    Temperature,
}

impl Category {
    fn label(self) -> &'static str {
        match self {
            Category::Length => "length",
            Category::Mass => "mass",
            Category::Volume => "volume",
            Category::Speed => "speed",
            Category::Time => "time",
            Category::Area => "area",
            Category::Energy => "energy",
            Category::Pressure => "pressure",
            Category::Temperature => "temperature",
        }
    }
}

struct Unit {
    /// Lowercase lookup key. Multiple rows can share a category to express
    /// aliases (e.g. `m` / `meter` / `metre`).
    name: &'static str,
    category: Category,
    /// `value_in_base = value × factor`. Ignored for [`Category::Temperature`]
    /// (see [`convert_temperature`]).
    factor: f64,
}

/// Static table — base units: meter, kilogram, liter, m/s, second, m², joule, pascal.
/// Aliases stay as separate rows rather than a side table, so a linear
/// scan stays the only lookup path.
const UNITS: &[Unit] = &[
    // ---------- Length (base: meter) ----------
    Unit { name: "m", category: Category::Length, factor: 1.0 },
    Unit { name: "meter", category: Category::Length, factor: 1.0 },
    Unit { name: "metre", category: Category::Length, factor: 1.0 },
    Unit { name: "meters", category: Category::Length, factor: 1.0 },
    Unit { name: "metres", category: Category::Length, factor: 1.0 },
    Unit { name: "cm", category: Category::Length, factor: 0.01 },
    Unit { name: "centimeter", category: Category::Length, factor: 0.01 },
    Unit { name: "mm", category: Category::Length, factor: 0.001 },
    Unit { name: "millimeter", category: Category::Length, factor: 0.001 },
    Unit { name: "km", category: Category::Length, factor: 1_000.0 },
    Unit { name: "kilometer", category: Category::Length, factor: 1_000.0 },
    Unit { name: "kilometre", category: Category::Length, factor: 1_000.0 },
    Unit { name: "in", category: Category::Length, factor: 0.0254 },
    Unit { name: "inch", category: Category::Length, factor: 0.0254 },
    Unit { name: "inches", category: Category::Length, factor: 0.0254 },
    Unit { name: "ft", category: Category::Length, factor: 0.3048 },
    Unit { name: "foot", category: Category::Length, factor: 0.3048 },
    Unit { name: "feet", category: Category::Length, factor: 0.3048 },
    Unit { name: "yd", category: Category::Length, factor: 0.9144 },
    Unit { name: "yard", category: Category::Length, factor: 0.9144 },
    Unit { name: "mi", category: Category::Length, factor: 1_609.344 },
    Unit { name: "mile", category: Category::Length, factor: 1_609.344 },
    Unit { name: "miles", category: Category::Length, factor: 1_609.344 },
    Unit { name: "nmi", category: Category::Length, factor: 1_852.0 },
    Unit { name: "nautical_mile", category: Category::Length, factor: 1_852.0 },
    Unit { name: "furlong", category: Category::Length, factor: 201.168 },
    Unit { name: "ly", category: Category::Length, factor: 9.460_730_472_580_8e15 },
    Unit { name: "light_year", category: Category::Length, factor: 9.460_730_472_580_8e15 },
    Unit { name: "au", category: Category::Length, factor: 1.495_978_707e11 },
    // 3.0856775814913673e16 m is the IAU-2015 parsec; the literal here is
    // truncated to the digits f64 can faithfully represent (the trailing `3`
    // is below f64's ~16-decimal-digit precision and just trips clippy's
    // `excessive_precision` lint without changing the stored value).
    Unit { name: "pc", category: Category::Length, factor: 3.085_677_581_491_367e16 },
    Unit { name: "parsec", category: Category::Length, factor: 3.085_677_581_491_367e16 },

    // ---------- Mass (base: kilogram) ----------
    Unit { name: "kg", category: Category::Mass, factor: 1.0 },
    Unit { name: "kilogram", category: Category::Mass, factor: 1.0 },
    Unit { name: "g", category: Category::Mass, factor: 0.001 },
    Unit { name: "gram", category: Category::Mass, factor: 0.001 },
    Unit { name: "mg", category: Category::Mass, factor: 1.0e-6 },
    Unit { name: "milligram", category: Category::Mass, factor: 1.0e-6 },
    Unit { name: "t", category: Category::Mass, factor: 1_000.0 },
    Unit { name: "tonne", category: Category::Mass, factor: 1_000.0 },
    Unit { name: "metric_ton", category: Category::Mass, factor: 1_000.0 },
    Unit { name: "lb", category: Category::Mass, factor: 0.453_592_37 },
    Unit { name: "pound", category: Category::Mass, factor: 0.453_592_37 },
    Unit { name: "lbs", category: Category::Mass, factor: 0.453_592_37 },
    Unit { name: "oz", category: Category::Mass, factor: 0.028_349_523_125 },
    Unit { name: "ounce", category: Category::Mass, factor: 0.028_349_523_125 },
    Unit { name: "troy_oz", category: Category::Mass, factor: 0.031_103_476_8 },
    Unit { name: "stone", category: Category::Mass, factor: 6.350_293_18 },
    Unit { name: "st", category: Category::Mass, factor: 6.350_293_18 },
    Unit { name: "short_ton", category: Category::Mass, factor: 907.184_74 },
    Unit { name: "long_ton", category: Category::Mass, factor: 1_016.046_908_8 },
    Unit { name: "carat", category: Category::Mass, factor: 0.000_2 },

    // ---------- Volume (base: liter) ----------
    Unit { name: "l", category: Category::Volume, factor: 1.0 },
    Unit { name: "liter", category: Category::Volume, factor: 1.0 },
    Unit { name: "litre", category: Category::Volume, factor: 1.0 },
    Unit { name: "ml", category: Category::Volume, factor: 0.001 },
    Unit { name: "milliliter", category: Category::Volume, factor: 0.001 },
    Unit { name: "m3", category: Category::Volume, factor: 1_000.0 },
    Unit { name: "cubic_meter", category: Category::Volume, factor: 1_000.0 },
    Unit { name: "gal_us", category: Category::Volume, factor: 3.785_411_784 },
    Unit { name: "gal_uk", category: Category::Volume, factor: 4.546_09 },
    // Bare `gal` defaults to US gallon — match what `units(1)` does.
    Unit { name: "gal", category: Category::Volume, factor: 3.785_411_784 },
    Unit { name: "gallon", category: Category::Volume, factor: 3.785_411_784 },
    Unit { name: "qt_us", category: Category::Volume, factor: 0.946_352_946 },
    Unit { name: "qt", category: Category::Volume, factor: 0.946_352_946 },
    Unit { name: "pt_us", category: Category::Volume, factor: 0.473_176_473 },
    Unit { name: "pt", category: Category::Volume, factor: 0.473_176_473 },
    Unit { name: "cup_us", category: Category::Volume, factor: 0.236_588_236_5 },
    Unit { name: "cup", category: Category::Volume, factor: 0.236_588_236_5 },
    Unit { name: "fl_oz_us", category: Category::Volume, factor: 0.029_573_529_562_5 },
    Unit { name: "fl_oz", category: Category::Volume, factor: 0.029_573_529_562_5 },
    Unit { name: "tsp", category: Category::Volume, factor: 0.004_928_921_593_75 },
    Unit { name: "tbsp", category: Category::Volume, factor: 0.014_786_764_781_25 },

    // ---------- Speed (base: m/s) ----------
    Unit { name: "m/s", category: Category::Speed, factor: 1.0 },
    Unit { name: "mps", category: Category::Speed, factor: 1.0 },
    Unit { name: "km/h", category: Category::Speed, factor: 0.277_777_777_777_777_8 },
    Unit { name: "kph", category: Category::Speed, factor: 0.277_777_777_777_777_8 },
    Unit { name: "mph", category: Category::Speed, factor: 0.447_04 },
    Unit { name: "knot", category: Category::Speed, factor: 0.514_444_444_444_444_5 },
    Unit { name: "knots", category: Category::Speed, factor: 0.514_444_444_444_444_5 },
    Unit { name: "kn", category: Category::Speed, factor: 0.514_444_444_444_444_5 },
    Unit { name: "ft/s", category: Category::Speed, factor: 0.3048 },
    Unit { name: "fps", category: Category::Speed, factor: 0.3048 },

    // ---------- Time (base: second) ----------
    Unit { name: "s", category: Category::Time, factor: 1.0 },
    Unit { name: "sec", category: Category::Time, factor: 1.0 },
    Unit { name: "second", category: Category::Time, factor: 1.0 },
    Unit { name: "ms", category: Category::Time, factor: 0.001 },
    Unit { name: "millisecond", category: Category::Time, factor: 0.001 },
    Unit { name: "us", category: Category::Time, factor: 1.0e-6 },
    Unit { name: "microsecond", category: Category::Time, factor: 1.0e-6 },
    Unit { name: "ns", category: Category::Time, factor: 1.0e-9 },
    Unit { name: "nanosecond", category: Category::Time, factor: 1.0e-9 },
    Unit { name: "min", category: Category::Time, factor: 60.0 },
    Unit { name: "minute", category: Category::Time, factor: 60.0 },
    Unit { name: "h", category: Category::Time, factor: 3_600.0 },
    Unit { name: "hr", category: Category::Time, factor: 3_600.0 },
    Unit { name: "hour", category: Category::Time, factor: 3_600.0 },
    Unit { name: "day", category: Category::Time, factor: 86_400.0 },
    Unit { name: "d", category: Category::Time, factor: 86_400.0 },
    Unit { name: "week", category: Category::Time, factor: 604_800.0 },

    // ---------- Area (base: square meter) ----------
    Unit { name: "m2", category: Category::Area, factor: 1.0 },
    Unit { name: "sq_m", category: Category::Area, factor: 1.0 },
    Unit { name: "cm2", category: Category::Area, factor: 0.000_1 },
    Unit { name: "km2", category: Category::Area, factor: 1.0e6 },
    Unit { name: "ft2", category: Category::Area, factor: 0.092_903_04 },
    Unit { name: "sq_ft", category: Category::Area, factor: 0.092_903_04 },
    Unit { name: "in2", category: Category::Area, factor: 0.000_645_16 },
    Unit { name: "yd2", category: Category::Area, factor: 0.836_127_36 },
    Unit { name: "mi2", category: Category::Area, factor: 2_589_988.110_336 },
    Unit { name: "acre", category: Category::Area, factor: 4_046.856_422_4 },
    Unit { name: "hectare", category: Category::Area, factor: 10_000.0 },
    Unit { name: "ha", category: Category::Area, factor: 10_000.0 },

    // ---------- Energy (base: joule) ----------
    Unit { name: "j", category: Category::Energy, factor: 1.0 },
    Unit { name: "joule", category: Category::Energy, factor: 1.0 },
    Unit { name: "kj", category: Category::Energy, factor: 1_000.0 },
    Unit { name: "cal", category: Category::Energy, factor: 4.184 },
    Unit { name: "kcal", category: Category::Energy, factor: 4_184.0 },
    Unit { name: "wh", category: Category::Energy, factor: 3_600.0 },
    Unit { name: "kwh", category: Category::Energy, factor: 3_600_000.0 },
    Unit { name: "btu", category: Category::Energy, factor: 1_055.055_852_62 },

    // ---------- Pressure (base: pascal) ----------
    Unit { name: "pa", category: Category::Pressure, factor: 1.0 },
    Unit { name: "kpa", category: Category::Pressure, factor: 1_000.0 },
    Unit { name: "mpa", category: Category::Pressure, factor: 1.0e6 },
    Unit { name: "bar", category: Category::Pressure, factor: 100_000.0 },
    Unit { name: "psi", category: Category::Pressure, factor: 6_894.757_293_168 },
    Unit { name: "atm", category: Category::Pressure, factor: 101_325.0 },
    Unit { name: "mmhg", category: Category::Pressure, factor: 133.322_387_415 },
    Unit { name: "torr", category: Category::Pressure, factor: 133.322_368_421_05 },

    // ---------- Temperature (special — affine, not linear) ----------
    Unit { name: "c", category: Category::Temperature, factor: 0.0 },
    Unit { name: "celsius", category: Category::Temperature, factor: 0.0 },
    Unit { name: "f", category: Category::Temperature, factor: 0.0 },
    Unit { name: "fahrenheit", category: Category::Temperature, factor: 0.0 },
    Unit { name: "k", category: Category::Temperature, factor: 0.0 },
    Unit { name: "kelvin", category: Category::Temperature, factor: 0.0 },
];

pub fn tool_description() -> &'static str {
    "Convert a numeric value from one unit to another. Use this rather \
     than guessing a conversion factor — your answer will drift for \
     anything beyond `km ↔ mi` or `kg ↔ lb`. Supported categories: \
     length (m, cm, mm, km, in, ft, yd, mi, nmi, furlong, ly, au, pc), \
     mass (kg, g, mg, t, lb, oz, stone, short_ton, long_ton, troy_oz, carat), \
     volume (L, mL, m3, gal, qt, pt, cup, fl_oz, tsp, tbsp — US by default; \
     suffix `_us`/`_uk` for clarity), \
     speed (m/s, km/h, mph, knot, ft/s), \
     time (s, ms, us, ns, min, h, day, week), \
     area (m2, cm2, km2, ft2, in2, yd2, mi2, acre, hectare), \
     energy (J, kJ, cal, kcal, Wh, kWh, BTU), \
     pressure (Pa, kPa, MPa, bar, psi, atm, mmHg, torr), \
     temperature (C, F, K). Names are case-insensitive. Both units must \
     belong to the same category."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "value": { "type": "number", "description": "Numeric value to convert." },
            "from": { "type": "string", "description": "Source unit (case-insensitive)." },
            "to": { "type": "string", "description": "Target unit (case-insensitive). Must share a category with `from`." }
        },
        "required": ["value", "from", "to"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let value = match args.get("value").and_then(|v| v.as_f64()) {
        Some(v) if v.is_finite() => v,
        Some(_) => return err("`value` must be a finite number"),
        None => return err("missing required `value` argument (number)"),
    };
    let from_raw = match args.get("from").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `from` argument"),
    };
    let to_raw = match args.get("to").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `to` argument"),
    };
    let from = match find_unit(from_raw) {
        Some(u) => u,
        None => return err(format!("unknown unit `{from_raw}`")),
    };
    let to = match find_unit(to_raw) {
        Some(u) => u,
        None => return err(format!("unknown unit `{to_raw}`")),
    };
    if from.category != to.category {
        return err(format!(
            "cannot convert {} ({}) to {} ({}) — different categories",
            from_raw,
            from.category.label(),
            to_raw,
            to.category.label(),
        ));
    }
    let result = if from.category == Category::Temperature {
        match convert_temperature(value, from.name, to.name) {
            Ok(v) => v,
            Err(e) => return err(e),
        }
    } else {
        value * from.factor / to.factor
    };
    // A finite-but-huge `value` times a large factor (e.g. parsec → light-year
    // at 1e308) can overflow to infinity. `format_number` would then emit a
    // bare "inf"; return an explanatory error instead, mirroring
    // `calculate::format_result`'s NaN/Infinity handling.
    if !result.is_finite() {
        return err("conversion result is out of range (overflowed)");
    }
    McpCallResult {
        content_text: format_number(result),
        is_error: false,
        ..Default::default()
    }
}

fn find_unit(name: &str) -> Option<&'static Unit> {
    let needle = name.trim().to_ascii_lowercase();
    UNITS.iter().find(|u| u.name == needle)
}

/// Affine temperature conversion, routed through Kelvin so each pair is
/// just two formulas. Names are already lower-cased by [`find_unit`].
fn convert_temperature(value: f64, from: &str, to: &str) -> Result<f64, String> {
    let kelvin = match from {
        "c" | "celsius" => value + 273.15,
        "f" | "fahrenheit" => (value + 459.67) * 5.0 / 9.0,
        "k" | "kelvin" => value,
        other => return Err(format!("unknown temperature unit `{other}`")),
    };
    Ok(match to {
        "c" | "celsius" => kelvin - 273.15,
        "f" | "fahrenheit" => kelvin * 9.0 / 5.0 - 459.67,
        "k" | "kelvin" => kelvin,
        other => return Err(format!("unknown temperature unit `{other}`")),
    })
}

/// Same trick as `calculate::format_result`: integer-valued floats become
/// `N`, otherwise trim trailing zeros from a 12-digit display so the
/// output reads cleanly.
fn format_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    let s = format!("{v:.12}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn meter_to_foot() {
        let r = dispatch(&json!({"value": 1.0, "from": "m", "to": "ft"}));
        assert!(!r.is_error);
        assert!(r.content_text.starts_with("3.28083"), "got: {}", r.content_text);
    }

    #[test]
    fn celsius_to_fahrenheit() {
        let r = dispatch(&json!({"value": 100.0, "from": "C", "to": "F"}));
        assert!(!r.is_error);
        // 100°C = 212°F exactly.
        assert_eq!(r.content_text, "212");
    }

    #[test]
    fn fahrenheit_to_celsius() {
        let r = dispatch(&json!({"value": 32.0, "from": "F", "to": "C"}));
        assert!(!r.is_error);
        // 32°F = 0°C exactly.
        assert_eq!(r.content_text, "0");
    }

    #[test]
    fn kg_to_pound() {
        let r = dispatch(&json!({"value": 1.0, "from": "kg", "to": "lb"}));
        assert!(!r.is_error);
        assert!(r.content_text.starts_with("2.2046"), "got: {}", r.content_text);
    }

    #[test]
    fn troy_oz_is_distinct_from_oz() {
        let r1 = dispatch(&json!({"value": 1.0, "from": "oz", "to": "g"}));
        let r2 = dispatch(&json!({"value": 1.0, "from": "troy_oz", "to": "g"}));
        assert!(!r1.is_error && !r2.is_error);
        assert_ne!(r1.content_text, r2.content_text, "troy_oz and oz must not collapse");
    }

    #[test]
    fn rejects_cross_category() {
        let r = dispatch(&json!({"value": 1.0, "from": "m", "to": "kg"}));
        assert!(r.is_error);
        assert!(r.content_text.contains("different categories"));
    }

    #[test]
    fn rejects_unknown_unit() {
        let r = dispatch(&json!({"value": 1.0, "from": "smoot", "to": "m"}));
        assert!(r.is_error);
    }

    #[test]
    fn furlong_known_value() {
        // 1 furlong = 660 feet exactly.
        let r = dispatch(&json!({"value": 1.0, "from": "furlong", "to": "ft"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "660");
    }
}
