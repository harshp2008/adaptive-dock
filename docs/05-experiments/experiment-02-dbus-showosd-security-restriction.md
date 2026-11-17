# Experiment 02: D-Bus ShowOSD Security Authorization Restriction

- **Date**: 2026-11-05
- **Subject**: Evaluation of `org.gnome.Shell.ShowOSD` D-Bus Interface
- **Status**: Completed / Security Restriction Discovered & Documented

---

## 1. Hypothesis
The GNOME Shell D-Bus method `org.gnome.Shell.ShowOSD` accepts a dictionary parameter including `{ 'connector': <string> }`. We hypothesized that this D-Bus method could be used as an alternative or fallback for showing monitor-scoped OSD notifications from helper processes or external preferences windows.

---

## 2. Test Setup
- **Operating System**: Linux 6.8.0-48-generic (x86_64)
- **Desktop Environment**: GNOME Shell 46.0 (Wayland)
- **Tool**: `gdbus` CLI tool communicating over the user session bus.

---

## 3. Method
Attempted to invoke `ShowOSD` targeting connector `eDP-1`:
```bash
gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell \
  --method org.gnome.Shell.ShowOSD \
  '{"connector": <"eDP-1">, "label": <"Test OSD eDP-1">, "icon": <"view-reveal-symbolic">}'
```

---

## 4. Observed Result

**Raw Terminal Output**:
```text
Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: ShowOSD is not allowed
```

---

## 5. Source Investigation & Root Cause
We traced this failure to `/org/gnome/shell/ui/shellDBus.js` in GNOME Shell:
```javascript
// Lines 26-29
this._senderChecker = new DBusSenderChecker([
    'org.gnome.Settings',
    'org.gnome.SettingsDaemon.MediaKeys',
]);

// Lines 115-121
async ShowOSDAsync([params], invocation) {
    try {
        await this._senderChecker.checkInvocation(invocation);
    } catch (e) {
        invocation.return_gerror(e);
        return;
    }
```
GNOME Shell enforces sender verification on `ShowOSDAsync`. Only `org.gnome.Settings` and `org.gnome.SettingsDaemon.MediaKeys` are authorized to invoke this method over D-Bus.

---

## 6. Conclusion
1. The D-Bus `ShowOSD` interface is intentionally restricted and inaccessible to general session processes, unprivileged scripts, or extension preference dialogs (`prefs.js`).
2. An extension running inside the GNOME Shell process (`extension.js`) must invoke `Main.osdWindowManager.show(monitorIndex, ...)` directly in-process. Direct in-process invocation has complete authorization and zero IPC overhead.
