"""Screen capture backend for the watch/calibration loops.

Prefers DXGI desktop duplication (via `bettercam`), which reads frames
straight from the GPU compositor instead of round-tripping through GDI's
BitBlt like `mss` does. Measured on this machine: mss pays ~8.4ms per grab
*every* call regardless of whether the screen changed, while bettercam
returns in ~0.05ms when there's no new frame yet and only pays a real cost
when a frame actually changed -- which is exactly the shape of a polling
loop watching for a combo row to appear. Falls back to mss automatically if
DXGI duplication isn't available (e.g. some VMs/remote sessions).
"""
import numpy as np
import mss

try:
    import bettercam
    _BETTERCAM_AVAILABLE = True
except Exception:
    bettercam = None
    _BETTERCAM_AVAILABLE = False


def _region_to_ltrb(region):
    return (
        region["left"],
        region["top"],
        region["left"] + region["width"],
        region["top"] + region["height"],
    )


class Grabber:
    """Grabs a fixed screen region as a BGRA numpy array (same shape/dtype
    mss produces), transparently using DXGI duplication when available.

    grab() returns None when the backend has no new frame since the last
    call (DXGI only, meaning the screen genuinely hasn't changed) --
    callers should treat that as "nothing new to look at yet", not as
    "no combo visible", and just poll again.
    """

    def __init__(self, region):
        self.region = region
        self.backend = "mss"
        self._camera = None
        self._mss = None
        if _BETTERCAM_AVAILABLE:
            try:
                camera = bettercam.create(output_color="BGRA")
                camera.grab(region=_region_to_ltrb(region))  # probe: raises on unsupported setups
                self._camera = camera
                self.backend = "dxgi"
            except Exception:
                self._camera = None
        if self.backend != "dxgi":
            self._mss = mss.mss()

    def grab(self):
        if self.backend == "dxgi":
            return self._camera.grab(region=_region_to_ltrb(self.region))
        return np.array(self._mss.grab(self.region))

    def close(self):
        if self._camera is not None:
            self._camera = None  # bettercam camera has no explicit close; let it be GC'd
        if self._mss is not None:
            self._mss.close()
            self._mss = None
