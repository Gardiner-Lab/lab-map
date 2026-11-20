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
Part of the suite from Trellis Tools 2.61.0, which pins this image (`ghcr.io/gardiner-lab/lab-map`). To try a change
against a running suite, build it from here with the suite's `docker-compose.local.yml`, or beside it:

```sh
docker compose -f dev/compose.dev.yml up -d --build
```

Data: the `map-data` volume holds one database, `map.db`: the maps, their places, and each drawing (a PNG and a
small overview), so the suite's nightly database backup carries all of it.

## Tests

```sh
docker build -t lab-map:local . && docker run --rm lab-map:local python -m pytest -q
```

## Licence

AGPL-3.0 (it uses PyMuPDF, which is AGPL).
