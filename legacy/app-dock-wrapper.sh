#!/bin/bash
DIR="$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas"
SCHEMA="org.gnome.shell.extensions.dash-to-dock"

# Read the state passed by your Python GUI (true or false)
TARGET_STATE="$1"
shift

# Instantly apply the dock setting
gsettings --schemadir "$DIR" set $SCHEMA intellihide "$TARGET_STATE"

# Hand off execution entirely to the application
exec "$@"
