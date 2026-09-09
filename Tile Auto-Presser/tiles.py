"""Shared tile-detection helpers used by calibrate.py and watcher.py."""
import cv2
import numpy as np


def find_tile_boxes(gray, min_area, detect_scale=0.5, max_refine=60, invert=False):
    """Find bright rounded-rectangle tile boxes in a grayscale image.

    Returns a list of (x, y, w, h) boxes in the ORIGINAL (full-resolution)
    coordinate space, unsorted.

    Detection runs on a downscaled copy: on a full 1080p whole-screen capture,
    findContours alone sees ~3500+ raw contours (UI text, icons, noise) and
    costs 25ms+; halving the resolution cuts both the threshold and contour
    cost roughly 4x while still resolving tiles that are tens of pixels
    across. The actual digit/icon matching still happens against the
    full-resolution image (see crop_cell), so recognition accuracy is
    unaffected -- only the cheap candidate-box search is downscaled.

    max_refine guards against a real pathology measured live: a busy
    whole-screen capture with a lot of other square-ish UI (a player list,
    HUD icons, spectator avatars) can produce dozens of approximate
    candidates, and _refine_boxes does one real adaptiveThreshold+findContours
    call PER candidate -- that's what turned a ~7ms scan into a measured
    230ms+ average (worst case 856ms) once candidate count climbed into the
    dozens, which is slow enough for the on-screen combo to have changed by
    the time a poll finishes, causing exactly the misreads that motivated
    this guard. Past max_refine candidates, this skips the per-candidate
    refinement pass entirely and uses the cheap downscaled-then-upscaled
    coordinates as-is (a few pixels less precise, but still accurate enough
    for row clustering/matching) rather than let one cluttered frame stall
    the whole watch loop.
    """
    if detect_scale != 1.0:
        small = cv2.resize(gray, None, fx=detect_scale, fy=detect_scale, interpolation=cv2.INTER_AREA)
    else:
        small = gray

    # Tiles are light/cream on a locally darker background. A single global
    # threshold (e.g. Otsu) works on a tightly-cropped region but falls apart
    # on a whole-screen capture, where brightness varies wildly across the
    # desktop -- adaptive thresholding compares each pixel to its own local
    # neighborhood instead, so it isolates tiles regardless of what else is
    # on screen. MEAN (box-filter, integral-image based) is used instead of
    # GAUSSIAN -- roughly 3x faster and equally effective here.
    # invert=True flips this to find a DARK box on a lighter background
    # instead -- some prompts (e.g. a mouse-click icon) are a dark tile with
    # a light glyph rather than the light tile the digit/controller icons use.
    block_size = 11  # must be odd; tuned for the downscaled resolution
    thresh_type = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    thresh = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, thresh_type, block_size, -10
    )
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    inv = 1.0 / detect_scale
    min_area_scaled = min_area * detect_scale * detect_scale
    approx_boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = w * h
        if area < min_area_scaled:
            continue
        aspect = w / float(h)
        if aspect < 0.7 or aspect > 1.4:
            continue
        approx_boxes.append((int(x * inv), int(y * inv), int(w * inv), int(h * inv)))

    if detect_scale == 1.0 or len(approx_boxes) > max_refine:
        return approx_boxes
    return _refine_boxes(gray, approx_boxes, min_area, invert=invert)


def _refine_boxes(gray, approx_boxes, min_area, pad=6, invert=False):
    """Re-locate each approximate (downscaled-then-upscaled) box precisely
    within a small full-resolution patch around it. The cheap downscaled pass
    gets rows/positions right but each box can land a couple pixels off,
    which is enough to noticeably hurt template-match confidence -- this
    costs almost nothing extra since it only touches the handful of real
    candidates, not the whole screen.
    """
    refined = []
    h_img, w_img = gray.shape[:2]
    for (x, y, w, h) in approx_boxes:
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w_img, x + w + pad), min(h_img, y + h + pad)
        patch = gray[y0:y1, x0:x1]
        if patch.size == 0:
            refined.append((x, y, w, h))
            continue
        thresh_type = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
        thresh = cv2.adaptiveThreshold(patch, 255, cv2.ADAPTIVE_THRESH_MEAN_C, thresh_type, 11, -10)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cx, cy = (x1 - x0) / 2.0, (y1 - y0) / 2.0
        best, best_dist = None, None
        for c in contours:
            bx, by, bw, bh = cv2.boundingRect(c)
            if bw * bh < min_area * 0.3:
                continue
            bcx, bcy = bx + bw / 2.0, by + bh / 2.0
            dist = (bcx - cx) ** 2 + (bcy - cy) ** 2
            if best is None or dist < best_dist:
                best, best_dist = (bx, by, bw, bh), dist
        if best is not None:
            bx, by, bw, bh = best
            refined.append((x0 + bx, y0 + by, bw, bh))
        else:
            refined.append((x, y, w, h))
    return refined


def _split_by_size(group, max_step_ratio=1.35):
    """Split a group of boxes into size-consistent clusters. A whole-screen
    scan often groups unrelated small icons/text into the same y-band as the
    real tile row (they just happen to sit at a similar height) -- splitting
    by size as well keeps that clutter from dragging the real tiles' row out
    of uniformity. Boxes are split wherever consecutive widths (sorted
    ascending) jump by more than max_step_ratio, which finds natural gaps in
    the size distribution instead of drifting from small to large.
    """
    if len(group) <= 1:
        return [group]
    ordered = sorted(group, key=lambda b: b[2])
    clusters = [[ordered[0]]]
    for b in ordered[1:]:
        prev_w = clusters[-1][-1][2]
        if b[2] <= prev_w * max_step_ratio:
            clusters[-1].append(b)
        else:
            clusters.append([b])
    return clusters


def _split_by_x_gap(group, max_gap_ratio=4.0):
    """Split a y-and-size-consistent group into horizontally-contiguous runs.
    Without this, a same-size icon far off to the side (same y-band, similar
    size, purely by coincidence) gets merged into a real tile row and breaks
    the match, since every box in a row must match a template. Real tile rows
    have small, even gaps between tiles; a gap much larger than that marks an
    unrelated box.
    """
    if len(group) <= 1:
        return [group]
    ordered = sorted(group, key=lambda b: b[0])
    avg_w = sum(b[2] for b in ordered) / len(ordered)
    runs = [[ordered[0]]]
    for b in ordered[1:]:
        prev = runs[-1][-1]
        gap = b[0] - (prev[0] + prev[2])
        if gap <= max_gap_ratio * avg_w:
            runs[-1].append(b)
        else:
            runs.append([b])
    return runs


def cluster_rows(boxes, tolerance_px):
    """Group boxes into rows by y-coordinate and, within each y-band, by
    similar size. Returns list of rows (each a list of boxes), ordered top to
    bottom. Each row's boxes are sorted left to right.
    """
    if not boxes:
        return []

    boxes = sorted(boxes, key=lambda b: b[1])
    y_groups = []
    current_group = [boxes[0]]
    current_y = boxes[0][1]

    for b in boxes[1:]:
        if abs(b[1] - current_y) <= tolerance_px:
            current_group.append(b)
        else:
            y_groups.append(current_group)
            current_group = [b]
            current_y = b[1]
    y_groups.append(current_group)

    rows = []
    for group in y_groups:
        for size_group in _split_by_size(group):
            rows.extend(_split_by_x_gap(size_group))

    for row in rows:
        row.sort(key=lambda b: b[0])

    rows.sort(key=lambda row: sum(b[1] for b in row) / len(row))
    return rows


def row_is_uniform(row, max_size_ratio=1.6):
    """Reject rows made of mismatched-size boxes (likely unrelated UI clutter,
    which matters once we're scanning the whole screen instead of a tight
    hand-picked region)."""
    widths = [b[2] for b in row]
    heights = [b[3] for b in row]
    if max(widths) / min(widths) > max_size_ratio:
        return False
    if max(heights) / min(heights) > max_size_ratio:
        return False
    return True


def row_is_locked(bgr, row, scan_height=60, band_height=6, left_margin=450,
                   red_frac_threshold=0.08, spike_ratio=1.75):
    """Detect a reddish 'requirement not met' warning line beneath a combo row
    (e.g. "Tier 3 Bloodthirst Required") -- games commonly show several
    alternative combos at once (e.g. "Weapon Execution" above "Bare Handed"),
    and the ones with an unmet requirement are not the one to press even if
    they happen to be listed first. The warning text sits under the row's
    *label* (to the left of the tiles/icons themselves, not directly below
    them), so the scan area is extended well to the left of the tile boxes.
    It's checked in thin horizontal bands (rather than one averaged block)
    since the text only occupies part of the vertical gap below the row --
    averaged over the whole gap it dilutes below any reasonable threshold.
    bgr is the original color frame (not grayscale) since this relies on
    text color, not brightness.

    Color alone isn't enough: some scenes have a strong ambient red color
    grade (rain/lightning/gore lighting) that pushes red_frac above threshold
    in EVERY band uniformly, which used to be misread as a lock warning on a
    perfectly available combo (a real bug -- "nothing was read" turned out to
    be the only row on screen getting incorrectly skipped as locked). Genuine
    warning text is a localized spike against a low baseline elsewhere in the
    scan area; uniform ambient tint is not. Requiring the peak band to
    clearly exceed the *median* band (not just an absolute threshold) tells
    the two apart.

    spike_ratio was tuned against real captures (a red-outlined grab prompt,
    which itself bleeds red into the scan area and raises the baseline): six
    genuinely-locked rows measured peak/baseline of 1.82-3.61, and six
    genuinely-unlocked rows measured 1.13-1.63 -- the old default of 2.5 sat
    inside the locked cluster and missed anything below ~2.5, silently
    treating a locked combo as available. 1.75 sits in the gap between the
    two clusters with margin on both sides.
    """
    if bgr is None:
        return False
    x_min = max(0, min(b[0] for b in row) - left_margin)
    x_max = max(b[0] + b[2] for b in row)
    y_bottom = max(b[1] + b[3] for b in row)
    fracs = []
    for y0 in range(y_bottom, y_bottom + scan_height, band_height):
        band = bgr[y0:y0 + band_height, x_min:x_max]
        if band.size == 0:
            continue
        pixels = band.reshape(-1, 3).astype(np.int32)
        b, g, r = pixels[:, 0], pixels[:, 1], pixels[:, 2]
        # r dominant alone also matches warm skin tones / warm lighting (common in
        # these games); true UI warning red/crimson has green <= blue (a pink/magenta
        # cast), while skin tones have green > blue (an orange/tan cast) -- requiring
        # g <= b + 10 keeps the check specific to actual warning text.
        red_mask = (r > g + 15) & (r > b + 15) & (r > 55) & (g <= b + 10)
        fracs.append(red_mask.mean())
    if not fracs:
        return False
    peak = max(fracs)
    baseline = float(np.median(fracs))
    return peak > red_frac_threshold and peak > baseline * spike_ratio


def find_best_full_match_row(gray, templates, min_area, tol, size, threshold, min_len=2, bgr=None, keep_frac=1.0, max_refine=60, max_len=None):
    """Scan rows top to bottom and return the sequence (list of digit strings)
    for the first row where every tile is confidently recognized AND the row
    isn't marked locked (see row_is_locked). Rows that are too short,
    size-mismatched, locked, or contain any unreadable tile are skipped --
    this is what keeps whole-screen watching from being fooled by unrelated
    square icons/HUD elements elsewhere on screen, or from acting on a combo
    option whose requirement isn't met. Returns None if no row fully
    qualifies.

    min_len/max_len bound how many tiles a real combo can have for whichever
    role is being played (e.g. Michael: 4-5, civilian: 3-4 -- see
    ROLE_LEN_RANGE in app.py). Anything outside that range is always a
    partial/mid-animation misread, never a real combo, so rejecting it here
    (before the expensive per-tile matching below) is free and needs no
    extra polling/confirmation to filter out.

    A row is also rejected if the same label repeats MORE times than the
    available alphabet allows a real combo to force -- i.e. only when
    len(sequence) <= len(templates), since a combo that fits within the
    number of distinct buttons never needs to repeat one. A combo longer
    than the alphabet (Michael's 5-tile combo with a 4-button alphabet) must
    repeat exactly one button, so duplicates there are expected, not a
    misread.

    max_refine is forwarded to find_tile_boxes -- see its docstring. Lower it
    if watching feels like it "catches up" late on busy frames (a cluttered
    whole-screen capture with lots of candidate boxes pays the per-candidate
    refine cost documented there, up to ~850ms measured worst case at the
    old default of 60).
    """
    boxes = find_tile_boxes(gray, min_area, max_refine=max_refine)
    rows = cluster_rows(boxes, tol)

    for row in rows:
        if len(row) < min_len or not row_is_uniform(row):
            continue
        if max_len is not None and len(row) > max_len:
            continue
        # Match icons BEFORE checking row_is_locked, not after -- profiling a
        # real whole-screen frame showed row_is_locked alone eating ~35% of
        # total scan time, because it used to run on every same-sized
        # candidate row (HUD icons, spectator-panel entries, anything
        # incidentally uniform), most of which were never going to match a
        # real tile anyway. Icon matching almost always rejects a clutter row
        # on its very first tile, so trying it first and only paying for the
        # expensive lock check on rows that already match completely cuts
        # row_is_locked calls from ~10/frame down to ~1-2/frame with no
        # change in the final decision (a locked-but-matching row is still
        # correctly rejected below, just after a cheaper check first).
        sequence = []
        ok = True
        for box in row:
            cell = crop_cell(gray, box, size, keep_frac=keep_frac)
            digit, _ = match_digit(cell, templates, threshold)
            if digit is None:
                ok = False
                break
            sequence.append(digit)
        if ok and len(sequence) <= len(templates) and len(set(sequence)) != len(sequence):
            ok = False
        if ok and not row_is_locked(bgr, row):
            return sequence
    return None


def crop_cell(gray, box, size, keep_frac=1.0):
    """Crop a tile/icon to a fixed size for template matching. If keep_frac
    is less than 1.0, only the central fraction of the box is kept before
    resizing -- round controller-button icons share a nearly identical
    outer ring/background across every letter (A/B/X/Y), which dilutes
    normalized cross-correlation and made different letters dangerously easy
    to confuse (measured cross-match up to 0.744, uncomfortably close to the
    0.75 accept threshold); cropping to the center discards that shared
    background. Digit tiles don't have this problem (they already had a wide
    real-world margin, e.g. 0.97-1.0 same-digit vs 0.56-0.72 different-digit)
    and are more sensitive to losing their margin for error on imprecise box
    edges, so callers should pass keep_frac=1.0 (the default) for keyboard
    mode and something tighter (e.g. 0.65) only for controller mode.
    """
    x, y, w, h = box
    cell = gray[y:y + h, x:x + w]
    if keep_frac < 1.0:
        mx, my = int(w * (1 - keep_frac) / 2), int(h * (1 - keep_frac) / 2)
        if w - 2 * mx > 0 and h - 2 * my > 0:
            cell = cell[my:h - my, mx:w - mx]
    return cv2.resize(cell, (size, size), interpolation=cv2.INTER_AREA)


def match_digit(cell, templates, threshold):
    """Match a cropped/resized cell against known digit templates.

    templates: dict[str_digit] -> grayscale image (same size as cell)
    Returns (digit_str, score) or (None, best_score) if below threshold.
    """
    best_digit, best_score = None, -1.0
    for digit, tmpl in templates.items():
        res = cv2.matchTemplate(cell, tmpl, cv2.TM_CCOEFF_NORMED)
        score = float(res.max())
        if score > best_score:
            best_score = score
            best_digit = digit
    if best_score < threshold:
        return None, best_score
    return best_digit, best_score
