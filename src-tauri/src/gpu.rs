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
    /// Dedicated video memory in bytes. Integrated adapters never reach this
    /// struct — whether they report zero or a multi-gigabyte UMA carve-out,
    /// that memory is system RAM, which the RAM path already covers, so they
    /// are reported as absent rather than as a small GPU.
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

/// Whether an adapter shares memory with the CPU (an APU or integrated GPU).
///
/// `DedicatedVideoMemory` alone can't answer this: an AMD APU reports its BIOS
/// UMA frame-buffer carve-out there, commonly 2–4 GB, which sails past the
/// discrete threshold and made a 32 GB laptop look like a 4 GB graphics card.
/// D3D12's architecture feature is the signal that actually distinguishes them.
/// Unreadable (pre-D3D12 hardware, a driver that won't create a device) counts
/// as discrete, which is the behaviour that shipped before.
#[cfg(windows)]
unsafe fn is_unified_memory(adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> bool {
    use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
    use windows::Win32::Graphics::Direct3D12::{
        D3D12CreateDevice, ID3D12Device, D3D12_FEATURE_ARCHITECTURE,
        D3D12_FEATURE_DATA_ARCHITECTURE,
    };

    let mut device: Option<ID3D12Device> = None;
    if unsafe { D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device) }.is_err() {
        return false;
    }
    let Some(device) = device else {
        return false;
    };
    let mut arch = D3D12_FEATURE_DATA_ARCHITECTURE::default();
    let ok = unsafe {
        device.CheckFeatureSupport(
            D3D12_FEATURE_ARCHITECTURE,
            std::ptr::from_mut(&mut arch).cast(),
            std::mem::size_of::<D3D12_FEATURE_DATA_ARCHITECTURE>() as u32,
        )
    };
    ok.is_ok() && arch.UMA.as_bool()
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
            // Integrated graphics carve their "VRAM" out of system RAM, which
            // the caller already sizes against.
            if is_unified_memory(&adapter) {
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

/// How long to wait for `nvidia-smi`. A wedged NVIDIA driver (a GPU that fell
/// off the bus, a broken WSL passthrough) leaves the tool hung indefinitely,
/// and `Command::output()` would wait with it — taking the whole `system_info`
/// call, and with it onboarding's model recommendation, down with it.
#[cfg(target_os = "linux")]
const NVIDIA_SMI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// `nvidia-smi --query-gpu=memory.total,name` → "8192, NVIDIA GeForce RTX 4060".
/// Memory is reported in MiB.
#[cfg(target_os = "linux")]
fn nvidia_smi() -> Option<GpuInfo> {
    use std::process::Stdio;

    let mut child = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total,name",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Poll rather than block: the output is two short lines, so it can't fill
    // the pipe buffer and stall a process that is otherwise healthy.
    let deadline = std::time::Instant::now() + NVIDIA_SMI_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                tracing::warn!("nvidia-smi did not exit within {NVIDIA_SMI_TIMEOUT:?} — giving up");
                let _ = child.kill();
                let _ = child.wait(); // reap, so we don't leave a zombie
                return None;
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
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
