# Walktime Map: Maynooth

Interactive web map showing how far Maynooth is, on foot, from five kinds of everyday services:
Food & Drinks, Fitness, Supplies, Pharmacy and Healthcare (GP).

Pick a service (or the average of all five) to colour the hexes by walking time. Click a hex to see the
time and nearest service for each category, and to watch the walking route to the nearest one being traced.

## Run it locally

The page loads its data with `fetch`, so it needs a small web server (opening the file directly will not work):

```
python -m http.server
```

Then open http://localhost:8000

## Host it on GitHub Pages

1. Put this folder in a GitHub repository.
2. Settings > Pages > Deploy from a branch > `main` and `/ (root)`.
3. The map appears at `https://<your-username>.github.io/<repo-name>/`.

## How the data was made

- **Grid:** 100 H3 hexes (resolution 9, about 190 m edges) covering Maynooth.
- **Services:** point layers from OpenStreetMap (Food & Drinks 46, Supplies 13, GP 7, Pharmacy 6, Fitness 3).
- **Routing:** OSRM running in Docker with the walking (foot) profile, about 5 km/h, on an OSM extract (`maynooth1.osm.pbf`).
- **Method:** each hex centre and each service point is snapped to the walking network. OSRM's table service gives
  the walking time from every hex to every service of a type, and the smallest one is kept. The route to that
  service is fetched with OSRM's route service. See `pipeline/walktime_pipeline.py`.
- **Average:** simple mean of the five service times.

Rebuild the OSRM files (run in a folder containing the `.osm.pbf`):

```
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/foot.lua /data/maynooth1.osm.pbf
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/maynooth1.osrm
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/maynooth1.osrm
docker run -t -i -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/maynooth1.osrm
```

## Limits to keep in mind

- Each hex is represented by one point, its centre, not by an average over the hex.
- Times start where the hex centre meets the walking network. For a few edge hexes the centre is far from
  any path (up to about 400 m), and that walk is not included. The sidebar flags these hexes.
- Times are not capped, so edge hexes can exceed 30 minutes.
- Only three gyms are mapped, so the Fitness result partly reflects how many were included.
- Walking time uses one flat speed and ignores hills, crossings and pavement quality.
