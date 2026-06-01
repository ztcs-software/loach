pub mod ollama;
pub mod openai;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::mcp::McpToolDef;

/// Truncate a tool result to `max_bytes` on a UTF-8 boundary and append a
/// trailing note so the model knows it was clipped. Naive byte-index
/// truncation would panic on multi-byte sequences (a single emoji at the
/// boundary trips it). We walk char_indices to land on a valid edge.
///
/// Shared between providers so a tweak to truncation phrasing (or the
/// "Ask the tool again with narrower arguments" hint, which the model
/// reads as guidance) lands in both transports at once.
pub(super) fn cap_tool_text(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let cut = s
        .char_indices()
        .take_while(|(i, _)| *i <= max_bytes)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    format!(
        "{}\n\n[... result truncated by Loach at {} bytes; original was {} bytes. \
         Ask the tool again with narrower arguments if you need more.]",
        &s[..cut],
        max_bytes,
        s.len()
    )
}

/// Soft ceiling on the serialized `messages` array we'll ship to the
/// provider. After a few tool turns with multi-KB results, the running
/// history grows fast — every subsequent call has to re-send the whole
/// transcript, so the payload scales quadratically with turn count.
///
/// Two MiB is generous (most chat sessions stay sub-100 KiB) but small
/// enough that we don't burn token budgets, hit per-request payload
/// limits, or stall on slow uploads when the user is stuck behind a thin
/// link. When we cross it we replace the oldest tool result with a stub —
/// the model still sees the assistant turn that requested the tool, just
/// not the (now redundant, possibly huge) reply.
pub(super) const SOFT_MESSAGES_CAP_BYTES: usize = 2 * 1024 * 1024;

/// Crude byte-size estimate for a JSON-encoded `messages` array. Uses
/// `serde_json::to_vec` so the number matches what reqwest will actually
/// upload — anything more clever risks drifting from the wire shape.
fn messages_payload_size(messages: &[Value]) -> usize {
    serde_json::to_vec(messages).map(|v| v.len()).unwrap_or(0)
}

/// Replace the oldest substantive tool-role messages with a short stub
/// until the payload fits under `SOFT_MESSAGES_CAP_BYTES`, or until no
/// substantive tool messages remain (at which point the model context is
/// unrescuable from our side — let the provider decide whether to accept
/// it). Idempotent across calls so providers can invoke it between every
/// turn.
///
/// We deliberately *don't* drop user / assistant / system messages — that
/// would break the chat semantics and confuse the model about what it
/// had said. The stub keeps the tool call's place in the transcript so
/// the model still sees the call→reply rhythm.
///
/// `search_from` advances each iteration so we never re-stub the same
/// slot (the stub text itself is >64 bytes, which would otherwise still
/// satisfy `is_substantive_tool_msg` and trap the loop spinning forever
/// in the rare case where one stub alone isn't enough to get back under
/// the cap — e.g. three multi-MB tool results in a row).
pub(super) fn bound_messages_payload(messages: &mut [Value]) {
    let mut search_from: usize = 0;
    while messages_payload_size(messages) > SOFT_MESSAGES_CAP_BYTES {
        let mut found_idx: Option<usize> = None;
        for i in search_from..messages.len() {
            if is_substantive_tool_msg(&messages[i]) {
                found_idx = Some(i);
                break;
            }
        }
        match found_idx {
            Some(i) => {
                stub_tool_message(&mut messages[i]);
                search_from = i + 1;
            }
            None => {
                // Nothing left to drop — the system / user / assistant
                // turns alone exceed the cap, or every tool message is
                // already either short or stubbed. Bail rather than
                // spinning; let the provider's own context-length error
                // surface to the user if it doesn't fit.
                tracing::warn!(
                    "messages payload {} bytes exceeds cap of {} bytes after \
                     dropping every tool result — sending as-is",
                    messages_payload_size(messages),
                    SOFT_MESSAGES_CAP_BYTES
                );
                break;
            }
        }
    }
}

fn is_substantive_tool_msg(m: &Value) -> bool {
    if m.get("role").and_then(|r| r.as_str()) != Some("tool") {
        return false;
    }
    let content = m.get("content");
    // Skip messages whose content is already short (already stubbed, or
    // genuinely empty) so we don't pointlessly re-stub on every loop.
    match content {
        Some(Value::String(s)) => s.len() > 64,
        Some(Value::Array(parts)) => {
            serde_json::to_vec(parts).map(|v| v.len()).unwrap_or(0) > 64
        }
        _ => false,
    }
}

fn stub_tool_message(m: &mut Value) {
    if let Some(obj) = m.as_object_mut() {
        obj.insert(
            "content".into(),
            json!("[earlier tool result dropped to keep the conversation within the size budget]"),
        );
    }
}

/// Reject a base URL whose host is — or resolves to — a link-local
/// address. Designed to be a small, defense-in-depth SSRF guard layered
/// over the shared `AppState.http` client (which is intentionally *not*
/// DNS-pinned the way MCP is, because hosted providers like
/// `api.openai.com` and an arbitrary local LAN llama-server are equally
/// legitimate destinations). Link-local is what we want to block —
/// AWS / GCP / Azure / DO / Oracle metadata services all live at
/// 169.254.169.254 (and IPv6 metadata at fe80::a9fe:a9fe-style addresses),
/// and there is no realistic deployment that legitimately points an
/// LLM endpoint at those ranges. Public + RFC 1918 + CGNAT + loopback
/// all pass.
///
/// Hostnames that don't parse as IPs are resolved through the system
/// resolver and *every* returned address is checked; we refuse if any
/// one of them is link-local, since reqwest can fail over between them
/// during connect. If DNS resolution itself fails we let the request
/// proceed — `reqwest::send` will surface a more accurate error than we
/// could synthesize here.
pub(super) async fn refuse_link_local_host(base_url: &str) -> Result<(), String> {
    use std::net::IpAddr;
    let url = reqwest::Url::parse(base_url)
        .map_err(|e| format!("could not parse base URL: {e}"))?;
    let Some(host) = url.host_str() else {
        return Ok(());
    };
    // Strip the IPv6 `[ ]` brackets that `Url::host_str` leaves on the
    // address before we feed it to `IpAddr::from_str`.
    let host_for_ip = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    let check = |ip: IpAddr| -> Result<(), String> {
        if is_link_local(&ip) {
            return Err(format!(
                "Refusing to connect to {ip}: link-local addresses host \
                 cloud-metadata services that should not receive LLM traffic."
            ));
        }
        Ok(())
    };
    if let Ok(ip) = host_for_ip.parse::<IpAddr>() {
        return check(ip);
    }
    // Hostname: resolve through the OS. If resolution fails, leave the
    // request alone — the subsequent `reqwest::send` will produce a more
    // accurate error than we could synthesize here.
    let port = url.port_or_known_default().unwrap_or(80);
    if let Ok(mut iter) = tokio::net::lookup_host((host, port)).await {
        for addr in iter.by_ref() {
            check(addr.ip())?;
        }
    }
    Ok(())
}

fn is_link_local(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            let segs = v6.segments();
            // Native IPv6 link-local: fe80::/10.
            if (segs[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // An attacker-controlled AAAA record can smuggle a link-local
            // IPv4 (169.254.169.254 is cloud metadata) inside an IPv6 address
            // — IPv4-mapped (`::ffff:a9fe:a9fe`), NAT64 (`64:ff9b::a9fe:a9fe`),
            // or deprecated IPv4-compatible (`::a9fe:a9fe`) — which the host
            // then routes to 169.254.x.x. Decode the embedded IPv4 and screen
            // it too, mirroring `fetch_url::is_public_ip`. Without this the
            // bare `fe80::/10` check above let those forms slip straight past.
            let is_v4_mapped = segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0xffff;
            let is_nat64 = segs[0] == 0x0064
                && segs[1] == 0xff9b
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0;
            // ::a.b.c.d — high 96 bits zero. Loopback (::1) / unspecified (::)
            // have a zero tail and aren't link-local, so they harmlessly fall
            // through the embedded check below.
            let is_v4_compat = segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0;
            if is_v4_mapped || is_nat64 || is_v4_compat {
                let embedded = std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    (segs[6] & 0xff) as u8,
                    (segs[7] >> 8) as u8,
                    (segs[7] & 0xff) as u8,
                );
                return embedded.is_link_local();
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuse_link_local_rejects_aws_metadata_v4() {
        let err = refuse_link_local_host("http://169.254.169.254/latest/")
            .await
            .expect_err("AWS metadata IP must be refused");
        assert!(err.contains("169.254.169.254"), "{err}");
    }

    #[tokio::test]
    async fn refuse_link_local_rejects_link_local_v6() {
        let err = refuse_link_local_host("http://[fe80::1]:11434")
            .await
            .expect_err("fe80::/10 must be refused");
        assert!(err.contains("fe80::1"), "{err}");
    }

    #[tokio::test]
    async fn refuse_link_local_allows_loopback_and_lan() {
        assert!(refuse_link_local_host("http://127.0.0.1:11434").await.is_ok());
        assert!(refuse_link_local_host("http://[::1]:11434").await.is_ok());
        assert!(refuse_link_local_host("http://10.0.1.5:11434").await.is_ok());
        assert!(refuse_link_local_host("http://192.168.1.10:11434").await.is_ok());
        assert!(refuse_link_local_host("http://100.64.0.1:11434").await.is_ok());
    }

    #[tokio::test]
    async fn refuse_link_local_allows_public() {
        assert!(refuse_link_local_host("https://api.openai.com").await.is_ok());
        assert!(refuse_link_local_host("http://8.8.8.8/").await.is_ok());
    }

    #[test]
    fn bound_messages_payload_is_noop_under_cap() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hello" }),
            json!({ "role": "assistant", "content": "hi" }),
        ];
        let before = msgs.clone();
        bound_messages_payload(&mut msgs);
        assert_eq!(msgs, before);
    }

    #[test]
    fn bound_messages_payload_stubs_oldest_tool_result_first() {
        // Build a transcript where the first tool message is large enough
        // to push us over the cap and the second is small. The trimmer
        // should replace the first and leave the second intact.
        let big = "x".repeat(SOFT_MESSAGES_CAP_BYTES + 1024);
        let mut msgs = vec![
            json!({ "role": "system", "content": "you are a helper" }),
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "assistant", "content": "calling tool" }),
            json!({ "role": "tool", "tool_call_id": "1", "content": big.clone() }),
            json!({ "role": "assistant", "content": "calling again" }),
            json!({ "role": "tool", "tool_call_id": "2", "content": "small result" }),
        ];
        bound_messages_payload(&mut msgs);
        // First tool message stubbed.
        assert!(
            msgs[3]["content"]
                .as_str()
                .unwrap()
                .contains("dropped to keep the conversation"),
            "first tool message should be stubbed, got: {:?}",
            msgs[3]
        );
        // Second tool message untouched.
        assert_eq!(msgs[5]["content"], "small result");
        // System / user / assistant messages must be left alone.
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["content"], "go");
        assert_eq!(msgs[2]["content"], "calling tool");
    }

    #[test]
    fn bound_messages_payload_handles_multiple_huge_tool_messages() {
        // Three tool messages each large enough that stubbing one isn't
        // enough to clear the cap. Regression for an earlier impl that
        // used `iter_mut().find(...)` and re-found the same just-stubbed
        // slot on every iteration — spinning forever because the stub
        // text itself is >64 bytes and `is_substantive_tool_msg` still
        // matched it. With `search_from` advancing per iteration, each
        // slot is visited at most once and the loop terminates.
        let big = "y".repeat(SOFT_MESSAGES_CAP_BYTES / 2);
        let mut msgs = vec![
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "tool", "tool_call_id": "1", "content": big.clone() }),
            json!({ "role": "assistant", "content": "next" }),
            json!({ "role": "tool", "tool_call_id": "2", "content": big.clone() }),
            json!({ "role": "assistant", "content": "another" }),
            json!({ "role": "tool", "tool_call_id": "3", "content": big.clone() }),
        ];
        // Must terminate, not hang. The test runner enforces a timeout
        // implicitly via the cargo test harness, so a hang fails the
        // suite even without an explicit panic.
        bound_messages_payload(&mut msgs);
        // After: payload must be under cap.
        assert!(
            messages_payload_size(&msgs) <= SOFT_MESSAGES_CAP_BYTES,
            "size {} still over cap {}",
            messages_payload_size(&msgs),
            SOFT_MESSAGES_CAP_BYTES
        );
        // At least one tool message stubbed; non-tool messages untouched.
        assert_eq!(msgs[0]["content"], "go");
        assert_eq!(msgs[2]["content"], "next");
        assert_eq!(msgs[4]["content"], "another");
    }

    #[test]
    fn bound_messages_payload_leaves_short_tool_messages_alone() {
        // Even when the array is over the cap, short tool messages stay —
        // dropping a 30-byte content for a 30-byte stub buys nothing and
        // would loop forever otherwise.
        let short_tool = json!({ "role": "tool", "content": "ok" });
        let mut msgs = vec![
            json!({ "role": "user", "content": "x".repeat(SOFT_MESSAGES_CAP_BYTES) }),
            short_tool.clone(),
        ];
        bound_messages_payload(&mut msgs);
        assert_eq!(msgs[1], short_tool);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub provider: String,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GenerationParams {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub min_p: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
    #[serde(default)]
    pub repeat_penalty: Option<f32>,
    #[serde(default)]
    pub frequency_penalty: Option<f32>,
    #[serde(default)]
    pub presence_penalty: Option<f32>,
    #[serde(default)]
    pub seed: Option<i64>,
    /// Reasoning toggle for thinking-capable models (Qwen3, DeepSeek-R1,
    /// GPT-OSS, …). `Some(true)` forces a chain-of-thought before the
    /// reply; `Some(false)` suppresses it; `None` lets Ollama use the
    /// model's own default. Models without thinking capability ignore the
    /// flag — Ollama returns an error for them, but the frontend gates the
    /// toggle on the model's `capabilities` so we never send it for those.
    #[serde(default)]
    pub think: Option<bool>,
    /// Number of model layers to offload to the GPU (Ollama `num_gpu`).
    /// `Some(0)` forces CPU-only inference, `Some(n)` offloads `n` layers,
    /// `None` lets Ollama auto-detect based on available VRAM. Useful for
    /// users whose model OOMs the GPU and need to dial offload down.
    #[serde(default)]
    pub num_gpu: Option<u32>,
    /// Enable Ollama's low-VRAM mode. `Some(true)` opts in (smaller batches,
    /// reduced KV cache); `None` / `Some(false)` follows Ollama's default
    /// (off). Pairs with `num_gpu` for memory-constrained setups.
    #[serde(default)]
    pub low_vram: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessageIn {
    pub role: String, // user | assistant | system
    pub content: String,
    /// Base64 image data (no data-URI prefix) for multimodal models.
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatRequest {
    pub stream_id: String,
    pub provider: String, // "ollama" | "openai"
    pub model: String,
    pub base_url: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessageIn>,
    pub params: GenerationParams,
    /// MCP tools exposed to the model for this turn. Populated server-side
    /// by [`crate::commands::chat_stream`] from the enabled MCP servers;
    /// the frontend never has to construct this list. Empty when no MCP
    /// servers are configured or none are reachable.
    #[serde(default, skip_deserializing)]
    pub tools: Vec<McpToolDef>,
    /// Private Chat marker. When `true`, `chat_stream` skips MCP tool
    /// aggregation entirely so the model can't autonomously fan prompt
    /// content out to a user-configured MCP server. The flag is the sole
    /// gate — `tools` stays `skip_deserializing`, so a compromised renderer
    /// can't smuggle in a tool definition the backend would honour.
    #[serde(default)]
    pub private: bool,
}
