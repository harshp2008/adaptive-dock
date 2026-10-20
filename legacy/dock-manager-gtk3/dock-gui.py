#!/usr/bin/env python3
import os, glob, json
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

LOCAL_DIR = os.path.expanduser("~/.local/share/applications")
STATE_FILE = os.path.expanduser("~/.config/dock-app-states.json")

class DockManagerWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title="Dock Manager")
        self.set_default_size(1000, 700)
        
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        vbox.set_border_width(10)
        self.add(vbox)
        
        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Search applications...")
        self.search_entry.connect("search-changed", self.on_search_changed)
        vbox.pack_start(self.search_entry, False, False, 0)
        
        self.liststore = Gtk.ListStore(str, str, str)
        self.load_data()
        
        self.filter = self.liststore.filter_new()
        self.filter.set_visible_func(self.filter_func)
        
        treeview = Gtk.TreeView.new_with_model(self.filter)
        
        for i, title in enumerate(["App Name", "Shortcut File"]):
            renderer = Gtk.CellRendererText()
            column = Gtk.TreeViewColumn(title, renderer, text=i)
            column.set_resizable(True)
            treeview.append_column(column)
        
        combo_model = Gtk.ListStore(str)
        for opt in ["none", "hide", "show"]:
            combo_model.append([opt])
            
        renderer_combo = Gtk.CellRendererCombo()
        renderer_combo.set_property("editable", True)
        renderer_combo.set_property("model", combo_model)
        renderer_combo.set_property("text-column", 0)
        renderer_combo.set_property("has-entry", False)
        renderer_combo.connect("edited", self.on_combo_changed)
        
        column_combo = Gtk.TreeViewColumn("Dock State", renderer_combo, text=2)
        treeview.append_column(column_combo)
        
        scroll = Gtk.ScrolledWindow()
        scroll.add(treeview)
        vbox.pack_start(scroll, True, True, 0)
        
    def load_data(self):
        try:
            with open(STATE_FILE, 'r') as f:
                states = json.load(f)
        except:
            states = {}

        paths = []
        paths.extend(glob.glob("/usr/share/applications/*.desktop"))
        paths.extend(glob.glob("/var/lib/flatpak/exports/share/applications/*.desktop"))
        paths.extend(glob.glob(os.path.join(LOCAL_DIR, "*.desktop")))
        
        seen = set()
        for path in sorted(paths):
            filename = os.path.basename(path)
            if filename in seen: continue
            seen.add(filename)
            
            app_name = filename
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if line.startswith("Name="):
                            app_name = line.strip().split("=", 1)[1]
                            break
            except: pass
            
            key = filename.replace('.desktop', '')
            state = states.get(key, "none")
            self.liststore.append([app_name, filename, state])
            
    def filter_func(self, model, iter, data):
        query = self.search_entry.get_text().lower()
        if not query: return True
        return query in model[iter][0].lower() or query in model[iter][1].lower()
        
    def on_search_changed(self, entry):
        self.filter.refilter()
        
    def on_combo_changed(self, widget, path, text):
        filter_iter = self.filter.get_iter(path)
        child_iter = self.filter.convert_iter_to_child_iter(filter_iter)
        self.liststore[child_iter][2] = text
        
        filename = self.liststore[child_iter][1]
        key = filename.replace('.desktop', '')
        
        try:
            with open(STATE_FILE, 'r') as f:
                states = json.load(f)
        except:
            states = {}
            
        if text == "none":
            states.pop(key, None)
        else:
            states[key] = text
            
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, 'w') as f:
            json.dump(states, f, indent=2)

win = DockManagerWindow()
win.connect("destroy", Gtk.main_quit)
win.show_all()
Gtk.main()
