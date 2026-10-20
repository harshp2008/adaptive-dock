#!/bin/bash
gnome-extensions disable adaptive-dock@harsh.patel 2>/dev/null
rm -rf "$HOME/.local/share/gnome-shell/extensions/adaptive-dock@harsh.patel"
echo "Adaptive Dock removed. Configuration in ~/.config/dock-app-states.json and ~/.config/dock-workspace-states/ was left in place."
