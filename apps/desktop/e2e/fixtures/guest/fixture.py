import concurrent.futures
import hmac
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from native_input import NativeInputError, guest_command, initialize_native_input, query_pointer_state, type_text


RESOLUTIONS = {(800, 600), (960, 720), (1024, 768), (1280, 720), (1280, 800)}
OUTPUTS = {"Virtual-1", "Virtual-0", "Virtual1", "VGA-1", "VGA-0", "default"}
MAX_BODY = 1024
TOKEN = os.environ.get("ENGRAM_GUEST_TOKEN", "")
WORKER_ID = os.environ.get("ENGRAM_WORKER_ID", "")[:128]
BOOT_ID = os.environ.get("ENGRAM_BOOT_ID", "")[:128]


class Fixture:
    def __init__(self):
        self.root = tk.Tk()
        self.display_size = {"width": self.root.winfo_screenwidth(), "height": self.root.winfo_screenheight()}
        self.root.title("Engram guest fixture")
        self.root.geometry("760x520+20+20")
        self.root.minsize(400, 300)
        self.requests = queue.Queue(maxsize=16)
        self.closed = False
        self.key_events = 0
        self.key_release_events = 0
        self.recent_keys = []
        self.last_type_diagnostic = None
        self.pointer_events = 0
        self.release_events = 0
        self.motion_events = 0
        self.last_pointer_event = None
        self.click_count = 0
        self.wheel_events = 0
        self.wheel_delta = 0
        self.geometry_events = 0
        self.resize_count = 0
        self.root.configure(background="#f4f6fa")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(4, weight=1)
        tk.Label(self.root, text="Worker: " + (WORKER_ID or "unassigned"),
                 anchor="w", background="#f4f6fa", font=("sans", 16)).grid(
                     row=0, column=0, sticky="ew", padx=20, pady=(16, 4))
        tk.Label(self.root, text="Boot: " + (BOOT_ID or "unassigned"),
                 anchor="w", background="#f4f6fa").grid(
                     row=1, column=0, sticky="ew", padx=20, pady=(0, 12))
        self.entry = tk.Entry(self.root, font=("sans", 14))
        self.entry.grid(row=2, column=0, sticky="ew", padx=20, pady=4)
        actions = tk.Frame(self.root, background="#f4f6fa")
        actions.grid(row=3, column=0, sticky="ew", padx=20, pady=12)
        self.button = tk.Button(actions, text="Confirm input", command=self.clicked)
        self.button.pack(side="left")
        self.resize_button = tk.Button(actions, text="Resize window", command=self.resize_window)
        self.resize_button.pack(side="left", padx=12)
        self.status = tk.Label(actions, text="Clicks: 0", background="#f4f6fa")
        self.status.pack(side="left")
        self.canvas = tk.Canvas(self.root, background="white", highlightthickness=1,
                                highlightbackground="#d9dee8", scrollregion=(0, 0, 600, 2400))
        self.canvas.grid(row=4, column=0, sticky="nsew", padx=20, pady=(0, 20))
        for row in range(60):
            self.canvas.create_text(16, row * 40 + 20, anchor="w",
                                    text="Worker %s / scroll row %02d" % (WORKER_ID, row + 1))
        self.canvas.bind("<Button-4>", lambda event: self.scrolled(event, -1))
        self.canvas.bind("<Button-5>", lambda event: self.scrolled(event, 1))
        self.canvas.bind("<MouseWheel>", self.mouse_wheel)
        self.root.bind_all("<KeyPress>", self.key_pressed, add="+")
        self.root.bind_all("<KeyRelease>", self.key_released, add="+")
        self.root.bind_all("<ButtonPress-1>", self.pointer_pressed, add="+")
        self.root.bind_all("<ButtonRelease-1>", lambda _event: setattr(self, "release_events", self.release_events + 1), add="+")
        self.root.bind_all("<Motion>", self.pointer_moved, add="+")
        self.root.bind("<Configure>", self.configured, add="+")
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(15, self.pump)

    def key_pressed(self, event):
        self.key_events += 1
        self.recent_keys = (self.recent_keys + [{"keycode": event.keycode,
                            "keysym": event.keysym, "char": event.char}])[-16:]

    def pointer_pressed(self, event):
        self.pointer_events += 1
        self.last_pointer_event = {"x": event.x_root, "y": event.y_root, "state": event.state}

    def key_released(self, _event):
        self.key_release_events += 1

    def pointer_moved(self, event):
        self.motion_events += 1
        self.last_pointer_event = {"x": event.x_root, "y": event.y_root, "state": event.state}

    def configured(self, event):
        if event.widget is self.root:
            self.geometry_events += 1

    def clicked(self):
        self.click_count += 1
        self.status.configure(text="Clicks: %d" % self.click_count)

    def mouse_wheel(self, event):
        return self.scrolled(event, -1 if event.delta > 0 else 1)

    def scrolled(self, _event, direction):
        self.wheel_events += 1
        self.wheel_delta += direction
        self.canvas.yview_scroll(direction * 3, "units")
        return "break"

    def resize_window(self):
        self.resize_count += 1
        width = min(self.display_size["width"] - 40, 640 if self.resize_count % 2 else 720)
        height = min(self.display_size["height"] - 60, 420 if self.resize_count % 2 else 480)
        self.root.geometry("%dx%d+20+20" % (width, height))

    def fit_display(self, observed_width, observed_height):
        self.display_size = {"width": observed_width, "height": observed_height}
        self.root.geometry("%dx%d+20+20" % (observed_width - 40, observed_height - 60))

    @staticmethod
    def bounds(widget):
        return {"x": widget.winfo_rootx(), "y": widget.winfo_rooty(),
                "width": widget.winfo_width(), "height": widget.winfo_height()}

    def state(self):
        first, last = self.canvas.yview()
        return {
            "workerId": WORKER_ID, "bootId": BOOT_ID, "pid": os.getpid(),
            "text": self.entry.get(), "keyEvents": self.key_events,
            "keyReleaseEvents": self.key_release_events,
            "entryCursor": self.entry.index("insert"),
            "entrySelection": [self.entry.index("sel.first"), self.entry.index("sel.last")]
            if self.entry.selection_present() else None,
            "recentKeys": self.recent_keys, "lastTypeDiagnostic": self.last_type_diagnostic,
            "pointerEvents": self.pointer_events, "clickCount": self.click_count,
            "releaseEvents": self.release_events,
            "pointer": {"x": self.root.winfo_pointerx(), "y": self.root.winfo_pointery()},
            "motionEvents": self.motion_events, "lastPointerEvent": self.last_pointer_event,
            "wheelEvents": self.wheel_events, "wheelDelta": self.wheel_delta,
            "scrollY": first, "scrollEnd": last, "resizeCount": self.resize_count,
            "geometryEvents": self.geometry_events,
            "entryFocused": self.root.focus_displayof() is self.entry,
            "screen": dict(self.display_size),
            "window": self.bounds(self.root),
            "bounds": {"entry": self.bounds(self.entry), "button": self.bounds(self.button),
                       "canvas": self.bounds(self.canvas), "resize": self.bounds(self.resize_button)},
        }

    def call(self, action, timeout=2):
        if self.closed:
            raise RuntimeError("Guest fixture is closing")
        future = concurrent.futures.Future()
        self.requests.put_nowait((future, action))
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise RuntimeError("Guest UI request timed out")

    def pump(self):
        for _ in range(16):
            try:
                future, action = self.requests.get_nowait()
            except queue.Empty:
                break
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(action())
            except Exception as error:
                future.set_exception(error)
        if not self.closed:
            self.root.after(15, self.pump)

    def close(self):
        self.closed = True
        while True:
            try:
                future, _action = self.requests.get_nowait()
            except queue.Empty:
                break
            if future.set_running_or_notify_cancel():
                future.set_exception(RuntimeError("Guest fixture closed"))
        self.root.destroy()


def resize_display(fixture, width, height):
    deadline = time.monotonic() + 12
    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise RuntimeError("Guest display resize deadline exceeded")
        return seconds
    def command(arguments):
        return guest_command(arguments, timeout=min(3, remaining()))
    query = command(["/usr/bin/xrandr", "--query"])
    connected = []
    modes = {}
    current = None
    for line in query.splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]{1,32}) connected\b", line)
        if match:
            current = match.group(1)
            connected.append(current)
            modes[current] = set()
        elif line and not line[0].isspace():
            current = None
        elif current:
            mode = re.match(r"^\s+(\d+x\d+)\s", line)
            if mode:
                modes[current].add(mode.group(1))
    selected = next((name for name in connected if name in OUTPUTS), None)
    wanted = "%dx%d" % (width, height)
    if selected is None or wanted not in modes[selected]:
        raise RuntimeError("Requested guest display mode is unavailable")
    command(["/usr/bin/xrandr", "--output", selected, "--mode", wanted])
    observed = command(["/usr/bin/xrandr", "--query"])
    dimensions = re.search(r"^Screen \d+:[^\n]*\bcurrent (\d+) x (\d+),", observed, re.MULTILINE)
    if dimensions is None:
        raise RuntimeError("Native display dimensions could not be observed")
    observed_width, observed_height = map(int, dimensions.groups())
    if (observed_width, observed_height) != (width, height):
        raise RuntimeError("Native display dimensions did not match the requested size")
    fixture.call(lambda: fixture.fit_display(observed_width, observed_height), timeout=min(1, remaining()))
    while time.monotonic() < deadline:
        state = fixture.call(fixture.state, timeout=min(1, remaining()))
        if (state["screen"] == {"width": width, "height": height}
                and state["window"]["width"] == width - 40
                and state["window"]["height"] == height - 60):
            fixture.call(fixture.root.update_idletasks, timeout=min(1, remaining()))
            fixture.call(fixture.root.winfo_pointerxy, timeout=min(1, remaining()))
            return
        time.sleep(0.05)
    raise RuntimeError("Guest display or window resize did not settle")


def handler_for(fixture):
    mutation = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, _format, *_args):
            logging.debug("Guest HTTP request completed")

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            supplied = self.headers.get_all("Authorization", [])
            if (len(supplied) != 1 or len(supplied[0]) > 1024
                    or not hmac.compare_digest(supplied[0].encode("utf-8"), ("Bearer " + TOKEN).encode("utf-8"))):
                self.reply(401, {"error": "Authorization required"})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            try:
                if self.path == "/health":
                    self.reply(200, {"ok": True, "workerId": WORKER_ID, "bootId": BOOT_ID})
                elif self.path == "/state":
                    self.reply(200, fixture.call(fixture.state))
                elif self.path == "/pointer-state":
                    self.reply(200, {"workerId": WORKER_ID, "bootId": BOOT_ID, **query_pointer_state()})
                else:
                    self.reply(404, {"error": "Unknown guest endpoint"})
            except (RuntimeError, queue.Full):
                self.reply(503, {"error": "Guest UI unavailable"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path not in ("/type", "/resize"):
                self.reply(404, {"error": "Unknown guest endpoint"})
                return
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or self.headers.get("Transfer-Encoding") is not None:
                    raise ValueError("A single content length is required")
                length = int(lengths[0])
                if length < 1 or length > MAX_BODY:
                    raise ValueError("Guest request is too large")
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object")
                if not mutation.acquire(blocking=False):
                    self.reply(409, {"error": "Another guest operation is running"})
                    return
                try:
                    if self.path == "/type":
                        text = data.get("text")
                        if (set(data) != {"text"} or not isinstance(text, str) or not 1 <= len(text) <= 128
                                or any(ord(character) < 32 or ord(character) > 0xFFFF
                                       or 0xD800 <= ord(character) <= 0xDFFF for character in text)):
                            raise ValueError("Expected 1 to 128 printable characters")
                        if not fixture.call(fixture.state)["entryFocused"]:
                            self.reply(409, {"error": "Focus the fixture text field first"})
                            return
                        type_text(fixture, text)
                    else:
                        width, height = data.get("width"), data.get("height")
                        if (set(data) != {"width", "height"} or type(width) is not int or type(height) is not int
                                or (width, height) not in RESOLUTIONS):
                            raise ValueError("Unsupported guest display size")
                        resize_display(fixture, width, height)
                    self.reply(200, {"completed": True})
                finally:
                    mutation.release()
            except (ValueError, UnicodeError):
                self.reply(400, {"error": "Invalid guest request"})
            except NativeInputError as error:
                self.reply(503, error.diagnostic)
            except (RuntimeError, queue.Full, subprocess.SubprocessError, OSError):
                self.reply(503, {"error": "Guest operation failed; inspect state before retrying"})

    return Handler


def main():
    if sys.platform != "linux" or os.environ.get("DISPLAY") != ":0":
        raise RuntimeError("The guest fixture requires its dedicated display")
    initialize_native_input()
    fixture = Fixture()
    server = None
    if 32 <= len(TOKEN) <= 512 and WORKER_ID and BOOT_ID:
        server = ThreadingHTTPServer(("0.0.0.0", 8080), handler_for(fixture))
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
    else:
        logging.warning("Guest HTTP endpoints disabled: session credentials are missing")
    try:
        fixture.root.mainloop()
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
