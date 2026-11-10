// Shared by the extension and the settings window: which settings exist,
// how they map onto the Ubuntu dock's own settings, and the built-in presets.

import GLib from 'gi://GLib';

export const DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';

// Settings that are not part of a design, so presets never touch them.
export const GENERAL_KEYS = ['enabled', 'hidden', 'toggle-shortcut', 'current-preset', 'user-presets',
    'weather-place', 'weather-lat', 'weather-lon'];

// Turns our settings into the Ubuntu dock's settings. `v(key)` reads one of ours.
export function dockValues(v) {
    const dynamic = v('transparency') === 'DYNAMIC';
    const mode = v('indicator-color-mode');
    return {
        'dock-position': v('position'),
        // A hidden dock must not keep its strip of the screen.
        'dock-fixed': v('reserve-space') && !v('hidden'),
        'extend-height': v('extend'),
        'height-fraction': v('length') / 100,
        'multi-monitor': v('all-monitors'),
        'dash-max-icon-size': v('icon-size'),
        'icon-size-fixed': true,
        'always-center-icons': v('align') === 'center',
        'show-show-apps-button': v('show-apps-button'),
        'show-apps-at-top': v('apps-position') === 'start',
        'show-apps-always-in-the-edge': v('apps-at-edge'),
        'show-trash': v('show-trash'),
        'show-mounts': v('show-mounts'),
        'show-mounts-network': v('show-mounts-network'),
        'show-favorites': v('show-favorites'),
        'show-running': v('show-running'),
        'show-windows-preview': v('show-previews'),
        'isolate-workspaces': v('isolate-workspaces'),
        'isolate-monitors': v('isolate-monitors'),
        'click-action': v('click-action'),
        // The dock itself only knows "keeps its space" or "hides somehow":
        // with both kinds of hiding off it would slide away for good. To
        // stay visible on top of windows, it is told to dodge only
        // always-on-top windows, which in practice means never.
        'autohide': v('autohide'),
        'intellihide': v('autohide') ? v('intellihide') : true,
        'intellihide-mode': v('autohide') ? v('intellihide-mode') : 'ALWAYS_ON_TOP',
        'autohide-in-fullscreen': v('autohide-fullscreen'),
        'require-pressure-to-show': v('require-pressure'),
        'show-delay': v('show-delay'),
        'hide-delay': v('hide-delay'),
        'animation-time': v('animation-time'),
        // With the default transparency mode the dock puts no color of its
        // own on the background, so our stylesheet decides. Dynamic mode
        // needs the dock's own code, which swaps between two opacities.
        'transparency-mode': dynamic ? 'DYNAMIC' : 'DEFAULT',
        'custom-background-color': dynamic,
        'background-color': v('bg-color'),
        'customize-alphas': dynamic,
        'min-alpha': v('bg-opacity'),
        'max-alpha': v('bg-opacity-near'),
        'running-indicator-style': v('indicator-style'),
        'running-indicator-dominant-color': mode === 'dominant',
        'custom-theme-customize-running-dots': mode === 'custom',
        'custom-theme-running-dots-color': v('indicator-color'),
        'custom-theme-running-dots-border-color': v('indicator-border-color'),
        'custom-theme-running-dots-border-width': v('indicator-border-width'),
        // Things our stylesheet replaces.
        'apply-custom-theme': false,
        'custom-theme-shrink': false,
        'force-straight-corner': false,
        'unity-backlit-items': false,
    };
}

// Writes a value to a settings key of any type; returns true if it changed.
export function setTyped(settings, key, value) {
    const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
    switch (type) {
    case 'b':
        if (settings.get_boolean(key) === value)
            return false;
        settings.set_boolean(key, value);
        return true;
    case 'i':
        value = Math.round(value);
        if (settings.get_int(key) === value)
            return false;
        settings.set_int(key, value);
        return true;
    case 'd':
        if (Math.abs(settings.get_double(key) - value) < 1e-6)
            return false;
        settings.set_double(key, value);
        return true;
    case 's':
        if (settings.get_string(key) === value)
            return false;
        settings.set_string(key, value);
        return true;
    default:
        return false;
    }
}

export function readTyped(settings, key) {
    const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
    switch (type) {
    case 'b': return settings.get_boolean(key);
    case 'i': return settings.get_int(key);
    case 'd': return settings.get_double(key);
    case 's': return settings.get_string(key);
    case 'as': return settings.get_strv(key);
    default: return null;
    }
}

export function designKeys(settings) {
    return settings.settings_schema.list_keys().filter(k => !GENERAL_KEYS.includes(k));
}

// Every key of the design, as a plain object.
export function snapshot(settings) {
    const out = {};
    for (const key of designKeys(settings))
        out[key] = readTyped(settings, key);
    return out;
}

// Makes the settings match a preset. Keys the preset does not mention go
// back to their defaults, so a preset always means the same look.
export function applyValues(settings, values) {
    for (const key of designKeys(settings)) {
        if (key in values) {
            const value = values[key];
            if (Array.isArray(value))
                settings.set_strv(key, value);
            else
                setTyped(settings, key, value);
        } else {
            settings.reset(key);
        }
    }
}

// Checks an imported preset against the schema; returns only the values
// that have the right type and are inside the allowed range or choices.
export function sanitize(settings, values) {
    const clean = {};
    if (typeof values !== 'object' || values === null)
        return clean;
    const schema = settings.settings_schema;
    for (const key of designKeys(settings)) {
        if (!(key in values))
            continue;
        const info = schema.get_key(key);
        const type = info.get_value_type().dup_string();
        const value = values[key];
        let variant = null;
        if (type === 'b' && typeof value === 'boolean')
            variant = GLib.Variant.new_boolean(value);
        else if (type === 'i' && Number.isFinite(value))
            variant = GLib.Variant.new_int32(Math.round(value));
        else if (type === 'd' && Number.isFinite(value))
            variant = GLib.Variant.new_double(value);
        else if (type === 's' && typeof value === 'string')
            variant = GLib.Variant.new_string(value);
        if (variant && info.range_check(variant))
            clean[key] = type === 'i' ? Math.round(value) : value;
    }
    return clean;
}
