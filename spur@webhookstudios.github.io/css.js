// Builds the stylesheet for the Ubuntu dock from our settings.
//
// Every rule starts with the marker classes `dm dm-on dm-style`, which the
// extension adds to the dock. That makes them more specific than the dock's
// own rules, so ours win no matter which stylesheet loads first.

const SCOPE = '#dashtodockContainer.dm.dm-on.dm-style';

function rgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

function rgba(hex, alpha) {
    const [r, g, b] = rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// Room, in pixels, kept free on the screen-edge side of every icon for the
// running indicator.
const INDICATOR_ROOM = 6;

export function buildCss(v) {
    const pos = v('position');
    const horizontal = pos === 'BOTTOM' || pos === 'TOP';
    const edge = pos.toLowerCase();                       // side that touches the screen
    const inner = {bottom: 'top', top: 'bottom', left: 'right', right: 'left'}[edge];
    const alongStart = horizontal ? 'left' : 'top';
    const alongEnd = horizontal ? 'right' : 'bottom';

    const pad = v('padding');
    const spacing = v('icon-spacing');
    const dynamic = v('transparency') === 'DYNAMIC';
    const side = v('extend') ? v('side-gap') : 0;
    const borderWidth = v('border-width');

    const rules = [];
    const add = (selector, body) => rules.push(`${SCOPE} ${selector} {\n${body.map(l => `  ${l}`).join('\n')}\n}`);

    // The dock itself.
    const background = [
        `margin: 0px;`,
        `margin-${edge}: ${v('edge-gap')}px;`,
        `margin-${alongStart}: ${side}px;`,
        `margin-${alongEnd}: ${side}px;`,
        `padding: 0px;`,
        `border-radius: ${v('radius')}px;`,
        `spacing: 0px;`,
    ];
    if (!dynamic) {
        background.push(`background-color: ${rgba(v('bg-color'), v('bg-opacity'))};`);
        background.push(`border-color: ${rgba(v('border-color'), v('border-opacity'))};`);
    }
    background.push(`border-width: ${borderWidth}px;`);
    background.push(`border-style: solid;`);
    // The shadow is drawn by the extension under the dock: one made here
    // would be cut off square at the dock's own edges.
    background.push('box-shadow: none;');
    add('#dash .dash-background', background);

    // Space along the dock, between the first/last icon and its ends.
    add('#dash #dashtodockDashContainer', [
        'padding: 0px;',
        `padding-${alongStart}: ${pad}px;`,
        `padding-${alongEnd}: ${pad}px;`,
    ]);

    // Space between icons.
    const half = spacing / 2;
    add('#dash .dash-item-container', [
        'margin: 0px;',
        `margin-${alongStart}: ${half}px;`,
        `margin-${alongEnd}: ${half}px;`,
    ]);
    add('#dash .dash-item-container > *', ['margin: 0px;']);

    // Space around each icon, across the dock. The indicator lives in the
    // extra room on the screen-edge side.
    const itemBody = [
        'padding: 0px;',
        `padding-${inner}: ${pad}px;`,
        `padding-${edge}: ${pad + INDICATOR_ROOM}px;`,
    ];
    add('#dash .dash-item-container .app-well-app', itemBody);
    add('#dash .dash-item-container .show-apps', itemBody);
    add('#dash .dash-item-container .overview-tile', itemBody);

    // Highlight behind hovered and active icons.
    const highlightRadius = `border-radius: ${v('highlight-radius')}px;`;
    const highlightOn = `background-color: ${rgba(v('highlight-color'), v('highlight-opacity'))};`;
    add('#dash .dash-item-container .overview-icon', [highlightRadius, 'background-color: rgba(0, 0, 0, 0);']);
    for (const state of ['.focused', ':hover', ':focus', ':active'])
        add(`#dash .dash-item-container .app-well-app${state} .overview-icon`, [highlightRadius, highlightOn]);
    add('#dash .dash-item-container .app-well-app.running.focused .overview-icon', [highlightRadius, highlightOn]);
    add('#dash .dash-item-container .show-apps:hover .overview-icon', [highlightRadius, highlightOn]);

    // The Show Apps button, optionally colored like a start button.
    if (v('apps-accent')) {
        add('#dash .dash-item-container .show-apps .overview-icon', [
            highlightRadius,
            `background-color: ${rgba(v('apps-accent-color'), 1)};`,
        ]);
        add('#dash .dash-item-container .show-apps:hover .overview-icon', [
            highlightRadius,
            `background-color: ${rgba(v('apps-accent-color'), 0.8)};`,
        ]);
    }

    // The thin line between pinned and running apps follows the dock's axis.
    add('#dash .dash-separator', [
        horizontal ? 'width: 1px; height: 0px;' : 'width: 0px; height: 1px;',
        `background-color: ${rgba(v('highlight-color'), 0.25)};`,
        'margin: 0px;',
        horizontal ? 'margin: 0px 4px;' : 'margin: 4px 0px;',
    ]);

    // Info widgets, inside the dock next to the icons.
    add('#dash .dm-widgets', [
        'padding: 0px;',
        `padding-${edge}: ${v('edge-gap')}px;`,
        `spacing: ${horizontal ? 14 : 10}px;`,
        `margin-${alongStart}: ${horizontal ? 8 : 6}px;`,
        `margin-${alongEnd}: ${horizontal ? 8 : 6}px;`,
    ]);
    add('#dash .dm-widget', ['spacing: 5px;']);
    add('#dash .dm-widget-label', [
        `color: ${rgba(v('widgets-text-color'), 1)};`,
        `font-size: ${v('widgets-font-size')}pt;`,
        // Quotes and backslashes cannot appear in a family name we accept.
        ...v('widgets-font') ? [`font-family: "${v('widgets-font').replace(/["\\;{}]/g, '')}";`] : [],
        'font-weight: 500;',
        'text-align: center;',
    ]);
    add('#dash .dm-widget-icon', [`color: ${rgba(v('widgets-text-color'), 1)};`]);

    return `/* Generated by Spur. Do not edit. */\n${rules.join('\n\n')}\n`;
}
