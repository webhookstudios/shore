// A small drawing of the dock, used for the live preview and on every preset
// card. It follows the same layout rules as css.js and the Ubuntu dock, so
// what you see is close to what you get. (It cannot show blur.)

import Gtk from 'gi://Gtk';

const SCREEN_W = 1280;
const SCREEN_H = 800;
const TOP_BAR = 32;
const INDICATOR_ROOM = 6;
const PALETTE = ['#e95420', '#3584e4', '#57e389', '#f6d32d', '#c061cb', '#ff7800'];

function rgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

function color(cr, hex, alpha = 1) {
    const [r, g, b] = rgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

function roundRect(cr, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const WIDGETS = ['clock', 'date', 'weather', 'cpu-usage', 'cpu-temp', 'memory', 'network'];

// Work out where the dock and everything in it sits, in screen pixels.
function layout(get) {
    const pos = get('position');
    const horizontal = pos === 'BOTTOM' || pos === 'TOP';
    const icon = get('icon-size');
    const pad = get('padding');
    const spacing = get('icon-spacing');
    const cell = icon + spacing;

    const kinds = ['app', 'app', 'app', 'app'];
    if (get('show-trash'))
        kinds.push('trash');
    const appsOn = get('show-apps-button');
    const appsAtStart = get('apps-position') === 'start';
    const extend = get('extend');
    // In a stretched dock the corner button can sit at the far end.
    const appsApart = appsOn && extend && get('apps-at-edge');
    if (appsOn && !appsApart) {
        if (appsAtStart)
            kinds.unshift('apps');
        else
            kinds.push('apps');
    }

    const widgetCount = WIDGETS.filter(k => get(`widget-${k}`)).length;
    const font = get('widgets-font-size');
    const widgetUnit = horizontal ? font * 6 : font * 3.2;
    const widgetLen = widgetCount ? widgetCount * widgetUnit + 12 : 0;
    const widgetsAtStart = get('widgets-position') === 'start';

    const iconsLen = kinds.length * icon + (kinds.length - 1) * spacing;
    const content = 2 * pad + iconsLen + widgetLen + (appsApart ? cell : 0);
    const thickness = icon + 2 * pad + INDICATOR_ROOM;
    const axisStart = horizontal ? 0 : TOP_BAR;
    const axisLen = horizontal ? SCREEN_W : SCREEN_H - TOP_BAR;
    const gap = get('edge-gap');

    let length;
    let start;
    if (extend) {
        const side = get('side-gap');
        length = Math.max(60, axisLen - 2 * side);
        start = axisStart + side;
    } else {
        length = Math.min(content, axisLen * get('length') / 100);
        start = axisStart + (axisLen - length) / 2;
    }

    let rect;
    if (horizontal) {
        rect = {x: start, y: pos === 'BOTTOM' ? SCREEN_H - gap - thickness : TOP_BAR + gap, w: length, h: thickness};
    } else {
        rect = {x: pos === 'LEFT' ? gap : SCREEN_W - gap - thickness, y: start, w: thickness, h: length};
    }

    // Free run for the icons, between whatever is fixed at the two ends.
    let lo = start + pad;
    let hi = start + length - pad;
    let widgetsAt = null;
    let appsAt = null;
    if (appsApart) {
        if (appsAtStart) {
            appsAt = lo;
            lo += cell;
        } else {
            appsAt = hi - icon;
            hi -= cell;
        }
    }
    if (widgetLen) {
        if (widgetsAtStart) {
            widgetsAt = lo;
            lo += widgetLen;
        } else {
            widgetsAt = hi - widgetLen;
            hi -= widgetLen;
        }
    }
    let first = lo;
    if (extend && get('align') === 'center')
        first = Math.max(lo, start + (length - iconsLen) / 2);
    first = Math.min(first, Math.max(lo, hi - iconsLen));

    return {pos, horizontal, icon, pad, spacing, cell, kinds, rect, first, appsAt,
        widgetsAt, widgetLen, widgetCount, widgetUnit};
}

// Icon sizes and positions along the dock, with magnification: icons near
// the pointer grow and push their neighbours aside.
function placeIcons(L, get) {
    const n = L.kinds.length;
    const pointer = Math.min(2, n - 1);
    const sigma = Math.max(1, get('magnify-range') * L.cell / 2);
    const sizes = L.kinds.map((_kind, i) => {
        if (!get('magnify'))
            return L.icon;
        const d = (i - pointer) * L.cell;
        return L.icon * (1 + (get('magnify-scale') - 1) * Math.exp(-(d * d) / (2 * sigma * sigma)));
    });
    const grown = sizes.reduce((a, s) => a + s - L.icon, 0);
    let at = L.first - grown * (pointer + 0.5) / n;
    return sizes.map(size => {
        const here = at;
        at += size + L.spacing;
        return {along: here, size};
    });
}

// Options: `focus` zooms in on the dock instead of showing the whole screen.
export function drawDock(cr, width, height, get, {focus = false} = {}) {
    const L = layout(get);
    const {x, y, w, h} = L.rect;

    cr.save();
    roundRect(cr, 0, 0, width, height, focus ? 12 : Math.min(width, height) * 0.06);
    cr.clip();
    color(cr, '#5c2349');
    cr.paint();

    let scale;
    if (focus) {
        const margin = 36;
        scale = Math.min(width / (w + 2 * margin), height / (h + 2 * margin), 1.6);
        cr.translate(width / 2 - (x + w / 2) * scale, height / 2 - (y + h / 2) * scale);
    } else {
        scale = Math.max(width / SCREEN_W, height / SCREEN_H);
        cr.translate((width - SCREEN_W * scale) / 2, (height - SCREEN_H * scale) / 2);
    }
    cr.scale(scale, scale);

    // Wallpaper and top bar.
    color(cr, '#8a3a6b', 0.55);
    cr.arc(SCREEN_W * 0.78, SCREEN_H * 0.2, 420, 0, 2 * Math.PI);
    cr.fill();
    color(cr, '#2a0f24', 0.5);
    cr.arc(SCREEN_W * 0.25, SCREEN_H * 0.9, 380, 0, 2 * Math.PI);
    cr.fill();
    color(cr, '#000000', 0.85);
    cr.rectangle(-SCREEN_W, 0, SCREEN_W * 3, TOP_BAR);
    cr.fill();
    color(cr, '#ffffff', 0.8);
    roundRect(cr, SCREEN_W / 2 - 50, 10, 100, 12, 6);
    cr.fill();

    const radius = get('radius');
    cr.pushGroup();

    if (get('shadow')) {
        const blur = get('shadow-blur');
        const offset = get('shadow-offset');
        const [dx, dy] = {BOTTOM: [0, -offset], TOP: [0, offset], LEFT: [offset, 0], RIGHT: [-offset, 0]}[L.pos];
        const steps = 8;
        for (let i = steps; i >= 1; i--) {
            const grow = blur / 2 * Math.pow(i / steps, 0.65);
            color(cr, get('shadow-color'), get('shadow-opacity') / steps * 0.9);
            roundRect(cr, x + dx - grow, y + dy - grow, w + 2 * grow, h + 2 * grow, radius + grow);
            cr.fill();
        }
    }

    // Background and border.
    roundRect(cr, x, y, w, h, radius);
    color(cr, get('bg-color'), get('bg-opacity'));
    cr.fill();
    const bw = get('border-width');
    if (bw > 0) {
        roundRect(cr, x + bw / 2, y + bw / 2, w - bw, h - bw, Math.max(0, radius - bw / 2));
        color(cr, get('border-color'), get('border-opacity'));
        cr.setLineWidth(bw);
        cr.stroke();
    }

    // Where an icon of `size` starting at `along` goes; it grows away
    // from the screen edge.
    const box = (along, size) => {
        const cross = L.horizontal
            ? (L.pos === 'BOTTOM' ? y + L.pad : y + L.pad + INDICATOR_ROOM)
            : (L.pos === 'RIGHT' ? x + L.pad : x + L.pad + INDICATOR_ROOM);
        let ix = L.horizontal ? along : cross;
        let iy = L.horizontal ? cross : along;
        if (L.pos === 'BOTTOM')
            iy -= size - L.icon;
        if (L.pos === 'RIGHT')
            ix -= size - L.icon;
        return [ix, iy];
    };
    const drawApps = (ix, iy, size) => {
        if (get('apps-accent')) {
            roundRect(cr, ix - 2, iy - 2, size + 4, size + 4, get('highlight-radius'));
            color(cr, get('apps-accent-color'));
            cr.fill();
        }
        drawAppsIcon(cr, ix, iy, size, get('apps-icon'));
    };

    if (L.appsAt !== null)
        drawApps(...box(L.appsAt, L.icon), L.icon);

    let appNumber = 0;
    placeIcons(L, get).forEach(({along, size}, i) => {
        const kind = L.kinds[i];
        const [ix, iy] = box(along, size);
        if (kind === 'apps') {
            drawApps(ix, iy, size);
        } else if (kind === 'trash') {
            roundRect(cr, ix + size * 0.22, iy + size * 0.12, size * 0.56, size * 0.76, size * 0.1);
            color(cr, '#b8bcc4');
            cr.fill();
        } else {
            if (appNumber === 0) {
                roundRect(cr, ix - 2, iy - 2, size + 4, size + 4, get('highlight-radius'));
                color(cr, get('highlight-color'), get('highlight-opacity'));
                cr.fill();
            }
            roundRect(cr, ix, iy, size, size, size * 0.22);
            color(cr, PALETTE[appNumber % PALETTE.length]);
            cr.fill();
            if (appNumber < 2)
                drawIndicator(cr, L, get, ix, iy, size);
            appNumber++;
        }
    });

    // Info widgets: short lines standing in for text.
    if (L.widgetsAt !== null) {
        color(cr, get('widgets-text-color'), 0.9);
        const bar = Math.max(3, get('widgets-font-size') * 0.45);
        for (let i = 0; i < L.widgetCount; i++) {
            const along = L.widgetsAt + 6 + i * L.widgetUnit;
            const len = L.widgetUnit * 0.72;
            for (const [line, part] of [[-1, 1], [1, 0.6]]) {
                if (L.horizontal) {
                    roundRect(cr, along, y + h / 2 + line * bar * 1.2 - bar / 2, len * part, bar, bar / 2);
                } else {
                    const span = w - 2 * L.pad;
                    roundRect(cr, x + L.pad + span * (1 - part) / 2, along + len / 2 + line * bar * 1.2 - bar / 2,
                        span * part, bar, bar / 2);
                }
                cr.fill();
            }
        }
    }

    cr.popGroupToSource();
    cr.paintWithAlpha(get('hidden') || !get('enabled') ? 0.2 : 1);
    cr.restore();
}

function drawAppsIcon(cr, x, y, size, mode) {
    color(cr, '#ffffff', 0.92);
    const c = size / 2;
    const at = (u, v) => [x + size * u, y + size * v];
    const poly = pts => {
        cr.newPath();
        pts.forEach(([u, v], i) => (i ? cr.lineTo(...at(u, v)) : cr.moveTo(...at(u, v))));
        cr.closePath();
        cr.fill();
    };
    switch (mode) {
    case 'hexagon':
        poly([[0.5, 0.1], [0.85, 0.3], [0.85, 0.7], [0.5, 0.9], [0.15, 0.7], [0.15, 0.3]]);
        break;
    case 'flower':
        for (let i = 0; i < 5; i++) {
            const a = i * 2 * Math.PI / 5 - Math.PI / 2;
            cr.arc(x + c + Math.cos(a) * size * 0.22, y + c + Math.sin(a) * size * 0.22, size * 0.16, 0, 2 * Math.PI);
            cr.fill();
        }
        break;
    case 'spark':
        poly([[0.5, 0.08], [0.6, 0.4], [0.92, 0.5], [0.6, 0.6], [0.5, 0.92], [0.4, 0.6], [0.08, 0.5], [0.4, 0.4]]);
        break;
    case 'orbit':
        cr.setLineWidth(size * 0.1);
        cr.arc(x + c, y + c, size * 0.36, 0, 2 * Math.PI);
        cr.stroke();
        cr.arc(x + c, y + c, size * 0.13, 0, 2 * Math.PI);
        cr.fill();
        break;
    case 'peak':
        poly([[0.08, 0.82], [0.38, 0.25], [0.56, 0.58], [0.68, 0.4], [0.92, 0.82]]);
        break;
    case 'diamond':
        poly([[0.5, 0.08], [0.92, 0.5], [0.5, 0.92], [0.08, 0.5]]);
        break;
    case 'drop':
        poly([[0.5, 0.08], [0.78, 0.5], [0.8, 0.68], [0.66, 0.86], [0.34, 0.86], [0.2, 0.68], [0.22, 0.5]]);
        break;
    case 'bars':
        for (let i = 0; i < 3; i++) {
            cr.rectangle(x + size * 0.14, y + size * (0.2 + i * 0.26), size * 0.72, size * 0.12);
            cr.fill();
        }
        break;
    default: {
        const d = size * 0.07;
        for (let r = 0; r < 3; r++) {
            for (let k = 0; k < 3; k++) {
                cr.arc(x + size * (0.25 + k * 0.25), y + size * (0.25 + r * 0.25), d, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }
    }
}

function drawIndicator(cr, L, get, ix, iy, size) {
    const style = get('indicator-style');
    const mode = get('indicator-color-mode');
    const fill = mode === 'custom' ? get('indicator-color') : '#ffffff';
    const dot = Math.max(3, size * 0.07);
    const edgeOffset = INDICATOR_ROOM / 2 + 1;
    const cx = ix + size / 2;
    const cy = iy + size / 2;
    // Spot just outside the icon, towards the screen edge.
    const pos = {
        BOTTOM: [cx, iy + size + edgeOffset + 1, 1, 0],
        TOP: [cx, iy - edgeOffset - 1, 1, 0],
        LEFT: [ix - edgeOffset - 1, cy, 0, 1],
        RIGHT: [ix + size + edgeOffset + 1, cy, 0, 1],
    }[L.pos];
    const [px, py, ax, ay] = pos;
    color(cr, fill);
    if (style === 'DASHES' || style === 'SEGMENTED' || style === 'SOLID' || style === 'METRO') {
        const len = style === 'SOLID' ? size * 0.9 : size * 0.45;
        const thick = Math.max(2, dot * 0.8);
        roundRect(cr, px - (ax ? len : thick) / 2, py - (ay ? len : thick) / 2,
            ax ? len : thick, ay ? len : thick, thick / 2);
        cr.fill();
    } else if (style === 'SQUARES') {
        cr.rectangle(px - dot, py - dot, dot * 2, dot * 2);
        cr.fill();
    } else {
        const n = style === 'DOT' ? 1 : 2;
        for (let i = 0; i < n; i++) {
            const o = (i - (n - 1) / 2) * dot * 3;
            cr.arc(px + ax * o, py + ay * o, dot, 0, 2 * Math.PI);
            cr.fill();
        }
    }
    if (get('indicator-border-width') > 0 && mode === 'custom') {
        color(cr, get('indicator-border-color'));
        cr.setLineWidth(get('indicator-border-width'));
        cr.arc(px, py, dot + 1, 0, 2 * Math.PI);
        cr.stroke();
    }
}

// A drawing area showing the dock described by `get(key)`. Call
// queue_draw() on it after changes.
export function makePreview(get, options = {}) {
    const area = new Gtk.DrawingArea(options.widget ?? {});
    area.set_draw_func((_area, cr, w, h) => drawDock(cr, w, h, get, options));
    return area;
}
