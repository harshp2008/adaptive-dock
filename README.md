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

**Adaptive Dock** automatically shows or hides your dock based on what you are currently doing. Whether you want your dock visible while browsing files and messaging, or completely hidden when coding or browsing the web, Adaptive Dock dynamically switches dock visibility as you switch application focus and navigate between workspaces.

Designed as an intelligent companion for **[Dash to Dock](https://github.com/micheleg/dash-to-dock)** and **Ubuntu Dock**.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
  - [Priority Hierarchy](#priority-hierarchy)
  - [Dock Reveal & Autohide Fine-Tuning](#dock-reveal--autohide-fine-tuning)
  - [Session State Memory](#session-state-memory)
  - [Dynamic Workspace Synchronization](#dynamic-workspace-synchronization)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Quick Install (Recommended)](#quick-install-recommended)
  - [Manual Installation](#manual-installation)
  - [Building from Source](#building-from-source)
- [Configuration & Preferences](#configuration--preferences)
  - [Preferences Window](#preferences-window)
  - [Configuration Storage on Disk](#configuration-storage-on-disk)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Repository Structure](#repository-structure)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- 🎯 **Per-Application Rules**: Choose whether the dock is visible (window dodge), completely hidden, or set to **Bypass** (preserves whatever dock state the previous app had—ideal for floating utilities like Win11Clip, screenshot tools, and popup launchers).
- 🗂️ **Per-Workspace Rules & In-Menu Renaming**: Set fallback dock behavior per workspace, rename workspaces directly in the preferences menu (syncs system-wide with GNOME), and use the `+` button to preset and append new workspaces.
- 🧠 **Session Memory & Granular Isolation**: Hit a quick shortcut to temporarily override dock visibility during your session. Choose a global default (per-app or per-window) and set custom exceptions for individual apps (e.g. isolate Gemini or Terminal per-window while keeping other apps per-application).
- 🖐️ **Screen Edge Reveal Control**: Prevent accidental dock popups by turning edge-hover reveal off, or tune pressure thresholds, animations, and reveal delays.
- 🔄 **Real-Time Workspace Sync**: Dynamically mirrors workspace creation, deletion, reordering, and custom names from GNOME Shell in real time ("Used + 1" dynamic layout).
- ⌨️ **Interactive Shortcut Recorder**: Rebind the global toggle shortcut via a native Libadwaita modal recorder.
- 🛡️ **Conflict & Dependency Health Checks**: Built-in status banners alert you if Dash to Dock is missing or if multiple conflicting docks are active at the same time.

---

## How It Works

Adaptive Dock hooks directly into GNOME Shell's window tracker and workspace manager. When you switch windows or switch workspaces, Adaptive Dock evaluates the current context and adjusts Dash to Dock / Ubuntu Dock's Intelligent Autohide properties:

- **Show dock**: Enables "Dodge windows" (`intellihide=true`) while keeping Intelligent Autohide and Autohide active (`dock-fixed=false`, `autohide=true`), making the dock visible.
- **Hide dock**: Disables "Dodge windows" (`intellihide=false`) while keeping Autohide active, cleanly hiding the dock out of view.
- **Bypass**: Preserves the dock visibility state inherited from the previously focused window/workspace without modification. Essential for floating clipboard history managers (like Win11Clip), quick launchers, or HUD overlays that shouldn't disrupt dock state.

### Priority Hierarchy

When a window is focused, Adaptive Dock evaluates visibility using the following strict resolution chain:

```text
┌────────────────────────────────────────────────────────┐
│  0. Bypass Rule (Freezes & preserves current state)    │
└───────────────────────────┬────────────────────────────┘
                            │ (not a bypass app)
                            ▼
┌────────────────────────────────────────────────────────┐
│  1. In-Memory Session Override (Window or App level)  │
└───────────────────────────┬────────────────────────────┘
                            │ (no app/window session override)
                            ▼
┌────────────────────────────────────────────────────────┐
│  2. Persistent Application Rule (dock-app-states.json) │
└───────────────────────────┬────────────────────────────┘
                            │ (app is Default)
                            ▼
┌────────────────────────────────────────────────────────┐
│  3. In-Memory Workspace Session Baseline (from toggle) │
└───────────────────────────┬────────────────────────────┘
                            │ (no in-memory workspace toggle)
                            ▼
┌────────────────────────────────────────────────────────┐
│  4. Persistent Workspace Rule (<workspace>.state)      │
└───────────────────────────┬────────────────────────────┘
                            │ (no workspace rule file)
                            ▼
┌────────────────────────────────────────────────────────┐
│  5. Default Fallback (Show dock)                       │
└────────────────────────────────────────────────────────┘
```

### Dock Reveal & Autohide Fine-Tuning

In standard Dash to Dock, moving the cursor near the edge of the screen can accidentally pop up the dock. Adaptive Dock gives you full control over this behavior in the **General** settings tab:

- **Reveal dock on mouse hover**: Disabled by default so accidental cursor movements near the screen edge never trigger the dock.
- **Push to show**: Require sustained mouse pressure against the edge before the dock appears.
- **Pressure threshold**: Fine-tune the pressure sensitivity (from 0 to 100).
- **Animation duration**: Adjust dock transition animation speed.
- **Hide timeout & Show timeout**: Control delays before showing or dismissing the dock.
- **Fullscreen & Urgent Notifications**: Dedicated switches to permit dock reveals during fullscreen video/gaming or when applications flag urgency.

### Session State Memory & Dual-Scope Shortcuts

Adaptive Dock provides dedicated shortcuts to control dock visibility at both the application and workspace levels with immediate on-screen (OSD) feedback:

- **Toggle Active App / Window** (`Shift+Super+D` by default): Temporarily toggles dock visibility for the focused application (or specific window if per-window isolation is active). Navigating to other apps leaves those apps on their own rules.
- **Toggle Workspace Baseline** (`Shift+Super+W` by default): Temporarily toggles the dock visibility baseline for the active workspace. All applications set to `Default` on this workspace immediately adopt this new baseline.
- **Session Memory Guarantee**: All manual overrides live strictly in memory and reset cleanly upon logging out or rebooting—never modifying your persistent preferences files on disk.
- **Global Window Isolation Default**: Set whether shortcut toggles apply to the entire application or strictly to the active window by default.
- **App Isolation Overrides & Exceptions**: Give specific apps custom isolation rules! For example, keep window isolation OFF globally (so toggling a browser affects all browser windows), but force **Per-Window isolation** for Gemini, terminal windows, or web apps. Exceptions can be toggled with a single click in the app list or managed centrally in the **App Isolation Overrides** expander.

### Dynamic Workspace Synchronization & Management

The **Workspaces** tab dynamically watches GNOME Shell's workspace manager:

- **Preset & Append Workspaces (`+` Button)**: Click the `+` button in the group header to create and preset a new workspace with a custom name and initial dock behavior.
- **In-Menu Workspace Renaming (✏️)**: Click the edit pencil icon next to any workspace to rename it directly inside the settings UI. Changes instantly update GNOME Mutter system-wide and automatically migrate your saved dock preferences (`.state` files).
- **Dynamic "Used + 1" Sync**: The workspace list automatically mirrors active and named workspaces from GNOME Shell, ensuring at least 4 slots and always offering at least one spare workspace.

---

## Prerequisites

- **GNOME Shell**: Versions `46`, `47`, `48`, `49`, or `50`
- **Supported Dock**:
  - [Dash to Dock](https://github.com/micheleg/dash-to-dock) (`dash-to-dock@micxgx.gmail.com`), **OR**
  - Ubuntu Dock (`ubuntu-dock@ubuntu.com`)
- **Display Server**: Wayland or X11

---

## Installation

### Quick Install (Latest Release)

Install or update Adaptive Dock directly with a single command:

```bash
curl -sSL https://raw.githubusercontent.com/harshp2008/Adaptive-Dock/main/install.sh | bash
```

### Install from Source

Clone the repository and run the install script:

```bash
git clone https://github.com/harshp2008/Adaptive-Dock.git
cd Adaptive-Dock
chmod +x install.sh
./install.sh
```

Then reload GNOME Shell and enable the extension:

1. **Wayland**: Log out and log back in.  
   **X11**: Press `Alt + F2`, type `r`, and press `Enter`.
2. Enable the extension:
   ```bash
   gnome-extensions enable adaptive-dock@harsh.patel
   ```
3. Open preferences:
   ```bash
   gnome-extensions prefs adaptive-dock@harsh.patel
   ```

### Manual Installation

Copy the extension directory to your local GNOME Shell extensions folder and compile the GSettings schema:

```bash
UUID="adaptive-dock@harsh.patel"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$TARGET"
cp -r extension/$UUID/* "$TARGET/"
glib-compile-schemas "$TARGET/schemas"
```

### Building from Source

Create an extension zip package ready for distribution or uploading to [extensions.gnome.org](https://extensions.gnome.org):

```bash
make zip
```

This generates `adaptive-dock@harsh.patel.shell-extension.zip`.

---

## Configuration & Preferences

### Preferences Window

Launch the settings UI via:
- The GNOME **Extensions** app (`gnome-extensions-app`), or
- Command line: `gnome-extensions prefs adaptive-dock@harsh.patel`

| Tab | Available Settings |
|---|---|
| **General** | Keyboard shortcut recorders, On-Screen Notification toggles & vertical bottom offset, health check alerts, edge-hover reveal switch, pressure-to-show, animation speeds, hide/show delays, fullscreen & urgent notifications. |
| **Apps** | Session state memory toggle, global per-window isolation default, **App Isolation Overrides expander** (with app picker dialog), quick per-window toggle buttons on each app row, and searchable list of all installed apps with dock visibility options (`Default`, `Hide dock`, `Show dock`). |
| **Workspaces** | Dynamically synchronized list of GNOME workspaces, **`+` Add Workspace button** to preset names and append workspaces to GNOME Shell, **✏️ Rename buttons** on each workspace row to rename workspaces system-wide and migrate settings, and dock visibility options (`Default`, `Hide dock`, `Show dock`). |

### Configuration Storage on Disk

Preferences are stored in clean, human-readable formats under your user configuration directory:

- **Application Rules**: `~/.config/dock-app-states.json`
  ```json
  {
    "org.gnome.Nautilus": "show",
    "com.visualstudio.code": "hide",
    "google-chrome": "hide"
  }
  ```
- **Workspace Rules**: `~/.config/dock-workspace-states/<workspace_name>.state`
  - Content is `true` (show dock), `false` (hide dock), or file deleted (default).
- **Extension Settings**: GSettings schema `org.gnome.shell.extensions.adaptive-dock`

Because configuration files are actively monitored via `Gio.FileMonitor`, manual edits or automated external scripts take effect immediately without restarting GNOME Shell.

---

## Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `Shift + Super + D` *(default)* | Toggle dock visibility for the focused application or window |
| `Shift + Super + W` *(default)* | Toggle dock visibility baseline for the active workspace |
| *Customizable* | Change or disable individually in **Preferences > General > Keyboard Shortcuts** |

---

## Repository Structure

```text
adaptive-dock/
├── extension/
│   └── adaptive-dock@harsh.patel/
│       ├── extension.js          # Core focus tracker & visibility controller
│       ├── prefs.js              # Libadwaita / GTK4 preferences dialog
│       ├── metadata.json         # Extension metadata & compatibility
│       └── schemas/              # GSettings schema definition & compiled cache
├── Makefile                      # Build automation (make zip, make install)
├── install.sh                    # Automated installer script
├── uninstall.sh                  # Uninstallation script
├── scripts/                      # Standalone helper scripts
├── legacy/                       # Historical prototypes (GTK3 UI & bash wrappers)
└── README.md
```

---

## Troubleshooting & FAQ

<details>
<summary><strong>The dock does not hide or show when switching windows</strong></summary>

1. Ensure **Dash to Dock** or **Ubuntu Dock** is enabled.
2. Open **Adaptive Dock Preferences** (`gnome-extensions prefs adaptive-dock@harsh.patel`) and verify that no warning banners are shown.
3. If both Dash to Dock and Ubuntu Dock are enabled simultaneously, disable one in GNOME Extensions.
</details>

<details>
<summary><strong>Mouse hover at the screen edge doesn't reveal the dock</strong></summary>

By default, **Reveal dock on mouse hover** is switched OFF to prevent unintended dock appearances. Open **Preferences > General > Screen Edge Dock Reveal** and enable it if you prefer edge reveals.
</details>

<details>
<summary><strong>How do I inspect runtime logs?</strong></summary>

Run the following command in your terminal:
```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "Adaptive Dock"
```
</details>

---

## Contributing

Contributions, bug reports, and suggestions are welcome!

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/cool-feature`).
3. Commit your changes (`git commit -m 'Add cool feature'`).
4. Push to the branch (`git push origin feature/cool-feature`).
5. Open a Pull Request.

---

## License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).
