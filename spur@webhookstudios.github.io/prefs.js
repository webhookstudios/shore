import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {applyToWindow as applySedge} from './sedge/sedge.js';

import {DOCK_SCHEMA, applyValues, dockValues, readTyped, sanitize, snapshot} from './model.js';
import {BUILTIN_PRESETS} from './presets.js';
import {drawDock, makePreview} from './preview.js';

const esc = text => GLib.markup_escape_text(text, -1);

// ---- Row helpers -------------------------------------------------------------

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function range(settings, key) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
    return [lower, upper];
}

function spinRow(settings, key, title, subtitle, step, digits = 0) {
    const [lower, upper] = range(settings, key);
    const row = new Adw.SpinRow({
        title, subtitle: subtitle ?? '', digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function sliderRow(settings, key, title, subtitle, digits = 2) {
    const [lower, upper] = range(settings, key);
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL, width_request: 220, valign: Gtk.Align.CENTER,
        draw_value: true, value_pos: Gtk.PositionType.RIGHT, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: (upper - lower) / 100}),
    });
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable_widget: scale});
    row.add_suffix(scale);
    return row;
}

function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title, subtitle, subtitle: subtitle ?? '', model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const show = () => {
        const index = options.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    const id = settings.connect(`changed::${key}`, show);
    row.connect('destroy', () => settings.disconnect(id));
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function toHex(rgba) {
    const part = value => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${part(rgba.red)}${part(rgba.green)}${part(rgba.blue)}`;
}

function colorRow(settings, key, title, subtitle) {
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER,
    });
    const show = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && toHex(rgba) !== toHex(button.rgba))
            button.rgba = rgba;
    };
    show();
    const id = settings.connect(`changed::${key}`, show);
    button.connect('destroy', () => settings.disconnect(id));
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable_widget: button});
    row.add_suffix(button);
    return row;
}

// One choice for when the dock shows, in place of three switches that
// only make sense in some combinations.
const SHOW_MODES = [
    ['always', 'Always, and windows stop at it', {'reserve-space': true}],
    ['float', 'Always, on top of windows', {'reserve-space': false, 'autohide': false}],
    ['dodge', 'Until a window touches it',
        {'reserve-space': false, 'autohide': true, 'intellihide': true}],
    ['autohide', 'Only when the pointer reaches the edge',
        {'reserve-space': false, 'autohide': true, 'intellihide': false}],
];

function showMode(settings) {
    if (settings.get_boolean('reserve-space'))
        return 'always';
    if (!settings.get_boolean('autohide'))
        return 'float';
    return settings.get_boolean('intellihide') ? 'dodge' : 'autohide';
}

function showModeRow(settings) {
    const row = new Adw.ComboRow({
        title: 'Show the dock',
        subtitle: 'A hidden dock comes back when the pointer reaches its edge',
        model: Gtk.StringList.new(SHOW_MODES.map(([, label]) => label)),
    });
    const show = () => {
        const index = SHOW_MODES.findIndex(([id]) => id === showMode(settings));
        if (row.selected !== index)
            row.selected = index;
    };
    show();
    const id = settings.connect('changed', show);
    row.connect('destroy', () => settings.disconnect(id));
    row.connect('notify::selected', () => {
        const [mode, , values] = SHOW_MODES[row.selected] ?? [];
        if (!mode || mode === showMode(settings))
            return;
        for (const [key, value] of Object.entries(values))
            settings.set_boolean(key, value);
    });
    return row;
}

// Greys a row out while `predicate()` is false; re-checked on any change.
function dependsOn(settings, row, predicate) {
    const update = () => (row.sensitive = predicate());
    update();
    const id = settings.connect('changed', update);
    row.connect('destroy', () => settings.disconnect(id));
}

// Picks a font family; the reset button goes back to the system font.
function fontRow(settings, key, title) {
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog(), level: Gtk.FontLevel.FAMILY,
        use_font: true, valign: Gtk.Align.CENTER,
    });
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
        tooltip_text: 'Use the system font',
    });
    const row = new Adw.ActionRow({title, activatable_widget: button});
    const show = () => {
        const family = settings.get_string(key);
        row.subtitle = family || 'System font';
        reset.sensitive = family !== '';
        if (family && button.font_desc?.get_family() !== family)
            button.font_desc = Pango.FontDescription.from_string(family);
    };
    show();
    const id = settings.connect(`changed::${key}`, show);
    row.connect('destroy', () => settings.disconnect(id));
    button.connect('notify::font-desc', () => {
        const family = button.font_desc?.get_family() ?? '';
        if (family && family !== settings.get_string(key))
            settings.set_string(key, family);
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    row.add_suffix(button);
    return row;
}

function shortcutText(settings, key) {
    const [accelerator] = settings.get_strv(key);
    if (!accelerator)
        return 'Disabled';
    const [ok, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return ok ? Gtk.accelerator_get_label(keyval, mods) : accelerator;
}

function captureShortcut(parent, settings, key, title) {
    const dialog = new Adw.Window({
        modal: true, transient_for: parent, title, default_width: 380, default_height: 180,
    });
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    view.set_content(new Adw.StatusPage({
        title: 'Press the new shortcut',
        description: 'Esc cancels. Backspace disables the shortcut.',
    }));
    dialog.set_content(view);
    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_c, keyval, keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (mods === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (mods === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            dialog.close();
        } else if (mods !== 0 && Gtk.accelerator_valid(keyval, mods)) {
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(
                null, Gdk.keyval_to_lower(keyval), keycode, mods)]);
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    dialog.present();
}

function shortcutRow(window, settings, key, title, subtitle) {
    const label = new Gtk.Label({
        label: shortcutText(settings, key), css_classes: ['dim-label'], valign: Gtk.Align.CENTER,
    });
    const id = settings.connect(`changed::${key}`, () => (label.label = shortcutText(settings, key)));
    label.connect('destroy', () => settings.disconnect(id));
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});
    row.add_suffix(label);
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => captureShortcut(window, settings, key, title));
    return row;
}

// The preview that stays at the top of the window: the whole screen on the
// left, a close-up of the dock on the right.
function previewPanel(settings) {
    const get = key => readTyped(settings, key);
    const screen = makePreview(get, {widget: {content_width: 272, content_height: 170}});
    const closeUp = makePreview(get, {focus: true, widget: {content_height: 170, hexpand: true}});
    const box = new Gtk.Box({
        spacing: 12, margin_top: 12, margin_bottom: 12, margin_start: 16, margin_end: 16,
    });
    box.append(screen);
    box.append(closeUp);
    const id = settings.connect('changed', () => {
        screen.queue_draw();
        closeUp.queue_draw();
    });
    box.connect('destroy', () => settings.disconnect(id));
    return box;
}

let toastOverlay = null;
function reveal(_window, text) {
    toastOverlay?.add_toast(new Adw.Toast({title: text, timeout: 3}));
}

// ---- User presets --------------------------------------------------------------

function loadUserPresets(settings) {
    try {
        const data = JSON.parse(settings.get_string('user-presets'));
        return typeof data === 'object' && data ? data : {};
    } catch {
        return {};
    }
}

function saveUserPreset(settings, name, values) {
    const all = loadUserPresets(settings);
    all[name] = {name, values};
    settings.set_string('user-presets', JSON.stringify(all));
}

function defaultsGetter(settings, values) {
    return key => (key in values ? values[key]
        : settings.settings_schema.get_key(key).get_default_value().recursiveUnpack());
}

function exportFile(window, settings, name, values) {
    const dialog = new Gtk.FileDialog({
        title: 'Export preset',
        initial_name: `${name.replace(/[^\w.-]+/g, '-')}.spurpreset.json`,
    });
    dialog.save(window, null, (_d, result) => {
        try {
            const file = dialog.save_finish(result);
            const text = JSON.stringify({format: 'spur-preset', version: 1, name, values}, null, 2);
            file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.NONE, null);
            reveal(window, `Exported “${name}”`);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                reveal(window, `Could not export: ${e.message}`);
        }
    });
}

function importFile(window, settings) {
    const dialog = new Gtk.FileDialog({title: 'Import preset'});
    dialog.open(window, null, (_d, result) => {
        try {
            const file = dialog.open_finish(result);
            const [, bytes] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (data?.format !== 'spur-preset' || typeof data.values !== 'object')
                throw new Error('this is not a Shore preset');
            const values = sanitize(settings, data.values);
            if (Object.keys(values).length === 0)
                throw new Error('the preset has no usable settings');
            const base = String(data.name ?? file.get_basename()).trim().slice(0, 40) || 'Imported';
            const existing = loadUserPresets(settings);
            let name = base;
            for (let n = 2; name in existing; n++)
                name = `${base} ${n}`;
            saveUserPreset(settings, name, values);
            reveal(window, `Imported “${name}”`);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                reveal(window, `Could not import: ${e.message}`);
        }
    });
}

// ---- Pages -------------------------------------------------------------------------

function presetCard(window, settings, preset, user) {
    const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['card'], spacing: 0});
    const main = new Gtk.Button({css_classes: ['flat'], hexpand: true});
    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6, margin_bottom: 4});

    const get = defaultsGetter(settings, preset.values);
    const area = new Gtk.DrawingArea({content_width: 150, content_height: 94, halign: Gtk.Align.CENTER});
    area.set_draw_func((_a, cr, w, h) => drawDock(cr, w, h, get));
    body.append(area);
    const title = new Gtk.Label({label: preset.name, xalign: 0, css_classes: ['heading'], ellipsize: 3});
    body.append(title);
    if (preset.description) {
        body.append(new Gtk.Label({
            label: preset.description, xalign: 0, wrap: true, lines: 4, ellipsize: 3, max_width_chars: 20,
            width_chars: 20,
            css_classes: ['dim-label', 'caption'],
        }));
    }
    main.set_child(body);
    main.connect('clicked', () => {
        applyValues(settings, preset.values);
        settings.set_string('current-preset', user ? `user:${preset.name}` : preset.id);
        reveal(window, `Applied “${preset.name}”`);
    });
    card.append(main);

    const tools = new Gtk.Box({spacing: 2, halign: Gtk.Align.END, margin_end: 4, margin_bottom: 4});
    const exportButton = new Gtk.Button({
        icon_name: 'document-save-symbolic', css_classes: ['flat'], tooltip_text: 'Export to a file',
    });
    exportButton.connect('clicked', () => exportFile(window, settings, preset.name, {...preset.values}));
    tools.append(exportButton);
    if (user) {
        const del = new Gtk.Button({
            icon_name: 'user-trash-symbolic', css_classes: ['flat'], tooltip_text: 'Delete this preset',
        });
        del.connect('clicked', () => {
            const all = loadUserPresets(settings);
            delete all[preset.name];
            settings.set_string('user-presets', JSON.stringify(all));
        });
        tools.append(del);
    }
    card.append(tools);

    const marker = user ? `user:${preset.name}` : preset.id;
    const mark = () => {
        if (settings.get_string('current-preset') === marker)
            title.add_css_class('accent');
        else
            title.remove_css_class('accent');
    };
    mark();
    const id = settings.connect('changed::current-preset', mark);
    card.connect('destroy', () => settings.disconnect(id));
    return card;
}

function presetsPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Presets', icon_name: 'view-grid-symbolic'});

    if (!Gio.SettingsSchemaSource.get_default().lookup(DOCK_SCHEMA, true)) {
        const warn = new Adw.PreferencesGroup({title: 'Ubuntu dock not found'});
        warn.add(new Adw.ActionRow({
            title: 'The Ubuntu dock extension is not installed',
            subtitle: 'Shore restyles ubuntu-dock@ubuntu.com, so it has nothing to change without it.',
        }));
        page.add(warn);
    }

    const main = new Adw.PreferencesGroup();
    main.add(switchRow(settings, 'enabled', 'Control the dock',
        'Turn off to leave the dock exactly as its own settings say'));
    main.add(switchRow(settings, 'hidden', 'Hide the dock completely',
        'Also on the shortcut set on the Hiding page'));
    page.add(main);

    const cards = new Adw.PreferencesGroup({
        title: 'Presets',
        description: 'Pick one, then change anything you like on the other pages.',
    });
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, row_spacing: 12, column_spacing: 12,
        min_children_per_line: 2, max_children_per_line: 3,
    });
    cards.add(flow);
    page.add(cards);

    const rebuild = () => {
        let child;
        while ((child = flow.get_first_child()))
            flow.remove(child);
        for (const preset of BUILTIN_PRESETS)
            flow.append(presetCard(window, settings, preset, false));
        for (const preset of Object.values(loadUserPresets(settings)))
            flow.append(presetCard(window, settings, preset, true));
    };
    rebuild();
    const id = settings.connect('changed::user-presets', rebuild);
    flow.connect('destroy', () => settings.disconnect(id));

    const share = new Adw.PreferencesGroup({
        title: 'Your presets',
        description: 'Save the current look, or share presets as files.',
    });
    const name = new Adw.EntryRow({title: 'Save the current look as…', show_apply_button: true});
    name.connect('apply', () => {
        const text = name.text.trim();
        if (!text)
            return;
        saveUserPreset(settings, text, snapshot(settings));
        settings.set_string('current-preset', `user:${text}`);
        name.text = '';
        reveal(window, `Saved “${text}”`);
    });
    share.add(name);

    const importRow = new Adw.ActionRow({title: 'Import a preset file', activatable: true});
    importRow.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
    importRow.connect('activated', () => importFile(window, settings));
    share.add(importRow);

    const exportRow = new Adw.ActionRow({title: 'Export the current look to a file', activatable: true});
    exportRow.add_suffix(new Gtk.Image({icon_name: 'document-save-symbolic'}));
    exportRow.connect('activated', () => exportFile(window, settings, 'My dock', snapshot(settings)));
    share.add(exportRow);
    page.add(share);

    const reset = new Adw.PreferencesGroup({title: 'Reset'});
    const resetRow = new Adw.ActionRow({
        title: 'Reset the look', subtitle: 'Resets every look and layout setting here',
        activatable: true,
    });
    resetRow.add_suffix(new Gtk.Image({icon_name: 'edit-undo-symbolic'}));
    resetRow.connect('activated', () => {
        applyValues(settings, {});
        settings.set_string('current-preset', 'ubuntu');
        reveal(window, 'The look is reset');
    });
    reset.add(resetRow);

    const restoreRow = new Adw.ActionRow({
        title: 'Revert to system default',
        subtitle: 'Turns Shore off and resets the Ubuntu dock settings it changed',
        activatable: true,
    });
    restoreRow.add_suffix(new Gtk.Image({icon_name: 'go-previous-symbolic'}));
    restoreRow.connect('activated', () => {
        const alert = new Adw.AlertDialog({
            heading: 'Revert to system default?',
            body: 'Shore turns off and the dock goes back to its stock settings. Your presets are kept.',
        });
        alert.add_response('cancel', 'Cancel');
        alert.add_response('restore', 'Revert');
        alert.set_response_appearance('restore', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.choose(window, null, (_a, result) => {
            if (alert.choose_finish(result) !== 'restore')
                return;
            settings.set_boolean('enabled', false);
            if (Gio.SettingsSchemaSource.get_default().lookup(DOCK_SCHEMA, true)) {
                const dock = new Gio.Settings({schema_id: DOCK_SCHEMA});
                const keys = new Set(dock.settings_schema.list_keys());
                for (const key of Object.keys(dockValues(k => readTyped(settings, k)))) {
                    if (keys.has(key))
                        dock.reset(key);
                }
            }
            reveal(window, 'The Ubuntu dock settings are restored');
        });
    });
    reset.add(restoreRow);
    page.add(reset);
    return page;
}

function layoutPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-dual-symbolic'});

    const place = new Adw.PreferencesGroup({title: 'Position'});
    place.add(comboRow(settings, 'position', 'Screen edge', null, [
        ['BOTTOM', 'Bottom'], ['LEFT', 'Left'], ['RIGHT', 'Right'], ['TOP', 'Top']]));
    place.add(showModeRow(settings));
    place.add(switchRow(settings, 'extend', 'Stretch along the edge', 'A full-width bar, like a panel'));
    const length = spinRow(settings, 'length', 'Length', 'Percent of the screen edge', 5);
    dependsOn(settings, length, () => !settings.get_boolean('extend'));
    place.add(length);
    const side = spinRow(settings, 'side-gap', 'Gap at both ends', 'Pixels, for a stretched dock', 2);
    dependsOn(settings, side, () => settings.get_boolean('extend'));
    place.add(side);
    const align = comboRow(settings, 'align', 'Icon alignment', 'In a stretched dock',
        [['center', 'Centered'], ['start', 'At the start']]);
    dependsOn(settings, align, () => settings.get_boolean('extend'));
    place.add(align);
    place.add(switchRow(settings, 'all-monitors', 'Dock on every monitor'));
    page.add(place);

    const size = new Adw.PreferencesGroup({title: 'Size and spacing'});
    size.add(spinRow(settings, 'icon-size', 'Icon size', 'Pixels', 2));
    size.add(spinRow(settings, 'icon-spacing', 'Space between icons', 'Pixels', 1));
    size.add(spinRow(settings, 'padding', 'Padding', 'Pixels between icons and the dock edge', 1));
    size.add(spinRow(settings, 'edge-gap', 'Floating gap', 'Pixels between the dock and the screen edge', 1));
    size.add(spinRow(settings, 'radius', 'Corner radius', 'Pixels', 1));
    page.add(size);
    return page;
}

function lookPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Look', icon_name: 'applications-graphics-symbolic'});

    const bg = new Adw.PreferencesGroup({title: 'Background'});
    bg.add(colorRow(settings, 'bg-color', 'Color'));
    bg.add(sliderRow(settings, 'bg-opacity', 'Opacity'));
    bg.add(comboRow(settings, 'transparency', 'Transparency', 'Dynamic is more solid when a window comes close',
        [['FIXED', 'Fixed'], ['DYNAMIC', 'Dynamic']]));
    const near = sliderRow(settings, 'bg-opacity-near', 'Opacity when a window is near');
    dependsOn(settings, near, () => settings.get_string('transparency') === 'DYNAMIC');
    bg.add(near);
    bg.add(switchRow(settings, 'blur', 'Frosted glass',
        'Shows a blurred copy of the wallpaper behind the dock. Works best with a low opacity'));
    const strength = spinRow(settings, 'blur-strength', 'Blur strength', null, 5);
    dependsOn(settings, strength, () => settings.get_boolean('blur'));
    bg.add(strength);
    page.add(bg);

    const border = new Adw.PreferencesGroup({title: 'Border'});
    border.add(spinRow(settings, 'border-width', 'Width', 'Pixels, 0 for none', 1));
    border.add(colorRow(settings, 'border-color', 'Color'));
    border.add(sliderRow(settings, 'border-opacity', 'Opacity'));
    page.add(border);

    const highlight = new Adw.PreferencesGroup({
        title: 'Icon highlight', description: 'Behind hovered and active icons.',
    });
    highlight.add(spinRow(settings, 'highlight-radius', 'Corner radius', 'Pixels', 1));
    highlight.add(colorRow(settings, 'highlight-color', 'Color'));
    highlight.add(sliderRow(settings, 'highlight-opacity', 'Opacity'));
    page.add(highlight);
    return page;
}

const LOGOS = [
    ['default', 'Default'], ['hexagon', 'Hexagon'], ['flower', 'Flower'], ['spark', 'Spark'],
    ['orbit', 'Orbit'], ['peak', 'Peak'], ['diamond', 'Diamond'], ['drop', 'Drop'], ['bars', 'Bars'],
];

// A row of buttons showing every logo choice, plus a custom image.
function logoPicker(window, settings, extensionPath) {
    const group = new Adw.PreferencesGroup({
        title: 'Corner button logo',
        description: 'The button that opens the app grid. Default is the one your system comes with.',
    });
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: 5,
        min_children_per_line: 3, row_spacing: 8, column_spacing: 8,
    });
    const buttons = new Map();

    const add = (value, label, image) => {
        const button = new Gtk.ToggleButton({tooltip_text: label, css_classes: ['flat']});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 6, margin_bottom: 6});
        box.append(image);
        box.append(new Gtk.Label({label, css_classes: ['caption']}));
        button.set_child(box);
        button.connect('clicked', () => settings.set_string('apps-icon', value));
        buttons.set(value, button);
        flow.append(button);
    };

    for (const [value, label] of LOGOS) {
        const image = value === 'default'
            // The system's own button: its distributor logo where the icon
            // theme has one, the plain app grid otherwise.
            ? new Gtk.Image({
                gicon: new Gio.ThemedIcon({names: ['view-app-grid-ubuntu-symbolic', 'view-app-grid-symbolic']}),
                pixel_size: 32,
            })
            : new Gtk.Image({
                gicon: Gio.icon_new_for_string(GLib.build_filenamev([extensionPath, 'media', `${value}-symbolic.svg`])),
                pixel_size: 32,
            });
        add(value, label, image);
    }
    add('custom', 'Your image', new Gtk.Image({icon_name: 'insert-image-symbolic', pixel_size: 32}));
    group.add(flow);

    const show = () => {
        const current = settings.get_string('apps-icon');
        for (const [value, button] of buttons)
            button.active = value === current;
    };
    show();
    const id = settings.connect('changed::apps-icon', show);
    flow.connect('destroy', () => settings.disconnect(id));

    return group;
}

function logoFileRow(window, settings) {
    const pathRow = new Adw.ActionRow({
        title: 'Your image', subtitle: 'An SVG or PNG file. Shown when “Your image” is picked above',
        activatable: true,
    });
    const pathLabel = new Gtk.Label({css_classes: ['dim-label'], ellipsize: 1, max_width_chars: 30});
    const showPath = () => (pathLabel.label = settings.get_string('apps-icon-path')
        ? GLib.path_get_basename(settings.get_string('apps-icon-path')) : 'None chosen');
    showPath();
    const pid = settings.connect('changed::apps-icon-path', showPath);
    pathLabel.connect('destroy', () => settings.disconnect(pid));
    pathRow.add_suffix(pathLabel);
    pathRow.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
    pathRow.connect('activated', () => {
        const dialog = new Gtk.FileDialog({title: 'Choose a logo image'});
        const filter = new Gtk.FileFilter({name: 'Images'});
        filter.add_mime_type('image/svg+xml');
        filter.add_mime_type('image/png');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        dialog.filters = filters;
        dialog.open(window, null, (_d, result) => {
            try {
                const file = dialog.open_finish(result);
                settings.set_string('apps-icon-path', file.get_path());
                settings.set_string('apps-icon', 'custom');
            } catch { /* cancelled */ }
        });
    });
    return pathRow;
}

function itemsPage(window, settings, extensionPath) {
    const page = new Adw.PreferencesPage({title: 'Icons', icon_name: 'applications-system-symbolic'});
    page.add(logoPicker(window, settings, extensionPath));

    const button = new Adw.PreferencesGroup({title: 'Corner button'});
    button.add(logoFileRow(window, settings));
    button.add(switchRow(settings, 'show-apps-button', 'Show the button'));
    button.add(comboRow(settings, 'apps-position', 'Position', null, [['start', 'Start'], ['end', 'End']]));
    button.add(switchRow(settings, 'apps-at-edge', 'Keep at the end',
        'In a stretched dock, off puts the button next to the icons'));
    button.add(switchRow(settings, 'apps-accent', 'Colored background'));
    const accent = colorRow(settings, 'apps-accent-color', 'Button color');
    dependsOn(settings, accent, () => settings.get_boolean('apps-accent'));
    button.add(accent);
    page.add(button);

    const indicators = new Adw.PreferencesGroup({title: 'Running-app indicators'});
    indicators.add(comboRow(settings, 'indicator-style', 'Style', null, [
        ['DEFAULT', 'Default'], ['DOTS', 'Dots'], ['DOT', 'Single dot'], ['SQUARES', 'Squares'],
        ['DASHES', 'Dashes'], ['SEGMENTED', 'Segmented'], ['SOLID', 'Solid line'],
        ['CILIORA', 'Cilora'], ['METRO', 'Metro'], ['BINARY', 'Binary']]));
    indicators.add(comboRow(settings, 'indicator-color-mode', 'Color', null, [
        ['theme', 'Theme'], ['custom', 'Custom'], ['dominant', 'From the app icon']]));
    const color = colorRow(settings, 'indicator-color', 'Custom color');
    dependsOn(settings, color, () => settings.get_string('indicator-color-mode') === 'custom');
    indicators.add(color);
    const bw = spinRow(settings, 'indicator-border-width', 'Border width', 'Pixels', 1);
    dependsOn(settings, bw, () => settings.get_string('indicator-color-mode') === 'custom');
    indicators.add(bw);
    const bc = colorRow(settings, 'indicator-border-color', 'Border color');
    dependsOn(settings, bc, () => settings.get_string('indicator-color-mode') === 'custom');
    indicators.add(bc);
    page.add(indicators);

    const items = new Adw.PreferencesGroup({title: 'What the dock shows'});
    items.add(switchRow(settings, 'show-favorites', 'Pinned apps'));
    items.add(switchRow(settings, 'show-running', 'Running apps that are not pinned'));
    items.add(switchRow(settings, 'show-trash', 'Trash'));
    items.add(switchRow(settings, 'show-mounts', 'Mounted drives'));
    const net = switchRow(settings, 'show-mounts-network', 'Network drives');
    dependsOn(settings, net, () => settings.get_boolean('show-mounts'));
    items.add(net);
    items.add(switchRow(settings, 'show-previews', 'Window previews'));
    items.add(switchRow(settings, 'isolate-workspaces', 'Only apps of this workspace'));
    items.add(switchRow(settings, 'isolate-monitors', 'Only apps of this monitor'));
    items.add(comboRow(settings, 'click-action', 'Clicking a running app', null, [
        ['focus-or-appspread', 'Focus, or show its windows'], ['focus-minimize-or-previews', 'Focus, minimize or preview'],
        ['focus-minimize-or-appspread', 'Focus, minimize or show windows'], ['focus-or-previews', 'Focus, or preview'],
        ['cycle-windows', 'Cycle windows'], ['minimize', 'Minimize'], ['minimize-or-overview', 'Minimize or overview'],
        ['minimize-or-previews', 'Minimize or preview'], ['previews', 'Previews'], ['launch', 'Open a new window'],
        ['quit', 'Quit'], ['skip', 'Focus only']]));
    page.add(items);

    const magnify = new Adw.PreferencesGroup({
        title: 'Magnification', description: 'Icons grow as the pointer moves over them.',
    });
    magnify.add(switchRow(settings, 'magnify', 'Magnify icons'));
    const scale = sliderRow(settings, 'magnify-scale', 'Growth', 'Times the normal size');
    const reach = sliderRow(settings, 'magnify-range', 'Reach', 'How many icons around the pointer grow', 1);
    for (const row of [scale, reach]) {
        dependsOn(settings, row, () => settings.get_boolean('magnify'));
        magnify.add(row);
    }
    page.add(magnify);
    return page;
}


// Looks a place up by name on open-meteo.com (only when the user asks).
function findPlace(window, settings, name, done) {
    const session = new Soup.Session({timeout: 15});
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
        encodeURIComponent(name);
    session.send_and_read_async(Soup.Message.new('GET', url), GLib.PRIORITY_DEFAULT, null, (_s, result) => {
        try {
            const bytes = session.send_and_read_finish(result);
            const hit = JSON.parse(new TextDecoder().decode(bytes.get_data())).results?.[0];
            if (!hit)
                throw new Error('no place with that name');
            settings.set_string('weather-place', [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '));
            settings.set_double('weather-lat', hit.latitude);
            settings.set_double('weather-lon', hit.longitude);
            reveal(window, `Weather place: ${settings.get_string('weather-place')}`);
        } catch (e) {
            reveal(window, `Could not find the place: ${e.message}`);
        }
        done();
    });
}

function widgetsPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Widgets', icon_name: 'utilities-system-monitor-symbolic'});

    const show = new Adw.PreferencesGroup({
        title: 'Show in the dock',
        description: 'Small readouts beside the icons. All off by default. They update every two seconds.',
    });
    show.add(switchRow(settings, 'widget-clock', 'Time'));
    show.add(switchRow(settings, 'widget-date', 'Date', 'Next to the time in a horizontal dock'));
    show.add(switchRow(settings, 'widget-weather', 'Weather',
        'Asks open-meteo.com for the temperature of the place set below'));
    show.add(switchRow(settings, 'widget-cpu-usage', 'CPU usage'));
    show.add(switchRow(settings, 'widget-cpu-temp', 'CPU temperature', 'Needs a sensor your computer exposes'));
    show.add(switchRow(settings, 'widget-memory', 'Memory use'));
    show.add(switchRow(settings, 'widget-network', 'Network speed',
        'Current download and upload speed, from the network counters'));
    page.add(show);

    const look = new Adw.PreferencesGroup({title: 'Look'});
    look.add(comboRow(settings, 'widgets-position', 'Position', null, [['end', 'End of the dock'], ['start', 'Start of the dock']]));
    look.add(colorRow(settings, 'widgets-text-color', 'Text color'));
    look.add(fontRow(settings, 'widgets-font', 'Font'));
    look.add(spinRow(settings, 'widgets-font-size', 'Text size', 'Points', 1));
    look.add(switchRow(settings, 'widgets-clock-24h', '24-hour clock'));
    look.add(comboRow(settings, 'widgets-temp-unit', 'Temperature unit', null, [['C', 'Celsius'], ['F', 'Fahrenheit']]));
    page.add(look);

    const weather = new Adw.PreferencesGroup({
        title: 'Weather place',
        description: 'Searching sends only the place name to open-meteo.com. Nothing else leaves your computer.',
    });
    const current = new Adw.ActionRow({title: 'Current place'});
    const label = new Gtk.Label({css_classes: ['dim-label']});
    const showPlace = () => (label.label = settings.get_string('weather-place') || 'None');
    showPlace();
    const id = settings.connect('changed::weather-place', showPlace);
    label.connect('destroy', () => settings.disconnect(id));
    current.add_suffix(label);
    weather.add(current);
    const search = new Adw.EntryRow({title: 'Search for a city', show_apply_button: true});
    search.connect('apply', () => {
        const name = search.text.trim();
        if (!name)
            return;
        search.sensitive = false;
        findPlace(window, settings, name, () => (search.sensitive = true));
    });
    weather.add(search);
    page.add(weather);
    return page;
}

function hidingPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Hiding', icon_name: 'view-conceal-symbolic'});

    const all = new Adw.PreferencesGroup({title: 'Hide completely'});
    all.add(switchRow(settings, 'hidden', 'Hide the dock',
        'Nothing is shown, not even on hover. Open Shore from the app grid (Super, then type Shore) to turn it back on'));
    all.add(shortcutRow(window, settings, 'toggle-shortcut', 'Shortcut', 'Hides and shows the dock'));
    page.add(all);

    const auto = new Adw.PreferencesGroup({title: 'When the dock shows'});
    auto.add(showModeRow(settings));
    const mode = comboRow(settings, 'intellihide-mode', 'Windows that count',
        'Which windows make the dock step aside', [
            ['ALL_WINDOWS', 'All windows'], ['FOCUS_APPLICATION_WINDOWS', 'Windows of the focused app'],
            ['MAXIMIZED_WINDOWS', 'Maximized windows'], ['ALWAYS_ON_TOP', 'Always-on-top windows']]);
    dependsOn(settings, mode, () => showMode(settings) === 'dodge');
    auto.add(mode);
    const hides = () => ['dodge', 'autohide'].includes(showMode(settings));
    const full = switchRow(settings, 'autohide-fullscreen', 'Also hide in full screen');
    dependsOn(settings, full, hides);
    auto.add(full);
    page.add(auto);

    const reveal_ = new Adw.PreferencesGroup({title: 'Revealing'});
    const rows = [
        switchRow(settings, 'require-pressure', 'Push against the edge to reveal',
            'Off reveals the dock as soon as the pointer touches the edge'),
        spinRow(settings, 'show-delay', 'Reveal delay', 'Seconds', 0.05, 2),
        spinRow(settings, 'hide-delay', 'Hide delay', 'Seconds', 0.05, 2),
        spinRow(settings, 'animation-time', 'Animation time', 'Seconds the slide takes', 0.05, 2),
    ];
    for (const row of rows) {
        dependsOn(settings, row, hides);
        reveal_.add(row);
    }
    page.add(reveal_);
    return page;
}

export default class SpurPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        applySedge(window, `${this.path}/sedge`);
        window.set_title('Shore');
        const settings = this.getSettings();
        window.set_default_size(800, 920);

        // One view for the whole window, so the preview can stay in place
        // above the pages while they scroll.
        const stack = new Adw.ViewStack({vexpand: true});
        const pages = [
            ['presets', presetsPage(window, settings)],
            ['layout', layoutPage(settings)],
            ['look', lookPage(settings)],
            ['icons', itemsPage(window, settings, this.path)],
            ['widgets', widgetsPage(window, settings)],
            ['hiding', hidingPage(window, settings)],
        ];
        for (const [id, page] of pages)
            stack.add_titled_with_icon(page, id, page.title, page.icon_name);

        const header = new Adw.HeaderBar({
            title_widget: new Adw.ViewSwitcher({stack, policy: Adw.ViewSwitcherPolicy.WIDE}),
        });
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(previewPanel(settings));
        content.append(new Gtk.Separator());
        content.append(stack);

        const view = new Adw.ToolbarView({content});
        view.add_top_bar(header);
        toastOverlay = new Adw.ToastOverlay({child: view});
        window.connect('close-request', () => {
            toastOverlay = null;
            return false;
        });
        // The Extensions app insists on at least one page of its own kind,
        // so it gets an empty one before the real content replaces it.
        window.add(new Adw.PreferencesPage());
        window.set_content(toastOverlay);
    }
}
