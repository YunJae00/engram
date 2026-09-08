import os
import queue
import subprocess
import time


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
        for character in text:
            if not state["entryFocused"] or time.monotonic() >= deadline:
                raise RuntimeError("Input focus changed or typing timed out")
            start, end = state["entrySelection"] or [state["entryCursor"]] * 2
            before, keys_before = state["text"], state["keyEvents"]
            expected = before[:start] + character + before[end:]
            # Confirm each key before reusing the temporary Unicode key mapping.
            guest_command(["/usr/bin/xdotool", "type", "--clearmodifiers", "--delay", "100", "--", character],
                          timeout=max(0.01, min(3, deadline - time.monotonic())))
            key_deadline = min(deadline, time.monotonic() + 1)
            while time.monotonic() < key_deadline:
                state = ui(fixture.state)
                if not state["entryFocused"]:
                    raise RuntimeError("Input focus changed")
                if state["text"] == expected and state["keyEvents"] > keys_before:
                    confirmed += 1
                    break
                if state["text"] != before:
                    raise RuntimeError("Native input produced unexpected text")
                time.sleep(0.03)
            else:
                raise RuntimeError("Native key was not observed")
        ui(lambda: setattr(fixture, "last_type_diagnostic",
                           {"completed": True, "confirmedCodepoints": confirmed}))
    except (RuntimeError, queue.Full, subprocess.SubprocessError, OSError) as error:
        snapshot_fresh = True
        try:
            state = fixture.call(fixture.state, timeout=0.25)
        except (RuntimeError, queue.Full):
            snapshot_fresh = False
        diagnostic = {"completed": False, "confirmedCodepoints": confirmed,
                      "failedCodepoint": "U+%04X" % ord(text[min(confirmed, len(text) - 1)]),
                      "observedText": state["text"][:512], "observedKeyEvents": state["keyEvents"],
                      "snapshotFresh": snapshot_fresh, "observedTextTruncated": len(state["text"]) > 512,
                      "recentKeys": state["recentKeys"], "error": "Native typing was not confirmed"}
        try:
            fixture.call(lambda: setattr(fixture, "last_type_diagnostic", diagnostic), timeout=0.25)
        except (RuntimeError, queue.Full):
            diagnostic["uiUnavailable"] = True
        raise NativeInputError(diagnostic) from error
