#!/usr/bin/env python3
"""Minimal KWin EIS helper for compositor-native absolute pointer motion."""

from __future__ import annotations

import ctypes
import json
import select
import sys
import time

import dbus

_EI_CAP_POINTER = 1 << 0
_EI_CAP_POINTER_ABSOLUTE = 1 << 1
_EI_CAP_KEYBOARD = 1 << 2
_EI_CAP_SCROLL = 1 << 4
_EI_CAP_BUTTON = 1 << 5
_EI_CAP_TEXT = 1 << 6
_EI_EVENT_DISCONNECT = 2
_EI_EVENT_SEAT_ADDED = 3
_EI_EVENT_DEVICE_ADDED = 5
_EI_EVENT_PONG = 90

_BUTTON_CODES = {
    "left": 0x110,
    "right": 0x111,
    "middle": 0x112,
}

_MODIFIER_CODES = {
    "ctrl": 29,
    "shift": 42,
    "alt": 56,
    "meta": 125,
}

_KEY_CODES = {
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
    "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38,
    "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
    "enter": 28, "escape": 1, "tab": 15, "backspace": 14, "space": 57,
    "delete": 111, "insert": 110, "left": 105, "right": 106, "up": 103, "down": 108,
    "home": 102, "end": 107, "pageup": 104, "pagedown": 109,
    "f1": 59, "f2": 60, "f3": 61, "f4": 62, "f5": 63, "f6": 64,
    "f7": 65, "f8": 66, "f9": 67, "f10": 68, "f11": 87, "f12": 88,
}
# Linux number-row scancodes are 2..11 where 1 maps to 2 and 0 maps to 11.
_KEY_CODES.update({"1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11})

# US-layout keycode fallback used when KWin exposes a keyboard EIS device but
# not libei's optional text capability. This keeps typing compositor-scoped
# instead of falling back to host ydotool and accidentally targeting the user's
# physical desktop.
_ASCII_KEY_CODES = {
    "-": (12, False), "_": (12, True),
    "=": (13, False), "+": (13, True),
    "[": (26, False), "{": (26, True),
    "]": (27, False), "}": (27, True),
    ";": (39, False), ":": (39, True),
    "'": (40, False), '"': (40, True),
    "`": (41, False), "~": (41, True),
    "\\": (43, False), "|": (43, True),
    ",": (51, False), "<": (51, True),
    ".": (52, False), ">": (52, True),
    "/": (53, False), "?": (53, True),
    " ": (57, False), "\t": (15, False), "\n": (28, False), "\r": (28, False),
}
for _digit, _code in {"1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11}.items():
    _ASCII_KEY_CODES[_digit] = (_code, False)
for _symbol, _digit in zip("!@#$%^&*()", "1234567890"):
    _ASCII_KEY_CODES[_symbol] = (_ASCII_KEY_CODES[_digit][0], True)
for _letter, _code in {key: value for key, value in _KEY_CODES.items() if len(key) == 1 and key.isalpha()}.items():
    _ASCII_KEY_CODES[_letter] = (_code, False)
    _ASCII_KEY_CODES[_letter.upper()] = (_code, True)


def _load_libei() -> ctypes.CDLL:
    lib = ctypes.CDLL("libei.so.1")
    lib.ei_new_sender.restype = ctypes.c_void_p
    lib.ei_new_sender.argtypes = [ctypes.c_void_p]
    lib.ei_configure_name.restype = None
    lib.ei_configure_name.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.ei_setup_backend_fd.restype = ctypes.c_int
    lib.ei_setup_backend_fd.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.ei_dispatch.restype = ctypes.c_int
    lib.ei_dispatch.argtypes = [ctypes.c_void_p]
    lib.ei_now.restype = ctypes.c_uint64
    lib.ei_now.argtypes = [ctypes.c_void_p]
    lib.ei_new_ping.restype = ctypes.c_void_p
    lib.ei_new_ping.argtypes = [ctypes.c_void_p]
    lib.ei_ping.restype = None
    lib.ei_ping.argtypes = [ctypes.c_void_p]
    lib.ei_ping_unref.restype = ctypes.c_void_p
    lib.ei_ping_unref.argtypes = [ctypes.c_void_p]
    lib.ei_event_pong_get_ping.restype = ctypes.c_void_p
    lib.ei_event_pong_get_ping.argtypes = [ctypes.c_void_p]
    lib.ei_get_event.restype = ctypes.c_void_p
    lib.ei_get_event.argtypes = [ctypes.c_void_p]
    lib.ei_event_get_type.restype = ctypes.c_int
    lib.ei_event_get_type.argtypes = [ctypes.c_void_p]
    lib.ei_event_unref.restype = ctypes.c_void_p
    lib.ei_event_unref.argtypes = [ctypes.c_void_p]
    lib.ei_unref.restype = ctypes.c_void_p
    lib.ei_unref.argtypes = [ctypes.c_void_p]
    lib.ei_get_fd.restype = ctypes.c_int
    lib.ei_get_fd.argtypes = [ctypes.c_void_p]
    lib.ei_event_get_seat.restype = ctypes.c_void_p
    lib.ei_event_get_seat.argtypes = [ctypes.c_void_p]
    lib.ei_seat_has_capability.restype = ctypes.c_int
    lib.ei_seat_has_capability.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    lib.ei_seat_bind_capabilities.restype = None
    # Variadic function: only describe the fixed argument. Setting argtypes for
    # the variadic arguments can crash on newer Python/ctypes combinations.
    lib.ei_seat_bind_capabilities.argtypes = [ctypes.c_void_p]
    lib.ei_event_get_device.restype = ctypes.c_void_p
    lib.ei_event_get_device.argtypes = [ctypes.c_void_p]
    lib.ei_device_has_capability.restype = ctypes.c_int
    lib.ei_device_has_capability.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    lib.ei_device_ref.restype = ctypes.c_void_p
    lib.ei_device_ref.argtypes = [ctypes.c_void_p]
    lib.ei_device_unref.restype = ctypes.c_void_p
    lib.ei_device_unref.argtypes = [ctypes.c_void_p]
    lib.ei_device_start_emulating.restype = None
    lib.ei_device_start_emulating.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    lib.ei_device_stop_emulating.restype = None
    lib.ei_device_stop_emulating.argtypes = [ctypes.c_void_p]
    lib.ei_device_pointer_motion.restype = None
    lib.ei_device_pointer_motion.argtypes = [
        ctypes.c_void_p,
        ctypes.c_double,
        ctypes.c_double,
    ]
    lib.ei_device_pointer_motion_absolute.restype = None
    lib.ei_device_pointer_motion_absolute.argtypes = [
        ctypes.c_void_p,
        ctypes.c_double,
        ctypes.c_double,
    ]
    lib.ei_device_button_button.restype = None
    lib.ei_device_button_button.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
    ]
    lib.ei_device_scroll_discrete.restype = None
    lib.ei_device_scroll_discrete.argtypes = [ctypes.c_void_p, ctypes.c_int32, ctypes.c_int32]
    lib.ei_device_scroll_stop.restype = None
    lib.ei_device_scroll_stop.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lib.ei_device_keyboard_key.restype = None
    lib.ei_device_keyboard_key.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int]
    lib.ei_device_text_utf8.restype = None
    lib.ei_device_text_utf8.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.ei_device_get_region.restype = ctypes.c_void_p
    lib.ei_device_get_region.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    lib.ei_region_get_x.restype = ctypes.c_int32
    lib.ei_region_get_x.argtypes = [ctypes.c_void_p]
    lib.ei_region_get_y.restype = ctypes.c_int32
    lib.ei_region_get_y.argtypes = [ctypes.c_void_p]
    lib.ei_region_get_width.restype = ctypes.c_uint32
    lib.ei_region_get_width.argtypes = [ctypes.c_void_p]
    lib.ei_region_get_height.restype = ctypes.c_uint32
    lib.ei_region_get_height.argtypes = [ctypes.c_void_p]
    lib.ei_region_get_physical_scale.restype = ctypes.c_double
    lib.ei_region_get_physical_scale.argtypes = [ctypes.c_void_p]
    lib.ei_device_frame.restype = None
    lib.ei_device_frame.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
    return lib


_LIBEI = _load_libei()


class KWinEisPointer:
    def __init__(self) -> None:
        self._bus = dbus.SessionBus()
        self._iface = dbus.Interface(
            self._bus.get_object("org.kde.KWin", "/org/kde/KWin/EIS/RemoteDesktop"),
            "org.kde.KWin.EIS.RemoteDesktop",
        )
        self._cookie = 0
        self._ei = 0
        self._pointer_device = 0
        self._keyboard_device = 0
        self._scroll_device = 0
        self._text_device = 0
        self._devices: dict[int, int] = {}
        self._connect()

    def _connect(self) -> None:
        caps = (
            _EI_CAP_POINTER
            | _EI_CAP_POINTER_ABSOLUTE
            | _EI_CAP_BUTTON
            | _EI_CAP_SCROLL
            | _EI_CAP_KEYBOARD
            | _EI_CAP_TEXT
        )
        result = self._iface.connectToEIS(dbus.Int32(caps))
        fd = result[0].take()
        self._cookie = int(result[1])

        self._ei = _LIBEI.ei_new_sender(None)
        if not self._ei:
            raise RuntimeError("failed to create libei sender")
        _LIBEI.ei_configure_name(self._ei, b"devspace-desktop-input")
        rc = _LIBEI.ei_setup_backend_fd(self._ei, fd)
        if rc != 0:
            raise RuntimeError(f"ei_setup_backend_fd failed: {rc}")
        self._negotiate()

    def _negotiate(self, timeout: float = 3.0) -> None:
        fd = _LIBEI.ei_get_fd(self._ei)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable and _LIBEI.ei_dispatch(self._ei) < 0:
                break

            while True:
                event = _LIBEI.ei_get_event(self._ei)
                if not event:
                    break
                try:
                    event_type = _LIBEI.ei_event_get_type(event)
                    if event_type == _EI_EVENT_DISCONNECT:
                        raise RuntimeError("KWin EIS disconnected during handshake")
                    if event_type == _EI_EVENT_SEAT_ADDED:
                        self._bind_seat(event)
                    elif event_type == _EI_EVENT_DEVICE_ADDED:
                        device = _LIBEI.ei_event_get_device(event)
                        self._remember_device(device)
                finally:
                    _LIBEI.ei_event_unref(event)

            if self._pointer_device and self._keyboard_device and self._scroll_device:
                for device in self._devices.values():
                    _LIBEI.ei_device_start_emulating(device, 0)
                self._sync()
                return

        missing = []
        if not self._pointer_device:
            missing.append("absolute pointer")
        if not self._keyboard_device:
            missing.append("keyboard")
        if not self._scroll_device:
            missing.append("scroll")
        raise RuntimeError("KWin EIS did not provide required input devices: " + ", ".join(missing))

    def _remember_device(self, device: int) -> None:
        capabilities = {
            "pointer": _EI_CAP_POINTER_ABSOLUTE,
            "keyboard": _EI_CAP_KEYBOARD,
            "scroll": _EI_CAP_SCROLL,
            "text": _EI_CAP_TEXT,
        }
        matched = {
            name: bool(_LIBEI.ei_device_has_capability(device, capability))
            for name, capability in capabilities.items()
        }
        if not any(matched.values()):
            return
        key = int(device)
        retained = self._devices.get(key)
        if not retained:
            retained = _LIBEI.ei_device_ref(device)
            self._devices[key] = retained
        if matched["pointer"] and not self._pointer_device:
            self._pointer_device = retained
        if matched["keyboard"] and not self._keyboard_device:
            self._keyboard_device = retained
        if matched["scroll"] and not self._scroll_device:
            self._scroll_device = retained
        if matched["text"] and not self._text_device:
            self._text_device = retained

    @staticmethod
    def _bind_capabilities(seat: int, capabilities: list[int]) -> None:
        args: list[ctypes.c_uint | ctypes.c_void_p] = [
            ctypes.c_uint(capability) for capability in capabilities
        ]
        args.append(ctypes.c_void_p(None))
        _LIBEI.ei_seat_bind_capabilities(seat, *args)

    def _bind_seat(self, event: int) -> None:
        seat = _LIBEI.ei_event_get_seat(event)
        available = [
            capability
            for capability in (
                _EI_CAP_POINTER,
                _EI_CAP_POINTER_ABSOLUTE,
                _EI_CAP_BUTTON,
                _EI_CAP_SCROLL,
                _EI_CAP_KEYBOARD,
                _EI_CAP_TEXT,
            )
            if _LIBEI.ei_seat_has_capability(seat, capability)
        ]
        if available:
            self._bind_capabilities(seat, available)

    def _frame(self, device: int) -> None:
        _LIBEI.ei_device_frame(device, _LIBEI.ei_now(self._ei))
        self._sync()

    def _sync(self, timeout: float = 1.0) -> None:
        """Wait until KWin has processed all EIS requests sent before this call."""
        ping = _LIBEI.ei_new_ping(self._ei)
        if not ping:
            raise RuntimeError("failed to create EIS synchronization ping")
        try:
            _LIBEI.ei_ping(ping)
            fd = _LIBEI.ei_get_fd(self._ei)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                readable, _, _ = select.select([fd], [], [], min(0.1, deadline - time.monotonic()))
                if not readable:
                    continue
                if _LIBEI.ei_dispatch(self._ei) < 0:
                    raise RuntimeError("KWin EIS disconnected while synchronizing input")
                while True:
                    event = _LIBEI.ei_get_event(self._ei)
                    if not event:
                        break
                    try:
                        event_type = _LIBEI.ei_event_get_type(event)
                        if event_type == _EI_EVENT_DISCONNECT:
                            raise RuntimeError("KWin EIS disconnected while synchronizing input")
                        if (
                            event_type == _EI_EVENT_PONG
                            and _LIBEI.ei_event_pong_get_ping(event) == ping
                        ):
                            return
                    finally:
                        _LIBEI.ei_event_unref(event)
            raise RuntimeError("timed out waiting for KWin to process EIS input")
        finally:
            _LIBEI.ei_ping_unref(ping)

    def move_absolute(self, x: float, y: float) -> None:
        _LIBEI.ei_device_pointer_motion_absolute(self._pointer_device, x, y)
        self._frame(self._pointer_device)

    def move_relative(self, x: float, y: float) -> None:
        _LIBEI.ei_device_pointer_motion(self._pointer_device, x, y)
        self._frame(self._pointer_device)

    def click(self, button: str, count: int = 1, delay_ms: int = 50) -> None:
        code = _BUTTON_CODES.get(button)
        if code is None:
            raise ValueError(f"unsupported button: {button}")
        if not 1 <= count <= 10:
            raise ValueError("click count must be between 1 and 10")
        if not 0 <= delay_ms <= 1000:
            raise ValueError("click delay must be between 0 and 1000 ms")
        for index in range(count):
            _LIBEI.ei_device_button_button(self._pointer_device, code, 1)
            self._frame(self._pointer_device)
            time.sleep(0.01)
            _LIBEI.ei_device_button_button(self._pointer_device, code, 0)
            self._frame(self._pointer_device)
            if index + 1 < count and delay_ms:
                time.sleep(delay_ms / 1000.0)

    def scroll(self, x: int, y: int) -> None:
        if not -120 <= x <= 120 or not -120 <= y <= 120:
            raise ValueError("scroll values must be between -120 and 120")
        _LIBEI.ei_device_scroll_discrete(self._scroll_device, x, y)
        _LIBEI.ei_device_scroll_stop(self._scroll_device, int(x != 0), int(y != 0))
        self._frame(self._scroll_device)

    def key_chord(self, key: str, modifiers: list[str], delay_ms: int = 20) -> None:
        code = _KEY_CODES.get(key.lower())
        if code is None:
            raise ValueError(f"unsupported key: {key}")
        if not 0 <= delay_ms <= 1000:
            raise ValueError("key delay must be between 0 and 1000 ms")
        modifier_codes: list[int] = []
        for modifier in dict.fromkeys(modifiers):
            modifier_code = _MODIFIER_CODES.get(modifier.lower())
            if modifier_code is None:
                raise ValueError(f"unsupported modifier: {modifier}")
            modifier_codes.append(modifier_code)
        for modifier_code in modifier_codes:
            _LIBEI.ei_device_keyboard_key(self._keyboard_device, modifier_code, 1)
        _LIBEI.ei_device_keyboard_key(self._keyboard_device, code, 1)
        self._frame(self._keyboard_device)
        if delay_ms:
            time.sleep(delay_ms / 1000.0)
        _LIBEI.ei_device_keyboard_key(self._keyboard_device, code, 0)
        for modifier_code in reversed(modifier_codes):
            _LIBEI.ei_device_keyboard_key(self._keyboard_device, modifier_code, 0)
        self._frame(self._keyboard_device)

    def type_text(self, text: str, key_delay_ms: int = 20) -> None:
        if len(text) > 16384:
            raise ValueError("text must be at most 16384 characters")
        if not 0 <= key_delay_ms <= 1000:
            raise ValueError("key delay must be between 0 and 1000 ms")
        if self._text_device:
            if key_delay_ms == 0:
                _LIBEI.ei_device_text_utf8(self._text_device, text.encode("utf-8"))
                self._frame(self._text_device)
                return
            for character in text:
                _LIBEI.ei_device_text_utf8(self._text_device, character.encode("utf-8"))
                self._frame(self._text_device)
                time.sleep(key_delay_ms / 1000.0)
            return

        if not self._keyboard_device:
            raise RuntimeError("KWin EIS text and keyboard input capabilities are unavailable")
        for character in text:
            mapping = _ASCII_KEY_CODES.get(character)
            if mapping is None:
                raise RuntimeError(
                    f"KWin EIS text capability is unavailable and character {character!r} cannot be synthesized safely"
                )
            code, shifted = mapping
            if shifted:
                _LIBEI.ei_device_keyboard_key(self._keyboard_device, _MODIFIER_CODES["shift"], 1)
            _LIBEI.ei_device_keyboard_key(self._keyboard_device, code, 1)
            self._frame(self._keyboard_device)
            _LIBEI.ei_device_keyboard_key(self._keyboard_device, code, 0)
            if shifted:
                _LIBEI.ei_device_keyboard_key(self._keyboard_device, _MODIFIER_CODES["shift"], 0)
            self._frame(self._keyboard_device)
            if key_delay_ms:
                time.sleep(key_delay_ms / 1000.0)

    def regions(self) -> list[tuple[int, int, int, int, float]]:
        values: list[tuple[int, int, int, int, float]] = []
        index = 0
        while True:
            region = _LIBEI.ei_device_get_region(self._pointer_device, index)
            if not region:
                break
            values.append(
                (
                    int(_LIBEI.ei_region_get_x(region)),
                    int(_LIBEI.ei_region_get_y(region)),
                    int(_LIBEI.ei_region_get_width(region)),
                    int(_LIBEI.ei_region_get_height(region)),
                    float(_LIBEI.ei_region_get_physical_scale(region)),
                )
            )
            index += 1
        return values

    def close(self) -> None:
        for device in list(self._devices.values()):
            _LIBEI.ei_device_stop_emulating(device)
        if self._devices:
            try:
                self._sync()
            except RuntimeError:
                pass
        for device in list(self._devices.values()):
            _LIBEI.ei_device_unref(device)
        self._devices.clear()
        self._pointer_device = 0
        self._keyboard_device = 0
        self._scroll_device = 0
        self._text_device = 0
        # Drop the libei client while the KWin endpoint is still valid. If the
        # D-Bus cookie is disconnected first, libei may try to finish protocol
        # teardown on a socket KWin has already closed and log EPIPE.
        if self._ei:
            _LIBEI.ei_unref(self._ei)
            self._ei = 0
        if self._cookie:
            try:
                self._iface.disconnect(dbus.Int32(self._cookie))
            except dbus.DBusException:
                pass
            self._cookie = 0

    def __enter__(self) -> "KWinEisPointer":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()


def _parse_coordinate(value: str) -> float:
    coordinate = float(value)
    if not 0 <= coordinate <= 100_000:
        raise ValueError("coordinate must be between 0 and 100000")
    return coordinate


def _serve() -> int:
    with KWinEisPointer() as pointer:
        print(json.dumps({"ready": True, "regions": pointer.regions()}), flush=True)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            request_id = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                command = request.get("command")
                if command == "move-absolute":
                    pointer.move_absolute(
                        _parse_coordinate(str(request["x"])),
                        _parse_coordinate(str(request["y"])),
                    )
                elif command == "move-relative":
                    x = int(request["x"])
                    y = int(request["y"])
                    if not -32768 <= x <= 32768 or not -32768 <= y <= 32768:
                        raise ValueError("relative coordinates must be between -32768 and 32768")
                    pointer.move_relative(float(x), float(y))
                elif command == "click":
                    pointer.click(
                        str(request["button"]).lower(),
                        int(request.get("count", 1)),
                        int(request.get("nextDelayMs", 50)),
                    )
                elif command == "scroll":
                    pointer.scroll(int(request.get("x", 0)), int(request["y"]))
                elif command == "type-text":
                    pointer.type_text(
                        str(request.get("text", "")),
                        int(request.get("keyDelayMs", 20)),
                    )
                elif command == "key-chord":
                    modifiers = request.get("modifiers", [])
                    if not isinstance(modifiers, list) or not all(isinstance(value, str) for value in modifiers):
                        raise ValueError("modifiers must be a list of strings")
                    pointer.key_chord(
                        str(request["key"]),
                        modifiers,
                        int(request.get("keyDelayMs", 20)),
                    )
                elif command == "regions":
                    pass
                else:
                    raise ValueError(f"unsupported command: {command}")
                response = {
                    "id": request_id,
                    "ok": True,
                    **({"regions": pointer.regions()} if command == "regions" else {}),
                }
            except Exception as exc:
                response = {"id": request_id, "ok": False, "error": str(exc)}
            print(json.dumps(response), flush=True)
    return 0


def main(argv: list[str]) -> int:
    try:
        command = argv[1] if len(argv) > 1 else ""
        if command == "serve" and len(argv) == 2:
            return _serve()

        if command == "move-absolute" and len(argv) == 4:
            x = _parse_coordinate(argv[2])
            y = _parse_coordinate(argv[3])
            with KWinEisPointer() as pointer:
                pointer.move_absolute(x, y)
            return 0

        if command == "click-absolute" and len(argv) in (5, 6):
            x = _parse_coordinate(argv[2])
            y = _parse_coordinate(argv[3])
            button = argv[4].lower()
            count = int(argv[5]) if len(argv) == 6 else 1
            with KWinEisPointer() as pointer:
                pointer.move_absolute(x, y)
                pointer.click(button, count)
            return 0

        if command == "regions" and len(argv) == 2:
            with KWinEisPointer() as pointer:
                for x, y, width, height, scale in pointer.regions():
                    print(f"{x} {y} {width} {height} {scale:g}")
            return 0

        print(
            "usage: devspace-eis-input-helper.py "
            "{serve|move-absolute <x> <y>|click-absolute <x> <y> <button> [count]|regions}",
            file=sys.stderr,
        )
        return 2
    except Exception as exc:
        print(f"devspace EIS input failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
