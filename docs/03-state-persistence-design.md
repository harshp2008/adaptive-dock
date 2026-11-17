# State Persistence Architecture & Storage Design

## 1. Storage Options Evaluation

To achieve robust per-monitor isolation while preserving complete backward compatibility, three primary persistence architectures were evaluated:

### Option A: Monolithic JSON Encoded into GSettings
- **Concept**: A new GSettings key `per-monitor-rules` of type `s` containing a serialized JSON string representing the entire hierarchy of monitors, applications, and workspace rules.
- **Evaluation**:
  - *Pros*: Built-in change notifications via GSettings signals; transactional writes managed by dconf.
  - *Cons*: GSettings strings have practical size constraints; manual inspection and repair by users via text editors is severely hindered; diverging from existing `dock-workspace-states` files requires writing a massive migration layer.

### Option B: Isolated Per-Monitor Root Directories
- **Concept**: Establish `~/.config/dock-monitors/<connector>/` containing isolated copies of `dock-app-states.json` and `workspaces/`.
- **Evaluation**:
  - *Pros*: Complete conceptual isolation between monitors.
  - *Cons*: Proliferation of filesystem watchers (`Gio.FileMonitor`); managing directory trees when displays are unplugged; switching the `per-monitor-isolation` flag to `false` creates desynchronization where global settings no longer reflect changes made in subfolders.

### Option C: Hybrid Structured JSON & Connector Subdirectories *(Chosen)*
- **Concept**:
  1. For Application Rules: Maintain a structured JSON document at `~/.config/dock-monitor-app-states.json` where top-level keys are connector strings. The existing global file `~/.config/dock-app-states.json` is preserved untouched for rollback / flag-disabled mode.
  2. For Workspace Rules: Store per-monitor workspace states in `~/.config/dock-workspace-states/<connector>/<workspaceName>.state`. Existing global files in `~/.config/dock-workspace-states/*.state` remain in place.
- **Evaluation**:
  - *Pros*:
    - POSIX atomic writes using `GLib.file_set_contents` (write-to-temp + rename).
    - Preserves exact human-readable text file format.
    - Zero data loss: existing rules are cleanly migrated to the primary monitor domain on first run.
    - Perfect backward compatibility: disabling the flag causes the extension to read and write directly to the legacy root files without alteration.

---

## 2. Persistence Schema Specifications

### 2.1 Per-Monitor Application State Schema (`dock-monitor-app-states.json`)

**Schema Structure**:
```json
{
  "version": 1,
  "monitors": {
    "<connector-id>": {
      "<app-id>": "show" | "hide" | "bypass"
    }
  }
}
```

**Concrete Example Document**:
```json
{
  "version": 1,
  "monitors": {
    "eDP-1": {
      "google-chrome": "show",
      "org.gnome.Terminal": "hide",
      "win11clip": "bypass",
      "dev.gustavosett.clipboard-history": "bypass"
    },
    "DVI-I-2": {
      "google-chrome": "hide",
      "org.gnome.Terminal": "show",
      "win11clip": "bypass"
    }
  }
}
```

### 2.2 Per-Monitor Workspace State Files (`dock-workspace-states/<connector>/`)

Each file is stored at:
`~/.config/dock-workspace-states/<connector-name>/<sanitized-workspace-name>.state`

**Directory Tree Example**:
```text
~/.config/dock-workspace-states/
├── General.state                      <-- Legacy / Global fallback
├── College Admission.state            <-- Legacy / Global fallback
├── eDP-1/
│   ├── General.state                  <-- eDP-1 baseline: "false"
│   └── College Admission.state        <-- eDP-1 baseline: "true"
└── DVI-I-2/
    ├── General.state                  <-- DVI-I-2 baseline: "true"
    └── College Admission.state        <-- DVI-I-2 baseline: "false"
```

**File Contents**:
Single unquoted token: `show`, `hide`, `true`, or `false`.

---

## 3. Atomic Write Implementation

To prevent file corruption during sudden system shutdowns or power interruptions, all disk writes use `GLib.file_set_contents`:

```javascript
function atomicWriteJson(path, data) {
    const jsonStr = JSON.stringify(data, null, 2);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, jsonStr);
}

function atomicWriteText(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
}
```

---

## 4. Migration Algorithm (Step-by-Step)

The migration algorithm runs automatically upon extension startup if `per-monitor-isolation` is enabled and per-monitor state has not yet been initialized for the current primary monitor:

1. **Resolve Primary Connector**: Query `global.backend.get_monitor_manager()` and Mutter `DisplayConfig` to find the primary display's connector string (e.g. `eDP-1`). If resolution fails, fall back to `'default'`.
2. **App States Migration**:
   - Check if `~/.config/dock-monitor-app-states.json` exists.
   - If the file does not exist, or does not contain an entry under `monitors[primaryConnector]`:
     - Load legacy rules from `~/.config/dock-app-states.json` (if present).
     - Populate `monitors[primaryConnector]` with a deep copy of the legacy rules.
     - Write out `~/.config/dock-monitor-app-states.json`.
     - Log: `Adaptive Dock: Migrated legacy app states to primary monitor (<connector>)`.
3. **Workspace States Migration**:
   - Inspect the legacy directory `~/.config/dock-workspace-states/`.
   - Iterate over all `.state` files located in the root of that directory.
   - For each file `<workspace>.state`:
     - Construct destination path `~/.config/dock-workspace-states/<primaryConnector>/<workspace>.state`.
     - If the destination file does not exist, copy the contents of the legacy file into the destination.
   - Log: `Adaptive Dock: Migrated legacy workspace states to primary monitor (<connector>)`.
4. **Mark Migration Complete**: Persist state to prevent redundant migration passes on subsequent reloads.

---

## 5. Hotplug & Orphaned Entry Pruning Algorithm

When displays are disconnected, configurations must not be immediately erased, as temporary disconnections (cable adjustments, dock unplugging, power suspend) are frequent. Pruning operates according to this algorithm:

1. **Signal Catching**: Listen for `'monitors-changed'` on `Main.layoutManager`.
2. **Hardware Re-scan**: Query `GetCurrentState` and build the active connector set `activeConnectors = Set(['eDP-1', ...])`.
3. **Transient In-Memory Pruning**:
   - For each `connector` in `this._sessionAppStates.keys()`:
     - If `!activeConnectors.has(connector)`:
       - Clear in-memory session maps for `connector` to reclaim heap memory.
       - Log debug: `Adaptive Dock: Pruned transient session cache for disconnected monitor: <connector>`.
4. **Persistent On-Disk Retention Policy**:
   - Records in `dock-monitor-app-states.json` and `dock-workspace-states/<connector>/` remain intact on disk by default.
   - When a previously configured monitor is reconnected, its rules immediately reactivate without user intervention.
5. **Explicit Pruning**:
   - Preferences exposes a maintenance action to prune entries for connectors no longer present in the system, logging each removed connector.
