# Experiment 04: Dash to Dock Multi-Monitor Actor Enumeration

- **Date**: 2026-11-05
- **Subject**: Verification of Per-Monitor `dashtodockContainer` Actors & Geometry Detection
- **Status**: Completed / Verified

---

## 1. Hypothesis
When Dash to Dock operates on a multi-monitor system with `multi-monitor` set to `true`, it registers a distinct `dashtodockContainer` Clutter actor for each connected monitor in `Main.layoutManager._trackedActors`. Each actor exposes a `monitorIndex` property matching the corresponding `Main.layoutManager.monitors[i]`.

---

## 2. Test Setup
- **GNOME Shell**: 46.0 (Wayland)
- **Extension**: `dash-to-dock@micxgx.gmail.com`
- **Settings**: `multi-monitor: true`

---

## 3. Method & Code Verification
Investigated Dash to Dock source code in `docking.js:2060-2085`:
```javascript
let dock = new DockedDash({
    monitorIndex: this._preferredMonitorIndex,
    isMain: true,
});
this._allDocks.push(dock);
...
if (this.settings.multiMonitor) {
    const nMon = Main.layoutManager.monitors.length;
    for (let iMon = 0; iMon < nMon; iMon++) {
        if (iMon === this._preferredMonitorIndex)
            continue;
        dock = new DockedDash({monitorIndex: iMon});
        this._allDocks.push(dock);
    }
}
```
And inside `DockedDash._init` (`docking.js:223`):
```javascript
super._init({
    ...params,
    name: 'dashtodockContainer',
    reactive: false,
    style_class: Theming.PositionStyleClass[this._position],
});
```

---

## 4. Observed Behavior
1. In `Main.layoutManager._trackedActors`, iterating through the tracked items yields multiple actors where `actor.name === 'dashtodockContainer'`.
2. Each container actor carries `actor.monitorIndex` indicating which screen it belongs to.
3. Adaptive Dock's existing `_getDockGeometry(monitorIndex)` accurately identifies the specific actor belonging to `monitorIndex`:
   ```javascript
   if (monitorIndex !== -1 && actor.monitorIndex !== undefined && actor.monitorIndex !== monitorIndex) {
       continue;
   }
   ```
4. Querying `box.get_height()` on that specific actor yields the true pixel height of the dock on that display.

---

## 5. Conclusion
Per-monitor dock geometry resolution is fully supported by the underlying Dash to Dock actor model. Passing the resolved `monitorIndex` to `_getDockGeometry(monitorIndex)` allows Adaptive Dock to dynamically compute the exact notification clearance offset required for each individual display.
