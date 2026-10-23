# Adaptive Dock

<p align="center">
  <strong>Intelligent, context-aware dock visibility management for GNOME Shell</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME%20Shell-46%20%7C%2047%20%7C%2048%20%7C%2049%20%7C%2050-blue?style=flat-square&logo=gnome" alt="GNOME Shell 46-50" />
  <img src="https://img.shields.io/badge/Supports-Dash%20to%20Dock%20%7C%20Ubuntu%20Dock-orange?style=flat-square" alt="Dash to Dock Supported" />
  <img src="https://img.shields.io/badge/Display-Wayland%20%7C%20X11-green?style=flat-square" alt="Wayland & X11" />
  <img src="https://img.shields.io/badge/UI-Libadwaita%20%2F%20GTK4-purple?style=flat-square" alt="Libadwaita / GTK4" />
</p>

---

**Adaptive Dock** automatically shows or hides your dock based on what you are doing. Keep your dock visible while multitasking or messaging, and automatically hide it when coding, reading, or browsing.

Designed as an intelligent companion for **[Dash to Dock](https://github.com/micheleg/dash-to-dock)** and **Ubuntu Dock**.

---

## ⚡ Quick Install (One-Liner)

Install or update Adaptive Dock directly in your terminal without needing to clone the repository:

```bash
curl -sSL https://raw.githubusercontent.com/harshp2008/Adaptive-Dock/main/install.sh | bash
```

After installing:
1. **Wayland**: Log out and log back in (or on **X11**, press `Alt + F2`, type `r`, and hit `Enter`).
2. **Enable the extension**:
   ```bash
   gnome-extensions enable adaptive-dock@harsh.patel
   ```
3. **Open preferences**:
   ```bash
   gnome-extensions prefs adaptive-dock@harsh.patel
   ```

---

## ✨ Main Features

- 🎯 **Per-Application & Workspace Rules**: Set individual dock visibility (`Default`, `Show dock`, or `Hide dock`) for any installed app and workspace.
- 🔄 **Bypass Mode**: Companion overlays, clipboard managers (like Win11Clip), and popup utilities preserve whatever dock state the previous app had without triggering unwanted changes.
- ⌨️ **Dual-Scope Shortcuts**:
  - `Shift + Super + D`: Toggles dock visibility for the focused app or window.
  - `Shift + Super + W`: Toggles the dock visibility baseline for the active workspace.
- 🔔 **Native Floating Indicators (OSD)**: On-screen display pills provide instant visual feedback on state changes, with a customizable bottom offset to prevent visual overlap with docks.
- 🧠 **Session Memory & Granular Isolation**: Quick shortcut toggles apply in memory for your current session without overwriting permanent disk rules. Choose global per-window or per-app isolation with individual app exception overrides.
- 🗂️ **Dynamic Workspace Management**: Rename workspaces system-wide and append new workspaces with pre-configured dock behaviors directly inside the settings UI.
- 🖐️ **Screen Edge Reveal Control**: Prevent accidental dock popups by controlling edge-hover reveals, pressure thresholds, animation times, and display delays.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `Shift + Super + D` | Toggle dock visibility for the active app / window |
| `Shift + Super + W` | Toggle dock visibility baseline for the active workspace |

*Shortcuts can be customized or rebound in **Preferences > General > Keyboard Shortcuts**.*

---

## 📋 Requirements

- **GNOME Shell**: 46, 47, 48, 49, or 50
- **Supported Dock Extension**: [Dash to Dock](https://github.com/micheleg/dash-to-dock) or Ubuntu Dock
- **Display Server**: Wayland or X11

---

## 🛠️ Manual Source Installation

<details>
<summary><strong>Click to expand source instructions</strong></summary>

```bash
git clone https://github.com/harshp2008/Adaptive-Dock.git
cd Adaptive-Dock
chmod +x install.sh
./install.sh
```

To build a distributable `.zip` archive:
```bash
make zip
```
</details>

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).
