# On-Screen Display (OSD) Scoping & Elevation Clearance

## 1. GNOME Shell OSD Architecture

GNOME Shell renders transient visual feedback pills (e.g., volume, brightness, keyboard backlight, and extension notifications) through `Main.osdWindowManager`.

### 1.1 Actor Hierarchy & Internal Mechanics
Inside `/org/gnome/shell/ui/osdWindow.js`:
- `OsdWindowManager` maintains an internal array `this._osdWindows = []`.
- When `Main.layoutManager` emits `'monitors-changed'`, `_monitorsChanged()` creates an instance of `OsdWindow` for every active monitor index (`0 <= i < Main.layoutManager.monitors.length`).
- Each `OsdWindow` is constrained to its respective monitor via `Layout.MonitorConstraint({ index: monitorIndex })`.
- The actor contains:
  ```text
  OsdWindow (Clutter.Actor, centered horizontally, bottom aligned)
  └── _hbox (St.BoxLayout, class 'osd-window')
      ├── _icon (St.Icon)
      └── _vbox (St.BoxLayout)
          ├── _label (St.Label)
          └── _level (BarLevel)
  ```

---

## 2. Global vs Scoped OSD Invocations

### 2.1 The Legacy Global Mechanism
In the original implementation (`extension.js:497-503`):
```javascript
Main.osdWindowManager.show(-1, icon, label, null, null);
```
Passing `-1` triggers the fallback branch in `osdWindow.js:195-197`:
```javascript
for (let i = 0; i < this._osdWindows.length; i++)
    this._showOsdWindow(i, icon, label, level, maxLevel);
```
This forces the notification to display across **all** connected monitors simultaneously, even when the user is typing on a single screen.

### 2.2 The Monitor-Scoped Mechanism
Passing a non-negative `monitorIndex` (`0 <= monitorIndex < this._osdWindows.length`) triggers `osdWindow.js:186-193`:
```javascript
if (monitorIndex !== -1) {
    for (let i = 0; i < this._osdWindows.length; i++) {
        if (i === monitorIndex)
            this._showOsdWindow(i, icon, label, level, maxLevel);
        else
            this._osdWindows[i].cancel();
    }
}
```
This guarantees:
1. The OSD appears **exclusively** on the target display.
2. Any lingering notification on other displays is immediately canceled (`.cancel()`).

---

## 3. Per-Monitor Vertical Elevation & Clearance Offset

Adaptive Dock features automatic dock clearance (`auto-elevate-dock`), which raises the notification pill so it does not collide with a bottom-mounted dock.

### 3.1 Per-Monitor Geometry Calculation
Because docks on different monitors may have different sizes, icon counts, or positions, the clearance offset must be calculated per monitor index:
```javascript
const geom = this._getDockGeometry(targetMonitorIndex);
const extraOffset = this._kb.get_int('notification-vertical-offset');
const offset = Math.max(0, geom.recommendedOffset + extraOffset);
```

### 3.2 Ephemeral Offset Application
Instead of shifting every OSD window globally, the elevation offset is applied **only** to the target monitor's OSD actor:
```javascript
const osd = Main.osdWindowManager._osdWindows?.[targetMonitorIndex];
if (osd) {
    if (osd._hbox) osd._hbox.translation_y = -offset;
    else osd.translation_y = -offset;

    // Ephemeral reset hook: restore translation_y = 0 when notification hides
    if (!osd._adaptiveDockResetId) {
        osd._adaptiveDockResetId = osd.connect('notify::visible', () => {
            if (!osd.visible) {
                if (osd._hbox) osd._hbox.translation_y = 0;
                else osd.translation_y = 0;
                if (osd._adaptiveDockResetId) {
                    try { osd.disconnect(osd._adaptiveDockResetId); } catch (_e) {}
                    osd._adaptiveDockResetId = null;
                }
            }
        });
    }
}
```

---

## 4. Dual-Monitor Worked Example

Consider a dual-monitor system:
- **Monitor 0**: Built-in laptop display (`eDP-1`, primary, scale 1.0, dock height = 68px).
- **Monitor 1**: External secondary display (`DVI-I-2`, scale 1.75, dock hidden or top panel).

### Scenario: User presses `Shift+Super+D` on Monitor 1 (`DVI-I-2`)
1. **Focus Resolution**:
   - `global.display.focus_window.get_monitor()` returns `1`.
   - Connector cache resolves `1 -> 'DVI-I-2'`.
2. **State Mutation**:
   - Toggles session state for `'DVI-I-2'` from `show` to `hide`.
   - Monitor 0 (`eDP-1`) remains unchanged.
3. **Geometry Resolution**:
   - Calls `_getDockGeometry(1)`. Target dock is hidden, so `recommendedOffset = 0`.
   - Target elevation offset = `0px`.
4. **Elevation Application**:
   - Only `Main.osdWindowManager._osdWindows[1]` is modified (`translation_y = 0`).
   - `Main.osdWindowManager._osdWindows[0]` is untouched.
5. **OSD Invocation**:
   - Calls `Main.osdWindowManager.show(1, icon, "Active Window: Dock Hidden", null, null)`.
   - Result:
     - Monitor 1 displays the OSD pill.
     - Monitor 0 remains completely quiet.

---

## 5. Fallback Policy

If connector or monitor index resolution fails at any stage:
1. If `monitorIndex` is `< 0` or `>= Main.layoutManager.monitors.length`:
   - Fall back to `Main.layoutManager.primaryIndex`.
2. If `primaryIndex` is invalid (`< 0`):
   - Fall back to index `0`.
3. If `Main.layoutManager.monitors.length === 0` (headless session):
   - Suppress the OSD call safely; log warning at debug level. Under no circumstances will a missing display cause an uncaught exception.
