#!/bin/bash
# Checks run against the nested shell. Sourced by headless-inner.sh, which
# provides eval_js, $UUID, $ROOT and $WORK.
SHOTS="${SHOTS:-$WORK/shots}"
mkdir -p "$SHOTS"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"

preset() { gjs -m "$ROOT/test/preset.mjs" "$@"; sleep 2.5; }
shot() {
    timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" 2>&1 | head -1
}
show() { echo "== $1"; eval_js "$2"; }

show "extension states (1 = enabled)" "[Main.extensionManager.lookup('$UUID').state, Main.extensionManager.lookup('ubuntu-dock@ubuntu.com').state]"
show "extension error" "Main.extensionManager.lookup('$UUID').error"

DOCK="Main.uiGroup.get_children().find(a=>a.name==='dashtodockContainer')"
show "dock classes" "$DOCK.style_class"
show "apps icon" "(() => { const d=$DOCK; const i=d.dash._showAppsIcon; return Object.keys(i).join(',') + ' | ' + (i.icon && typeof i.icon.createIcon); })()"
shot default
for p in floating taskbar taskbar-left glass minimal vertical pill neon topbar; do
    echo "== preset $p"
    preset "$p"
    show "classes" "$DOCK.style_class"
    show "radius/border" "(() => { const d=$DOCK; const n=d.dash._background.get_theme_node(); return [n.get_border_radius(0), n.get_border_width(0), n.get_margin(2)||0].join(' ') + ' ' + d.get_transformed_position() + ' ' + d.get_size(); })()"
    shot "$p"
done

# ---- widgets -------------------------------------------------------------------
DM="org.gnome.shell.extensions.shore"
set_() { gsettings set "$DM" "$@"; sleep 0.5; }
echo "##### widgets"
preset taskbar
for w in clock date cpu-usage cpu-temp memory network weather; do set_ widget-$w true; done
set_ widgets-font "DejaVu Serif"; set_ weather-place "Test"; set_ weather-lat 35.0; set_ weather-lon -97.0
sleep 4
show "widget box" "(() => { const d=$DOCK; const k=d.dash._dashContainer.get_children(); return k.map(c=>c.name).join(' ') + ' | ' + k.find(c=>c.name==='dm-widgets')?.get_children().map(r=>r.get_children().map(c=>c.text||c.icon_name).join('/')).join(' || '); })()"
shot widgets-taskbar
preset topbar
set_ widget-network true
sleep 3
shot widgets-topbar
preset vertical
set_ widget-clock true; set_ widget-network true
sleep 3
shot widgets-vertical

# ---- magnification --------------------------------------------------------------
echo "##### frosted glass"
preset floating
show "glass actor under the dock: x,y,w,h (expect the dock's shape, not 0)" "(() => { const d=$DOCK; const k=Main.uiGroup.get_children(); const h=k[k.indexOf(d)-1]; return [h.constructor.name, h.x, h.y, h.width, h.height, h.visible, h.get_effects().length].join(' '); })()"
shot glass-floating
preset default 2>/dev/null || preset ubuntu
show "glass actor gone with blur off (expect true)" "(() => { const d=$DOCK; const k=Main.uiGroup.get_children(); return k[k.indexOf(d)-1]?.get_effects().length !== 1; })()"

echo "##### magnify"
preset floating
eval_js "(() => { const d=$DOCK; const C=imports.gi.Clutter; globalThis.__dev = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const [x,y]=d.dash._box.get_children()[1].get_transformed_position(); globalThis.__p=[x+20,y+20]; globalThis.__dev.notify_absolute_motion(global.get_current_time(), x+20, y+20); return 1; })()" >/dev/null
sleep 1
eval_js "globalThis.__dev.notify_absolute_motion(global.get_current_time(), globalThis.__p[0]+4, globalThis.__p[1]+3)" >/dev/null
sleep 1
show "scales/shifts under the pointer (expect values above 1.00)" "$DOCK.dash._box.get_children().filter(i=>i.child).map(i=>i.child.scale_x.toFixed(2)+'/'+Math.round(i.child.translation_x)).join(' ')"
shot magnify

# ---- hide completely ---------------------------------------------------------------
echo "##### hide"
eval_js "globalThis.__dev.notify_absolute_motion(global.get_current_time(), 640, 300)" >/dev/null
sleep 1
show "scales after leaving (expect 1.00)" "$DOCK.dash._box.get_children().filter(i=>i.child).map(i=>i.child.scale_x.toFixed(2)).join(' ')"
show "work area height with reserved space (expect less than 768)" "Main.layoutManager.getWorkAreaForMonitor(0).height"
set_ hidden true
sleep 1
show "visible while hidden (expect false)" "$DOCK.visible"
show "work area height while hidden (expect 768)" "Main.layoutManager.getWorkAreaForMonitor(0).height"
set_ hidden false
sleep 1
show "visible after (expect true)" "$DOCK.visible"

# ---- always visible without reserved space --------------------------------------------
echo "##### float over windows"
set_ reserve-space false; set_ autohide false
sleep 2
show "slide with reserve space and autohide both off (expect 1 = shown)" "$DOCK._slider.slide_x"
show "work area height (expect 768)" "Main.layoutManager.getWorkAreaForMonitor(0).height"

# ---- apps logo ----------------------------------------------------------------------
echo "##### logos"
for icon in hexagon flower spark; do set_ apps-icon $icon; sleep 1; shot logo-$icon; done
set_ apps-icon default

# ---- settings window while the dock is hidden ----------------------------------------------
echo "##### prefs while hidden"
set_ hidden true
sleep 1
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
(timeout 8 gnome-extensions prefs "$UUID" > "$WORK/prefs-hidden.log" 2>&1 &)
sleep 5
show "windows open while hidden (expect 1)" "global.get_window_actors().length"
shot prefs-hidden
sleep 4
set_ hidden false
sleep 1

# ---- settings window ------------------------------------------------------------------
echo "##### prefs"
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
ls "$XDG_RUNTIME_DIR" | head
(timeout 20 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
# The settings window runs in the Extensions service; its messages land in the session output.
sleep 6
shot prefs
# Click through the tabs of the settings window.
click() {
    eval_js "(() => { const C=imports.gi.Clutter; const d=globalThis.__dev; d.notify_absolute_motion(global.get_current_time(), $1, $2); d.notify_button(global.get_current_time(), C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(global.get_current_time(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED); })()" >/dev/null
    sleep 1.2
}
n=1
for x in 452 575 698 821 944; do click $x 55; shot prefs-tab$n; n=$((n+1)); done
# Scroll the Widgets page down to its Look group.
click 821 55
eval_js "(() => { const C=imports.gi.Clutter; for (let i = 0; i < 6; i++) globalThis.__dev.notify_discrete_scroll(global.get_current_time(), C.ScrollDirection.DOWN, C.ScrollSource.WHEEL); })()" >/dev/null
sleep 1.5; shot prefs-widgets-look
cat "$WORK/prefs.log" | head -20

# ---- turn off and on again ----------------------------------------------------------------
echo "##### disable / enable"
gnome-extensions disable "$UUID"; sleep 1.5
show "classes after disable" "$DOCK.style_class"
show "widgets after disable" "!!$DOCK.dash._dashContainer.get_children().find(c=>c.name==='dm-widgets')"
gnome-extensions enable "$UUID"; sleep 2.5
show "classes after enable" "$DOCK.style_class"
