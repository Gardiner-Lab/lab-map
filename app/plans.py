"""
Floor plans: a lab admin's PDF or picture, made into the drawing the map shows, and
the places a PDF's own labels point at, offered as suggestions.

An architect's equipment drawing (an "afsprakentekening") names what stands where in
short labels: KK a fridge, VR or -20 a freezer, -80, Kast a cabinet, FC a flow cabinet,
INC an incubator, each inside the outline of the thing. The PDF keeps those labels as
text with their positions, so they are read, not guessed from pixels. The outline round
each is found in the drawing itself: the white area the label sits in, bounded by the
drawn lines. A label with no closed outline round it gets a box of its own.
"""

import io
import re
import uuid
from collections import Counter
from typing import List, Optional, Tuple

import fitz  # PyMuPDF
import numpy as np
from PIL import Image
from scipy import ndimage

# The drawing is stored at most this wide or tall: sharp when zoomed in on a bench, small enough to load.
LONG_SIDE = 6000
Image.MAX_IMAGE_PIXELS = 120_000_000

# What a label means: (kind, the place's name). Dutch drawings' abbreviations and the plain words.
LABELS = {
    '-80': ('freezer80', '-80 °C freezer'),
    'VR (-80)': ('freezer80', '-80 °C freezer'),
    '-20': ('freezer20', '-20 °C freezer'),
    'VR': ('freezer20', 'Freezer'),
    'KK': ('fridge', 'Fridge'),
    'KK/VR': ('fridgefreezer', 'Fridge-freezer'),
    'koelcel': ('coldroom', 'Cold room'),
    'Kast': ('cabinet', 'Cabinet'),
    'FC': ('equipment', 'Flow cabinet'),
    'FSSC': ('equipment', 'Fume cupboard'),
    'FSCG': ('equipment', 'Fume cupboard'),
    'BSC': ('equipment', 'Biosafety cabinet'),
    'INC': ('equipment', 'Incubator'),
    'IJS': ('equipment', 'Ice machine'),
    'fridge': ('fridge', 'Fridge'),
    'freezer': ('freezer20', 'Freezer'),
    'incubator': ('equipment', 'Incubator'),
}
_LABELS_LOWER = {k.lower(): v for k, v in LABELS.items()}
ROOM_NUMBER = re.compile(r'^\d{1,2}\.\d{1,2}\.\d{2,4}$')
# A room's label: its number (03.6.077), then its name (B7/B8) on the next line.
# Shafts, toilets, cleaners' and server cupboards: numbered like rooms, never where the equipment is.
NOT_A_ROOM = re.compile(r'schacht|toilet|werkkast|^SER$|shaft|cleaner', re.I)
ROOM_REACH = 260      # points: a label further than this from every room number is left without a room
# An outline larger than this (points, each way) is a room or a corridor, not the thing the label names.
MAX_OUTLINE = 220


class PlanError(ValueError):
    pass


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _fit(width: float, height: float) -> float:
    return min(1.0, LONG_SIDE / max(width, height))


def from_image(data: bytes) -> Tuple[Image.Image, List[dict]]:
    """A picture of a plan (PNG, JPEG, WebP): kept as it is, made no larger than LONG_SIDE. No suggestions."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # Pillow raises many kinds
        raise PlanError('That file is not a picture or PDF the map can read') from exc
    img = img.convert('RGB')
    scale = _fit(*img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return img, []


def from_pdf(data: bytes, page_number: int = 0) -> Tuple[Image.Image, List[dict]]:
    """A PDF's page, drawn, with the places its labels suggest."""
    try:
        doc = fitz.open(stream=data, filetype='pdf')
    except Exception as exc:
        raise PlanError('That PDF could not be opened') from exc
    if doc.needs_pass:
        raise PlanError('That PDF is locked with a password')
    if not 0 <= page_number < len(doc):
        raise PlanError(f'That PDF has {len(doc)} page{"s" if len(doc) != 1 else ""}')
    page = doc[page_number]
    shown = page.rect * page.rotation_matrix if page.rotation else page.rect
    scale = LONG_SIDE / max(abs(shown.width), abs(shown.height))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    return img, suggest(page, img, scale)


def _words(page) -> List[Tuple[fitz.Rect, str, tuple]]:
    """The page's words where they are shown (a turned page's text is stored unturned), with their line."""
    turn = page.rotation_matrix if page.rotation else None
    out = []
    for w in page.get_text('words'):
        rect = fitz.Rect(w[:4])
        out.append((rect * turn if turn else rect, w[4], (w[5], w[6])))
    return out


def _labels(words) -> List[Tuple[fitz.Rect, str]]:
    """The words that are labels; 'VR' followed by '(-80)' on its line is one label, a -80 freezer."""
    found = []
    skip = set()
    for i, (rect, text, line) in enumerate(words):
        if i in skip:
            continue
        nxt = words[i + 1] if i + 1 < len(words) else None
        if text == 'VR' and nxt and nxt[2] == line and nxt[1] == '(-80)':
            found.append((rect | nxt[0], 'VR (-80)'))
            skip.add(i + 1)
        elif text.lower() in _LABELS_LOWER:
            found.append((rect, text))
    return found


def _rooms(words) -> List[Tuple[fitz.Point, str]]:
    """Room numbers and the names under them: '03.6.077 B7/B8'."""
    rooms = []
    by_line = {}
    for rect, text, line in words:
        by_line.setdefault(line, []).append(text)
    for rect, text, (block, line) in words:
        if ROOM_NUMBER.match(text):
            name = ' '.join(by_line.get((block, line + 1), []))
            if NOT_A_ROOM.search(name):
                continue
            rooms.append((fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2),
                          f'{name} ({text})' if name else text))
    return rooms


def suggest(page, img: Image.Image, scale: float) -> List[dict]:
    """
    A place for each label: its outline in the drawing (fractions of the picture), what it is, and
    the nearest room. Labels are read from the PDF's text; outlines from the drawn lines round them.
    """
    words = _words(page)
    labels = _labels(words)
    if not labels:
        return []
    rooms = _rooms(words)
    gray = np.asarray(img.convert('L'))
    h, w = gray.shape
    # The white areas between the drawn lines, each numbered. Lines are thickened by a pixel so a
    # hairline gap in a drawing does not join a cupboard to the room round it.
    ink = ndimage.binary_dilation(gray < 200, iterations=1)
    areas, _ = ndimage.label(~ink)
    boxes = ndimage.find_objects(areas)

    out = []
    for rect, text in labels:
        kind, name = _LABELS_LOWER[text.lower()]
        x0, y0, x1, y1 = (int(round(v * scale)) for v in (rect.x0, rect.y0, rect.x1, rect.y1))
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, w - 1), min(y1, h - 1)
        box = (x0, y0, x1, y1)
        # The area just outside the label's own letters, all round: the one most of that ring is in.
        pad = 3
        ring = np.concatenate([
            areas[max(y0 - pad, 0):min(y1 + pad, h), max(x0 - pad, 0)],
            areas[max(y0 - pad, 0):min(y1 + pad, h), min(x1 + pad, w - 1)],
            areas[max(y0 - pad, 0), x0:x1 + 1],
            areas[min(y1 + pad, h - 1), x0:x1 + 1],
        ])
        ring = ring[ring > 0]
        if ring.size:
            area = Counter(ring.tolist()).most_common(1)[0][0]
            sl = boxes[area - 1]
            bx0, by0, bx1, by1 = sl[1].start, sl[0].start, sl[1].stop, sl[0].stop
            if (bx1 - bx0) / scale <= MAX_OUTLINE and (by1 - by0) / scale <= MAX_OUTLINE:
                box = (min(bx0, x0), min(by0, y0), max(bx1, x1), max(by1, y1))
        # At least a little larger than the letters, to be found and clicked.
        bx0, by0, bx1, by1 = box
        min_w, min_h = (x1 - x0) * 1.5, (y1 - y0) * 1.5
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        if bx1 - bx0 < min_w:
            bx0, bx1 = cx - min_w / 2, cx + min_w / 2
        if by1 - by0 < min_h:
            by0, by1 = cy - min_h / 2, cy + min_h / 2

        centre = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        room = ''
        if rooms:
            dist, room_name = min(((abs(centre - p), n) for p, n in rooms), key=lambda t: t[0])
            room = room_name if dist <= ROOM_REACH else ''
        out.append({
            'id': new_id(), 'kind': kind, 'name': name, 'label': text, 'room': room,
            'shape': {'rect': [round(bx0 / w, 5), round(by0 / h, 5), round((bx1 - bx0) / w, 5), round((by1 - by0) / h, 5)]},
        })
    return out


def read(data: bytes, filename: str, page_number: int = 0) -> Tuple[Image.Image, List[dict]]:
    if data[:5] == b'%PDF-' or filename.lower().endswith('.pdf'):
        return from_pdf(data, page_number)
    return from_image(data)


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=False, compress_level=6)
    return buf.getvalue()


# The whole floor at a glance: a drawing's hairlines vanish when a browser shrinks 6000 pixels to a
# screen's width, so a small copy is made with its lines thickened first, and shown until zoomed in.
OVERVIEW_SIDE = 2000


def overview(img: Image.Image) -> bytes:
    from PIL import ImageFilter
    scale = OVERVIEW_SIDE / max(img.size)
    if scale >= 1:
        return png(img)
    thick = img.filter(ImageFilter.MinFilter(max(3, int(round(1 / scale)) | 1)))
    return png(thick.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS))
