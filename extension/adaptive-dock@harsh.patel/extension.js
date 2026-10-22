import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const APP_STATES = GLib.build_filenamev([GLib.get_user_config_dir(), 'dock-app-states.json']);
const WS_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'dock-workspace-states']);
const SCHEMAS = ['org.gnome.shell.extensions.dash-to-dock', 'org.gnome.shell.extensions.ubuntu-dock'];

export default class AdaptiveDock extends Extension {
    enable() {
        this._settings = this._getDockSettings();
        if (!this._settings) {
            console.warn('Adaptive Dock: Dash to Dock / Ubuntu Dock not found');
            return;
        }
        this._wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._tracker = Shell.WindowTracker.get_default();
        this._appStates = {};
        this._loadAppStates();

        // In-memory session state maps
        this._sessionAppStates = new Map();
        this._sessionWindowStates = new Map();
        this._sessionWorkspaceStates = new Map();
        this._windowSignals = new Map();
        this._lastWasBypassed = false;
        this._deferTimeoutId = null;
        this._lastNonBypassedShowState = this._settings.get_boolean('intellihide');

        // reload app states when prefs edits the file
        this._monitor = Gio.File.new_for_path(APP_STATES).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monId = this._monitor.connect('changed', () => {
            this._loadAppStates();
            this._apply(true);
        });

        this._kb = this.getSettings('org.gnome.shell.extensions.adaptive-dock');
        try {
            Main.wm.removeKeybinding('toggle-dock');
        } catch (_e) {}
        try {
            Main.wm.removeKeybinding('toggle-workspace-dock');
        } catch (_e) {}

        Main.wm.addKeybinding('toggle-dock', this._kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggleApp());

        Main.wm.addKeybinding('toggle-workspace-dock', this._kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggleWorkspace());

        this._edgeRevealId = this._kb.connect('changed::edge-hover-reveal', () => this._apply(true));
        this._notifOffsetId = this._kb.connect('changed::notification-vertical-offset', () => this._updateOsdOffset());
        this._updateOsdOffset();
        this._addWsId = this._kb.connect('changed::request-add-workspace', () => {
            try {
                if (global.workspace_manager) {
                    global.workspace_manager.append_new_workspace(false, global.get_current_time());
                    this._syncWorkspaces();
                }
            } catch (e) {
                console.warn(`Adaptive Dock: could not append workspace: ${e.message}`);
            }
        });

        this._focusId = global.display.connect('notify::focus-window', () => this._apply());
        this._wsActiveId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._apply();
            this._syncWorkspaces();
        });
        this._wsCountId = global.workspace_manager.connect('notify::n-workspaces', () => this._syncWorkspaces());
        this._wsReorderId = global.workspace_manager.connect('workspaces-reordered', () => this._syncWorkspaces());
        this._winTrackId = this._tracker.connect('tracked-windows-changed', () => this._syncWorkspaces());
        this._wmNamesId = this._wm.connect('changed::workspace-names', () => this._syncWorkspaces());

        this._syncWorkspaces();
        this._apply(true);
    }

    disable() {
        if (this._kb) {
            Main.wm.removeKeybinding('toggle-dock');
            Main.wm.removeKeybinding('toggle-workspace-dock');
            if (this._edgeRevealId) this._kb.disconnect(this._edgeRevealId);
            if (this._notifOffsetId) this._kb.disconnect(this._notifOffsetId);
            if (this._addWsId) this._kb.disconnect(this._addWsId);
            this._kb = null;
        }
        if (this._focusId) global.display.disconnect(this._focusId);
        if (this._wsActiveId) global.workspace_manager.disconnect(this._wsActiveId);
        if (this._wsCountId) global.workspace_manager.disconnect(this._wsCountId);
        if (this._wsReorderId) global.workspace_manager.disconnect(this._wsReorderId);
        if (this._winTrackId) this._tracker?.disconnect(this._winTrackId);
        if (this._wmNamesId) this._wm?.disconnect(this._wmNamesId);
        if (this._monId) this._monitor?.disconnect(this._monId);
        this._monitor?.cancel();

        if (this._windowSignals) {
            for (const { win, id } of this._windowSignals.values()) {
                try {
                    win.disconnect(id);
                } catch (_e) {}
            }
            this._windowSignals.clear();
        }

        this._sessionAppStates?.clear();
        this._sessionWindowStates?.clear();
        this._sessionWorkspaceStates?.clear();

        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }
        this._lastWasBypassed = false;
        this._lastNonBypassedShowState = null;

        if (Main.osdWindowManager?._osdWindows) {
            for (const osd of Main.osdWindowManager._osdWindows) {
                if (osd?._hbox) osd._hbox.translation_y = 0;
                if (osd) osd.translation_y = 0;
            }
        }

        this._focusId = this._wsActiveId = this._wsCountId = this._wsReorderId = null;
        this._winTrackId = this._wmNamesId = this._monId = this._monitor = this._edgeRevealId = this._notifOffsetId = null;
        this._settings = this._wm = this._tracker = this._appStates = null;
        this._sessionAppStates = this._sessionWindowStates = this._sessionWorkspaceStates = this._windowSignals = null;
        this._lastKey = null;
    }

    _getDockSettings() {
        const src = Gio.SettingsSchemaSource.get_default();
        for (const id of SCHEMAS) {
            if (src.lookup(id, true))
                return new Gio.Settings({schema_id: id});
        }
        const dirs = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'dash-to-dock@micxgx.gmail.com', 'schemas']),
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'ubuntu-dock@ubuntu.com', 'schemas']),
            '/usr/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas',
            '/usr/share/gnome-shell/extensions/ubuntu-dock@ubuntu.com/schemas',
        ];
        for (const dir of dirs) {
            if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
                try {
                    const custom = Gio.SettingsSchemaSource.new_from_directory(dir, src, false);
                    for (const id of SCHEMAS) {
                        const schema = custom.lookup(id, true);
                        if (schema) return new Gio.Settings({settings_schema: schema});
                    }
                } catch (_e) {}
            }
        }
        return null;
    }

    _readText(path) {
        try {
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            return ok ? new TextDecoder().decode(bytes).trim() : null;
        } catch (_e) {
            return null;
        }
    }

    _loadAppStates() {
        try {
            this._appStates = JSON.parse(this._readText(APP_STATES) ?? '{}') ?? {};
        } catch (_e) {
            this._appStates = {};
        }
    }

    _hasKey(key) {
        if (!this._settings) return false;
        try {
            return this._settings.get_value(key) !== null;
        } catch (_e) {
            return false;
        }
    }

    _setDockVisibility(show) {
        if (!this._settings) return;
        const hoverReveal = this._kb ? this._kb.get_boolean('edge-hover-reveal') : false;

        // 1. Intelligent autohide must be turned on at all times (dock-fixed = false)
        if (this._hasKey('dock-fixed') && this._settings.get_boolean('dock-fixed') !== false)
            this._settings.set_boolean('dock-fixed', false);

        // 2. Autohide must be turned on at all times
        if (this._hasKey('autohide') && this._settings.get_boolean('autohide') !== true)
            this._settings.set_boolean('autohide', true);

        // 3. Match "Reveal dock on mouse hover" with "Push to show: require pressure to show the dock"
        const targetPressure = !hoverReveal;
        if (this._hasKey('require-pressure-to-show') && this._settings.get_boolean('require-pressure-to-show') !== targetPressure)
            this._settings.set_boolean('require-pressure-to-show', targetPressure);

        // 4. Toggle Dodge windows (intellihide) to show and hide the dock
        if (this._hasKey('intellihide') && this._settings.get_boolean('intellihide') !== show)
            this._settings.set_boolean('intellihide', show);
    }

    _getWindowIdentifiers(win) {
        if (!win) return [];
        const ids = [];
        try {
            const app = this._tracker?.get_window_app(win);
            if (app) {
                const id = app.get_id();
                if (id) ids.push(id.replace(/\.desktop$/, ''));
            }
        } catch (_e) {}
        try {
            const cls = win.get_wm_class?.();
            if (cls) ids.push(cls.replace(/\.desktop$/, ''));
        } catch (_e) {}
        try {
            const inst = win.get_wm_class_instance?.();
            if (inst) ids.push(inst.replace(/\.desktop$/, ''));
        } catch (_e) {}
        try {
            const gtkId = win.get_gtk_application_id?.();
            if (gtkId) ids.push(gtkId.replace(/\.desktop$/, ''));
        } catch (_e) {}
        try {
            const sandboxed = win.get_sandboxed_app_id?.();
            if (sandboxed) ids.push(sandboxed.replace(/\.desktop$/, ''));
        } catch (_e) {}
        return [...new Set(ids.filter(id => id && id.toLowerCase() !== 'gjs'))];
    }

    _getFocusAppWindow() {
        const win = global.display.focus_window;
        if (!win) return null;

        // Skip background desktop windows, overlays, and taskbar-skipping helpers (e.g. DING desktop icons)
        if (win.skip_taskbar) return null;

        const type = win.get_window_type ? win.get_window_type() : null;
        if (type !== null && (
            type === Meta.WindowType.DESKTOP ||
            type === Meta.WindowType.DOCK
        )) {
            return null;
        }

        const ids = this._getWindowIdentifiers(win);
        if (ids.length === 0) return null;

        return win;
    }

    _resolveAppState(ids) {
        if (!ids || ids.length === 0) return 'none';
        for (const id of ids) {
            if (this._appStates[id]) return this._appStates[id];
        }
        for (const id of ids) {
            const lowerId = id.toLowerCase();
            for (const key in this._appStates) {
                const lowerKey = key.toLowerCase();
                if (lowerId.includes(lowerKey) || lowerKey.includes(lowerId)) {
                    return this._appStates[key];
                }
            }
        }
        return 'none';
    }

    _appState(appId) {
        if (!appId) return 'none';
        return this._resolveAppState([appId]);
    }

    _getWorkspaceName(wsIndex) {
        if (!this._wm) return `Workspace ${wsIndex + 1}`;
        const names = this._wm.get_strv('workspace-names') || [];
        return names[wsIndex] || `Workspace ${wsIndex + 1}`;
    }

    _workspaceState(wsIndex) {
        const name = this._getWorkspaceName(wsIndex);
        return this._readText(GLib.build_filenamev([WS_DIR, `${name}.state`]));
    }

    _updateOsdOffset() {
        try {
            const offset = this._kb ? this._kb.get_int('notification-vertical-offset') : 80;
            if (Main.osdWindowManager?._osdWindows) {
                for (const osd of Main.osdWindowManager._osdWindows) {
                    if (osd?._hbox) {
                        osd._hbox.translation_y = -offset;
                    } else if (osd) {
                        osd.translation_y = -offset;
                    }
                }
            }
        } catch (e) {
            console.warn(`Adaptive Dock: failed to update OSD offset: ${e.message}`);
        }
    }

    _showOsd(iconName, label) {
        try {
            this._updateOsdOffset();

            let icon = null;
            if (iconName) {
                try {
                    icon = Gio.Icon.new_for_string(iconName);
                } catch (_e) {
                    try {
                        icon = new Gio.ThemedIcon({name: iconName});
                    } catch (_e2) {}
                }
            }
            if (!icon) {
                icon = Gio.Icon.new_for_string('user-desktop-symbolic');
            }

            if (typeof Main.osdWindowManager?.showAll === 'function') {
                Main.osdWindowManager.showAll(icon, label, null, null);
            } else if (typeof Main.osdWindowManager?.show === 'function') {
                Main.osdWindowManager.show(-1, icon, label, null, null);
            } else {
                console.warn('Adaptive Dock: No supported OSD display method found on Main.osdWindowManager');
            }
        } catch (e) {
            console.warn(`Adaptive Dock: OSD display failed: ${e.message}`);
        }
    }

    _syncWorkspaces() {
        if (!this._kb || !global.workspace_manager) return;

        const wm = global.workspace_manager;
        const n = wm.get_n_workspaces();
        let maxUsedIndex = -1;

        for (let i = 0; i < n; i++) {
            const ws = wm.get_workspace_by_index(i);
            if (!ws) continue;
            const windows = ws.list_windows().filter(w => !w.is_on_all_workspaces() && !w.skip_taskbar);
            if (windows.length > 0) {
                maxUsedIndex = i;
            }
        }

        // Keep at least 4 workspaces, and at least 1 more than current number of workspaces in use
        const targetCount = Math.max(4, maxUsedIndex + 2, n);
        const names = this._wm.get_strv('workspace-names');
        const wsList = [];

        for (let i = 0; i < targetCount; i++) {
            wsList.push(names[i] || `Workspace ${i + 1}`);
        }

        const currentList = this._kb.get_strv('workspace-list');
        if (JSON.stringify(currentList) !== JSON.stringify(wsList)) {
            this._kb.set_strv('workspace-list', wsList);
        }
    }

    _isPerWindow(appId) {
        if (!appId || !this._kb) return false;
        const perWindowApps = this._kb.get_strv('per-window-apps') || [];
        if (perWindowApps.includes(appId)) return true;

        const perAppApps = this._kb.get_strv('per-app-apps') || [];
        if (perAppApps.includes(appId)) return false;

        return this._kb.get_boolean('remember-per-window');
    }

    _toggleApp() {
        if (!this._settings) return;
        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }

        const win = this._getFocusAppWindow();
        if (!win) {
            this._toggleWorkspace();
            return;
        }

        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const appRule = this._resolveAppState(ids);

        // If currently focused window belongs to a bypassed app, do not record session override for it
        if (appRule === 'bypass') return;

        const currentShow = this._settings.get_boolean('intellihide');
        const nextShow = !currentShow;
        console.log(`Adaptive Dock: _toggleApp() invoked! currentShow=${currentShow} -> nextShow=${nextShow}`);
        this._setDockVisibility(nextShow);
        this._lastNonBypassedShowState = nextShow;

        let appName = 'Active Window';
        try {
            const app = this._tracker?.get_window_app(win);
            if (app) appName = app.get_name();
            else if (win?.title) appName = win.title;
        } catch (_e) {}

        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        if (rememberSession && appId) {
            const perWindow = this._isPerWindow(appId);
            if (perWindow) {
                const winId = win.get_id();
                this._sessionWindowStates.set(winId, nextShow ? 'show' : 'hide');
                if (!this._windowSignals.has(winId)) {
                    const id = win.connect('unmanaged', () => {
                        this._sessionWindowStates.delete(winId);
                        this._windowSignals.delete(winId);
                    });
                    this._windowSignals.set(winId, { win, id });
                }
            } else {
                for (const id of ids) {
                    this._sessionAppStates.set(id, nextShow ? 'show' : 'hide');
                }
            }
        }

        const shouldNotify = this._kb ? this._kb.get_boolean('notify-on-app-toggle') : true;
        if (shouldNotify) {
            const statusText = nextShow ? 'Shown' : 'Hidden';
            this._showOsd(nextShow ? 'user-desktop-symbolic' : 'view-paged-symbolic',
                `Dock: ${statusText} (${appName})`);
        }
    }

    _toggleWorkspace() {
        if (!this._settings || !global.workspace_manager) return;
        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }

        const wsIndex = global.workspace_manager.get_active_workspace_index();
        const wsName = this._getWorkspaceName(wsIndex);

        let currentWsState = true;
        if (this._sessionWorkspaceStates.has(wsIndex)) {
            currentWsState = this._sessionWorkspaceStates.get(wsIndex) === 'show';
        } else {
            const wsDiskState = this._workspaceState(wsIndex);
            if (wsDiskState === 'false' || wsDiskState === 'hide') currentWsState = false;
            else currentWsState = true;
        }

        const nextShow = !currentWsState;
        this._sessionWorkspaceStates.set(wsIndex, nextShow ? 'show' : 'hide');
        console.log(`Adaptive Dock: _toggleWorkspace() invoked for ${wsName}! currentWsState=${currentWsState} -> nextShow=${nextShow}`);

        const win = this._getFocusAppWindow();
        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const winId = win ? win.get_id() : null;
        const appRule = this._resolveAppState(ids);

        // When toggling workspace baseline, clear any conflicting temporary in-memory session override on the active app/window
        if (winId && this._sessionWindowStates.has(winId)) {
            this._sessionWindowStates.delete(winId);
        }
        for (const id of ids) {
            this._sessionAppStates.delete(id);
        }

        const hasExplicitPersistentRule = appRule === 'show' || appRule === 'hide';

        // If the active window relies on the workspace baseline (or no app window is focused),
        // update dock visibility immediately
        if (!hasExplicitPersistentRule && appRule !== 'bypass') {
            this._setDockVisibility(nextShow);
            this._lastNonBypassedShowState = nextShow;
        }

        const shouldNotify = this._kb ? this._kb.get_boolean('notify-on-workspace-toggle') : true;
        if (shouldNotify) {
            if (hasExplicitPersistentRule) {
                const appStateText = appRule === 'show' ? 'Always Shown' : 'Always Hidden';
                this._showOsd('video-display-symbolic', `Workspace: ${nextShow ? 'Shown' : 'Hidden'} (App: ${appStateText})`);
            } else if (appRule === 'bypass') {
                this._showOsd('video-display-symbolic', `Workspace: ${nextShow ? 'Shown' : 'Hidden'} (App: Bypass)`);
            } else {
                const statusText = nextShow ? 'Shown' : 'Hidden';
                this._showOsd('video-display-symbolic', `Dock: ${statusText} (Workspace: ${wsName})`);
            }
        }
    }

    _apply(force = false) {
        if (!this._settings) return;

        // Cancel any pending deferred fallback
        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }

        const win = this._getFocusAppWindow();

        // If no window is focused and this is not a force-evaluation,
        // defer by 300ms to allow hotkey launchers, popup windows (like Win11Clip),
        // or window switches to complete before resetting to workspace defaults.
        if (!win && !force) {
            this._deferTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._deferTimeoutId = null;
                this._apply(true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const wsIndex = global.workspace_manager.get_active_workspace_index();
        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const winId = win ? win.get_id() : null;

        const key = `${wsIndex}:${winId ?? appId}`;
        if (!force && key === this._lastKey) return;
        this._lastKey = key;

        // 1. Bypass check: If window belongs to a bypassed app, preserve existing dock state!
        const appRule = this._resolveAppState(ids);
        if (win && appRule === 'bypass') {
            this._lastWasBypassed = true;
            // Actively enforce the last non-bypassed dock state (in case of transitional changes)
            if (this._lastNonBypassedShowState !== null) {
                this._setDockVisibility(this._lastNonBypassedShowState);
            }
            return;
        }
        this._lastWasBypassed = false;

        // 2. Determine target dock visibility (true = Show, false = Hide)
        let show = true;
        let sessionHandled = false;
        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        const perWindow = this._isPerWindow(appId);

        // Check app/window level session overrides
        if (rememberSession && win && appId) {
            if (perWindow && this._sessionWindowStates.has(winId)) {
                show = this._sessionWindowStates.get(winId) === 'show';
                sessionHandled = true;
            } else if (!perWindow) {
                for (const id of ids) {
                    if (this._sessionAppStates.has(id)) {
                        show = this._sessionAppStates.get(id) === 'show';
                        sessionHandled = true;
                        break;
                    }
                }
            }
        }

        if (!sessionHandled) {
            // Check persistent app rule
            if (appRule === 'hide') {
                show = false;
            } else if (appRule === 'show') {
                show = true;
            } else {
                // App is Default or no window focused: Check in-memory workspace session state
                if (this._sessionWorkspaceStates.has(wsIndex)) {
                    show = this._sessionWorkspaceStates.get(wsIndex) === 'show';
                } else {
                    // Check persistent workspace rule on disk
                    const wsState = this._workspaceState(wsIndex);
                    if (wsState === 'false' || wsState === 'hide') {
                        show = false;
                    } else if (wsState === 'true' || wsState === 'show') {
                        show = true;
                    } else {
                        // If no window is focused, but windows exist on this workspace,
                        // keep the last non-bypassed state to prevent transitional flickering
                        const currentWs = global.workspace_manager.get_active_workspace();
                        const wsWindows = currentWs ? currentWs.list_windows().filter(w => !w.is_on_all_workspaces() && !w.skip_taskbar) : [];
                        if (!win && wsWindows.length > 0 && this._lastNonBypassedShowState !== null) {
                            show = this._lastNonBypassedShowState;
                        } else {
                            // Default fallback: Show dock
                            show = true;
                        }
                    }
                }
            }
        }

        this._setDockVisibility(show);
        this._lastNonBypassedShowState = show;
    }
}
