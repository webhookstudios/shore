#!/bin/sh
# Builds the release zip in dist/, ready for `gnome-extensions install`.
set -e

UUID=spur@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/dist"
gnome-extensions pack --force --out-dir "$ROOT/dist" \
    --extra-source=model.js \
    --extra-source=presets.js \
    --extra-source=css.js \
    --extra-source=preview.js \
    --extra-source=widgets.js \
    --extra-source=media \
    --extra-source=sedge \
    "$ROOT/$UUID"

echo "Built $ROOT/dist/$UUID.shell-extension.zip"
