# Lab Map

A Trellis Tools module: each lab's floor plans, with its fridges, freezers, cabinets and equipment marked.

- **Lab admins** upload the floor plan, as a PDF from the architect or facilities or as a picture. The labels a PDF
  uses for equipment (KK, VR, -20, -80, Kast, FC, BSC, INC…) are read with their positions, and the outline drawn round each
  is found in the drawing. Those are offered as suggested places to accept, rename or drop. Anything else is
  drawn as a box or an outline.
- **Everyone in the lab** pans and zooms the plan, finds a place by name or room, and clicks it. A fridge, freezer
  or cabinet shows the stock records kept there (from Lab Stocks). A piece of equipment shows today's bookings and
  opens its calendar (from Booking).
- `#place=<id>` opens the map on one place, so other tools (Lab Stocks' place column) can link to it.

Maps belong to one lab. Its members see them, and its lab admins (and the suite's administrators) change them.
Stocks and bookings are fetched by the browser from those tools' own APIs, so their rules on who sees what hold.

## Running it

It runs inside the suite at `/map/`, behind the suite's proxy, which says who is signed in (`X-Suite-User`).
Not part of the suite's `docker-compose.yml` or `install.sh` yet. For development beside a running suite:

```sh
docker compose -f dev/compose.dev.yml up -d --build
# and add dev/nginx-location.conf to the suite's nginx/default.conf, then: docker exec lab-proxy nginx -s reload
```

Data: the `map-data` volume holds `map.db` (maps and places) and `plans/` (each drawing as a PNG, with an overview).

## Tests

```sh
docker build -t lab-map:local . && docker run --rm lab-map:local python -m pytest -q
```

## Licence

AGPL-3.0 (it uses PyMuPDF, which is AGPL).
