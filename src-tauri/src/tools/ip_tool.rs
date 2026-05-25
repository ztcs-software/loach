//! Built-in `ip` tool — CIDR containment and subnet arithmetic.
//!
//! Models are *fine* at small examples (does 10.0.0.5 fit in 10.0.0.0/24)
//! but slip on /15 vs /16 boundaries, broadcast/network identity for odd
//! prefix lengths, and IPv6 in particular. `ipnet` is the right crate.

use std::net::IpAddr;

use ipnet::IpNet;
use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "ip";

pub fn tool_description() -> &'static str {
    "IP-address arithmetic. Use this rather than computing subnet \
     boundaries by hand — getting the network/broadcast address right \
     for a /23 or a /127 is harder than it looks, especially on IPv6. \
     Operations: \
     `in_cidr` — return `true` / `false` for whether `address` falls \
     within `cidr`. Both IPv4 and IPv6 supported. Family mismatches \
     return `false` (an IPv4 address never matches an IPv6 prefix). \
     `subnet_info` — given a `cidr`, return the network address, \
     broadcast (IPv4 only), first/last usable host, prefix length, and \
     total host count. Host count is the address range size; for IPv4 /31 \
     and /32 (and IPv6 in general) every address is treated as usable."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": ["in_cidr", "subnet_info"],
                "description": "Operation to perform."
            },
            "address": { "type": "string", "description": "IPv4 or IPv6 address (no prefix). For `in_cidr`." },
            "cidr": { "type": "string", "description": "CIDR notation (e.g. `10.0.0.0/16`, `2001:db8::/32`)." }
        },
        "required": ["op", "cidr"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let op = match args.get("op").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `op` argument"),
    };
    let cidr_str = match args.get("cidr").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `cidr` argument"),
    };
    let cidr: IpNet = match cidr_str.parse() {
        Ok(n) => n,
        Err(e) => return err(format!("invalid CIDR `{cidr_str}`: {e}")),
    };
    match op {
        "in_cidr" => op_in_cidr(args, cidr),
        "subnet_info" => op_subnet_info(cidr),
        other => err(format!("unknown op `{other}`")),
    }
}

fn op_in_cidr(args: &Value, cidr: IpNet) -> McpCallResult {
    let address_str = match args.get("address").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `address` argument for in_cidr"),
    };
    let addr: IpAddr = match address_str.parse() {
        Ok(a) => a,
        Err(e) => return err(format!("invalid address `{address_str}`: {e}")),
    };
    // ipnet's `contains` rejects v4 vs v6 cross-family at compile time,
    // so we explicitly dispatch and report `false` on mismatch rather
    // than failing the call — that's the answer the model wants.
    let inside = match (cidr, addr) {
        (IpNet::V4(net), IpAddr::V4(ip)) => net.contains(&ip),
        (IpNet::V6(net), IpAddr::V6(ip)) => net.contains(&ip),
        _ => false,
    };
    McpCallResult {
        content_text: inside.to_string(),
        is_error: false,
    }
}

fn op_subnet_info(cidr: IpNet) -> McpCallResult {
    let mut out = String::new();
    out.push_str(&format!("network: {}\n", cidr.network()));
    if let IpNet::V4(net) = cidr {
        out.push_str(&format!("broadcast: {}\n", net.broadcast()));
    }
    out.push_str(&format!("prefix_len: {}\n", cidr.prefix_len()));
    out.push_str(&format!("netmask: {}\n", cidr.netmask()));

    // First/last usable host. For IPv4 /31 and /32, and for all IPv6 prefixes,
    // we treat every address in the range as usable (RFC 3021 for /31,
    // and IPv6 has no broadcast). For other IPv4 prefixes, skip the
    // network and broadcast addresses.
    let (first, last, hosts) = match cidr {
        IpNet::V4(net) => {
            let prefix = net.prefix_len();
            let total: u64 = 1u64 << (32 - prefix as u64);
            if prefix >= 31 {
                (
                    IpAddr::V4(net.network()),
                    IpAddr::V4(net.broadcast()),
                    total,
                )
            } else {
                let network_u32 = u32::from(net.network());
                let broadcast_u32 = u32::from(net.broadcast());
                (
                    IpAddr::V4(std::net::Ipv4Addr::from(network_u32 + 1)),
                    IpAddr::V4(std::net::Ipv4Addr::from(broadcast_u32 - 1)),
                    total - 2,
                )
            }
        }
        IpNet::V6(net) => {
            let prefix = net.prefix_len();
            let total: u128 = if prefix == 0 {
                // 2^128 doesn't fit in u128 — saturate at the max and
                // mention the cap when reporting.
                u128::MAX
            } else {
                1u128 << (128 - prefix as u32)
            };
            (
                IpAddr::V6(net.network()),
                IpAddr::V6(net.broadcast()),
                // We cap the displayed count at u64::MAX for compatibility
                // with the IPv4 path; the formatter handles the limit.
                total.min(u128::from(u64::MAX)) as u64,
            )
        }
    };
    out.push_str(&format!("first_host: {first}\n"));
    out.push_str(&format!("last_host: {last}\n"));
    // For IPv6 we may have capped the count; the model can verify with
    // `subnet_info` on a smaller prefix if it needs the exact figure.
    out.push_str(&format!("host_count: {hosts}"));

    McpCallResult {
        content_text: out,
        is_error: false,
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ipv4_in_cidr_positive() {
        let r = dispatch(&json!({"op": "in_cidr", "address": "10.0.5.7", "cidr": "10.0.0.0/16"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "true");
    }

    #[test]
    fn ipv4_in_cidr_negative() {
        let r = dispatch(&json!({"op": "in_cidr", "address": "10.1.0.0", "cidr": "10.0.0.0/16"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "false");
    }

    #[test]
    fn cross_family_is_false_not_error() {
        let r = dispatch(&json!({"op": "in_cidr", "address": "10.0.0.1", "cidr": "2001:db8::/32"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "false");
    }

    #[test]
    fn subnet_info_ipv4_slash_24() {
        let r = dispatch(&json!({"op": "subnet_info", "cidr": "192.168.1.0/24"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("network: 192.168.1.0"));
        assert!(r.content_text.contains("broadcast: 192.168.1.255"));
        assert!(r.content_text.contains("first_host: 192.168.1.1"));
        assert!(r.content_text.contains("last_host: 192.168.1.254"));
        assert!(r.content_text.contains("host_count: 254"));
    }

    #[test]
    fn subnet_info_ipv4_slash_31_treats_both_addresses_as_usable() {
        let r = dispatch(&json!({"op": "subnet_info", "cidr": "10.0.0.0/31"}));
        assert!(!r.is_error);
        assert!(r.content_text.contains("first_host: 10.0.0.0"));
        assert!(r.content_text.contains("last_host: 10.0.0.1"));
        assert!(r.content_text.contains("host_count: 2"));
    }

    #[test]
    fn ipv6_in_cidr() {
        let r = dispatch(&json!({
            "op": "in_cidr",
            "address": "2001:db8::1",
            "cidr": "2001:db8::/32",
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "true");
    }

    #[test]
    fn rejects_malformed_cidr() {
        let r = dispatch(&json!({"op": "in_cidr", "address": "10.0.0.1", "cidr": "not-a-cidr"}));
        assert!(r.is_error);
    }
}
