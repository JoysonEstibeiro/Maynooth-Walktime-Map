# Walktime Map: Maynooth

**[View the live map](https://joysonestibeiro.github.io/Maynooth-Walktime-Map/)**

Interactive web map showing how a neighbourhood in Maynooth is, on foot, from five kinds of essential/everyday services:
Food & Drinks, Fitness, Supplies, Pharmacy and Healthcare (GP).

Pick a service (or the average of all five) to colour the hexes by walking time. Click a hex to see the
time and nearest service for each category, and to watch the walking route to the nearest one being traced.

Inspired by Bruno et al. (2024) and their framework for inclusive 15-minute cities, and its companion platform, [whatif.sonycsl.it/15mincity.](https://whatif.sonycsl.it/15mincity/index.php) 

## Tech stack

- **QGIS** — visualisation and data processing
- **Python** — data pulling and the OSRM routing pipeline
- **OSRM** — walking-time routing engine, run locally in Docker
- **HTML/CSS/JavaScript (Leaflet)** — the interactive web map

## How the data was made

- **Grid:** 100 H3 hexes (resolution 9, about 190 m edges) covering Maynooth.
- **Services:** point layers from OpenStreetMap (Food & Drinks 46, Supplies 13, GP 7, Pharmacy 6, Fitness 3).
- **Routing:** Open Street routing machine (OSRM) Locally running in Docker with the walking (foot) profile, about 5 km/h, on an OSM extract (`maynooth1.osm.pbf`).
- **Method:** each hex centre and each service point is snapped to the walking network. OSRM's table service gives
  the walking time from every hex to every service of a type, and the smallest one is kept. The route to that
  service is fetched with OSRM's route service. See `pipeline/walktime_pipeline.py`.
- **Average:** simple mean of the five service times.

## Limits to keep in mind

- Each hex is represented by one point, its centre, not by an average over the hex.
- Times start where the hex centre meets the walking network. For a few edge hexes the centre is far from
  any path (up to about 400 m), and that walk is not included. The sidebar flags these hexes.
- Times are not capped, so edge hexes can exceed 40 minutes.

## Credits

Built by Joyson Estibeiro. Data extraction, processing and the OSRM routing pipeline is the work of the Author; 
Claude (Anthropic) assisted with the HTML, CSS and JavaScript for the web map.