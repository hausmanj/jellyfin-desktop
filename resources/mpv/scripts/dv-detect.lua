-- Detect Dolby Vision from mpv's track-list and select the Windows
-- presentation path before decoders are created. DWM supplies automatic
-- Dolby Vision signaling, but keeping every file DWM-composited also converts
-- HDR10 and SDR output to DV. Use bitblt presentation only for DV files; the
-- file-local option restores mpv's normal flip-model path when playback ends.
--
-- Changing d3d11-flip on a live VO forces mpv to tear down and recreate its
-- own native render window — the Rust side observes mpv's window-id property
-- and rebinds the compositor, input child window, WndProc hook, and SMTC to
-- the new window when that happens (src/windows/src/platform.rs,
-- win_on_window_handle_changed). Do not reintroduce this per-file toggle
-- without that recovery plumbing in place.

if mp.get_property("platform") ~= "windows" then
    return
end

mp.add_hook("on_preloaded", 50, function()
    local tracks = mp.get_property_native("track-list", {})
    local is_dv = false
    for _, track in ipairs(tracks) do
        if track.type == "video" and track["dolby-vision-profile"] then
            is_dv = true
            break
        end
    end
    local hint = is_dv and "no" or "yes"
    local presentation = "flip"

    mp.set_property("file-local-options/target-colorspace-hint", hint)
    if is_dv then
        mp.set_property("file-local-options/d3d11-flip", "no")
        presentation = "dwm-bitblt"
    end

    mp.msg.info(string.format(
        "[dv-detect] dolbyVision=%s → target-colorspace-hint=%s presentation=%s",
        tostring(is_dv), hint, presentation))
end)
