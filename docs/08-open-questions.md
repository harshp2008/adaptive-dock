# Open Questions, Limitations & Research Notes

This document maintains an honest, institutional record of design limitations, unverified edge cases, and future exploration avenues.

---

## 1. Dash to Dock Upstream Limitations

### 1.1 Global `intellihide` in Dash to Dock / Ubuntu Dock
- **Limitation**: Dash to Dock's underlying architecture binds all dock actors to a single global GSettings key `intellihide`. Setting this key toggles the intellihide state across every monitor actor simultaneously.
- **Why**: Dash to Dock's `DockManager` does not expose per-monitor visibility GSettings keys or a public per-instance visibility API (`docking.js:616-621`).
- **Impact**: When Adaptive Dock decides to show or hide the dock based on the focused monitor, the underlying Dash to Dock extension toggles intellihide globally.
- **Current Mitigation**: Adaptive Dock maintains complete per-monitor isolation of:
  1. Focused-monitor policy resolution.
  2. Per-monitor transient session overrides.
  3. Per-monitor persistent application rules on disk.
  4. Per-monitor persistent workspace baselines on disk.
  5. Per-monitor OSD notification delivery.
- **Suggested Next Step**: Open an upstream feature request or pull request against `micheleg/dash-to-dock` proposing per-monitor intellihide GSettings keys (`intellihide-by-connector` or an array of monitor states).

---

## 2. Platform & Display Server Edge Cases

### 2.1 Multi-GPU Display Server Reconfiguration
- **Status**: Unverified on multi-discrete-GPU hardware configurations.
- **Why**: The primary test environment is an integrated GPU with an external display over DisplayPort/DVI. Systems with heterogeneous GPU switching (NVIDIA Optimus / Prime offloading) may re-enumerate connectors on GPU switch.
- **Suggested Next Step**: Test on dual-GPU laptops toggling between hybrid and dedicated graphics modes.

### 2.2 Wayland Headless Virtual Monitors
- **Status**: Verified in logic, but edge case of `Main.layoutManager.monitors.length === 0` cannot be triggered on normal hardware without a headless virtual test session.
- **Why**: Linux DRM drivers maintain at least one fallback framebuffer when Xwayland / Mutter boots.
- **Suggested Next Step**: Run automated CI tests with `dbus-run-session mutter --headless` to verify null-safety when zero monitors are reported.

### 2.3 Automated Periodic Pruning of Stale Connector Records
- **Status**: Chose not to automatically delete stale connector records on hotplug unplug.
- **Why**: Automatic deletion risks destroying user configurations during transient cable disconnections, sleep/wake cycles, or laptop docking station undocking.
- **Suggested Next Step**: Consider adding an age threshold (e.g. prune records for connectors not seen in 30 days) or a manual "Clean Up Disconnected Displays" button in Preferences.
