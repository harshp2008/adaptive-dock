import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CFG = GLib.get_user_config_dir();
const APP_STATES = GLib.build_filenamev([CFG, 'dock-app-states.json']);
const WS_DIR = GLib.build_filenamev([CFG, 'dock-workspace-states']);
const CHOICES = ['Default', 'Hide dock', 'Show dock (dodge windows)'];
const DOCK_SCHEMAS = ['org.gnome.shell.extensions.dash-to-dock', 'org.gnome.shell.extensions.ubuntu-dock'];

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

function readWs(name) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(GLib.build_filenamev([WS_DIR, `${name}.state`])).load_contents(null);
        return ok ? new TextDecoder().decode(bytes).trim() : null;
    } catch (_e) {
        return null;
    }
}

function writeWs(name, value) {
    GLib.mkdir_with_parents(WS_DIR, 0o755);
    const path = GLib.build_filenamev([WS_DIR, `${name}.state`]);
    if (value === null) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {}
    } else {
        GLib.file_set_contents(path, value);
    }
}

function getDockSettings() {
    const src = Gio.SettingsSchemaSource.get_default();
    for (const id of DOCK_SCHEMAS) {
        if (src.lookup(id, true))
            return new Gio.Settings({schema_id: id});
    }
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions',
        'dash-to-dock@micxgx.gmail.com', 'schemas']);
    if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
        const custom = Gio.SettingsSchemaSource.new_from_directory(dir, src, false);
        const schema = custom.lookup('org.gnome.shell.extensions.dash-to-dock', true);
        if (schema) return new Gio.Settings({settings_schema: schema});
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

function openShortcutDialog(parentWindow, settings, onShortcutSet) {
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

        // Escape cancels
        if (mask === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        // Backspace clears shortcut
        if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv('toggle-dock', []);
            if (onShortcutSet) onShortcutSet('');
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        // Must have valid accelerator with modifier
        if (mask === 0 || !Gtk.accelerator_valid(keyval, mask)) {
            return Gdk.EVENT_STOP;
        }

        const accel = Gtk.accelerator_name(keyval, mask);
        if (accel) {
            settings.set_strv('toggle-dock', [accel]);
            if (onShortcutSet) onShortcutSet(accel);
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });

    dialog.present();
}

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(700, 800);
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

        // Shortcut group
        const genGroup = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'Keyboard shortcut to toggle dock visibility.',
        });

        const shortcutRow = new Adw.ActionRow({
            title: 'Toggle dock',
            subtitle: 'Click to record or change shortcut',
            activatable: true,
        });

        const shortcutBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const shortcutLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
        });

        const disabledLabel = new Gtk.Label({
            label: 'Disabled',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            tooltip_text: 'Disable shortcut',
        });

        const updateDisplay = (accel) => {
            if (accel && accel.trim().length > 0) {
                shortcutLabel.accelerator = accel;
                shortcutLabel.visible = true;
                disabledLabel.visible = false;
                clearBtn.visible = true;
            } else {
                shortcutLabel.accelerator = '';
                shortcutLabel.visible = false;
                disabledLabel.visible = true;
                clearBtn.visible = false;
            }
        };

        const currentShortcuts = settings.get_strv('toggle-dock');
        updateDisplay(currentShortcuts[0] ?? '');

        clearBtn.connect('clicked', () => {
            settings.set_strv('toggle-dock', []);
            updateDisplay('');
        });

        shortcutRow.connect('activated', () => {
            openShortcutDialog(window, settings, (newAccel) => {
                updateDisplay(newAccel);
            });
        });

        shortcutBox.append(shortcutLabel);
        shortcutBox.append(disabledLabel);
        shortcutBox.append(clearBtn);
        shortcutRow.add_suffix(shortcutBox);
        genGroup.add(shortcutRow);
        genPage.add(genGroup);

        // Edge Reveal & Autohide group
        if (dockSettings) {
            const edgeGroup = new Adw.PreferencesGroup({
                title: 'Screen Edge Dock Reveal',
                description: 'Configure whether and how the dock reveals itself when moving the cursor to the screen edge.',
            });

            const revealRow = new Adw.SwitchRow({
                title: 'Reveal dock on mouse hover',
                subtitle: 'Show the dock when moving the cursor to the screen edge (off by default to prevent accidental auto-show)',
                active: settings.get_boolean('edge-hover-reveal'),
            });
            settings.bind('edge-hover-reveal', revealRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            revealRow.connect('notify::active', () => {
                if (hasKey(dockSettings, 'autohide'))
                    dockSettings.set_boolean('autohide', revealRow.active);
            });
            edgeGroup.add(revealRow);

            let pushRow = null;
            if (hasKey(dockSettings, 'require-pressure-to-show')) {
                pushRow = new Adw.SwitchRow({
                    title: 'Push to show',
                    subtitle: 'Require pressure against the screen edge before revealing the dock',
                });
                dockSettings.bind('require-pressure-to-show', pushRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(pushRow);
            }

            let pressureRow = null;
            if (hasKey(dockSettings, 'pressure-threshold')) {
                pressureRow = Adw.SpinRow.new_with_range(0.0, 100.0, 5.0);
                pressureRow.title = 'Pressure threshold';
                pressureRow.subtitle = 'Amount of mouse pressure needed to reveal dock (0 – 100)';
                pressureRow.set_digits(0);
                dockSettings.bind('pressure-threshold', pressureRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(pressureRow);
            }

            let animRow = null;
            if (hasKey(dockSettings, 'animation-time')) {
                animRow = Adw.SpinRow.new_with_range(0.05, 2.0, 0.05);
                animRow.title = 'Animation duration (s)';
                animRow.subtitle = 'Duration of dock show and hide animations';
                animRow.set_digits(3);
                dockSettings.bind('animation-time', animRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(animRow);
            }

            let hideTimeoutRow = null;
            if (hasKey(dockSettings, 'hide-delay')) {
                hideTimeoutRow = Adw.SpinRow.new_with_range(0.0, 2.0, 0.05);
                hideTimeoutRow.title = 'Hide timeout (s)';
                hideTimeoutRow.subtitle = 'Delay before dock hides after moving cursor away';
                hideTimeoutRow.set_digits(3);
                dockSettings.bind('hide-delay', hideTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(hideTimeoutRow);
            }

            let showTimeoutRow = null;
            if (hasKey(dockSettings, 'show-delay')) {
                showTimeoutRow = Adw.SpinRow.new_with_range(0.0, 2.0, 0.05);
                showTimeoutRow.title = 'Show timeout (s)';
                showTimeoutRow.subtitle = 'Hover delay before revealing dock (when pressure is disabled)';
                showTimeoutRow.set_digits(3);
                dockSettings.bind('show-delay', showTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                edgeGroup.add(showTimeoutRow);
            }

            const updateSensitivity = () => {
                const rev = revealRow.active;
                const pushOn = pushRow ? pushRow.active : false;

                if (pushRow) pushRow.sensitive = rev;
                if (animRow) animRow.sensitive = rev;
                if (hideTimeoutRow) hideTimeoutRow.sensitive = rev;
                if (pressureRow) pressureRow.sensitive = rev && pushOn;
                if (showTimeoutRow) showTimeoutRow.sensitive = rev && !pushOn;
            };

            revealRow.connect('notify::active', updateSensitivity);
            if (pushRow) pushRow.connect('notify::active', updateSensitivity);
            updateSensitivity();

            genPage.add(edgeGroup);

            // Additional behaviors group
            const hasFullscreen = hasKey(dockSettings, 'autohide-in-fullscreen');
            const hasUrgent = hasKey(dockSettings, 'show-dock-urgent-notify');

            if (hasFullscreen || hasUrgent) {
                const extraGroup = new Adw.PreferencesGroup({
                    title: 'Additional Behaviors',
                    description: 'Specific dock visibility triggers.',
                });

                if (hasFullscreen) {
                    const fsRow = new Adw.SwitchRow({
                        title: 'Enable in fullscreen mode',
                        subtitle: 'Allow revealing the dock at screen edge while an app is fullscreen',
                    });
                    dockSettings.bind('autohide-in-fullscreen', fsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                    extraGroup.add(fsRow);
                }

                if (hasUrgent) {
                    const urgRow = new Adw.SwitchRow({
                        title: 'Show dock for urgent notifications',
                        subtitle: 'Automatically reveal the dock when an application demands attention',
                    });
                    dockSettings.bind('show-dock-urgent-notify', urgRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                    extraGroup.add(urgRow);
                }

                genPage.add(extraGroup);
            }
        }

        window.add(genPage);

        // ---- Apps page ----
        const appsPage = new Adw.PreferencesPage({title: 'Apps', icon_name: 'view-app-grid-symbolic'});

        // Session Memory group
        const sessionGroup = new Adw.PreferencesGroup({
            title: 'Session Memory',
            description: 'Manage manual dock toggles during the active desktop session.',
        });

        const rememberRow = new Adw.SwitchRow({
            title: 'Remember manual dock state in current session',
            subtitle: 'Keep dock visible or hidden after toggling with shortcut until log out',
            active: settings.get_boolean('remember-session-state'),
        });
        settings.bind('remember-session-state', rememberRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sessionGroup.add(rememberRow);

        const perWindowRow = new Adw.SwitchRow({
            title: 'Isolate state per window',
            subtitle: 'Apply shortcut toggle to active window only instead of all windows of the app',
            active: settings.get_boolean('remember-per-window'),
        });
        settings.bind('remember-per-window', perWindowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('remember-session-state', perWindowRow, 'sensitive', Gio.SettingsBindFlags.GET);
        sessionGroup.add(perWindowRow);

        appsPage.add(sessionGroup);

        // Per-app dock behaviour group
        const appsGroup = new Adw.PreferencesGroup({
            title: 'Per-app dock behaviour',
            description: 'Overrides the workspace setting while this app is focused.',
        });
        appsPage.add(appsGroup);

        const states = readApps();
        const apps = Gio.AppInfo.get_all()
            .filter(a => a.should_show())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

        for (const app of apps) {
            const id = (app.get_id() ?? '').replace(/\.desktop$/, '');
            if (!id) continue;
            const row = new Adw.ComboRow({
                title: GLib.markup_escape_text(app.get_display_name(), -1),
                subtitle: id,
                model: Gtk.StringList.new(CHOICES),
            });
            const icon = app.get_icon();
            if (icon) row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));
            row.selected = states[id] === 'hide' ? 1 : states[id] === 'show' ? 2 : 0;
            row.connect('notify::selected', () => {
                const cur = readApps();
                if (row.selected === 1) cur[id] = 'hide';
                else if (row.selected === 2) cur[id] = 'show';
                else delete cur[id];
                writeApps(cur);
            });
            appsGroup.add(row);
        }
        window.add(appsPage);

        // ---- Workspaces page ----
        const wsPage = new Adw.PreferencesPage({title: 'Workspaces', icon_name: 'preferences-desktop-apps-symbolic'});
        const wsGroup = new Adw.PreferencesGroup({
            title: 'Per-workspace dock behaviour',
            description: 'Used when the focused app has no override. Name your workspaces in GNOME to tell them apart.',
        });
        wsPage.add(wsGroup);

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

            // Only rebuild if list changed
            if (JSON.stringify(currentWsList) === JSON.stringify(effectiveList)) {
                return;
            }
            currentWsList = effectiveList;

            // Clear old rows
            for (const row of wsRows) {
                wsGroup.remove(row);
            }
            wsRows = [];

            // Rebuild rows in clean sequential order
            for (const name of effectiveList) {
                const row = new Adw.ComboRow({
                    title: GLib.markup_escape_text(name, -1),
                    model: Gtk.StringList.new(CHOICES),
                });
                const cur = readWs(name);
                row.selected = cur === 'false' ? 1 : cur === 'true' ? 2 : 0;
                row.connect('notify::selected', () => {
                    writeWs(name, row.selected === 1 ? 'false' : row.selected === 2 ? 'true' : null);
                });
                wsGroup.add(row);
                wsRows.push(row);
            }
        };

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
