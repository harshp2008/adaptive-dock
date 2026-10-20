import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class DockTrackerExtension extends Extension {
    enable() {
        this._settings = this._getDockSettings();
        if (!this._settings) return;
        
        // Lock master Intelligent Autohide properties
        this._settings.set_boolean('dock-fixed', false);
        this._settings.set_boolean('autohide', true);
        
        this._tracker = Shell.WindowTracker.get_default();
        this._lastAppId = null;
        this._lastWorkspaceIndex = -1;
        
        this._focusSigId = global.display.connect('notify::focus-window', this._onStateChange.bind(this));
        this._wsSigId = global.workspace_manager.connect('active-workspace-changed', this._onStateChange.bind(this));
    }

    disable() {
        if (this._focusSigId) {
            global.display.disconnect(this._focusSigId);
            this._focusSigId = null;
        }
        if (this._wsSigId) {
            global.workspace_manager.disconnect(this._wsSigId);
            this._wsSigId = null;
        }
        this._settings = null;
        this._tracker = null;
        this._lastAppId = null;
        this._lastWorkspaceIndex = -1;
    }

    _getDockSettings() {
        const defaultSource = Gio.SettingsSchemaSource.get_default();
        if (defaultSource.lookup('org.gnome.shell.extensions.dash-to-dock', true)) {
            return new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.dash-to-dock' });
        }
        if (defaultSource.lookup('org.gnome.shell.extensions.ubuntu-dock', true)) {
            return new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.ubuntu-dock' });
        }
        const customDir = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions', 'dash-to-dock@micxgx.gmail.com', 'schemas'
        ]);
        const file = Gio.File.new_for_path(customDir);
        if (file.query_exists(null)) {
            const customSource = Gio.SettingsSchemaSource.new_from_directory(customDir, defaultSource, false);
            const schemaObj = customSource.lookup('org.gnome.shell.extensions.dash-to-dock', true);
            if (schemaObj) return new Gio.Settings({ settings_schema: schemaObj });
        }
        return null;
    }

    _onStateChange() {
        if (!this._settings) return;

        let wsIndex = global.workspace_manager.get_active_workspace_index();
        let appId = null;
        const window = global.display.focus_window;
        
        if (window) {
            const app = this._tracker.get_window_app(window);
            if (app) appId = app.get_id();
        }

        // Prevent redundant triggers
        if (this._lastWorkspaceIndex === wsIndex && this._lastAppId === appId) {
            return;
        }
        
        this._lastWorkspaceIndex = wsIndex;
        this._lastAppId = appId;

        // 1. Check Workspace State
        let wsState = null;
        let wmSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
        let wsNames = wmSettings.get_strv('workspace-names');
        let wsName = wsNames[wsIndex] || `Workspace ${wsIndex + 1}`;
        
        let wsStateFile = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'dock-workspace-states', `${wsName}.state`]);
        let wFile = Gio.File.new_for_path(wsStateFile);
        
        try {
            let [success, contents] = wFile.load_contents(null);
            if (success) {
                wsState = new TextDecoder('utf-8').decode(contents).trim();
            }
        } catch (e) {}

        // 2. Check App State
        let appState = "none";
        if (appId) {
            const appStateFile = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'dock-app-states.json']);
            const aFile = Gio.File.new_for_path(appStateFile);
            try {
                const [success, contents] = aFile.load_contents(null);
                if (success) {
                    const states = JSON.parse(new TextDecoder('utf-8').decode(contents));
                    const baseId = appId.replace(/\.desktop$/, '');
                    if (states[baseId]) {
                        appState = states[baseId];
                    } else {
                        for (let key in states) {
                            if (baseId.includes(key) || key.includes(baseId)) {
                                appState = states[key];
                                break;
                            }
                        }
                    }
                }
            } catch (err) {}
        }

        // Enforce master autohide locks
        this._settings.set_boolean('dock-fixed', false);
        this._settings.set_boolean('autohide', true);

        // 3. Apply Dodge Windows hierarchy (App > Workspace)
        if (appState === "hide") {
            this._settings.set_boolean('intellihide', false);
        } else if (appState === "show") {
            this._settings.set_boolean('intellihide', true);
        } else {
            if (wsState === "true") {
                this._settings.set_boolean('intellihide', true);
            } else if (wsState === "false") {
                this._settings.set_boolean('intellihide', false);
            } else {
                this._settings.set_boolean('intellihide', true); 
            }
        }
    }
}
