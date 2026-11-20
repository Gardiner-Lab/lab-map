/*
 * Lab Map: a lab's floor plan with its fridges, freezers, cabinets and equipment marked.
 *
 * The drawing is a picture; the places are outlines over it, kept as fractions of its width
 * and height ({rect: [x, y, w, h]} or {poly: [[x, y], ...]}), drawn in an SVG of the same size.
 * Both sit in one "world" that is moved and scaled to pan and zoom.
 *
 * Addresses: #map=<id>, #map=<id>&place=<id>, #place=<id> (from Stocks: the map it is on is looked up).
 * What a freezer holds comes from Stocks' API, what a machine is booked for from Booking's, both
 * asked by the browser, so each tool's own rules on who sees what hold.
 */
'use strict';

const MAP = window.MAP;
const COLOURS = {
  fridge: '#3a8fd1', freezer20: '#2364aa', freezer80: '#5a3da6', fridgefreezer: '#2a7f9e', coldroom: '#1497a8',
  cabinet: '#8b5a2b', shelf: '#b07d2a', equipment: '#7a4a8f', room: '#6f665c', other: '#8a8378',
};
const MIN_SCALE = 0.02;
const MAX_SCALE = 4;

const state = {
  me: null, kinds: {}, maps: [], map: null,
  view: { s: 1, x: 0, y: 0 },
  hidden: new Set(), query: '', selected: null, suggestion: null,
  editing: false, tool: 'select', draft: null, resources: null,
};
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

/** A small element builder: el('td', { class: 'x', onclick }, 'text', child, ...). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** replaceChildren and append that, like el(), flatten lists and leave out null and false. */
const kids = (list) => list.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
const put = (node, ...children) => node.replaceChildren(...kids(children));
const add = (node, ...children) => node.append(...kids(children));

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
}

function toast(message, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, message);
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

async function call(url, method = 'GET', body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method, cache: 'no-store', credentials: 'same-origin',
    headers: body === undefined || isForm ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Something went wrong (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
const api = (path, method, body) => call(`${MAP.base}/api${path}`, method, body);

function remember(key, value) { try { localStorage.setItem(`map.${key}`, value); } catch { /* private window */ } }
function recall(key) { try { return localStorage.getItem(`map.${key}`); } catch { return null; } }

const colour = (kind) => COLOURS[kind] || COLOURS.other;
const kindName = (kind) => state.kinds[kind] || kind;
const canEdit = () => !!(state.map && state.map.can_edit);
const target = MAP.embed ? '_top' : '_self';

/* --- the view: panning and zooming ---------------------------------------------------- */

function applyView() {
  const { s, x, y } = state.view;
  $('world').style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  sharpen();
}

/**
 * The full drawing once zoomed in past what the overview shows sharply; fetched the first time it
 * is needed, and laid over the overview once it has loaded.
 */
function sharpen() {
  if (!state.map) return;
  const full = $('drawing');
  const need = state.map.width * state.view.s * (window.devicePixelRatio || 1) > 2200;
  const src = `${MAP.base}${state.map.drawing}`;
  if (need && full.getAttribute('src') !== src) {
    full.hidden = true;
    full.onload = () => { full.hidden = false; };
    full.src = src;
  } else if (full.getAttribute('src') === src && full.complete) {
    full.hidden = !need;
  }
}

function fit(box) {
  // The whole drawing, or a box of it ([x, y, w, h] in drawing pixels), filling the stage.
  if (!state.map) return;
  const stage = $('stage').getBoundingClientRect();
  const [bx, by, bw, bh] = box || [0, 0, state.map.width, state.map.height];
  const margin = box ? 0.35 : 0.03;
  const s = Math.min(MAX_SCALE, Math.min(stage.width / (bw * (1 + 2 * margin)), stage.height / (bh * (1 + 2 * margin))));
  state.view = { s, x: stage.width / 2 - (bx + bw / 2) * s, y: stage.height / 2 - (by + bh / 2) * s };
  applyView();
}

function zoomAt(factor, cx, cy) {
  const v = state.view;
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
  const k = s / v.s;
  state.view = { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  applyView();
}

function stagePoint(e) {
  const r = $('stage').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** Where on the drawing, as fractions of it. */
function drawingPoint(e) {
  const [sx, sy] = stagePoint(e);
  const { s, x, y } = state.view;
  return [(sx - x) / s / state.map.width, (sy - y) / s / state.map.height];
}

/* --- shapes -------------------------------------------------------------------------- */

function boxOf(shape) {
  if (shape.rect) return shape.rect;
  const xs = shape.poly.map((p) => p[0]);
  const ys = shape.poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function shapeNode(shape, attrs) {
  const W = state.map.width;
  const H = state.map.height;
  if (shape.rect) {
    const [x, y, w, h] = shape.rect;
    return svg('rect', { x: x * W, y: y * H, width: w * W, height: h * H, rx: 2, ...attrs });
  }
  return svg('polygon', { points: shape.poly.map(([x, y]) => `${x * W},${y * H}`).join(' '), ...attrs });
}

function moved(shape, dx, dy) {
  if (shape.rect) return { rect: [shape.rect[0] + dx, shape.rect[1] + dy, shape.rect[2], shape.rect[3]] };
  return { poly: shape.poly.map(([x, y]) => [x + dx, y + dy]) };
}

/* --- what is shown ------------------------------------------------------------------- */

function matches(place) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [place.name, place.room, kindName(place.kind), place.notes, place.match].some((t) => (t || '').toLowerCase().includes(q));
}

function shown(place) { return !state.hidden.has(place.kind); }

function drawOverlay() {
  const overlay = $('overlay');
  overlay.replaceChildren();
  if (!state.map) return;
  const W = state.map.width;
  const H = state.map.height;
  overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  overlay.setAttribute('width', W);
  overlay.setAttribute('height', H);
  const searching = !!state.query.trim();
  for (const place of state.map.places) {
    if (!shown(place)) continue;
    const on = state.selected && state.selected.id === place.id;
    const cls = ['spot', on && 'on', searching && !matches(place) && 'dim', searching && matches(place) && 'found'].filter(Boolean).join(' ');
    const shape = on && state.draft && state.draft.id === place.id ? state.draft.shape : place.shape;
    overlay.append(shapeNode(shape, { class: cls, style: `--c:${colour(place.kind)}`, 'data-place': place.id }));
  }
  if (state.editing) {
    for (const s of state.map.suggestions || []) {
      overlay.append(shapeNode(s.shape, { class: 'suggestion', 'data-suggestion': s.id }));
    }
  }
  // A place being drawn, or the one chosen while editing, with its handles.
  if (state.draft && !state.draft.id) {
    if (state.draft.shape) overlay.append(shapeNode(state.draft.shape, { class: 'ghost' }));
    if (state.draft.points) {
      const pts = state.draft.points.concat(state.draft.cursor ? [state.draft.cursor] : []);
      overlay.append(svg('polyline', { class: 'ghost', points: pts.map(([x, y]) => `${x * W},${y * H}`).join(' ') }));
    }
  }
  if (state.editing && state.selected && state.tool === 'select') {
    const shape = state.draft && state.draft.id === state.selected.id ? state.draft.shape : state.selected.shape;
    const r = 6 / state.view.s;
    if (shape.rect) {
      const [x, y, w, h] = shape.rect;
      [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(([hx, hy], i) => {
        overlay.append(svg('circle', { class: 'handle', cx: hx * W, cy: hy * H, r, 'data-corner': i }));
      });
    } else {
      shape.poly.forEach(([hx, hy], i) => {
        overlay.append(svg('circle', { class: 'handle vertex', cx: hx * W, cy: hy * H, r, 'data-vertex': i }));
      });
    }
  }
}

function drawLegend() {
  const legend = $('legend');
  legend.replaceChildren();
  if (!state.map) return;
  const present = [...new Set(state.map.places.map((p) => p.kind))];
  for (const kind of Object.keys(state.kinds)) {
    if (!present.includes(kind)) continue;
    const n = state.map.places.filter((p) => p.kind === kind).length;
    legend.append(el('span', {
      class: `chip ${state.hidden.has(kind) ? 'off' : ''}`, style: `--c:${colour(kind)}`, title: 'Show or hide',
      onclick: () => {
        if (state.hidden.has(kind)) state.hidden.delete(kind); else state.hidden.add(kind);
        remember('hidden', [...state.hidden].join(','));
        redraw();
      },
    }, el('span', { class: 'dot' }), `${kindName(kind)} ${n}`));
  }
}

function drawList() {
  const list = $('place-list');
  list.replaceChildren();
  if (!state.map) return;
  const places = state.map.places.filter((p) => shown(p) && matches(p));
  if (!places.length) {
    list.append(el('li', { class: 'group' }, state.map.places.length ? 'Nothing matches' : 'No places marked yet'));
    return;
  }
  // By room, as people look for things: "the -80 in B7".
  const rooms = new Map();
  for (const p of places) {
    const room = p.room || 'No room given';
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(p);
  }
  for (const room of [...rooms.keys()].sort((a, b) => a.localeCompare(b))) {
    list.append(el('li', { class: 'group' }, room));
    for (const p of rooms.get(room)) {
      list.append(el('li', {
        class: state.selected && state.selected.id === p.id ? 'on' : '', style: `--c:${colour(p.kind)}`,
        onclick: () => select(p, true),
        onmouseenter: () => hoverSpot(p.id, true), onmouseleave: () => hoverSpot(p.id, false),
      }, el('span', { class: 'dot' }), p.name, el('span', { class: 'room' }, kindName(p.kind))));
    }
  }
}

function hoverSpot(id, on) {
  const node = $('overlay').querySelector(`[data-place="${id}"]`);
  if (node) node.classList.toggle('hover', on);
}

function redraw() { drawOverlay(); drawLegend(); drawList(); }

function drawToolbar() {
  const bar = $('toolbar');
  bar.replaceChildren();
  if (!state.map || !canEdit()) return;
  if (!state.editing) {
    add(bar, el('button', { class: 'tt-btn', onclick: () => setEditing(true) }, '✎ Edit this map'),
      el('span', { class: 'hint' }, `${state.map.lab}'s map: you can mark places on it.`));
    return;
  }
  const tool = (id, label, hint) => el('button', {
    class: `tt-btn ${state.tool === id ? 'on' : ''}`, title: hint,
    onclick: () => { state.tool = id; state.draft = null; $('stage').classList.toggle('drawing', id !== 'select'); drawToolbar(); drawOverlay(); },
  }, label);
  const n = (state.map.suggestions || []).length;
  add(bar,
    tool('select', 'Select', 'Choose a place; drag it or its corners'),
    tool('rect', '▭ Draw a box', 'Drag out a box round the thing'),
    tool('poly', '⬠ Draw an outline', 'Click each corner; click the first again, or double-click, to finish'),
    n ? el('button', { class: 'tt-btn', onclick: suggestionsDialog }, `✨ ${n} suggested`) : null,
    el('span', { class: 'hint' }, {
      select: 'Click a place to change it; drag to move it.',
      rect: 'Drag out a box round the thing.',
      poly: 'Click each corner, then the first again (or double-click).',
    }[state.tool]),
    el('span', { class: 'spacer' }),
    el('button', { class: 'tt-btn', onclick: mapDialog }, 'Map settings'),
    el('button', { class: 'tt-btn primary', onclick: () => setEditing(false) }, 'Done'),
  );
}

function setEditing(on) {
  state.editing = on;
  state.tool = 'select';
  state.draft = null;
  $('stage').classList.remove('drawing');
  $('layout').classList.toggle('editing', on);
  drawToolbar();
  drawOverlay();
  if (state.selected) showPlace(state.selected);
}

/* --- maps ------------------------------------------------------------------------------ */

function drawMapChoice() {
  const choice = $('map-choice');
  choice.replaceChildren();
  const byLab = new Map();
  for (const m of state.maps) {
    if (!byLab.has(m.lab)) byLab.set(m.lab, []);
    byLab.get(m.lab).push(m);
  }
  for (const [lab, maps] of byLab) {
    const group = el('optgroup', { label: lab || 'Lab' });
    for (const m of maps) group.append(el('option', { value: m.id }, m.name));
    choice.append(group);
  }
  if (state.map) choice.value = state.map.id;
  choice.hidden = !state.maps.length;
  $('new-map').hidden = !(state.me.admin_labs || []).length;
}

async function openMap(id, placeId) {
  const { map } = await api(`/maps/${id}`);
  const same = state.map && state.map.id === map.id;
  state.map = map;
  state.selected = null;
  state.suggestion = null;
  state.draft = null;
  remember('map', map.id);
  $('empty').hidden = true;
  const overview = `${MAP.base}${map.overview}`;
  if ($('overview').getAttribute('src') !== overview) $('overview').src = overview;
  if ($('drawing').getAttribute('src') !== `${MAP.base}${map.drawing}`) {
    $('drawing').hidden = true;
    $('drawing').removeAttribute('src');
  }
  $('world').style.width = `${map.width}px`;
  $('world').style.height = `${map.height}px`;
  drawMapChoice();
  drawToolbar();
  redraw();
  closePanel();
  if (!same) fit();
  const place = placeId && map.places.find((p) => p.id === placeId);
  if (place) select(place, true);
  else if (placeId) toast('That place is no longer on this map', 'error');
}

async function reloadMap() {
  const keep = state.selected && state.selected.id;
  const { map } = await api(`/maps/${state.map.id}`);
  state.map = map;
  state.selected = keep ? map.places.find((p) => p.id === keep) || null : null;
  drawToolbar();
  redraw();
}

function showEmpty() {
  const admin = (state.me.admin_labs || []).length;
  $('empty').hidden = false;
  put($('empty'), el('div', { class: 'box' },
    el('img', { src: `${MAP.base}/static/trellis/map.svg`, alt: '' }),
    el('h2', {}, 'No map yet'),
    admin
      ? [el('p', {}, "Upload your lab's floor plan, as a PDF from the architect or facilities, or a picture of it. "
          + "The fridges, freezers, cabinets and equipment its labels name are suggested for you to mark."),
        el('button', { class: 'tt-btn primary', onclick: newMapDialog }, 'Upload a floor plan')]
      : el('p', {}, "Your lab has no map yet. A lab admin of your lab can upload its floor plan.")));
}

/* --- choosing a place, and the panel -------------------------------------------------- */

function select(place, zoom = false) {
  state.selected = place;
  state.suggestion = null;
  state.draft = null;
  history.replaceState(null, '', `#map=${state.map.id}&place=${place.id}`);
  redraw();
  // The panel first: it narrows the drawing, which is then centred on the place.
  showPlace(place);
  if (zoom) zoomTo(place.shape);
}

/** Centre on a shape, close enough to see the bench round it, never so close the drawing blurs. */
function zoomTo(shape) {
  const [x, y, w, h] = boxOf(shape);
  const W = state.map.width;
  const H = state.map.height;
  const stage = $('stage').getBoundingClientRect();
  const s = Math.min(0.6, Math.max(state.view.s, Math.min(stage.width / (w * W * 14), stage.height / (h * H * 14))));
  state.view = { s, x: stage.width / 2 - (x + w / 2) * W * s, y: stage.height / 2 - (y + h / 2) * H * s };
  applyView();
  drawOverlay();
}

function closePanel() {
  $('panel').hidden = true;
  $('panel').replaceChildren();
}

function deselect() {
  state.selected = null;
  state.suggestion = null;
  state.draft = null;
  if (state.map) history.replaceState(null, '', `#map=${state.map.id}`);
  closePanel();
  redraw();
}

function panelHead(title, kind) {
  return el('div', {},
    el('h2', {}, el('span', { class: 'badge', style: `--c:${colour(kind)}` }, kindName(kind)),
      el('button', { class: 'close', title: 'Close', onclick: deselect }, '×')),
    el('h2', {}, title));
}

function showPlace(place) {
  const panel = $('panel');
  panel.hidden = false;
  const parts = [
    panelHead(place.name, place.kind),
    el('div', { class: 'meta' }, [place.room, state.map.name].filter(Boolean).join(' · ')),
    place.notes ? el('p', { class: 'notes' }, place.notes) : null,
  ];
  const booking = el('div');
  const stocks = el('div');
  if (place.resource_id) parts.push(booking);
  if (place.storage) parts.push(stocks);
  if (!place.resource_id && !place.storage) parts.push(el('p', { class: 'muted' }, 'Not linked to anything to book.'));
  if (canEdit()) {
    parts.push(el('div', { class: 'actions' },
      el('button', { class: 'tt-btn', onclick: () => editPlace(place) }, '✎ Change'),
      el('button', {
        class: 'tt-btn', title: 'Copy a link to this place',
        onclick: () => copyLink(place),
      }, '🔗 Link')));
  } else {
    parts.push(el('div', { class: 'actions' }, el('button', { class: 'tt-btn', onclick: () => copyLink(place) }, '🔗 Link to this place')));
  }
  put(panel, ...parts.filter(Boolean));
  if (place.resource_id) fillBooking(booking, place);
  if (place.storage) fillStocks(stocks, place);
}

function copyLink(place) {
  const url = `${location.origin}${MAP.base}/#place=${place.id}`;
  navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast(url));
}

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

async function fillBooking(box, place) {
  const href = `${MAP.booking}/#calendar=${encodeURIComponent(place.resource_id)}`;
  put(box, el('h3', {}, 'Booking'), el('div', { class: 'busy-note' }, el('span', { class: 'spinner' }), 'Today’s bookings…'));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  let content;
  try {
    const data = await call(`${MAP.booking}/api/bookings?from=${encodeURIComponent(start.toISOString())}`
      + `&to=${encodeURIComponent(end.toISOString())}&resource=${encodeURIComponent(place.resource_id)}`);
    const resource = (data.resources || [])[0];
    if (!resource) {
      content = el('p', { class: 'muted' }, 'This equipment is not shared with your lab in Booking.');
    } else {
      const now = new Date();
      const today = data.bookings || [];
      const busy = today.some((b) => new Date(b.start) <= now && new Date(b.end) > now);
      content = [
        el('p', {}, el('strong', {}, resource.name), ' · ', busy ? el('span', { class: 'busy' }, 'in use now') : el('span', { class: 'free' }, 'free now')),
        today.length
          ? el('ul', { class: 'slots' }, today.map((b) => el('li', {},
            el('span', { class: 'when' }, `${hm(new Date(b.start))}–${hm(new Date(b.end))}`),
            el('span', {}, b.title || b.booked_by))))
          : el('p', { class: 'muted' }, 'Nothing booked today.'),
        el('div', { class: 'actions' }, el('a', { class: 'tt-btn primary', href, target }, '📅 Book it')),
      ];
    }
  } catch (err) {
    content = [el('p', { class: 'muted' }, err.status === 404 ? 'Booking is not part of this suite.' : `Booking did not answer: ${err.message}`),
      el('a', { class: 'tt-btn', href, target }, 'Open in Booking')];
  }
  put(box, el('h3', {}, 'Booking'), content);
}

const STOCK_KINDS = { glycerol: 'Glycerol stock', primer: 'Primer', chemical: 'Chemical', antibody: 'Antibody', material: 'Plant material' };

async function fillStocks(box, place) {
  put(box, el('h3', {}, 'Stocks kept here'), el('div', { class: 'busy-note' }, el('span', { class: 'spinner' }), 'Looking in Stocks…'));
  let records = null;
  let how = '';
  try {
    // Stocks that name this place (Stocks' place picker).
    records = (await call(`${MAP.stocks}/api/places/${encodeURIComponent(place.id)}`)).records;
  } catch (err) {
    if (err.status !== 404) {
      put(box, el('h3', {}, 'Stocks kept here'), el('p', { class: 'muted' }, `Stocks did not answer: ${err.message}`));
      return;
    }
  }
  // Older stock records only say where they are in words: those words, as a lab admin gave them.
  const words = (place.match || '').split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
  if (words.length) {
    const seen = new Set((records || []).map((r) => `${r.kind}:${r.code}`));
    const extra = [];
    for (const word of words) {
      try {
        for (const r of (await call(`${MAP.stocks}/api/search?q=${encodeURIComponent(word)}`)).results || []) {
          if (!seen.has(`${r.kind}:${r.code}`)) { seen.add(`${r.kind}:${r.code}`); extra.push(r); }
        }
      } catch { /* Stocks not here */ }
    }
    if (extra.length) how = `Including records whose location mentions ${words.map((w) => `“${w}”`).join(' or ')}.`;
    records = (records || []).concat(extra);
  }
  const parts = [el('h3', {}, 'Stocks kept here')];
  if (!records || !records.length) {
    parts.push(el('p', { class: 'muted' }, records ? 'No stocks of yours are recorded here.' : 'No stocks recorded here yet.'));
  } else {
    parts.push(el('ul', { class: 'records' }, records.map((r) => el('li', {},
      el('a', { href: `${MAP.stocks}/#${r.kind}=${encodeURIComponent(r.code)}`, target },
        el('span', { class: 'code' }, r.code), el('span', {}, (r.label || '').replace(r.code, '').trim()),
        el('span', { class: 'kind' }, STOCK_KINDS[r.kind] || r.kind))))));
    if (how) parts.push(el('p', { class: 'muted' }, how));
  }
  parts.push(el('div', { class: 'actions' }, el('a', { class: 'tt-btn', href: `${MAP.stocks}/`, target }, 'Open Stocks')));
  put(box, ...parts);
}

/* --- changing a place --------------------------------------------------------------------- */

async function loadResources() {
  if (state.resources) return state.resources;
  try {
    state.resources = (await call(`${MAP.booking}/api/resources`)).resources || [];
  } catch {
    state.resources = [];
  }
  return state.resources;
}

async function editPlace(place, shape) {
  // place: an existing one, or null for a new one drawn as shape.
  if (!state.editing) setEditing(true);
  const panel = $('panel');
  panel.hidden = false;
  const resources = await loadResources();
  const kind = place ? place.kind : 'fridge';
  const f = {
    name: el('input', { value: place ? place.name : '', required: true, maxlength: 120, placeholder: 'e.g. -80 freezer 2' }),
    kind: el('select', {}, Object.entries(state.kinds).map(([k, v]) => el('option', { value: k, selected: k === kind }, v))),
    room: el('input', { value: place ? place.room : '', maxlength: 120, list: 'rooms', placeholder: 'e.g. B7/B8 (03.6.077)' }),
    resource: el('select', {}, el('option', { value: '' }, '— not booked —'),
      resources.map((r) => el('option', { value: r.id, selected: place && place.resource_id === r.id },
        `${r.name}${r.kind ? ` (${r.kind})` : ''}${r.owner_lab ? ` · ${r.owner_lab}` : ''}`))),
    match: el('input', { value: place ? place.match : '', maxlength: 500, placeholder: 'e.g. -80 B7, freezer 2' }),
    notes: el('textarea', { maxlength: 2000 }, place ? place.notes : ''),
  };
  if (place && place.resource_id && !resources.some((r) => r.id === place.resource_id)) {
    f.resource.append(el('option', { value: place.resource_id, selected: true }, '(equipment you cannot see in Booking)'));
  }
  const rooms = [...new Set(state.map.places.map((p) => p.room).filter(Boolean))].sort();
  const error = el('div', { class: 'error', hidden: true });
  const save = async (e) => {
    e.preventDefault();
    const body = {
      name: f.name.value, kind: f.kind.value, room: f.room.value, resource_id: f.resource.value,
      match: f.match.value, notes: f.notes.value,
    };
    if (shape) body.shape = shape;
    try {
      const { place: saved } = place
        ? await api(`/places/${place.id}`, 'PUT', body)
        : await api(`/maps/${state.map.id}/places`, 'POST', body);
      await reloadMap();
      const fresh = state.map.places.find((p) => p.id === saved.id);
      toast(place ? 'Saved' : 'Place added');
      state.tool = 'select';
      $('stage').classList.remove('drawing');
      drawToolbar();
      if (fresh) select(fresh);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
  put(panel, el('form', { class: 'form', onsubmit: save },
    el('h2', {}, place ? 'Change this place' : 'New place',
      el('button', { type: 'button', class: 'close', title: 'Close', onclick: () => (place ? select(place) : cancelDraft()) }, '×')),
    el('label', { class: 'field' }, el('span', {}, 'Name'), f.name),
    el('label', { class: 'field' }, el('span', {}, 'What it is'), f.kind),
    el('label', { class: 'field' }, el('span', {}, 'Room'), f.room, el('datalist', { id: 'rooms' }, rooms.map((r) => el('option', { value: r })))),
    el('label', { class: 'field' }, el('span', {}, 'Booked in Booking as'), f.resource,
      el('small', {}, 'Clicking it on the map then shows its bookings and opens its calendar.')),
    el('label', { class: 'field' }, el('span', {}, 'Older stock records call it'), f.match,
      el('small', {}, 'Words, separated by commas, that stock records written before the map use for this place. Stocks found by them show here too.')),
    el('label', { class: 'field' }, el('span', {}, 'Notes'), f.notes),
    error,
    el('div', { class: 'foot' },
      place ? el('button', { type: 'button', class: 'tt-btn danger left', onclick: () => removePlace(place) }, 'Remove') : null,
      el('button', { type: 'button', class: 'tt-btn', onclick: () => (place ? select(place) : cancelDraft()) }, 'Cancel'),
      el('button', { type: 'submit', class: 'tt-btn primary' }, place ? 'Save' : 'Add place'))));
  f.name.focus();
}

function cancelDraft() {
  state.draft = null;
  deselect();
}

function confirmDialog(title, text, yes, danger = true) {
  return new Promise((resolve) => {
    const d = $('dialog');
    const done = (v) => { d.close(); resolve(v); };
    put(d, el('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(true); } },
      el('h2', {}, title), el('p', {}, text),
      el('div', { class: 'foot' },
        el('button', { type: 'button', class: 'tt-btn', onclick: () => done(false) }, 'Cancel'),
        el('button', { type: 'submit', class: `tt-btn ${danger ? 'danger' : 'primary'}` }, yes))));
    d.onclose = () => resolve(false);
    d.showModal();
  });
}

async function removePlace(place) {
  if (!await confirmDialog('Remove this place?', `“${place.name}” comes off the map. Stocks that named it keep their records, without a place.`, 'Remove')) return;
  try {
    await api(`/places/${place.id}`, 'DELETE');
    toast('Removed');
    await reloadMap();
    deselect();
  } catch (err) { toast(err.message, 'error'); }
}

async function saveShape(place, shape) {
  try {
    await api(`/places/${place.id}`, 'PUT', { shape });
    place.shape = shape;
  } catch (err) {
    toast(err.message, 'error');
  }
  state.draft = null;
  drawOverlay();
}

/* --- suggestions -------------------------------------------------------------------------- */

function showSuggestion(s) {
  state.suggestion = s;
  state.selected = null;
  const panel = $('panel');
  panel.hidden = false;
  const take = async (dismiss) => {
    try {
      const { map } = await api(`/maps/${state.map.id}/suggestions`, 'POST', { ids: [s.id], dismiss });
      state.map = map;
      drawToolbar();
      if (dismiss) { deselect(); return; }
      const added = map.places.find((p) => p.name === s.name && JSON.stringify(p.shape) === JSON.stringify(s.shape));
      if (added) select(added); else deselect();
    } catch (err) { toast(err.message, 'error'); }
  };
  put(panel, 
    panelHead(s.name, s.kind),
    el('div', { class: 'meta' }, s.room || 'Room not known'),
    el('p', {}, 'Suggested from the label ', el('strong', {}, s.label), ' on the drawing.'),
    el('div', { class: 'actions' },
      el('button', { class: 'tt-btn primary', onclick: () => take(false) }, 'Add to the map'),
      el('button', { class: 'tt-btn', onclick: () => take(true) }, 'Not needed')));
  redraw();
}

function suggestionsDialog() {
  const all = state.map.suggestions || [];
  const d = $('dialog');
  const boxes = new Map();
  const groups = {};
  for (const s of all) (groups[s.kind] = groups[s.kind] || []).push(s);
  const list = el('div', { class: 'sugg-list' });
  for (const kind of Object.keys(state.kinds)) {
    if (!groups[kind]) continue;
    const head = el('input', { type: 'checkbox', checked: kind !== 'equipment' || true });
    list.append(el('label', { class: 'group' }, head, `${kindName(kind)} (${groups[kind].length})`));
    const mine = [];
    for (const s of groups[kind].sort((a, b) => (a.room || '').localeCompare(b.room || ''))) {
      const box = el('input', { type: 'checkbox', checked: true });
      boxes.set(s.id, box);
      mine.push(box);
      list.append(el('label', {}, box, s.name, el('span', { class: 'room' }, s.room)));
    }
    head.addEventListener('change', () => mine.forEach((b) => { b.checked = head.checked; }));
  }
  const chosen = () => [...boxes].filter(([, b]) => b.checked).map(([id]) => id);
  const error = el('div', { class: 'error', hidden: true });
  const go = async (dismiss) => {
    const ids = chosen();
    if (!ids.length) return;
    try {
      const { map } = await api(`/maps/${state.map.id}/suggestions`, 'POST', { ids, dismiss });
      state.map = map;
      d.close();
      drawToolbar();
      redraw();
      toast(dismiss ? `${ids.length} suggestions dropped` : `${ids.length} places added`);
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  };
  put(d, el('form', { onsubmit: (e) => e.preventDefault() },
    el('h2', {}, `${all.length} places suggested by the drawing`),
    el('p', { class: 'muted' }, 'Found from the labels on the PDF (KK a fridge, VR or -20 a freezer, Kast a cabinet, FC a flow cabinet…). '
      + 'They show dashed on the map. Add the ones that are yours; their names and rooms can be changed afterwards.'),
    list, error,
    el('div', { class: 'foot' },
      el('button', { type: 'button', class: 'tt-btn danger left', onclick: () => go(true) }, 'Drop the ticked ones'),
      el('button', { type: 'button', class: 'tt-btn', onclick: () => d.close() }, 'Cancel'),
      el('button', { type: 'button', class: 'tt-btn primary', onclick: () => go(false) }, 'Add the ticked ones'))));
  d.showModal();
}

/* --- maps: adding, settings ---------------------------------------------------------------- */

function uploadField() {
  return el('input', { type: 'file', accept: '.pdf,application/pdf,image/png,image/jpeg,image/webp', required: true });
}

function newMapDialog() {
  const d = $('dialog');
  const labs = state.me.admin_labs || [];
  const f = {
    lab: el('select', {}, labs.map((l) => el('option', { value: l.id }, l.name))),
    name: el('input', { maxlength: 120, placeholder: 'e.g. 3rd floor south' }),
    file: uploadField(),
    page: el('input', { type: 'number', min: 1, value: 1, style: 'width:6rem' }),
  };
  const error = el('div', { class: 'error', hidden: true });
  const busy = el('div', { class: 'busy-note', hidden: true }, el('span', { class: 'spinner' }), 'Reading the drawing… (a large PDF takes a few seconds)');
  const submit = el('button', { type: 'submit', class: 'tt-btn primary' }, 'Upload');
  put(d, el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const form = new FormData();
      form.append('lab_id', f.lab.value);
      form.append('name', f.name.value);
      form.append('page', f.page.value || '1');
      form.append('file', f.file.files[0]);
      busy.hidden = false; error.hidden = true; submit.disabled = true;
      try {
        const { map } = await api('/maps', 'POST', form);
        d.close();
        state.maps = (await api('/maps')).maps;
        await openMap(map.id);
        setEditing(true);
        if ((map.suggestions || []).length) suggestionsDialog();
      } catch (err) {
        error.textContent = err.message; error.hidden = false;
      } finally { busy.hidden = true; submit.disabled = false; }
    },
  },
  el('h2', {}, 'Upload a floor plan'),
  el('p', { class: 'muted' }, 'A PDF from the architect or facilities is best: its labels become suggested places. A picture (PNG, JPEG) works too; then you draw the places yourself.'),
  labs.length > 1 ? el('label', { class: 'field' }, el('span', {}, 'Lab'), f.lab) : null,
  el('label', { class: 'field' }, el('span', {}, 'Name'), f.name, el('small', {}, 'Left empty, the file’s name.')),
  el('label', { class: 'field' }, el('span', {}, 'Floor plan'), f.file),
  el('label', { class: 'field' }, el('span', {}, 'Page of the PDF'), f.page),
  busy, error,
  el('div', { class: 'foot' },
    el('button', { type: 'button', class: 'tt-btn', onclick: () => d.close() }, 'Cancel'), submit)));
  d.showModal();
}

function mapDialog() {
  const d = $('dialog');
  const m = state.map;
  const f = {
    name: el('input', { value: m.name, maxlength: 120, required: true }),
    description: el('textarea', { maxlength: 2000 }, m.description),
    file: el('input', { type: 'file', accept: '.pdf,application/pdf,image/png,image/jpeg,image/webp' }),
    page: el('input', { type: 'number', min: 1, value: 1, style: 'width:6rem' }),
  };
  const error = el('div', { class: 'error', hidden: true });
  const busy = el('div', { class: 'busy-note', hidden: true }, el('span', { class: 'spinner' }), 'Saving…');
  put(d, el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      busy.hidden = false; error.hidden = true;
      try {
        await api(`/maps/${m.id}`, 'PUT', { name: f.name.value, description: f.description.value });
        if (f.file.files[0]) {
          const form = new FormData();
          form.append('file', f.file.files[0]);
          form.append('page', f.page.value || '1');
          await api(`/maps/${m.id}/drawing`, 'POST', form);
        }
        d.close();
        state.maps = (await api('/maps')).maps;
        state.map = null;
        await openMap(m.id);
        setEditing(true);
        toast('Saved');
      } catch (err) { error.textContent = err.message; error.hidden = false; } finally { busy.hidden = true; }
    },
  },
  el('h2', {}, 'Map settings'),
  el('label', { class: 'field' }, el('span', {}, 'Name'), f.name),
  el('label', { class: 'field' }, el('span', {}, 'Description'), f.description),
  el('label', { class: 'field' }, el('span', {}, 'A new version of the drawing'), f.file,
    el('small', {}, `Now: ${m.source_name || 'uploaded drawing'}. The places stay where they are on the page, so a revision of the same plan needs no re-marking.`)),
  el('label', { class: 'field' }, el('span', {}, 'Page of the PDF'), f.page),
  busy, error,
  el('div', { class: 'foot' },
    el('button', {
      type: 'button', class: 'tt-btn danger left',
      onclick: async () => {
        d.close();
        if (!await confirmDialog('Delete this map?', `“${m.name}” and its ${m.places.length} places go out of sight for everyone in ${m.lab}. An administrator can bring it back from a backup.`, 'Delete map')) return;
        try {
          await api(`/maps/${m.id}`, 'DELETE');
          state.map = null;
          await start();
          toast('Map deleted');
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Delete map'),
    el('button', { type: 'button', class: 'tt-btn', onclick: () => d.close() }, 'Cancel'),
    el('button', { type: 'submit', class: 'tt-btn primary' }, 'Save'))));
  d.showModal();
}

/* --- the pointer: pan, pinch, click, draw, move ----------------------------------------- */

const pointers = new Map();
let gesture = null;

function onDown(e) {
  if (!state.map || e.button > 0) return;
  $('stage').setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, stagePoint(e));
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), view: { ...state.view }, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  const t = e.target;
  const at = drawingPoint(e);
  const [sx, sy] = stagePoint(e);
  if (state.editing && state.tool === 'rect') {
    gesture = { type: 'rect', from: at };
    state.draft = { shape: { rect: [at[0], at[1], 0, 0] } };
    return;
  }
  if (state.editing && state.tool === 'poly') {
    gesture = { type: 'polyclick', start: [sx, sy] };
    return;
  }
  if (state.editing && state.selected && t.dataset && (t.dataset.corner !== undefined || t.dataset.vertex !== undefined)) {
    gesture = { type: 'handle', corner: t.dataset.corner, vertex: t.dataset.vertex, place: state.selected, shape: state.selected.shape };
    return;
  }
  if (state.editing && state.selected && t.dataset && t.dataset.place === state.selected.id) {
    gesture = { type: 'move', from: at, place: state.selected, shape: state.selected.shape, start: [sx, sy], moved: false };
    return;
  }
  gesture = { type: 'pan', start: [sx, sy], view: { ...state.view }, target: t, moved: false };
}

function onMove(e) {
  if (state.map && !gesture) hoverTip(e);
  if (!pointers.has(e.pointerId)) {
    if (state.draft && state.draft.points) { state.draft.cursor = drawingPoint(e); drawOverlay(); }
    return;
  }
  pointers.set(e.pointerId, stagePoint(e));
  if (!gesture) return;
  const [sx, sy] = stagePoint(e);
  if (gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const v = gesture.view;
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * dist / gesture.dist));
    const k = s / v.s;
    state.view = { s, x: mid[0] - (gesture.mid[0] - v.x) * k, y: mid[1] - (gesture.mid[1] - v.y) * k };
    applyView();
  } else if (gesture.type === 'pan') {
    const dx = sx - gesture.start[0];
    const dy = sy - gesture.start[1];
    if (Math.abs(dx) + Math.abs(dy) > 4) { gesture.moved = true; $('stage').classList.add('panning'); $('tip').hidden = true; }
    state.view = { ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy };
    applyView();
  } else if (gesture.type === 'rect') {
    const at = drawingPoint(e);
    const [x0, y0] = gesture.from;
    state.draft = { shape: { rect: [Math.min(x0, at[0]), Math.min(y0, at[1]), Math.abs(at[0] - x0), Math.abs(at[1] - y0)] } };
    drawOverlay();
  } else if (gesture.type === 'move') {
    const at = drawingPoint(e);
    if (Math.abs(sx - gesture.start[0]) + Math.abs(sy - gesture.start[1]) > 3) gesture.moved = true;
    state.draft = { id: gesture.place.id, shape: moved(gesture.shape, at[0] - gesture.from[0], at[1] - gesture.from[1]) };
    drawOverlay();
  } else if (gesture.type === 'handle') {
    const at = drawingPoint(e);
    let shape;
    if (gesture.shape.rect) {
      const [x, y, w, h] = gesture.shape.rect;
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const opposite = corners[(Number(gesture.corner) + 2) % 4];
      shape = { rect: [Math.min(opposite[0], at[0]), Math.min(opposite[1], at[1]), Math.abs(at[0] - opposite[0]), Math.abs(at[1] - opposite[1])] };
    } else {
      shape = { poly: gesture.shape.poly.map((p, i) => (i === Number(gesture.vertex) ? at : p)) };
    }
    state.draft = { id: gesture.place.id, shape };
    gesture.moved = true;
    drawOverlay();
  }
}

function onUp(e) {
  pointers.delete(e.pointerId);
  $('stage').classList.remove('panning');
  if (!gesture) return;
  const g = gesture;
  if (g.type === 'pinch') {
    if (pointers.size < 2) gesture = null;
    return;
  }
  gesture = null;
  if (g.type === 'pan' && !g.moved) click(g.target);
  else if (g.type === 'rect') {
    const shape = state.draft && state.draft.shape;
    const W = state.map.width;
    if (!shape || shape.rect[2] * W * state.view.s < 6 || shape.rect[3] * state.map.height * state.view.s < 6) {
      state.draft = null; drawOverlay(); return;
    }
    state.selected = null;
    editPlace(null, shape);
  } else if (g.type === 'polyclick') {
    const at = drawingPoint(e);
    const d = state.draft && state.draft.points ? state.draft : (state.draft = { points: [] });
    const first = d.points[0];
    const near = first && Math.hypot((first[0] - at[0]) * state.map.width, (first[1] - at[1]) * state.map.height) * state.view.s < 10;
    if (near && d.points.length >= 3) finishPoly();
    else { d.points.push(at); drawOverlay(); }
  } else if ((g.type === 'move' || g.type === 'handle') && g.moved && state.draft) {
    saveShape(g.place, state.draft.shape);
  }
}

function finishPoly() {
  const d = state.draft;
  if (!d || !d.points || d.points.length < 3) return;
  const shape = { poly: d.points };
  state.draft = { shape };
  state.selected = null;
  editPlace(null, shape);
}

function click(t) {
  const placeId = t && t.dataset && t.dataset.place;
  const sugg = t && t.dataset && t.dataset.suggestion;
  if (placeId) {
    const place = state.map.places.find((p) => p.id === placeId);
    if (place) select(place);
  } else if (sugg) {
    const s = (state.map.suggestions || []).find((x) => x.id === sugg);
    if (s) showSuggestion(s);
  } else if (state.selected || state.suggestion) {
    deselect();
  }
}

function hoverTip(e) {
  const tip = $('tip');
  const t = e.target;
  const place = t.dataset && t.dataset.place && state.map.places.find((p) => p.id === t.dataset.place);
  const sugg = t.dataset && t.dataset.suggestion && (state.map.suggestions || []).find((s) => s.id === t.dataset.suggestion);
  const what = place || sugg;
  if (!what) { tip.hidden = true; return; }
  const [sx, sy] = stagePoint(e);
  put(tip, what.name, el('small', {}, [sugg ? 'Suggested · ' : '', what.room || kindName(what.kind)].join('')));
  tip.style.left = `${sx}px`;
  tip.style.top = `${sy}px`;
  tip.hidden = false;
}

/* --- starting up -------------------------------------------------------------------------- */

function hashParams() {
  return new URLSearchParams(location.hash.slice(1).replace(/&amp;/g, '&'));
}

async function route() {
  const params = hashParams();
  let mapId = params.get('map');
  const placeId = params.get('place');
  if (placeId && !mapId) {
    try {
      mapId = (await api(`/places/${encodeURIComponent(placeId)}`)).place.map_id;
    } catch (err) {
      toast(err.status === 404 ? 'That place is not on a map you can see' : err.message, 'error');
    }
  }
  if (mapId && state.map && state.map.id === mapId) {
    const place = placeId && state.map.places.find((p) => p.id === placeId);
    if (place && (!state.selected || state.selected.id !== place.id)) select(place, true);
    return;
  }
  const known = state.maps.find((m) => m.id === mapId) || state.maps.find((m) => m.id === recall('map')) || state.maps[0];
  if (!known) { showEmpty(); return; }
  await openMap(known.id, known.id === mapId ? placeId : null);
}

async function start() {
  const [me, list] = await Promise.all([api('/me'), api('/maps')]);
  state.me = me;
  state.kinds = me.kinds;
  state.maps = list.maps;
  state.hidden = new Set((recall('hidden') || '').split(',').filter(Boolean));
  drawMapChoice();
  await route();
}

function wire() {
  const stage = $('stage');
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('pointerleave', () => { $('tip').hidden = true; });
  stage.addEventListener('dblclick', (e) => { if (state.editing && state.tool === 'poly') { e.preventDefault(); finishPoly(); } });
  stage.addEventListener('wheel', (e) => {
    if (!state.map) return;
    e.preventDefault();
    const [sx, sy] = stagePoint(e);
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), sx, sy);
    if (state.editing && state.selected) drawOverlay();
  }, { passive: false });
  const centre = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $('zoom-in').addEventListener('click', () => zoomAt(1.5, ...centre()));
  $('zoom-out').addEventListener('click', () => zoomAt(1 / 1.5, ...centre()));
  $('zoom-fit').addEventListener('click', () => fit());
  $('map-choice').addEventListener('change', (e) => { location.hash = `map=${e.target.value}`; });
  $('new-map').addEventListener('click', newMapDialog);
  $('find').addEventListener('input', (e) => {
    state.query = e.target.value;
    redraw();
  });
  $('find').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !state.map) return;
    const first = state.map.places.find((p) => shown(p) && matches(p));
    if (first) select(first, true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'Escape') {
      if (state.draft && !state.draft.id) { state.draft = null; drawOverlay(); } else deselect();
    } else if (e.key === 'Enter' && state.draft && state.draft.points) {
      finishPoly();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.editing && state.selected) {
      removePlace(state.selected);
    }
  });
  window.addEventListener('hashchange', () => route().catch((err) => toast(err.message, 'error')));
  window.addEventListener('resize', () => { if (state.map && !state.selected) fit(); });
}

wire();
start().catch((err) => {
  $('empty').hidden = false;
  put($('empty'), el('div', { class: 'box' }, el('h2', {}, 'The map could not be opened'), el('p', {}, err.message)));
});
