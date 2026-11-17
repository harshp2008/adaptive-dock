# Adaptive Dock: Multi-Monitor Isolation Architecture

## Executive Summary

**Adaptive Dock** is a context-aware policy engine for GNOME Shell that dynamically manages dock visibility (specifically for **Dash to Dock** and **Ubuntu Dock**) based on active application focus, window characteristics, and workspace contexts.

Prior to this engineering initiative, Adaptive Dock operated entirely within a **global control domain**:
- Any dock visibility change triggered by window focus or keyboard shortcuts applied simultaneously to all attached displays.
- On-Screen Display (OSD) feedback notifications were broadcast globally across every monitor simultaneously.
- Session overrides, application-level persistence, and workspace-level baselines were unified across screens, preventing independent control when multitasking across multiple physical displays.

This project implements **Per-Monitor Isolation**, establishing each connected physical or virtual display as an autonomous dock control domain:
- **Focused-Monitor Resolution**: Shortcuts (`<Shift><Super>d` and `<Shift><Super>w`) evaluate the display containing the active focus window (or pointer location).
- **Localized OSD Scoping**: Notification pills appear strictly on the monitor initiating the state change.
- **Independent State Machine & Persistence**: Application rules, workspace baselines, and transient session overrides are segregated per monitor connector (e.g., `eDP-1`, `DVI-I-2`, `HDMI-1`), persisting across reboots and surviving display hotplug events.
- **Graceful Backward Compatibility**: Gated behind the `per-monitor-isolation` boolean GSettings key (enabled by default). When disabled, the extension reverts byte-for-byte to its legacy global behavior with zero regression.

---

## Architecture Navigation Map

The `docs/` directory documents every facet of this system for future maintainers and auditors:

| Document | Purpose |
|---|---|
| [01-repository-map.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/01-repository-map.md) | Comprehensive call graphs, signal connection lifecycles, and audit of global-assumption sites. |
| [02-multimonitor-investigation.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/02-multimonitor-investigation.md) | Technical findings report covering Mutter/Meta APIs, Dash to Dock internals, and GNOME Shell D-Bus interfaces with source citations. |
| [03-state-persistence-design.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/03-state-persistence-design.md) | Storage schema trade-offs (GSettings vs JSON vs per-monitor directory trees), atomic operations, migration, and hotplug pruning. |
| [04-osd-scoping.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/04-osd-scoping.md) | Deep dive into `Main.osdWindowManager`, D-Bus security constraints (`DBusSenderChecker`), and per-monitor vertical elevation clearance. |
| [05-experiments/](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/) | Reproducible empirical experiments conducted on live Wayland hardware: <br>• [Experiment 01](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/experiment-01-display-config-connector-resolution.md): DisplayConfig D-Bus connector resolution.<br>• [Experiment 02](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/experiment-02-dbus-showosd-security-restriction.md): ShowOSD D-Bus security restriction.<br>• [Experiment 03](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/experiment-03-mutter-connector-to-index-mapping.md): Mutter connector-to-index mapping.<br>• [Experiment 04](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/experiment-04-dock-actor-geometry-per-monitor.md): Dock actor geometry per monitor.<br>• [Experiment 05](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/05-experiments/experiment-05-live-extension-multimonitor-osd-and-isolation.md): Live multi-monitor isolation & persistence. |
| [06-test-matrix.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/06-test-matrix.md) | Exhaustive test matrix covering single/multi-monitor, hotplug addition/removal, shortcut isolation, and fallback handling. |
| [07-migration-and-rollback.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/07-migration-and-rollback.md) | Step-by-step upgrade migration algorithm, failure modes, rollback procedures, and persistent data retention semantics. |
| [08-open-questions.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/08-open-questions.md) | Institutional knowledge tracking unverified assumptions, design limitations, and recommended future roadmap items. |
| [implementation-plan.md](file:///home/harsh/Documents/GITHUB%20PROJECTS/adaptive-dock/docs/implementation-plan.md) | Blueprint of code modifications across schemas, extension engine, and preferences UI. |
