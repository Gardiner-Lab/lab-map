"""The map's own database: each lab's floor plans and the places marked on them."""

import os
import sqlite3
from contextlib import contextmanager
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    lab_id TEXT NOT NULL,                     -- the suite's lab (suite.db labs.id) whose map it is
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL,                   -- the drawing, as stored (pixels)
    height INTEGER NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',     -- the file it was made from
    suggestions TEXT NOT NULL DEFAULT '[]',   -- places found in a PDF's labels, not yet taken up (JSON)
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS maps_by_lab ON maps (lab_id);
CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    map_id TEXT NOT NULL REFERENCES maps(id),
    kind TEXT NOT NULL,                       -- fridge, freezer20, freezer80, ... (places.KINDS)
    name TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    shape TEXT NOT NULL,                      -- JSON: {"rect": [x, y, w, h]} or {"poly": [[x, y], ...]}, fractions of the drawing
    resource_id TEXT NOT NULL DEFAULT '',     -- Booking's id for the equipment here
    match TEXT NOT NULL DEFAULT '',           -- words in Stocks' free-text locations that mean this place
    notes TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
);
CREATE INDEX IF NOT EXISTS places_by_map ON places (map_id);
"""

_path: Optional[str] = None


def path() -> str:
    return _path or os.environ.get('MAP_DATABASE_PATH', '/map/map.db')


def files() -> str:
    """Where the drawings are kept, one PNG per map."""
    return os.environ.get('MAP_FILES') or os.path.join(os.path.dirname(path()), 'plans')


def initialize(db_path: Optional[str] = None) -> None:
    global _path
    if db_path:
        _path = db_path
    os.makedirs(os.path.dirname(path()) or '.', exist_ok=True)
    os.makedirs(files(), exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect():
    conn = sqlite3.connect(path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
