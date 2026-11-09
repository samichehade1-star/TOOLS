"""Media Converter (SE Visuals): paste a link (YouTube, Instagram, Facebook, TikTok and ~1,700 other sites) and save it as MP3, MP4, etc.,
optionally only a part of it; convert a file on the PC to another format; play a file and cut a part out of it (Player tab).

Pieces:
- the window is ui.html shown borderless by pywebview (Edge WebView2); the page draws its own title bar, minimize and close.
- downloads use yt-dlp. Sites change often, so the app keeps yt-dlp up to date by itself: it fetches the official wheel from PyPI
  (sha256 checked) into %APPDATA%\\MediaConverter\\engine and loads that instead of the copy built into the exe (EngineFinder).
- converting / trimming use ffmpeg.exe from next to the exe (else PATH). Update zips leave ffmpeg.exe alone.
- app updates: GitHub Releases of UPDATE_REPO (same scheme as Sami's other TOOLS apps): MediaConverter.zip = the onedir build
  folder without ffmpeg.exe, extracted over the install folder by a helper .bat once this process has exited.
Use only on content you own or have permission to download."""
import glob
import hashlib
import http.server
import importlib.machinery
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request

APP_NAME = "Media Converter"
APP_VERSION = "1.0.0"
UPDATE_REPO = "samichehade1-star/media-converter"
UPDATE_ASSET_NAME = "MediaConverter.zip"
USER_AGENT = "MediaConverter-UpdateCheck"

FROZEN = getattr(sys, "frozen", False)
HERE = os.path.dirname(sys.executable if FROZEN else os.path.abspath(__file__))
RES = getattr(sys, "_MEIPASS", HERE)
DATA = os.path.join(os.environ.get("APPDATA", HERE), "MediaConverter")
SETTINGS = os.path.join(DATA, "settings.json")
ENGINE_DIR = os.path.join(DATA, "engine")
PREVIEW_DIR = os.path.join(tempfile.gettempdir(), "MediaConverterPreview")
AUDIO = ["mp3", "m4a", "wav", "flac", "ogg", "opus"]
VIDEO = ["mp4", "mkv", "webm", "mov", "avi", "gif"]
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
GIF_FILTER = "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"
MIME = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm", ".mov": "video/mp4", ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac"}


def vtuple(v):
    return tuple(int("".join(c for c in p if c.isdigit()) or 0) for p in str(v).lstrip("vV").split("."))


# ---------- yt-dlp engine: newest downloaded wheel wins over the built-in copy ----------
def newest_engine():
    wheels = sorted(glob.glob(os.path.join(ENGINE_DIR, "yt_dlp-*-py3-none-any.whl")), key=lambda p: vtuple(os.path.basename(p).split("-")[1]))
    return wheels[-1] if wheels else None


class EngineFinder:
    """Loads yt_dlp and all its submodules from the wheel (a zip) - placed first on sys.meta_path so it beats PyInstaller's bundled copy."""
    def __init__(self, wheel):
        self.wheel = wheel

    def find_spec(self, name, path=None, target=None):
        if name == "yt_dlp":
            return importlib.machinery.PathFinder.find_spec(name, [self.wheel])
        if name.startswith("yt_dlp."):
            return importlib.machinery.PathFinder.find_spec(name, path)
        return None


_wheel = newest_engine()
if _wheel:
    sys.meta_path.insert(0, EngineFinder(_wheel))
try:
    import yt_dlp
    from yt_dlp.utils import download_range_func
except Exception:   # a broken downloaded engine must never stop the app: drop it, use the built-in one
    if _wheel:
        sys.meta_path[:] = [f for f in sys.meta_path if not isinstance(f, EngineFinder)]
        for k in [k for k in sys.modules if k == "yt_dlp" or k.startswith("yt_dlp.")]:
            del sys.modules[k]
        try:
            os.remove(_wheel)
        except OSError:
            pass
    import yt_dlp
    from yt_dlp.utils import download_range_func

import webview  # noqa: E402
from webview.dom import DOMEventHandler  # noqa: E402


def find_ffmpeg():
    local = os.path.join(HERE, "ffmpeg.exe")
    return local if os.path.isfile(local) else shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()


def ffmpeg_version():
    if not FFMPEG:
        return None
    r = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)
    m = re.search(r"ffmpeg version (\S+)", r.stdout)
    return m.group(1).split("-")[0] if m else "found"


def probe(src):
    """{duration, video, vcodec, acodec} from ffmpeg's own banner - no ffprobe needed."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", src], capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)
    info = {"duration": 0.0, "video": False, "vcodec": "", "acodec": ""}
    for line in r.stderr.splitlines():
        if "Duration:" in line:
            try:
                h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
                info["duration"] = int(h) * 3600 + int(m) * 60 + float(s)
            except ValueError:
                pass
        mv = re.search(r"Video: (\w+)", line)
        if mv and "attached pic" not in line and not info["video"]:
            info["video"], info["vcodec"] = True, mv.group(1)
        ma = re.search(r"Audio: (\w+)", line)
        if ma and not info["acodec"]:
            info["acodec"] = ma.group(1)
    return info


def parse_time(t):
    """'83', '1:23', '01:02:03.5' -> seconds; '' -> None."""
    t = str(t or "").strip().replace(",", ".")
    if not t:
        return None
    try:
        secs = 0.0
        for part in t.split(":"):
            secs = secs * 60 + float(part)
        return secs
    except ValueError:
        raise ValueError(f'"{t}" is not a time. Use seconds (83) or minutes:seconds (1:23) or h:mm:ss (1:02:03).')


def clock(sec, ms=False):
    if sec is None or sec < 0:
        return "--:--"
    whole = int(sec)
    s = f"{whole // 3600}:{whole % 3600 // 60:02d}:{whole % 60:02d}" if whole >= 3600 else f"{whole // 60:02d}:{whole % 60:02d}"
    return s + f".{int((sec - whole) * 10)}" if ms else s


def free_name(folder, base, ext, avoid=None):
    base = re.sub(r'[<>:"/\\|?*]', "_", base).strip() or "file"
    dst, n = os.path.join(folder, f"{base}.{ext}"), 1
    while os.path.exists(dst) or (avoid and os.path.abspath(dst) == os.path.abspath(avoid)):
        dst, n = os.path.join(folder, f"{base} ({n}).{ext}"), n + 1
    return dst


# ---------- local media server for the Player (only the one file the person opened, with Range support for seeking) ----------
class MediaServer:
    def __init__(self):
        self.files = {}
        srv = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                key = urllib.parse.urlparse(self.path).path.strip("/").split("/")[0]
                path = srv.files.get(key)
                if not path or not os.path.isfile(path):
                    self.send_error(404)
                    return
                size = os.path.getsize(path)
                start, end = 0, size - 1
                rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
                if rng:
                    if rng.group(1):
                        start = int(rng.group(1))
                        end = int(rng.group(2)) if rng.group(2) else end
                    elif rng.group(2):
                        start = max(0, size - int(rng.group(2)))
                    end = min(end, size - 1)
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                else:
                    self.send_response(200)
                self.send_header("Content-Type", MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    with open(path, "rb") as f:
                        f.seek(start)
                        left = end - start + 1
                        while left > 0:
                            chunk = f.read(min(1 << 16, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                except (ConnectionError, OSError):
                    pass

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.httpd = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url_for(self, path):
        key = hashlib.sha1(f"{path}{os.path.getmtime(path)}".encode()).hexdigest()[:16]
        self.files = {key: path}   # only ever the current file
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/{key}/{urllib.parse.quote(os.path.basename(path))}"


# ---------- app updates (GitHub Releases), same scheme as the other TOOLS apps ----------
def check_for_update(timeout=6):
    """(version, download_url) if a newer release than APP_VERSION is published, else None. Never raises."""
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
                                     headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
        tag = data.get("tag_name", "")
        if tag and vtuple(tag) > vtuple(APP_VERSION):
            for asset in data.get("assets", []):
                if asset.get("name") == UPDATE_ASSET_NAME:
                    return tag.lstrip("vV"), asset.get("browser_download_url")
    except Exception:
        pass
    return None


def download_to(url, dest, progress_cb=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
        total, done = int(resp.headers.get("Content-Length", 0)), 0
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if progress_cb and total:
                progress_cb(done * 100 / total)


def apply_update(zip_path):
    """Hands off to a detached .bat that waits for this process to exit, extracts the zip over the install folder, relaunches, deletes itself."""
    exe, pid = sys.executable, os.getpid()
    bat = os.path.join(tempfile.gettempdir(), "mediaconverter_update.bat")
    with open(bat, "w") as f:
        f.write("@echo off\r\n:wait\r\n"
                f'tasklist /fi "PID eq {pid}" | find "{pid}" >nul\r\n'
                "if not errorlevel 1 (\r\n    timeout /t 1 /nobreak >nul\r\n    goto wait\r\n)\r\n"
                f"powershell -NoProfile -Command \"Expand-Archive -LiteralPath '{zip_path}' -DestinationPath '{os.path.dirname(exe)}' -Force\"\r\n"
                f'del "{zip_path}"\r\nstart "" "{exe}"\r\ndel "%~f0"\r\n')
    subprocess.Popen(["cmd", "/c", bat], creationflags=NO_WINDOW)
    os._exit(0)


def check_engine_update(timeout=8):
    """Downloads a newer yt-dlp wheel from PyPI (sha256 checked) into ENGINE_DIR. Returns the new version, or None. Never raises."""
    try:
        req = urllib.request.Request("https://pypi.org/pypi/yt-dlp/json", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            d = json.load(resp)
        latest = d["info"]["version"]
        if vtuple(latest) <= vtuple(yt_dlp.version.__version__):
            return None
        whl = next(u for u in d["urls"] if u["packagetype"] == "bdist_wheel" and u["filename"].endswith("-py3-none-any.whl"))
        os.makedirs(ENGINE_DIR, exist_ok=True)
        dest = os.path.join(ENGINE_DIR, whl["filename"])
        if not os.path.isfile(dest):
            part = dest + ".part"
            download_to(whl["url"], part, timeout=60)
            if hashlib.sha256(open(part, "rb").read()).hexdigest() != whl["digests"]["sha256"]:
                os.remove(part)
                return None
            os.replace(part, dest)
        for old in glob.glob(os.path.join(ENGINE_DIR, "yt_dlp-*.whl")):   # keep the newest two (the one in use + the new one)
            if old not in (dest, _wheel):
                try:
                    os.remove(old)
                except OSError:
                    pass
        return latest
    except Exception:
        return None


class Api:
    def __init__(self):
        self._window = None
        self._busy = False
        self._update_url = None
        self._media = MediaServer()
        self._settings = {"out": os.path.join(os.path.expanduser("~"), "Music")}
        try:
            self._settings.update(json.load(open(SETTINGS, encoding="utf-8")))
        except (OSError, ValueError):
            pass

    # ---------- talking to the page ----------
    def _js(self, fn, *args):
        if self._window:
            try:
                self._window.evaluate_js(f"{fn}(...{json.dumps(list(args))})")
            except Exception:
                pass

    def _log(self, kind, text):
        self._js("appendLog", kind, text)

    def _progress(self, pct, status=None, speed=None, eta=None):
        self._js("setProgress", round(max(0, min(100, pct)), 1), status, speed, eta)

    def _save(self):
        try:
            os.makedirs(DATA, exist_ok=True)
            json.dump(self._settings, open(SETTINGS, "w", encoding="utf-8"))
        except OSError:
            pass

    # ---------- window (the page has no Windows title bar) ----------
    def minimize(self):
        self._window.minimize()

    def close(self):
        shutil.rmtree(PREVIEW_DIR, ignore_errors=True)
        self._window.destroy()

    def fit(self, height):
        """The page asks for the height its content needs (it changes per tab); capped to the screen."""
        try:
            screen = webview.screens[0]
            h = int(min(max(height, 400), screen.height - 40))
            if abs(h - self._window.height) > 2:
                self._window.resize(self._window.width, h)
        except Exception:
            pass

    # ---------- called from the page ----------
    def state(self):
        return {"out": self._settings["out"], "ffmpeg": ffmpeg_version(), "ytdlp": yt_dlp.version.__version__, "version": APP_VERSION,
                "frozen": FROZEN, "engine_updated": bool(yt_dlp.__file__ and ".whl" in yt_dlp.__file__)}

    def browse_out(self):
        r = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=self._settings["out"])
        if r:
            self._settings["out"] = r[0]
            self._save()
        return self._settings["out"]

    def open_out(self):
        os.makedirs(self._settings["out"], exist_ok=True)
        os.startfile(self._settings["out"])

    def choose_file(self):
        r = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=(
            "Media files (" + ";".join("*." + e for e in AUDIO + VIDEO + ["aac", "wma", "m4v", "3gp", "flv", "wmv", "ts"]) + ")", "All files (*.*)"))
        return self.file_info(r[0]) if r else None

    def choose_picture(self):
        r = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=("Pictures (*.jpg;*.jpeg;*.png;*.bmp;*.webp)", "All files (*.*)"))
        return r[0] if r else None

    def file_info(self, path):
        if not path or not os.path.isfile(path):
            return None
        info = probe(path) if FFMPEG else {"duration": 0, "video": False}
        return {"path": path, "name": os.path.basename(path), "size": f"{os.path.getsize(path) / 1048576:.1f} MB",
                "kind": ("Video" if info["video"] else "Audio") + (f" • {clock(info['duration'])}" if info["duration"] else ""),
                "video": info["video"], "duration": info["duration"]}

    def clipboard(self):
        r = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"], capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)
        return (r.stdout or "").strip()

    def check_time(self, t):
        """For the page: '' -> None, valid -> seconds, invalid -> the error text."""
        try:
            return {"ok": True, "sec": parse_time(t)}
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    # ---------- player ----------
    def media_url(self, path):
        """A URL the page's <video> can play. Formats the browser cannot play (AVI, WMV, HEVC, ...) get a quick preview copy first;
        trimming still cuts the original file."""
        info = probe(path)
        ext = os.path.splitext(path)[1].lower()
        playable_v = info["vcodec"] in ("h264", "vp8", "vp9", "av1", "")
        playable_a = info["acodec"] in ("aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "")
        if ext in MIME and playable_v and playable_a:
            return {"url": self._media.url_for(path), "preview": False}
        os.makedirs(PREVIEW_DIR, exist_ok=True)
        prev = os.path.join(PREVIEW_DIR, hashlib.sha1(path.encode()).hexdigest()[:12] + (".mp4" if info["video"] else ".m4a"))
        if not os.path.isfile(prev):
            self._log("INFO", "This format can't play in the app directly - making a quick preview copy (the cut uses the original)...")
            cmd = [FFMPEG, "-hide_banner", "-y", "-i", path]
            cmd += (["-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p"] if info["video"] else ["-vn"])
            cmd += ["-c:a", "aac", "-b:a", "160k", prev]
            if subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW).returncode != 0:
                return {"error": "This file could not be opened for playback."}
        return {"url": self._media.url_for(prev), "preview": True}

    def start_trim(self, src, fmt, start, end, fast):
        return self._start(self._trim, src, fmt, start, end, fast)

    # ---------- jobs ----------
    def start_download(self, url, fmt, quality, start, end):
        return self._start(self._download, url.strip(), fmt, quality, start, end)

    def start_convert(self, src, fmt, img):
        return self._start(self._convert, src, fmt, img or "")

    def _start(self, fn, *args):
        if self._busy:
            return "busy"
        if not FFMPEG:
            self._log("ERROR", "ffmpeg is missing. Put ffmpeg.exe next to this app or run: winget install ffmpeg")
            return "no-ffmpeg"
        os.makedirs(self._settings["out"], exist_ok=True)
        self._busy = True

        def run():
            try:
                result = fn(*args)
                self._js("finished", True, result)
            except Exception as e:   # one failure must never kill the app
                msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
                self._log("ERROR", msg)
                self._js("finished", False, None)
            finally:
                self._busy = False
        threading.Thread(target=run, daemon=True).start()
        return "started"

    def _download(self, url, fmt, quality, start, end):
        out = self._settings["out"]
        t0, t1 = parse_time(start), parse_time(end)
        if t0 is not None and t1 is not None and t1 <= t0:
            raise ValueError("The end time must be after the start time.")
        part = f", {clock(t0 or 0)} to {clock(t1) if t1 is not None else 'end'}" if t0 is not None or t1 is not None else ""
        self._log("START", f"{url}  →  {fmt.upper()} ({quality}{part})")
        self._progress(0, "Fetching info...")

        def hook(d):
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                speed = d.get("speed")
                self._progress(d["downloaded_bytes"] * 100 / total if total else 0, "Downloading...",
                               f"{speed / 1048576:.1f} MB/s" if speed else None, clock(d.get("eta")))
            elif d["status"] == "finished":
                self._progress(100, "Finishing the file...", "", "")

        opts = {"outtmpl": os.path.join(out, "%(title).150B [%(id)s]" + (" (part)" if part else "") + ".%(ext)s"), "noplaylist": True,
                "quiet": True, "no_warnings": True, "progress_hooks": [hook], "ffmpeg_location": FFMPEG, "windowsfilenames": True}
        if part:   # only the chosen part is downloaded; cuts land exactly on the times asked for
            opts["download_ranges"] = download_range_func(None, [(t0 or 0, t1 if t1 is not None else float("inf"))])
            opts["force_keyframes_at_cuts"] = True
        if fmt in AUDIO:
            opts["format"] = "bestaudio/best"
            opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": quality if quality.isdigit() else "320"}]
        else:
            h = "" if not quality.endswith("p") else f"[height<={quality[:-1]}]"
            vfmt = "mp4" if fmt in ("gif", "avi") else fmt
            if vfmt == "mp4":   # H.264/AAC first so the file plays everywhere (Windows, phones, TVs)
                opts["format"] = f"bv*{h}[vcodec^=avc]+ba[ext=m4a]/bv*{h}+ba/b{h}/b"
            else:
                opts["format"] = f"bv*{h}+ba/b{h}/b"
            opts["merge_output_format"] = vfmt
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = (info.get("requested_downloads") or [{}])[0].get("filepath") or ydl.prepare_filename(info)
        title = info.get("title") or "file"
        if fmt in ("gif", "avi"):   # these two are made from the downloaded MP4
            self._log("INFO", f"Downloaded, making the {fmt.upper()}...")
            mp4 = path
            path = self._ffmpeg(mp4, fmt, "")
            try:
                os.remove(mp4)
            except OSError:
                pass
        self._progress(100, "Finished", "Complete", "00:00")
        self._log("DONE", f"{title} ({fmt}) saved in {out}")
        self._js("clearUrl")
        return path

    def _convert(self, src, fmt, img):
        self._log("START", f'Converting "{os.path.basename(src)}"  →  .{fmt}')
        dst = self._ffmpeg(src, fmt, img)
        self._progress(100, "Finished", "Complete", "00:00")
        self._log("DONE", f"{os.path.basename(dst)} saved in {os.path.dirname(dst)}")
        return dst

    def _trim(self, src, fmt, start, end, fast):
        t0, t1 = parse_time(start) or 0.0, parse_time(end)
        info = probe(src)
        if info["duration"] and t0 >= info["duration"]:
            raise ValueError(f"The start ({clock(t0)}) is past the end of the file (it is {clock(info['duration'])} long).")
        if t1 is None or t1 > info["duration"] > 0:
            t1 = info["duration"]
        if t1 is not None and t1 <= t0:
            raise ValueError("The end of the cut must be after its start.")
        fmt = fmt or os.path.splitext(src)[1].lstrip(".").lower()
        base = f"{os.path.splitext(os.path.basename(src))[0]} (cut {clock(t0).replace(':', '.')}-{clock(t1).replace(':', '.')})"
        self._log("START", f'Cutting "{os.path.basename(src)}" {clock(t0, True)} to {clock(t1, True)}  →  .{fmt}' + (" (fast)" if fast else ""))
        same = fmt == os.path.splitext(src)[1].lstrip(".").lower()
        if fast and same and fmt != "gif":   # no re-encode: instant, but the start snaps to the nearest keyframe before it
            dst = free_name(self._settings["out"], base, fmt, avoid=src)
            cmd = [FFMPEG, "-hide_banner", "-y", "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}", "-i", src, "-map", "0", "-c", "copy",
                   "-avoid_negative_ts", "make_zero", dst]
            r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)
            if r.returncode != 0:
                raise RuntimeError("ffmpeg could not cut this file. " + (r.stderr.strip().splitlines()[-1] if r.stderr.strip() else ""))
        else:
            dst = self._ffmpeg(src, fmt, "", t0=t0, t1=t1, base=base)
        self._progress(100, "Finished", "Complete", "00:00")
        self._log("DONE", f"{os.path.basename(dst)} saved in {os.path.dirname(dst)}")
        return dst

    def _ffmpeg(self, src, fmt, img, t0=None, t1=None, base=None):
        out = self._settings["out"]
        dst = free_name(out, base or os.path.splitext(os.path.basename(src))[0], fmt, avoid=src)
        info = probe(src)
        total = (t1 if t1 is not None else info["duration"]) - (t0 or 0)
        cut = (["-ss", f"{t0:.3f}"] if t0 else []) + (["-to", f"{t1:.3f}"] if t1 is not None else [])
        cmd = [FFMPEG, "-hide_banner", "-y"]
        if fmt in AUDIO:
            cmd += cut + ["-i", src, "-vn"] + {"mp3": ["-c:a", "libmp3lame", "-b:a", "320k"], "m4a": ["-c:a", "aac", "-b:a", "256k"],
                                               "wav": ["-c:a", "pcm_s16le"], "flac": ["-c:a", "flac"], "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
                                               "opus": ["-c:a", "libopus", "-b:a", "160k"]}[fmt]
        elif fmt == "gif":
            if not info["video"]:
                raise RuntimeError("A GIF needs a video to start from - this file is audio only.")
            cmd += cut + ["-i", src, "-filter_complex", GIF_FILTER, "-loop", "0"]
        elif info["video"]:
            cmd += cut + ["-i", src] + {"webm": ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus"]}.get(
                fmt, ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"])
            if fmt in ("mp4", "mov"):
                cmd += ["-movflags", "+faststart"]
        else:   # audio -> video: a still picture (or black) for the whole song
            if img and os.path.isfile(img):
                cmd += ["-loop", "1", "-i", img] + cut + ["-i", src]
                vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
            else:
                cmd += ["-f", "lavfi", "-i", "color=c=black:s=1280x720:r=1"] + cut + ["-i", src]
                vf = "format=yuv420p"
            vcodec = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-c:a", "libopus"] if fmt == "webm" else \
                ["-c:v", "libx264", "-tune", "stillimage", "-preset", "medium", "-c:a", "aac", "-b:a", "192k"]
            cmd += ["-map", "0:v", "-map", "1:a", "-vf", vf, "-r", "1"] + vcodec + ["-shortest"]
        cmd += ["-progress", "pipe:1", "-nostats", dst]
        self._progress(0, "Converting...")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", creationflags=NO_WINDOW)
        err = []
        threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
        done, speed = 0.0, None
        for line in p.stdout:
            key, _, val = line.strip().partition("=")
            if key == "out_time_us" and val.isdigit():
                done = int(val) / 1e6
            elif key == "speed" and val.endswith("x"):
                try:
                    speed = float(val[:-1])
                except ValueError:
                    pass
            elif key == "progress" and total > 0:
                eta = (total - done) / speed if speed else None
                self._progress(min(99, done * 100 / total), "Converting...", f"{speed:.1f}x" if speed else None, clock(eta))
        if p.wait() != 0:
            try:
                os.remove(dst)
            except OSError:
                pass
            raise RuntimeError("ffmpeg could not convert this file. " + " ".join(line.strip() for line in err[-2:]))
        return dst

    # ---------- updates ----------
    def check_updates(self, quiet=False):
        def run():
            found = check_for_update()
            if found:
                version, self._update_url = found
                self._js("updateAvailable", version)
            elif not quiet:
                self._js("toast", f"You're on the latest version (v{APP_VERSION}).")
            new_engine = check_engine_update()
            if new_engine:
                self._log("INFO", f"Download engine updated to yt-dlp {new_engine}. It is used the next time you open the app.")
        threading.Thread(target=run, daemon=True).start()

    def install_update(self):
        if not FROZEN:
            self._log("WARN", "Running from source - update with git instead.")
            return
        if not self._update_url or self._busy:
            return
        self._busy = True

        def run():
            try:
                dest = os.path.join(tempfile.gettempdir(), "MediaConverter_update.zip")
                self._log("INFO", "Downloading the update...")
                download_to(self._update_url, dest, lambda pct: self._progress(pct, "Downloading update..."))
                self._log("INFO", "Update downloaded - restarting.")
                apply_update(dest)
            except Exception as e:
                self._busy = False
                self._log("ERROR", f"Update failed: {e}")
        threading.Thread(target=run, daemon=True).start()


def on_ready(window, api):
    api._window = window
    window.events.loaded.wait(30)   # touching window.dom before the page has loaded deadlocks the WinForms backend

    def on_drop(e):
        files = e.get("dataTransfer", {}).get("files", [])
        info = api.file_info(files[0].get("pywebviewFullPath") if files else None)
        if info:
            api._js("droppedFile", info)
        else:
            api._log("WARN", "Drop a media file from your PC.")

    window.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True)
    window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)


def main():
    api = Api()
    window = webview.create_window(APP_NAME, os.path.join(RES, "ui.html"), js_api=api, width=880, height=860, min_size=(640, 400),
                                   frameless=True, easy_drag=False, background_color="#0d1117")
    # private_mode: no browser cache, so an updated ui.html always shows (settings live in settings.json, not in the browser)
    webview.start(on_ready, (window, api), private_mode=True, icon=os.path.join(RES, "assets", "icon.ico"))


if __name__ == "__main__":
    main()
