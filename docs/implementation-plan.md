# Implementation Plan: Per-Monitor Isolation

## 1. Files to Modify

| File Path | Description of Changes |
|---|---|
| `extension/adaptive-dock@harsh.patel/schemas/org.gnome.shell.extensions.adaptive-dock.gschema.xml` | Declare `per-monitor-isolation` boolean GSettings key (default: `true`). |
| `extension/adaptive-dock@harsh.patel/extension.js` | Implement `MonitorManager` / connector cache, `getFocusedMonitor()`, per-monitor session maps, monitor-keyed `_apply()`, scoped shortcut handlers, and monitor-scoped OSD. |
| `extension/adaptive-dock@harsh.patel/prefs.js` | Add "Per-Monitor Isolation" switch in General page. Add active monitor switcher to Apps & Workspaces pages to allow viewing/editing rules per connected display. |

---

## 2. New GSettings Keys

```xml
<key name="per-monitor-isolation" type="b">
  <default>true</default>
  <summary>Per-monitor dock isolation</summary>
  <description>When true, dock visibility rules, shortcuts, session state, and OSD notifications are isolated per monitor.</description>
</key>
```

---

## 3. New Helper Functions & Architecture

### 3.1 Display & Connector Resolution Subsystem
- `_initMonitorManager()`: Connects to `Main.layoutManager.connect('monitors-changed')`.
- `_updateMonitorsCache()`: Queries `org.gnome.Mutter.DisplayConfig.GetCurrentState` synchronously via `Gio.DBus.session`, populating:
  - `this._connectorToIndex = new Map()`
  - `this._indexToConnector = new Map()`
  - `this._activeConnectors = new Set()`
  - `this._primaryConnector = string`
- `getFocusedMonitor()`:
  - Resolves target monitor index (`focus_window?.get_monitor() ?? global.display.get_current_monitor() ?? primaryIndex`).
  - Resolves connector name from cache (with robust fallbacks).
  - Returns `{ index: number, connector: string, isPrimary: boolean }`.

### 3.2 Per-Monitor Persistence Methods
- `_checkAndMigrate()`: On extension enable, checks if `dock-monitor-app-states.json` and `dock-workspace-states/<connector>/` exist. If missing, clones legacy rules to the primary connector.
- `_loadPerMonitorAppStates()`: Reads and writes `~/.config/dock-monitor-app-states.json`.
- `_loadPerMonitorWorkspaceState(connector, wsIndex)`: Reads `~/.config/dock-workspace-states/<connector>/<name>.state`.
- `_writePerMonitorWorkspaceState(connector, wsIndex, state)`: Writes to `~/.config/dock-workspace-states/<connector>/<name>.state`.

### 3.3 Scoped State Machine (`_apply`)
- Accepts `targetConnector` or resolves via `getFocusedMonitor()`.
- Session overrides checked in `this._perMonitorSessionAppStates.get(connector)`.
- Persistent rules checked in `this._perMonitorAppStates[connector]`.
- Cache key updated to `${connector}:${wsIndex}:${winId ?? appId}`.
- Per-monitor last non-bypassed state maintained in `this._perMonitorLastShowState.get(connector)`.

### 3.4 Scoped Shortcuts (`_toggleApp` & `_toggleWorkspace`)
- Invokes `getFocusedMonitor()`.
- Updates session/persistent state **only** for the resolved connector.
- Calls `_showOsd(icon, label, targetMonitor.index)`.

### 3.5 Scoped OSD (`_showOsd`)
- Computes `_getDockGeometry(targetMonitorIndex)`.
- Applies vertical clearance elevation `translation_y = -offset` **only** to `Main.osdWindowManager._osdWindows[targetMonitorIndex]`.
- Invokes `Main.osdWindowManager.show(targetMonitorIndex, icon, label, null, null)`.

---

## 4. Risk Mitigation & Resilience Notes

1. **Connector Resolution Failure**: If Mutter D-Bus returns an error or display disconnects during evaluation, falls back cleanly to index `0` and connector `'default'`. Shell never throws unhandled exceptions.
2. **Re-entrancy / Fast Switching**: Focus switches trigger debounced evaluation; cache key prevents redundant executions.
3. **Rollback Guarantee**: When `per-monitor-isolation` is `false`, all code branches divert cleanly to the legacy monitor-agnostic functions, preserving byte-for-byte fidelity with the prior release.
