import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Legacy / global persistence paths
const APP_STATES = GLib.build_filenamev([GLib.get_user_config_dir(), 'dock-app-states.json']);
const WS_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'dock-workspace-states']);

// Per-monitor structured persistence paths
const MONITOR_APP_STATES = GLib.build_filenamev([GLib.get_user_config_dir(), 'dock-monitor-app-states.json']);

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

        // 1. Load legacy and per-monitor persistent stores
        this._appStates = {};
        this._monitorAppStates = { version: 1, monitors: {} };
        this._loadAppStates();
        this._loadMonitorAppStates();

        // 2. In-memory session state maps (legacy global domain)
        this._sessionAppStates = new Map();
        this._sessionWindowStates = new Map();
        this._sessionWorkspaceStates = new Map();
        this._windowSignals = new Map();
        this._lastWasBypassed = false;
        this._deferTimeoutId = null;
        this._lastNonBypassedShowState = this._settings.get_boolean('intellihide');

        // 3. Per-monitor in-memory session state and cache maps
        this._perMonitorSessionAppStates = new Map();
        this._perMonitorSessionWindowStates = new Map();
        this._perMonitorSessionWorkspaceStates = new Map();
        this._perMonitorLastShowState = new Map();
        this._connectorToIndex = new Map();
        this._indexToConnector = new Map();
        this._activeConnectors = new Set();
        this._primaryConnector = null;

        // 4. Multi-monitor enumeration and tracking
        this._kb = this.getSettings('org.gnome.shell.extensions.adaptive-dock');
        this._initMonitorTracking();
        this._checkAndMigrate();
        this._monitor = Gio.File.new_for_path(APP_STATES).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monId = this._monitor.connect('changed', () => {
            this._loadAppStates();
            if (!this._isIsolationEnabled()) this._apply(true);
        });

        this._perMonitorFileMonitor = Gio.File.new_for_path(MONITOR_APP_STATES).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._perMonitorMonId = this._perMonitorFileMonitor.connect('changed', () => {
            this._loadMonitorAppStates();
            if (this._isIsolationEnabled()) this._apply(true);
        });

        // 6. Settings and Keybindings
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
        this._defaultWsStateId = this._kb.connect('changed::default-workspace-state', () => this._apply(true));
        this._isolationSettingId = this._kb.connect('changed::per-monitor-isolation', () => {
            this._checkAndMigrate();
            this._apply(true);
        });

        // Intercept system OSD displays to ensure system level indicators (volume, brightness)
        // are never affected by notification offsets.
        if (Main.osdWindowManager && typeof Main.osdWindowManager._showOsdWindow === 'function') {
            this._origShowOsdWindow = Main.osdWindowManager._showOsdWindow;
            Main.osdWindowManager._showOsdWindow = (monitorIndex, icon, label, level, maxLevel) => {
                if (level !== null && level !== undefined) {
                    const osd = Main.osdWindowManager._osdWindows?.[monitorIndex];
                    if (osd?._hbox) osd._hbox.translation_y = 0;
                    else if (osd) osd.translation_y = 0;
                }
                this._origShowOsdWindow.call(Main.osdWindowManager, monitorIndex, icon, label, level, maxLevel);
            };
        }

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

        // 7. System Event Signals
        this._focusId = global.display.connect('notify::focus-window', () => this._apply());
        this._wsActiveId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._apply();
            this._syncWorkspaces();
        });
        this._wsCountId = global.workspace_manager.connect('notify::n-workspaces', () => this._syncWorkspaces());
        this._wsReorderId = global.workspace_manager.connect('workspaces-reordered', () => this._syncWorkspaces());
        this._winTrackId = this._tracker.connect('tracked-windows-changed', () => this._syncWorkspaces());
        this._wmNamesId = this._wm.connect('changed::workspace-names', () => this._syncWorkspaces());
        this._spaceBarSettingId = this._kb.connect('changed::integrate-space-bar', () => this._updateSpaceBarIntegration());

        // Perform first-run migration to initialize primary monitor rules if needed
        this._checkAndMigrate();

        this._syncWorkspaces();
        this._updateSpaceBarIntegration();
        this._apply(true);
    }

    disable() {
        this._cleanSpaceBarIntegration();

        if (this._origShowOsdWindow && Main.osdWindowManager) {
            Main.osdWindowManager._showOsdWindow = this._origShowOsdWindow;
            this._origShowOsdWindow = null;
        }

        if (this._monitorsChangedId && Main.layoutManager) {
            try {
                Main.layoutManager.disconnect(this._monitorsChangedId);
            } catch (_e) {}
            this._monitorsChangedId = null;
        }

        if (this._kb) {
            Main.wm.removeKeybinding('toggle-dock');
            Main.wm.removeKeybinding('toggle-workspace-dock');
            if (this._edgeRevealId) this._kb.disconnect(this._edgeRevealId);
            if (this._defaultWsStateId) this._kb.disconnect(this._defaultWsStateId);
            if (this._isolationSettingId) this._kb.disconnect(this._isolationSettingId);
            if (this._spaceBarSettingId) this._kb.disconnect(this._spaceBarSettingId);
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
        if (this._perMonitorMonId) this._perMonitorFileMonitor?.disconnect(this._perMonitorMonId);
        this._perMonitorFileMonitor?.cancel();

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

        this._perMonitorSessionAppStates?.clear();
        this._perMonitorSessionWindowStates?.clear();
        this._perMonitorSessionWorkspaceStates?.clear();
        this._perMonitorLastShowState?.clear();
        this._connectorToIndex?.clear();
        this._indexToConnector?.clear();
        this._activeConnectors?.clear();

        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }
        this._lastWasBypassed = false;
        this._lastNonBypassedShowState = null;

        if (Main.osdWindowManager?._osdWindows) {
            for (const osd of Main.osdWindowManager._osdWindows) {
                if (osd?._adaptiveDockResetId) {
                    try {
                        osd.disconnect(osd._adaptiveDockResetId);
                    } catch (_e) {}
                    osd._adaptiveDockResetId = null;
                }
                if (osd?._hbox) osd._hbox.translation_y = 0;
                if (osd) osd.translation_y = 0;
            }
        }

        this._focusId = this._wsActiveId = this._wsCountId = this._wsReorderId = null;
        this._winTrackId = this._wmNamesId = this._monId = this._monitor = this._perMonitorMonId = this._perMonitorFileMonitor = this._edgeRevealId = null;
        this._settings = this._wm = this._tracker = this._appStates = this._monitorAppStates = null;
        this._sessionAppStates = this._sessionWindowStates = this._sessionWorkspaceStates = this._windowSignals = null;
        this._perMonitorSessionAppStates = this._perMonitorSessionWindowStates = this._perMonitorSessionWorkspaceStates = this._perMonitorLastShowState = null;
        this._connectorToIndex = this._indexToConnector = this._activeConnectors = this._primaryConnector = null;
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

    _isIsolationEnabled() {
        return this._kb ? this._kb.get_boolean('per-monitor-isolation') : true;
    }

    // -------------------------------------------------------------
    // Multi-Monitor Hardware Tracking & Connector Cache
    // -------------------------------------------------------------

    _initMonitorTracking() {
        this._updateMonitorsCache();
        if (Main.layoutManager) {
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
                this._onMonitorsChanged();
            });
        }
    }

    _onMonitorsChanged() {
        this._updateMonitorsCache((_success) => {
            if (this._isIsolationEnabled()) {
                // Prune transient in-memory session maps for displays that have been unplugged
                for (const conn of this._perMonitorSessionAppStates.keys()) {
                    if (!this._activeConnectors.has(conn)) {
                        this._perMonitorSessionAppStates.delete(conn);
                        this._perMonitorSessionWindowStates.delete(conn);
                        this._perMonitorSessionWorkspaceStates.delete(conn);
                        this._perMonitorLastShowState.delete(conn);
                        console.log(`Adaptive Dock: Pruned in-memory session cache for disconnected monitor: ${conn}`);
                    }
                }
            }
            this._apply(true);
        });
    }

    _fallbackMonitorsCache() {
        if (!this._connectorToIndex) this._connectorToIndex = new Map();
        if (!this._indexToConnector) this._indexToConnector = new Map();
        if (!this._activeConnectors) this._activeConnectors = new Set();

        const nMonitors = Main.layoutManager?.monitors?.length || 1;
        const primaryIdx = Main.layoutManager?.primaryIndex ?? 0;
        for (let i = 0; i < nMonitors; i++) {
            const fallbackConn = (i === primaryIdx) ? (this._primaryConnector || 'primary') : `monitor-${i}`;
            this._connectorToIndex.set(fallbackConn, i);
            this._indexToConnector.set(i, fallbackConn);
            this._activeConnectors.add(fallbackConn);
        }
        if (!this._primaryConnector) {
            this._primaryConnector = this._indexToConnector.get(primaryIdx) || 'primary';
        }
    }

    _parseDisplayConfig(logicalMonitors) {
        const connToIdx = new Map();
        const idxToConn = new Map();
        const active = new Set();
        let primaryConn = null;

        const monitorManager = global.backend?.get_monitor_manager?.() ?? (Meta.MonitorManager ? Meta.MonitorManager.get() : null);

        for (let i = 0; i < logicalMonitors.length; i++) {
            const lm = logicalMonitors[i];
            const [x, y, _scale, _transform, isPrimary, specs] = lm;
            const connector = specs?.[0]?.[0];
            if (connector) {
                active.add(connector);
                let idx = -1;
                if (monitorManager?.get_monitor_for_connector) {
                    try {
                        idx = monitorManager.get_monitor_for_connector(connector);
                    } catch (_e) {}
                }
                if (idx < 0) {
                    // Fallback matching by screen geometry coordinates
                    if (Main.layoutManager?.monitors) {
                        for (let m = 0; m < Main.layoutManager.monitors.length; m++) {
                            const mon = Main.layoutManager.monitors[m];
                            if (mon.x === x && mon.y === y) {
                                idx = m;
                                break;
                            }
                        }
                    }
                }
                if (idx < 0) idx = i;

                connToIdx.set(connector, idx);
                idxToConn.set(idx, connector);
                if (isPrimary) primaryConn = connector;
            }
        }

        if (!primaryConn && Main.layoutManager?.primaryIndex !== undefined) {
            primaryConn = idxToConn.get(Main.layoutManager.primaryIndex) || 'eDP-1';
        }

        this._connectorToIndex = connToIdx;
        this._indexToConnector = idxToConn;
        this._activeConnectors = active;
        this._primaryConnector = primaryConn;
        console.log(`Adaptive Dock: _updateMonitorsCache resolved primary=${primaryConn}, connectors: ${[...connToIdx.keys()].join(', ')}`);
    }

    _updateMonitorsCache(callback = null) {
        try {
            const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
            if (!callback) {
                const res = bus.call_sync(
                    'org.gnome.Mutter.DisplayConfig',
                    '/org/gnome/Mutter/DisplayConfig',
                    'org.gnome.Mutter.DisplayConfig',
                    'GetCurrentState',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    1000,
                    null
                );
                const [_serial, _monitors, logicalMonitors] = res.recursiveUnpack();
                this._parseDisplayConfig(logicalMonitors);
            } else {
                bus.call(
                    'org.gnome.Mutter.DisplayConfig',
                    '/org/gnome/Mutter/DisplayConfig',
                    'org.gnome.Mutter.DisplayConfig',
                    'GetCurrentState',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    1000,
                    null,
                    (conn, res) => {
                        try {
                            const reply = conn.call_finish(res);
                            const [_serial, _monitors, logicalMonitors] = reply.recursiveUnpack();
                            this._parseDisplayConfig(logicalMonitors);
                            callback?.(true);
                        } catch (e) {
                            console.warn(`Adaptive Dock: async _updateMonitorsCache failed: ${e.message}`);
                            this._fallbackMonitorsCache();
                            callback?.(false);
                        }
                    }
                );
            }
        } catch (e) {
            console.warn(`Adaptive Dock: _updateMonitorsCache failed: ${e.message}`);
            this._fallbackMonitorsCache();
            if (callback) callback(false);
        }
    }

    /**
     * Resolves the monitor holding user focus, returning both hardware connector and index.
     * Guaranteed never to throw; implements a resilient fallback cascade.
     */
    getFocusedMonitor() {
        let index = -1;
        const win = this._getFocusAppWindow() || global.display.focus_window;
        if (win && !win.skip_taskbar && typeof win.get_monitor === 'function') {
            index = win.get_monitor();
        }

        // Fallback: Pointer / active screen monitor
        if (index === null || index === undefined || index < 0) {
            index = global.display.get_current_monitor();
        }

        const nMonitors = Main.layoutManager?.monitors?.length || 1;
        if (index < 0 || index >= nMonitors) {
            index = Main.layoutManager?.primaryIndex ?? 0;
            if (index < 0 || index >= nMonitors) index = 0;
        }

        let connector = this._indexToConnector?.get(index) || null;
        if (!connector) {
            if (index === Main.layoutManager?.primaryIndex && this._primaryConnector) {
                connector = this._primaryConnector;
            } else {
                connector = `monitor-${index}`;
            }
        }

        const isPrimary = (index === (Main.layoutManager?.primaryIndex ?? 0));
        return { index, connector, isPrimary };
    }

    // -------------------------------------------------------------
    // Migration & Persistence Operations
    // -------------------------------------------------------------

    _checkAndMigrate() {
        if (!this._isIsolationEnabled()) return;
        try {
            const primaryConn = this._primaryConnector || 'primary';
            console.log(`Adaptive Dock: _checkAndMigrate starting, primaryConn=${primaryConn}`);

            // 1. App states migration
            const perMonitorFile = Gio.File.new_for_path(MONITOR_APP_STATES);
            if (!perMonitorFile.query_exists(null)) {
                this._loadAppStates();
                const initialMonitors = {};
                if (this._appStates && Object.keys(this._appStates).length > 0) {
                    initialMonitors[primaryConn] = { ...this._appStates };
                }
                const doc = {
                    version: 1,
                    monitors: initialMonitors,
                };
                GLib.mkdir_with_parents(GLib.get_user_config_dir(), 0o755);
                GLib.file_set_contents(MONITOR_APP_STATES, JSON.stringify(doc, null, 2));
                this._monitorAppStates = doc;
                console.log(`Adaptive Dock: Migrated legacy app states to primary monitor (${primaryConn})`);
            } else {
                this._loadMonitorAppStates();
            }

            // 2. Workspace states migration
            const wsDir = Gio.File.new_for_path(WS_DIR);
            if (wsDir.query_exists(null)) {
                const targetDir = GLib.build_filenamev([WS_DIR, primaryConn]);
                GLib.mkdir_with_parents(targetDir, 0o755);

                const enumerator = wsDir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.state')) {
                        const oldPath = GLib.build_filenamev([WS_DIR, name]);
                        const newPath = GLib.build_filenamev([targetDir, name]);
                        if (!GLib.file_test(newPath, GLib.FileTest.EXISTS)) {
                            const [ok, content] = GLib.file_get_contents(oldPath);
                            if (ok) {
                                GLib.file_set_contents(newPath, content);
                            }
                        }
                    }
                }
                console.log(`Adaptive Dock: Migrated legacy workspace states to primary monitor (${primaryConn})`);
            }
        } catch (e) {
            console.warn(`Adaptive Dock: _checkAndMigrate error: ${e.message}`);
        }
    }

    _loadAppStates() {
        try {
            this._appStates = JSON.parse(this._readText(APP_STATES) ?? '{}') ?? {};
        } catch (_e) {
            this._appStates = {};
        }
    }

    _loadMonitorAppStates() {
        try {
            const text = this._readText(MONITOR_APP_STATES);
            this._monitorAppStates = JSON.parse(text ?? '{"version": 1, "monitors": {}}') ?? { version: 1, monitors: {} };
            if (!this._monitorAppStates.monitors) this._monitorAppStates.monitors = {};
        } catch (_e) {
            this._monitorAppStates = { version: 1, monitors: {} };
        }
    }

    _writeAppState(appId, state) {
        try {
            this._loadAppStates();
            const cur = { ...this._appStates };
            if (state === null) {
                delete cur[appId];
            } else {
                cur[appId] = state;
            }
            GLib.mkdir_with_parents(GLib.get_user_config_dir(), 0o755);
            GLib.file_set_contents(APP_STATES, JSON.stringify(cur, null, 2));
            this._appStates = cur;
        } catch (e) {
            console.warn(`Adaptive Dock: Failed to persist app state: ${e.message}`);
        }
    }

    _writeMonitorAppState(connector, appId, state) {
        try {
            this._loadMonitorAppStates();
            const cur = { ...this._monitorAppStates };
            if (!cur.monitors) cur.monitors = {};
            if (!cur.monitors[connector]) cur.monitors[connector] = {};

            const monitorDict = { ...cur.monitors[connector] };
            if (state === null) {
                delete monitorDict[appId];
            } else {
                monitorDict[appId] = state;
            }
            cur.monitors[connector] = monitorDict;

            GLib.mkdir_with_parents(GLib.get_user_config_dir(), 0o755);
            GLib.file_set_contents(MONITOR_APP_STATES, JSON.stringify(cur, null, 2));
            this._monitorAppStates = cur;
        } catch (e) {
            console.warn(`Adaptive Dock: Failed to persist per-monitor app state: ${e.message}`);
        }
    }

    _migrateWorkspaceStateFile(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;
        try {
            const oldSafe = oldName.replace(/[\/\0]/g, '-').trim();
            const newSafe = newName.replace(/[\/\0]/g, '-').trim();

            // Migrate in legacy root
            const oldPath = GLib.build_filenamev([WS_DIR, `${oldSafe}.state`]);
            const newPath = GLib.build_filenamev([WS_DIR, `${newSafe}.state`]);
            if (GLib.file_test(oldPath, GLib.FileTest.EXISTS)) {
                Gio.File.new_for_path(oldPath).move(Gio.File.new_for_path(newPath), Gio.FileCopyFlags.OVERWRITE, null, null);
            }

            // Migrate across all monitor connector subdirectories
            for (const conn of this._activeConnectors) {
                const oldMonPath = GLib.build_filenamev([WS_DIR, conn, `${oldSafe}.state`]);
                const newMonPath = GLib.build_filenamev([WS_DIR, conn, `${newSafe}.state`]);
                if (GLib.file_test(oldMonPath, GLib.FileTest.EXISTS)) {
                    Gio.File.new_for_path(oldMonPath).move(Gio.File.new_for_path(newMonPath), Gio.FileCopyFlags.OVERWRITE, null, null);
                }
            }
            console.log(`Adaptive Dock: Migrated workspace state files from "${oldName}" to "${newName}"`);
        } catch (e) {
            console.warn(`Adaptive Dock: Failed to migrate state file: ${e.message}`);
        }
    }

    _writeWorkspaceState(wsIndex, state) {
        try {
            const name = this._getWorkspaceName(wsIndex);
            const safe = (name || '').replace(/[\/\0]/g, '-').trim();
            GLib.mkdir_with_parents(WS_DIR, 0o755);
            const path = GLib.build_filenamev([WS_DIR, `${safe}.state`]);
            if (state === null) {
                try {
                    Gio.File.new_for_path(path).delete(null);
                } catch (_e) {}
            } else {
                GLib.file_set_contents(path, state);
            }
        } catch (e) {
            console.warn(`Adaptive Dock: Failed to persist workspace state: ${e.message}`);
        }
    }

    _readMonitorWorkspaceState(connector, wsIndex) {
        const name = this._getWorkspaceName(wsIndex);
        const safe = (name || '').replace(/[\/\0]/g, '-').trim();
        const perMonPath = GLib.build_filenamev([WS_DIR, connector, `${safe}.state`]);
        if (GLib.file_test(perMonPath, GLib.FileTest.EXISTS)) {
            return this._readText(perMonPath);
        }
        // Fall back to legacy global file if not yet customized for this monitor
        return this._readText(GLib.build_filenamev([WS_DIR, `${safe}.state`]));
    }

    _writeMonitorWorkspaceState(connector, wsIndex, state) {
        try {
            const name = this._getWorkspaceName(wsIndex);
            const safe = (name || '').replace(/[\/\0]/g, '-').trim();
            const dir = GLib.build_filenamev([WS_DIR, connector]);
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([dir, `${safe}.state`]);
            if (state === null) {
                try {
                    Gio.File.new_for_path(path).delete(null);
                } catch (_e) {}
            } else {
                GLib.file_set_contents(path, state);
            }
        } catch (e) {
            console.warn(`Adaptive Dock: Failed to persist per-monitor workspace state: ${e.message}`);
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

        // 1. Intelligent autohide must be turned on at all times (dock-fixed = false)
        if (this._hasKey('dock-fixed') && this._settings.get_boolean('dock-fixed') !== false)
            this._settings.set_boolean('dock-fixed', false);

        // 2. Toggle Dodge windows (intellihide) to show and hide the dock
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

    _resolveMonitorAppState(connector, ids) {
        if (!ids || ids.length === 0) return 'none';
        const dict = this._monitorAppStates?.monitors?.[connector] || {};
        for (const id of ids) {
            if (dict[id]) return dict[id];
        }
        for (const id of ids) {
            const lowerId = id.toLowerCase();
            for (const key in dict) {
                const lowerKey = key.toLowerCase();
                if (lowerId.includes(lowerKey) || lowerKey.includes(lowerId)) {
                    return dict[key];
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

    _getDockGeometry(monitorIndex = -1) {
        let position = 'BOTTOM';
        let height = 0;
        let isBottom = false;

        // 1. Query Dash to Dock / Ubuntu Dock GSettings
        if (this._settings) {
            try {
                position = this._settings.get_string('dock-position');
            } catch (_e) {
                try {
                    const enumVal = this._settings.get_enum('dock-position');
                    if (enumVal === 0) position = 'TOP';
                    else if (enumVal === 1) position = 'RIGHT';
                    else if (enumVal === 2) position = 'BOTTOM';
                    else if (enumVal === 3) position = 'LEFT';
                } catch (_e2) {}
            }
        }

        isBottom = (position === 'BOTTOM');

        // 2. Query live Clutter actor if dock is on BOTTOM
        if (isBottom && Main.layoutManager?._trackedActors) {
            for (const item of Main.layoutManager._trackedActors) {
                const actor = item.actor;
                if (!actor) continue;
                const name = actor.name || (actor.get_name ? actor.get_name() : '');
                if (name === 'dashtodockContainer') {
                    if (monitorIndex !== -1 && actor.monitorIndex !== undefined && actor.monitorIndex !== monitorIndex) {
                        continue;
                    }
                    const box = actor._box || actor.get_first_child()?.get_first_child();
                    if (box && typeof box.get_height === 'function') {
                        height = Math.round(box.get_height());
                    } else if (actor.height > 0) {
                        height = Math.round(actor.height);
                    }
                    if (height > 0) break;
                }
            }
        }

        // 3. Fallback calculation if live actor not resolved yet
        if (isBottom && height === 0 && this._settings) {
            try {
                const iconSize = this._settings.get_int('dash-max-icon-size') || 48;
                height = iconSize + 20;
            } catch (_e) {
                height = 68;
            }
        }

        // 4. Compute recommended clearance offset
        let recommendedOffset = 0;
        if (isBottom && height > 0) {
            const nativeMargin = 60; // Standard GNOME Shell 4em margin-bottom
            const gap = 12; // Visual gap between dock top and OSD pill bottom
            recommendedOffset = Math.max(0, (height + gap) - nativeMargin);
        }

        return {
            position,
            height,
            isBottom,
            recommendedOffset,
        };
    }

    _getAppIcon(show) {
        const style = this._kb ? this._kb.get_string('osd-app-icon-style') : 'eye';
        if (style === 'window') {
            return show ? 'focus-windows-symbolic' : 'window-minimize-symbolic';
        }
        // Default: 'eye'
        return show ? 'view-reveal-symbolic' : 'view-conceal-symbolic';
    }

    _getWorkspaceIcon() {
        const style = this._kb ? this._kb.get_string('osd-workspace-icon-style') : 'display';
        if (style === 'grid') return 'view-grid-symbolic';
        if (style === 'multitasking') return 'preferences-desktop-multitasking-symbolic';
        // Default: 'display'
        return 'video-display-symbolic';
    }

    /**
     * Shows on-screen display notification scoped to a specific monitor index,
     * or globally if targetMonitorIndex is -1 or isolation is disabled.
     */
    _showOsd(iconName, label, targetMonitorIndex = -1) {
        try {
            const isIsolated = this._isIsolationEnabled();
            const monitorIndex = isIsolated ? targetMonitorIndex : -1;
            const geom = this._getDockGeometry(monitorIndex);
            const extraOffset = this._kb ? this._kb.get_int('notification-vertical-offset') : 0;
            const offset = Math.max(0, geom.recommendedOffset + extraOffset);

            // Apply ephemeral elevation strictly to the relevant OSD windows
            if (Main.osdWindowManager?._osdWindows) {
                const targetWindows = (monitorIndex !== -1 && Main.osdWindowManager._osdWindows[monitorIndex])
                    ? [Main.osdWindowManager._osdWindows[monitorIndex]]
                    : Main.osdWindowManager._osdWindows;

                for (const osd of targetWindows) {
                    if (!osd) continue;

                    if (osd._hbox) osd._hbox.translation_y = -offset;
                    else osd.translation_y = -offset;

                    // Automatically restore translation_y = 0 when notification hides
                    if (!osd._adaptiveDockResetId) {
                        osd._adaptiveDockResetId = osd.connect('notify::visible', () => {
                            if (!osd.visible) {
                                if (osd._hbox) osd._hbox.translation_y = 0;
                                else osd.translation_y = 0;
                                if (osd._adaptiveDockResetId) {
                                    try {
                                        osd.disconnect(osd._adaptiveDockResetId);
                                    } catch (_e) {}
                                    osd._adaptiveDockResetId = null;
                                }
                            }
                        });
                    }
                }
            }

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

            // Route OSD: scoped monitor vs global broadcast
            if (monitorIndex !== -1) {
                if (typeof Main.osdWindowManager?.show === 'function') {
                    Main.osdWindowManager.show(monitorIndex, icon, label, null, null);
                }
            } else {
                if (typeof Main.osdWindowManager?.showAll === 'function') {
                    Main.osdWindowManager.showAll(icon, label, null, null);
                } else if (typeof Main.osdWindowManager?.show === 'function') {
                    Main.osdWindowManager.show(-1, icon, label, null, null);
                } else {
                    console.warn('Adaptive Dock: No supported OSD display method found on Main.osdWindowManager');
                }
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

        // Check if any workspace was renamed externally; if so, migrate state files
        if (this._lastKnownWmNames) {
            for (let i = 0; i < Math.min(names.length, this._lastKnownWmNames.length); i++) {
                const oldName = this._lastKnownWmNames[i];
                const newName = names[i];
                if (oldName && newName && oldName !== newName) {
                    this._migrateWorkspaceStateFile(oldName, newName);
                }
            }
        }
        this._lastKnownWmNames = [...names];

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

        const isIsolated = this._isIsolationEnabled();
        const focused = this.getFocusedMonitor();
        const connector = focused.connector;
        const targetMonIndex = focused.index;

        const win = this._getFocusAppWindow();
        if (!win) {
            this._toggleWorkspace();
            return;
        }

        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const appRule = isIsolated
            ? this._resolveMonitorAppState(connector, ids)
            : this._resolveAppState(ids);

        // If currently focused window belongs to a bypassed app, do not record session override for it
        if (appRule === 'bypass') return;

        const currentShow = this._settings.get_boolean('intellihide');
        const nextShow = !currentShow;
        console.log(`Adaptive Dock: _toggleApp() invoked on [${connector}:${targetMonIndex}]! currentShow=${currentShow} -> nextShow=${nextShow}`);
        this._setDockVisibility(nextShow);
        this._lastNonBypassedShowState = nextShow;
        if (isIsolated) {
            this._perMonitorLastShowState.set(connector, nextShow);
        }

        let appName = 'Active Window';
        try {
            const app = this._tracker?.get_window_app(win);
            if (app) appName = app.get_name();
            else if (win?.title) appName = win.title;
        } catch (_e) {}

        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        const persistAppShortcuts = this._kb ? this._kb.get_boolean('persist-app-shortcut-state') : false;

        if (rememberSession && appId) {
            const perWindow = this._isPerWindow(appId);
            if (isIsolated) {
                if (!this._perMonitorSessionWindowStates.has(connector)) {
                    this._perMonitorSessionWindowStates.set(connector, new Map());
                }
                if (!this._perMonitorSessionAppStates.has(connector)) {
                    this._perMonitorSessionAppStates.set(connector, new Map());
                }
                const sessWinMap = this._perMonitorSessionWindowStates.get(connector);
                const sessAppMap = this._perMonitorSessionAppStates.get(connector);

                if (perWindow) {
                    const winId = win.get_id();
                    sessWinMap.set(winId, nextShow ? 'show' : 'hide');
                    if (!this._windowSignals.has(winId)) {
                        const id = win.connect('unmanaged', () => {
                            sessWinMap.delete(winId);
                            this._windowSignals.delete(winId);
                        });
                        this._windowSignals.set(winId, { win, id });
                    }
                } else {
                    for (const id of ids) {
                        sessAppMap.set(id, nextShow ? 'show' : 'hide');
                    }
                    if (persistAppShortcuts) {
                        this._writeMonitorAppState(connector, appId, nextShow ? 'show' : 'hide');
                    }
                }
            } else {
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
                    if (persistAppShortcuts) {
                        this._writeAppState(appId, nextShow ? 'show' : 'hide');
                    }
                }
            }
        }

        const shouldNotify = this._kb ? this._kb.get_boolean('notify-on-app-toggle') : true;
        if (shouldNotify) {
            const statusText = nextShow ? 'Shown' : 'Hidden';
            const icon = this._getAppIcon(nextShow);
            this._showOsd(icon, `${appName}: Dock ${statusText}`, targetMonIndex);
        }
    }

    _toggleWorkspace() {
        if (!this._settings || !global.workspace_manager) return;
        if (this._deferTimeoutId) {
            GLib.source_remove(this._deferTimeoutId);
            this._deferTimeoutId = null;
        }

        const isIsolated = this._isIsolationEnabled();
        const focused = this.getFocusedMonitor();
        const connector = focused.connector;
        const targetMonIndex = focused.index;

        const wsIndex = global.workspace_manager.get_active_workspace_index();
        const wsName = this._getWorkspaceName(wsIndex);

        let currentWsState = true;
        const defaultWsShow = this._kb ? (this._kb.get_string('default-workspace-state') !== 'hide') : true;

        if (isIsolated) {
            if (!this._perMonitorSessionWorkspaceStates.has(connector)) {
                this._perMonitorSessionWorkspaceStates.set(connector, new Map());
            }
            const sessWsMap = this._perMonitorSessionWorkspaceStates.get(connector);
            if (sessWsMap.has(wsIndex)) {
                currentWsState = sessWsMap.get(wsIndex) === 'show';
            } else {
                const wsDiskState = this._readMonitorWorkspaceState(connector, wsIndex);
                if (wsDiskState === 'false' || wsDiskState === 'hide') currentWsState = false;
                else if (wsDiskState === 'true' || wsDiskState === 'show') currentWsState = true;
                else currentWsState = defaultWsShow;
            }
        } else {
            if (this._sessionWorkspaceStates.has(wsIndex)) {
                currentWsState = this._sessionWorkspaceStates.get(wsIndex) === 'show';
            } else {
                const wsDiskState = this._workspaceState(wsIndex);
                if (wsDiskState === 'false' || wsDiskState === 'hide') currentWsState = false;
                else if (wsDiskState === 'true' || wsDiskState === 'show') currentWsState = true;
                else currentWsState = defaultWsShow;
            }
        }

        const nextShow = !currentWsState;
        const persistWsShortcuts = this._kb ? this._kb.get_boolean('persist-workspace-shortcut-state') : false;

        if (isIsolated) {
            this._perMonitorSessionWorkspaceStates.get(connector).set(wsIndex, nextShow ? 'show' : 'hide');
            if (persistWsShortcuts) {
                this._writeMonitorWorkspaceState(connector, wsIndex, nextShow ? 'show' : 'hide');
            }
        } else {
            this._sessionWorkspaceStates.set(wsIndex, nextShow ? 'show' : 'hide');
            if (persistWsShortcuts) {
                this._writeWorkspaceState(wsIndex, nextShow ? 'show' : 'hide');
            }
        }
        console.log(`Adaptive Dock: _toggleWorkspace() invoked on [${connector}:${targetMonIndex}] for ${wsName}! currentWsState=${currentWsState} -> nextShow=${nextShow}`);

        const win = this._getFocusAppWindow();
        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const winId = win ? win.get_id() : null;
        const appRule = isIsolated
            ? this._resolveMonitorAppState(connector, ids)
            : this._resolveAppState(ids);

        // When toggling workspace baseline, clear any conflicting temporary in-memory session override on the active app/window
        if (isIsolated) {
            const sessWinMap = this._perMonitorSessionWindowStates.get(connector);
            const sessAppMap = this._perMonitorSessionAppStates.get(connector);
            if (winId && sessWinMap?.has(winId)) sessWinMap.delete(winId);
            if (sessAppMap) {
                for (const id of ids) sessAppMap.delete(id);
            }
        } else {
            if (winId && this._sessionWindowStates.has(winId)) {
                this._sessionWindowStates.delete(winId);
            }
            for (const id of ids) {
                this._sessionAppStates.delete(id);
            }
        }

        const hasExplicitPersistentRule = appRule === 'show' || appRule === 'hide';

        // If the active window relies on the workspace baseline (or no app window is focused),
        // update dock visibility immediately
        if (!hasExplicitPersistentRule && appRule !== 'bypass') {
            this._setDockVisibility(nextShow);
            this._lastNonBypassedShowState = nextShow;
            if (isIsolated) {
                this._perMonitorLastShowState.set(connector, nextShow);
            }
        }

        const shouldNotify = this._kb ? this._kb.get_boolean('notify-on-workspace-toggle') : true;
        if (shouldNotify) {
            const wsIcon = this._getWorkspaceIcon();
            if (hasExplicitPersistentRule) {
                const appStateText = appRule === 'show' ? 'Always Shown' : 'Always Hidden';
                this._showOsd(wsIcon, `${wsName}: Dock ${nextShow ? 'Shown' : 'Hidden'} (App: ${appStateText})`, targetMonIndex);
            } else if (appRule === 'bypass') {
                this._showOsd(wsIcon, `${wsName}: Dock ${nextShow ? 'Shown' : 'Hidden'} (App: Bypass)`, targetMonIndex);
            } else {
                const statusText = nextShow ? 'Shown' : 'Hidden';
                this._showOsd(wsIcon, `${wsName}: Dock ${statusText}`, targetMonIndex);
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

        const isIsolated = this._isIsolationEnabled();
        const wsIndex = global.workspace_manager.get_active_workspace_index();
        const ids = this._getWindowIdentifiers(win);
        const appId = ids[0] || null;
        const winId = win ? win.get_id() : null;

        // -------------------------------------------------------------
        // LEGACY GLOBAL EXECUTION PATH (per-monitor-isolation: false)
        // -------------------------------------------------------------
        if (!isIsolated) {
            const key = `${wsIndex}:${winId ?? appId}`;
            if (!force && key === this._lastKey) return;
            this._lastKey = key;

            // 1. Bypass check
            const appRule = this._resolveAppState(ids);
            if (win && appRule === 'bypass') {
                this._lastWasBypassed = true;
                if (this._lastNonBypassedShowState !== null) {
                    this._setDockVisibility(this._lastNonBypassedShowState);
                }
                return;
            }
            this._lastWasBypassed = false;

            // 2. Determine target dock visibility
            let show = true;
            let sessionHandled = false;
            const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
            const perWindow = this._isPerWindow(appId);

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
                if (appRule === 'hide') {
                    show = false;
                } else if (appRule === 'show') {
                    show = true;
                } else {
                    if (this._sessionWorkspaceStates.has(wsIndex)) {
                        show = this._sessionWorkspaceStates.get(wsIndex) === 'show';
                    } else {
                        const wsState = this._workspaceState(wsIndex);
                        const defaultWsShow = this._kb ? (this._kb.get_string('default-workspace-state') !== 'hide') : true;

                        if (wsState === 'false' || wsState === 'hide') {
                            show = false;
                        } else if (wsState === 'true' || wsState === 'show') {
                            show = true;
                        } else {
                            const currentWs = global.workspace_manager.get_active_workspace();
                            const wsWindows = currentWs ? currentWs.list_windows().filter(w => !w.is_on_all_workspaces() && !w.skip_taskbar) : [];
                            if (!win && wsWindows.length > 0 && this._lastNonBypassedShowState !== null) {
                                show = this._lastNonBypassedShowState;
                            } else {
                                show = defaultWsShow;
                            }
                        }
                    }
                }
            }

            this._setDockVisibility(show);
            this._lastNonBypassedShowState = show;
            this._updateSpaceBarMenuItemLabel();
            return;
        }

        // -------------------------------------------------------------
        // PER-MONITOR ISOLATED EXECUTION PATH (per-monitor-isolation: true)
        // -------------------------------------------------------------
        const focused = this.getFocusedMonitor();
        const connector = focused.connector;
        const key = `${connector}:${wsIndex}:${winId ?? appId}`;
        if (!force && key === this._lastKey) return;
        this._lastKey = key;

        // 1. Bypass check
        const appRule = this._resolveMonitorAppState(connector, ids);
        if (win && appRule === 'bypass') {
            this._lastWasBypassed = true;
            const lastShow = this._perMonitorLastShowState.get(connector) ?? this._lastNonBypassedShowState ?? this._settings.get_boolean('intellihide');
            this._setDockVisibility(lastShow);
            return;
        }
        this._lastWasBypassed = false;

        // 2. Determine target dock visibility for this monitor domain
        let show = true;
        let sessionHandled = false;
        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        const perWindow = this._isPerWindow(appId);

        const sessWinMap = this._perMonitorSessionWindowStates.get(connector);
        const sessAppMap = this._perMonitorSessionAppStates.get(connector);

        if (rememberSession && win && appId) {
            if (perWindow && sessWinMap?.has(winId)) {
                show = sessWinMap.get(winId) === 'show';
                sessionHandled = true;
            } else if (!perWindow && sessAppMap) {
                for (const id of ids) {
                    if (sessAppMap.has(id)) {
                        show = sessAppMap.get(id) === 'show';
                        sessionHandled = true;
                        break;
                    }
                }
            }
        }

        if (!sessionHandled) {
            if (appRule === 'hide') {
                show = false;
            } else if (appRule === 'show') {
                show = true;
            } else {
                const sessWsMap = this._perMonitorSessionWorkspaceStates.get(connector);
                if (sessWsMap?.has(wsIndex)) {
                    show = sessWsMap.get(wsIndex) === 'show';
                } else {
                    const wsState = this._readMonitorWorkspaceState(connector, wsIndex);
                    const defaultWsShow = this._kb ? (this._kb.get_string('default-workspace-state') !== 'hide') : true;

                    if (wsState === 'false' || wsState === 'hide') {
                        show = false;
                    } else if (wsState === 'true' || wsState === 'show') {
                        show = true;
                    } else {
                        const currentWs = global.workspace_manager.get_active_workspace();
                        const wsWindows = currentWs ? currentWs.list_windows().filter(w => !w.is_on_all_workspaces() && !w.skip_taskbar) : [];
                        const lastShow = this._perMonitorLastShowState.get(connector);
                        if (!win && wsWindows.length > 0 && lastShow !== undefined && lastShow !== null) {
                            show = lastShow;
                        } else {
                            show = defaultWsShow;
                        }
                    }
                }
            }
        }

        this._setDockVisibility(show);
        this._perMonitorLastShowState.set(connector, show);
        this._lastNonBypassedShowState = show;
        this._updateSpaceBarMenuItemLabel();
    }

    _findSpaceBarMenu() {
        try {
            // 1. Check Main.extensionManager directly for Space Bar's live instance
            if (Main.extensionManager?.lookup) {
                const sbExt = Main.extensionManager.lookup('space-bar@luchrioh');
                const menu = sbExt?.stateObj?.workspacesBar?._button?.menu;
                if (menu) {
                    console.log('Adaptive Dock: Found Space Bar menu via extensionManager');
                    return menu;
                }
            }

            // 2. Space Bar adds its indicator button under metadata.name ('Space Bar')
            const candidateKeys = ['Space Bar', 'space-bar', 'space-bar@luchrioh'];
            for (const key of candidateKeys) {
                const indicator = Main.panel.statusArea?.[key];
                if (indicator?.menu) {
                    console.log(`Adaptive Dock: Found Space Bar menu in statusArea['${key}']`);
                    return indicator.menu;
                }
            }

            // 3. Search panel boxes for WorkspacesButton or 'space-bar' style class
            for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
                if (!box) continue;
                for (const actor of box.get_children()) {
                    const btn = actor._delegate || actor;
                    if (btn?.menu && (
                        btn.styleClass?.includes('space-bar') ||
                        btn.name?.toLowerCase().includes('space') ||
                        btn.constructor?.name?.includes('WorkspacesButton')
                    )) {
                        console.log('Adaptive Dock: Found Space Bar menu in panel box children');
                        return btn.menu;
                    }
                }
            }
        } catch (e) {
            console.warn(`Adaptive Dock: _findSpaceBarMenu failed: ${e.message}`);
        }
        return null;
    }

    _updateSpaceBarMenuItemLabel() {
        if (!this._spaceBarMenuItem) return;
        const currentShow = this._settings?.get_boolean('intellihide') ?? true;
        this._spaceBarMenuItem.label.text = `Dock: ${currentShow ? 'Shown' : 'Hidden'} (Click to toggle)`;
    }

    _updateSpaceBarIntegration() {
        const enabled = this._kb ? this._kb.get_boolean('integrate-space-bar') : true;
        if (!enabled) {
            this._cleanSpaceBarIntegration();
            return;
        }

        const menu = this._findSpaceBarMenu();
        if (!menu) return;

        // If already attached to this menu, just refresh label
        if (this._spaceBarMenuItem && this._spaceBarMenu === menu) {
            this._updateSpaceBarMenuItemLabel();
            return;
        }

        this._cleanSpaceBarIntegration();
        this._spaceBarMenu = menu;

        // Create the popup menu item
        this._spaceBarMenuItem = new PopupMenu.PopupMenuItem('Dock: (loading…)');
        this._updateSpaceBarMenuItemLabel();

        this._spaceBarMenuItemClickId = this._spaceBarMenuItem.connect('activate', () => {
            this._toggleWorkspace();
            this._updateSpaceBarMenuItemLabel();
        });

        // Insert near manage workspace section or at the bottom before settings
        const items = menu._getMenuItems ? menu._getMenuItems() : menu.box.get_children();
        let insertIndex = items.length;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const text = item.label?.text || item._delegate?.label?.text || '';
            if (text.includes('Space Bar settings') || text.includes('settings')) {
                insertIndex = i;
                break;
            }
        }

        if (insertIndex >= 0 && insertIndex < items.length) {
            menu.addMenuItem(this._spaceBarMenuItem, insertIndex);
        } else {
            menu.addMenuItem(this._spaceBarMenuItem);
        }

        this._spaceBarMenuOpenId = menu.connect('open-state-changed', () => {
            if (menu.isOpen) {
                this._updateSpaceBarMenuItemLabel();
            }
        });
    }

    _cleanSpaceBarIntegration() {
        if (this._spaceBarMenuItemClickId && this._spaceBarMenuItem) {
            try {
                this._spaceBarMenuItem.disconnect(this._spaceBarMenuItemClickId);
            } catch (_e) {}
            this._spaceBarMenuItemClickId = null;
        }

        if (this._spaceBarMenuOpenId && this._spaceBarMenu) {
            try {
                this._spaceBarMenu.disconnect(this._spaceBarMenuOpenId);
            } catch (_e) {}
            this._spaceBarMenuOpenId = null;
        }

        if (this._spaceBarMenuItem) {
            try {
                this._spaceBarMenuItem.destroy();
            } catch (_e) {}
            this._spaceBarMenuItem = null;
        }
        this._spaceBarMenu = null;
    }
}
