-- Run from the repository root: luajit dev/tests/dv-detect.lua
local props = {platform = 'windows', fullscreen = true}
local writes, timers, hooks = {}, {}, {}
mp = {
    get_property = function(key) return props[key] end,
    get_property_native = function(key, fallback)
        if props[key] == nil then return fallback end
        return props[key]
    end,
    set_property = function(key, value)
        props[key] = value
        writes[#writes + 1] = {key, value}
    end,
    set_property_native = function(key, value) props[key] = value end,
    add_hook = function(name, _, fn) hooks[name] = fn end,
    add_timeout = function(_, fn) timers[#timers + 1] = fn end,
    msg = {info = function() end, warn = function() end}
}
local script = 'resources/mpv/scripts/dv-detect.lua'
dofile(script)
local preload = assert(hooks.on_preloaded)
local function load(path, dv)
    props.path = path
    props['track-list'] = {{type = 'video', ['dolby-vision-profile'] = dv and 8 or nil}}
    preload()
end
load('dv-one', true)
assert(props['target-colorspace-hint'] == 'no' and props['d3d11-flip'] == 'no')
local count = #writes
load('dv-one', true)
assert(#writes == count, 'looping the same file must not recreate the VO')
load('dv-two', true)
assert(#writes == count + 2, 'a different DV file must reassert its presentation profile')
load('hdr', false)
assert(props['target-colorspace-hint'] == 'yes' and props['d3d11-flip'] == 'yes')
assert(#timers == 1, 'DV exit must schedule fullscreen recovery')
table.remove(timers, 1)()
assert(props.fullscreen == false)
table.remove(timers, 1)()
assert(props.fullscreen == true)
load('sdr', false)
assert(#timers == 0, 'SDR/HDR transitions must not cycle fullscreen')
dofile(script)
assert(hooks.on_preloaded == preload, 'duplicate script must not register a second writer')
props.platform = 'darwin'
hooks = {}
dofile(script)
assert(next(hooks) == nil, 'Windows DV policy must not run on macOS')
print('DV policy: profile transitions, loop guard, fullscreen recovery, duplicate load and platform isolation passed')
