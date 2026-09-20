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
- [ ] Add reconnect/backoff behavior for mid-request agent loss.
- [ ] Add per-capability permissions.
- [x] Add health reporting and a kill switch.
- [x] Ensure agent failure never terminates DevSpace core.
- [x] Launch Linux desktop agent through the user systemd manager so it inherits the active KDE graphical-session environment while core remains detached.

## Desktop modules

- [x] Linux KDE/Wayland window/application awareness using KWin D-Bus window enumeration and per-window metadata, enriched with safe process identity from `/proc`.
- [x] KDE monitor/display awareness using KScreen JSON plus KWin active-output state, including layout, scale, modes, refresh rate, physical size, priority, brightness, and active/primary status.
- [ ] Screenshot/window/region capture.
- [ ] AT-SPI accessibility tree and semantic UI actions.
- [ ] Keyboard/mouse input control.
- [ ] Clipboard read/write with explicit permissions.
- [ ] Desktop notification awareness/actions.
- [ ] PipeWire audio graph, routes, streams, and meters.
- [ ] Hardware/device hotplug awareness.
- [ ] Network interface/route/service awareness.
- [ ] Authorized filesystem watchers.
- [ ] Application log/tracing correlation.
- [ ] Browser-session integration where explicitly authorized.

## Event and correlation layer

- [ ] Add a common event envelope with timestamp, source module, application identity, and correlation ID.
- [ ] Add process start/stop events.
- [ ] Add window create/close/focus/move/resize events.
- [ ] Add audio stream/route events.
- [ ] Add device connect/disconnect/change events.
- [ ] Add notification events.
- [ ] Add authorized filesystem events.
- [ ] Add display/network events.
- [ ] Build an activity timeline that can answer questions such as “what happened after I clicked Generate?”

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
