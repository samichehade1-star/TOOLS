"""Tile Sequence Auto-Presser - GUI app.

Three steps, done entirely through buttons:
  1. Select Region  - drag a box around the tile row on screen.
  2. Calibrate      - trigger the in-game sequence; label each new digit once.
  3. Start Watching - it reads the tiles and presses the matching keys live.
"""
import ctypes
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from tkinter import messagebox

import customtkinter as ctk
import cv2
import keyboard
import mss
import numpy as np
import pydirectinput
from PIL import Image

from tiles import (
    find_tile_boxes,
    cluster_rows,
    crop_cell,
    match_digit,
    row_is_uniform,
    row_is_locked,
    find_best_full_match_row,
)
from capture import Grabber

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
TEMPLATE_ROOT = os.path.join(BASE_DIR, "templates")
LOG_PATH = os.path.join(BASE_DIR, "session.log")

# ---------- Auto-update (GitHub Releases) ----------
APP_VERSION = "1.0.0"
UPDATE_REPO = "samichehade1-star/tile-auto-presser"
UPDATE_ASSET_NAME = "TileAutoPresser.exe"


def _parse_version(v):
    parts = []
    for p in v.lstrip("vV").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def check_for_update(timeout=6):
    """Hits the GitHub Releases API for this tool's own mirror repo and
    returns (version, download_url) if a newer release than APP_VERSION is
    published, else None. Never raises -- a failed/offline check should be
    silent, not interrupt normal use of the tool.
    """
    url = f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest"
    req = urllib.request.Request(url, headers={
        "User-Agent": "TileAutoPresser-UpdateCheck",
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
        tag = data.get("tag_name", "")
        if not tag or _parse_version(tag) <= _parse_version(APP_VERSION):
            return None
        for asset in data.get("assets", []):
            if asset.get("name") == UPDATE_ASSET_NAME:
                return tag.lstrip("vV"), asset.get("browser_download_url")
    except Exception:
        pass
    return None


def download_update(url, dest_path, progress_cb=None):
    req = urllib.request.Request(url, headers={"User-Agent": "TileAutoPresser-UpdateCheck"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        with open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if progress_cb and total:
                    progress_cb(done / total)


def apply_update(new_exe_path):
    """Swaps the running exe for new_exe_path and relaunches it, then exits
    this process. Windows keeps a running exe's file locked, so this can't
    just overwrite it directly -- it hands off to a detached helper .bat
    that waits for our PID to disappear, does the move + relaunch, and then
    deletes itself.
    """
    current_exe = sys.executable
    pid = os.getpid()
    bat_path = os.path.join(tempfile.gettempdir(), "tileautopresser_update.bat")
    bat = (
        "@echo off\r\n"
        ":wait\r\n"
        f'tasklist /fi "PID eq {pid}" | find "{pid}" >nul\r\n'
        "if not errorlevel 1 (\r\n"
        "    timeout /t 1 /nobreak >nul\r\n"
        "    goto wait\r\n"
        ")\r\n"
        f'move /y "{new_exe_path}" "{current_exe}" >nul\r\n'
        f'start "" "{current_exe}"\r\n'
        'del "%~f0"\r\n'
    )
    with open(bat_path, "w") as f:
        f.write(bat)
    subprocess.Popen(["cmd", "/c", bat_path], creationflags=subprocess.CREATE_NO_WINDOW)
    os._exit(0)

DEFAULT_CONFIG = {
    "region": None,
    "poll_interval_ms": 5,
    "match_threshold": 0.75,
    "key_hold_ms": 40,
    "key_gap_ms": 55,
    "min_cell_area": 150,
    "row_cluster_tolerance_px": 18,
    "template_size": 40,
    "min_sequence_length": 2,
    "whole_screen": False,
    "hotkey_toggle_watch": "f8",
    "hotkey_toggle_calibration": "f7",
    "hotkey_reboot_watch": "f9",
    "input_mode": "keyboard",
    "role": "civilian",
    "confirm_count": 1,
    "max_refine_candidates": 24,
    "stall_log_ms": 250,
    "mash_region": None,
    "mash_whole_screen": False,
    "mash_match_threshold": 0.75,
    "mash_template_size": 40,
    "mash_press_hold_ms": 15,
    "mash_press_gap_ms": 10,
    "mash_poll_interval_ms": 5,
    "mash_min_cell_area": 150,
    "mash_max_refine_candidates": 12,
    "mash_miss_tolerance": 15,
    "hotkey_toggle_mash_calibration": "f5",
    "hotkey_toggle_mash_watch": "f6",
}

pydirectinput.PAUSE = 0

if sys.platform == "win32":
    try:
        # Windows' default scheduler tick is ~15.6ms, so any time.sleep()
        # shorter than that (the Mash tab's press hold/gap, tuned down to a
        # few ms for a fast spam rate) silently gets rounded up to a full
        # tick instead of actually sleeping the requested duration --
        # capping the real-world press rate well below what config.json
        # asks for. Requesting 1ms scheduler granularity for this process
        # makes short sleeps behave as configured.
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass

REQUIRED_LABELS = {
    "keyboard": set("1234"),
    "controller": {"A", "B", "X", "Y"},
}
DIALOG_BUTTON_CHOICES = {
    "keyboard": list("123456789"),
    "controller": ["A", "B", "X", "Y"],
}
# How many tiles a combo row actually has depends on which role is being
# played, not just the input mode -- Michael's combos are always 4 or 5
# tiles, civilian's are always 3 or 4. Rows outside that range are always a
# partial/mid-animation misread, never a real combo, so rejecting them
# outright (see exact_len/max_len in find_best_full_match_row) filters those
# out for free with no extra polling or confirmation delay.
ROLE_LEN_RANGE = {
    "michael": (4, 5),
    "civilian": (3, 4),
}
# Controller mode reads the same Xbox-style A/B/X/Y icon prompts as before,
# but no virtual controller is involved at all -- it just presses the mapped
# keyboard key instead (this game apparently accepts keyboard input for the
# same actions). Avoids every problem a virtual controller had: DS4Windows
# fighting over the XInput slot, and the game outright rejecting/kicking for
# an unrecognized second controller.
CONTROLLER_KEY_MAP = {"A": "1", "B": "2", "X": "4", "Y": "3"}

# ---------- Dark theme palette (matches the "Tile Auto-Presser Pro" concept) ----------
BG_MAIN = "#10131a"
BG_CARD = "#1a1e28"
BG_CHIP = "#242938"
BORDER_SUBTLE = "#2f3546"
ACCENT_TEAL = "#2dd4bf"
ACCENT_TEAL_HOVER = "#25b3a1"
ACCENT_BLUE = "#3b82f6"
ACCENT_BLUE_HOVER = "#2f6fd1"
ACCENT_RED = "#ef4444"
ACCENT_RED_HOVER = "#c53030"
GREEN_CHECK = "#34d399"
TEXT_PRIMARY = "#eef0f5"
TEXT_SECONDARY = "#8a92a6"
TEXT_MUTED = "#5b6274"
LOG_BG = "#0c0e13"
LOG_TS = "#6b7385"
LOG_INFO = "#c7cbd6"
LOG_DETECT = "#4ade80"
LOG_ERROR = "#f87171"
LOG_SUCCESS = "#2dd4bf"


def template_dir_for(mode):
    return os.path.join(TEMPLATE_ROOT, mode)


def keep_frac_for(mode):
    # Controller icons share a nearly identical outer ring across every
    # letter (A/B/X/Y), which made them dangerously easy to confuse with a
    # full-tile crop -- cropping to the center glyph fixes that. Digit tiles
    # never had that problem and already had a wide real-world matching
    # margin, so keep them at the full, proven-working crop; center-cropping
    # them too made keyboard mode more sensitive to live box-alignment noise
    # and caused a real regression (all-tiles-read-as-"1" misreads).
    return 0.65 if mode == "controller" else 1.0


def match_threshold_for(mode, base_threshold):
    # Controller-icon rendering has more real-world size/weight variance
    # between instances than digit tiles do -- measured a correct "B" icon
    # scoring only 0.737 in live gameplay (just under the shared 0.75
    # threshold), which silently broke matching for that whole row. Since
    # center-cropping (see keep_frac_for) already pushed worst-case
    # cross-letter confusion down to ~0.47, there's a wide safety margin to
    # lower the bar for controller mode specifically without risking
    # accepting a wrong letter.
    return 0.68 if mode == "controller" else base_threshold


def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=4)
    with open(CONFIG_PATH, "r") as f:
        cfg = json.load(f)
    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, v)
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=4)


def _timestamp_ms():
    now = time.time()
    return f"{time.strftime('%H:%M:%S', time.localtime(now))}.{int(now % 1 * 1000):03d}"


def find_mash_cell(gray, size, min_area, max_refine):
    # A hand-drawn region can't be trusted to be a pixel-tight crop of just
    # the icon (measured live: a real attempt landed at 450x396, nearly the
    # whole game view) -- resizing that whole area straight down to `size`
    # squashed the icon into noise and made matching flicker on/off frame to
    # frame. Reusing the Main tab's tile-box finder instead locates the
    # actual bright rounded-rectangle icon inside whatever region was drawn,
    # so a loose box works exactly as well as a tight one. Returns None when
    # no icon-shaped box is found (i.e. the prompt currently isn't showing).
    boxes = find_tile_boxes(gray, min_area, max_refine=max_refine)
    if not boxes:
        # Not every prompt is a light box on a dark background -- a
        # mouse-click icon showed up as a dark box with a light glyph
        # instead, which the normal pass never saw as a candidate at all.
        # Retrying inverted catches that polarity too.
        boxes = find_tile_boxes(gray, min_area, max_refine=max_refine, invert=True)
    if not boxes:
        return None
    h, w = gray.shape[:2]
    cx, cy = w / 2.0, h / 2.0

    def dist_from_center(box):
        bx, by, bw, bh = box
        return (bx + bw / 2.0 - cx) ** 2 + (by + bh / 2.0 - cy) ** 2

    box = min(boxes, key=dist_from_center)
    return crop_cell(gray, box, size, keep_frac=1.0)


# Raw SendInput with hardware scan codes, bypassing pydirectinput entirely
# for the Mash tab specifically. pydirectinput re-validates arguments, checks
# its global PAUSE/failsafe state, and re-resolves the scan code on every
# single call -- overhead that's negligible at the Main tab's ~20 presses/sec
# but eats directly into the Mash tab's few-millisecond hold/gap budget at
# 100+ presses/sec, adding jitter on top of whatever the game itself can
# register. This mirrors the technique in a proven fast/reliable autoclicker
# (github.com/Blur009/Blur-AutoClicker's engine/keyboard.rs and mouse.rs):
# build the INPUT struct once per call and hand it straight to user32.
_user32 = ctypes.WinDLL("user32", use_last_error=True)

_INPUT_KEYBOARD = 1
_INPUT_MOUSE = 0
_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_SCANCODE = 0x0008
_KEYEVENTF_EXTENDEDKEY = 0x0001
_MAPVK_VK_TO_VSC_EX = 4
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_MOUSEEVENTF_RIGHTDOWN = 0x0008
_MOUSEEVENTF_RIGHTUP = 0x0010

_ULONG_PTR = ctypes.c_size_t


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong), ("dwExtraInfo", _ULONG_PTR),
    )


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort), ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong), ("dwExtraInfo", _ULONG_PTR),
    )


class _INPUTunion(ctypes.Union):
    _fields_ = (("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT))


class _INPUT(ctypes.Structure):
    _fields_ = (("type", ctypes.c_ulong), ("union", _INPUTunion))


def _send_key_event(vk, key_up):
    raw = _user32.MapVirtualKeyW(vk, _MAPVK_VK_TO_VSC_EX)
    scan, extended = raw & 0xFF, (raw >> 8) != 0
    flags = _KEYEVENTF_SCANCODE | (_KEYEVENTF_KEYUP if key_up else 0) | (_KEYEVENTF_EXTENDEDKEY if extended else 0)
    inp = _INPUT(type=_INPUT_KEYBOARD, union=_INPUTunion(ki=_KEYBDINPUT(0, scan, flags, 0, 0)))
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def _send_mouse_event(flag):
    inp = _INPUT(type=_INPUT_MOUSE, union=_INPUTunion(mi=_MOUSEINPUT(0, 0, 0, flag, 0, 0)))
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def press_mash_input(label, hold_s, gap_s):
    if label in ("MB1", "MB2"):
        down, up = (_MOUSEEVENTF_LEFTDOWN, _MOUSEEVENTF_LEFTUP) if label == "MB1" \
            else (_MOUSEEVENTF_RIGHTDOWN, _MOUSEEVENTF_RIGHTUP)
        _send_mouse_event(down)
        time.sleep(hold_s)
        _send_mouse_event(up)
    else:
        vk = ord(label)  # labels are captured as single A-Z/0-9 chars, whose VK codes equal their ASCII value
        _send_key_event(vk, key_up=False)
        time.sleep(hold_s)
        _send_key_event(vk, key_up=True)
    time.sleep(gap_s)


def load_templates(size, template_dir):
    templates = {}
    if os.path.isdir(template_dir):
        for fname in os.listdir(template_dir):
            if fname.endswith(".png"):
                label = os.path.splitext(fname)[0]
                img = cv2.imread(os.path.join(template_dir, fname), cv2.IMREAD_GRAYSCALE)
                if img is not None:
                    templates[label] = cv2.resize(img, (size, size))
    return templates


class App:
    def __init__(self, root):
        self.root = root
        root.title("Tile Auto-Presser Pro")
        root.resizable(False, False)
        root.configure(fg_color=BG_MAIN)
        if sys.platform == "win32":
            root.after(50, lambda: self._strip_maximize_button(root))

        header = ctk.CTkFrame(root, fg_color="transparent")
        header.pack(fill="x", padx=12, pady=(10, 0))
        ctk.CTkLabel(
            header, text=f"v{APP_VERSION}", text_color=TEXT_MUTED, font=ctk.CTkFont(size=11),
        ).pack(side="left")
        self.update_btn = ctk.CTkButton(
            header, text="Check for Updates", command=self.check_for_updates_clicked,
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_SECONDARY,
            height=22, corner_radius=11, font=ctk.CTkFont(size=11), width=130,
        )
        self.update_btn.pack(side="right")
        # Quiet startup check so the tool self-reports being out of date without
        # anyone remembering to click the button -- errors/no-update are just
        # not logged, since a background check failing silently must never look
        # like a problem with the tool itself.
        root.after(1500, lambda: threading.Thread(target=self._background_update_check, daemon=True).start())

        self.config = load_config()
        self.log_queue = queue.Queue()

        self.watch_thread = None
        self.watch_stop = threading.Event()
        self.calibrate_thread = None
        self.calibrate_stop = threading.Event()
        self.calib_request_q = queue.Queue()
        self.calib_response_q = queue.Queue()
        self.calib_dialog = None
        self._calib_photo = None
        self._thumb_image = None

        self.mash_watch_thread = None
        self.mash_press_thread = None
        self._mash_active_label = None
        self.mash_watch_stop = threading.Event()
        self.mash_calibrate_thread = None
        self.mash_calibrate_stop = threading.Event()
        self.mash_calib_request_q = queue.Queue()
        self.mash_calib_response_q = queue.Queue()
        self.mash_calib_dialog = None
        self._mash_calib_photo = None
        self._mash_thumb_image = None

        self._seg_to_mode = {"Keyboard": "keyboard", "Controller": "controller"}
        self._mode_to_seg = {v: k for k, v in self._seg_to_mode.items()}
        self._seg_to_role = {"Michael": "michael", "Civilian": "civilian"}
        self._role_to_seg = {v: k for k, v in self._seg_to_role.items()}
        self.monitor_wh = self._detect_monitor_size()

        TITLE_FONT = ctk.CTkFont(size=13, weight="bold")

        # ---------- Tabs ----------
        # The Mash puzzle is a separate minigame from the Main-tab combo row
        # (see README) -- it gets its own tab so its region/calibration/run
        # controls don't crowd or get confused with the Main tab's.
        self.tabview = ctk.CTkTabview(
            root, fg_color=BG_CARD, corner_radius=12,
            segmented_button_fg_color=BG_CHIP, segmented_button_selected_color=ACCENT_BLUE,
            segmented_button_selected_hover_color=ACCENT_BLUE_HOVER,
            segmented_button_unselected_color=BG_CHIP, segmented_button_unselected_hover_color=BORDER_SUBTLE,
            text_color=TEXT_PRIMARY,
        )
        self.tabview.pack(fill="x", padx=12, pady=(12, 6))
        self.tabview.add("Main")
        self.tabview.add("Mash (Beta)")
        main_tab = self.tabview.tab("Main")
        mash_tab = self.tabview.tab("Mash (Beta)")

        # ---------- Input mode ----------
        card_input = ctk.CTkFrame(main_tab, fg_color=BG_CARD, corner_radius=12)
        card_input.pack(fill="x", padx=12, pady=(12, 6))
        ctk.CTkLabel(
            card_input, text="Input", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 4))
        self.input_seg = ctk.CTkSegmentedButton(
            card_input, values=["Keyboard", "Controller"], command=self.on_input_mode_change,
            fg_color=BG_CHIP, selected_color=ACCENT_BLUE, selected_hover_color=ACCENT_BLUE_HOVER,
            unselected_color=BG_CHIP, unselected_hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY,
            height=26, corner_radius=13, font=ctk.CTkFont(size=11),
        )
        self.input_seg.set(self._mode_to_seg.get(self.config.get("input_mode", "keyboard"), "Keyboard"))
        self.input_seg.pack(fill="x", padx=12, pady=(0, 10))

        # ---------- Role (sets how many tiles a real combo can have) ----------
        ctk.CTkLabel(
            card_input, text="Role", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(0, 4))
        self.role_seg = ctk.CTkSegmentedButton(
            card_input, values=["Michael", "Civilian"], command=self.on_role_change,
            fg_color=BG_CHIP, selected_color=ACCENT_BLUE, selected_hover_color=ACCENT_BLUE_HOVER,
            unselected_color=BG_CHIP, unselected_hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY,
            height=26, corner_radius=13, font=ctk.CTkFont(size=11),
        )
        self.role_seg.set(self._role_to_seg.get(self.config.get("role", "civilian"), "Civilian"))
        self.role_seg.pack(fill="x", padx=12, pady=(0, 10))

        # ---------- Step 1: screen region ----------
        card1 = ctk.CTkFrame(main_tab, fg_color=BG_CARD, corner_radius=12)
        card1.pack(fill="x", padx=12, pady=6)
        ctk.CTkLabel(
            card1, text="Step 1: Configure Screen", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 6))

        body1 = ctk.CTkFrame(card1, fg_color="transparent")
        body1.pack(fill="x", padx=12, pady=(0, 10))

        thumb_frame = ctk.CTkFrame(body1, fg_color=BG_CHIP, corner_radius=8, width=140, height=84)
        thumb_frame.pack(side="left")
        thumb_frame.pack_propagate(False)
        self.thumb_label = ctk.CTkLabel(
            thumb_frame, text="No region\nselected", text_color=TEXT_MUTED, font=ctk.CTkFont(size=10),
        )
        self.thumb_label.pack(expand=True, fill="both")

        btns_col = ctk.CTkFrame(body1, fg_color="transparent")
        btns_col.pack(side="left", fill="both", expand=True, padx=(10, 0))
        self.whole_screen_btn = ctk.CTkButton(
            btns_col, text=f"Full Screen ({self.monitor_wh[0]}x{self.monitor_wh[1]})",
            command=self.use_whole_screen, fg_color=BG_CHIP, hover_color=BORDER_SUBTLE,
            border_width=2, border_color=BG_CHIP, text_color=TEXT_PRIMARY, corner_radius=8, height=26,
            font=ctk.CTkFont(size=11),
        )
        self.whole_screen_btn.pack(fill="x", pady=(0, 6))
        self.select_region_btn = ctk.CTkButton(
            btns_col, text="Select Region...", command=self.select_region,
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, border_width=2, border_color=BG_CHIP,
            text_color=TEXT_PRIMARY, corner_radius=8, height=26, font=ctk.CTkFont(size=11),
        )
        self.select_region_btn.pack(fill="x")
        self.region_caption = ctk.CTkLabel(
            btns_col, text=self.region_text(), text_color=TEXT_SECONDARY, font=ctk.CTkFont(size=10),
            justify="left", anchor="w", wraplength=280,
        )
        self.region_caption.pack(fill="x", pady=(6, 0))

        # ---------- Step 2: calibration ----------
        card2 = ctk.CTkFrame(main_tab, fg_color=BG_CARD, corner_radius=12)
        card2.pack(fill="x", padx=12, pady=6)
        self.step2_title_label = ctk.CTkLabel(
            card2, text=self.step2_title(), font=TITLE_FONT, text_color=TEXT_PRIMARY,
        )
        self.step2_title_label.pack(anchor="w", padx=12, pady=(10, 6))

        body2 = ctk.CTkFrame(card2, fg_color="transparent")
        body2.pack(fill="x", padx=12, pady=(0, 2))
        self.chips_frame = ctk.CTkFrame(body2, fg_color="transparent")
        self.chips_frame.pack(side="left")
        self.chip_widgets = {}

        self.calibrate_btn = ctk.CTkButton(
            body2, text="Start Calibration", command=self.toggle_calibration,
            fg_color=ACCENT_BLUE, hover_color=ACCENT_BLUE_HOVER, text_color="#0b0d12",
            corner_radius=8, height=28, width=120, font=ctk.CTkFont(size=11),
        )
        self.calibrate_btn.pack(side="right")

        calib_hotkey = self.config.get("hotkey_toggle_calibration", "f7").upper()
        self._hotkey_badge(card2, calib_hotkey, "start/stop without tabbing out").pack(
            anchor="w", padx=12, pady=(2, 10),
        )

        self.build_calibration_chips()

        # ---------- Step 3: run ----------
        card3 = ctk.CTkFrame(main_tab, fg_color=BG_CARD, corner_radius=12)
        card3.pack(fill="x", padx=12, pady=6)
        ctk.CTkLabel(
            card3, text="Step 3: Auto-Press", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 6))

        run_col = ctk.CTkFrame(card3, fg_color="transparent")
        run_col.pack(pady=(0, 10))
        run_btn_row = ctk.CTkFrame(run_col, fg_color="transparent")
        run_btn_row.pack()
        self.watch_btn = ctk.CTkButton(
            run_btn_row, text="▶  Run", command=self.toggle_watch,
            fg_color=ACCENT_TEAL, hover_color=ACCENT_TEAL_HOVER, text_color="#07211d",
            font=ctk.CTkFont(size=13, weight="bold"), corner_radius=18, height=36, width=140,
        )
        self.watch_btn.pack(side="left")
        self.reboot_btn = ctk.CTkButton(
            run_btn_row, text="⟳", command=self.reboot_watch,
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY,
            font=ctk.CTkFont(size=16, weight="bold"), corner_radius=18, height=36, width=36,
        )
        self.reboot_btn.pack(side="left", padx=(8, 0))

        watch_hotkey = self.config.get("hotkey_toggle_watch", "f8").upper()
        self._hotkey_badge(run_col, watch_hotkey, "works even with the game focused").pack(pady=(6, 0))
        reboot_hotkey = self.config.get("hotkey_reboot_watch", "f9").upper()
        self._hotkey_badge(run_col, reboot_hotkey, "reboots watching if it degrades over time").pack(pady=(4, 0))

        # ---------- Mash tab: Step 1 (region) ----------
        card_m1 = ctk.CTkFrame(mash_tab, fg_color=BG_CARD, corner_radius=12)
        card_m1.pack(fill="x", padx=12, pady=(12, 6))
        ctk.CTkLabel(
            card_m1, text="Step 1: Select Icon Box", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 6))

        body_m1 = ctk.CTkFrame(card_m1, fg_color="transparent")
        body_m1.pack(fill="x", padx=12, pady=(0, 10))

        mash_thumb_frame = ctk.CTkFrame(body_m1, fg_color=BG_CHIP, corner_radius=8, width=140, height=84)
        mash_thumb_frame.pack(side="left")
        mash_thumb_frame.pack_propagate(False)
        self.mash_thumb_label = ctk.CTkLabel(
            mash_thumb_frame, text="No region\nselected", text_color=TEXT_MUTED, font=ctk.CTkFont(size=10),
        )
        self.mash_thumb_label.pack(expand=True, fill="both")

        mash_btns_col = ctk.CTkFrame(body_m1, fg_color="transparent")
        mash_btns_col.pack(side="left", fill="both", expand=True, padx=(10, 0))
        self.mash_whole_screen_btn = ctk.CTkButton(
            mash_btns_col, text=f"Full Screen ({self.monitor_wh[0]}x{self.monitor_wh[1]})",
            command=self.use_mash_whole_screen, fg_color=BG_CHIP, hover_color=BORDER_SUBTLE,
            border_width=2, border_color=BG_CHIP, text_color=TEXT_PRIMARY, corner_radius=8, height=26,
            font=ctk.CTkFont(size=11),
        )
        self.mash_whole_screen_btn.pack(fill="x", pady=(0, 6))
        self.mash_select_region_btn = ctk.CTkButton(
            mash_btns_col, text="Select Region...", command=self.select_mash_region,
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, border_width=2, border_color=BG_CHIP,
            text_color=TEXT_PRIMARY, corner_radius=8, height=26, font=ctk.CTkFont(size=11),
        )
        self.mash_select_region_btn.pack(fill="x")
        self.mash_region_caption = ctk.CTkLabel(
            mash_btns_col, text=self.mash_region_text(), text_color=TEXT_SECONDARY, font=ctk.CTkFont(size=10),
            justify="left", anchor="w", wraplength=280,
        )
        self.mash_region_caption.pack(fill="x", pady=(6, 0))

        # ---------- Mash tab: Step 2 (calibration) ----------
        card_m2 = ctk.CTkFrame(mash_tab, fg_color=BG_CARD, corner_radius=12)
        card_m2.pack(fill="x", padx=12, pady=6)
        ctk.CTkLabel(
            card_m2, text="Step 2: Teach Icons", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 6))

        body_m2 = ctk.CTkFrame(card_m2, fg_color="transparent")
        body_m2.pack(fill="x", padx=12, pady=(0, 2))
        self.mash_chips_frame = ctk.CTkFrame(body_m2, fg_color="transparent")
        self.mash_chips_frame.pack(side="left", fill="x", expand=True)
        self.mash_chip_widgets = {}

        self.mash_calibrate_btn = ctk.CTkButton(
            body_m2, text="Start Calibration", command=self.toggle_mash_calibration,
            fg_color=ACCENT_BLUE, hover_color=ACCENT_BLUE_HOVER, text_color="#0b0d12",
            corner_radius=8, height=28, width=120, font=ctk.CTkFont(size=11),
        )
        self.mash_calibrate_btn.pack(side="right")

        mash_calib_hotkey = self.config.get("hotkey_toggle_mash_calibration", "f5").upper()
        self._hotkey_badge(card_m2, mash_calib_hotkey, "start/stop without tabbing out").pack(
            anchor="w", padx=12, pady=(2, 10),
        )

        self.build_mash_calibration_chips()

        # ---------- Mash tab: Step 3 (run) ----------
        card_m3 = ctk.CTkFrame(mash_tab, fg_color=BG_CARD, corner_radius=12)
        card_m3.pack(fill="x", padx=12, pady=(6, 12))
        ctk.CTkLabel(
            card_m3, text="Step 3: Mash", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 6))

        run_col_m = ctk.CTkFrame(card_m3, fg_color="transparent")
        run_col_m.pack(pady=(0, 10))
        self.mash_watch_btn = ctk.CTkButton(
            run_col_m, text="▶  Run", command=self.toggle_mash_watch,
            fg_color=ACCENT_TEAL, hover_color=ACCENT_TEAL_HOVER, text_color="#07211d",
            font=ctk.CTkFont(size=13, weight="bold"), corner_radius=18, height=36, width=140,
        )
        self.mash_watch_btn.pack()

        mash_run_hotkey = self.config.get("hotkey_toggle_mash_watch", "f6").upper()
        self._hotkey_badge(run_col_m, mash_run_hotkey, "works even with the game focused").pack(pady=(6, 0))
        ctk.CTkLabel(
            run_col_m,
            text=(
                f"⚠ Doesn't auto-stop -- toggle {mash_run_hotkey} ON right before the puzzle "
                f"and OFF right after. Left running, it can lock onto a similar icon in an "
                f"unrelated puzzle and mash the wrong thing."
            ),
            text_color=ACCENT_RED, font=ctk.CTkFont(size=10), justify="left", anchor="w", wraplength=280,
        ).pack(pady=(8, 0))

        # ---------- Log ----------
        card4 = ctk.CTkFrame(root, fg_color=BG_CARD, corner_radius=12, height=150)
        card4.pack(fill="x", padx=12, pady=(6, 12))
        card4.pack_propagate(False)
        ctk.CTkLabel(
            card4, text="Log", font=TITLE_FONT, text_color=TEXT_PRIMARY,
        ).pack(anchor="w", padx=12, pady=(10, 4))
        self.log_text = ctk.CTkTextbox(
            card4, fg_color=LOG_BG, text_color=LOG_INFO, font=ctk.CTkFont(family="Consolas", size=10),
            corner_radius=8, wrap="none",
        )
        self.log_text.pack(fill="both", expand=True, padx=12, pady=(0, 10))
        self._init_log_tags()
        self.log_text.configure(state="disabled")

        self.refresh_region_buttons()
        self.refresh_mash_region_buttons()
        self.update_thumbnail()
        self.update_mash_thumbnail()
        self.register_hotkeys()

        self.poll_log()
        self.poll_calibration_requests()
        self.poll_mash_calibration_requests()
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        # Size the window to exactly fit its content instead of a guessed
        # constant -- avoids the window growing past the screen (and the log
        # panel becoming invisible) whenever a widget's size changes.
        root.update_idletasks()
        root.geometry(f"{root.winfo_reqwidth()}x{root.winfo_reqheight()}")

    # ---------- small UI helpers ----------
    def _hotkey_badge(self, parent, key_text, note):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        ctk.CTkLabel(
            row, text=key_text, font=ctk.CTkFont(size=10, weight="bold"), text_color=TEXT_PRIMARY,
            fg_color=BG_CHIP, corner_radius=5, width=24, height=16,
        ).pack(side="left")
        ctk.CTkLabel(
            row, text=f"  {key_text} — {note}", text_color=TEXT_SECONDARY, font=ctk.CTkFont(size=10),
        ).pack(side="left")
        return row

    def _background_update_check(self):
        result = check_for_update()
        if result:
            version, url = result
            self.root.after(0, lambda: self._offer_update(version, url))

    def check_for_updates_clicked(self):
        self.update_btn.configure(text="Checking...", state="disabled")

        def worker():
            result = check_for_update()
            self.root.after(0, lambda: self.update_btn.configure(text="Check for Updates", state="normal"))
            if result:
                version, url = result
                self.root.after(0, lambda: self._offer_update(version, url))
            else:
                self.root.after(0, lambda: messagebox.showinfo(
                    "Up to date", f"You're on the latest version (v{APP_VERSION}).",
                ))

        threading.Thread(target=worker, daemon=True).start()

    def _offer_update(self, version, url):
        if not getattr(sys, "frozen", False):
            self.log(f"Update v{version} available (running from source -- update manually).")
            return
        if not messagebox.askyesno(
            "Update available", f"v{version} is available (you're on v{APP_VERSION}). Update now?",
        ):
            return
        self.log(f"Downloading update v{version}...")
        threading.Thread(target=self._run_update, args=(url,), daemon=True).start()

    def _run_update(self, url):
        try:
            dest = os.path.join(tempfile.gettempdir(), "TileAutoPresser.new.exe")
            last_pct = -1

            def progress(frac):
                nonlocal last_pct
                pct = int(frac * 100)
                if pct != last_pct and pct % 10 == 0:
                    last_pct = pct
                    self.log(f"Downloading update... {pct}%")

            download_update(url, dest, progress_cb=progress)
            self.log("Update downloaded, restarting...")
            apply_update(dest)
        except Exception as e:
            self.log(f"Update failed: {e}")
            self.root.after(0, lambda: messagebox.showerror("Update failed", str(e)))

    def _strip_maximize_button(self, root):
        # This is a fixed-size utility window (resizable(False, False)), so the
        # native maximize control is dead weight -- Windows still draws it
        # (just disabled) unless the WS_MAXIMIZEBOX style bit is removed directly.
        try:
            GWL_STYLE = -16
            WS_MAXIMIZEBOX = 0x00010000
            SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED = 0x2, 0x1, 0x4, 0x20
            hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_STYLE)
            ctypes.windll.user32.SetWindowLongW(hwnd, GWL_STYLE, style & ~WS_MAXIMIZEBOX)
            # GWL_STYLE changes don't repaint the non-client area (titlebar
            # buttons) on their own -- SWP_FRAMECHANGED forces Windows to
            # actually redraw it with the maximize button gone.
            ctypes.windll.user32.SetWindowPos(
                hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
        except Exception:
            pass

    def _detect_monitor_size(self):
        try:
            with mss.mss() as sct:
                m = sct.monitors[1]
                return m["width"], m["height"]
        except Exception:
            return (0, 0)

    def _init_log_tags(self):
        tb = self.log_text
        tb.tag_config("ts", foreground=LOG_TS)
        tb.tag_config("info", foreground=LOG_INFO)
        tb.tag_config("detect", foreground=LOG_DETECT)
        tb.tag_config("error", foreground=LOG_ERROR)
        tb.tag_config("success", foreground=LOG_SUCCESS)

    def build_calibration_chips(self):
        for w in self.chips_frame.winfo_children():
            w.destroy()
        self.chip_widgets = {}
        mode = self.config.get("input_mode", "keyboard")
        templates = load_templates(self.config["template_size"], template_dir_for(mode))
        have = set(templates.keys())
        for label in sorted(REQUIRED_LABELS[mode]):
            done = label in have
            chip = ctk.CTkFrame(
                self.chips_frame, width=36, height=36, corner_radius=8, fg_color=BG_CHIP,
                border_width=2, border_color=GREEN_CHECK if done else BG_CHIP,
            )
            chip.pack(side="left", padx=4)
            chip.pack_propagate(False)
            ctk.CTkLabel(
                chip, text=label, font=ctk.CTkFont(size=13, weight="bold"), text_color=TEXT_PRIMARY,
            ).place(relx=0.5, rely=0.5, anchor="center")
            if done:
                ctk.CTkLabel(
                    chip, text="✓", font=ctk.CTkFont(size=8, weight="bold"), text_color="#04120e",
                    fg_color=GREEN_CHECK, corner_radius=6, width=12, height=12,
                ).place(relx=1.0, rely=0.0, x=-1, y=1, anchor="ne")
            self.chip_widgets[label] = chip

    def update_thumbnail(self):
        region = self.config.get("region")
        if not region:
            self._thumb_image = None
            self.thumb_label.configure(image=None, text="No region\nselected", text_color=TEXT_MUTED)
            return
        try:
            with mss.mss() as sct:
                shot = np.array(sct.grab(region))
            rgb = cv2.cvtColor(shot, cv2.COLOR_BGRA2RGB)
            pil_img = Image.fromarray(rgb)
            pil_img.thumbnail((128, 76))
            cimg = ctk.CTkImage(light_image=pil_img, dark_image=pil_img, size=pil_img.size)
            self._thumb_image = cimg
            self.thumb_label.configure(image=cimg, text="")
        except Exception:
            self._thumb_image = None
            self.thumb_label.configure(image=None, text="Preview\nunavailable", text_color=TEXT_MUTED)

    def refresh_region_buttons(self):
        whole = bool(self.config.get("whole_screen"))
        has_region = bool(self.config.get("region"))
        self.whole_screen_btn.configure(border_color=ACCENT_TEAL if whole else BG_CHIP)
        self.select_region_btn.configure(border_color=ACCENT_TEAL if (has_region and not whole) else BG_CHIP)

    def region_text(self):
        r = self.config.get("region")
        if not r:
            return "No region selected yet"
        if self.config.get("whole_screen"):
            return f"Watching whole screen ({r['width']}x{r['height']})"
        return f"Region set: {r['width']}x{r['height']} at ({r['left']},{r['top']})"

    def step2_title(self):
        mode = self.config.get("input_mode", "keyboard")
        needed = ", ".join(sorted(REQUIRED_LABELS[mode]))
        return f"Step 2: Teach {'digits' if mode == 'keyboard' else 'buttons'} {needed}"

    def on_input_mode_change(self, selected_value):
        mode = self._seg_to_mode.get(selected_value, "keyboard")
        self.config["input_mode"] = mode
        save_config(self.config)
        self.step2_title_label.configure(text=self.step2_title())
        self.build_calibration_chips()
        self.log(f"Mode: {mode}")

    def on_role_change(self, selected_value):
        role = self._seg_to_role.get(selected_value, "civilian")
        self.config["role"] = role
        save_config(self.config)
        self.log(f"Role: {role}")

    def log(self, msg):
        self.log_queue.put(msg)
        # Also persist to disk -- the GUI log box auto-scrolls on every new
        # line, so trying to select/copy text out of it while the game (and
        # the log) is still running is essentially impossible. session.log
        # lets a misfire be reviewed after the fact instead of needing to be
        # caught live. Millisecond precision (not just whole seconds) matters
        # here specifically for the Mash tab -- comparing how long a QTE took
        # to complete across different hold/gap settings, to find the game's
        # real input-registration ceiling, needs sub-second resolution.
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(f"{_timestamp_ms()}  {msg}\n")
        except Exception:
            pass

    def poll_log(self):
        while not self.log_queue.empty():
            msg = self.log_queue.get_nowait()
            self._render_log_line(msg)
        self.root.after(150, self.poll_log)

    def _render_log_line(self, msg):
        tb = self.log_text
        tb.configure(state="normal")
        tb.insert("end", _timestamp_ms() + "  ", "ts")
        lower = msg.lower()
        if lower.startswith("pressed"):
            tag = "detect"
        elif "error" in lower or "could not" in lower or "unavailable" in lower:
            tag = "error"
        elif lower.startswith("captured") or lower.startswith("capture:") or "complete" in lower:
            tag = "success"
        else:
            tag = "info"
        tb.insert("end", msg, tag)
        tb.insert("end", "\n")
        tb.see("end")
        tb.configure(state="disabled")

    def poll_calibration_requests(self):
        if self.calib_dialog is None and not self.calib_request_q.empty():
            cell = self.calib_request_q.get_nowait()
            self.show_calibration_dialog(cell)
        self.root.after(100, self.poll_calibration_requests)

    def show_calibration_dialog(self, cell):
        mode = self.config.get("input_mode", "keyboard")
        choices = DIALOG_BUTTON_CHOICES[mode]

        def respond(ch):
            self.calib_response_q.put(ch)
            if self.calib_dialog is not None:
                self.calib_dialog.destroy()
            self.calib_dialog = None

        dlg = ctk.CTkToplevel(self.root)
        self.calib_dialog = dlg
        dlg.title("Label this tile")
        dlg.configure(fg_color=BG_MAIN)
        dlg.attributes("-topmost", True)
        dlg.resizable(False, False)
        dlg.protocol("WM_DELETE_WINDOW", lambda: respond("s"))

        pil_img = Image.fromarray(cell)
        photo = ctk.CTkImage(light_image=pil_img, dark_image=pil_img, size=(120, 120))
        self._calib_photo = photo  # keep a reference so it isn't garbage collected
        ctk.CTkLabel(dlg, image=photo, text="").pack(padx=12, pady=12)
        prompt = ("Press the digit key this tile shows (or click it below)."
                  if mode == "keyboard" else
                  "Click the controller button this icon shows.")
        ctk.CTkLabel(dlg, text=prompt, text_color=TEXT_SECONDARY, font=ctk.CTkFont(size=11)).pack(pady=(0, 8))

        choice_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        choice_frame.pack(pady=(0, 8))
        for label in choices:
            ctk.CTkButton(
                choice_frame, text=label, width=32, height=26, command=lambda label=label: respond(label),
                fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY, corner_radius=6,
                font=ctk.CTkFont(size=11),
            ).pack(side="left", padx=2)

        action_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        action_frame.pack(pady=(0, 12))
        ctk.CTkButton(
            action_frame, text="Skip", command=lambda: respond("s"),
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY, corner_radius=6,
            height=26, font=ctk.CTkFont(size=11),
        ).pack(side="left", padx=4)
        ctk.CTkButton(
            action_frame, text="Stop Calibration", command=lambda: respond("q"),
            fg_color=ACCENT_RED, hover_color=ACCENT_RED_HOVER, text_color="#1a0505", corner_radius=6,
            height=26, font=ctk.CTkFont(size=11),
        ).pack(side="left", padx=4)

        def on_key(event):
            ch = event.char
            if mode == "keyboard" and ch.isdigit():
                respond(ch)
            elif mode == "controller" and ch.upper() in ("A", "B", "X", "Y"):
                respond(ch.upper())
            elif ch in ("s", "S"):
                respond("s")
            elif ch in ("q", "Q"):
                respond("q")

        dlg.bind("<Key>", on_key)
        dlg.focus_force()
        dlg.grab_set()

    def register_hotkeys(self):
        self._register_hotkey(self.config.get("hotkey_toggle_watch", "f8"), self.toggle_watch)
        self._register_hotkey(self.config.get("hotkey_toggle_calibration", "f7"), self.toggle_calibration)
        self._register_hotkey(self.config.get("hotkey_reboot_watch", "f9"), self.reboot_watch)
        self._register_hotkey(self.config.get("hotkey_toggle_mash_calibration", "f5"), self.toggle_mash_calibration)
        self._register_hotkey(self.config.get("hotkey_toggle_mash_watch", "f6"), self.toggle_mash_watch)

    def _register_hotkey(self, hotkey, action):
        try:
            keyboard.add_hotkey(hotkey, lambda: self.root.after(0, action))
        except Exception as e:
            self.log(f"Error: hotkey {hotkey.upper()} failed ({e}). Try running as administrator.")

    # ---------- Step 1 ----------
    def use_whole_screen(self):
        with mss.mss() as sct:
            monitor = sct.monitors[1]
        self.config["region"] = {
            "left": monitor["left"],
            "top": monitor["top"],
            "width": monitor["width"],
            "height": monitor["height"],
        }
        self.config["whole_screen"] = True
        save_config(self.config)
        self.log(f"Capture: {monitor['width']}x{monitor['height']} (whole screen)")
        self.region_caption.configure(text=self.region_text())
        self.refresh_region_buttons()
        self.update_thumbnail()

    def select_region(self):
        # Runs on the main thread (not a background thread) -- OpenCV's HighGUI
        # windows need to live on the same thread as their event loop, otherwise
        # they can fail to take keyboard/mouse focus, same issue the calibration
        # popup used to have.
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            shot = np.array(sct.grab(monitor))
        img = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)
        box = cv2.selectROI("Drag a box around the tile row, then press ENTER", img, showCrosshair=True)
        cv2.destroyAllWindows()
        x, y, w, h = [int(v) for v in box]
        if w == 0 or h == 0:
            self.log("Region selection cancelled.")
            return
        self.config["region"] = {
            "left": monitor["left"] + x,
            "top": monitor["top"] + y,
            "width": w,
            "height": h,
        }
        self.config["whole_screen"] = False
        save_config(self.config)
        self.log(f"Capture: {w}x{h} region")
        self.region_caption.configure(text=self.region_text())
        self.refresh_region_buttons()
        self.update_thumbnail()

    # ---------- Mash tab: Step 1 ----------
    def mash_region_text(self):
        r = self.config.get("mash_region")
        if not r:
            return "No region selected yet"
        if self.config.get("mash_whole_screen"):
            return f"Watching whole screen ({r['width']}x{r['height']})"
        return f"Region set: {r['width']}x{r['height']} at ({r['left']},{r['top']})"

    def refresh_mash_region_buttons(self):
        whole = bool(self.config.get("mash_whole_screen"))
        has_region = bool(self.config.get("mash_region"))
        self.mash_whole_screen_btn.configure(border_color=ACCENT_TEAL if whole else BG_CHIP)
        self.mash_select_region_btn.configure(border_color=ACCENT_TEAL if (has_region and not whole) else BG_CHIP)

    def use_mash_whole_screen(self):
        # Fixes the case where the mash prompt isn't at a fixed HUD position
        # but anchored to whatever's being interacted with in the world (e.g.
        # V near one door, X near another) -- a small region can only ever
        # catch one of those spots. find_mash_cell already tolerates a loose
        # region by locating the icon box itself, so scanning the whole
        # screen for it works the same way, just over a bigger area.
        with mss.mss() as sct:
            monitor = sct.monitors[1]
        self.config["mash_region"] = {
            "left": monitor["left"],
            "top": monitor["top"],
            "width": monitor["width"],
            "height": monitor["height"],
        }
        self.config["mash_whole_screen"] = True
        save_config(self.config)
        self.log(f"Mash capture: {monitor['width']}x{monitor['height']} (whole screen)")
        self.mash_region_caption.configure(text=self.mash_region_text())
        self.refresh_mash_region_buttons()
        self.update_mash_thumbnail()

    def update_mash_thumbnail(self):
        region = self.config.get("mash_region")
        if not region:
            self._mash_thumb_image = None
            self.mash_thumb_label.configure(image=None, text="No region\nselected", text_color=TEXT_MUTED)
            return
        try:
            with mss.mss() as sct:
                shot = np.array(sct.grab(region))
            rgb = cv2.cvtColor(shot, cv2.COLOR_BGRA2RGB)
            pil_img = Image.fromarray(rgb)
            pil_img.thumbnail((128, 76))
            cimg = ctk.CTkImage(light_image=pil_img, dark_image=pil_img, size=pil_img.size)
            self._mash_thumb_image = cimg
            self.mash_thumb_label.configure(image=cimg, text="")
        except Exception:
            self._mash_thumb_image = None
            self.mash_thumb_label.configure(image=None, text="Preview\nunavailable", text_color=TEXT_MUTED)

    def select_mash_region(self):
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            shot = np.array(sct.grab(monitor))
        img = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)
        box = cv2.selectROI("Drag a TIGHT box around just the icon, then press ENTER", img, showCrosshair=True)
        cv2.destroyAllWindows()
        x, y, w, h = [int(v) for v in box]
        if w == 0 or h == 0:
            self.log("Mash region selection cancelled.")
            return
        self.config["mash_region"] = {
            "left": monitor["left"] + x,
            "top": monitor["top"] + y,
            "width": w,
            "height": h,
        }
        self.config["mash_whole_screen"] = False
        save_config(self.config)
        self.log(f"Mash capture: {w}x{h} region")
        self.mash_region_caption.configure(text=self.mash_region_text())
        self.refresh_mash_region_buttons()
        self.update_mash_thumbnail()

    # ---------- Mash tab: Step 2 ----------
    def build_mash_calibration_chips(self):
        for w in self.mash_chips_frame.winfo_children():
            w.destroy()
        self.mash_chip_widgets = {}
        templates = load_templates(self.config["mash_template_size"], template_dir_for("mash"))
        if not templates:
            ctk.CTkLabel(
                self.mash_chips_frame, text="No icons taught yet", text_color=TEXT_MUTED,
                font=ctk.CTkFont(size=10),
            ).pack(side="left", padx=4)
            return
        for label in sorted(templates.keys()):
            chip = ctk.CTkFrame(
                self.mash_chips_frame, width=36, height=36, corner_radius=8, fg_color=BG_CHIP,
                border_width=2, border_color=GREEN_CHECK,
            )
            chip.pack(side="left", padx=4, pady=4)
            chip.pack_propagate(False)
            ctk.CTkLabel(
                chip, text=label, font=ctk.CTkFont(size=11, weight="bold"), text_color=TEXT_PRIMARY,
            ).place(relx=0.5, rely=0.5, anchor="center")
            self.mash_chip_widgets[label] = chip

    def toggle_mash_calibration(self):
        if self.mash_calibrate_thread and self.mash_calibrate_thread.is_alive():
            self.mash_calibrate_stop.set()
            if self.mash_calib_dialog is not None:
                self.mash_calib_response_q.put("q")
                self.mash_calib_dialog.destroy()
                self.mash_calib_dialog = None
            return
        if not self.config.get("mash_region"):
            messagebox.showwarning("No region", "Select the icon box first (Mash Step 1).")
            return
        self.mash_calibrate_stop.clear()
        self.mash_calibrate_btn.configure(text="Stop Calibration")
        self.mash_calibrate_thread = threading.Thread(target=self.run_mash_calibration, daemon=True)
        self.mash_calibrate_thread.start()

    def run_mash_calibration(self):
        cfg = self.config
        template_dir = template_dir_for("mash")
        size = cfg["mash_template_size"]
        threshold = cfg["mash_match_threshold"]
        min_area = cfg.get("mash_min_cell_area", 150)
        max_refine = cfg.get("mash_max_refine_candidates", 12)
        os.makedirs(template_dir, exist_ok=True)
        templates = load_templates(size, template_dir)
        region = cfg["mash_region"]
        grabber = Grabber(region)
        self.log(f"Mash calibrating: {grabber.backend}, {region['width']}x{region['height']}")
        try:
            while not self.mash_calibrate_stop.is_set():
                shot = grabber.grab()
                if shot is None:
                    time.sleep(0.01)
                    continue
                gray = cv2.cvtColor(shot, cv2.COLOR_BGRA2GRAY)
                cell = find_mash_cell(gray, size, min_area, max_refine)
                if cell is None:
                    time.sleep(0.05)
                    continue
                label, _ = match_digit(cell, templates, threshold)
                if label is not None:
                    time.sleep(0.05)
                    continue
                display = cv2.resize(cell, (200, 200), interpolation=cv2.INTER_NEAREST)
                self.mash_calib_request_q.put(display)
                ch = self.mash_calib_response_q.get()  # blocks until the dialog is answered
                if ch == "q":
                    self.mash_calibrate_stop.set()
                    break
                if ch == "s":
                    time.sleep(0.3)
                    continue
                templates[ch] = cell
                cv2.imwrite(os.path.join(template_dir, f"{ch}.png"), cell)
                self.log(f"Captured '{ch}'.")
                self.root.after(0, self.build_mash_calibration_chips)
                time.sleep(0.3)
        except Exception as e:
            self.log(f"Mash calibration error: {e}")
        finally:
            grabber.close()

        self.root.after(0, lambda: self.mash_calibrate_btn.configure(text="Start Calibration"))
        self.root.after(0, self.build_mash_calibration_chips)

    def poll_mash_calibration_requests(self):
        if self.mash_calib_dialog is None and not self.mash_calib_request_q.empty():
            cell = self.mash_calib_request_q.get_nowait()
            self.show_mash_calibration_dialog(cell)
        self.root.after(100, self.poll_mash_calibration_requests)

    def show_mash_calibration_dialog(self, cell):
        def respond(label):
            self.mash_calib_response_q.put(label)
            if self.mash_calib_dialog is not None:
                self.mash_calib_dialog.destroy()
            self.mash_calib_dialog = None

        dlg = ctk.CTkToplevel(self.root)
        self.mash_calib_dialog = dlg
        dlg.title("Label this icon")
        dlg.configure(fg_color=BG_MAIN)
        dlg.attributes("-topmost", True)
        dlg.resizable(False, False)
        dlg.protocol("WM_DELETE_WINDOW", lambda: respond("s"))

        pil_img = Image.fromarray(cell)
        photo = ctk.CTkImage(light_image=pil_img, dark_image=pil_img, size=(120, 120))
        self._mash_calib_photo = photo  # keep a reference so it isn't garbage collected
        ctk.CTkLabel(dlg, image=photo, text="").pack(padx=12, pady=12)
        ctk.CTkLabel(
            dlg, text="Click the letter/number this icon shows, or MB1/MB2 for a mouse click.",
            text_color=TEXT_SECONDARY, font=ctk.CTkFont(size=11), wraplength=260,
        ).pack(pady=(0, 8))

        # Click-only, not keyboard-only: while the game is the foreground
        # window, Windows blocks this background dialog from programmatically
        # stealing real keyboard focus (SetForegroundWindow restriction), so
        # a pressed letter key silently goes to the game instead of this
        # dialog. A real mouse click, unlike a synthetic focus grab, IS
        # honored regardless of which window nominally has focus -- so a
        # full on-screen keyboard is the only labeling path guaranteed to
        # work without alt-tabbing. <Key> binding below is kept as a bonus
        # for when the dialog does have real focus (e.g. after tabbing in).
        keys_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        keys_frame.pack(pady=(0, 8), padx=12)
        key_cols = 9
        for i, label in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"):
            r, c = divmod(i, key_cols)
            ctk.CTkButton(
                keys_frame, text=label, width=26, height=24, command=lambda label=label: respond(label),
                fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY, corner_radius=4,
                font=ctk.CTkFont(size=10),
            ).grid(row=r, column=c, padx=2, pady=2)

        mouse_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        mouse_frame.pack(pady=(0, 8))
        for label in ("MB1", "MB2"):
            ctk.CTkButton(
                mouse_frame, text=label, width=48, height=26, command=lambda label=label: respond(label),
                fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY, corner_radius=6,
                font=ctk.CTkFont(size=11),
            ).pack(side="left", padx=2)

        action_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        action_frame.pack(pady=(0, 12))
        ctk.CTkButton(
            action_frame, text="Skip", command=lambda: respond("s"),
            fg_color=BG_CHIP, hover_color=BORDER_SUBTLE, text_color=TEXT_PRIMARY, corner_radius=6,
            height=26, font=ctk.CTkFont(size=11),
        ).pack(side="left", padx=4)
        ctk.CTkButton(
            action_frame, text="Stop Calibration", command=lambda: respond("q"),
            fg_color=ACCENT_RED, hover_color=ACCENT_RED_HOVER, text_color="#1a0505", corner_radius=6,
            height=26, font=ctk.CTkFont(size=11),
        ).pack(side="left", padx=4)

        # 's'/'q' aren't used as keyboard shortcuts here (unlike the Main tab
        # dialog) because a legitimate in-game prompt could itself be the
        # letter S or Q -- Skip/Stop are mouse-click-only, and Escape (never
        # a real letter-key prompt) is Stop's keyboard shortcut instead.
        def on_key(event):
            if event.keysym == "Escape":
                respond("q")
                return
            ch = event.char
            if ch and ch.isalnum():
                respond(ch.upper())

        dlg.bind("<Key>", on_key)
        dlg.focus_force()
        dlg.grab_set()

    # ---------- Mash tab: Step 3 ----------
    def toggle_mash_watch(self):
        if self.mash_watch_thread and self.mash_watch_thread.is_alive():
            self.mash_watch_stop.set()
            return
        self._start_mash_watch()

    def _start_mash_watch(self):
        if not self.config.get("mash_region"):
            messagebox.showwarning("No region", "Select the icon box first (Mash Step 1).")
            return
        templates = load_templates(self.config["mash_template_size"], template_dir_for("mash"))
        if not templates:
            messagebox.showwarning("Not calibrated", "Capture at least one icon first (Mash Step 2).")
            return
        self.mash_watch_stop.clear()
        self._mash_active_label = None
        self.mash_watch_btn.configure(
            text="■  Stop", fg_color=ACCENT_RED, hover_color=ACCENT_RED_HOVER, text_color="#210707",
        )
        # Split into two independent loops sharing one flag (self._mash_active_label)
        # instead of one loop that both looks and presses. Coupling them meant
        # every press had to wait for a fresh screen grab + icon search first --
        # measured live at ~35 presses/sec actually reaching the game against a
        # ~100/s config, because a single dropped detection frame (common when
        # scanning the whole screen) stalled pressing entirely until the next
        # capture. Now the detector only ever decides "currently showing: X" or
        # "gone," and the presser mashes at full configured speed reading that
        # flag, with no dependency on how fast/slow a given capture+detect
        # cycle happens to be.
        self.mash_watch_thread = threading.Thread(target=self.run_mash_detect, daemon=True)
        self.mash_press_thread = threading.Thread(target=self.run_mash_press_loop, daemon=True)
        self.mash_watch_thread.start()
        self.mash_press_thread.start()

    def run_mash_detect(self):
        cfg = self.config
        size = cfg["mash_template_size"]
        threshold = cfg["mash_match_threshold"]
        min_area = cfg.get("mash_min_cell_area", 150)
        max_refine = cfg.get("mash_max_refine_candidates", 12)
        poll_s = cfg["mash_poll_interval_ms"] / 1000.0
        miss_tolerance = cfg.get("mash_miss_tolerance", 3)
        region = cfg["mash_region"]
        templates = load_templates(size, template_dir_for("mash"))
        grabber = Grabber(region)
        self.log(f"Mashing: {grabber.backend}, {region['width']}x{region['height']}")
        current = None
        miss_count = 0
        try:
            while not self.mash_watch_stop.is_set():
                shot = grabber.grab()
                if shot is None:
                    time.sleep(poll_s)
                    continue
                gray = cv2.cvtColor(shot, cv2.COLOR_BGRA2GRAY)
                cell = find_mash_cell(gray, size, min_area, max_refine)
                label = None if cell is None else match_digit(cell, templates, threshold)[0]

                if label is None and current is not None:
                    miss_count += 1
                    if miss_count < miss_tolerance:
                        # Ride out a short flicker (a frame where the icon
                        # briefly isn't found -- common scanning the whole
                        # screen) without flipping the presser off for it.
                        time.sleep(poll_s)
                        continue
                    current = None
                    miss_count = 0
                    self._mash_active_label = None
                elif label is not None:
                    miss_count = 0
                    current = label
                    self._mash_active_label = label
                time.sleep(poll_s)
        except Exception as e:
            self.log(f"Mash detection error: {e}")
        finally:
            # Setting this here (not just on manual stop) is what keeps the
            # presser thread from ever running orphaned: a rare DXGI capture
            # error killing this loop used to leave the paired presser
            # thread mashing forever with no detector left to feed it label
            # changes, since the presser only watches this flag, not this
            # thread's liveness -- clicking Run again then stacked a second
            # detector+presser pair on top instead of cleanly restarting,
            # measured live as two presser threads mashing "V" at once. This
            # is a no-op on the normal manual-stop path (the flag is already
            # set, since that's why the loop exited), so it only changes
            # behavior for the crash case.
            self.mash_watch_stop.set()
            self._mash_active_label = None
            grabber.close()

    def run_mash_press_loop(self):
        # Manual stop only: the detector reporting "gone" no longer stops
        # the presser at all -- it only ever LOCKS ONTO a new label when the
        # detector finds one. Vision-based auto-stop kept tripping on
        # detection flicker (icons dropping out for 100-200ms+ at a time,
        # measured live -- longer than any reasonable miss-tolerance window)
        # and cutting mashing short mid-QTE. Once locked onto a label this
        # keeps mashing it no matter what the detector reports, until the
        # user hits Run/F6 again themselves (self.mash_watch_stop).
        cfg = self.config
        hold_s, gap_s = cfg["mash_press_hold_ms"] / 1000.0, cfg["mash_press_gap_ms"] / 1000.0
        active_label = None
        burst_start = None
        burst_presses = 0
        try:
            while not self.mash_watch_stop.is_set():
                seen_label = self._mash_active_label
                if seen_label is not None and seen_label != active_label:
                    active_label = seen_label
                    self.log(f"Mashing {active_label}")
                    burst_start = time.perf_counter()
                    burst_presses = 0
                if active_label is None:
                    time.sleep(0.02)
                    continue
                press_mash_input(active_label, hold_s, gap_s)
                burst_presses += 1
        except Exception as e:
            self.log(f"Mash press error: {e}")

        if active_label is not None:
            # Sent rate over the whole run (not the nominal hold+gap rate)
            # -- this is what actually reached SendInput, so comparing it
            # and how long a run took across different hold/gap settings is
            # how you find the game's real input-registration ceiling: past
            # some sent rate, completion time stops improving.
            elapsed = time.perf_counter() - burst_start
            rate = burst_presses / elapsed if elapsed > 0 else 0.0
            self.log(
                f"Mashing stopped (manual) -- "
                f"sent {burst_presses} presses of {active_label} in {elapsed:.2f}s (~{rate:.0f}/s)"
            )
        else:
            self.log("Mashing stopped.")
        self.root.after(0, lambda: self.mash_watch_btn.configure(
            text="▶  Run", fg_color=ACCENT_TEAL, hover_color=ACCENT_TEAL_HOVER, text_color="#07211d",
        ))

    # ---------- Step 2 ----------
    def toggle_calibration(self):
        if self.calibrate_thread and self.calibrate_thread.is_alive():
            self.calibrate_stop.set()
            if self.calib_dialog is not None:
                self.calib_response_q.put("q")
                self.calib_dialog.destroy()
                self.calib_dialog = None
            return
        if not self.config.get("region"):
            messagebox.showwarning("No region", "Select the screen region first (Step 1).")
            return
        self.calibrate_stop.clear()
        self.calibrate_btn.configure(text="Stop Calibration")
        self.calibrate_thread = threading.Thread(target=self.run_calibration, daemon=True)
        self.calibrate_thread.start()

    def run_calibration(self):
        cfg = self.config
        mode = cfg.get("input_mode", "keyboard")
        required = REQUIRED_LABELS[mode]
        template_dir = template_dir_for(mode)
        size = cfg["template_size"]
        threshold = match_threshold_for(mode, cfg["match_threshold"])
        min_area, tol = cfg["min_cell_area"], cfg["row_cluster_tolerance_px"]
        min_len = cfg.get("min_sequence_length", 2)
        max_refine = cfg.get("max_refine_candidates", 24)
        os.makedirs(template_dir, exist_ok=True)
        templates = load_templates(size, template_dir)
        region = cfg["region"]
        grabber = Grabber(region)
        self.log(f"Calibrating ({mode}): {grabber.backend}, {region['width']}x{region['height']}")
        try:
            while not self.calibrate_stop.is_set():
                if required.issubset(templates.keys()):
                    self.log("Calibration complete.")
                    break
                shot = grabber.grab()
                if shot is None:
                    time.sleep(0.01)
                    continue
                bgr = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)
                gray = cv2.cvtColor(shot, cv2.COLOR_BGRA2GRAY)
                boxes = find_tile_boxes(gray, min_area, max_refine=max_refine)
                rows = cluster_rows(boxes, tol)
                # Only consider plausible, currently-available tile rows (>=min_len
                # same-size boxes in a line, no "requirement not met" warning below)
                # so whole-screen scans don't spam labeling prompts for unrelated UI
                # clutter or for a combo option we'll never actually want to press.
                candidate_rows = [
                    r for r in rows
                    if len(r) >= min_len and row_is_uniform(r) and not row_is_locked(bgr, r)
                ]
                for row in candidate_rows:
                    if self.calibrate_stop.is_set():
                        break
                    for box in row:
                        if self.calibrate_stop.is_set():
                            break
                        cell = crop_cell(gray, box, size, keep_frac=keep_frac_for(mode))
                        digit, _ = match_digit(cell, templates, threshold)
                        if digit is not None:
                            continue
                        display = cv2.resize(cell, (200, 200), interpolation=cv2.INTER_NEAREST)
                        self.calib_request_q.put(display)
                        ch = self.calib_response_q.get()  # blocks until the dialog is answered
                        if ch == "q":
                            self.calibrate_stop.set()
                            break
                        if ch == "s":
                            continue
                        templates[ch] = cell
                        cv2.imwrite(os.path.join(template_dir, f"{ch}.png"), cell)
                        self.log(f"Captured '{ch}'.")
                        self.root.after(0, self.build_calibration_chips)
                time.sleep(0.3)
        except Exception as e:
            self.log(f"Calibration error: {e}")
        finally:
            grabber.close()

        self.root.after(0, lambda: self.calibrate_btn.configure(text="Start Calibration"))
        self.root.after(0, self.build_calibration_chips)

    # ---------- Step 3 ----------
    def toggle_watch(self):
        if self.watch_thread and self.watch_thread.is_alive():
            self.watch_stop.set()
            return
        self._start_watch()

    def reboot_watch(self):
        # Long sessions can apparently degrade (stale capture state, a game
        # resolution/focus change, etc.) -- this is the fix: fully tear down
        # the running watch thread (which also throws away and recreates the
        # Grabber/DXGI duplication interface, since run_watch builds a fresh
        # one every time it starts) and start clean. Runs the stop+join in a
        # background thread so clicking it doesn't freeze the GUI while the
        # old loop winds down.
        def do_reboot():
            if self.watch_thread and self.watch_thread.is_alive():
                self.log("Rebooting watch...")
                self.watch_stop.set()
                self.watch_thread.join(timeout=5)
            self.root.after(0, self._start_watch)
        threading.Thread(target=do_reboot, daemon=True).start()

    def _start_watch(self):
        if not self.config.get("region"):
            messagebox.showwarning("No region", "Select the screen region first (Step 1).")
            return
        mode = self.config.get("input_mode", "keyboard")
        required = REQUIRED_LABELS[mode]
        templates = load_templates(self.config["template_size"], template_dir_for(mode))
        if not required.issubset(templates.keys()):
            messagebox.showwarning("Not calibrated", f"Capture templates for {sorted(required)} first (Step 2).")
            return
        self.watch_stop.clear()
        self.watch_btn.configure(
            text="■  Stop", fg_color=ACCENT_RED, hover_color=ACCENT_RED_HOVER, text_color="#210707",
        )
        self.watch_thread = threading.Thread(target=self.run_watch, daemon=True)
        self.watch_thread.start()

    def run_watch(self):
        cfg = self.config
        mode = cfg.get("input_mode", "keyboard")
        size = cfg["template_size"]
        threshold = match_threshold_for(mode, cfg["match_threshold"])
        min_area, tol = cfg["min_cell_area"], cfg["row_cluster_tolerance_px"]
        role_min, role_max = ROLE_LEN_RANGE.get(cfg.get("role", "civilian"), (None, None))
        min_len = role_min if role_min is not None else cfg.get("min_sequence_length", 2)
        max_len = role_max
        poll_s = cfg["poll_interval_ms"] / 1000.0
        hold_s, gap_s = cfg["key_hold_ms"] / 1000.0, cfg["key_gap_ms"] / 1000.0
        region = cfg["region"]
        templates = load_templates(size, template_dir_for(mode))
        confirm_count = cfg.get("confirm_count", 1)
        max_refine = cfg.get("max_refine_candidates", 24)
        stall_log_s = cfg.get("stall_log_ms", 40) / 1000.0
        last_fired = None
        pending_seq = None
        pending_count = 0
        grabber = Grabber(region)
        self.log(f"Watching ({mode}): {grabber.backend}, {region['width']}x{region['height']}")
        try:
            while not self.watch_stop.is_set():
                t_grab0 = time.perf_counter()
                shot = grabber.grab()
                grab_s = time.perf_counter() - t_grab0
                if shot is None:
                    # DXGI backend only: no new compositor frame since the last
                    # grab, i.e. the screen genuinely hasn't changed. NOT the
                    # same as "no combo visible" -- must not reset pending/
                    # last_fired state, just wait for the next real frame.
                    # A slow *None* grab means the DXGI duplication interface
                    # itself stalled/rebuilt (display mode change or access
                    # lost), not a normal "nothing changed yet" poll -- worth
                    # flagging separately since that's a real, if rare, source
                    # of a late reaction.
                    if grab_s > stall_log_s:
                        self.log(f"[stall] capture reacquire took {grab_s * 1000:.0f}ms")
                    time.sleep(poll_s)
                    continue
                bgr = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)
                gray = cv2.cvtColor(shot, cv2.COLOR_BGRA2GRAY)
                # Scans every row top to bottom (the whole captured area) and
                # returns the first row where every tile is confidently
                # recognized AND the row isn't marked locked (a red "requirement
                # not met" warning beneath it) -- that's the actual combo to act
                # on, ignoring unrelated icons and any unavailable alternatives.
                t_scan0 = time.perf_counter()
                sequence = find_best_full_match_row(
                    gray, templates, min_area, tol, size, threshold, min_len, bgr=bgr,
                    keep_frac=keep_frac_for(mode), max_refine=max_refine, max_len=max_len,
                )
                scan_s = time.perf_counter() - t_scan0
                if grab_s + scan_s > stall_log_s:
                    self.log(
                        f"[stall] frame took {(grab_s + scan_s) * 1000:.0f}ms "
                        f"(grab {grab_s * 1000:.0f}ms, scan {scan_s * 1000:.0f}ms)"
                    )
                if sequence is None:
                    last_fired = None
                    pending_seq = None
                    pending_count = 0
                else:
                    seq_key = tuple(sequence)
                    if seq_key == last_fired:
                        pending_seq = None
                        pending_count = 0
                    else:
                        # Require the SAME reading several polls in a row before acting on
                        # it. A single unstable frame (one tile briefly misread/dropped due
                        # to a UI glow/animation) used to look identical to "the combo
                        # legitimately changed," causing the tool to re-press a sequence
                        # that never actually changed (observed live: "1 2 1" -> "2 1" ->
                        # back to "1 2 1", pressed three times for one on-screen combo).
                        # Requiring confirmation filters that flicker out.
                        if seq_key == pending_seq:
                            pending_count += 1
                        else:
                            pending_seq = seq_key
                            pending_count = 1

                        if pending_count >= confirm_count:
                            self.log(f"Pressed {','.join(sequence)}")
                            for label in sequence:
                                # Controller mode reads Xbox-style A/B/X/Y icons but
                                # presses the mapped keyboard key -- see CONTROLLER_KEY_MAP.
                                key = CONTROLLER_KEY_MAP[label] if mode == "controller" else label
                                pydirectinput.keyDown(key)
                                time.sleep(hold_s)
                                pydirectinput.keyUp(key)
                                time.sleep(gap_s)
                            last_fired = seq_key
                            pending_seq = None
                            pending_count = 0
                time.sleep(poll_s)
        except Exception as e:
            self.log(f"Watching error: {e}")
        finally:
            grabber.close()

        self.log("Watching stopped.")
        self.root.after(0, lambda: self.watch_btn.configure(
            text="▶  Run", fg_color=ACCENT_TEAL, hover_color=ACCENT_TEAL_HOVER, text_color="#07211d",
        ))

    def on_close(self):
        self.watch_stop.set()
        self.calibrate_stop.set()
        self.mash_watch_stop.set()
        self.mash_calibrate_stop.set()
        if sys.platform == "win32":
            try:
                ctypes.windll.winmm.timeEndPeriod(1)
            except Exception:
                pass
        try:
            keyboard.unhook_all()
        except Exception:
            pass
        self.root.destroy()


if __name__ == "__main__":
    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("dark-blue")
    root = ctk.CTk()
    App(root)
    root.mainloop()
