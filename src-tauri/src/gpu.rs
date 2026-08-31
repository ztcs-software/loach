//! Discrete-GPU detection for the onboarding model recommendation.
//!
//! Sizing a local model against system RAM is wrong for anyone with a discrete
//! GPU: Ollama loads as many layers as fit into VRAM and runs the remainder on
//! the CPU, so a model that "fits in RAM" but overflows an 8 GB card generates
//! at a fraction of the speed. VRAM is the number that decides whether a model
//! is pleasant to use, so we detect it where we can and let the caller size
//! against the constraint that actually binds.
//!
//! Every path here is best-effort and returns `None` rather than failing: a
//! machine we can't read just falls back to the RAM heuristic, which is what
//! shipped before and is still correct for CPU-only and integrated setups.
//!
//! Platform notes:
//!   - **Windows** — DXGI. Vendor-neutral (NVIDIA / AMD / Intel alike) and
//!     needs no external tooling.
//!   - **Linux** — `nvidia-smi` when present, else the amdgpu sysfs node.
//!     Intel Arc is not covered; it reports as unknown and falls back to RAM.
//!   - **macOS** — deliberately unimplemented. Apple Silicon is unified
//!     memory, so system RAM already *is* the GPU's budget and reporting a
//!     separate VRAM figure would double-count it.

/// A discrete GPU worth sizing against.
pub struct GpuInfo {
    /// Dedicated video memory in bytes. Never zero — a zero-VRAM adapter is
    /// integrated graphics carving out system RAM, which is already covered by
    /// the RAM path, so it is reported as absent rather than as a 0 GB GPU.
    pub vram_bytes: u64,
    /// Adapter name for display, e.g. "NVIDIA GeForce RTX 4060".
    pub name: String,
}

/// Smallest dedicated VRAM we'll treat as a real discrete GPU. Below this the
/// adapter is almost certainly integrated (or a virtual display adapter), and
/// sizing against it would recommend absurdly small models to someone whose
/// real budget is system RAM.
const MIN_DISCRETE_VRAM_BYTES: u64 = 1024 * 1024 * 1024;

/// Probe for the most capable discrete GPU, or `None` when there isn't one we
/// can read.
pub fn detect() -> Option<GpuInfo> {
    let found = detect_impl()?;
    if found.vram_bytes < MIN_DISCRETE_VRAM_BYTES {
        return None;
    }
    Some(found)
}

#[cfg(windows)]
fn detect_impl() -> Option<GpuInfo> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    // SAFETY: straight FFI into DXGI. The factory and adapters are COM objects
    // managed by the `windows` crate's RAII wrappers, and `GetDesc1` writes
    // into a fully-owned local struct. Nothing escapes this function but plain
    // copied data.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best: Option<GpuInfo> = None;

        for i in 0.. {
            // Enumeration ends with DXGI_ERROR_NOT_FOUND; any other error is
            // equally a reason to stop walking the list.
            let Ok(adapter) = factory.EnumAdapters1(i) else {
                break;
            };
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            // Skip the Microsoft Basic Render Driver and friends — they report
            // plausible-looking memory that no model will ever run in.
            if DXGI_ADAPTER_FLAG(desc.Flags as i32) == DXGI_ADAPTER_FLAG_SOFTWARE {
                continue;
            }

            let vram_bytes = desc.DedicatedVideoMemory as u64;
            let name = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .trim()
                .to_string();

            // Multi-GPU laptops enumerate both the integrated and the discrete
            // adapter; the largest dedicated pool is the one Ollama will use.
            if best.as_ref().is_none_or(|b| vram_bytes > b.vram_bytes) {
                best = Some(GpuInfo { vram_bytes, name });
            }
        }
        best
    }
}

#[cfg(target_os = "linux")]
fn detect_impl() -> Option<GpuInfo> {
    nvidia_smi().or_else(amdgpu_sysfs)
}

/// `nvidia-smi --query-gpu=memory.total,name` → "8192, NVIDIA GeForce RTX 4060".
/// Memory is reported in MiB.
#[cfg(target_os = "linux")]
fn nvidia_smi() -> Option<GpuInfo> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total,name",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Multiple GPUs print one line each; take the largest.
    text.lines()
        .filter_map(|line| {
            let (mib, name) = line.split_once(',')?;
            let mib: u64 = mib.trim().parse().ok()?;
            Some(GpuInfo {
                vram_bytes: mib * 1024 * 1024,
                name: name.trim().to_string(),
            })
        })
        .max_by_key(|g| g.vram_bytes)
}

/// amdgpu exposes total VRAM in bytes at
/// `/sys/class/drm/card*/device/mem_info_vram_total`.
#[cfg(target_os = "linux")]
fn amdgpu_sysfs() -> Option<GpuInfo> {
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let total = e.path().join("device/mem_info_vram_total");
            let bytes: u64 = std::fs::read_to_string(&total).ok()?.trim().parse().ok()?;
            // No reliable model string here; the vendor name is honest and
            // enough for a "based on N GB VRAM" line.
            Some(GpuInfo {
                vram_bytes: bytes,
                name: "AMD GPU".to_string(),
            })
        })
        .max_by_key(|g| g.vram_bytes)
}

/// macOS: unified memory. See the module docs — reporting VRAM separately here
/// would double-count the RAM the caller already sizes against.
#[cfg(not(any(windows, target_os = "linux")))]
fn detect_impl() -> Option<GpuInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `detect()` is hardware-dependent, so this asserts the invariants rather
    /// than a value: on a machine with no readable GPU it passes trivially, and
    /// on one with a GPU it catches the failure mode that matters — FFI that
    /// "succeeds" while handing back garbage (a zero/absurd VRAM figure, or a
    /// name still carrying its UTF-16 NUL padding).
    #[test]
    fn detected_gpu_is_plausible() {
        let Some(gpu) = detect() else {
            return;
        };
        println!("detected GPU: {} ({} bytes VRAM)", gpu.name, gpu.vram_bytes);

        assert!(
            gpu.vram_bytes >= MIN_DISCRETE_VRAM_BYTES,
            "detect() must filter adapters below the discrete threshold, got {}",
            gpu.vram_bytes
        );
        assert!(
            gpu.vram_bytes < 1024_u64.pow(4),
            "VRAM over 1 TB means the field was misread, got {}",
            gpu.vram_bytes
        );
        assert!(!gpu.name.trim().is_empty(), "adapter name must not be empty");
        assert!(
            !gpu.name.contains('\0'),
            "adapter name must be NUL-trimmed, got {:?}",
            gpu.name
        );
    }
}
