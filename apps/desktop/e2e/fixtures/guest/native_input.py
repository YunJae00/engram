import ctypes as c
import os
import queue
import subprocess
import sys
import time


_x11 = None
_xtst = None


class XErrorEvent(c.Structure):
    _fields_ = [("type", c.c_int), ("display", c.c_void_p), ("resourceid", c.c_ulong),
                ("serial", c.c_ulong), ("error_code", c.c_ubyte),
                ("request_code", c.c_ubyte), ("minor_code", c.c_ubyte)]


ERROR_HANDLER = c.CFUNCTYPE(c.c_int, c.c_void_p, c.POINTER(XErrorEvent))


def initialize_native_input():
    global _x11, _xtst
    if sys.platform != "linux" or os.environ.get("DISPLAY") != ":0":
        raise RuntimeError("Native input requires the dedicated guest display")
    if _x11 is not None:
        return
    x11, xtst = c.CDLL("libX11.so.6"), c.CDLL("libXtst.so.6")
    integer, display, keysyms = c.c_int, c.c_void_p, c.POINTER(c.c_ulong)
    signatures = {
        "XInitThreads": (integer, []), "XOpenDisplay": (display, [c.c_char_p]),
        "XCloseDisplay": (integer, [display]), "XSync": (integer, [display, integer]),
        "XDisplayKeycodes": (integer, [display, c.POINTER(integer), c.POINTER(integer)]),
        "XGetKeyboardMapping": (keysyms, [display, c.c_ubyte, integer, c.POINTER(integer)]),
        "XChangeKeyboardMapping": (integer, [display, integer, integer, keysyms, integer]),
        "XQueryKeymap": (integer, [display, c.POINTER(c.c_ubyte)]),
        "XFree": (integer, [display]), "XSetErrorHandler": (display, [display]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(x11, name)
        function.restype, function.argtypes = result, arguments
    xtst.XTestQueryExtension.restype = integer
    xtst.XTestQueryExtension.argtypes = [display] + [c.POINTER(integer)] * 4
    xtst.XTestFakeKeyEvent.restype = integer
    xtst.XTestFakeKeyEvent.argtypes = [display, c.c_uint, integer, c.c_ulong]
    if not x11.XInitThreads():
        raise RuntimeError("Native display threading is unavailable")
    _x11, _xtst = x11, xtst


class NativeKeyboard:
    def __enter__(self):
        if _x11 is None or sys.platform != "linux" or os.environ.get("DISPLAY") != ":0":
            raise RuntimeError("Guest native input was not initialized")
        self.display = _x11.XOpenDisplay(b":0")
        if not self.display:
            raise RuntimeError("Dedicated guest display could not be opened")
        self.errors, self.changed, self.down, self.previous = [], False, False, None
        self.handler = ERROR_HANDLER(self.handle_error)
        self.previous = _x11.XSetErrorHandler(c.cast(self.handler, c.c_void_p))
        try:
            versions = [c.c_int() for _ in range(4)]
            if not _xtst.XTestQueryExtension(self.display, *(c.byref(value) for value in versions)):
                raise RuntimeError("Guest native key injection is unavailable")
            low, high, slots = c.c_int(), c.c_int(), c.c_int()
            _x11.XDisplayKeycodes(self.display, c.byref(low), c.byref(high))
            self.sync()
            if not 8 <= low.value <= high.value <= 255:
                raise RuntimeError("Invalid guest keycode range")
            mapping = _x11.XGetKeyboardMapping(self.display, low.value, high.value - low.value + 1, c.byref(slots))
            if not mapping:
                raise RuntimeError("Guest key mapping could not be read")
            try:
                if not 1 <= slots.value <= 64:
                    raise RuntimeError("Invalid guest key mapping width")
                held = (c.c_ubyte * 32)()
                if not _x11.XQueryKeymap(self.display, held):
                    raise RuntimeError("Guest held keys could not be read")
                self.sync()
                for code in range(low.value, high.value + 1):
                    original = [mapping[(code - low.value) * slots.value + slot] for slot in range(slots.value)]
                    if not any(original) and not held[code // 8] & (1 << (code % 8)):
                        self.code, self.slots = code, slots.value
                        self.original = (c.c_ulong * self.slots)(*original)
                        break
                else:
                    raise RuntimeError("No unused guest keycode is available")
            finally:
                _x11.XFree(mapping)
        except Exception:
            self.__exit__(None, None, None)
            raise
        return self

    def handle_error(self, display, event):
        if display == self.display:
            self.errors.append(event.contents.error_code)
            return 0
        return ERROR_HANDLER(self.previous)(display, event) if self.previous else 0

    def sync(self):
        _x11.XSync(self.display, 0)
        if self.errors:
            raise RuntimeError("Guest X11 request failed (%d)" % self.errors[-1])

    def send(self, character):
        if self.changed:
            raise RuntimeError("Previous native key mapping was not restored")
        codepoint = ord(character)
        symbol = codepoint if codepoint <= 255 else 0x01000000 | codepoint
        mapping = (c.c_ulong * self.slots)(symbol, *([0] * (self.slots - 1)))
        self.changed = True
        _x11.XChangeKeyboardMapping(self.display, self.code, self.slots, mapping, 1)
        self.sync()
        self.down = True
        if not _xtst.XTestFakeKeyEvent(self.display, self.code, 1, 0):
            raise RuntimeError("Guest native key press failed")
        self.sync()
        if not _xtst.XTestFakeKeyEvent(self.display, self.code, 0, 0):
            raise RuntimeError("Guest native key release failed")
        self.sync()
        self.down = False

    def restore(self):
        try:
            if self.down:
                released = _xtst.XTestFakeKeyEvent(self.display, self.code, 0, 0)
                self.down = False
                self.sync()
                if not released:
                    raise RuntimeError("Guest native key cleanup failed")
        finally:
            if self.changed:
                _x11.XChangeKeyboardMapping(self.display, self.code, self.slots, self.original, 1)
                self.changed = False
                self.sync()

    def __exit__(self, _kind, _value, _traceback):
        try:
            self.restore()
        finally:
            _x11.XSetErrorHandler(self.previous)
            _x11.XCloseDisplay(self.display)
            self.display = None


def guest_command(arguments, timeout=4):
    environment = os.environ.copy()
    environment["DISPLAY"] = ":0"
    result = subprocess.run(arguments, env=environment, shell=False, check=False,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                            encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError("Guest display command failed")
    if len(result.stdout) > 16384:
        raise RuntimeError("Guest display response exceeded its limit")
    return result.stdout


class NativeInputError(RuntimeError):
    def __init__(self, diagnostic):
        super().__init__("Native typing was not confirmed")
        self.diagnostic = diagnostic


def type_text(fixture, text):
    deadline = time.monotonic() + 12
    def ui(action):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Native typing deadline exceeded")
        return fixture.call(action, timeout=min(1, remaining))
    state = ui(fixture.state)
    confirmed = 0
    try:
        with NativeKeyboard() as keyboard:
            for character in text:
                if not state["entryFocused"] or time.monotonic() >= deadline:
                    raise RuntimeError("Input focus changed or typing timed out")
                start, end = state["entrySelection"] or [state["entryCursor"]] * 2
                before, keys_before = state["text"], state["keyEvents"]
                releases_before = state["keyReleaseEvents"]
                expected = before[:start] + character + before[end:]
                try:
                    keyboard.send(character)
                    key_deadline = min(deadline, time.monotonic() + 2)
                    while time.monotonic() < key_deadline:
                        state = ui(fixture.state)
                        if not state["entryFocused"]:
                            raise RuntimeError("Input focus changed")
                        if (state["text"] == expected and state["keyEvents"] > keys_before
                                and state["keyReleaseEvents"] > releases_before):
                            confirmed += 1
                            break
                        if state["text"] not in (before, expected):
                            raise RuntimeError("Native input produced unexpected text")
                        time.sleep(0.01)
                    else:
                        raise RuntimeError("Native press, release or text was not observed")
                finally:
                    keyboard.restore()
        ui(lambda: setattr(fixture, "last_type_diagnostic",
                           {"completed": True, "confirmedCodepoints": confirmed}))
    except (RuntimeError, queue.Full, subprocess.SubprocessError, OSError, c.ArgumentError) as error:
        snapshot_fresh = True
        try:
            state = fixture.call(fixture.state, timeout=0.25)
        except (RuntimeError, queue.Full):
            snapshot_fresh = False
        diagnostic = {"completed": False, "confirmedCodepoints": confirmed,
                      "failedCodepoint": "U+%04X" % ord(text[min(confirmed, len(text) - 1)]),
                      "observedText": state["text"][:512], "observedKeyEvents": state["keyEvents"],
                      "observedKeyReleaseEvents": state["keyReleaseEvents"],
                      "snapshotFresh": snapshot_fresh, "observedTextTruncated": len(state["text"]) > 512,
                      "recentKeys": state["recentKeys"], "error": "Native typing was not confirmed"}
        try:
            fixture.call(lambda: setattr(fixture, "last_type_diagnostic", diagnostic), timeout=0.25)
        except (RuntimeError, queue.Full):
            diagnostic["uiUnavailable"] = True
        raise NativeInputError(diagnostic) from error
