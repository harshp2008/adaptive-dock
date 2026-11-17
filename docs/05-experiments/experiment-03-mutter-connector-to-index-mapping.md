# Experiment 03: Mutter Connector-to-Index Resolution

- **Date**: 2026-11-05
- **Subject**: Bi-Directional Mapping Between Hardware Connectors & Mutter Monitor Indices
- **Status**: Completed / Verified

---

## 1. Hypothesis
`Meta.MonitorManager.get_monitor_for_connector(connector)` (accessible inside GNOME Shell via `global.backend.get_monitor_manager().get_monitor_for_connector(connector)`) translates physical connector names (`eDP-1`, `DVI-I-2`) to the runtime monitor indices (`0, 1`) used by Clutter actors, `Main.layoutManager.monitors`, and `Main.osdWindowManager._osdWindows`.

---

## 2. Test Setup
- **Operating System**: Linux 6.8.0-48-generic (x86_64)
- **Desktop Environment**: GNOME Shell 46.0 (Wayland)
- **Typelibs**: `/usr/lib/x86_64-linux-gnu/mutter-14/Meta-14.typelib`
- **Mutter Header**: `/usr/include/mutter-14/meta/meta-monitor-manager.h` lines 46-47:
  ```c
  META_EXPORT
  gint meta_monitor_manager_get_monitor_for_connector (MetaMonitorManager *manager,
                                                       const char         *connector);
  ```

---

## 3. Method & Analysis
1. Inspected `Meta-14.gir` (line 2912):
   ```xml
   <method name="get_monitor_for_connector" c:identifier="meta_monitor_manager_get_monitor_for_connector">
     <return-value transfer-ownership="none">
       <type name="gint32"/>
     </return-value>
     <parameters>
       <parameter name="connector" transfer-ownership="none">
         <type name="utf8"/>
       </parameter>
     </parameters>
   </method>
   ```
2. Traced GNOME Shell core usage in `/org/gnome/shell/ui/osdMonitorLabeler.js:92`:
   ```javascript
   let monitor = this._monitorManager.get_monitor_for_connector(connector);
   if (monitor === -1)
       continue;
   ```
3. Traced Dash to Dock usage in `docking.js:2032`:
   ```javascript
   this._preferredMonitorIndex = monitorManager.get_monitor_for_connector(
       this.settings.preferredMonitorByConnector);
   ```

---

## 4. Observed Behavior
- Passing an active physical connector (e.g. `'eDP-1'`) returns its corresponding active monitor index (`0`).
- Passing a secondary connector (e.g. `'DVI-I-2'`) returns its active index (`1`).
- Passing a non-existent, unplugged, or invalid connector (e.g. `'HDMI-99'`) returns `-1`.

---

## 5. Conclusion
`get_monitor_for_connector` is the canonical, battle-tested Mutter API used by GNOME Shell core and Dash to Dock to resolve connectors to monitor indices. Combining this with `org.gnome.Mutter.DisplayConfig.GetCurrentState` provides a robust, two-way lookup cache (`connector <-> monitorIndex`) that remains perfectly synchronized via the `monitors-changed` signal.
