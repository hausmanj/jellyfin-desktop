-- linux-edr-verify.lua
-- Diagnostic logging for HDR pipeline status on Linux/Wayland.
-- Key indicator: video-out-params/gamma = pq means the Wayland compositor
-- accepted the HDR surface request and an HDR swapchain is live.
--
-- Logs automatically:
--   - 1.5 s after file-loaded (initial snapshot)
--   - whenever video-out-params/gamma changes (real-time tracking)

if mp.get_property("platform") ~= "linux" then
    return
end

local function log_hdr_status(context)
    local gamma      = mp.get_property("video-out-params/gamma")     or "n/a"
    local sig_peak   = mp.get_property("video-out-params/sig-peak")  or "n/a"
    local csp_hint   = mp.get_property("target-colorspace-hint")     or "n/a"
    local primaries  = mp.get_property("video-out-params/primaries") or "n/a"
    local colorspace = mp.get_property("video-out-params/colorspace") or "n/a"
    local hdr_active = (gamma == "pq") and "YES" or "NO"

    mp.msg.info(string.format(
        "linux-edr-verify [%s]: HDR=%s gamma=%s sig-peak=%s primaries=%s colorspace=%s csp-hint=%s",
        context, hdr_active, gamma, sig_peak, primaries, colorspace, csp_hint
    ))
end

-- Snapshot 1.5 s after load (lets the VO negotiate the HDR surface first).
mp.register_event("file-loaded", function()
    mp.add_timeout(1.5, function() log_hdr_status("file-loaded+1.5s") end)
end)

-- Real-time: log whenever the output gamma actually changes.
mp.observe_property("video-out-params/gamma", "string", function(_, val)
    if val then
        log_hdr_status("gamma-changed")
    end
end)
