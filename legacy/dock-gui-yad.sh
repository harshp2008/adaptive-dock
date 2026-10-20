#!/bin/bash

WRAPPER="$HOME/app-dock-wrapper.sh"
LOCAL_DIR="$HOME/.local/share/applications"
mkdir -p "$LOCAL_DIR"

data=()
# Read apps and check their current wrapper status to populate the dropdown
while read -r path; do
    filename=$(basename "$path")
    app_name=$(grep -m 1 "^Name=" "$path" | cut -d '=' -f 2- | tr -d '\r')
    [[ -z "$app_name" ]] && app_name="$filename"
    
    # Determine which file is actively used
    TARGET="$LOCAL_DIR/$filename"
    [[ ! -f "$TARGET" ]] && TARGET="$path"

    # The first item in the ! separated list becomes the default selected value in YAD
    if grep -q "$WRAPPER true" "$TARGET" 2>/dev/null; then
        cb_options="hide!show!none"
    elif grep -q "$WRAPPER false" "$TARGET" 2>/dev/null; then
        cb_options="show!hide!none"
    else
        cb_options="none!hide!show"
    fi
    
    # Add to the array: App Name, Shortcut File, Hidden Path, Combobox Options
    data+=("$app_name" "$filename" "$path" "$cb_options")
done < <(find /usr/share/applications/ /var/lib/flatpak/exports/share/applications/ "$LOCAL_DIR" -name "*.desktop" 2>/dev/null | sort -u)

# Launch the YAD interface (significantly larger with editable dropdowns)
RESULT=$(yad --list --title="Dock Manager" \
    --width=1200 --height=800 \
    --text="Double-click the State column to change it, then click OK to apply. Type anywhere to search." \
    --column="App Name" --column="Shortcut File" --column="Path":HD --column="State":CB \
    --search-column=1 --editable \
    "${data[@]}")

# Exit if cancelled
[[ -z "$RESULT" ]] && exit 0

# Parse YAD's piped output (e.g., App|File|Path|State|)
path=$(echo "$RESULT" | awk -F'|' '{print $3}')
filename=$(echo "$RESULT" | awk -F'|' '{print $2}')
state=$(echo "$RESULT" | awk -F'|' '{print $4}')

[[ -z "$path" || -z "$state" ]] && exit 0

TARGET="$LOCAL_DIR/$filename"
if [[ "$path" != "$TARGET" ]]; then
    cp "$path" "$TARGET"
fi

# Wipe any previous wrapper injections from the file
sed -i "s|$WRAPPER true ||g" "$TARGET"
sed -i "s|$WRAPPER false ||g" "$TARGET"

# Inject the newly selected state
if [[ "$state" == "hide" ]]; then
    sed -i "s|^Exec=|Exec=$WRAPPER true |g" "$TARGET"
    yad --info --title="Success" --text="✅ Set to HIDE dock for $filename" --width=300 --button=OK:0
elif [[ "$state" == "show" ]]; then
    sed -i "s|^Exec=|Exec=$WRAPPER false |g" "$TARGET"
    yad --info --title="Success" --text="✅ Set to SHOW dock for $filename" --width=300 --button=OK:0
else
    yad --info --title="Cleared" --text="🧹 Wrapper removed. Default behavior restored for $filename." --width=300 --button=OK:0
fi
