-- linux-edr-verify.lua
-- Diagnostic OSD for HDR pipeline status on Linux/Wayland.
-- Key indicator: video-out-params/gamma = pq means the Wayland compositor
-- accepted the HDR surface request and an HDR swapchain is live.
-- Displays 1.5s after file load. Shift+E to refresh manually.

if mp.get_property("platform") ~= "linux" then
    return
end

local function show_hdr_status()
    local gamma      = mp.get_property("video-out-params/gamma")      or "n/a"
    local sig_peak   = mp.get_property("video-out-params/sig-peak")   or "n/a"
    local csp_hint   = mp.get_property("target-colorspace-hint")      or "n/a"
    local primaries  = mp.get_property("video-out-params/primaries")  or "n/a"
    local colorspace = mp.get_property("video-out-params/colorspace")  or "n/a"

    local hdr_active = (gamma == "pq") and "YES (HDR swapchain live)" or "NO  (SDR or compositor rejected)"

    local prev_size = mp.get_property("osd-font-size")
    mp.set_property("osd-font-size", "32")

    mp.osd_message(
        "=== Linux HDR Verify ===\n" ..
        "HDR active:      " .. hdr_active .. "\n" ..
        "out gamma:       " .. gamma .. "\n" ..
        "sig-peak:        " .. sig_peak .. "\n" ..
        "primaries:       " .. primaries .. "\n" ..
        "colorspace:      " .. colorspace .. "\n" ..
        "csp-hint:        " .. csp_hint,
        5
    )

    mp.add_timeout(5, function()
        mp.set_property("osd-font-size", prev_size)
    end)

    mp.msg.info(string.format(
        "linux-edr-verify: gamma=%s sig-peak=%s primaries=%s colorspace=%s csp-hint=%s",
        gamma, sig_peak, primaries, colorspace, csp_hint
    ))
end

mp.register_event("file-loaded", function()
    mp.add_timeout(1.5, show_hdr_status)
end)

mp.add_key_binding("Shift+e", "linux-edr-verify", show_hdr_status)
