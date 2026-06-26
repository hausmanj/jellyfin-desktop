-- macOS EDR pipeline verification
--
-- Confirms that the EDR swapchain is actually active, not just that the TV
-- shows an HDR badge (HDMI handshake alone triggers that).
--
-- Key indicator: video-out-params/gamma == "pq" or "hlg" means libplacebo
-- obtained an HDR-capable swapchain from MoltenVK/Metal.  If it reads
-- "bt.1886" or "srgb" the output is SDR regardless of what the TV reports.
--
-- OSD appears 1.5s after file load.  Press Shift+E at any time to refresh.

if mp.get_property("platform") ~= "darwin" then
    return
end

local HDR_GAMMAS = { pq = true, hlg = true, ["bt.2020-10"] = true }

local function collect()
    local function get(p) return mp.get_property(p, "?") end

    local out_gamma   = get("video-out-params/gamma")
    local out_peak    = get("video-out-params/sig-peak")
    local src_gamma   = get("video-params/gamma")
    local src_peak    = get("video-params/sig-peak")
    local src_prim    = get("video-params/primaries")
    local hint        = get("target-colorspace-hint")
    local vo          = get("current-vo")
    local display     = get("display-names")

    local edr_active  = HDR_GAMMAS[out_gamma] == true
    local status      = edr_active and "EDR ACTIVE ✓" or "EDR NOT ACTIVE ✗"

    local lines = {
        "── macOS EDR verify ──────────────────",
        string.format("  status          : %s", status),
        string.format("  out gamma       : %s  (pq/hlg = HDR swapchain)", out_gamma),
        string.format("  out sig-peak    : %s", out_peak),
        string.format("  src gamma       : %s", src_gamma),
        string.format("  src sig-peak    : %s", src_peak),
        string.format("  src primaries   : %s", src_prim),
        string.format("  target-cs-hint  : %s  (want: yes)", hint),
        string.format("  vo              : %s", vo),
        string.format("  display         : %s", display),
        "──────────────────────────────────────",
    }

    for _, l in ipairs(lines) do
        mp.msg.info("[edr-verify] " .. l)
    end

    return table.concat(lines, "\n"), edr_active
end

local function show()
    local text, _ = collect()
    local prev_size = mp.get_property("osd-font-size")
    mp.set_property("osd-font-size", "32")
    mp.osd_message(text, 12)
    mp.add_timeout(12.1, function()
        mp.set_property("osd-font-size", prev_size)
    end)
end

mp.register_event("file-loaded", function()
    mp.add_timeout(1.5, show)
end)

mp.add_key_binding("E", "edr-verify-refresh", show)
