#!/bin/bash
set -e

UUID="adaptive-dock@harsh.patel"
REPO="harshp2008/Adaptive-Dock"
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
CONFIG_DIR="$HOME/.config/dock-workspace-states"

mkdir -p "$EXT" "$CONFIG_DIR"

# Determine source: local directory or GitHub latest release
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
LOCAL_SRC="$HERE/extension/$UUID"

if [ -d "$LOCAL_SRC" ] && [ "$1" != "--release" ] && [ "$1" != "--latest" ]; then
    echo "Installing Adaptive Dock from local source..."
    cp -r "$LOCAL_SRC/"* "$EXT/"
else
    echo "Fetching latest release of Adaptive Dock from GitHub..."
    RELEASE_URL="https://github.com/$REPO/releases/latest/download/$UUID.shell-extension.zip"
    TMP_ZIP="$(mktemp --suffix=.zip)"

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$RELEASE_URL" -o "$TMP_ZIP"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$TMP_ZIP" "$RELEASE_URL"
    else
        echo "Error: curl or wget is required to download the release." >&2
        exit 1
    fi

    if command -v unzip >/dev/null 2>&1; then
        unzip -q -o "$TMP_ZIP" -d "$EXT"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import zipfile; zipfile.ZipFile('$TMP_ZIP').extractall('$EXT')"
    else
        echo "Error: unzip or python3 is required to extract the release." >&2
        rm -f "$TMP_ZIP"
        exit 1
    fi
    rm -f "$TMP_ZIP"
fi

# Compile GSettings schemas
if [ -d "$EXT/schemas" ]; then
    glib-compile-schemas "$EXT/schemas"
fi

echo "Successfully installed Adaptive Dock to $EXT"
echo
echo "Next steps:"
echo "  1. If running Wayland, log out and log back in (or on X11, press Alt+F2, type 'r', and Enter)."
echo "  2. Enable the extension:"
echo "     gnome-extensions enable $UUID"
echo "  3. Open preferences:"
echo "     gnome-extensions prefs $UUID"
