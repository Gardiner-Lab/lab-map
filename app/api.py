"""The map's API, under /map/api. Everything needs someone signed in (people.current)."""

from functools import wraps

from flask import Blueprint, jsonify, request

from app import maps, people
from app.maps import Forbidden, NotFound
from app.plans import PlanError

api = Blueprint('api', __name__)


def signed_in(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        person = people.current()
        if person is None:
            return jsonify({'error': 'Sign in first'}), 401
        try:
            return fn(person, *args, **kwargs)
        except Forbidden as exc:
            return jsonify({'error': str(exc)}), 403
        except NotFound as exc:
            return jsonify({'error': str(exc)}), 404
        except (PlanError, ValueError, KeyError, TypeError) as exc:
            return jsonify({'error': str(exc).strip("'")}), 400
    return wrapper


def body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError('Send JSON')
    return data


def _upload():
    f = request.files.get('file')
    if f is None:
        raise ValueError('Choose a PDF or picture of the floor plan')
    page = int(request.form.get('page') or 1) - 1
    return f.read(maps.MAX_UPLOAD + 1), f.filename or '', page


@api.get('/me')
@signed_in
def me(person):
    return jsonify({'person': person.to_dict(), 'kinds': maps.KINDS, 'storage': sorted(maps.STORAGE),
                    'admin_labs': [lab for lab in people.labs() if lab['id'] in person.admin_lab_ids]})


@api.get('/maps')
@signed_in
def list_maps(person):
    return jsonify({'maps': maps.visible(person)})


@api.post('/maps')
@signed_in
def add_map(person):
    data, name, page = _upload()
    return jsonify({'map': maps.create(person, request.form.get('lab_id', ''), request.form.get('name', ''),
                                       data, name, page)}), 201


@api.get('/maps/<map_id>')
@signed_in
def get_map(person, map_id):
    return jsonify({'map': maps.get(person, map_id)})


@api.put('/maps/<map_id>')
@signed_in
def change_map(person, map_id):
    return jsonify({'map': maps.update(person, map_id, body())})


@api.post('/maps/<map_id>/drawing')
@signed_in
def replace_drawing(person, map_id):
    data, name, page = _upload()
    return jsonify({'map': maps.replace_drawing(person, map_id, data, name, page)})


@api.delete('/maps/<map_id>')
@signed_in
def remove_map(person, map_id):
    maps.delete(person, map_id)
    return jsonify({'ok': True})


@api.post('/maps/<map_id>/suggestions')
@signed_in
def suggestions(person, map_id):
    """{"ids": [...], "dismiss": false}: make those suggestions places, or drop them."""
    data = body()
    ids = data.get('ids')
    if not isinstance(ids, list):
        raise ValueError('Say which suggestions')
    return jsonify({'map': maps.take_suggestions(person, map_id, [str(i) for i in ids], bool(data.get('dismiss')))})


@api.post('/maps/<map_id>/places')
@signed_in
def add_place(person, map_id):
    return jsonify({'place': maps.add_place(person, map_id, body())}), 201


@api.get('/places')
@signed_in
def list_places(person):
    """Every place they can see; ?storage=1 only where stocks are kept (Stocks' place picker)."""
    return jsonify({'places': maps.all_places(person, request.args.get('storage') == '1'), 'kinds': maps.KINDS})


@api.get('/places/<place_id>')
@signed_in
def get_place(person, place_id):
    return jsonify({'place': maps.get_place(person, place_id)})


@api.put('/places/<place_id>')
@signed_in
def change_place(person, place_id):
    return jsonify({'place': maps.update_place(person, place_id, body())})


@api.delete('/places/<place_id>')
@signed_in
def remove_place(person, place_id):
    maps.delete_place(person, place_id)
    return jsonify({'ok': True})
