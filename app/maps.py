"""
Each lab's maps and the places on them.

A map belongs to one lab: its members see it, its lab admins (and the suite's
administrators) upload the drawing and mark the places. A place is a fridge,
freezer, cabinet or piece of equipment: an outline on the drawing, a name, and
what it links to: Booking's equipment by id, and Stocks, whose records name the place.
"""

import json
import os
from typing import List, Optional

from app import db, people, plans
from app.people import Person

KINDS = {
    'fridge': 'Fridge (4 °C)',
    'freezer20': 'Freezer (-20 °C)',
    'freezer80': 'Freezer (-80 °C)',
    'fridgefreezer': 'Fridge-freezer',
    'coldroom': 'Cold room',
    'cabinet': 'Cabinet',
    'shelf': 'Shelf or rack',
    'equipment': 'Equipment',
    'room': 'Room',
    'other': 'Other',
}
# Where stocks are kept, as opposed to what is booked: these show the stocks in them.
STORAGE = {'fridge', 'freezer20', 'freezer80', 'fridgefreezer', 'coldroom', 'cabinet', 'shelf', 'room', 'other'}
MAX_UPLOAD = 60 * 1024 * 1024


class Forbidden(Exception):
    pass


class NotFound(Exception):
    pass


def _text(value, limit: int) -> str:
    return str(value or '').strip()[:limit]


def _lab_names() -> dict:
    return {lab['id']: lab['name'] for lab in people.labs()}


def can_see(person: Person, lab_id: str) -> bool:
    return person.is_admin or lab_id in person.lab_ids


def can_edit(person: Person, lab_id: str) -> bool:
    return lab_id in person.admin_lab_ids


def _map_row(conn, map_id: str):
    row = conn.execute('SELECT * FROM maps WHERE id = ? AND deleted_at IS NULL', (map_id,)).fetchone()
    if row is None:
        raise NotFound('No such map')
    return row


def _seen(person: Person, conn, map_id: str):
    row = _map_row(conn, map_id)
    if not can_see(person, row['lab_id']):
        raise NotFound('No such map')
    return row


def _editable(person: Person, conn, map_id: str):
    row = _seen(person, conn, map_id)
    if not can_edit(person, row['lab_id']):
        raise Forbidden("Only the lab's lab admins change its maps")
    return row


def map_dict(person: Person, row, places: Optional[List[dict]] = None, labs: Optional[dict] = None) -> dict:
    labs = labs if labs is not None else _lab_names()
    editable = can_edit(person, row['lab_id'])
    out = {
        'id': row['id'], 'lab_id': row['lab_id'], 'lab': labs.get(row['lab_id'], ''),
        'name': row['name'], 'description': row['description'],
        'width': row['width'], 'height': row['height'], 'source_name': row['source_name'],
        'updated_at': row['updated_at'], 'can_edit': editable,
        'drawing': f"/plans/{row['id']}.png?v={row['updated_at']}",
        'overview': f"/plans/{row['id']}-overview.png?v={row['updated_at']}",
    }
    if places is not None:
        out['places'] = places
        # Suggestions are for whoever marks the places.
        out['suggestions'] = json.loads(row['suggestions'] or '[]') if editable else []
    return out


def place_dict(row, map_row=None, labs: Optional[dict] = None) -> dict:
    out = {
        'id': row['id'], 'map_id': row['map_id'], 'kind': row['kind'], 'name': row['name'],
        'room': row['room'], 'shape': json.loads(row['shape']), 'resource_id': row['resource_id'],
        'match': row['match'], 'notes': row['notes'], 'storage': row['kind'] in STORAGE,
    }
    if map_row is not None:
        out['map'] = map_row['name']
        out['lab_id'] = map_row['lab_id']
        if labs is not None:
            out['lab'] = labs.get(map_row['lab_id'], '')
    return out


# --- maps ------------------------------------------------------------------------

def visible(person: Person) -> List[dict]:
    labs = _lab_names()
    with db.connect() as conn:
        rows = conn.execute('SELECT m.*, (SELECT COUNT(*) FROM places p WHERE p.map_id = m.id) AS n '
                            'FROM maps m WHERE m.deleted_at IS NULL ORDER BY m.name COLLATE NOCASE').fetchall()
    out = []
    for r in rows:
        if can_see(person, r['lab_id']):
            d = map_dict(person, r, labs=labs)
            d['places_count'] = r['n']
            out.append(d)
    # Their own labs' maps first.
    mine = person.lab_ids
    return sorted(out, key=lambda m: (m['lab_id'] not in mine, m['lab'].lower(), m['name'].lower()))


def get(person: Person, map_id: str) -> dict:
    with db.connect() as conn:
        row = _seen(person, conn, map_id)
        places = conn.execute('SELECT * FROM places WHERE map_id = ? ORDER BY name COLLATE NOCASE', (map_id,)).fetchall()
    return map_dict(person, row, [place_dict(p) for p in places])


def drawing_path(map_id: str, overview: bool = False) -> str:
    return os.path.join(db.files(), f"{map_id}{'-overview' if overview else ''}.png")


def _save(img, map_id: str) -> None:
    plans.save_png(img, drawing_path(map_id))
    plans.save_overview(img, drawing_path(map_id, overview=True))


def drawing(person: Person, map_id: str, overview: bool = False) -> str:
    with db.connect() as conn:
        _seen(person, conn, map_id)
    path = drawing_path(map_id, overview)
    return path if os.path.exists(path) or not overview else drawing_path(map_id)


def _read_upload(data: bytes, filename: str, page: int):
    if not data:
        raise ValueError('Choose a PDF or picture of the floor plan')
    if len(data) > MAX_UPLOAD:
        raise ValueError(f'The file is over {MAX_UPLOAD // (1024 * 1024)} MB')
    return plans.read(data, filename, page)


def create(person: Person, lab_id: str, name: str, data: bytes, filename: str, page: int = 0) -> dict:
    lab_id = _text(lab_id, 40)
    if not can_edit(person, lab_id):
        raise Forbidden("Only the lab's lab admins add its maps")
    name = _text(name, 120) or os.path.splitext(os.path.basename(filename or ''))[0][:120] or 'Floor plan'
    img, suggestions = _read_upload(data, filename, page)
    map_id = plans.new_id()
    _save(img, map_id)
    with db.connect() as conn:
        conn.execute('INSERT INTO maps (id, lab_id, name, width, height, source_name, suggestions, created_by) '
                     'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                     (map_id, lab_id, name, img.width, img.height, _text(os.path.basename(filename or ''), 200),
                      json.dumps(suggestions), person.username))
    return get(person, map_id)


def replace_drawing(person: Person, map_id: str, data: bytes, filename: str, page: int = 0) -> dict:
    """
    A new version of the drawing. The places stay where they were on the page (they are kept as
    fractions of it), so a revision of the same plan needs no re-marking; new suggestions replace old.
    """
    with db.connect() as conn:
        _editable(person, conn, map_id)
    img, suggestions = _read_upload(data, filename, page)
    _save(img, map_id)
    with db.connect() as conn:
        conn.execute('UPDATE maps SET width = ?, height = ?, source_name = ?, suggestions = ?, '
                     "updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?",
                     (img.width, img.height, _text(os.path.basename(filename or ''), 200), json.dumps(suggestions), map_id))
    return get(person, map_id)


def update(person: Person, map_id: str, data: dict) -> dict:
    with db.connect() as conn:
        row = _editable(person, conn, map_id)
        name = _text(data.get('name', row['name']), 120)
        if not name:
            raise ValueError('A map needs a name')
        conn.execute("UPDATE maps SET name = ?, description = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?",
                     (name, _text(data.get('description', row['description']), 2000), map_id))
    return get(person, map_id)


def delete(person: Person, map_id: str) -> None:
    """Out of sight; the drawing and places stay in the database, for a backup to bring back."""
    with db.connect() as conn:
        _editable(person, conn, map_id)
        conn.execute("UPDATE maps SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (map_id,))


# --- suggestions -----------------------------------------------------------------

def take_suggestions(person: Person, map_id: str, ids: List[str], dismiss: bool = False) -> dict:
    """Make the chosen suggestions places (or, dismissing, just drop them)."""
    wanted = set(ids or [])
    with db.connect() as conn:
        row = _editable(person, conn, map_id)
        suggestions = json.loads(row['suggestions'] or '[]')
        chosen = [s for s in suggestions if s['id'] in wanted]
        left = [s for s in suggestions if s['id'] not in wanted]
        if not dismiss:
            for s in chosen:
                conn.execute('INSERT INTO places (id, map_id, kind, name, room, shape, created_by, updated_by) '
                             'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                             (plans.new_id(), map_id, s['kind'], s['name'], s.get('room', ''),
                              json.dumps(s['shape']), person.username, person.username))
        conn.execute('UPDATE maps SET suggestions = ? WHERE id = ?', (json.dumps(left), map_id))
    return get(person, map_id)


# --- places ----------------------------------------------------------------------

def _shape(value) -> dict:
    def num(v):
        f = float(v)
        if not -0.05 <= f <= 1.05:
            raise ValueError('A place must be on the drawing')
        return round(f, 5)
    if not isinstance(value, dict):
        raise ValueError('Draw the place on the map')
    if 'rect' in value:
        x, y, w, h = (num(v) for v in value['rect'])
        if w <= 0 or h <= 0:
            raise ValueError('Draw the place on the map')
        return {'rect': [x, y, w, h]}
    pts = value.get('poly')
    if isinstance(pts, list) and 3 <= len(pts) <= 300:
        return {'poly': [[num(p[0]), num(p[1])] for p in pts]}
    raise ValueError('Draw the place on the map')


def _place_fields(data: dict, old=None) -> dict:
    def pick(key, limit):
        return _text(data[key], limit) if key in data else (old[key] if old is not None else '')
    out = {'name': pick('name', 120), 'room': pick('room', 120), 'resource_id': pick('resource_id', 60),
           'match': pick('match', 500), 'notes': pick('notes', 2000)}
    kind = pick('kind', 20) or 'other'
    if kind not in KINDS:
        raise ValueError(f'Kind must be one of {", ".join(KINDS)}')
    out['kind'] = kind
    if not out['name']:
        raise ValueError('A place needs a name')
    out['shape'] = json.dumps(_shape(data['shape'])) if 'shape' in data else (old['shape'] if old is not None else None)
    if out['shape'] is None:
        raise ValueError('Draw the place on the map')
    return out


def _place_row(conn, place_id: str):
    row = conn.execute('SELECT * FROM places WHERE id = ?', (place_id,)).fetchone()
    if row is None:
        raise NotFound('No such place')
    return row


def get_place(person: Person, place_id: str) -> dict:
    with db.connect() as conn:
        row = _place_row(conn, place_id)
        try:
            map_row = _seen(person, conn, row['map_id'])
        except NotFound:
            raise NotFound('No such place')
    return place_dict(row, map_row, _lab_names())


def add_place(person: Person, map_id: str, data: dict) -> dict:
    fields = _place_fields(data)
    place_id = plans.new_id()
    with db.connect() as conn:
        _editable(person, conn, map_id)
        cols = ['id', 'map_id', 'created_by', 'updated_by', *fields]
        conn.execute(f'INSERT INTO places ({", ".join(cols)}) VALUES ({", ".join("?" * len(cols))})',
                     (place_id, map_id, person.username, person.username, *fields.values()))
    return get_place(person, place_id)


def update_place(person: Person, place_id: str, data: dict) -> dict:
    with db.connect() as conn:
        old = _place_row(conn, place_id)
        _editable(person, conn, old['map_id'])
        fields = _place_fields(data, old)
        sets = ', '.join(f'{k} = ?' for k in fields)
        conn.execute(f"UPDATE places SET {sets}, updated_by = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?",
                     (*fields.values(), person.username, place_id))
    return get_place(person, place_id)


def delete_place(person: Person, place_id: str) -> None:
    with db.connect() as conn:
        old = _place_row(conn, place_id)
        _editable(person, conn, old['map_id'])
        conn.execute('DELETE FROM places WHERE id = ?', (place_id,))


def all_places(person: Person, storage_only: bool = False) -> List[dict]:
    """Every place on the maps they can see: for Stocks' place picker, and finding a place by name."""
    labs = _lab_names()
    with db.connect() as conn:
        rows = conn.execute('SELECT p.*, m.name AS map_name, m.lab_id AS map_lab FROM places p '
                            'JOIN maps m ON m.id = p.map_id WHERE m.deleted_at IS NULL '
                            'ORDER BY m.name COLLATE NOCASE, p.room COLLATE NOCASE, p.name COLLATE NOCASE').fetchall()
    out = []
    for r in rows:
        if not can_see(person, r['map_lab']) or (storage_only and r['kind'] not in STORAGE):
            continue
        d = place_dict(r)
        d.update(map=r['map_name'], lab_id=r['map_lab'], lab=labs.get(r['map_lab'], ''))
        out.append(d)
    return out
