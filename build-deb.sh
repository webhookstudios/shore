#!/bin/sh
# Builds dist/shore_<version>_all.deb. Needs only dpkg-deb.
#
# The package installs Shore for every user of the machine:
#   /usr/share/gnome-shell/extensions/<uuid>/   the extension
#   /usr/share/glib-2.0/schemas/                its settings schema
#   /usr/bin/shore                              apps-menu launcher
#   /usr/share/applications, /usr/share/icons   apps-menu entry and icon
set -e

UUID=shore@webhookstudios.github.io
APP_ID=io.github.webhookstudios.Shore
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' "$ROOT/$UUID/metadata.json")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

EXT="$STAGE/usr/share/gnome-shell/extensions/$UUID"
install -d "$EXT" "$STAGE/DEBIAN" "$STAGE/usr/bin" \
    "$STAGE/usr/share/glib-2.0/schemas" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/doc/shore"

install -m 644 "$ROOT/$UUID"/*.js "$ROOT/$UUID/metadata.json" \
    "$ROOT/$UUID/stylesheet.css" "$EXT/"
cp -r "$ROOT/$UUID/sedge" "$EXT/"
find "$EXT/sedge" -type f -exec chmod 644 {} +
install -d "$EXT/media"
install -m 644 "$ROOT/$UUID/media"/*.svg "$EXT/media/"
# With no schemas folder of its own, the extension reads its schema from
# the system one, which dpkg compiles through glib's trigger.
install -m 644 "$ROOT/$UUID/schemas"/*.gschema.xml "$STAGE/usr/share/glib-2.0/schemas/"
install -m 755 "$ROOT/data/launcher.js" "$STAGE/usr/bin/shore"
install -m 644 "$ROOT/data/$APP_ID.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/"
sed -e 's|@EXEC@|shore|' -e "s|@ICON@|$APP_ID|" "$ROOT/data/$APP_ID.desktop.in" \
    > "$STAGE/usr/share/applications/$APP_ID.desktop"
chmod 644 "$STAGE/usr/share/applications/$APP_ID.desktop"

# Turns Shore on in place of Spur at the next login, for people who had Spur on.
install -d "$STAGE/usr/lib/shore" "$STAGE/etc/xdg/autostart"
install -m 755 "$ROOT/data/shore-take-over" "$STAGE/usr/lib/shore/"
install -m 644 "$ROOT/data/io.github.webhookstudios.Shore.take-over.desktop" "$STAGE/etc/xdg/autostart/"

cat > "$STAGE/usr/share/doc/shore/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Shore (formerly Spur)
Source: https://github.com/webhookstudios/shore

Files: *
Copyright: $(date +%Y) webhookstudios
License: GPL-2+
 On Debian systems, the full text of the GNU General Public License
 version 2 can be found in /usr/share/common-licenses/GPL-2.

Files: usr/share/gnome-shell/extensions/*/sedge/fonts/*
Copyright: 2023 The Young Serif Project Authors; 2015 The Public Sans Project Authors
License: OFL-1.1
 The full license texts are in the extension's sedge/fonts/ folder.
EOF
chmod 644 "$STAGE/usr/share/doc/shore/copyright"

# Replaces/Breaks take over from this app's old package name, spur.
cat > "$STAGE/DEBIAN/control" <<EOF
Package: shore
Version: $VERSION
Architecture: all
Maintainer: webhookstudios <354619278+webhookstudios@users.noreply.github.com>
Installed-Size: $(du -sk "$STAGE/usr" | cut -f1)
Depends: gnome-shell (>= 50~), gnome-shell (<< 51~), gnome-shell-ubuntu-extensions, gjs, gir1.2-adw-1, gir1.2-gtk-4.0, gir1.2-soup-3.0
Replaces: spur (<< 2~)
Breaks: spur (<< 2~)
Section: gnome
Priority: optional
Homepage: https://github.com/webhookstudios/shore
Description: Restyle and control the Ubuntu dock
 Shore (formerly Spur) is a GNOME Shell extension that changes how the Ubuntu dock
 looks and behaves: ready-made presets, position, size, colors, blur,
 running indicators, a choice of corner button logos, optional clock,
 weather and system readouts, autohide, and hiding the dock completely.
 .
 After installing, log out and back in, then open Shore from the
 apps menu.
EOF

# Folders are created with the builder's umask; packages want 755.
find "$STAGE" -type d -exec chmod 755 {} +

mkdir -p "$ROOT/dist"
dpkg-deb --root-owner-group --build "$STAGE" "$ROOT/dist/shore_${VERSION}_all.deb"
