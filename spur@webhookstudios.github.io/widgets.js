// Live information for the dock widgets. Everything except the weather is
// read from local system files; the weather asks open-meteo.com, and only
// when the weather widget is on and a place is set.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

// Finds the file that holds the CPU package temperature, in millidegrees.
function findTempFile() {
    const wanted = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal'];
    try {
        for (let i = 0; i < 20; i++) {
            const dir = `/sys/class/hwmon/hwmon${i}`;
            const name = readText(`${dir}/name`)?.trim();
            if (!name || !wanted.includes(name))
                continue;
            let fallback = null;
            for (let j = 1; j < 12; j++) {
                const file = `${dir}/temp${j}_input`;
                if (readText(file) === null)
                    continue;
                const label = readText(`${dir}/temp${j}_label`)?.trim() ?? '';
                if (/package|tctl|tdie/i.test(label))
                    return file;
                fallback ??= file;
            }
            if (fallback)
                return fallback;
        }
        for (let i = 0; i < 20; i++) {
            const type = readText(`/sys/class/thermal/thermal_zone${i}/type`)?.trim();
            if (type && /x86_pkg_temp|cpu/i.test(type))
                return `/sys/class/thermal/thermal_zone${i}/temp`;
        }
    } catch { /* no sensors */ }
    return null;
}

function formatRate(bytesPerSecond) {
    const kb = bytesPerSecond / 1024;
    if (kb < 1000)
        return `${Math.round(kb)} KB/s`;
    return `${(kb / 1024).toFixed(1)} MB/s`;
}

const WEATHER_ICONS = [
    [[0], 'weather-clear-symbolic'],
    [[1, 2], 'weather-few-clouds-symbolic'],
    [[3], 'weather-overcast-symbolic'],
    [[45, 48], 'weather-fog-symbolic'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], 'weather-showers-symbolic'],
    [[71, 73, 75, 77, 85, 86], 'weather-snow-symbolic'],
    [[95, 96, 99], 'weather-storm-symbolic'],
];

export class Stats {
    constructor(settings) {
        this._settings = settings;
        this._tempFile = undefined;
        this._lastCpu = null;
        this._lastNet = null;
        this._weather = null;
        this._weatherKey = '';
        this._weatherTime = 0;
        this._session = null;
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._session = null;
    }

    wantsAny() {
        return ['clock', 'date', 'weather', 'cpu-usage', 'cpu-temp', 'memory', 'network']
            .some(k => this._settings.get_boolean(`widget-${k}`));
    }

    // The list of things to show right now: [{id, icon?, text}].
    items() {
        const s = this._settings;
        const out = [];
        const showTime = s.get_boolean('widget-clock');
        const showDate = s.get_boolean('widget-date');
        if (showTime || showDate) {
            const now = GLib.DateTime.new_now_local();
            const time = showTime ? now.format(s.get_boolean('widgets-clock-24h') ? '%H:%M' : '%-I:%M %p') : null;
            // Side by side along a horizontal dock, stacked in a vertical one.
            out.push({
                id: 'clock',
                text: [time, showDate ? now.format('%a %-d %b') : null].filter(Boolean).join('   '),
                narrow: [time, showDate ? now.format('%-d %b') : null].filter(Boolean).join('\n'),
            });
        }
        if (s.get_boolean('widget-weather'))
            out.push(this._weatherItem());
        if (s.get_boolean('widget-cpu-usage')) {
            const usage = this._cpuUsage();
            out.push({id: 'cpu', text: `CPU ${usage}`, narrow: `CPU\n${usage}`});
        }
        if (s.get_boolean('widget-cpu-temp')) {
            const temp = this._cpuTemp();
            out.push({id: 'temp', text: temp, narrow: temp.replace(' ', '\n')});
        }
        if (s.get_boolean('widget-memory')) {
            const used = this._memory();
            out.push({id: 'mem', text: `RAM ${used}`, narrow: `RAM\n${used}`});
        }
        if (s.get_boolean('widget-network')) {
            const [down, up] = this._network();
            out.push({
                id: 'net', icon: 'network-transmit-receive-symbolic',
                text: `↓ ${down}   ↑ ${up}`,
                narrow: `↓${down.replace(/ |B\/s/g, '')}\n↑${up.replace(/ |B\/s/g, '')}`,
            });
        }
        return out;
    }

    _cpuUsage() {
        const line = readText('/proc/stat')?.split('\n')[0];
        if (!line)
            return '–';
        const f = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = f[3] + (f[4] ?? 0);
        const total = f.reduce((a, b) => a + b, 0);
        const last = this._lastCpu;
        this._lastCpu = {idle, total};
        if (!last || total === last.total)
            return '–';
        return `${Math.round(100 * (1 - (idle - last.idle) / (total - last.total)))}%`;
    }

    _cpuTemp() {
        if (this._tempFile === undefined)
            this._tempFile = findTempFile();
        if (!this._tempFile)
            return 'No sensor';
        const milli = Number(readText(this._tempFile));
        if (!Number.isFinite(milli))
            return 'No sensor';
        const c = milli / 1000;
        return this._settings.get_string('widgets-temp-unit') === 'F'
            ? `CPU ${Math.round(c * 9 / 5 + 32)}°F` : `CPU ${Math.round(c)}°C`;
    }

    _memory() {
        const text = readText('/proc/meminfo');
        if (!text)
            return '–';
        const total = Number(/MemTotal:\s+(\d+)/.exec(text)?.[1]);
        const avail = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1]);
        return total ? `${Math.round(100 * (1 - avail / total))}%` : '–';
    }

    _network() {
        const text = readText('/proc/net/dev');
        if (!text)
            return ['–', '–'];
        let rx = 0;
        let tx = 0;
        for (const line of text.split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest || /^\s*(lo|docker|veth|virbr|br-)/.test(name))
                continue;
            const f = rest.trim().split(/\s+/).map(Number);
            rx += f[0];
            tx += f[8];
        }
        const now = GLib.get_monotonic_time() / 1e6;
        const last = this._lastNet;
        this._lastNet = {rx, tx, now};
        if (!last || now <= last.now)
            return ['–', '–'];
        const dt = now - last.now;
        return [formatRate(Math.max(0, rx - last.rx) / dt), formatRate(Math.max(0, tx - last.tx) / dt)];
    }

    // Weather ------------------------------------------------------------------

    _weatherItem() {
        const s = this._settings;
        const lat = s.get_double('weather-lat');
        const lon = s.get_double('weather-lon');
        if (!s.get_string('weather-place') && lat === 0 && lon === 0)
            return {id: 'weather', text: 'Set a place'};

        const unit = s.get_string('widgets-temp-unit');
        const key = `${lat},${lon},${unit}`;
        const stale = GLib.get_monotonic_time() / 1e6 - this._weatherTime > 20 * 60;
        if (key !== this._weatherKey || stale)
            this._fetchWeather(lat, lon, unit, key);
        return this._weather && this._weatherKey === key
            ? {id: 'weather', icon: this._weather.icon, text: this._weather.text}
            : {id: 'weather', text: 'Weather…'};
    }

    _fetchWeather(lat, lon, unit, key) {
        // Only one request at a time, and not again for a minute after any try.
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._fetching || (this._lastTry && now - this._lastTry < 60 && key === this._weatherKey))
            return;
        this._fetching = true;
        this._lastTry = now;
        this._session ??= new Soup.Session({timeout: 15});
        const url = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code' +
            `&latitude=${lat}&longitude=${lon}&temperature_unit=${unit === 'F' ? 'fahrenheit' : 'celsius'}`;
        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            this._fetching = false;
            try {
                const bytes = session.send_and_read_finish(result);
                const current = JSON.parse(decoder.decode(bytes.get_data())).current;
                const code = current.weather_code;
                const icon = WEATHER_ICONS.find(([codes]) => codes.includes(code))?.[1] ?? 'weather-overcast-symbolic';
                this._weather = {icon, text: `${Math.round(current.temperature_2m)}°${unit}`};
                this._weatherKey = key;
                this._weatherTime = GLib.get_monotonic_time() / 1e6;
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Spur: weather request failed: ${e.message}`);
            }
        });
    }
}
