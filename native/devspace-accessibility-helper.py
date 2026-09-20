#!/usr/bin/env python3
import argparse
import json
import re
import sys
import warnings
from datetime import datetime, timezone

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

warnings.filterwarnings("ignore", category=DeprecationWarning)

FOCUS_WINDOW_ROLES = {"dialog", "frame", "window", "alert"}


def safe(call, default=None):
    try:
        value = call()
        return default if value is None else value
    except Exception:
        return default


def normalize_state(state):
    nick = getattr(state, "value_nick", None)
    return str(nick if nick else state).lower().replace("atspi_state_", "").replace("_", "-")


def node_actions(accessible):
    count = safe(accessible.get_n_actions, 0) or 0
    actions = []
    for index in range(min(int(count), 64)):
        name = safe(lambda i=index: accessible.get_action_name(i), "") or ""
        description = safe(lambda i=index: accessible.get_action_description(i), "") or ""
        key_binding = safe(lambda i=index: accessible.get_key_binding(i), "") or ""
        actions.append({
            "index": index,
            "name": str(name),
            "description": str(description),
            "keyBinding": str(key_binding),
        })
    return actions


def node_bounds(accessible):
    rect = safe(lambda: accessible.get_extents(Atspi.CoordType.SCREEN))
    if rect is None:
        return None
    return {
        "x": int(rect.x),
        "y": int(rect.y),
        "width": int(rect.width),
        "height": int(rect.height),
    }


def node_record(accessible, node_id, parent_id, depth, app_name):
    states_obj = safe(accessible.get_state_set)
    states = safe(states_obj.get_states, []) if states_obj is not None else []
    interfaces = safe(accessible.get_interfaces, []) or []
    attrs = safe(accessible.get_attributes, {}) or {}
    if not isinstance(attrs, dict):
        attrs = {}
    record = {
        "id": node_id,
        "parentId": parent_id,
        "depth": depth,
        "application": app_name,
        "accessibleId": str(safe(accessible.get_accessible_id, "") or ""),
        "processId": int(safe(accessible.get_process_id, 0) or 0),
        "name": str(safe(accessible.get_name, "") or ""),
        "description": str(safe(accessible.get_description, "") or ""),
        "role": str(safe(accessible.get_role_name, "unknown") or "unknown"),
        "localizedRole": str(safe(accessible.get_localized_role_name, "") or ""),
        "childCount": max(0, int(safe(accessible.get_child_count, 0) or 0)),
        "states": sorted({normalize_state(state) for state in states}),
        "interfaces": sorted({str(value) for value in interfaces}),
        "actions": node_actions(accessible),
        "bounds": node_bounds(accessible),
    }
    # Keep only low-risk structural attributes. Do not expose free-form text/value payloads.
    allowed_attrs = ("class", "id", "level", "placeholder-text", "tag")
    filtered = {str(k): str(v) for k, v in attrs.items() if str(k) in allowed_attrs}
    if filtered:
        record["attributes"] = filtered
    return record


def snapshot(args):
    desktop = Atspi.get_desktop(0)
    app_count = max(0, int(safe(desktop.get_child_count, 0) or 0))
    roots = []
    requested = args.application.casefold() if args.application else None
    for index in range(app_count):
        app = safe(lambda i=index: desktop.get_child_at_index(i))
        if app is None:
            continue
        name = str(safe(app.get_name, "") or "")
        accessible_id = str(safe(app.get_accessible_id, "") or "")
        if requested and requested not in {name.casefold(), accessible_id.casefold()}:
            continue
        roots.append((index, app, name or accessible_id or f"application-{index}"))

    nodes = []
    truncated = False

    def visit(accessible, node_id, parent_id, depth, app_name):
        nonlocal truncated
        if len(nodes) >= args.max_nodes:
            truncated = True
            return
        nodes.append(node_record(accessible, node_id, parent_id, depth, app_name))
        if depth >= args.max_depth:
            if safe(accessible.get_child_count, 0):
                truncated = True
            return
        child_count = max(0, int(safe(accessible.get_child_count, 0) or 0))
        for child_index in range(child_count):
            if len(nodes) >= args.max_nodes:
                truncated = True
                return
            child = safe(lambda i=child_index: accessible.get_child_at_index(i))
            if child is None:
                continue
            visit(child, f"{node_id}.{child_index}", node_id, depth + 1, app_name)

    for root_index, app, app_name in roots:
        if len(nodes) >= args.max_nodes:
            truncated = True
            break
        process_id = int(safe(app.get_process_id, 0) or 0)
        root_id = f"pid-{process_id}" if process_id > 0 else f"app-{root_index}"
        visit(app, root_id, None, 0, app_name)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "applicationCount": len(roots),
        "nodeCount": len(nodes),
        "truncated": truncated,
        "maxDepth": args.max_depth,
        "maxNodes": args.max_nodes,
        "nodes": nodes,
    }


def resolve_action_target(node_id):
    match = re.fullmatch(r"pid-(\d+)((?:\.\d+)*)", node_id)
    if not match:
        raise ValueError("Accessibility action target must use a pid-based node ID from a recent snapshot.")
    process_id = int(match.group(1))
    child_path = [int(value) for value in match.group(2).split(".") if value]
    desktop = Atspi.get_desktop(0)
    app_count = max(0, int(safe(desktop.get_child_count, 0) or 0))
    target = None
    for index in range(app_count):
        app = safe(lambda i=index: desktop.get_child_at_index(i))
        if app is not None and int(safe(app.get_process_id, 0) or 0) == process_id:
            target = app
            break
    if target is None:
        raise ValueError("Accessibility target application is no longer available.")
    for child_index in child_path:
        child_count = max(0, int(safe(target.get_child_count, 0) or 0))
        if child_index < 0 or child_index >= child_count:
            raise ValueError("Accessibility target path is stale.")
        target = safe(lambda i=child_index, parent=target: parent.get_child_at_index(i))
        if target is None:
            raise ValueError("Accessibility target path is stale.")
    return target


def focus_event_record(source):
    process_id = int(safe(source.get_process_id, 0) or 0)
    control_role = str(safe(source.get_role_name, "unknown") or "unknown")
    control_name = str(safe(source.get_name, "") or "")
    control_accessible_id = str(safe(source.get_accessible_id, "") or "")
    application = safe(source.get_application)
    application_name = str(safe(application.get_name, "") or "") if application is not None else ""
    application_id = str(safe(application.get_accessible_id, "") or "") if application is not None else ""

    window = None
    current = source
    for _ in range(16):
        if current is None:
            break
        role = str(safe(current.get_role_name, "unknown") or "unknown")
        if role in FOCUS_WINDOW_ROLES:
            window = current
            break
        current = safe(current.get_parent)

    if window is None:
        window = application or source
    window_role = str(safe(window.get_role_name, "unknown") or "unknown")
    window_name = str(safe(window.get_name, "") or "")
    window_accessible_id = str(safe(window.get_accessible_id, "") or "")
    return {
        "focusedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "processId": process_id,
        "application": application_name,
        "applicationId": application_id,
        "windowRole": window_role,
        "windowName": window_name,
        "windowAccessibleId": window_accessible_id,
        "controlRole": control_role,
        "controlName": control_name,
        "controlAccessibleId": control_accessible_id,
    }


def focus_monitor():
    def on_focus(event, _user_data):
        if int(getattr(event, "detail1", 0) or 0) != 1:
            return
        source = getattr(event, "source", None)
        if source is None:
            return
        record = focus_event_record(source)
        if record["processId"] <= 0:
            return
        print(json.dumps(record, separators=(",", ":"), ensure_ascii=False), flush=True)

    listener = Atspi.EventListener.new(on_focus, None)
    if not listener.register("object:state-changed:focused"):
        raise RuntimeError("Unable to register AT-SPI focus listener.")
    Atspi.event_main()


def perform_action(args):
    target = resolve_action_target(args.node_id)
    role = str(safe(target.get_role_name, "unknown") or "unknown")
    name = str(safe(target.get_name, "") or "")
    accessible_id = str(safe(target.get_accessible_id, "") or "")
    if role != args.expected_role:
        raise ValueError("Accessibility target role changed since the snapshot.")
    if name != args.expected_name:
        raise ValueError("Accessibility target name changed since the snapshot.")
    if args.expected_accessible_id is not None and accessible_id != args.expected_accessible_id:
        raise ValueError("Accessibility target ID changed since the snapshot.")
    action_count = max(0, int(safe(target.get_n_actions, 0) or 0))
    if args.action_index < 0 or args.action_index >= action_count:
        raise ValueError("Accessibility action index is no longer available.")
    action_name = str(safe(lambda: target.get_action_name(args.action_index), "") or "")
    try:
        outcome = target.do_action(args.action_index)
        performed = outcome is not False
    except Exception as error:
        # Some actions (notably close/dismiss) destroy the accessible peer before
        # AT-SPI can deliver the method reply. Re-resolve the guarded target: if
        # it vanished or no longer matches, the requested semantic transition
        # completed; if it still exists unchanged, preserve the failure.
        try:
            refreshed = resolve_action_target(args.node_id)
            refreshed_role = str(safe(refreshed.get_role_name, "unknown") or "unknown")
            refreshed_name = str(safe(refreshed.get_name, "") or "")
            refreshed_accessible_id = str(safe(refreshed.get_accessible_id, "") or "")
            still_matches = (
                refreshed_role == args.expected_role
                and refreshed_name == args.expected_name
                and (args.expected_accessible_id is None or refreshed_accessible_id == args.expected_accessible_id)
            )
        except ValueError:
            still_matches = False
        if still_matches:
            raise ValueError(f"Accessibility action failed: {error}") from error
        performed = True
    return {
        "performed": performed,
        "nodeId": args.node_id,
        "actionIndex": args.action_index,
        "actionName": action_name,
        "performedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def main():
    parser = argparse.ArgumentParser(description="DevSpace bounded AT-SPI accessibility helper")
    subparsers = parser.add_subparsers(dest="command", required=True)
    snap = subparsers.add_parser("snapshot")
    snap.add_argument("--application")
    snap.add_argument("--max-depth", type=int, default=4)
    snap.add_argument("--max-nodes", type=int, default=200)
    action = subparsers.add_parser("action")
    action.add_argument("--node-id", required=True)
    action.add_argument("--action-index", type=int, required=True)
    action.add_argument("--expected-role", required=True)
    action.add_argument("--expected-name", required=True)
    action.add_argument("--expected-accessible-id")
    subparsers.add_parser("focus-monitor")
    args = parser.parse_args()

    if args.command == "snapshot":
        if args.max_depth < 0 or args.max_depth > 8:
            parser.error("--max-depth must be between 0 and 8")
        if args.max_nodes < 1 or args.max_nodes > 500:
            parser.error("--max-nodes must be between 1 and 500")
        print(json.dumps(snapshot(args), separators=(",", ":"), ensure_ascii=False))
        return 0
    if args.command == "action":
        try:
            result = perform_action(args)
        except ValueError as error:
            print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
            return 3
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
        return 0
    if args.command == "focus-monitor":
        focus_monitor()
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
