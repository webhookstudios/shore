// Applies a built-in preset to the settings, the same way the settings
// window does. Usage: gjs -m test/preset.mjs <preset-id> [key=value ...]
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {applyValues, sanitize} from '../shore@webhookstudios.github.io/model.js';
import {BUILTIN_PRESETS} from '../shore@webhookstudios.github.io/presets.js';

const dir = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')),
    '..', 'shore@webhookstudios.github.io', 'schemas']);
const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.shore', false)});

const [id, ...extra] = ARGV;
const preset = BUILTIN_PRESETS.find(p => p.id === id);
if (!preset) {
    print(`no preset ${id}; have: ${BUILTIN_PRESETS.map(p => p.id).join(', ')}`);
    imports.system.exit(1);
}
const values = {...preset.values};
for (const pair of extra) {
    const [k, v] = pair.split('=');
    values[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
}
const clean = sanitize(settings, values);
const dropped = Object.keys(values).filter(k => !(k in clean));
if (dropped.length)
    print(`INVALID in preset ${id}: ${dropped.join(', ')}`);
applyValues(settings, clean);
settings.set_string('current-preset', id);
Gio.Settings.sync();
print(`applied ${id}`);
