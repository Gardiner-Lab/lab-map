import os
import sqlite3

import pytest

os.environ['MAP_NO_APP'] = '1'


def _make(path, sql):
    conn = sqlite3.connect(path)
    conn.executescript(sql)
    conn.commit()
    conn.close()


@pytest.fixture()
def app(tmp_path, monkeypatch):
    """The app, with a directory and suite of two labs: lab 1 (ann lab admin, bob member), lab 2 (cat lab admin)."""
    moclo = tmp_path / 'moclo.db'
    suite = tmp_path / 'suite.db'
    _make(moclo, """
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, is_admin INTEGER DEFAULT 0);
        INSERT INTO users VALUES ('1', 'ann', 0), ('2', 'bob', 0), ('3', 'cat', 0), ('4', 'root', 1);""")
    _make(suite, """
        CREATE TABLE labs (id INTEGER PRIMARY KEY, name TEXT, chair_group_id INTEGER);
        CREATE TABLE chair_groups (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE lab_members (username TEXT, lab_id INTEGER, role TEXT, lab_admin INTEGER DEFAULT 0, joined_at TEXT);
        CREATE TABLE archived (username TEXT PRIMARY KEY, archived_at TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO labs VALUES (1, 'Plant Lab', NULL), (2, 'Other Lab', NULL);
        INSERT INTO lab_members VALUES ('ann', 1, 'lab_lead', 1, '2026-01-01'), ('bob', 1, 'member', 0, '2026-01-01'),
                                       ('cat', 2, 'lab_lead', 1, '2026-01-01');""")
    monkeypatch.setenv('MOCLO_DATABASE_PATH', str(moclo))
    monkeypatch.setenv('SUITE_DATABASE_PATH', str(suite))
    monkeypatch.setenv('MAP_DATABASE_PATH', str(tmp_path / 'map' / 'map.db'))
    monkeypatch.delenv('URL_PREFIX', raising=False)
    from app.main import create_app
    flask_app = create_app()
    flask_app.config['TESTING'] = True
    return flask_app


@pytest.fixture()
def client(app):
    c = app.test_client()

    def as_user(username):
        c.environ_base['HTTP_X_SUITE_USER'] = username
        return c
    c.as_user = as_user
    return c


@pytest.fixture()
def plan_pdf():
    """A small equipment drawing: a room, a fridge (KK) and a -80 (VR (-80)) inside their outlines, a room label."""
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=600, height=400)
    page.draw_rect(fitz.Rect(20, 20, 580, 380), width=3)          # the room's walls
    page.draw_rect(fitz.Rect(100, 100, 140, 140), width=1)        # a fridge
    page.insert_text((110, 124), 'KK', fontsize=9)
    page.draw_rect(fitz.Rect(300, 100, 360, 140), width=1)        # a -80 freezer
    page.insert_text((306, 124), 'VR (-80)', fontsize=8)
    page.insert_text((200, 220), '03.6.077', fontsize=7)
    page.insert_text((200, 230), 'B7/B8', fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data
