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

# ---- Intelligent Dock Validation & Conflict Management ----
D2D_UUID="dash-to-dock@micxgx.gmail.com"
UDOCK_UUID="ubuntu-dock@ubuntu.com"

is_ext_installed() {
    local uuid="$1"
    [ -d "$HOME/.local/share/gnome-shell/extensions/$uuid" ] || [ -d "/usr/share/gnome-shell/extensions/$uuid" ]
}

is_ext_enabled() {
    local uuid="$1"
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions list --enabled 2>/dev/null | grep -qx "$uuid"
    else
        gsettings get org.gnome.shell enabled-extensions 2>/dev/null | grep -q "$uuid"
    fi
}

D2D_INSTALLED=$(is_ext_installed "$D2D_UUID" && echo true || echo false)
UDOCK_INSTALLED=$(is_ext_installed "$UDOCK_UUID" && echo true || echo false)
D2D_ACTIVE=$(is_ext_enabled "$D2D_UUID" && echo true || echo false)
UDOCK_ACTIVE=$(is_ext_enabled "$UDOCK_UUID" && echo true || echo false)

echo ""
echo "Checking dock extension compatibility..."

if [ "$D2D_ACTIVE" = true ] && [ "$UDOCK_ACTIVE" = true ]; then
    echo "⚠️  Conflict detected: Both Dash to Dock and Ubuntu Dock are currently active."
    echo "   Running both simultaneously causes double docks, overlapping icons, and errors."
    if [ -t 0 ]; then
        read -r -p "   Disable Ubuntu Dock to use Dash to Dock (Recommended)? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN])
                echo "   Skipped. You can disable one later in Adaptive Dock preferences."
                ;;
            *)
                gnome-extensions disable "$UDOCK_UUID" 2>/dev/null || true
                echo "   ✓ Successfully disabled Ubuntu Dock. Dash to Dock is now active."
                ;;
        esac
    else
        echo "   (Running non-interactively: Please disable one in GNOME Extensions or Adaptive Dock preferences)"
    fi
elif [ "$D2D_INSTALLED" = false ] && [ "$UDOCK_INSTALLED" = false ]; then
    echo "⚠️  Notice: Neither Dash to Dock nor Ubuntu Dock was found."
    echo "   Adaptive Dock requires a dock extension to manage dock visibility."
    if [ -t 0 ]; then
        read -r -p "   Download and install Dash to Dock (Recommended)? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN])
                echo "   Skipped. Please install Dash to Dock manually to use Adaptive Dock."
                ;;
            *)
                echo "   Fetching latest Dash to Dock release from GitHub..."
                D2D_DIR="$HOME/.local/share/gnome-shell/extensions/$D2D_UUID"
                mkdir -p "$D2D_DIR"
                D2D_ZIP_URL=$(curl -fsSL https://api.github.com/repos/micheleg/dash-to-dock/releases/latest 2>/dev/null | grep -o 'https://[^"]*dash-to-dock[^"]*\.zip' | head -n 1 || echo "")
                if [ -n "$D2D_ZIP_URL" ]; then
                    D2D_TMP="$(mktemp --suffix=.zip)"
                    curl -fsSL "$D2D_ZIP_URL" -o "$D2D_TMP"
                    unzip -q -o "$D2D_TMP" -d "$D2D_DIR"
                    rm -f "$D2D_TMP"
                    if [ -d "$D2D_DIR/schemas" ]; then
                        glib-compile-schemas "$D2D_DIR/schemas"
                    fi
                    gnome-extensions enable "$D2D_UUID" 2>/dev/null || true
                    echo "   ✓ Successfully installed and enabled Dash to Dock."
                else
                    echo "   Could not retrieve Dash to Dock release automatically. Please install from extensions.gnome.org."
                fi
                ;;
        esac
    fi
elif [ "$D2D_ACTIVE" = true ]; then
    echo "✓ Detected active dock: Dash to Dock"
elif [ "$UDOCK_ACTIVE" = true ]; then
    echo "✓ Detected active dock: Ubuntu Dock"
elif [ "$D2D_INSTALLED" = true ]; then
    echo "ℹ️  Dash to Dock is installed but currently disabled."
    if [ -t 0 ]; then
        read -r -p "   Enable Dash to Dock now? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN]) ;;
            *)
                gnome-extensions enable "$D2D_UUID" 2>/dev/null || true
                echo "   ✓ Dash to Dock enabled."
                ;;
        esac
    fi
elif [ "$UDOCK_INSTALLED" = true ]; then
    echo "ℹ️  Ubuntu Dock is installed but currently disabled."
    if [ -t 0 ]; then
        read -r -p "   Enable Ubuntu Dock now? [Y/n] " choice
        case "$choice" in
            [nN][oO]|[nN]) ;;
            *)
                gnome-extensions enable "$UDOCK_UUID" 2>/dev/null || true
                echo "   ✓ Ubuntu Dock enabled."
                ;;
        esac
    fi
fi

echo ""
echo "Next steps:"
echo "  1. If running Wayland, log out and log back in (or on X11, press Alt+F2, type 'r', and Enter)."
echo "  2. Enable Adaptive Dock:"
echo "     gnome-extensions enable $UUID"
echo "  3. Open preferences:"
echo "     gnome-extensions prefs $UUID"
