#!/bin/bash

DIR="$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas"
SCHEMA="org.gnome.shell.extensions.dash-to-dock"
STATE_DIR="$HOME/.config/dock-workspace-states"
mkdir -p "$STATE_DIR"

# Get active workspace name
idx=$(xprop -root _NET_CURRENT_DESKTOP 2>/dev/null | awk '{print $NF}')
names_str=$(xprop -root _NET_DESKTOP_NAMES 2>/dev/null | cut -d '=' -f 2-)

desktop_names=()
while read -d, -r name || [[ -n "$name" ]]; do
    clean_name=$(echo "$name" | sed 's/^[ \t]*"//;s/"[ \t]*$//')
    [[ -n "$clean_name" ]] && desktop_names+=("$clean_name")
done <<< "$names_str"

active_name="${desktop_names[$idx]}"

# Toggle dock setting
current_state=$(gsettings --schemadir "$DIR" get $SCHEMA intellihide)
if [ "$current_state" = "true" ]; then
    new_state="false"
else
    new_state="true"
fi

gsettings --schemadir "$DIR" set $SCHEMA intellihide "$new_state"

# Save to memory for this workspace
if [[ -n "$active_name" ]]; then
    echo "$new_state" > "$STATE_DIR/${active_name}.state"
fi
