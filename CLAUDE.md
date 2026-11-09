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
- As of 2026-11-09, Windows has only been cross-compile checked from the Mac
  (`cargo-xwin check` and `clippy`). No real Windows exe has been built or
  tested yet: no DV, HDR10/SDR, VO recreation, TV hotplug or RDP testing.
- Upstream Windows PRs to review for the Windows build (not applied here, as
  of 2026-11-09): #738 (Windows `<select>` dropdowns as in-page menus, the same
  method now used on macOS), #737 and #699 (Windows startup waits for mpv's
  window), #627 (PerMonitorV2 HiDPI and logical input coordinates; overlaps
  John's RDP scaling fixes).
- **Test on Windows before PR #346 is updated.** This branch has the full
  Dolby Vision handling: `dv-detect.lua`, plus the native VO-window rebind in
  `src/windows/src/platform.rs` `win_on_window_handle_changed`, `input.rs`
  `recreate_input_child_window` and `render::rebind`. That rebind was ported
  onto upstream's new DirectComposition compositor on 2026-11-09 and has
  never run on Windows. Test: DV -> HDR10 -> SDR, back-to-back DV files, DV ->
  non-DV in fullscreen, and a looping theme video. Watch the log for
  `mpv VO window replaced` and `input child window recreated`.
- John's PRs (#346, #533, #580) were updated in place on 2026-11-09. The
  full-DV update for #346 is committed but **held** on fork branch
  `pr346-full-dv-pending` until the Windows test passes. When it does,
  fast-forward `minimal-dv-fix` to that branch and push normally. Never
  force-push, and don't touch the PRs without John's OK.

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
