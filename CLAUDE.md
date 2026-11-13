@AGENTS.md

# Hausflix Desktop (personal build)

This checkout is John's Hausflix port onto Jellium Desktop (upstream
`andrewrabert/jellium-desktop` main at `ec4cba200498`, CEF 154). The app is
still called **Hausflix Desktop**; the binary keeps upstream's name
`jellium-desktop`.

## Where Windows builds come from (read this before any Windows build)

- Build from branch **`integration/jellium-2026-11-09`** on
  `github.com/hausmanj/jellyfin-desktop`. On the Mac the checkout is
  `/Volumes/Storage/source/hausflix-jellium-integration-2026-11-09`.
- Do **not** build from `feature/hausflix-windows-personal`. That is the
  pre-Jellium branch (old CEF and old Windows compositor) and is superseded.
- **Getting the updates on Windows (do this before every rebuild):**
  ```
  git fetch origin
  git checkout integration/jellium-2026-11-09   # first time: git checkout -t origin/integration/jellium-2026-11-09
  git pull --ff-only
  git submodule sync
  git submodule update --init --recursive
  git ls-files -s third_party/mpv   # must print 80296818...
  ```
  Then `just deps` and `just build`. `submodule sync` matters: the mpv
  submodule moved from `andrewrabert/mpv` to `hausmanj/mpv`, and an old clone
  still has the old URL, so it can't fetch the custom commit.
- The mpv submodule must stay at **`8029681`**: the custom CoreAudio
  passthrough fix (`1ea4b4cf5`) plus upstream mpv's two CoreAudio crash fixes
  (the ones behind upstream PRs #719/#742). It's on `github.com/hausmanj/mpv`,
  branch `hausflix/jellium-2026-11-09`, and `.gitmodules` points there.
  Upstream's `andrewrabert/mpv` (pinned `ab0467ff24`) has **neither** change,
  so never point the submodule back at it.
- On Windows, use upstream's recipes: `just deps`, then `just build`
  (`dev/windows/build.ps1`, plus `dev/windows/build_mpv_source.ps1` for mpv).
- **Windows build status (2026-11-13):** Built and tested on real Windows
  hardware (Basement PC `100.87.82.89`, AMD Radeon Graphics + LG OLED).
  DirectComposition tier-1 fallback, composition target rebind retry/teardown,
  sync `wait_for_hwnd` boot wait, and SMTC consumer thread join were verified
  and committed.
- Upstream Windows PRs reviewed: #737 / #699 startup window-wait resolved via
  safe sync `window-id` property poll in `platform.rs`.
- **PR Updates (2026-11-13):**
  - **PR #346 (`minimal-dv-fix`):** Updated with full Dolby Vision presentation
    profile selection (`dv-detect.lua`), VO window rebind, DComp tier-1
    clipping fallback, retry race hardening, and SMTC consumer thread join.
    Synced with upstream `main` (`96bae1c`).
  - **PR #533 (`feature/startup-window-mode-upstream`):** Synced with upstream
    `main` (`96bae1c`). Clean diff against upstream (6 files, +176, -4).
  - **PR #580 (`feature/user-profile-switching`):** Synced with upstream
    `main` (`96bae1c`). Clean diff against upstream (6 files, +1028, -5).
  - All PR branches pushed cleanly via linear fast-forwards. Never force-push.

## Data compatibility

Config and cache directories are still named `jellyfin-desktop`, so existing
settings, profiles and logins carry over:

| Platform | Config | Cache (CEF cache) |
|---|---|---|
| macOS | `~/.config/jellyfin-desktop` | `~/Library/Caches/jellyfin-desktop` |
| Windows | `%APPDATA%\jellyfin-desktop` | `%LOCALAPPDATA%\jellyfin-desktop` |

Don't adopt upstream's `jellium-desktop` directory names without a migration.

## Ported Hausflix features

- Profile picker / multi-user: `src/web/user-switch.js`
- Startup window mode: `src/config`, plus the native settings in `src/jfn_rust/src/shell/settings.rs`
- DV handling: `resources/mpv/scripts/dv-detect.lua`, plus the Windows VO rebind in `src/windows`
- macOS audio passthrough: the mpv submodule commit above
- Branding

Regression tests live in `dev/tests/` and are run from the repo root:
`node --test dev/tests/user-switch.cjs` and `luajit dev/tests/dv-detect.lua`.

## Windows Remote Access & Deployment Notes (2026-11-12)

### Remote Access & SSH Setup
- **Family Room Machine:** Hausflix Family Room (`DESKTOP-49H5SUT`, Windows 11 Pro 24H2 build 26100, AMD Radeon Graphics).
  - **Tailscale IP:** `100.78.3.18`
  - **SSH Command:** `ssh familyroom`
- **Basement Machine:** Hausflix Basement (`DESKTOP-JUC0QAF`, Windows 11 build 26100).
  - **Tailscale IP:** `100.87.82.89`
  - **SSH Command:** `ssh basement` (user `johnhausman`)
- **Bedroom Machine:** Hausflix Bedroom (`jellyfinbedroom`, Windows 11 build 26100).
  - **Tailscale IP:** `100.92.211.3`
  - **SSH Command:** `ssh bedroom` (user `john`)
  *(Configured in `~/.ssh/config` with key `~/.ssh/id_ed25519`)*.
- **Windows OpenSSH Configuration:**
  - Mac public key authorized in both `%USERPROFILE%\.ssh\authorized_keys` and `%ProgramData%\ssh\administrators_authorized_keys` (with `icacls` restricted to `Administrators:F` and `SYSTEM:F`).
  - `sshd` and `ssh-agent` services are set to Automatic.
- **RDP Configuration (Windows App on Mac):**
  - **Uncheck "Connect to an admin session"** in the Windows App connection settings; the admin session flag requests console takeover (Session 1), causing a 30-second delay/approval prompt.
  - Enforced single session policy via registry: `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\fSingleSessionPerUser` = `1`.

### Live Deployment & Runtime Findings
- **Staging location:** `C:\Users\johnhausman\Desktop\buildtest4\build\jellium-desktop.exe`
- **Shortcuts & Taskbar:**
  - Start menu shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Jellium Desktop.lnk`
  - Taskbar pinned: `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Jellium.lnk` (registered in `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband`).
  - Note on Windows 11 taskbar at low resolutions (e.g. 1024x768 RDP): pinned icons may overflow into the three-dot `...` taskbar overflow tray.
- **Process Architecture (CEF Multi-Process):**
  - A single app run produces 5–6 `jellium-desktop.exe` subprocesses in Task Manager:
    1. Main Browser Process (owns UI, mpv, and window)
    2. Chromium GPU Process (`--type=gpu-process`)
    3. Chromium Renderer Process (`--type=renderer`)
    4. Chromium Network & Audio Utility Services (`--type=utility`)
  - All child processes are managed under a Windows Job Object and exit cleanly when the main process exits.
- **Crash & Device-Lost Analysis:**
  - **Symptoms:** Under prolonged playback / repeated runs, Windows hit virtual memory exhaustion (Event 2004), causing `dwm.exe` (Desktop Window Manager) to crash (`0xc00001ad` in `dwmcore.dll`).
  - **Root Cause:** DWM crash/reset destroyed the DXGI swapchain / Direct3D 11 device (`0x8007000e`). `wgpu-29.0.4` failed to reconfigure the surface on device loss and panicked:
    ```
    PANIC: panicked at wgpu-29.0.4\src\backend\wgpu_core.rs:3934:26:
    Error in Surface::get_current_texture_view: Validation Error
    Caused by: Surface is not configured for presentation
    ```
  - **Future Fix Needed:** Add device-loss recovery / surface reconfiguration in `jfn_gpu_paint` when DWM resets or display topology changes (e.g. RDP connect/disconnect, monitor resolution changes).
