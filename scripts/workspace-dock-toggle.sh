#!/bin/bash

DIR="$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas"
SCHEMA="org.gnome.shell.extensions.dash-to-dock"
STATE_DIR="$HOME/.config/dock-workspace-states"
mkdir -p "$STATE_DIR"


# true = show taskbar on empty screens, false = hide taskbar
DEFAULT_STATE="true"

desktop_names=()

update_names() {
    local names_str
    names_str=$(xprop -root _NET_DESKTOP_NAMES 2>/dev/null | cut -d '=' -f 2-)
    local new_desktop_names=()
    
    # Parse the current workspace names
    while read -d, -r name || [[ -n "$name" ]]; do
        clean_name=$(echo "$name" | sed 's/^[ \t]*"//;s/"[ \t]*$//')
        if [[ -n "$clean_name" ]]; then
            new_desktop_names+=("$clean_name")
        fi
    done <<< "$names_str"

    # Detect renames by comparing old array with new array
    if [[ ${#desktop_names[@]} -gt 0 && ${#desktop_names[@]} -eq ${#new_desktop_names[@]} ]]; then
        for i in "${!desktop_names[@]}"; do
            if [[ "${desktop_names[$i]}" != "${new_desktop_names[$i]}" ]]; then
                local old_file="$STATE_DIR/${desktop_names[$i]}.state"
                local new_file="$STATE_DIR/${new_desktop_names[$i]}.state"
                
                # If a state file exists for the old name, rename it to the new one
                if [[ -f "$old_file" ]]; then
                    mv "$old_file" "$new_file"
                fi
            fi
        done
    fi
    
    desktop_names=("${new_desktop_names[@]}")
}

apply_state_for_workspace() {
    local ws_name="$1"
    [[ -z "$ws_name" ]] && return

    local state_file="$STATE_DIR/${ws_name}.state"
    local desired_state

    if [[ -f "$state_file" ]]; then
        desired_state=$(cat "$state_file")
    else
        desired_state="$DEFAULT_STATE"
        echo "$desired_state" > "$state_file"
    fi

    gsettings --schemadir "$DIR" set $SCHEMA intellihide "$desired_state"
}

update_names

while read -r line; do
    current_idx=""
    if [[ "$line" == *"_NET_DESKTOP_NAMES"* ]] || [[ "$line" == *"_NET_NUMBER_OF_DESKTOPS"* ]]; then
        update_names
        current_idx=$(xprop -root _NET_CURRENT_DESKTOP 2>/dev/null | awk '{print $NF}')
    elif [[ "$line" == *"_NET_CURRENT_DESKTOP"* ]]; then
        current_idx=$(echo "$line" | awk '{print $NF}')
    fi

    if [[ -n "$current_idx" && "$current_idx" =~ ^[0-9]+$ ]]; then
        active_name="${desktop_names[$current_idx]}"
        apply_state_for_workspace "$active_name"
    fi
done < <(xprop -root -spy _NET_CURRENT_DESKTOP _NET_DESKTOP_NAMES _NET_NUMBER_OF_DESKTOPS)
