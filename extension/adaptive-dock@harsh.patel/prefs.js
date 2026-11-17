import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CFG = GLib.get_user_config_dir();
const APP_STATES = GLib.build_filenamev([CFG, 'dock-app-states.json']);
const MONITOR_APP_STATES = GLib.build_filenamev([CFG, 'dock-monitor-app-states.json']);
const WS_DIR = GLib.build_filenamev([CFG, 'dock-workspace-states']);
const WS_CHOICES = ['Default', 'Show dock', 'Hide dock'];
const APP_CHOICES = ['Inherit', 'Show dock', 'Hide dock', 'Bypass'];
const CHOICES = WS_CHOICES;
const DOCK_SCHEMAS = ['org.gnome.shell.extensions.dash-to-dock', 'org.gnome.shell.extensions.ubuntu-dock'];

function sanitizeWsName(name) {
    return (name || '').replace(/[\/\0]/g, '-').trim();
}

function getConnectedMonitors() {
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        const res = bus.call_sync(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'GetCurrentState',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
        const [_serial, monitors, logicalMonitors] = res.recursiveUnpack();
        const results = [];
        const names = new Map();

        for (const m of monitors) {
            const [specs, _modes, props] = m;
            const connector = specs[0];
            const name = props['display-name'] ? props['display-name'].unpack() : connector;
            names.set(connector, name);
        }

        for (const lm of logicalMonitors) {
            const [_x, _y, _scale, _transform, isPrimary, specs] = lm;
            const connector = specs?.[0]?.[0];
            if (connector) {
                const displayName = names.get(connector) || connector;
                results.push({
                    connector,
                    displayName,
                    isPrimary: Boolean(isPrimary),
                    label: isPrimary ? `${displayName} (${connector}) — Primary` : `${displayName} (${connector})`,
                });
            }
        }
        if (results.length > 0) return results;
    } catch (_e) {}

    return [{
        connector: 'default',
        displayName: 'Default Display',
        isPrimary: true,
        label: 'Default Display',
    }];
}

function readApps() {
    try {
        const [ok, bytes] = Gio.File.new_for_path(APP_STATES).load_contents(null);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    } catch (_e) {
        return {};
    }
}

function writeApps(states) {
    GLib.mkdir_with_parents(CFG, 0o755);
    GLib.file_set_contents(APP_STATES, JSON.stringify(states, null, 2));
}

function readMonitorApps(connector) {
    if (!connector) return readApps();
    try {
        const [ok, bytes] = Gio.File.new_for_path(MONITOR_APP_STATES).load_contents(null);
        if (!ok) return readApps();
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        return doc.monitors?.[connector] || {};
    } catch (_e) {
        return readApps();
    }
}

function writeMonitorApps(connector, states) {
    if (!connector) {
        writeApps(states);
        return;
    }
    GLib.mkdir_with_parents(CFG, 0o755);
    let doc = { version: 1, monitors: {} };
    try {
        const [ok, bytes] = Gio.File.new_for_path(MONITOR_APP_STATES).load_contents(null);
        if (ok) doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_e) {}
    if (!doc.monitors) doc.monitors = {};
    doc.monitors[connector] = states;
    GLib.file_set_contents(MONITOR_APP_STATES, JSON.stringify(doc, null, 2));
}

function readWs(name) {
    try {
        const safe = sanitizeWsName(name);
        const [ok, bytes] = Gio.File.new_for_path(GLib.build_filenamev([WS_DIR, `${safe}.state`])).load_contents(null);
        return ok ? new TextDecoder().decode(bytes).trim() : null;
    } catch (_e) {
        return null;
    }
}

function writeWs(name, value) {
    GLib.mkdir_with_parents(WS_DIR, 0o755);
    const safe = sanitizeWsName(name);
    const path = GLib.build_filenamev([WS_DIR, `${safe}.state`]);
    if (value === null) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {}
    } else {
        GLib.file_set_contents(path, value);
    }
}

function readMonitorWs(connector, name) {
    if (!connector) return readWs(name);
    try {
        const safe = sanitizeWsName(name);
        const perMonPath = GLib.build_filenamev([WS_DIR, connector, `${safe}.state`]);
        if (GLib.file_test(perMonPath, GLib.FileTest.EXISTS)) {
            const [ok, bytes] = Gio.File.new_for_path(perMonPath).load_contents(null);
            return ok ? new TextDecoder().decode(bytes).trim() : null;
        }
        return readWs(name);
    } catch (_e) {
        return readWs(name);
    }
}

function writeMonitorWs(connector, name, value) {
    if (!connector) {
        writeWs(name, value);
        return;
    }
    const safe = sanitizeWsName(name);
    const dir = GLib.build_filenamev([WS_DIR, connector]);
    GLib.mkdir_with_parents(dir, 0o755);
    const path = GLib.build_filenamev([dir, `${safe}.state`]);
    if (value === null) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {}
    } else {
        GLib.file_set_contents(path, value);
    }
}

function renameWs(oldName, newName) {
    if (oldName === newName) return;
    const oldSafe = sanitizeWsName(oldName);
    const newSafe = sanitizeWsName(newName);
    const oldPath = GLib.build_filenamev([WS_DIR, `${oldSafe}.state`]);
    const newPath = GLib.build_filenamev([WS_DIR, `${newSafe}.state`]);
    if (GLib.file_test(oldPath, GLib.FileTest.EXISTS)) {
        try {
            const oldFile = Gio.File.new_for_path(oldPath);
            const newFile = Gio.File.new_for_path(newPath);
            oldFile.move(newFile, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (_e) {}
    }
}

function getDockSettings() {
    const src = Gio.SettingsSchemaSource.get_default();
    for (const id of DOCK_SCHEMAS) {
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
                for (const id of DOCK_SCHEMAS) {
                    const schema = custom.lookup(id, true);
                    if (schema) return new Gio.Settings({settings_schema: schema});
                }
            } catch (_e) {}
        }
    }
    return null;
}

function hasKey(settings, key) {
    if (!settings) return false;
    try {
        return settings.get_value(key) !== null;
    } catch (_e) {
        return false;
    }
}

function isExtensionInstalled(uuid) {
    const paths = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', uuid]),
        GLib.build_filenamev(['/usr/share/gnome-shell/extensions', uuid]),
    ];
    return paths.some(p => GLib.file_test(p, GLib.FileTest.IS_DIR));
}

function checkDockStatus(banner) {
    try {
        const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const enabled = shellSettings.get_strv('enabled-extensions') || [];
        const d2dInstalled = isExtensionInstalled('dash-to-dock@micxgx.gmail.com');
        const udockInstalled = isExtensionInstalled('ubuntu-dock@ubuntu.com');
        const d2dEnabled = enabled.includes('dash-to-dock@micxgx.gmail.com');
        const udockEnabled = enabled.includes('ubuntu-dock@ubuntu.com');

        if (!d2dInstalled && !udockInstalled) {
            banner.title = 'Neither Dash to Dock nor Ubuntu Dock is installed. Please install Dash to Dock to use Adaptive Dock.';
            banner.revealed = true;
        } else if (d2dEnabled && udockEnabled) {
            banner.title = 'Both Dash to Dock and Ubuntu Dock are enabled. Please disable one to prevent conflicts.';
            banner.button_label = 'Disable Ubuntu Dock';
            banner.connect('button-clicked', () => {
                const cur = shellSettings.get_strv('enabled-extensions') || [];
                shellSettings.set_strv('enabled-extensions', cur.filter(id => id !== 'ubuntu-dock@ubuntu.com'));
                banner.revealed = false;
            });
            banner.revealed = true;
        } else if (!d2dEnabled && !udockEnabled) {
            const target = d2dInstalled ? 'dash-to-dock@micxgx.gmail.com' : 'ubuntu-dock@ubuntu.com';
            const name = d2dInstalled ? 'Dash to Dock' : 'Ubuntu Dock';
            banner.title = `${name} is installed but disabled. Please enable it to use Adaptive Dock.`;
            banner.button_label = `Enable ${name}`;
            banner.connect('button-clicked', () => {
                const cur = shellSettings.get_strv('enabled-extensions') || [];
                if (!cur.includes(target)) {
                    cur.push(target);
                    shellSettings.set_strv('enabled-extensions', cur);
                }
                banner.revealed = false;
            });
            banner.revealed = true;
        } else {
            banner.revealed = false;
        }
    } catch (e) {
        console.warn('Adaptive Dock: checkDockStatus error:', e.message);
    }
}

function openShortcutDialog(parentWindow, settings, keyName, onShortcutSet) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parentWindow,
        title: 'Set Shortcut',
        width_request: 420,
        height_request: 260,
    });

    const tbv = new Adw.ToolbarView();
    const hb = new Adw.HeaderBar({ show_title: true });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    cancelBtn.connect('clicked', () => dialog.close());
    hb.pack_start(cancelBtn);
    tbv.add_top_bar(hb);

    const statusPage = new Adw.StatusPage({
        title: 'New Shortcut',
        description: 'Press any key combination\nPress Esc to cancel, Backspace to disable',
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    });
    tbv.set_content(statusPage);
    dialog.set_content(tbv);

    const keyCtrl = new Gtk.EventControllerKey();
    dialog.add_controller(keyCtrl);

    keyCtrl.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;

        if (mask === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(keyName, []);
            if (onShortcutSet) onShortcutSet('');
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        if (mask === 0 || !Gtk.accelerator_valid(keyval, mask)) {
            return Gdk.EVENT_STOP;
        }

        const accel = Gtk.accelerator_name(keyval, mask);
        if (accel) {
            settings.set_strv(keyName, [accel]);
            if (onShortcutSet) onShortcutSet(accel);
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });

    dialog.present();
}

function openRenameWorkspaceDialog(parentWindow, wm, oldName, index, onRenamed) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parentWindow,
        title: 'Rename Workspace',
        width_request: 360,
        height_request: 180,
    });

    const tbv = new Adw.ToolbarView();
    const hb = new Adw.HeaderBar({ show_title: true });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    cancelBtn.connect('clicked', () => dialog.close());
    hb.pack_start(cancelBtn);

    const saveBtn = new Gtk.Button({
        label: 'Save',
        css_classes: ['suggested-action'],
    });
    hb.pack_end(saveBtn);
    tbv.add_top_bar(hb);

    const clamp = new Adw.Clamp({
        maximum_size: 400,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 16,
        margin_end: 16,
    });
    const group = new Adw.PreferencesGroup();
    const entryRow = new Adw.EntryRow({
        title: 'Workspace Name',
        text: oldName,
    });
    entryRow.set_activates_default(true);
    group.add(entryRow);

    clamp.set_child(group);
    tbv.set_content(clamp);
    dialog.set_content(tbv);

    const applyRename = () => {
        const newName = entryRow.get_text().trim();
        if (!newName || newName === oldName) {
            dialog.close();
            return;
        }
        const wmNames = wm.get_strv('workspace-names') || [];
        while (wmNames.length <= index) {
            const idx = wmNames.length;
            wmNames.push(wmNames[idx] || `Workspace ${idx + 1}`);
        }
        wmNames[index] = newName;
        wm.set_strv('workspace-names', wmNames);
        renameWs(oldName, newName);
        if (onRenamed) onRenamed(oldName, newName);
        dialog.close();
    };

    saveBtn.connect('clicked', applyRename);
    entryRow.connect('entry-activated', applyRename);
    dialog.present();
}

function openAddWorkspaceDialog(parentWindow, wm, settings, nextCount, onAdded) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parentWindow,
        title: 'New Workspace',
        width_request: 420,
        height_request: 260,
    });

    const tbv = new Adw.ToolbarView();
    const hb = new Adw.HeaderBar({ show_title: true });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    cancelBtn.connect('clicked', () => dialog.close());
    hb.pack_start(cancelBtn);

    const addBtn = new Gtk.Button({
        label: 'Add',
        css_classes: ['suggested-action'],
    });
    hb.pack_end(addBtn);
    tbv.add_top_bar(hb);

    const clamp = new Adw.Clamp({
        maximum_size: 400,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 16,
        margin_end: 16,
    });
    const group = new Adw.PreferencesGroup();

    const suggestedName = `Workspace ${nextCount + 1}`;
    const entryRow = new Adw.EntryRow({
        title: 'Workspace Name',
        text: suggestedName,
    });
    group.add(entryRow);

    const comboRow = new Adw.ComboRow({
        title: 'Dock Behavior',
        model: Gtk.StringList.new(CHOICES),
    });
    group.add(comboRow);

    clamp.set_child(group);
    tbv.set_content(clamp);
    dialog.set_content(tbv);

    const confirmAdd = () => {
        const name = entryRow.get_text().trim() || suggestedName;
        const wmNames = wm.get_strv('workspace-names') || [];
        while (wmNames.length < nextCount) {
            const idx = wmNames.length;
            wmNames.push(wmNames[idx] || `Workspace ${idx + 1}`);
        }
        wmNames.push(name);
        wm.set_strv('workspace-names', wmNames);

        if (comboRow.selected === 1) writeWs(name, 'show');
        else if (comboRow.selected === 2) writeWs(name, 'hide');

        // Check if dynamic workspaces is disabled; if static, increment num-workspaces
        try {
            const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            if (!mutterSettings.get_boolean('dynamic-workspaces')) {
                wm.set_int('num-workspaces', wm.get_int('num-workspaces') + 1);
            }
        } catch (_e) {}

        // Signal extension to append workspace in GNOME Shell
        const curReq = settings.get_int('request-add-workspace');
        settings.set_int('request-add-workspace', curReq + 1);

        if (onAdded) onAdded(name);
        dialog.close();
    };

    addBtn.connect('clicked', confirmAdd);
    entryRow.connect('entry-activated', confirmAdd);
    dialog.present();
}

function openAddAppOverrideDialog(parentWindow, settings, allApps, onAdded) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parentWindow,
        title: 'Add App Override',
        width_request: 440,
        height_request: 520,
    });

    const tbv = new Adw.ToolbarView();
    const hb = new Adw.HeaderBar({ show_title: true });
    const cancelBtn = new Gtk.Button({ label: 'Cancel' });
    cancelBtn.connect('clicked', () => dialog.close());
    hb.pack_start(cancelBtn);
    tbv.add_top_bar(hb);

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 16,
        margin_end: 16,
    });

    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: 'Search apps (e.g. Gemini, Chrome, Terminal)…',
    });
    box.append(searchEntry);

    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
    });

    const listBox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
    });

    const perWindowApps = settings.get_strv('per-window-apps') || [];
    const perAppApps = settings.get_strv('per-app-apps') || [];
    const existingIds = new Set([...perWindowApps, ...perAppApps]);

    const rows = [];
    for (const app of allApps) {
        const id = (app.get_id() ?? '').replace(/\.desktop$/, '');
        if (!id || existingIds.has(id)) continue;

        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(app.get_display_name(), -1),
            subtitle: id,
            activatable: true,
        });

        const icon = app.get_icon();
        if (icon) row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 28}));

        const addIcon = new Gtk.Image({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(addIcon);

        row.connect('activated', () => {
            // Default new override to per-window
            const cur = settings.get_strv('per-window-apps') || [];
            if (!cur.includes(id)) {
                cur.push(id);
                settings.set_strv('per-window-apps', cur);
            }
            if (onAdded) onAdded(id);
            dialog.close();
        });

        listBox.append(row);
        rows.push({ row, name: app.get_display_name().toLowerCase(), id: id.toLowerCase() });
    }

    searchEntry.connect('search-changed', () => {
        const query = searchEntry.get_text().toLowerCase().trim();
        for (const item of rows) {
            item.row.visible = !query || item.name.includes(query) || item.id.includes(query);
        }
    });

    scrolled.set_child(listBox);
    box.append(scrolled);
    tbv.set_content(box);
    dialog.set_content(tbv);
    dialog.present();
}

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 820);
        window.set_search_enabled(true);

        const settings = this.getSettings('org.gnome.shell.extensions.adaptive-dock');
        const dockSettings = getDockSettings();

        // ---- General page ----
        const genPage = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        // Banner group for dock conflict/missing warnings
        const bannerGroup = new Adw.PreferencesGroup();
        const banner = new Adw.Banner({revealed: false});
        bannerGroup.add(banner);
        genPage.add(bannerGroup);
        checkDockStatus(banner);

        // Shortcuts group
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Quickly toggle dock visibility on the fly during your session (resets on logout).',
        });

        const createShortcutRow = (title, subtitle, keyName) => {
            const row = new Adw.ActionRow({
                title,
                subtitle,
                activatable: true,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                valign: Gtk.Align.CENTER,
            });

            const label = new Gtk.ShortcutLabel({ valign: Gtk.Align.CENTER });
            const disabled = new Gtk.Label({
                label: 'Disabled',
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
            });
            const clear = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                has_frame: false,
                tooltip_text: 'Disable shortcut',
            });

            const update = (accel) => {
                if (accel && accel.trim().length > 0) {
                    label.accelerator = accel;
                    label.visible = true;
                    disabled.visible = false;
                    clear.visible = true;
                } else {
                    label.accelerator = '';
                    label.visible = false;
                    disabled.visible = true;
                    clear.visible = false;
                }
            };

            const current = settings.get_strv(keyName);
            update(current[0] ?? '');

            clear.connect('clicked', () => {
                settings.set_strv(keyName, []);
                update('');
            });

            row.connect('activated', () => {
                openShortcutDialog(window, settings, keyName, (newAccel) => {
                    update(newAccel);
                });
            });

            box.append(label);
            box.append(disabled);
            box.append(clear);
            row.add_suffix(box);
            shortcutsGroup.add(row);
        };

        createShortcutRow('Toggle Active App / Window', 'Override dock for focused window', 'toggle-dock');
        createShortcutRow('Toggle Workspace Baseline', 'Override dock baseline for active workspace', 'toggle-workspace-dock');

        genPage.add(shortcutsGroup);

        // On-Screen Notifications group
        const notifGroup = new Adw.PreferencesGroup({
            title: 'On-Screen Notifications',
            description: 'Configure visual indicators when shortcut toggles are pressed.',
        });

        const appNotifRow = new Adw.SwitchRow({
            title: 'Notify on App Toggle',
            subtitle: 'Show indicator when toggling dock for active app',
            active: settings.get_boolean('notify-on-app-toggle'),
        });
        settings.bind('notify-on-app-toggle', appNotifRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifGroup.add(appNotifRow);

        const wsNotifRow = new Adw.SwitchRow({
            title: 'Notify on Workspace Toggle',
            subtitle: 'Show indicator when toggling dock baseline for workspace',
            active: settings.get_boolean('notify-on-workspace-toggle'),
        });
        settings.bind('notify-on-workspace-toggle', wsNotifRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifGroup.add(wsNotifRow);

        // App notification icon style selector
        const appIconStyles = [
            { id: 'eye', label: 'Eye' },
            { id: 'window', label: 'Window' },
        ];
        const appIconModel = Gtk.StringList.new(appIconStyles.map(s => s.label));
        const appIconRow = new Adw.ComboRow({
            title: 'App Icon',
            subtitle: 'Icon style for app toggle indicators',
            model: appIconModel,
        });
        const curAppStyle = settings.get_string('osd-app-icon-style') || 'eye';
        const curAppIdx = appIconStyles.findIndex(s => s.id === curAppStyle);
        appIconRow.selected = curAppIdx >= 0 ? curAppIdx : 0;
        appIconRow.connect('notify::selected', () => {
            const selectedItem = appIconStyles[appIconRow.selected];
            if (selectedItem) settings.set_string('osd-app-icon-style', selectedItem.id);
        });
        notifGroup.add(appIconRow);

        // Workspace notification icon style selector
        const wsIconStyles = [
            { id: 'display', label: 'Display' },
            { id: 'grid', label: 'Grid' },
            { id: 'multitasking', label: 'Multitasking' },
        ];
        const wsIconModel = Gtk.StringList.new(wsIconStyles.map(s => s.label));
        const wsIconRow = new Adw.ComboRow({
            title: 'Workspace Icon',
            subtitle: 'Icon style for workspace toggle indicators',
            model: wsIconModel,
        });
        const curWsStyle = settings.get_string('osd-workspace-icon-style') || 'display';
        const curWsIdx = wsIconStyles.findIndex(s => s.id === curWsStyle);
        wsIconRow.selected = curWsIdx >= 0 ? curWsIdx : 0;
        wsIconRow.connect('notify::selected', () => {
            const selectedItem = wsIconStyles[wsIconRow.selected];
            if (selectedItem) settings.set_string('osd-workspace-icon-style', selectedItem.id);
        });
        notifGroup.add(wsIconRow);

        const offsetRow = Adw.SpinRow.new_with_range(-50.0, 300.0, 5.0);
        offsetRow.title = 'Offset Adjustment (px)';
        offsetRow.subtitle = 'Fine-tune notification vertical position';
        offsetRow.set_digits(0);
        settings.bind('notification-vertical-offset', offsetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        notifGroup.add(offsetRow);

        const updateNotifSensitivity = () => {
            const anyActive = appNotifRow.active || wsNotifRow.active;
            appIconRow.sensitive = appNotifRow.active;
            wsIconRow.sensitive = wsNotifRow.active;
            offsetRow.sensitive = anyActive;
        };
        appNotifRow.connect('notify::active', updateNotifSensitivity);
        wsNotifRow.connect('notify::active', updateNotifSensitivity);
        updateNotifSensitivity();

        genPage.add(notifGroup);

        // Dock Placement & Size group
        if (dockSettings) {
            const placementGroup = new Adw.PreferencesGroup({
                title: 'Dock Placement and Size',
                description: 'Configure dock screen position and icon sizing.',
            });

            // Dock Screen Position selector
            const dockPositions = [
                { id: 2, label: 'Bottom' },
                { id: 3, label: 'Left' },
                { id: 1, label: 'Right' },
                { id: 0, label: 'Top' },
            ];
            const posModel = Gtk.StringList.new(dockPositions.map(p => p.label));
            const posRow = new Adw.ComboRow({
                title: 'Position on Screen',
                model: posModel,
            });
            const updatePosRow = () => {
                let curEnum = 2;
                try {
                    curEnum = dockSettings.get_enum('dock-position');
                } catch (_e) {
                    const s = dockSettings.get_string('dock-position');
                    if (s === 'TOP') curEnum = 0;
                    else if (s === 'RIGHT') curEnum = 1;
                    else if (s === 'BOTTOM') curEnum = 2;
                    else if (s === 'LEFT') curEnum = 3;
                }
                const idx = dockPositions.findIndex(p => p.id === curEnum);
                if (idx >= 0 && posRow.selected !== idx) posRow.selected = idx;
            };
            updatePosRow();
            posRow.connect('notify::selected', () => {
                const chosen = dockPositions[posRow.selected];
                if (chosen !== undefined) {
                    try {
                        dockSettings.set_enum('dock-position', chosen.id);
                    } catch (_e) {
                        const strVal = chosen.id === 0 ? 'TOP' : chosen.id === 1 ? 'RIGHT' : chosen.id === 2 ? 'BOTTOM' : 'LEFT';
                        dockSettings.set_string('dock-position', strVal);
                    }
                }
            });
            try {
                dockSettings.connect('changed::dock-position', updatePosRow);
            } catch (_e) {}
            placementGroup.add(posRow);

            // Dock Icon Size limit
            if (hasKey(dockSettings, 'dash-max-icon-size')) {
                const iconSizeRow = Adw.SpinRow.new_with_range(16.0, 128.0, 2.0);
                iconSizeRow.title = 'Dock Icon Size (px)';
                iconSizeRow.set_digits(0);
                dockSettings.bind('dash-max-icon-size', iconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                placementGroup.add(iconSizeRow);
            }

            genPage.add(placementGroup);

            // Screen Edge Autohide & Reveal group
            const edgeGroup = new Adw.PreferencesGroup({
                title: 'Screen Edge Autohide and Reveal',
                description: 'Configure how the dock reveals itself when moving cursor to screen edge.',
            });

            // Master switch: Reveal dock on mouse hover at screen edge (autohide)
            const autohideRow = new Adw.SwitchRow({
                title: 'Reveal dock at screen edge',
            });
            if (hasKey(dockSettings, 'autohide')) {
                dockSettings.bind('autohide', autohideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            }
            edgeGroup.add(autohideRow);

            // Independent switch: Require pressure to show (Push to show)
            let pressureSwitchRow = null;
            if (hasKey(dockSettings, 'require-pressure-to-show')) {
                pressureSwitchRow = new Adw.SwitchRow({
                    title: 'Require pressure to reveal',
                    subtitle: 'Push against edge with mouse pressure instead of hovering',
                });
                dockSettings.bind('require-pressure-to-show', pressureSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(pressureSwitchRow);
            }

            // Pressure threshold
            let pressureRow = null;
            if (hasKey(dockSettings, 'pressure-threshold')) {
                pressureRow = Adw.SpinRow.new_with_range(0.0, 1000.0, 50.0);
                pressureRow.title = 'Pressure threshold';
                pressureRow.subtitle = 'Amount of mouse pressure needed to reveal dock';
                pressureRow.set_digits(0);
                dockSettings.bind('pressure-threshold', pressureRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(pressureRow);
            }

            // Show delay (when pressure is off)
            let showTimeoutRow = null;
            if (hasKey(dockSettings, 'show-delay')) {
                showTimeoutRow = Adw.SpinRow.new_with_range(0.0, 2.0, 0.05);
                showTimeoutRow.title = 'Show delay (s)';
                showTimeoutRow.subtitle = 'Hover delay before revealing dock (when pressure is off)';
                showTimeoutRow.set_digits(3);
                dockSettings.bind('show-delay', showTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(showTimeoutRow);
            }

            // Hide delay
            let hideTimeoutRow = null;
            if (hasKey(dockSettings, 'hide-delay')) {
                hideTimeoutRow = Adw.SpinRow.new_with_range(0.0, 2.0, 0.05);
                hideTimeoutRow.title = 'Hide delay (s)';
                hideTimeoutRow.subtitle = 'Delay before dock hides';
                hideTimeoutRow.set_digits(3);
                dockSettings.bind('hide-delay', hideTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(hideTimeoutRow);
            }

            // Animation duration
            let animRow = null;
            if (hasKey(dockSettings, 'animation-time')) {
                animRow = Adw.SpinRow.new_with_range(0.05, 2.0, 0.05);
                animRow.title = 'Animation duration (s)';
                animRow.subtitle = 'Slide animation speed';
                animRow.set_digits(3);
                dockSettings.bind('animation-time', animRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(animRow);
            }

            // Fullscreen
            let fsRow = null;
            if (hasKey(dockSettings, 'autohide-in-fullscreen')) {
                fsRow = new Adw.SwitchRow({
                    title: 'Enable in fullscreen mode',
                    subtitle: 'Allow edge reveal during fullscreen',
                });
                dockSettings.bind('autohide-in-fullscreen', fsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(fsRow);
            }

            // Urgent alerts
            let urgRow = null;
            if (hasKey(dockSettings, 'show-dock-urgent-notify')) {
                urgRow = new Adw.SwitchRow({
                    title: 'Show dock for urgent notifications',
                    subtitle: 'Reveal dock when apps demand attention',
                });
                dockSettings.bind('show-dock-urgent-notify', urgRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(urgRow);
            }

            // Sensitivity updates matching Dash to Dock
            const updateEdgeSensitivity = () => {
                const auto = autohideRow.active;
                const reqPressure = pressureSwitchRow ? pressureSwitchRow.active : false;

                if (pressureSwitchRow) pressureSwitchRow.sensitive = auto;
                if (pressureRow) pressureRow.sensitive = auto && reqPressure;
                if (showTimeoutRow) showTimeoutRow.sensitive = auto && !reqPressure;
                if (hideTimeoutRow) hideTimeoutRow.sensitive = auto;
                if (animRow) animRow.sensitive = auto;
                if (fsRow) fsRow.sensitive = auto;
                if (urgRow) urgRow.sensitive = auto;
            };

            autohideRow.connect('notify::active', updateEdgeSensitivity);
            if (pressureSwitchRow) pressureSwitchRow.connect('notify::active', updateEdgeSensitivity);
            updateEdgeSensitivity();

            genPage.add(edgeGroup);
        }

        // Multi-Monitor Isolation group
        const multiMonGroup = new Adw.PreferencesGroup({
            title: 'Multi-Monitor Behavior',
            description: 'Control whether dock visibility, session memory, shortcuts, and notifications operate independently on each display.',
        });

        const isolationRow = new Adw.SwitchRow({
            title: 'Per-Monitor Isolation',
            subtitle: 'Isolate dock visibility rules, shortcuts, session overrides, and OSD notifications per monitor',
            active: settings.get_boolean('per-monitor-isolation'),
        });
        settings.bind('per-monitor-isolation', isolationRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        multiMonGroup.add(isolationRow);

        genPage.add(multiMonGroup);

        window.add(genPage);

        // ---- Apps page ----
        const appsPage = new Adw.PreferencesPage({title: 'Apps', icon_name: 'view-app-grid-symbolic'});
        const allApps = Gio.AppInfo.get_all()
            .filter(a => a.should_show())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

        const connectedMonitors = getConnectedMonitors();
        let selectedAppConnector = connectedMonitors.find(m => m.isPrimary)?.connector || connectedMonitors[0]?.connector || null;

        const getActiveAppConnector = () => {
            return settings.get_boolean('per-monitor-isolation') ? selectedAppConnector : null;
        };

        const appMonitorGroup = new Adw.PreferencesGroup({
            title: 'Display Scope',
            description: 'Select the display for which application dock rules apply.',
        });
        const appMonitorModel = Gtk.StringList.new(connectedMonitors.map(m => m.label));
        const appMonitorCombo = new Adw.ComboRow({
            title: 'Configuring Display',
            model: appMonitorModel,
        });
        const primaryAppMonIdx = connectedMonitors.findIndex(m => m.isPrimary);
        appMonitorCombo.selected = primaryAppMonIdx >= 0 ? primaryAppMonIdx : 0;
        appMonitorGroup.add(appMonitorCombo);
        appsPage.add(appMonitorGroup);

        const appRowDropdownUpdaters = [];

        const updateAppMonitorGroupVisibility = () => {
            const isolated = settings.get_boolean('per-monitor-isolation');
            appMonitorGroup.visible = isolated && (connectedMonitors.length > 1);
        };
        settings.connect('changed::per-monitor-isolation', () => {
            updateAppMonitorGroupVisibility();
            for (const updater of appRowDropdownUpdaters) updater();
        });
        updateAppMonitorGroupVisibility();

        appMonitorCombo.connect('notify::selected', () => {
            const mon = connectedMonitors[appMonitorCombo.selected];
            if (mon) {
                selectedAppConnector = mon.connector;
                for (const updater of appRowDropdownUpdaters) updater();
            }
        });

        // Session Memory group
        const sessionGroup = new Adw.PreferencesGroup({
            title: 'Session Memory',
            description: 'Manage manual dock toggles during the active desktop session.',
        });

        const rememberRow = new Adw.SwitchRow({
            title: 'Remember manual dock state in current session',
            subtitle: 'Retain manual shortcut visibility until logout',
            active: settings.get_boolean('remember-session-state'),
        });
        settings.bind('remember-session-state', rememberRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sessionGroup.add(rememberRow);

        const persistRow = new Adw.SwitchRow({
            title: 'Persist App Shortcut Toggles',
            subtitle: 'Save Shift+Super+D changes to disk across reboots',
            active: settings.get_boolean('persist-app-shortcut-state'),
        });
        settings.bind('persist-app-shortcut-state', persistRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('remember-session-state', persistRow, 'sensitive', Gio.SettingsBindFlags.GET);
        sessionGroup.add(persistRow);

        const perWindowRow = new Adw.SwitchRow({
            title: 'Isolate state per window by default',
            subtitle: 'Apply shortcut toggle to active window only',
            active: settings.get_boolean('remember-per-window'),
        });
        settings.bind('remember-per-window', perWindowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('remember-session-state', perWindowRow, 'sensitive', Gio.SettingsBindFlags.GET);
        sessionGroup.add(perWindowRow);

        // App Isolation Overrides Expander
        const overridesExpander = new Adw.ExpanderRow({
            title: 'App Isolation Overrides',
            subtitle: 'Configure specific apps to isolate per window or per application',
        });
        settings.bind('remember-session-state', overridesExpander, 'sensitive', Gio.SettingsBindFlags.GET);
        sessionGroup.add(overridesExpander);

        const addOverrideActionRow = new Adw.ActionRow({
            title: 'Add app override…',
            activatable: true,
        });
        const addOverrideBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            has_frame: false,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add app override',
        });
        addOverrideActionRow.add_suffix(addOverrideBtn);

        let overrideRows = [];
        let appRowUpdaters = new Map();

        const refreshOverridesUI = () => {
            for (const r of overrideRows) {
                overridesExpander.remove(r);
            }
            overrideRows = [];

            const perWin = settings.get_strv('per-window-apps') || [];
            const perApp = settings.get_strv('per-app-apps') || [];
            const count = perWin.length + perApp.length;

            overridesExpander.subtitle = count === 0
                ? 'No app exceptions configured (all apps follow default)'
                : `${count} app exception${count === 1 ? '' : 's'} configured`;

            const combined = [
                ...perWin.map(id => ({ id, mode: 'window' })),
                ...perApp.map(id => ({ id, mode: 'app' })),
            ].sort((a, b) => a.id.localeCompare(b.id));

            for (const item of combined) {
                const appInfo = allApps.find(a => (a.get_id() ?? '').replace(/\.desktop$/, '') === item.id);
                const title = appInfo ? appInfo.get_display_name() : item.id;

                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(title, -1),
                    subtitle: item.id,
                });

                if (appInfo && appInfo.get_icon()) {
                    row.add_prefix(new Gtk.Image({ gicon: appInfo.get_icon(), pixel_size: 24 }));
                }

                const modeChoices = ['Isolate per window', 'Isolate per application'];
                const modeDrop = new Gtk.DropDown({
                    model: Gtk.StringList.new(modeChoices),
                    selected: item.mode === 'window' ? 0 : 1,
                    valign: Gtk.Align.CENTER,
                });

                modeDrop.connect('notify::selected', () => {
                    let curWin = settings.get_strv('per-window-apps') || [];
                    let curApp = settings.get_strv('per-app-apps') || [];
                    curWin = curWin.filter(x => x !== item.id);
                    curApp = curApp.filter(x => x !== item.id);

                    if (modeDrop.selected === 0) curWin.push(item.id);
                    else curApp.push(item.id);

                    settings.set_strv('per-window-apps', curWin);
                    settings.set_strv('per-app-apps', curApp);
                    refreshOverridesUI();
                    const updater = appRowUpdaters.get(item.id);
                    if (updater) updater();
                });
                row.add_suffix(modeDrop);

                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    has_frame: false,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove override',
                });
                delBtn.connect('clicked', () => {
                    let curWin = (settings.get_strv('per-window-apps') || []).filter(x => x !== item.id);
                    let curApp = (settings.get_strv('per-app-apps') || []).filter(x => x !== item.id);
                    settings.set_strv('per-window-apps', curWin);
                    settings.set_strv('per-app-apps', curApp);
                    refreshOverridesUI();
                    const updater = appRowUpdaters.get(item.id);
                    if (updater) updater();
                });
                row.add_suffix(delBtn);

                overridesExpander.add_row(row);
                overrideRows.push(row);
            }
        };

        const onAddOverrideClicked = () => {
            openAddAppOverrideDialog(window, settings, allApps, (newId) => {
                refreshOverridesUI();
                const updater = appRowUpdaters.get(newId);
                if (updater) updater();
            });
        };

        addOverrideActionRow.connect('activated', onAddOverrideClicked);
        addOverrideBtn.connect('clicked', onAddOverrideClicked);
        overridesExpander.add_row(addOverrideActionRow);
        refreshOverridesUI();

        appsPage.add(sessionGroup);

        // Per-app dock behaviour group
        const appsGroup = new Adw.PreferencesGroup({
            title: 'Per-app dock behaviour',
            description: 'Set dock visibility per app. "Inherit" follows the workspace rule. "Bypass" leaves the existing dock state untouched when this app gains focus.',
        });
        appsPage.add(appsGroup);

        for (const app of allApps) {
            const id = (app.get_id() ?? '').replace(/\.desktop$/, '');
            if (!id) continue;

            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(app.get_display_name(), -1),
                subtitle: id,
            });
            row.set_title_lines(1);
            row.set_subtitle_lines(1);

            const icon = app.get_icon();
            if (icon) row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));

            // Window isolation override toggle button
            const winToggleBtn = new Gtk.ToggleButton({
                icon_name: 'view-paged-symbolic',
                has_frame: false,
                valign: Gtk.Align.CENTER,
            });

            const updateAppRowVisuals = () => {
                const perWin = settings.get_strv('per-window-apps') || [];
                const perApp = settings.get_strv('per-app-apps') || [];

                if (perWin.includes(id)) {
                    winToggleBtn.active = true;
                    winToggleBtn.tooltip_text = 'Window isolation: Forced Per-Window (Click to restore default)';
                    row.subtitle = `${id} • 🪟 Per-window`;
                } else if (perApp.includes(id)) {
                    winToggleBtn.active = false;
                    winToggleBtn.tooltip_text = 'Window isolation: Forced Per-App (Click to switch to Per-Window)';
                    row.subtitle = `${id} • 🏢 Per-app`;
                } else {
                    winToggleBtn.active = false;
                    winToggleBtn.tooltip_text = 'Window isolation: Inheriting global default (Click to force Per-Window)';
                    row.subtitle = id;
                }
            };

            appRowUpdaters.set(id, updateAppRowVisuals);
            updateAppRowVisuals();

            winToggleBtn.connect('toggled', () => {
                let curWin = settings.get_strv('per-window-apps') || [];
                let curApp = settings.get_strv('per-app-apps') || [];
                curWin = curWin.filter(x => x !== id);
                curApp = curApp.filter(x => x !== id);

                if (winToggleBtn.active) {
                    curWin.push(id);
                }
                settings.set_strv('per-window-apps', curWin);
                settings.set_strv('per-app-apps', curApp);
                updateAppRowVisuals();
                refreshOverridesUI();
            });
            row.add_suffix(winToggleBtn);

            const dockDropDown = new Gtk.DropDown({
                model: Gtk.StringList.new(APP_CHOICES),
                valign: Gtk.Align.CENTER,
            });
            dockDropDown.set_size_request(130, -1);

            const refreshAppDropDown = () => {
                const conn = getActiveAppConnector();
                const cur = conn ? readMonitorApps(conn) : readApps();
                dockDropDown.selected = (cur[id] === 'show' || cur[id] === 'true') ? 1
                    : (cur[id] === 'hide' || cur[id] === 'false') ? 2
                    : cur[id] === 'bypass' ? 3
                    : 0;
            };
            appRowDropdownUpdaters.push(refreshAppDropDown);
            refreshAppDropDown();

            dockDropDown.connect('notify::selected', () => {
                const conn = getActiveAppConnector();
                const cur = conn ? readMonitorApps(conn) : readApps();
                if (dockDropDown.selected === 1) cur[id] = 'show';
                else if (dockDropDown.selected === 2) cur[id] = 'hide';
                else if (dockDropDown.selected === 3) cur[id] = 'bypass';
                else delete cur[id];

                if (conn) writeMonitorApps(conn, cur);
                else writeApps(cur);
            });
            row.add_suffix(dockDropDown);

            appsGroup.add(row);
        }
        window.add(appsPage);

        // ---- Workspaces page ----
        const wsPage = new Adw.PreferencesPage({title: 'Workspaces', icon_name: 'preferences-desktop-apps-symbolic'});

        let selectedWsConnector = connectedMonitors.find(m => m.isPrimary)?.connector || connectedMonitors[0]?.connector || null;

        const getActiveWsConnector = () => {
            return settings.get_boolean('per-monitor-isolation') ? selectedWsConnector : null;
        };

        const wsMonitorGroup = new Adw.PreferencesGroup({
            title: 'Display Scope',
            description: 'Select the display for which workspace dock baselines apply.',
        });
        const wsMonitorModel = Gtk.StringList.new(connectedMonitors.map(m => m.label));
        const wsMonitorCombo = new Adw.ComboRow({
            title: 'Configuring Display',
            model: wsMonitorModel,
        });
        const primaryWsMonIdx = connectedMonitors.findIndex(m => m.isPrimary);
        wsMonitorCombo.selected = primaryWsMonIdx >= 0 ? primaryWsMonIdx : 0;
        wsMonitorGroup.add(wsMonitorCombo);
        wsPage.add(wsMonitorGroup);

        const updateWsMonitorGroupVisibility = () => {
            const isolated = settings.get_boolean('per-monitor-isolation');
            wsMonitorGroup.visible = isolated && (connectedMonitors.length > 1);
        };
        settings.connect('changed::per-monitor-isolation', () => {
            updateWsMonitorGroupVisibility();
            syncWorkspaces();
        });
        updateWsMonitorGroupVisibility();

        wsMonitorCombo.connect('notify::selected', () => {
            const mon = connectedMonitors[wsMonitorCombo.selected];
            if (mon) {
                selectedWsConnector = mon.connector;
                syncWorkspaces();
            }
        });

        const wsConfigGroup = new Adw.PreferencesGroup({
            title: 'Workspaces',
            description: 'Configure default and per-workspace dock visibility.',
        });
        wsPage.add(wsConfigGroup);

        const defaultWsRow = new Adw.ActionRow({
            title: 'Default Dock Behavior',
            subtitle: 'Applied to workspaces without custom rules',
        });
        const defaultWsDrop = new Gtk.DropDown({
            model: Gtk.StringList.new(['Show dock', 'Hide dock']),
            valign: Gtk.Align.CENTER,
        });
        defaultWsDrop.set_size_request(130, -1);
        defaultWsDrop.selected = (settings.get_string('default-workspace-state') === 'hide') ? 1 : 0;
        defaultWsDrop.connect('notify::selected', () => {
            settings.set_string('default-workspace-state', defaultWsDrop.selected === 1 ? 'hide' : 'show');
        });
        defaultWsRow.add_suffix(defaultWsDrop);
        wsConfigGroup.add(defaultWsRow);

        const persistWsRow = new Adw.SwitchRow({
            title: 'Persist Workspace Shortcut Toggles',
            subtitle: 'Save Shift+Super+W changes to disk across reboots',
            active: settings.get_boolean('persist-workspace-shortcut-state'),
        });
        settings.bind('persist-workspace-shortcut-state', persistWsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('remember-session-state', persistWsRow, 'sensitive', Gio.SettingsBindFlags.GET);
        wsConfigGroup.add(persistWsRow);

        const spaceBarRow = new Adw.SwitchRow({
            title: 'Space Bar Menu Integration',
            subtitle: 'Add dock toggle to Space Bar workspace popup menu (if installed)',
            active: settings.get_boolean('integrate-space-bar'),
        });
        settings.bind('integrate-space-bar', spaceBarRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        wsConfigGroup.add(spaceBarRow);

        const wsGroup = new Adw.PreferencesGroup({
            title: 'Workspace Rules',
            description: 'Custom overrides for specific workspaces. Click the edit icon to rename.',
        });
        wsPage.add(wsGroup);

        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const removeLastWsBtn = new Gtk.Button({
            icon_name: 'list-remove-symbolic',
            has_frame: true,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove last workspace',
        });

        const addWsBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            has_frame: true,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add workspace',
        });

        headerBox.append(removeLastWsBtn);
        headerBox.append(addWsBtn);
        wsGroup.set_header_suffix(headerBox);

        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        let currentWsList = [];
        let wsRows = [];

        const syncWorkspaces = () => {
            const rawSynced = settings.get_strv('workspace-list') || [];
            const wmNames = wm.get_strv('workspace-names') || [];

            // Build effective workspace list, ensuring at least 4
            const effectiveList = [...rawSynced];
            const minCount = Math.max(wmNames.length, 4);
            while (effectiveList.length < minCount) {
                const idx = effectiveList.length;
                effectiveList.push(wmNames[idx] || `Workspace ${idx + 1}`);
            }

            // Always update rows to reflect fresh names or states
            for (const row of wsRows) {
                wsGroup.remove(row);
            }
            wsRows = [];
            currentWsList = effectiveList;

            // Only enable remove button if there are more than 4 workspaces
            removeLastWsBtn.sensitive = (effectiveList.length > 4);

            const activeWsConn = getActiveWsConnector();

            // Rebuild rows in clean sequential order
            for (let i = 0; i < effectiveList.length; i++) {
                const name = effectiveList[i];
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(name, -1),
                });

                const numLabel = new Gtk.Label({
                    label: `${i + 1}`,
                    css_classes: ['dim-label'],
                    valign: Gtk.Align.CENTER,
                    width_chars: 2,
                });
                row.add_prefix(numLabel);

                // Rename button
                const editBtn = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    has_frame: false,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `Rename "${name}"`,
                });
                editBtn.connect('clicked', () => {
                    openRenameWorkspaceDialog(window, wm, name, i, () => {
                        syncWorkspaces();
                    });
                });
                row.add_suffix(editBtn);

                // Dock behavior dropdown
                const dockDropDown = new Gtk.DropDown({
                    model: Gtk.StringList.new(WS_CHOICES),
                    valign: Gtk.Align.CENTER,
                });
                dockDropDown.set_size_request(130, -1);
                const cur = activeWsConn ? readMonitorWs(activeWsConn, name) : readWs(name);
                dockDropDown.selected = (cur === 'true' || cur === 'show') ? 1
                    : (cur === 'false' || cur === 'hide') ? 2
                    : 0;
                dockDropDown.connect('notify::selected', () => {
                    const connNow = getActiveWsConnector();
                    if (dockDropDown.selected === 1) {
                        if (connNow) writeMonitorWs(connNow, name, 'show');
                        else writeWs(name, 'show');
                    } else if (dockDropDown.selected === 2) {
                        if (connNow) writeMonitorWs(connNow, name, 'hide');
                        else writeWs(name, 'hide');
                    } else {
                        if (connNow) writeMonitorWs(connNow, name, null);
                        else writeWs(name, null);
                    }
                });
                row.add_suffix(dockDropDown);

                wsGroup.add(row);
                wsRows.push(row);
            }
        };

        addWsBtn.connect('clicked', () => {
            openAddWorkspaceDialog(window, wm, settings, currentWsList.length, () => {
                syncWorkspaces();
            });
        });

        removeLastWsBtn.connect('clicked', () => {
            if (currentWsList.length <= 4) return;
            const lastIdx = currentWsList.length - 1;
            const lastName = currentWsList[lastIdx];

            // 1. Remove state file if present
            const connNow = getActiveWsConnector();
            if (connNow) writeMonitorWs(connNow, lastName, null);
            writeWs(lastName, null);

            // 2. Pop from workspace-names
            const curWmNames = wm.get_strv('workspace-names') || [];
            if (curWmNames.length > lastIdx) {
                curWmNames.splice(lastIdx, 1);
                wm.set_strv('workspace-names', curWmNames);
            }

            // 3. Decrement workspace count if static
            try {
                const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
                if (!mutterSettings.get_boolean('dynamic-workspaces')) {
                    const count = wm.get_int('num-workspaces');
                    if (count > 4) wm.set_int('num-workspaces', count - 1);
                }
            } catch (_e) {}

            // 4. Update workspace-list in GSettings
            const updatedList = currentWsList.slice(0, lastIdx);
            settings.set_strv('workspace-list', updatedList);
            syncWorkspaces();
        });

        syncWorkspaces();

        const wsListChangedId = settings.connect('changed::workspace-list', () => syncWorkspaces());
        const wmNamesChangedId = wm.connect('changed::workspace-names', () => syncWorkspaces());

        window.connect('close-request', () => {
            try {
                settings.disconnect(wsListChangedId);
                wm.disconnect(wmNamesChangedId);
            } catch (_e) {}
        });

        window.add(wsPage);
    }
}
