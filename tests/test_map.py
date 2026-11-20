import io

from PIL import Image


def upload(client, data, name='plan.pdf', lab='1', title='Floor 3'):
    return client.post('/api/maps', data={'lab_id': lab, 'name': title, 'file': (io.BytesIO(data), name)},
                       content_type='multipart/form-data')


def test_suggestions_from_pdf_labels(client, plan_pdf):
    res = upload(client.as_user('ann'), plan_pdf)
    assert res.status_code == 201, res.json
    m = res.json['map']
    kinds = sorted(s['kind'] for s in m['suggestions'])
    assert kinds == ['freezer80', 'fridge']
    fridge = next(s for s in m['suggestions'] if s['kind'] == 'fridge')
    # The outline drawn round the label, not the room round it: 40 of 600 points wide.
    x, y, w, h = fridge['shape']['rect']
    assert abs(w - 40 / 600) < 0.01 and abs(h - 40 / 400) < 0.015
    assert abs(x - 100 / 600) < 0.01
    assert fridge['room'] == 'B7/B8 (03.6.077)'


def test_picture_upload_has_no_suggestions(client):
    buf = io.BytesIO()
    Image.new('RGB', (800, 500), 'white').save(buf, 'PNG')
    res = upload(client.as_user('ann'), buf.getvalue(), 'plan.png')
    assert res.status_code == 201
    assert res.json['map']['suggestions'] == [] and res.json['map']['width'] == 800


def test_rubbish_is_refused(client):
    res = upload(client.as_user('ann'), b'not a plan', 'plan.txt')
    assert res.status_code == 400


def test_only_lab_admins_add_maps(client, plan_pdf):
    assert upload(client.as_user('bob'), plan_pdf).status_code == 403
    assert upload(client.as_user('cat'), plan_pdf, lab='1').status_code == 403
    assert upload(client.as_user('root'), plan_pdf, lab='1').status_code == 201


def test_maps_are_the_labs_own(client, plan_pdf):
    map_id = upload(client.as_user('ann'), plan_pdf).json['map']['id']
    assert [m['id'] for m in client.as_user('bob').get('/api/maps').json['maps']] == [map_id]
    assert client.as_user('cat').get('/api/maps').json['maps'] == []
    assert client.as_user('cat').get(f'/api/maps/{map_id}').status_code == 404
    assert client.as_user('cat').get(f'/plans/{map_id}.png').status_code == 404
    assert client.as_user('bob').get(f'/plans/{map_id}.png').status_code == 200
    # A member sees the places, not the suggestions, and cannot change anything.
    m = client.as_user('bob').get(f'/api/maps/{map_id}').json['map']
    assert m['suggestions'] == [] and not m['can_edit']


def test_places_from_suggestions_and_drawn(client, plan_pdf):
    ann = client.as_user('ann')
    as_ann = lambda: client.as_user('ann')
    m = upload(as_ann(), plan_pdf).json['map']
    fridge = next(s for s in m['suggestions'] if s['kind'] == 'fridge')
    m = as_ann().post(f"/api/maps/{m['id']}/suggestions", json={'ids': [fridge['id']]}).json['map']
    assert [p['name'] for p in m['places']] == ['Fridge'] and len(m['suggestions']) == 1
    m = as_ann().post(f"/api/maps/{m['id']}/suggestions", json={'ids': [m['suggestions'][0]['id']], 'dismiss': True}).json['map']
    assert m['suggestions'] == [] and len(m['places']) == 1

    res = as_ann().post(f"/api/maps/{m['id']}/places", json={
        'name': 'Confocal', 'kind': 'equipment', 'resource_id': 'abc', 'shape': {'poly': [[.1, .1], [.2, .1], [.2, .2]]}})
    assert res.status_code == 201
    place = res.json['place']
    assert place['resource_id'] == 'abc' and not place['storage']

    assert client.as_user('bob').put(f"/api/places/{place['id']}", json={'name': 'x'}).status_code == 403
    res = as_ann().put(f"/api/places/{place['id']}", json={'shape': {'rect': [.3, .3, .1, .1]}})
    assert res.json['place']['shape'] == {'rect': [.3, .3, .1, .1]} and res.json['place']['name'] == 'Confocal'

    # Stocks' picker: storage places only, with their map.
    picked = client.as_user('bob').get('/api/places?storage=1').json['places']
    assert [(p['name'], p['map'], p['lab']) for p in picked] == [('Fridge', 'Floor 3', 'Plant Lab')]
    assert client.as_user('cat').get('/api/places').json['places'] == []
    assert client.as_user('cat').get(f"/api/places/{place['id']}").status_code == 404

    assert as_ann().delete(f"/api/places/{place['id']}").status_code == 200


def test_bad_places_refused(client, plan_pdf):
    ann = client.as_user('ann')
    as_ann = lambda: client.as_user('ann')
    map_id = upload(as_ann(), plan_pdf).json['map']['id']
    for body in ({'name': 'x', 'kind': 'fridge'}, {'name': '', 'kind': 'fridge', 'shape': {'rect': [0, 0, .1, .1]}},
                 {'name': 'x', 'kind': 'spaceship', 'shape': {'rect': [0, 0, .1, .1]}},
                 {'name': 'x', 'kind': 'fridge', 'shape': {'rect': [5, 0, .1, .1]}},
                 {'name': 'x', 'kind': 'fridge', 'shape': {'poly': [[0, 0], [1, 1]]}}):
        assert as_ann().post(f'/api/maps/{map_id}/places', json=body).status_code == 400, body


def test_new_drawing_keeps_places(client, plan_pdf):
    ann = client.as_user('ann')
    as_ann = lambda: client.as_user('ann')
    m = upload(as_ann(), plan_pdf).json['map']
    as_ann().post(f"/api/maps/{m['id']}/suggestions", json={'ids': [s['id'] for s in m['suggestions']]})
    res = as_ann().post(f"/api/maps/{m['id']}/drawing", data={'file': (io.BytesIO(plan_pdf), 'v2.pdf')},
                   content_type='multipart/form-data')
    assert res.status_code == 200
    assert len(res.json['map']['places']) == 2 and res.json['map']['source_name'] == 'v2.pdf'


def test_deleted_map_is_gone(client, plan_pdf):
    ann = client.as_user('ann')
    as_ann = lambda: client.as_user('ann')
    map_id = upload(as_ann(), plan_pdf).json['map']['id']
    assert client.as_user('bob').delete(f'/api/maps/{map_id}').status_code == 403
    assert as_ann().delete(f'/api/maps/{map_id}').status_code == 200
    assert as_ann().get('/api/maps').json['maps'] == []


def test_signed_out(client):
    assert client.get('/api/maps').status_code == 401
    assert client.get('/').status_code == 302
    assert client.get('/health').json['status'] == 'healthy'
