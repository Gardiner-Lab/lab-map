"""
Lab Map: a lab's floor plans, with its fridges, freezers, cabinets and equipment marked.

A lab admin uploads the architect's drawing (a PDF, or a picture of it); the places its
labels name are offered to mark, and more can be drawn. Clicking a freezer shows the
stocks kept in it (from Stocks); clicking a piece of equipment opens its calendar in Booking.
"""

import io
import os

from flask import Flask, abort, redirect, render_template, request, send_file

APP_VERSION = '0.1.0'

# The tabs this tool adds to the suite's dashboard (see the suite's pages/dashboard.html).
MANIFEST = {
    'tool': 'Lab Map',
    'tabs': [
        {'id': 'map-view', 'title': 'Lab map', 'icon': '🗺️', 'glyph': 'lab', 'section': 'me',
         'src': '/map/?embed=1'},
    ],
}


class PrefixMiddleware:
    """Mount the app under URL_PREFIX (/map), as the suite's proxy passes the full path."""

    def __init__(self, wsgi_app, prefix: str):
        self.wsgi_app = wsgi_app
        self.prefix = '/' + prefix.strip('/')

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path == self.prefix or path.startswith(self.prefix + '/'):
            environ['SCRIPT_NAME'] = environ.get('SCRIPT_NAME', '') + self.prefix
            environ['PATH_INFO'] = path[len(self.prefix):] or '/'
        return self.wsgi_app(environ, start_response)


def create_app() -> Flask:
    from app import db, maps, people
    from app.api import api

    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = maps.MAX_UPLOAD + 1024 * 1024
    db.initialize(os.environ.get('MAP_DATABASE_PATH', '/map/map.db'))
    app.register_blueprint(api, url_prefix='/api')

    def links() -> dict:
        return {
            'suite_home': os.environ.get('SUITE_HOME_URL', '/'),
            'stocks': os.environ.get('STOCKS_URL', '/stocks').rstrip('/'),
            'booking': os.environ.get('BOOKING_URL', '/booking').rstrip('/'),
            'logout': os.environ.get('SUITE_LOGOUT_URL', '/account/logout'),
        }

    @app.route('/')
    def map_page():
        person = people.current()
        if person is None:
            login = os.environ.get('SUITE_LOGIN_URL', '/account/login')
            return redirect(f'{login}?next={request.script_root}/')
        return render_template('map.html', version=APP_VERSION, person=person, links=links(),
                               embed=request.args.get('embed') == '1')

    @app.route('/plans/<name>.png')
    def plan_drawing(name):
        map_id, overview = (name[:-len('-overview')], True) if name.endswith('-overview') else (name, False)
        person = people.current()
        if person is None:
            abort(401)
        try:
            data, changed = maps.drawing(person, map_id, overview)
        except maps.NotFound:
            abort(404)
        response = send_file(io.BytesIO(data), mimetype='image/png', etag=f'{name}-{changed}', conditional=True,
                             max_age=86400)
        response.headers['Cache-Control'] = 'private, max-age=86400'
        return response

    @app.route('/about')
    def about_page():
        return render_template('about.html', version=APP_VERSION, links=links())

    @app.route('/help')
    def help_page():
        return render_template('help.html', version=APP_VERSION, links=links())

    @app.route('/suite-manifest.json')
    def suite_manifest():
        return MANIFEST

    @app.route('/health')
    def health():
        return {'status': 'healthy', 'version': APP_VERSION}

    prefix = os.environ.get('URL_PREFIX', '').strip('/')
    if prefix:
        app.wsgi_app = PrefixMiddleware(app.wsgi_app, prefix)
    return app


app = create_app() if os.environ.get('MAP_NO_APP') != '1' else None

if __name__ == '__main__':
    create_app().run(host='0.0.0.0', port=int(os.environ.get('PORT', 5010)), debug=True)
