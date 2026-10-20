#!/bin/bash
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="adaptive-dock@harsh.patel"
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$EXT" "$HOME/.config/dock-workspace-states"
cp -r "$HERE/extension/$UUID/"* "$EXT/"
glib-compile-schemas "$EXT/schemas"
echo "Installed to $EXT"
echo
echo "Next steps:"
echo "  1. If running Wayland, log out and log back in (or on X11, press Alt+F2, type 'r', and Enter)."
echo "  2. Enable the extension:"
echo "     gnome-extensions enable $UUID"
echo "  3. Open preferences:"
echo "     gnome-extensions prefs $UUID"
