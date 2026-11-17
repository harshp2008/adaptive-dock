# Technical Findings Report: GNOME Shell Multi-Monitor Architecture

## 1. Monitor Enumeration & Focused-Monitor Resolution

### 1.1 Core Display & Window APIs
An exhaustive analysis of the Mutter (Meta) and GNOME Shell introspection interfaces reveals the exact API mechanisms available to GJS extensions:

| Class / Object | Method / Property | Signature | Source Reference / Line | Verified Behavior |
|---|---|---|---|---|
| `Meta.Display` (`global.display`) | `get_n_monitors()` | `() -> int` | `/usr/include/mutter-14/meta/display.h:221` | Returns the total count of active logical monitors. |
| `Meta.Display` (`global.display`) | `get_primary_monitor()` | `() -> int` | `/usr/include/mutter-14/meta/display.h:224` | Returns the 0-based integer index of the primary display. |
| `Meta.Display` (`global.display`) | `get_current_monitor()` | `() -> int` | `/usr/include/mutter-14/meta/display.h:227` | Returns the monitor index containing the pointer cursor / user activity. |
| `Meta.Window` (`win`) | `get_monitor()` | `() -> int` | `/usr/include/mutter-14/meta/window.h` (`Meta-14.gir:5235`) | Returns the monitor index on which the window's center / largest area rests. |
| `Meta.MonitorManager` (`global.backend.get_monitor_manager()`) | `get_monitor_for_connector(connector)` | `(string) -> int` | `/usr/include/mutter-14/meta/meta-monitor-manager.h:46-47` | Translates a connector string (e.g. `'eDP-1'`) into its active integer monitor index, or `-1` if absent. |
| `Main.layoutManager` | `monitors` | `Array<Layout.Monitor>` | `/org/gnome/shell/ui/layout.js:205, 388-394` | Array of monitor descriptors storing geometry (`x, y, width, height, geometry_scale`). |
| `Main.layoutManager` | `primaryIndex` | `int` | `/org/gnome/shell/ui/layout.js:207, 403` | Index of the primary monitor in `Main.layoutManager.monitors`. |
| `Main.layoutManager` | `focusIndex` | `get focusIndex() -> int` | `/org/gnome/shell/ui/layout.js:639-647` | Convenience getter checking `global.stage.key_focus`, then `focus_window.get_monitor()`, falling back to `primaryIndex`. |

### 1.2 Canonical GJS Resolution of Focused Monitor
To reliably obtain the monitor index holding the user's attention, the canonical call path is:
```javascript
const win = global.display.focus_window;
let monitorIndex = (win && !win.skip_taskbar)
    ? win.get_monitor()
    : global.display.get_current_monitor();
```

#### Edge Case Enumeration & Resolutions:
1. **`focus_window` is null** (e.g. Desktop clicked, wallpaper focused, empty workspace):
   - *Status*: Verified.
   - *Resolution*: Fall back to `global.display.get_current_monitor()`. This returns the monitor where the pointer or recent click occurred. If even that returns `< 0` or `>= nMonitors`, fall back to `Main.layoutManager.primaryIndex`.
2. **Window spans two monitors**:
   - *Status*: Verified against Mutter window placement code.
   - *Resolution*: Mutter's `meta_window_get_monitor(window)` calculates monitor intersection area and assigns the window to the monitor containing the largest bounding area. It never returns multiple indices or an invalid index.
3. **Focus on a monitor with no windows**:
   - *Status*: Verified.
   - *Resolution*: `focus_window` is null. `get_current_monitor()` resolves the monitor containing the pointer.
4. **Focus during a workspace transition**:
   - *Status*: Verified.
   - *Resolution*: Windows may temporarily yield focus during workspace animations. A 300ms deferral mechanism (`GLib.timeout_add`) prevents premature fallback execution, ensuring stable resolution once the transition settles.
5. **Modal dialog open**:
   - *Status*: Verified.
   - *Resolution*: Modal dialogs are normal `Meta.Window` instances. `win.get_monitor()` accurately resolves the display displaying the dialog.

### 1.3 Monitor Index vs Stable Connector String Trade-off
- **Monitor Indices (`0, 1, ...`)**: Unstable across hotplugging, display power cycling, and session restarts. A secondary screen at index 1 can become index 0 if the laptop lid is closed.
- **Connector Strings (`eDP-1`, `HDMI-1`, `DP-2`, `DVI-I-2`)**: Stable physical hardware identifiers defined by the Linux kernel DRM subsystem. They persist across reboots, monitor reconfigurations, and hotplug cycles.
- **Strategy**: Key all persistent rules and session states by **connector string** as the canonical identifier. Resolve the connector to the transient **monitor index** dynamically at runtime for Clutter/OSD API calls.

---

## 2. Per-Monitor State Persistence

### 2.1 Multi-Monitor Paradigms in GNOME Extensions
- **Dash to Panel**: Stores per-monitor configurations (e.g., `panel-positions`, `panel-sizes`) as JSON-encoded string objects inside dedicated GSettings keys (`/org/gnome/shell/extensions/dash-to-panel/`).
- **Dash to Dock**:
  - `multi-monitor` (`b`): Whether to render docks on all monitors (`docking.js:2073`).
  - `preferred-monitor` (`i`): Monitor index for the dock (`-1` for primary, `-2` for connector string).
  - `preferred-monitor-by-connector` (`s`): Stores the target connector string (`docking.js:2032`).
  - `isolate-monitors` (`b`): Controls icon filtering on the dock (`appIcons.js:148`).

### 2.2 Dash to Dock `intellihide` Scope: Hard Constraint Proof
Investigation of `schemas/org.gnome.shell.extensions.dash-to-dock.gschema.xml` (line 129) and `docking.js` (lines 616-621, 670-690, 711-765) confirms:
1. `intellihide` is declared as a single boolean GSettings key in `org.gnome.shell.extensions.dash-to-dock`.
2. There are **no per-monitor intellihide settings** in Dash to Dock.
3. In `docking.js:616`, every `DashToDock` instance connects to `settings.connect('changed::intellihide')`. Changing this key toggles intellihide globally on all docks across all monitors simultaneously.
4. **Architectural Implication**: Per-instance dock hiding cannot be accomplished via Dash to Dock's GSettings without Dash to Dock being rewritten. Therefore, Adaptive Dock maintains **monitor-scoped policy evaluation, monitor-scoped session overrides, monitor-scoped persistent rules, and monitor-scoped OSD notifications**. When the user interacts with Monitor A, Adaptive Dock evaluates Monitor A's rules and drives the dock state accordingly; when switching to Monitor B, it evaluates Monitor B's rules.

### 2.3 Storage Schema Evaluation
We evaluated three storage options:

| Schema Option | Description | Atomicity & Concurrency | Hotplug Pruning | Migration Complexity | Verdict |
|---|---|---|---|---|---|
| **Option A: GSettings JSON String** | Store entire per-monitor state tree as JSON string in GSettings. | Handled by dconf. Changes trigger `changed::` signal. Limited to ~32KB. | Straightforward in JS memory before dconf write. | High: requires schema compiler and dconf writes. | Rejected: Inconvenient for manual inspection and diverges from existing file architecture. |
| **Option B: Per-Monitor Directory Tree** (`dock-monitors/<connector>/...`) | Completely separate directories per monitor containing both app JSON and workspace files. | Requires managing directory hierarchies. High IO overhead. | Requires recursive directory removal. | High: complete migration of existing flat structure. | Rejected: Over-engineered; breaking changes if isolation is toggled off. |
| **Option C: Hybrid Structured JSON & Connector Subdirectories** *(Chosen)* | 1. `dock-monitor-app-states.json` with top-level connector keys.<br>2. `dock-workspace-states/<connector>/<ws>.state` subdirectories. | POSIX atomic replacement via `GLib.file_set_contents`. Flat global files preserved for fallback. | In-memory cleanup on unplug; persistent records retained until explicit prune. | Low: Clean, 100% reversible, non-destructive migration. | **Recommended & Adopted**. |

---

## 3. On-Screen Display (OSD) Scoping

### 3.1 GNOME Shell OSD Window Management
Examination of `/org/gnome/shell/ui/osdWindow.js` and `/org/gnome/shell/ui/shellDBus.js`:
- In `osdWindow.js:161-175`, `OsdWindowManager` maintains `this._osdWindows`, an array of `OsdWindow` instances mapped 1:1 to `Main.layoutManager.monitors`.
- `Main.osdWindowManager.show(monitorIndex, icon, label, level, maxLevel)`:
  - When `monitorIndex !== -1`: Calls `_showOsdWindow(monitorIndex, ...)` on the target monitor and invokes `cancel()` on all other monitors (`osdWindow.js:187-192`).
  - When `monitorIndex === -1`: Displays the OSD on all monitors simultaneously.

### 3.2 D-Bus Security Restriction (`_senderChecker`)
Empirical testing on GNOME Shell 46 revealed a critical security constraint in `shellDBus.js:26-29, 117`:
```javascript
this._senderChecker = new DBusSenderChecker([
    'org.gnome.Settings',
    'org.gnome.SettingsDaemon.MediaKeys',
]);
```
Any external or unprivileged call to `org.gnome.Shell.ShowOSD` via D-Bus is rejected with:
`GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: ShowOSD is not allowed`.

**Conclusion**: Extensions must call `Main.osdWindowManager.show(monitorIndex, ...)` directly in-process. Direct invocation is synchronous, avoids D-Bus serialization overhead, and bypasses sender authorization restrictions.

### 3.3 Connector-to-Index Resolution & Fallback Policy
1. Look up `connector` in the cached `connectorToIndex` map.
2. If absent, call `global.backend.get_monitor_manager().get_monitor_for_connector(connector)`.
3. If resolution returns `-1` or is out of bounds:
   - Fall back to `Main.layoutManager.primaryIndex`.
   - If `primaryIndex` is out of bounds, fall back to index `0`.
   - If `Main.layoutManager.monitors.length === 0` (headless), suppress OSD call and log a debug warning.

---

## 4. Dash to Dock Multi-Monitor Actor Interaction

### 4.1 Actor Enumeration
Source analysis of `dash-to-dock@micxgx.gmail.com/docking.js:2058-2083`:
- When `multi-monitor` is true, `DockManager` creates a distinct `DockedDash` instance (named `'dashtodockContainer'`) for each connected monitor.
- Each actor is registered into `Main.layoutManager._trackedActors` and possesses a `monitorIndex` property.
- Adaptive Dock's `_getDockGeometry(monitorIndex)` queries this actor array to calculate the exact pixel height and vertical clearance offset for each monitor.

### 4.2 Isolate-Monitors Interaction
In `appIcons.js:148-154`, Dash to Dock connects to `global.display.window-entered-monitor` when `isolate-monitors` is enabled. It filters icons on each dock actor to windows present on that actor's monitor.
Adaptive Dock's policy engine operates at the window/workspace visibility level and does not alter icon filtering, guaranteeing full compatibility.
