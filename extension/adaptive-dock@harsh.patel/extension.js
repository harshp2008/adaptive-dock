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
        this._windowSignals = new Map();

        // reload app states when prefs edits the file
        this._monitor = Gio.File.new_for_path(APP_STATES).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monId = this._monitor.connect('changed', () => {
            this._loadAppStates();
            this._apply(true);
        });

        this._kb = this.getSettings('org.gnome.shell.extensions.adaptive-dock');
        Main.wm.addKeybinding('toggle-dock', this._kb, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());

        this._edgeRevealId = this._kb.connect('changed::edge-hover-reveal', () => this._apply(true));

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
            if (this._edgeRevealId) this._kb.disconnect(this._edgeRevealId);
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

        this._focusId = this._wsActiveId = this._wsCountId = this._wsReorderId = null;
        this._winTrackId = this._wmNamesId = this._monId = this._monitor = this._edgeRevealId = null;
        this._settings = this._wm = this._tracker = this._appStates = null;
        this._sessionAppStates = this._sessionWindowStates = this._windowSignals = null;
        this._lastKey = null;
    }

    _getDockSettings() {
        const src = Gio.SettingsSchemaSource.get_default();
        for (const id of SCHEMAS) {
            if (src.lookup(id, true))
                return new Gio.Settings({schema_id: id});
        }
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions',
            'dash-to-dock@micxgx.gmail.com', 'schemas']);
        if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
            const custom = Gio.SettingsSchemaSource.new_from_directory(dir, src, false);
            const schema = custom.lookup(SCHEMAS[0], true);
            if (schema) return new Gio.Settings({settings_schema: schema});
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

    _appState(appId) {
        if (!appId) return 'none';
        const base = appId.replace(/\.desktop$/, '');
        if (this._appStates[base]) return this._appStates[base];
        for (const key in this._appStates) {
            if (base.includes(key) || key.includes(base))
                return this._appStates[key];
        }
        return 'none';
    }

    _workspaceState(wsIndex) {
        const names = this._wm.get_strv('workspace-names');
        const name = names[wsIndex] || `Workspace ${wsIndex + 1}`;
        return this._readText(GLib.build_filenamev([WS_DIR, `${name}.state`]));
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

    _toggle() {
        if (!this._settings) return;
        const next = !this._settings.get_boolean('intellihide');
        this._settings.set_boolean('intellihide', next);

        const win = global.display.focus_window;
        const app = win ? this._tracker.get_window_app(win) : null;
        const rawAppId = app ? app.get_id() : null;
        const appId = rawAppId ? rawAppId.replace(/\.desktop$/, '') : null;

        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        const perWindow = this._kb ? this._kb.get_boolean('remember-per-window') : false;

        if (rememberSession && win && appId) {
            if (perWindow) {
                const winId = win.get_id();
                this._sessionWindowStates.set(winId, next);
                if (!this._windowSignals.has(winId)) {
                    const id = win.connect('unmanaged', () => {
                        this._sessionWindowStates.delete(winId);
                        this._windowSignals.delete(winId);
                    });
                    this._windowSignals.set(winId, { win, id });
                }
            } else {
                this._sessionAppStates.set(appId, next);
            }
        } else {
            // remember for the current workspace if no app/window or session memory disabled
            const names = this._wm.get_strv('workspace-names');
            const idx = global.workspace_manager.get_active_workspace_index();
            const name = names[idx] || `Workspace ${idx + 1}`;
            try {
                GLib.mkdir_with_parents(WS_DIR, 0o755);
                GLib.file_set_contents(GLib.build_filenamev([WS_DIR, `${name}.state`]), String(next));
            } catch (e) {
                console.warn(`Adaptive Dock: could not save workspace state: ${e.message}`);
            }
        }
    }

    _apply(force = false) {
        if (!this._settings) return;

        const wsIndex = global.workspace_manager.get_active_workspace_index();
        const win = global.display.focus_window;
        const app = win ? this._tracker.get_window_app(win) : null;
        const rawAppId = app ? app.get_id() : null;
        const appId = rawAppId ? rawAppId.replace(/\.desktop$/, '') : null;
        const winId = win ? win.get_id() : null;

        const key = `${wsIndex}:${winId ?? appId}`;
        if (!force && key === this._lastKey) return;
        this._lastKey = key;

        let intellihide = true;
        const rememberSession = this._kb ? this._kb.get_boolean('remember-session-state') : true;
        const perWindow = this._kb ? this._kb.get_boolean('remember-per-window') : false;

        let sessionHandled = false;
        if (rememberSession && win && appId) {
            if (perWindow && this._sessionWindowStates.has(winId)) {
                intellihide = this._sessionWindowStates.get(winId);
                sessionHandled = true;
            } else if (!perWindow && this._sessionAppStates.has(appId)) {
                intellihide = this._sessionAppStates.get(appId);
                sessionHandled = true;
            }
        }

        if (!sessionHandled) {
            // priority: app > workspace > default (show)
            const appState = this._appState(appId);
            if (appState === 'hide') intellihide = false;
            else if (appState === 'show') intellihide = true;
            else if (this._workspaceState(wsIndex) === 'false') intellihide = false;
        }

        const autohide = this._kb ? this._kb.get_boolean('edge-hover-reveal') : false;
        this._settings.set_boolean('dock-fixed', false);
        this._settings.set_boolean('autohide', autohide);
        this._settings.set_boolean('intellihide', intellihide);
    }
}
