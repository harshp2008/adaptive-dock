# Migration, Upgrade & Rollback Procedures

## 1. Upgrading to Per-Monitor Isolation

### 1.1 Automatic Migration Sequence
When the user installs the updated extension:
1. The new GSettings key `per-monitor-isolation` defaults to `true`.
2. On extension load (`enable()`), the state machine runs `_checkAndMigrate()`:
   - It queries Mutter to resolve the current primary display connector (e.g. `eDP-1`).
   - If `~/.config/dock-monitor-app-states.json` does not exist:
     - It reads all existing application rules from `~/.config/dock-app-states.json`.
     - It creates `~/.config/dock-monitor-app-states.json` containing:
       ```json
       {
         "version": 1,
         "monitors": {
           "<primary-connector>": {
             /* All preexisting app rules cloned here */
           }
         }
       }
       ```
     - The original `~/.config/dock-app-states.json` is left completely intact on disk.
   - For workspace states:
     - It inspects `~/.config/dock-workspace-states/`.
     - For every `<workspace>.state` file in the root of that folder, it copies the file into `~/.config/dock-workspace-states/<primary-connector>/<workspace>.state`.
     - The original root `.state` files remain untouched.
3. The migration is non-destructive, atomic, and instantaneous.

---

## 2. Rollback Procedures

If a user wishes to return to the legacy global behavior, they can do so immediately via GUI or CLI.

### 2.1 Disabling via GUI (Preferences)
1. Open **Adaptive Dock Preferences**:
   ```bash
   gnome-extensions prefs adaptive-dock@harsh.patel
   ```
2. Navigate to **General > Multi-Monitor Behavior**.
3. Toggle off **Per-Monitor Isolation**.

### 2.2 Disabling via Command Line (GSettings)
```bash
gsettings set org.gnome.shell.extensions.adaptive-dock per-monitor-isolation false
```

### 2.3 System State Upon Rollback
When `per-monitor-isolation` is `false`:
- The extension immediately switches back to the legacy state machine.
- All state reads and writes target `~/.config/dock-app-states.json` and the root of `~/.config/dock-workspace-states/`.
- All OSD calls pass `-1` to `Main.osdWindowManager.show()`, broadcasting to all monitors.
- Shortcuts toggle dock state globally across all screens simultaneously.

### 2.4 Data Retention Semantics
- **No data is lost during rollback**:
  - The per-monitor files (`dock-monitor-app-states.json` and `dock-workspace-states/<connector>/`) are preserved on disk.
  - If the user re-enables `per-monitor-isolation` at any time in the future, their per-monitor configurations are instantly restored without reconfiguration.
- **Manual Purge (Optional)**:
  If a user desires a completely clean slate removing all per-monitor data:
  ```bash
  rm -f ~/.config/dock-monitor-app-states.json
  rm -rf ~/.config/dock-workspace-states/*/
  ```
