//! D3D11 + DirectComposition per-surface compositor.
//!
//! Owns all D3D / DComp / per-surface state. The platform module keeps only
//! HWND, cached scale, fullscreen bookkeeping, the WndProc hook, and the
//! input thread; it calls into this module via the narrow `jfn_win_*`
//! accessors at the bottom of the file to initialize, tear down, and drive
//! the transition-locked routines.

#![allow(non_snake_case)]

use parking_lot::Mutex;
use std::ffi::{c_int, c_void};

use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_QUERY_DESC,
    D3D11_QUERY_EVENT, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11DeviceContext,
    ID3D11Query, ID3D11Texture2D,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_PRESENT, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
    DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1,
};
use windows_core::Interface;

use jfn_compositor_core::stack::SurfaceStack;
use jfn_compositor_core::transition::{PresentDecision, TransitionGate};
use jfn_platform_abi::JfnRect;

// =====================================================================
// Per-surface state. Stored as `Box<Surface>` and exposed across the C
// ABI as the opaque `*mut c_void` PlatformSurface pointer.
// =====================================================================

pub(crate) struct Surface {
    swap_chain: Option<IDXGISwapChain1>,
    visual: Option<IDCompositionVisual>,
    sw: i32,
    sh: i32,
    visible: bool,
    in_tree: bool,

    popup_visual: Option<IDCompositionVisual>,
    popup_swap_chain: Option<IDXGISwapChain1>,
    popup_sw: i32,
    popup_sh: i32,
    popup_visible: bool,
}

impl Surface {
    fn new() -> Self {
        Self {
            swap_chain: None,
            visual: None,
            sw: 0,
            sh: 0,
            visible: true,
            in_tree: false,
            popup_visual: None,
            popup_swap_chain: None,
            popup_sw: 0,
            popup_sh: 0,
            popup_visible: false,
        }
    }
}

// =====================================================================
// Shared compositor state. Mutex order: any caller that wants to touch
// `State.surfaces` / per-surface visuals must hold STATE.lock(). Equivalent
// of the C++ `g_win.surface_mtx`.
// =====================================================================

struct CompositorDevices {
    d3d_device: ID3D11Device1,
    d3d_context: ID3D11DeviceContext,
    dxgi_factory: IDXGIFactory2,
    dcomp_device: IDCompositionDevice,
    // Held only to keep the composition target (and its bound root) alive for
    // the lifetime of the compositor; never read after construction.
    #[allow(dead_code)]
    dcomp_target: IDCompositionTarget,
    dcomp_root: IDCompositionVisual,
}

// COM interfaces are Send+Sync-by-COM-spec for the apartment we created them
// in (MTA via D3D11CreateDevice). We serialize all access under STATE's
// Mutex so the apartment-confinement isn't violated.
unsafe impl Send for CompositorDevices {}
unsafe impl Send for Surface {}

struct State {
    devices: Option<CompositorDevices>,
    // mpv's HWND, retained so a lost D3D device can be torn down and
    // recreated in place (`recover_from_device_loss`) without needing the
    // caller to re-run `jfn_win_init_compositor`.
    hwnd: HWND,
    // Surface registry (live + stack order + main) shared with macOS via
    // jfn-compositor-core.
    surfaces: SurfaceStack<*mut Surface>,
    // Fullscreen/resize transition gate (was G_TRANSITIONING + expected_w/h +
    // transition_pw/ph), kept inside this single STATE lock.
    gate: TransitionGate,
    mpv_pw: i32,
    mpv_ph: i32,
    pending_lw: i32,
    pending_lh: i32,
}

unsafe impl Send for State {}

static STATE: Mutex<State> = Mutex::new(State {
    devices: None,
    hwnd: HWND(std::ptr::null_mut()),
    surfaces: SurfaceStack::new(),
    gate: TransitionGate::new(),
    mpv_pw: 0,
    mpv_ph: 0,
    pending_lw: 0,
    pending_lh: 0,
});

/// Max time to wait for `STATE` before giving up and logging. A real
/// deadlock elsewhere can't be fixed by waiting longer, but an unbounded
/// `.lock()` turns that deadlock into a silent, unrecoverable native-thread
/// hang with zero diagnostic trace — which is exactly what the 2026-07-10
/// and 2026-07-12 TV freezes looked like (GPU device stayed alive, CEF's
/// JS/websocket thread stayed alive, but native paint/restack calls and even
/// `jfn_win_cleanup_compositor` during shutdown went completely silent with
/// no error ever logged). A timed lock turns that into a bounded wait plus a
/// log line naming the stuck call site, and keeps a wedged `STATE` from
/// blocking `shutdown_runtime` forever. See memory
/// `project-jellyfin-windows-tv-hotplug`.
const STATE_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

fn lock_state(caller: &str) -> Option<parking_lot::MutexGuard<'static, State>> {
    match STATE.try_lock_for(STATE_LOCK_TIMEOUT) {
        Some(guard) => Some(guard),
        None => {
            tracing::error!(
                target: "platform",
                "STATE lock timed out after {STATE_LOCK_TIMEOUT:?} in {caller} — \
                 compositor is likely deadlocked; skipping this call"
            );
            None
        }
    }
}

/// Whether the main surface is currently gated. Takes the STATE lock, so
/// callers must not already hold it (none do).
pub(crate) fn gate_in_transition() -> bool {
    match lock_state("gate_in_transition") {
        Some(st) => st.gate.in_transition(),
        None => false,
    }
}

// =====================================================================
// Compositor init/cleanup — called from win_init/win_cleanup (C++).
// =====================================================================

/// Build D3D11 + DXGI + DComp devices and the root visual. Returns false
/// on failure with the partial state torn down.
pub fn jfn_win_init_compositor(hwnd: *mut c_void) -> bool {
    let hwnd = HWND(hwnd);
    let mut st = STATE.lock();
    if st.devices.is_some() {
        return true;
    }
    st.hwnd = hwnd;
    match init_devices(hwnd) {
        Ok(d) => {
            st.devices = Some(d);
            true
        }
        Err(e) => {
            tracing::error!(target: "platform", "compositor init failed: {e:?}");
            false
        }
    }
}

fn init_devices(hwnd: HWND) -> windows_core::Result<CompositorDevices> {
    unsafe {
        // D3D11 device + immediate context.
        let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
        let mut base_device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None::<&windows::Win32::Graphics::Dxgi::IDXGIAdapter>,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE(std::ptr::null_mut()),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut base_device),
            None,
            Some(&mut context),
        )?;
        let base_device = base_device.ok_or(windows_core::Error::from_thread())?;
        let context = context.ok_or(windows_core::Error::from_thread())?;
        let d3d_device: ID3D11Device1 = base_device.cast()?;

        // DXGI factory via the device's adapter.
        let dxgi_device: IDXGIDevice = d3d_device.cast()?;
        let adapter: IDXGIAdapter = dxgi_device.GetAdapter()?;
        let dxgi_factory: IDXGIFactory2 = adapter.GetParent()?;

        // DComp device on the DXGI device.
        let dcomp_device: IDCompositionDevice = DCompositionCreateDevice(&dxgi_device)?;
        let dcomp_target = dcomp_device.CreateTargetForHwnd(hwnd, false)?;
        let dcomp_root = dcomp_device.CreateVisual()?;
        dcomp_target.SetRoot(&dcomp_root)?;
        dcomp_device.Commit()?;

        Ok(CompositorDevices {
            d3d_device,
            d3d_context: context,
            dxgi_factory,
            dcomp_device,
            dcomp_target,
            dcomp_root,
        })
    }
}

/// Release all surfaces + devices. Called from win_cleanup (C++) after the
/// WndProc hook is unhooked and the input thread is joined.
pub fn jfn_win_cleanup_compositor() {
    // Bounded: a wedged STATE must not block shutdown_runtime forever.
    let Some(mut st) = lock_state("jfn_win_cleanup_compositor") else {
        return;
    };
    // Free any remaining surfaces. Browsers should normally free them
    // first, but be defensive.
    let live: Vec<*mut Surface> = st.surfaces.take_live();
    for ptr in live {
        if !ptr.is_null() {
            // SAFETY: we own these pointers via Box::into_raw.
            unsafe {
                let mut s = Box::from_raw(ptr);
                detach_surface(&mut s, st.devices.as_ref());
                drop(s);
            }
        }
    }
    st.devices = None;
}

fn detach_surface(s: &mut Surface, devices: Option<&CompositorDevices>) {
    unsafe {
        if let Some(pv) = s.popup_visual.as_ref() {
            if let Some(v) = s.visual.as_ref() {
                let _ = v.RemoveVisual(pv);
            }
            let _ = pv.SetContent(None::<&windows_core::IUnknown>);
        }
        s.popup_visual = None;
        s.popup_swap_chain = None;
        if let Some(v) = s.visual.as_ref() {
            if s.in_tree
                && let Some(d) = devices
            {
                let _ = d.dcomp_root.RemoveVisual(v);
            }
            let _ = v.SetContent(None::<&windows_core::IUnknown>);
        }
        s.visual = None;
        s.swap_chain = None;
    }
}

/// Rebuilds every D3D11/DComp device and re-creates all existing surfaces'
/// visuals in place after the GPU adapter was lost/reset (e.g. an HDMI
/// hotplug causing `DXGI_ERROR_DEVICE_REMOVED`). Without this, every
/// surface silently stopped presenting for the rest of the session once the
/// original device died — the overlay would freeze on its last good frame
/// even though CEF kept rendering normally underneath. Triggered directly
/// from the Present-failure path once `device_removed` confirms an actual
/// device loss; never polled. Surface pointer identity is preserved (the
/// CEF layer holds onto it across recovery) — only the visual/swap-chain
/// internals are torn down and rebuilt. See memory
/// `project-jellyfin-windows-tv-hotplug`.
fn recover_from_device_loss(st: &mut State) {
    if st.hwnd.is_invalid() {
        return;
    }
    tracing::warn!(target: "platform", "recovering compositor from GPU device loss");

    // Best-effort detach against the dying device — these COM calls may
    // themselves fail since the device is already gone, which is fine.
    let live: Vec<*mut Surface> = st.surfaces.live().to_vec();
    for ptr in &live {
        if ptr.is_null() {
            continue;
        }
        unsafe {
            detach_surface(&mut **ptr, st.devices.as_ref());
        }
    }
    let prev_stack: Vec<*mut Surface> = st.surfaces.stack().to_vec();

    st.devices = None;
    let devices = match init_devices(st.hwnd) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(target: "platform", "device-loss recovery: init_devices failed: {e:?}");
            return;
        }
    };

    // Re-create each live surface's visual(s) against the new dcomp device.
    // Swap chains rebuild lazily via `ensure_swap_chain` on next present.
    for ptr in &live {
        if ptr.is_null() {
            continue;
        }
        unsafe {
            let s = &mut **ptr;
            let visual = match devices.dcomp_device.CreateVisual() {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(target: "platform", "device-loss recovery: CreateVisual failed: {e:?}");
                    continue;
                }
            };
            let popup = devices.dcomp_device.CreateVisual().ok();
            if let Some(pv) = popup.as_ref() {
                let _ = visual.AddVisual(pv, true, None::<&IDCompositionVisual>);
            }
            s.visual = Some(visual);
            s.popup_visual = popup;
            s.swap_chain = None;
            s.sw = 0;
            s.sh = 0;
            s.popup_swap_chain = None;
            s.popup_sw = 0;
            s.popup_sh = 0;
            s.in_tree = false;
        }
    }

    // Re-stack in the pre-recovery order (mirrors `win_restack`).
    st.surfaces.clear_stack();
    let mut prev_visual: Option<IDCompositionVisual> = None;
    for ptr in &prev_stack {
        if ptr.is_null() {
            continue;
        }
        unsafe {
            let s = &mut **ptr;
            let Some(visual) = s.visual.as_ref() else {
                continue;
            };
            let hr = if let Some(prev) = prev_visual.as_ref() {
                devices.dcomp_root.AddVisual(visual, true, prev)
            } else {
                devices.dcomp_root.AddVisual(visual, false, None::<&IDCompositionVisual>)
            };
            if let Err(e) = hr {
                tracing::error!(target: "platform", "device-loss recovery: restack AddVisual failed: {e:?}");
                continue;
            }
            s.in_tree = true;
            st.surfaces.push_stack(*ptr);
            prev_visual = Some(visual.clone());
        }
    }
    st.surfaces.set_main_to_stack_first();
    unsafe {
        let _ = devices.dcomp_device.Commit();
    }
    st.devices = Some(devices);
    tracing::info!(target: "platform", "compositor recovered from device loss");
}

/// Retries device-loss recovery if a previous attempt left `st.devices`
/// empty. Without this, one failed `init_devices` inside
/// `recover_from_device_loss` left the compositor permanently blind — every
/// later paint call saw `devices == None` and just bailed out, with no
/// further retry ever attempted. Cheap no-op once devices are present again;
/// deliberately retries on every call while down rather than backing off,
/// since device loss is rare and "stuck forever" was the worse failure mode.
fn retry_recovery_if_needed(st: &mut State) {
    if st.devices.is_none() {
        recover_from_device_loss(st);
    }
}

// =====================================================================
// Swap-chain helpers (locked).
// =====================================================================

fn create_swap_chain(
    devices: &CompositorDevices,
    width: i32,
    height: i32,
) -> Option<IDXGISwapChain1> {
    if width <= 0 || height <= 0 {
        return None;
    }
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width as u32,
        Height: height as u32,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        ..Default::default()
    };
    unsafe {
        match devices.dxgi_factory.CreateSwapChainForComposition(
            &devices.d3d_device,
            &desc,
            None::<&windows::Win32::Graphics::Dxgi::IDXGIOutput>,
        ) {
            Ok(sc) => Some(sc),
            Err(e) => {
                tracing::error!(target: "platform", "CreateSwapChainForComposition failed: {e:?}");
                None
            }
        }
    }
}

/// Ensure `sc` is sized (w,h); resize in place if possible, otherwise
/// recreate and rebind to `visual`. Updates `sw`/`sh` on success. Returns
/// `true` if a `ResizeBuffers` failure was confirmed to be a device
/// removal/reset, so the caller (which holds `&mut State`) can run
/// `recover_from_device_loss` — this function only has `&CompositorDevices`
/// and previously discarded that result, so a device-removed swap-chain
/// resize never triggered recovery when the subsequent recreate happened to
/// succeed against the same (dead) device.
fn ensure_swap_chain(
    devices: &CompositorDevices,
    sc: &mut Option<IDXGISwapChain1>,
    sw: &mut i32,
    sh: &mut i32,
    visual: &IDCompositionVisual,
    w: i32,
    h: i32,
) -> bool {
    if w <= 0 || h <= 0 {
        return false;
    }
    if let Some(existing) = sc.as_ref() {
        if *sw == w && *sh == h {
            return false;
        }
        let resize = unsafe {
            existing.ResizeBuffers(
                2,
                w as u32,
                h as u32,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_SWAP_CHAIN_FLAG(0),
            )
        };
        let mut device_lost = false;
        if let Err(e) = &resize {
            tracing::warn!(target: "platform", "ResizeBuffers failed, recreating swap chain: {e:?}");
            device_lost = device_removed(&devices.d3d_device);
        }
        if resize.is_ok() {
            *sw = w;
            *sh = h;
            return false;
        }
        unsafe {
            let _ = visual.SetContent(None::<&windows_core::IUnknown>);
        }
        *sc = None;
        if device_lost {
            return true;
        }
    }

    if let Some(new_sc) = create_swap_chain(devices, w, h) {
        unsafe {
            let _ = visual.SetContent(&new_sc);
        }
        *sc = Some(new_sc);
        *sw = w;
        *sh = h;
    }
    false
}

/// Logs whether the D3D device has been removed/reset and, if so, the
/// reason HRESULT, returning `true` if it has. `GetDeviceRemovedReason`
/// returns `Ok(())` while the device is alive, so this is only informative
/// when called right after a Present/GetBuffer failure. See memory
/// `project-jellyfin-windows-tv-hotplug`.
fn device_removed(device: &ID3D11Device1) -> bool {
    unsafe {
        if let Err(e) = device.GetDeviceRemovedReason() {
            tracing::error!(target: "platform", "device removed/reset, reason: {e:?}");
            true
        } else {
            false
        }
    }
}

/// Diagnostic-only probe: checks and logs the D3D device's removed/reset
/// status right now, independent of any Present/GetBuffer failure. Unlike
/// `device_removed`, this logs the not-removed case too, so it's useful
/// called proactively (e.g. right on a WM_DISPLAYCHANGE hotplug event) to
/// see device state at the moment of the event rather than only finding out
/// reactively if/when a subsequent Present happens to fail. Does not trigger
/// recovery itself — `present_to_swap_chain`'s own check still owns that.
pub fn win_probe_device_removed_diagnostic() {
    let Some(st) = lock_state("win_probe_device_removed_diagnostic") else {
        return;
    };
    match st.devices.as_ref() {
        Some(devices) => unsafe {
            match devices.d3d_device.GetDeviceRemovedReason() {
                Ok(()) => {
                    tracing::info!(target: "platform", "device-removed probe: device alive");
                }
                Err(e) => {
                    tracing::warn!(target: "platform", "device-removed probe: device removed/reset, reason: {e:?}");
                }
            }
        },
        None => {
            tracing::info!(target: "platform", "device-removed probe: no devices (compositor not initialized)");
        }
    }
}

/// Outcome of a single swap-chain present attempt.
enum PresentOutcome {
    Ok,
    /// `Present`/`GetBuffer` failed but the device is still alive. Distinct
    /// from `DeviceLost` because the old code collapsed this case into
    /// "not lost" and callers then unconditionally reported success to CEF,
    /// leaving a stale swap-chain/visual in service with no recovery and no
    /// retry.
    Failed,
    /// The D3D device was confirmed removed/reset; caller should run
    /// `recover_from_device_loss`.
    DeviceLost,
}

/// Diagnostic-only: tracks accelerated-paint frames and the distinct CEF
/// shared-texture handles seen, to correlate against the growing "Section"
/// handle count Process Explorer showed during the 2026-07-16/17 overnight
/// GPU shared-memory leak (see memory `project-jellyfin-windows-tv-hotplug`
/// and `project-startup-window-mode`). If CEF is actually pooling/reusing a
/// small rotating set of handles, `distinct_count` should plateau; if it
/// climbs 1:1 with `frame_count`, CEF is never recycling and the leak is
/// upstream of our code. Remove once the leak investigation concludes.
struct AccelPaintDiag {
    frame_count: u64,
    distinct_count: u64,
    recent_handles: Vec<isize>,
}

static ACCEL_PAINT_DIAG: Mutex<AccelPaintDiag> = Mutex::new(AccelPaintDiag {
    frame_count: 0,
    distinct_count: 0,
    recent_handles: Vec::new(),
});

fn log_accel_paint_diag(tag: &str, handle: *mut c_void, w: i32, h: i32) {
    let mut d = ACCEL_PAINT_DIAG.lock();
    d.frame_count += 1;
    let hv = handle as isize;
    let is_new = !d.recent_handles.contains(&hv);
    if is_new {
        d.distinct_count += 1;
        d.recent_handles.push(hv);
        if d.recent_handles.len() > 8 {
            d.recent_handles.remove(0);
        }
    }
    if is_new || d.frame_count % 200 == 0 {
        tracing::info!(
            target: "platform",
            "accel-paint diag[{tag}]: frame={} distinct_handles_seen={} new_handle={} handle={:?} {w}x{h}",
            d.frame_count, d.distinct_count, is_new, handle
        );
    }
}

/// Diagnostic-only: blocks until the GPU has actually finished the work
/// enqueued so far on this context (i.e. the preceding `CopyResource`),
/// rather than just submitting it. CEF's docs say the shared-texture
/// resource is "released to the underlying pool for reuse when the callback
/// returns from client code" — `CopyResource` only enqueues a copy, it
/// doesn't wait for it, so previously we could return from
/// `OnAcceleratedPaint` before our read of the CEF-owned texture had
/// actually completed on the GPU. This tests whether that gap is why CEF's
/// pool isn't recycling handles. Bounded to 200ms so a real GPU hang doesn't
/// turn into an unbounded stall on top of the existing STATE lock timeout.
fn wait_for_copy_completion(devices: &CompositorDevices) {
    unsafe {
        let desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut query: Option<ID3D11Query> = None;
        if let Err(e) = devices.d3d_device.CreateQuery(&desc, Some(&mut query)) {
            tracing::warn!(target: "platform", "diagnostic: CreateQuery failed: {e:?}");
            return;
        }
        let Some(query) = query else {
            return;
        };
        devices.d3d_context.End(&query);
        let start = std::time::Instant::now();
        loop {
            let mut done: i32 = 0;
            let _ = devices.d3d_context.GetData(
                &query,
                Some(&mut done as *mut i32 as *mut c_void),
                std::mem::size_of::<i32>() as u32,
                0,
            );
            if done != 0 {
                break;
            }
            if start.elapsed() > std::time::Duration::from_millis(200) {
                tracing::warn!(target: "platform", "diagnostic: copy-completion query timed out after 200ms");
                break;
            }
            std::thread::yield_now();
        }
        let waited = start.elapsed();
        if waited > std::time::Duration::from_millis(1) {
            tracing::info!(target: "platform", "diagnostic: copy completion took {waited:?}");
        }
    }
}

fn present_to_swap_chain(
    devices: &CompositorDevices,
    sc: &IDXGISwapChain1,
    src: &ID3D11Texture2D,
) -> PresentOutcome {
    unsafe {
        match sc.GetBuffer::<ID3D11Texture2D>(0) {
            Ok(bb) => {
                devices.d3d_context.CopyResource(&bb, src);
                wait_for_copy_completion(devices);
                let present_hr = sc.Present(0, DXGI_PRESENT(0));
                let mut outcome = PresentOutcome::Ok;
                if present_hr.is_err() {
                    tracing::error!(target: "platform", "swap-chain Present failed: {present_hr:?}");
                    outcome = if device_removed(&devices.d3d_device) {
                        PresentOutcome::DeviceLost
                    } else {
                        PresentOutcome::Failed
                    };
                }
                if let Err(e) = devices.dcomp_device.Commit() {
                    tracing::error!(target: "platform", "dcomp Commit failed after present: {e:?}");
                }
                outcome
            }
            Err(e) => {
                tracing::error!(target: "platform", "GetBuffer failed: {e:?}");
                if device_removed(&devices.d3d_device) {
                    PresentOutcome::DeviceLost
                } else {
                    PresentOutcome::Failed
                }
            }
        }
    }
}

// =====================================================================
// Surface lifecycle + stacking.
// =====================================================================

pub fn win_alloc_surface() -> *mut c_void {
    let Some(mut st) = lock_state("win_alloc_surface") else {
        return std::ptr::null_mut();
    };
    let Some(devices) = st.devices.as_ref() else {
        return std::ptr::null_mut();
    };

    let mut s = Box::new(Surface::new());
    {
        unsafe {
            let visual = match devices.dcomp_device.CreateVisual() {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(target: "platform", "CreateVisual failed: {e:?}");
                    return std::ptr::null_mut();
                }
            };

            let popup = devices.dcomp_device.CreateVisual().ok();
            if let Some(pv) = popup.as_ref() {
                let _ = visual.AddVisual(pv, true, None::<&IDCompositionVisual>);
            } else {
                tracing::error!(target: "platform", "CreateVisual(popup) failed");
            }

            match devices
                .dcomp_root
                .AddVisual(&visual, true, None::<&IDCompositionVisual>)
            {
                Ok(()) => s.in_tree = true,
                Err(e) => tracing::error!(target: "platform", "AddVisual failed: {e:?}"),
            }

            s.visual = Some(visual);
            s.popup_visual = popup;

            let _ = devices.dcomp_device.Commit();
        }
    }

    let ptr = Box::into_raw(s);
    st.surfaces.add_live(ptr);
    ptr as *mut c_void
}

pub fn win_free_surface(s: *mut c_void) {
    if s.is_null() {
        return;
    }
    let p = s as *mut Surface;

    let Some(mut st) = lock_state("win_free_surface") else {
        return;
    };
    st.surfaces.remove(p);

    let devices = st.devices.as_ref();
    unsafe {
        let mut s_box = Box::from_raw(p);
        detach_surface(&mut s_box, devices);
        if let Some(d) = devices {
            let _ = d.dcomp_device.Commit();
        }
        drop(s_box);
    }
}

/// Rebuild the child-list under `dcomp_root` in `ordered` order
/// (bottom -> top). Popup visuals stay nested under their owning surface,
/// so they're not in this list.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn win_restack(ordered: *const *mut c_void, n: usize) {
    let Some(mut st) = lock_state("win_restack") else {
        return;
    };
    let Some(dcomp_root) = st.devices.as_ref().map(|d| d.dcomp_root.clone()) else {
        return;
    };

    // Snapshot live pointers so we can detach without holding a borrow of
    // `st` while we mutate per-surface state.
    let live_ptrs: Vec<*mut Surface> = st.surfaces.live().to_vec();
    {
        unsafe {
            for ptr in &live_ptrs {
                if ptr.is_null() {
                    continue;
                }
                let s = &mut **ptr;
                if let Some(v) = s.visual.as_ref()
                    && s.in_tree
                {
                    let _ = dcomp_root.RemoveVisual(v);
                    s.in_tree = false;
                }
            }
        }
    }

    st.surfaces.clear_stack();
    let mut prev_visual: Option<IDCompositionVisual> = None;
    {
        unsafe {
            for i in 0..n {
                let ptr = *ordered.add(i) as *mut Surface;
                if ptr.is_null() {
                    continue;
                }
                let s = &mut *ptr;
                let visual = match s.visual.as_ref() {
                    Some(v) => v.clone(),
                    None => continue,
                };
                let hr = if let Some(prev) = prev_visual.as_ref() {
                    dcomp_root.AddVisual(&visual, true, prev)
                } else {
                    dcomp_root.AddVisual(&visual, false, None::<&IDCompositionVisual>)
                };
                if let Err(e) = hr {
                    tracing::error!(target: "platform", "restack AddVisual failed: {e:?}");
                    continue;
                }
                s.in_tree = true;
                st.surfaces.push_stack(ptr);
                prev_visual = Some(visual);
            }
        }
    }
    st.surfaces.set_main_to_stack_first();
    if let Some(d) = st.devices.as_ref() {
        unsafe {
            let _ = d.dcomp_device.Commit();
        }
    }
}

// =====================================================================
// Per-frame presentation.
// =====================================================================

pub fn win_surface_present(s: *mut c_void, raw_info: *const c_void) -> bool {
    if s.is_null() || raw_info.is_null() {
        return false;
    }
    let info = unsafe { &*(raw_info as *const cef::sys::_cef_accelerated_paint_info_t) };
    let handle = info.shared_texture_handle;
    if handle.is_null() {
        return false;
    }

    let Some(mut st) = lock_state("win_surface_present") else {
        return false;
    };
    retry_recovery_if_needed(&mut st);
    let Some(d3d_device) = st.devices.as_ref().map(|d| d.d3d_device.clone()) else {
        return false;
    };
    let src: ID3D11Texture2D = unsafe {
        match d3d_device.OpenSharedResource1::<ID3D11Texture2D>(HANDLE(handle)) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(target: "platform", "OpenSharedResource1 failed: {e:?}");
                return false;
            }
        }
    };

    let mut td = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        src.GetDesc(&mut td);
    }
    let w = td.Width as i32;
    let h = td.Height as i32;

    let p = s as *mut Surface;
    let is_main = st.surfaces.is_main(p);

    // Transition logic applies only to the bottom-most ("main") surface.
    if is_main {
        match st.gate.main_present_decision((w, h)) {
            PresentDecision::Reject => return false,
            PresentDecision::EndTransitionThenPresent => {
                // The gate cleared the transition flags; clear the
                // (write-only) pending logical size too, matching the rest
                // of end_transition_locked.
                st.pending_lw = 0;
                st.pending_lh = 0;
            }
            PresentDecision::Present => {}
        }
    }

    if is_main && st.mpv_pw > 0 && (w > st.mpv_pw + 2 || h > st.mpv_ph + 2) {
        return false;
    }

    let surf = unsafe { &mut *p };
    if !surf.visible {
        return false;
    }
    let visual = match surf.visual.as_ref() {
        Some(v) => v.clone(),
        None => return false,
    };

    let Some(devices) = st.devices.as_ref() else {
        return false;
    };
    let resize_lost = ensure_swap_chain(
        devices,
        &mut surf.swap_chain,
        &mut surf.sw,
        &mut surf.sh,
        &visual,
        w,
        h,
    );
    let sc = match surf.swap_chain.as_ref() {
        Some(sc) => sc.clone(),
        None => {
            if resize_lost {
                recover_from_device_loss(&mut st);
            }
            return false;
        }
    };
    log_accel_paint_diag("main", handle, w, h);
    match present_to_swap_chain(devices, &sc, &src) {
        PresentOutcome::DeviceLost => {
            recover_from_device_loss(&mut st);
            true
        }
        PresentOutcome::Ok => true,
        PresentOutcome::Failed => false,
    }
}

pub fn win_surface_present_software(
    s: *mut c_void,
    _dirty: *const JfnRect,
    _dirty_len: usize,
    buffer: *const c_void,
    w: c_int,
    h: c_int,
) -> bool {
    if s.is_null() || buffer.is_null() || w <= 0 || h <= 0 {
        return false;
    }

    let Some(mut st) = lock_state("win_surface_present_software") else {
        return false;
    };
    retry_recovery_if_needed(&mut st);
    let p = s as *mut Surface;
    if st.surfaces.is_main(p) {
        match st.gate.main_present_decision((w, h)) {
            PresentDecision::Reject => return false,
            PresentDecision::EndTransitionThenPresent | PresentDecision::Present => {}
        }
    }
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return false,
    };

    let desc = D3D11_TEXTURE2D_DESC {
        Width: w as u32,
        Height: h as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: buffer,
        SysMemPitch: w as u32 * 4,
        SysMemSlicePitch: 0,
    };
    let mut src: Option<ID3D11Texture2D> = None;
    unsafe {
        if devices
            .d3d_device
            .CreateTexture2D(&desc, Some(&init), Some(&mut src))
            .is_err()
        {
            return false;
        }
    }
    let src = match src {
        Some(t) => t,
        None => return false,
    };

    let surf = unsafe { &mut *p };
    if !surf.visible {
        return false;
    }
    let visual = match surf.visual.as_ref() {
        Some(v) => v.clone(),
        None => return false,
    };
    let resize_lost = ensure_swap_chain(
        devices,
        &mut surf.swap_chain,
        &mut surf.sw,
        &mut surf.sh,
        &visual,
        w,
        h,
    );
    let sc = match surf.swap_chain.as_ref() {
        Some(sc) => sc.clone(),
        None => {
            if resize_lost {
                recover_from_device_loss(&mut st);
            }
            return false;
        }
    };
    match present_to_swap_chain(devices, &sc, &src) {
        PresentOutcome::DeviceLost => {
            recover_from_device_loss(&mut st);
            true
        }
        PresentOutcome::Ok => true,
        PresentOutcome::Failed => false,
    }
}

pub fn win_surface_resize(s: *mut c_void, _lw: c_int, _lh: c_int, pw: c_int, ph: c_int) {
    if s.is_null() || pw <= 0 || ph <= 0 {
        return;
    }
    let Some(mut st) = lock_state("win_surface_resize") else {
        return;
    };
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return,
    };
    let surf = unsafe { &mut *(s as *mut Surface) };
    // Only adjust the swap chain if it already exists — matches the prior
    // overlay/about semantics that avoid forcing a stale physical size
    // between a window resize and the next CEF paint. (ensure_swap_chain
    // rebinds at present time.)
    if surf.swap_chain.is_none() {
        return;
    }
    let visual = match surf.visual.as_ref() {
        Some(v) => v.clone(),
        None => return,
    };
    let resize_lost = ensure_swap_chain(
        devices,
        &mut surf.swap_chain,
        &mut surf.sw,
        &mut surf.sh,
        &visual,
        pw,
        ph,
    );
    unsafe {
        let _ = devices.dcomp_device.Commit();
    }
    if resize_lost {
        recover_from_device_loss(&mut st);
    }
}

pub fn win_surface_set_visible(s: *mut c_void, visible: bool) {
    if s.is_null() {
        return;
    }
    let Some(st) = lock_state("win_surface_set_visible") else {
        return;
    };
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return,
    };
    let surf = unsafe { &mut *(s as *mut Surface) };
    if surf.visible == visible {
        return;
    }
    surf.visible = visible;
    let visual = match surf.visual.as_ref() {
        Some(v) => v.clone(),
        None => return,
    };
    if !visible {
        // Detach content and drop the swap chain so we don't display a
        // stale frame when the surface is shown again at a different size.
        unsafe {
            let _ = visual.SetContent(None::<&windows_core::IUnknown>);
        }
        surf.swap_chain = None;
        surf.sw = 0;
        surf.sh = 0;
    }
    // visible=true: content rebinds on next ensure_swap_chain via present.
    unsafe {
        let _ = devices.dcomp_device.Commit();
    }
}

// =====================================================================
// Transition state.
// =====================================================================

fn begin_transition_locked(st: &mut State) {
    if !st.gate.begin_capturing_if_idle((st.mpv_pw, st.mpv_ph)) {
        return;
    }
    st.pending_lw = 0;
    st.pending_lh = 0;

    // Detach main surface's content to avoid stale frames while resizing.
    let Some(p) = st.surfaces.main() else {
        return;
    };
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return,
    };
    unsafe {
        let s = &mut *p;
        if let Some(v) = s.visual.as_ref() {
            let _ = v.SetContent(None::<&windows_core::IUnknown>);
        }
        s.swap_chain = None;
        s.sw = 0;
        s.sh = 0;
        let _ = devices.dcomp_device.Commit();
    }
}

fn end_transition_locked(st: &mut State) {
    st.gate.end();
    st.pending_lw = 0;
    st.pending_lh = 0;
}

/// Called by `win_begin_transition` (in lib.rs) — replaces the old
/// `win_begin_transition_impl` C++ helper. Takes STATE lock then runs
/// the locked routine.
pub fn jfn_win_begin_transition_locked() {
    let Some(mut st) = lock_state("jfn_win_begin_transition_locked") else {
        return;
    };
    begin_transition_locked(&mut st);
}

pub fn win_end_transition() {
    let Some(mut st) = lock_state("win_end_transition") else {
        return;
    };
    end_transition_locked(&mut st);
}

pub fn win_set_expected_size(w: c_int, h: c_int) {
    if let Some(mut st) = lock_state("win_set_expected_size") {
        st.gate.set_expected((w, h));
    }
}

// =====================================================================
// Accessors used by C++ WndProc / fullscreen helpers.
// =====================================================================

/// Called from the WndProc on WM_SIZE: stores mpv's current physical size
/// (used by oversized-buffer rejection), records the logical size while a
/// transition is in progress, and ends that transition once the window has
/// settled at its new size. `force_end` ends it even if the physical size is
/// unchanged (a fullscreen-style edge that didn't alter the client size).
pub fn jfn_win_update_surface_size(lw: c_int, lh: c_int, pw: c_int, ph: c_int, force_end: bool) {
    let Some(mut st) = lock_state("jfn_win_update_surface_size") else {
        return;
    };
    if st.gate.in_transition() {
        st.pending_lw = lw;
        st.pending_lh = lh;
        if st.gate.note_window_size((pw, ph), force_end) {
            st.pending_lw = 0;
            st.pending_lh = 0;
        }
    }
    st.mpv_pw = pw;
    st.mpv_ph = ph;
}

/// Called from C++ WndProc on WM_SIZE to run begin_transition under the
/// state lock (matches the old win_begin_transition_locked behavior).
pub fn jfn_win_wndproc_begin_transition_locked() {
    let Some(mut st) = lock_state("jfn_win_wndproc_begin_transition_locked") else {
        return;
    };
    begin_transition_locked(&mut st);
}

pub fn jfn_win_wndproc_end_transition_locked() {
    let Some(mut st) = lock_state("jfn_win_wndproc_end_transition_locked") else {
        return;
    };
    end_transition_locked(&mut st);
}

// =====================================================================
// Popup helpers.
// =====================================================================

pub fn win_popup_show(s: *mut c_void, x: c_int, y: c_int) {
    if s.is_null() {
        return;
    }
    let Some(_st) = lock_state("win_popup_show") else {
        return;
    };
    let surf = unsafe { &mut *(s as *mut Surface) };
    surf.popup_visible = true;
    if let Some(pv) = surf.popup_visual.as_ref() {
        let scale = crate::platform::win_get_scale();
        unsafe {
            let _ = pv.SetOffsetX2(x as f32 * scale);
            let _ = pv.SetOffsetY2(y as f32 * scale);
        }
    }
}

pub fn win_popup_hide(s: *mut c_void) {
    if s.is_null() {
        return;
    }
    let Some(st) = lock_state("win_popup_hide") else {
        return;
    };
    let surf = unsafe { &mut *(s as *mut Surface) };
    surf.popup_visible = false;
    let pv = match surf.popup_visual.as_ref() {
        Some(v) => v.clone(),
        None => return,
    };
    unsafe {
        let _ = pv.SetContent(None::<&windows_core::IUnknown>);
    }
    surf.popup_swap_chain = None;
    surf.popup_sw = 0;
    surf.popup_sh = 0;
    if let Some(d) = st.devices.as_ref() {
        unsafe {
            let _ = d.dcomp_device.Commit();
        }
    }
}

pub fn win_popup_present(s: *mut c_void, raw_info: *const c_void, _lw: c_int, _lh: c_int) {
    if s.is_null() || raw_info.is_null() {
        return;
    }
    let info = unsafe { &*(raw_info as *const cef::sys::_cef_accelerated_paint_info_t) };
    let handle = info.shared_texture_handle;
    if handle.is_null() {
        return;
    }
    let Some(mut st) = lock_state("win_popup_present") else {
        return;
    };
    retry_recovery_if_needed(&mut st);
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return,
    };
    let src: ID3D11Texture2D = unsafe {
        match devices
            .d3d_device
            .OpenSharedResource1::<ID3D11Texture2D>(HANDLE(handle))
        {
            Ok(t) => t,
            Err(_) => return,
        }
    };
    let mut td = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        src.GetDesc(&mut td);
    }
    let w = td.Width as i32;
    let h = td.Height as i32;

    let surf = unsafe { &mut *(s as *mut Surface) };
    if !surf.popup_visible {
        return;
    }
    let pv = match surf.popup_visual.as_ref() {
        Some(v) => v.clone(),
        None => return,
    };
    let resize_lost = ensure_swap_chain(
        devices,
        &mut surf.popup_swap_chain,
        &mut surf.popup_sw,
        &mut surf.popup_sh,
        &pv,
        w,
        h,
    );
    let sc = match surf.popup_swap_chain.as_ref() {
        Some(sc) => sc.clone(),
        None => {
            if resize_lost {
                recover_from_device_loss(&mut st);
            }
            return;
        }
    };
    log_accel_paint_diag("popup", handle, w, h);
    if let PresentOutcome::DeviceLost = present_to_swap_chain(devices, &sc, &src) {
        recover_from_device_loss(&mut st);
    }
}

pub fn win_popup_present_software(
    s: *mut c_void,
    buffer: *const c_void,
    pw: c_int,
    ph: c_int,
    _lw: c_int,
    _lh: c_int,
) {
    if s.is_null() || buffer.is_null() || pw <= 0 || ph <= 0 {
        return;
    }
    let Some(mut st) = lock_state("win_popup_present_software") else {
        return;
    };
    retry_recovery_if_needed(&mut st);
    let devices = match st.devices.as_ref() {
        Some(d) => d,
        None => return,
    };
    let surf = unsafe { &mut *(s as *mut Surface) };
    if !surf.popup_visible {
        return;
    }
    let pv = match surf.popup_visual.as_ref() {
        Some(v) => v.clone(),
        None => return,
    };

    let desc = D3D11_TEXTURE2D_DESC {
        Width: pw as u32,
        Height: ph as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: buffer,
        SysMemPitch: pw as u32 * 4,
        SysMemSlicePitch: 0,
    };
    let mut src: Option<ID3D11Texture2D> = None;
    unsafe {
        if devices
            .d3d_device
            .CreateTexture2D(&desc, Some(&init), Some(&mut src))
            .is_err()
        {
            return;
        }
    }
    let src = match src {
        Some(t) => t,
        None => return,
    };

    let resize_lost = ensure_swap_chain(
        devices,
        &mut surf.popup_swap_chain,
        &mut surf.popup_sw,
        &mut surf.popup_sh,
        &pv,
        pw,
        ph,
    );
    let sc = match surf.popup_swap_chain.as_ref() {
        Some(sc) => sc.clone(),
        None => {
            if resize_lost {
                recover_from_device_loss(&mut st);
            }
            return;
        }
    };
    if let PresentOutcome::DeviceLost = present_to_swap_chain(devices, &sc, &src) {
        recover_from_device_loss(&mut st);
    }
}
