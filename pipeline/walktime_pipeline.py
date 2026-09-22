"""
Walktime pipeline for the Maynooth walking accessibility map.

For every H3 hex (centroid) and each of the 5 services it finds:
  - the walking time to the nearest service (by walking time, not straight line)
  - which service that is (name and id)
  - the actual walking route (LineString) so the web map can animate it

Needs a local OSRM server built with the foot profile (see README steps),
running on http://127.0.0.1:5000  (change with the OSRM_URL environment variable).

Inputs (same folder by default):
  Hex_Average.geojson                 hex grid (old times are used only for comparison)
  fooddrinks / fitness / supplies / pharmacy / healthcare .geojson   point files with id + name
  (Only the hex SHAPES in Hex_Average.geojson are used; its old times are ignored unless COMPARE_OLD = True)

Outputs (./output):
  hexes_walktime.geojson   hexes with times, nearest names/ids, average, snap distance
  routes.geojson           one route line per hex per service (500 lines)
  comparison_old_vs_new.csv  (only if COMPARE_OLD = True)
"""
import csv
import json
import os
import statistics
from pathlib import Path

import requests
from shapely.geometry import shape

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------
OSRM = os.environ.get("OSRM_URL", "http://127.0.0.1:5000")
IN_DIR = Path(os.environ.get("IN_DIR", "."))
OUT_DIR = Path(os.environ.get("OUT_DIR", "output"))
HEX_FILE = IN_DIR / "Hex_Average.geojson"

# (label used in field names, point file, old per-service walktime file)
SERVICES = [
    ("Food&Drinks", "fooddrinks.geojson", "fooddrinks_walktime.geojson"),
    ("Fitness", "fitness.geojson", "Fitness_walktime.geojson"),
    ("Supplies", "supplies.geojson", "supplies_walktime.geojson"),
    ("Pharmacy", "pharmacy.geojson", "pharmacy_walktime.geojson"),
    ("GP", "healthcare.geojson", "healthcare_walktime.geojson"),
]

# Set True only if you want a comparison against old times stored in Hex_Average.geojson
# (and old *_walktime.geojson files). Default: ignore old data, use only the fresh OSRM results.
COMPARE_OLD = False

H3_RESOLUTION = 9          # your hexes were checked to be exactly H3 res 9
MAX_TABLE = 100            # OSRM default: max coordinates per /table request
ORIGIN_BATCH = 25          # hexes per /table request (batch + destinations must stay <= MAX_TABLE)
SNAP_WARN_M = 150          # flag hexes whose centroid snaps further than this to the network

session = requests.Session()


# ----------------------------------------------------------------------------
# OSRM helpers
# ----------------------------------------------------------------------------
def get(url):
    r = session.get(url, timeout=120)
    return r.json()


def snap(lon, lat):
    """Snap a coordinate to the walking network. Returns (lon, lat, distance_m) or None."""
    d = get(f"{OSRM}/nearest/v1/foot/{lon:.6f},{lat:.6f}?number=1")
    if d.get("code") != "Ok":
        return None
    w = d["waypoints"][0]
    return w["location"][0], w["location"][1], w["distance"]


def table(origins, dests):
    """Durations in seconds, one row per origin, one column per destination (None = unreachable)."""
    if len(dests) >= MAX_TABLE:
        raise RuntimeError("Too many destinations for one /table request; raise --max-table-size or batch them.")
    batch = max(1, min(ORIGIN_BATCH, MAX_TABLE - len(dests)))
    rows = []
    for i in range(0, len(origins), batch):
        chunk = origins[i:i + batch]
        coords = ";".join(f"{x:.6f},{y:.6f}" for x, y in chunk + dests)
        src = ";".join(str(k) for k in range(len(chunk)))
        dst = ";".join(str(k) for k in range(len(chunk), len(chunk) + len(dests)))
        d = get(f"{OSRM}/table/v1/foot/{coords}?sources={src}&destinations={dst}&annotations=duration")
        if d.get("code") != "Ok":
            raise RuntimeError(f"/table failed: {d}")
        rows.extend(d["durations"])
    return rows


def route(o, d):
    """Walking route between two snapped points. Returns (geometry, duration_s, distance_m) or None."""
    url = (f"{OSRM}/route/v1/foot/{o[0]:.6f},{o[1]:.6f};{d[0]:.6f},{d[1]:.6f}"
           f"?overview=full&geometries=geojson&steps=false")
    r = get(url)
    if r.get("code") != "Ok":
        return None
    rt = r["routes"][0]
    return rt["geometry"], rt["duration"], rt["distance"]


# ----------------------------------------------------------------------------
# Data helpers
# ----------------------------------------------------------------------------
def hex_id(lon, lat, i):
    """H3 index for a hex centroid; falls back to a running number if h3 is not installed."""
    try:
        import h3
        if hasattr(h3, "latlng_to_cell"):      # h3 v4
            return h3.latlng_to_cell(lat, lon, H3_RESOLUTION)
        return h3.geo_to_h3(lat, lon, H3_RESOLUTION)   # h3 v3
    except ImportError:
        return f"hex_{i:03d}"


def load_points(fn):
    feats = json.load(open(IN_DIR / fn, encoding="utf-8"))["features"]
    pts = []
    for f in feats:
        lon, lat = f["geometry"]["coordinates"][:2]
        pts.append({"id": str(f["properties"]["id"]), "name": f["properties"]["name"], "lon": lon, "lat": lat})
    return pts


def load_old_nearest(fn):
    p = IN_DIR / fn
    if not p.exists():
        return None
    out = []
    for f in json.load(open(p, encoding="utf-8"))["features"]:
        props = f["properties"]
        out.append(next((v for k, v in props.items() if k != "Walk Time"), None))
    return out


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def write_comparison(hexes, ids, result):
    """Optional: compare new results with the old values kept in Hex_Average.geojson."""
    with open(OUT_DIR / "comparison_old_vs_new.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["hex_id", "service", "old_min", "new_min", "diff_min", "old_was_30_cap",
                    "old_nearest", "new_nearest", "nearest_changed"])
        print("\n===== OLD vs NEW =====")
        for label, pfile, oldfile in SERVICES:
            old_near = load_old_nearest(oldfile)
            diffs, changed, cap_fixed, cap_total = [], 0, 0, 0
            for i, f in enumerate(hexes):
                e = result[i].get(label)
                old = f["properties"].get(f"{label} WalkTime")
                new = e["time"] if e else None
                on = old_near[i] if old_near else None
                nn = e["dest"]["name"] if e else None
                was_cap = old is not None and abs(old - 30.0) < 1e-6
                if old is not None and new is not None and not was_cap:
                    diffs.append(new - old)
                if was_cap:
                    cap_total += 1
                    if new is not None and new > 30.0 + 1e-6:
                        cap_fixed += 1
                ch = bool(on and nn and on != nn)
                changed += ch
                w.writerow([ids[i], label,
                            None if old is None else round(old, 2),
                            None if new is None else round(new, 2),
                            None if (old is None or new is None) else round(new - old, 2),
                            was_cap, on, nn, ch])
            md = statistics.mean(abs(d) for d in diffs) if diffs else float("nan")
            print(f"{label:12s} mean |diff| (uncapped) {md:4.2f} min | nearest changed: {changed:3d} | "
                  f"old 30-min caps now above 30: {cap_fixed}/{cap_total}")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    OUT_DIR.mkdir(exist_ok=True)

    try:
        get(f"{OSRM}/nearest/v1/foot/-6.59,53.38")
    except requests.exceptions.ConnectionError:
        raise SystemExit(f"Cannot reach OSRM at {OSRM}. Is the Docker server window still open?")

    hexes = json.load(open(HEX_FILE, encoding="utf-8"))["features"]
    n = len(hexes)
    print(f"{n} hexes loaded")

    # 1) Hex origins: centroid, H3 id, snap to network
    cents = [shape(f["geometry"]).centroid for f in hexes]
    ids = [hex_id(c.x, c.y, i) for i, c in enumerate(cents)]
    snaps = [snap(c.x, c.y) for c in cents]
    unsnapped = [i for i, s in enumerate(snaps) if s is None]
    if unsnapped:
        print(f"WARNING: {len(unsnapped)} hexes could not be snapped and will have no times: {unsnapped}")
    ok = [i for i, s in enumerate(snaps) if s]
    origins = [(snaps[i][0], snaps[i][1]) for i in ok]
    far = [ids[i] for i in ok if snaps[i][2] > SNAP_WARN_M]
    print(f"Hex snap distance: max {max(snaps[i][2] for i in ok):.0f} m, "
          f"{len(far)} hexes over {SNAP_WARN_M} m")

    result = {i: {} for i in range(n)}     # hex index -> label -> dict
    route_features = []
    csv_rows = []

    # 2) Each service
    for label, pfile, oldfile in SERVICES:
        pts = load_points(pfile)
        for p in pts:
            p["snap"] = snap(p["lon"], p["lat"])
        valid = [p for p in pts if p["snap"]]
        if len(valid) < len(pts):
            print(f"WARNING {label}: {len(pts) - len(valid)} points could not be snapped and were skipped")
        dests = [(p["snap"][0], p["snap"][1]) for p in valid]
        print(f"{label}: {len(valid)} destinations, running /table ...")

        rows = table(origins, dests)
        max_route_gap = 0.0
        for r_i, row in enumerate(rows):
            h = ok[r_i]
            best = None
            for j, v in enumerate(row):
                if v is not None and (best is None or v < row[best]):
                    best = j
            if best is None:
                continue
            dest = valid[best]
            rt = route(origins[r_i], dests[best])
            entry = {"time": row[best] / 60.0, "dest": dest}
            if rt:
                geom, dur, dist = rt
                max_route_gap = max(max_route_gap, abs(dur - row[best]))
                route_features.append({
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {
                        "hex_id": ids[h], "service": label,
                        "dest_id": dest["id"], "dest_name": dest["name"],
                        "walk_min": round(dur / 60.0, 2), "distance_m": round(dist),
                    },
                })
            result[h][label] = entry
        print(f"   route vs table duration, largest gap: {max_route_gap:.1f} s")

    # 3) Build hex output + comparison
    labels = [s[0] for s in SERVICES]
    out_features = []
    for i, f in enumerate(hexes):
        old_props = f["properties"]
        props = {"hex_id": ids[i]}
        times = []
        for label in labels:
            e = result[i].get(label)
            props[f"{label} WalkTime"] = round(e["time"], 2) if e else None
            props[f"{label} Nearest"] = e["dest"]["name"] if e else None
            props[f"{label} NearestID"] = e["dest"]["id"] if e else None
            if e:
                times.append(e["time"])
        props["Average WalkTime"] = round(sum(times) / len(times), 2) if len(times) == len(labels) else None
        props["Snap distance m"] = round(snaps[i][2]) if snaps[i] else None
        out_features.append({"type": "Feature", "geometry": f["geometry"], "properties": props})

    write_json(OUT_DIR / "hexes_walktime.geojson", {"type": "FeatureCollection", "features": out_features})
    write_json(OUT_DIR / "routes.geojson", {"type": "FeatureCollection", "features": route_features})

    print("\n===== SUMMARY =====")
    for label, pfile, oldfile in SERVICES:
        times = [result[i][label]["time"] for i in range(n) if label in result[i]]
        missing = n - len(times)
        print(f"{label:12s} median {statistics.median(times):5.1f} min | max {max(times):5.1f} | "
              f"over 30 min: {sum(t > 30 for t in times):2d} | over 15 min: {sum(t > 15 for t in times):3d} | "
              f"hexes without a route: {missing}")

    if COMPARE_OLD:
        write_comparison(hexes, ids, result)

    print(f"\nWrote {len(out_features)} hexes and {len(route_features)} routes to {OUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
