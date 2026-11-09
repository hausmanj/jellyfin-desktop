@AGENTS.md

# Hausflix Desktop (personal build)

This checkout is John's Hausflix port onto Jellium Desktop (upstream
`andrewrabert/jellium-desktop` main at `ec4cba200498`, CEF 154). The app is
still called **Hausflix Desktop**; the binary keeps upstream's name
`jellium-desktop`.

## Where Windows builds come from (read this before any Windows build)

- Build from branch **`integration/jellium-2026-11-09`** of this repo
  (`/Volumes/Storage/source/hausflix-jellium-integration-2026-11-09` on the Mac).
- Do **not** build from `feature/hausflix-windows-personal`. That is the
  pre-Jellium branch (old CEF and old Windows compositor) and is superseded.
- This branch has **not been pushed to GitHub yet**. `origin` here is a local
  comparison repo, so a Windows machine can't fetch it until John pushes it to
  `hausmanj/jellyfin-desktop`. John decides when that happens.
- The mpv submodule must stay at **`8029681`**: the custom CoreAudio
  passthrough fix (`1ea4b4cf5`) plus upstream mpv's two CoreAudio crash fixes
  (the ones behind upstream PRs #719/#742). It's on `github.com/hausmanj/mpv`,
  branch `hausflix/jellium-2026-11-09`. `.gitmodules` still points at
  `andrewrabert/mpv`, whose pinned `ab0467ff24` has **neither** change. Check
  `git ls-files -s third_party/mpv` after any submodule update.
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
- John's GitHub PRs against upstream will probably need updating once this
  build has been tested. Don't touch them without his OK.

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
