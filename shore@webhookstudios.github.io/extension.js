import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DOCK_SCHEMA, dockValues, readTyped, setTyped} from './model.js';
import {buildCss} from './css.js';
import {Stats} from './widgets.js';

const DOCK_NAME = 'dashtodockContainer';
const MARKERS = ['dm', 'dm-on', 'dm-style'];

// Pivot (as a fraction of the icon) that keeps a growing icon attached to
// the screen edge, by dock position.
const PIVOT = {
    BOTTOM: [0.5, 1.0],
    TOP: [0.5, 0.0],
    LEFT: [0.0, 0.5],
    RIGHT: [1.0, 0.5],
};

// Cuts an actor to a rounded rectangle. Clutter can only clip to plain
// rectangles, so this fades out everything outside the rounded shape.
const RoundedClip = GObject.registerClass(
class ShoreRoundedClip extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._sizeLocation = this.get_uniform_location('shore_size');
        this._radiusLocation = this.get_uniform_location('shore_radius');
        this.setShape(1, 1, 0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            'uniform vec2 shore_size;\nuniform float shore_radius;\n',
            'vec2 shore_p = cogl_tex_coord_in[0].st * shore_size;\n' +
            'vec2 shore_q = abs(shore_p - shore_size * 0.5) - (shore_size * 0.5 - vec2(shore_radius));\n' +
            'float shore_d = length(max(shore_q, 0.0)) + min(max(shore_q.x, shore_q.y), 0.0) - shore_radius;\n' +
            'cogl_color_out *= 1.0 - smoothstep(-0.75, 0.75, shore_d);\n',
            false);
    }

    setShape(width, height, radius) {
        const r = Math.max(0, Math.min(radius, width / 2, height / 2));
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.set_uniform_float(this._radiusLocation, 1, [r]);
        this.queue_repaint();
    }
});

// Everything we do to one dock that the dock's own settings cannot do:
// marker classes, blur, icon magnification and hiding it completely.
class DockDecor {
    constructor(dock, settings, extensionDir) {
        this._dock = dock;
        this._extensionDir = extensionDir;
        this._hidByUs = false;
        this._settings = settings;
        this._hiding = false;
        this._ids = [];
        this._boxIds = [];
        this._appsIconPatched = null;

        this._connect(dock, 'notify::visible', () => {
            if (this._wantHidden() && dock.visible)
                this._hide();
        });
        this._connect(dock, 'notify::mapped', () => this.refresh());
        this._attachMagnifier();
        this.refresh();
    }

    _connect(obj, signal, callback) {
        this._ids.push([obj, obj.connect(signal, callback)]);
    }

    _wantHidden() {
        return this._settings.get_boolean('enabled') && this._settings.get_boolean('hidden');
    }

    _hide() {
        if (this._hiding)
            return;
        this._hiding = true;
        this._dock.visible = false;
        this._hiding = false;
    }

    get _background() {
        return this._dock.dash?._background ?? null;
    }

    refresh() {
        const dock = this._dock;
        const on = this._settings.get_boolean('enabled');

        for (const name of MARKERS) {
            if (on)
                dock.add_style_class_name(name);
            else
                dock.remove_style_class_name(name);
        }

        if (this._wantHidden()) {
            this._hide();
        } else if (!dock.visible && this._hidByUs) {
            dock.visible = true;
        }
        this._hidByUs = this._wantHidden();

        this._updateUnder(on && !this._wantHidden());
        this._updateAppsIcon(on);
        if (!on || !this._settings.get_boolean('magnify'))
            this._resetMagnification(false);
    }

    // Under the dock: frosted glass ----------------------------------------------
    //
    // The dock draws itself into an offscreen buffer, so a blur placed inside
    // it has no desktop to blur and shows as a square. Instead a separate
    // actor sits right under the dock: a blurred copy of the wallpaper, cut
    // to the dock's rounded shape, that follows the dock around.

    _updateUnder(on) {
        const s = this._settings;
        if (!(on && s.get_boolean('blur'))) {
            this._removeBlur();
            this._unwatchUnder();
            return;
        }
        if (!this._blurHolder)
            this._createBlur();
        if (this._blurEffect)
            this._blurEffect.radius = s.get_int('blur-strength') * 2;
        if (this._blurHolder) {
            this._watchUnder();
            this._syncUnder();
        }
    }

    _createBlur() {
        const dock = this._dock;
        const index = dock.monitorIndex ?? Main.layoutManager.primaryIndex;
        const source = Main.layoutManager._bgManagers?.[index]?.backgroundActor;
        const monitor = Main.layoutManager.monitors[index];
        if (!source?.content || !monitor)
            return;
        try {
            const wallpaper = new Meta.BackgroundActor({meta_display: global.display, monitor: index});
            wallpaper.content.set({background: source.content.background});
            wallpaper.set_size(monitor.width, monitor.height);
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: 1.0});
            wallpaper.add_effect(this._blurEffect);

            this._roundEffect = new RoundedClip();
            const holder = new Clutter.Actor({clip_to_allocation: true, reactive: false});
            holder.add_child(wallpaper);
            holder.add_effect(this._roundEffect);
            Main.uiGroup.insert_child_below(holder, dock);
            holder.connect('destroy', () => {
                this._blurHolder = null;
                this._blurWallpaper = null;
                this._blurEffect = null;
                this._roundEffect = null;
            });
            this._blurHolder = holder;
            this._blurWallpaper = wallpaper;
            this._blurMonitor = monitor;
        } catch (e) {
            console.warn(`Shore: frosted glass is not available: ${e.message}`);
            this._removeBlur();
        }
    }

    _removeBlur() {
        this._blurHolder?.destroy();
        this._blurHolder = null;
        this._blurWallpaper = null;
        this._blurEffect = null;
        this._roundEffect = null;
    }

    // Follow the dock: its size, its slide in and out, and the wallpaper.
    _watchUnder() {
        if (this._underIds)
            return;
        const dock = this._dock;
        this._underIds = [];
        const watch = (obj, signal, fn = () => this._queueUnderSync()) => {
            if (obj)
                this._underIds.push([obj, obj.connect(signal, fn)]);
        };
        watch(this._background, 'notify::allocation');
        watch(dock._box, 'notify::allocation');
        watch(dock._slider, 'notify::allocation');
        watch(dock._slider, 'notify::slide-x');
        watch(dock, 'notify::allocation');
        watch(dock, 'notify::visible');
        watch(dock, 'notify::mapped');
        watch(dock, 'notify::opacity');
        watch(dock.dash, 'notify::opacity');
        watch(Main.layoutManager._bgManagers?.[dock.monitorIndex ?? 0], 'changed', () => {
            // The wallpaper actor is replaced when the picture changes.
            this._removeBlur();
            this.refresh();
        });
    }

    _unwatchUnder() {
        for (const [obj, id] of this._underIds ?? [])
            obj.disconnect(id);
        this._underIds = null;
        if (this._underLater) {
            global.compositor.get_laters().remove(this._underLater);
            this._underLater = 0;
        }
    }

    _queueUnderSync() {
        if (this._underLater)
            return;
        // Positions are only right once the current layout pass is done.
        this._underLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._underLater = 0;
            this._syncUnder();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The visible shape of the dock on screen, or null while it is not shown.
    _shape() {
        const dock = this._dock;
        const bg = this._background;
        if (!bg || !dock.visible || !dock.mapped || !bg.mapped)
            return null;
        // The background widget minus its CSS margins.
        const node = bg.get_theme_node();
        const [x, y] = bg.get_transformed_position();
        const [w, h] = bg.get_transformed_size();
        const left = node.get_margin(St.Side.LEFT);
        const top = node.get_margin(St.Side.TOP);
        const width = Math.round(w - left - node.get_margin(St.Side.RIGHT));
        const height = Math.round(h - top - node.get_margin(St.Side.BOTTOM));
        if (!(width > 0 && height > 0) || Number.isNaN(x))
            return null;
        return {
            x: Math.round(x + left), y: Math.round(y + top), width, height,
            radius: Math.min(node.get_border_radius(St.Corner.TOPLEFT), width / 2, height / 2),
            opacity: Math.round(dock.opacity * (dock.dash?.opacity ?? 255) / 255),
        };
    }

    _syncUnder() {
        const shape = this._shape();
        const holder = this._blurHolder;
        if (!holder)
            return;
        if (!shape) {
            holder.hide();
            return;
        }
        if (holder.x !== shape.x || holder.y !== shape.y)
            holder.set_position(shape.x, shape.y);
        if (holder.width !== shape.width || holder.height !== shape.height)
            holder.set_size(shape.width, shape.height);
        // Keep the wallpaper where the real one is, wherever the holder goes.
        this._blurWallpaper.set_position(
            this._blurMonitor.x - shape.x, this._blurMonitor.y - shape.y);
        this._roundEffect.setShape(shape.width, shape.height, shape.radius);
        if (holder.opacity !== shape.opacity)
            holder.opacity = shape.opacity;
        // Re-stacking triggers a new layout of the whole stage, which would
        // call this again, so only do it when the order is really wrong.
        if (holder.get_next_sibling() !== this._dock)
            Main.uiGroup.set_child_below_sibling(holder, this._dock);
        if (!holder.visible)
            holder.show();
    }

    _removeUnder() {
        this._unwatchUnder();
        this._removeBlur();
    }

    // Corner button logo -------------------------------------------------------

    _updateAppsIcon(on) {
        const button = this._dock.dash?._showAppsIcon;
        const baseIcon = button?.icon;
        if (!baseIcon)
            return;

        const mode = on ? this._settings.get_string('apps-icon') : 'default';
        let gicon = null;
        if (mode === 'custom') {
            const path = this._settings.get_string('apps-icon-path');
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS))
                gicon = Gio.icon_new_for_string(path);
        } else if (mode !== 'default') {
            const file = GLib.build_filenamev([this._extensionDir, 'media', `${mode}-symbolic.svg`]);
            if (GLib.file_test(file, GLib.FileTest.EXISTS))
                gicon = Gio.icon_new_for_string(file);
        }

        if (this._appsIconPatched === (gicon?.to_string() ?? null))
            return;
        this._appsIconPatched = gicon?.to_string() ?? null;

        // The shell's icon builds its picture through `createIcon`, so
        // swapping that function and asking for a redraw is enough.
        if (!baseIcon._dmOriginalCreateIcon)
            baseIcon._dmOriginalCreateIcon = baseIcon.createIcon;
        baseIcon.createIcon = gicon
            ? size => new St.Icon({gicon, icon_size: size, style_class: 'shore-apps-icon'})
            : baseIcon._dmOriginalCreateIcon;
        try {
            baseIcon.setIconSize(baseIcon.iconSize);
            baseIcon._createIconTexture?.(baseIcon.iconSize);
        } catch (e) {
            console.warn(`Shore: could not redraw the Show Apps icon: ${e.message}`);
        }
    }

    // Magnification ---------------------------------------------------------

    _attachMagnifier() {
        const box = this._dock._box;
        this._magBox = box;
        // Captured events reach the box before the icons can swallow them.
        this._boxIds.push(box.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.MOTION)
                this._magnify(event);
            return Clutter.EVENT_PROPAGATE;
        }));
        this._boxIds.push(box.connect('notify::hover', () => {
            if (!box.hover)
                this._resetMagnification(true);
        }));
    }

    // Everything in the icon row, in order: [slot, actor to move]. The slot
    // is the layout position, which never moves; the actor inside it does.
    _slots() {
        const dash = this._dock.dash;
        const out = [];
        for (const item of dash?._box?.get_children() ?? []) {
            if (item.visible)
                out.push([item, item.child ?? item, !!item.child]);
        }
        const apps = dash?._showAppsIcon;
        if (apps?.visible && apps.get_parent() && apps.child) {
            const entry = [apps, apps.child, true];
            if (this._settings.get_string('apps-position') === 'start')
                out.unshift(entry);
            else
                out.push(entry);
        }
        return out;
    }

    _magnify(event) {
        const s = this._settings;
        if (!s.get_boolean('enabled') || !s.get_boolean('magnify') || this._wantHidden())
            return;
        const pos = s.get_string('position');
        const horizontal = pos === 'BOTTOM' || pos === 'TOP';
        const maxScale = s.get_double('magnify-scale');
        const cell = s.get_int('icon-size') + s.get_int('icon-spacing');
        const sigma = Math.max(1, s.get_double('magnify-range') * cell / 2);
        const [px, py] = event.get_coords();
        const pointer = horizontal ? px : py;
        const [pivotX, pivotY] = PIVOT[pos] ?? PIVOT.BOTTOM;

        // Measure the slots, then give each a scale by its distance to the pointer.
        const slots = this._slots().map(([slot, actor, scalable]) => {
            const [x, y] = slot.get_transformed_position();
            const [w, h] = slot.get_transformed_size();
            const start = horizontal ? x : y;
            const size = horizontal ? w : h;
            const d = pointer - (start + size / 2);
            const scale = scalable ? 1 + (maxScale - 1) * Math.exp(-(d * d) / (2 * sigma * sigma)) : 1;
            return {actor, start, size, scale};
        });
        if (slots.length === 0)
            return;

        // Grown icons push their neighbours aside. The row grows around the
        // pointer, so the icon under it stays under it.
        const first = slots[0].start;
        const last = slots[slots.length - 1];
        const length = Math.max(1, last.start + last.size - first);
        const grown = slots.reduce((sum, slot) => sum + slot.size * (slot.scale - 1), 0);
        const fraction = Math.max(0, Math.min(1, (pointer - first) / length));
        let at = first - grown * fraction;
        this._setUnclipped(true);
        this._magnified = true;
        for (const slot of slots) {
            const size = slot.size * slot.scale;
            const shift = at + size / 2 - (slot.start + slot.size / 2);
            at += size;
            slot.actor.remove_all_transitions();
            slot.actor.set_pivot_point(pivotX, pivotY);
            slot.actor.set_scale(slot.scale, slot.scale);
            if (horizontal)
                slot.actor.translation_x = shift;
            else
                slot.actor.translation_y = shift;
        }
    }

    // The dock clips its contents to its own box, which would cut grown
    // icons off. The clip is lifted while icons are magnified and put back
    // afterwards, because the hide animation relies on it.
    _setUnclipped(on) {
        const box = this._dock._box;
        const viewport = this._dock.dash?._boxContainer;
        if (on && !this._clipId) {
            this._clipId = box.connect('notify::has-clip', () => {
                if (box.has_clip)
                    box.remove_clip();
            });
            box.remove_clip();
            if (viewport && 'clip_to_view' in viewport) {
                this._hadClipToView = viewport.clip_to_view;
                viewport.clip_to_view = false;
            }
        } else if (!on && this._clipId) {
            box.disconnect(this._clipId);
            this._clipId = 0;
            if (viewport && this._hadClipToView !== undefined)
                viewport.clip_to_view = this._hadClipToView;
            this._dock._slider?.queue_relayout();
        }
    }

    _resetMagnification(animate) {
        if (!this._magnified)
            return;
        this._magnified = false;
        this._setUnclipped(false);
        for (const [, actor] of this._slots()) {
            if (animate) {
                actor.ease({
                    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                actor.remove_all_transitions();
                actor.set_scale(1, 1);
                actor.translation_x = 0;
                actor.translation_y = 0;
            }
        }
    }

    // Info widgets -----------------------------------------------------------

    setWidgets(items) {
        const s = this._settings;
        const show = s.get_boolean('enabled') && items.length > 0 && !this._wantHidden();
        if (!show) {
            this._removeWidgets();
            return;
        }
        const pos = s.get_string('position');
        const horizontal = pos === 'BOTTOM' || pos === 'TOP';
        const where = s.get_string('widgets-position');
        const key = [pos, where, s.get_int('widgets-font-size'), ...items.map(i => `${i.id}${i.icon ?? ''}`)].join('|');

        const container = this._dock.dash?._dashContainer;
        if (!container)
            return;
        if (!this._widgetBox || this._widgetKey !== key) {
            this._removeWidgets();
            const holder = new St.BoxLayout({
                name: 'dm-widgets', style_class: 'dm-widgets', vertical: !horizontal,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                x_expand: false, y_expand: false,
            });
            this._labels = new Map();
            for (const item of items) {
                const row = new St.BoxLayout({
                    style_class: 'dm-widget', vertical: !horizontal,
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                });
                if (item.icon) {
                    row.add_child(new St.Icon({
                        icon_name: item.icon, style_class: 'dm-widget-icon',
                        icon_size: s.get_int('widgets-font-size') + 6,
                        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                    }));
                }
                const label = new St.Label({
                    style_class: 'dm-widget-label',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(label);
                this._labels.set(item.id, label);
                holder.add_child(row);
            }
            container.add_child(holder);
            this._widgetBox = holder;
            this._widgetKey = key;
        }
        // The dock moves its own button around, so put ours back at the end
        // (or start) every time.
        if (where === 'start')
            container.set_child_below_sibling(this._widgetBox, null);
        else
            container.set_child_above_sibling(this._widgetBox, null);
        for (const item of items) {
            const label = this._labels.get(item.id);
            const text = horizontal ? item.text : item.narrow ?? item.text;
            if (label && label.text !== text)
                label.text = text;
        }
    }

    _removeWidgets() {
        if (!this._widgetBox)
            return;
        this._widgetBox.destroy();
        this._widgetBox = null;
        this._widgetKey = '';
        this._labels = null;
    }

    dockGone() {
        this._underIds = null;
        this._removeUnder();
    }

    destroy() {
        this._removeWidgets();
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        for (const id of this._boxIds)
            this._magBox.disconnect(id);
        this._boxIds = [];

        this._resetMagnification(false);
        this._removeUnder();
        this._updateAppsIcon(false);
        for (const name of MARKERS)
            this._dock.remove_style_class_name(name);
        if (this._hidByUs)
            this._dock.visible = true;
    }
}

export default class ShoreExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._decors = new Map();
        this._pending = new Map();
        this._stats = new Stats(this._settings);
        this._cssSerial = 0;
        this._cssFile = null;
        this._cssDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'shore']);

        const source = Gio.SettingsSchemaSource.get_default();
        this._dockSettings = source.lookup(DOCK_SCHEMA, true)
            ? new Gio.Settings({schema_id: DOCK_SCHEMA}) : null;
        if (!this._dockSettings)
            console.warn('Shore: the Ubuntu dock settings were not found, only the stylesheet is applied.');

        this._settingsId = this._settings.connect('changed', () => this._queue());
        this._uiId = Main.uiGroup.connect('child-added', (_group, child) => this._adopt(child));

        Main.wm.addKeybinding('toggle-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.ALL, () => {
                this._settings.set_boolean('hidden', !this._settings.get_boolean('hidden'));
            });

        this._sync();
        for (const child of Main.uiGroup.get_children())
            this._adopt(child);
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');
        if (this._queueId) {
            GLib.source_remove(this._queueId);
            this._queueId = 0;
        }
        Main.uiGroup.disconnect(this._uiId);
        this._settings.disconnect(this._settingsId);

        if (this._statsId) {
            GLib.source_remove(this._statsId);
            this._statsId = 0;
        }
        for (const id of this._pending.values())
            GLib.source_remove(id);
        this._pending = null;
        for (const [dock, entry] of this._decors) {
            dock.disconnect(entry.destroyId);
            entry.decor.destroy();
        }
        this._decors = null;
        this._stats.destroy();
        this._stats = null;
        this._unloadCss();
        this._dockSettings = null;
        this._settings = null;
    }

    // Applying settings -------------------------------------------------------

    _queue() {
        if (this._queueId)
            return;
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._queueId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const s = this._settings;
        if (s.get_boolean('enabled')) {
            this._writeDockSettings();
            this._loadCss();
        } else {
            this._unloadCss();
        }
        for (const entry of this._decors.values())
            entry.decor.refresh();
        this._updateWidgets();
    }

    _updateWidgets() {
        const wanted = this._settings.get_boolean('enabled') && this._stats.wantsAny();
        if (wanted && !this._statsId) {
            this._statsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._pushWidgets();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._statsId) {
            GLib.source_remove(this._statsId);
            this._statsId = 0;
        }
        this._pushWidgets(wanted);
    }

    _pushWidgets(wanted = true) {
        const items = wanted ? this._stats.items() : [];
        for (const entry of this._decors.values())
            entry.decor.setWidgets(items);
    }

    _writeDockSettings() {
        if (!this._dockSettings)
            return;
        const values = dockValues(key => readTyped(this._settings, key));
        const keys = new Set(this._dockSettings.settings_schema.list_keys());
        // Holding the writes back until all are set keeps the dock from
        // being rebuilt once per key.
        this._dockSettings.delay();
        for (const [key, value] of Object.entries(values)) {
            if (!keys.has(key))
                continue;
            try {
                setTyped(this._dockSettings, key, value);
            } catch (e) {
                console.warn(`Shore: could not set ${key}: ${e.message}`);
            }
        }
        this._dockSettings.apply();
    }

    _loadCss() {
        const css = buildCss(key => readTyped(this._settings, key));
        GLib.mkdir_with_parents(this._cssDir, 0o755);
        // A new file name each time, because the theme keeps files it has
        // already read.
        const path = GLib.build_filenamev([this._cssDir, `style-${GLib.get_monotonic_time()}-${this._cssSerial++}.css`]);
        const file = Gio.File.new_for_path(path);
        file.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.NONE, null);

        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const previous = this._cssFile;
        theme.load_stylesheet(file);
        if (previous) {
            theme.unload_stylesheet(previous);
            try { previous.delete(null); } catch { /* already gone */ }
        }
        this._cssFile = file;
    }

    _unloadCss() {
        if (!this._cssFile)
            return;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.unload_stylesheet(this._cssFile);
        try { this._cssFile.delete(null); } catch { /* already gone */ }
        this._cssFile = null;
    }

    // Docks ---------------------------------------------------------------------

    // The dock adds itself to the stage half-way through being built, so
    // adopting waits until the shell is idle and the dock is complete.
    _adopt(child) {
        if (child.name !== DOCK_NAME || this._decors.has(child) || this._pending.has(child))
            return;
        if (child._box && child.dash) {
            this._adoptNow(child);
            return;
        }
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pending.delete(child);
            if (child._box && child.dash && child.get_parent())
                this._adoptNow(child);
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(child, id);
    }

    _adoptNow(child) {
        if (this._decors.has(child))
            return;
        const decor = new DockDecor(child, this._settings, this.path);
        const destroyId = child.connect('destroy', () => {
            // The dock replaces itself when some settings change. What we
            // put next to it, outside it, has to go too.
            decor.dockGone();
            this._decors?.delete(child);
        });
        this._decors.set(child, {decor, destroyId});
        this._updateWidgets();
    }
}
