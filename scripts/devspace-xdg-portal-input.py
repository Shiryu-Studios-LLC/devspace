#!/usr/bin/env python3
"""Portal-authorized physical desktop input for DevSpace on Linux/Wayland."""

from __future__ import annotations

import importlib.util
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any

import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib


_PORTAL_APP_ID = "org.shiryustudios.DevSpace.ComputerUse"


def _load_base_helper() -> Any:
    candidates = [
        Path(__file__).with_name("devspace-eis-input-helper.py"),
        Path(__file__).resolve().parent.parent / "dist" / "bin" / "devspace-eis-input-helper.py",
    ]
    helper_path = next((path for path in candidates if path.is_file()), None)
    if helper_path is None:
        raise RuntimeError("DevSpace's base EIS input helper is missing.")
    spec = importlib.util.spec_from_file_location("devspace_eis_input_helper", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load DevSpace's base EIS input helper.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_base = _load_base_helper()


def _token_path() -> Path:
    configured_state = os.environ.get("DEVSPACE_STATE_DIR")
    if configured_state:
        root = Path(configured_state)
    else:
        state_home = os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))
        root = Path(state_home) / "devspace"
    return root / "computer-use" / "xdg-portal-restore-token"


def _read_restore_token() -> str | None:
    path = _token_path()
    try:
        if path.stat().st_mode & 0o077:
            os.chmod(path, 0o600)
        token = path.read_text(encoding="utf-8").strip()
        return token or None
    except FileNotFoundError:
        return None


def _write_restore_token(token: str | None) -> None:
    path = _token_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    if not token:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


class PortalEisPointer(_base.KWinEisPointer):
    def __init__(self) -> None:
        DBusGMainLoop(set_as_default=True)
        self._portal_session: str | None = None
        self._portal_bus = dbus.SessionBus()
        registry = dbus.Interface(
            self._portal_bus.get_object(
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
            ),
            "org.freedesktop.host.portal.Registry",
        )
        try:
            # Unsandboxed clients must identify themselves on this D-Bus
            # connection before making any portal request. This lets KDE show
            # the registered application name in its consent dialog.
            registry.Register(
                dbus.String(_PORTAL_APP_ID),
                dbus.Dictionary({}, signature="sv"),
            )
        except dbus.DBusException as exc:
            raise RuntimeError(
                "Could not register DevSpace with KDE's host portal; refusing "
                "to request unidentified physical desktop access."
            ) from exc
        self._remote = dbus.Interface(
            self._portal_bus.get_object(
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
            ),
            "org.freedesktop.portal.RemoteDesktop",
        )
        super().__init__()

    def _request(self, method: Any, *args: Any) -> dict[str, Any]:
        loop = GLib.MainLoop()
        state: dict[str, Any] = {}
        signal_match: Any = None

        def fail(error: Exception) -> None:
            state["error"] = error
            loop.quit()

        def receive_request_path(path: str) -> None:
            def receive_response(response: int, results: dict[str, Any]) -> None:
                state["response"] = int(response)
                state["results"] = results
                loop.quit()

            nonlocal signal_match
            signal_match = self._portal_bus.add_signal_receiver(
                receive_response,
                signal_name="Response",
                dbus_interface="org.freedesktop.portal.Request",
                path=str(path),
            )

        try:
            method(*args, reply_handler=receive_request_path, error_handler=fail)
            GLib.timeout_add_seconds(120, lambda: (fail(TimeoutError("Timed out waiting for KDE's desktop permission dialog.")), False)[1])
            loop.run()
        finally:
            if signal_match is not None:
                signal_match.remove()
        if "error" in state:
            raise RuntimeError(f"KDE desktop permission request failed: {state['error']}")
        if state.get("response") != 0:
            raise RuntimeError(
                "KDE physical desktop permission was denied or canceled "
                f"(portal response {state.get('response')}); no input was sent."
            )
        return dict(state.get("results", {}))

    def _connect(self) -> None:
        session_options = dbus.Dictionary(
            {"handle_token": secrets.token_hex(8), "session_handle_token": secrets.token_hex(8)},
            signature="sv",
        )
        created = self._request(self._remote.CreateSession, session_options)
        session = created.get("session_handle")
        if not session:
            raise RuntimeError("KDE did not return a RemoteDesktop session handle.")
        self._portal_session = str(session)

        selection: dict[str, Any] = {
            "handle_token": secrets.token_hex(8),
            "types": dbus.UInt32(3),  # keyboard and pointer
            "persist_mode": dbus.UInt32(2),  # persist until explicitly revoked
        }
        restore_token = _read_restore_token()
        if restore_token:
            selection["restore_token"] = dbus.String(restore_token)
        self._request(
            self._remote.SelectDevices,
            dbus.ObjectPath(self._portal_session),
            dbus.Dictionary(selection, signature="sv"),
        )

        started = self._request(
            self._remote.Start,
            dbus.ObjectPath(self._portal_session),
            dbus.String(""),
            dbus.Dictionary({"handle_token": secrets.token_hex(8)}, signature="sv"),
        )
        devices = int(started.get("devices", 0))
        if devices & 3 != 3:
            raise RuntimeError("KDE did not grant both pointer and keyboard access.")
        _write_restore_token(str(started["restore_token"]) if started.get("restore_token") else None)

        fd_handle = self._remote.ConnectToEIS(
            dbus.ObjectPath(self._portal_session),
            dbus.Dictionary({}, signature="sv"),
        )
        fd = fd_handle.take()
        caps = (
            _base._EI_CAP_POINTER
            | _base._EI_CAP_POINTER_ABSOLUTE
            | _base._EI_CAP_BUTTON
            | _base._EI_CAP_SCROLL
            | _base._EI_CAP_KEYBOARD
            | _base._EI_CAP_TEXT
        )
        self._ei = _base._LIBEI.ei_new_sender(None)
        if not self._ei:
            raise RuntimeError("failed to create libei sender for the XDG RemoteDesktop portal")
        _base._LIBEI.ei_configure_name(self._ei, b"devspace-physical-desktop")
        rc = _base._LIBEI.ei_setup_backend_fd(self._ei, fd)
        if rc != 0:
            raise RuntimeError(f"ei_setup_backend_fd failed: {rc}")
        self._negotiate()

    def close(self) -> None:
        try:
            super().close()
        finally:
            session = self._portal_session
            self._portal_session = None
            if session:
                try:
                    dbus.Interface(
                        self._portal_bus.get_object("org.freedesktop.portal.Desktop", session),
                        "org.freedesktop.portal.Session",
                    ).Close()
                except dbus.DBusException:
                    pass


def main(argv: list[str]) -> int:
    _base.KWinEisPointer = PortalEisPointer
    return _base.main([argv[0], *argv[1:]])


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except Exception as exc:
        print(f"DevSpace XDG RemoteDesktop input failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
