# DevSpace Modular Computer-Awareness Roadmap

DevSpace core remains the primary runtime and source of truth. Optional capabilities are secondary modules. A secondary module may be disabled, unavailable, degraded, restarting, or failed without making the core MCP server unavailable.

## Safety rules

- Never develop directly against the live installed DevSpace instance.
- Keep the production installation usable as the recovery/control path.
- Develop in an isolated Git worktree based on a known snapshot.
- Preserve MCP tool names and schemas while extracting existing capabilities.
- Run typecheck, regression tests, and a production build after each extraction.
- Do not deploy the experimental build over production until the development instance passes end-to-end validation.
- A module failure must not crash DevSpace core unless the capability is explicitly promoted to a core dependency.

## Phase 0A — Modularize existing DevSpace

- [x] Protect the current source checkout with a full filesystem safety copy.
- [x] Create a Git snapshot of meaningful source state without changing the original working tree/index.
- [x] Open an isolated managed worktree from that snapshot.
- [x] Baseline typecheck, regression tests, and production build.
- [x] Add a secondary-module registry with fault isolation.
- [x] Add module health states.
- [x] Establish in-place module boundaries for workspace, agents, filesystem, reviews, search, shell, and process tooling before physically extracting them from `server.ts`.
- [x] Wrap the existing upstream MCP bridge as a secondary module.
- [x] Wrap Git tooling as a secondary module.
- [x] Wrap the elevated admin broker as a secondary module.
- [x] Wrap existing Windows computer-control tooling as a platform module.
- [x] Wrap artifact tooling as a secondary module.
- [x] Add a core `get_devspace_module_status` MCP tool.
- [x] Add regression tests proving a failed module does not stop healthy modules.
- [x] Extract workspace tool registration from `server.ts` while keeping workspace state owned by core context.
- [x] Extract filesystem tool registration from `server.ts`.
- [x] Extract shell tool registration from `server.ts`.
- [x] Extract process-session tool registration from `server.ts`.
- [x] Extract local-agent tool registration from `server.ts`.
- [x] Extract review/checkpoint tool registration from `server.ts`.
- [x] Keep authentication, configuration, persistence, MCP transport, and module lifecycle in core.
- [ ] Compare the complete MCP tool/schema surface before and after extraction.
- [x] Prove a second development build can start on a separate port with separate state while production remains healthy.
- [ ] Run authenticated MCP end-to-end testing against a persistent second DevSpace service identity.

## Phase 0B — Desktop agent foundation

- [x] Add a separate `devspace-desktop-agent` process/service.
- [x] Use local authenticated IPC between DevSpace core and the desktop agent.
- [ ] Add protocol version negotiation beyond strict version validation.
- [x] Add capability discovery.
- [x] Add bounded reconnect/backoff for mid-request desktop-agent transport loss without retrying permission, protocol, or provider errors.
- [x] Add per-capability permissions with read-only status reporting; all desktop permissions default granted, with explicit per-capability config overrides available to disable them.
- [x] Hot-reload desktop permission config inside the isolated Desktop Agent without restarting DevSpace or the agent process.
- [x] Add health reporting and a kill switch.
- [x] Ensure agent failure never terminates DevSpace core.
- [x] Launch Linux desktop agent through the user systemd manager so it inherits the active KDE graphical-session environment while core remains detached.

## Desktop modules

- [x] Linux KDE/Wayland window/application awareness using KWin D-Bus window enumeration and per-window metadata, enriched with safe process identity from `/proc`.
- [x] KDE monitor/display awareness using KScreen JSON plus KWin active-output state, including layout, scale, modes, refresh rate, physical size, priority, brightness, and active/primary status.
- [x] Read-only KDE virtual desktop awareness, including desktop IDs/names/order, current desktop, rows, and navigation wrapping state.
- [x] Structured Linux process/application awareness using `/proc`, correlated with KWin window ownership while excluding command-line arguments and environment variables.
- [ ] Screenshot/window/region capture.
- [ ] AT-SPI accessibility tree and semantic UI actions.
- [ ] Keyboard/mouse input control.
- [ ] Clipboard read/write with explicit permissions.
- [x] Read-only bounded in-memory desktop notification awareness via passive freedesktop/Plasma D-Bus observation.
- [ ] Desktop notification actions/dismissal/reply handling with explicit permissions.
- [x] Read-only PipeWire audio graph, application streams, channel ports, and active route links.
- [ ] PipeWire live meters and richer runtime stream telemetry.
- [x] Read-only Linux USB, PCI/PCIe, block-storage, and Bluetooth inventory with privacy-safe identifiers.
- [x] Hardware/device connect/disconnect/state-change events in the bounded activity timeline.
- [x] Network interface/route/service awareness (read-only Linux interfaces, addresses, routes, DNS, listeners, and Cloudflare Tunnel process state).
- [ ] Authorized filesystem watchers.
- [x] Application log/tracing correlation for `pid:<pid>` activity IDs, combining bounded timeline events with explicit bounded Linux user-journal reads. Journal source discovery and source-specific reads are also available.
- [ ] Browser-session integration where explicitly authorized.

## Event and correlation layer

- [x] Add a common event envelope with sequence, timestamp, source module, application identity, entity ID, and correlation ID.
- [x] Add process start/stop events.
- [ ] Add window focus events through a verified Wayland-native/AT-SPI signal path. Window create/close/move/resize/title/state changes are already captured by the polling timeline.
- [x] Add virtual desktop create/remove/name/order/current-desktop events.
- [x] Add PipeWire audio stream start/stop/change and route create/remove/topology-change events, while suppressing noisy link transport-state flaps.
- [x] Add device connect/disconnect/change events with privacy-safe stable IDs.
- [x] Add notification creation/closure events correlated to the sender PID when Plasma provides it.
- [ ] Add authorized filesystem events.
- [x] Add network events for interface state/address changes, route/DNS changes, listener open/close, and Cloudflare Tunnel start/stop. Display connect/disconnect/layout/mode/brightness changes are already captured.
- [x] Build a bounded in-memory activity timeline that can answer questions such as “what happened after I clicked Generate?” by comparing event sequence cursors.

## Integration modules

- [x] Upstream MCP bridge tolerates offline Unity/Unreal/Blockbench servers.
- [ ] Surface per-upstream health inside the unified module/capability status model.
- [ ] Add application-specific adapters only as enhancements to generic desktop awareness.
- [ ] Keep Unreal, Unity, Blockbench, SteamVR, OBS, ShiryuAudio, ShiryuGen, and browser integrations optional.

## Reliability gates

Each completed module must pass:

1. Core remains reachable when the module is absent.
2. Core remains reachable when module initialization throws.
3. Core remains reachable if the backing application/service exits.
4. Existing MCP tools retain their schemas unless an intentional versioned change is approved.
5. Typecheck passes.
6. Relevant targeted tests pass.
7. Full regression suite passes.
8. Production build passes.
9. Development instance can start independently of production.
