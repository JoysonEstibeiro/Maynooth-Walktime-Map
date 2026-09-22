// ============================================================================
// Maynooth Walktime Map
// Data: data/hexes_walktime.geojson (100 H3 hexes), data/routes.geojson (500 walking routes),
//       one point file per service, MU_Campus_Centroid.geojson
// ============================================================================

// ---------- Config ----------
const HOME_CENTER = [53.38026, -6.58133];
const HOME_ZOOM = 14;
const DEFAULT_OPACITY = 0.70;
const BAR_MAX = 40;            // minutes shown on the sidebar bars
const SNAP_NOTE_M = 150;       // show a note when a hex centre is further than this from a path

// One shared colour scale for the map, the sidebar bars and the legend
const CLASS_BREAKS = [5, 10, 15, 20, 25, 30];
const CLASS_COLORS = ['#166fc9', '#5aa9d6', '#d1e5f0', '#f7f7f7', '#fddbc7', '#e67e54', '#cf152b']; // ['#4575b4', '#91bfdb', '#e0f3f8', '#ffffbf', '#fee090', '#fc8d59', '#d73027'];
const CLASS_LABELS = ['0 to 5', '5 to 10', '10 to 15', '15 to 20', '20 to 25', '25 to 30', 'Over 30'];

// label = prefix of the field names in hexes_walktime.geojson and the "service" value in routes.geojson
const SERVICES = [
    { key: 'fooddrinks', label: 'Food&Drinks', name: 'Food & Drinks', icon: 'fa-solid fa-utensils', color: '#d95f02', file: 'fooddrinks.geojson' },
    { key: 'fitness', label: 'Fitness', name: 'Fitness', icon: 'fa-solid fa-dumbbell', color: '#7570b3', file: 'fitness.geojson' },
    { key: 'supplies', label: 'Supplies', name: 'Supplies', icon: 'fa-solid fa-cart-shopping', color: '#1b9e77', file: 'supplies.geojson' },
    { key: 'pharmacy', label: 'Pharmacy', name: 'Pharmacy', icon: 'fa-solid fa-notes-medical', color: '#e7298a', file: 'pharmacy.geojson' },
    { key: 'gp', label: 'GP', name: 'Healthcare', icon: 'fa-solid fa-house-chimney-medical', color: '#0b3d91', file: 'healthcare.geojson' }
];
const SERVICE_BY_KEY = Object.fromEntries(SERVICES.map(s => [s.key, s]));

// ---------- State ----------
const state = {
    service: 'average',     // 'average' or a service key
    selectedId: null,       // hex_id of the selected hex
    opacity: DEFAULT_OPACITY
};
let animToken = 0;          // bumping this stops any running route animation

// ---------- Helpers ----------
function colorFor(v) {
    if (v === null || v === undefined) return '#cccccc';
    for (let i = 0; i < CLASS_BREAKS.length; i++) {
        if (v <= CLASS_BREAKS[i]) return CLASS_COLORS[i];
    }
    return CLASS_COLORS[CLASS_COLORS.length - 1];
}

function timeField(key) {
    return key === 'average' ? 'Average WalkTime' : SERVICE_BY_KEY[key].label + ' WalkTime';
}

function fmt(v) {
    return (v === null || v === undefined) ? 'n/a' : v.toFixed(1) + ' min';
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------- Map + basemaps ----------
const map = L.map('map', { zoomSnap: 0.25 }).setView(HOME_CENTER, HOME_ZOOM);

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
});

const carto = L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_3si1_1_fd2ab73421ca39e1bb2f17fd', {
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
	subdomains: 'abcd',
	maxZoom: 19,
	apikey: 'cb1_3si1_1_fd2ab73421ca39e1bb2f17fd'
}).addTo(map);

const CartoDB_Positron = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_3si1_1_fd2ab73421ca39e1bb2f17fd', {
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
	subdomains: 'abcd',
	maxZoom: 19,
	apikey: 'cb1_3si1_1_fd2ab73421ca39e1bb2f17fd'
});

// ---------- Stadia overlays: roads/lines and labels (sit above the basemap, below the hexes) ----------
const STADIA_ATTR = '&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a> ' +
    '&copy; <a href="https://www.stamen.com/" target="_blank">Stamen Design</a> ' +
    '&copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const stadiaLines = L.tileLayer('https://tiles.stadiamaps.com/tiles/stamen_terrain_lines/{z}/{x}/{y}{r}.{ext}', {
    minZoom: 0, maxZoom: 19, attribution: STADIA_ATTR, ext: 'png'
}).addTo(map);

const stadiaLabels = L.tileLayer('https://tiles.stadiamaps.com/tiles/stamen_toner_labels/{z}/{x}/{y}{r}.{ext}', {
    minZoom: 0, maxZoom: 19, attribution: STADIA_ATTR, ext: 'png'
});

// Layers filled in once data has loaded
let hexLayer = null;
const hexLayers = {};       // hex_id -> Leaflet layer
const hexProps = {};        // hex_id -> properties
const routeIndex = new Map();   // "hex_id|Label" -> route feature
const routeGroup = L.layerGroup().addTo(map);
const pointsRoot = L.layerGroup().addTo(map);        // toggled from the layer control
const servicePointLayers = {};                       // key -> L.geoJSON
let homeBounds = null;

// ---------- Home button ----------
const HomeButton = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
        const el = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-home');
        el.title = 'Reset view';
        el.innerHTML = '<i class="fa-solid fa-house"></i>';
        L.DomEvent.disableClickPropagation(el);
        el.onclick = function () {
            clearSelection();
            map.fitBounds(homeBounds || L.latLngBounds([HOME_CENTER, HOME_CENTER]).pad(0.5));
        };
        return el;
    }
});
map.addControl(new HomeButton());

// ---------- Hex styling ----------
function styleHex(feature) {
    const p = feature.properties;
    const selected = p.hex_id === state.selectedId;
    return {
        color: selected ? '#000000' : '#333333',
        weight: selected ? 3 : 0.5,
        opacity: selected ? 1 : 0.6,
        fillColor: colorFor(p[timeField(state.service)]),
        fillOpacity: state.opacity
    };
}

function tooltipText(feature) {
    const p = feature.properties;
    const title = state.service === 'average' ? 'Average' : SERVICE_BY_KEY[state.service].name;
    return `${title}: ${fmt(p[timeField(state.service)])}`;
}

// ---------- Selection ----------
function selectHex(id) {
    state.selectedId = id;
    hexLayer.setStyle(styleHex);
    if (hexLayers[id]) hexLayers[id].bringToFront();
    updateSidebar(hexProps[id]);
    drawRoutes();
}

function clearSelection() {
    state.selectedId = null;
    animToken++;
    routeGroup.clearLayers();
    if (hexLayer) hexLayer.setStyle(styleHex);
    document.getElementById('hint').hidden = false;
    document.getElementById('hex-details').hidden = true;
}

// ---------- Sidebar ----------
function buildSidebarRows() {
    const wrap = document.getElementById('service-rows');
    wrap.innerHTML = '';
    SERVICES.forEach(s => {
        const row = document.createElement('div');
        row.className = 'svc-row';
        row.dataset.key = s.key;
        row.style.borderLeftColor = s.color;
        row.title = 'Show the route to the nearest ' + s.name.toLowerCase();
        row.innerHTML = `
            <div class="svc-head">
                <span class="svc-name"><i class="${s.icon}"></i> ${s.name}</span>
                <span class="svc-time"></span>
            </div>
            <div class="svc-nearest"></div>
            <div class="bar-outline">
                <div class="bar-fill"></div>
                <div class="bar-marker" style="left:${(10 / BAR_MAX) * 100}%"></div>
                <div class="bar-marker" style="left:${(20 / BAR_MAX) * 100}%"></div>
                <div class="bar-marker" style="left:${(30 / BAR_MAX) * 100}%"></div>
            </div>`;
        row.addEventListener('click', () => {
            document.getElementById('service-select').value = s.key;
            setService(s.key);
        });
        wrap.appendChild(row);
    });
}

function updateSidebar(p) {
    document.getElementById('hint').hidden = true;
    document.getElementById('hex-details').hidden = false;

    const avg = p['Average WalkTime'];
    document.getElementById('avg-row').innerHTML =
        `<span class="chip" style="background:${colorFor(avg)}"></span> Average walk time: <strong>${fmt(avg)}</strong>`;

    document.querySelectorAll('#service-rows .svc-row').forEach(row => {
        const s = SERVICE_BY_KEY[row.dataset.key];
        const t = p[s.label + ' WalkTime'];
        row.querySelector('.svc-time').textContent = fmt(t);
        row.querySelector('.svc-nearest').textContent = 'Nearest: ' + (p[s.label + ' Nearest'] || 'n/a');
        const fill = row.querySelector('.bar-fill');
        fill.style.width = (t === null || t === undefined ? 0 : Math.min(t / BAR_MAX, 1) * 100) + '%';
        fill.style.backgroundColor = colorFor(t);
    });
    markActiveRow();

    const note = document.getElementById('snap-note');
    const snap = p['Snap distance m'];
    if (snap !== null && snap !== undefined && snap > SNAP_NOTE_M) {
        note.hidden = false;
        note.textContent = `Note: the centre of this hex is ${snap} m from the nearest walkable path. ` +
            `The walk from the centre to that path is not included in these times.`;
    } else {
        note.hidden = true;
    }
}

function markActiveRow() {
    document.querySelectorAll('#service-rows .svc-row').forEach(row => {
        row.classList.toggle('active', row.dataset.key === state.service);
    });
}

// ---------- Service dropdown + opacity ----------
function buildServiceSelect() {
    const sel = document.getElementById('service-select');
    sel.innerHTML = '<option value="average">All services (average)</option>' +
        SERVICES.map(s => `<option value="${s.key}">${s.name}</option>`).join('');
    sel.value = state.service;
    sel.addEventListener('change', () => setService(sel.value));
}

function setService(key) {
    state.service = key;
    if (hexLayer) {
        hexLayer.setStyle(styleHex);
        hexLayer.eachLayer(l => l.closeTooltip());   // avoid stale hover text
    }
    markActiveRow();
    syncServicePoints();
    drawRoutes();
}

document.getElementById('opacity-slider').addEventListener('input', function () {
    state.opacity = parseFloat(this.value);
    if (hexLayer) hexLayer.setStyle(styleHex);
});

// ---------- Service points (shown for the selected service, or all for the average) ----------
function syncServicePoints() {
    SERVICES.forEach(s => {
        const layer = servicePointLayers[s.key];
        if (!layer) return;
        const show = state.service === 'average' || state.service === s.key;
        if (show) pointsRoot.addLayer(layer); else pointsRoot.removeLayer(layer);
    });
}

function loadServicePoints() {
    return Promise.all(SERVICES.map(s =>
        fetch('data/' + s.file).then(r => r.json()).then(data => {
            servicePointLayers[s.key] = L.geoJSON(data, {
                pointToLayer: (feature, latlng) => L.marker(latlng, {
                    icon: L.divIcon({
                        html: `<i class="${s.icon} icon-box"></i>`,
                        className: 'fa-icon-marker',
                        iconSize: [22, 22],
                        iconAnchor: [11, 11]
                    })
                }),
                onEachFeature: (feature, layer) => {
                    const name = feature.properties.name || feature.properties.Name;
                    if (name) layer.bindTooltip(name);
                }
            });
        })
    ));
}

// ---------- Route animation ----------
function drawRoutes() {
    animToken++;
    routeGroup.clearLayers();
    if (!state.selectedId) return;

    const keys = state.service === 'average' ? SERVICES.map(s => s.key) : [state.service];
    const items = [];
    keys.forEach(k => {
        const s = SERVICE_BY_KEY[k];
        const feature = routeIndex.get(state.selectedId + '|' + s.label);
        if (feature) items.push({ feature, color: s.color, single: keys.length === 1 });
    });
    if (!items.length) return;

    // Move the map only if the routes are out of view, or so small on screen that the animation gets lost
    const bounds = L.latLngBounds([]);
    items.forEach(it => it.feature.geometry.coordinates.forEach(c => bounds.extend([c[1], c[0]])));
    const size = map.getSize();
    const sw = map.latLngToContainerPoint(bounds.getSouthWest());
    const ne = map.latLngToContainerPoint(bounds.getNorthEast());
    const tooSmall = Math.abs(ne.x - sw.x) < size.x * 0.3 && Math.abs(sw.y - ne.y) < size.y * 0.3;
    if (!map.getBounds().pad(-0.08).contains(bounds) || tooSmall) {
        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 17 });
    }

    runAnimation(items);
}

function runAnimation(items) {
    const token = ++animToken;
    const runs = items.map(makeRun).filter(Boolean);
    const start = performance.now();

    function frame(now) {
        if (token !== animToken) return;      // a newer selection replaced this one
        let allDone = true;
        runs.forEach(r => { if (!r.step(now - start)) allDone = false; });
        if (!allDone) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

function makeRun(item) {
    const coords = item.feature.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    if (coords.length < 2) return null;

    // cumulative distance along the route, so the line grows at an even pace
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + coords[i - 1].distanceTo(coords[i]));
    const total = cum[cum.length - 1] || 1;
    const duration = Math.min(4000, Math.max(1400, 900 + item.feature.properties.distance_m * 1.1));

    const lineOpts = { lineCap: 'round', lineJoin: 'round', interactive: false };
    const casing = L.polyline([coords[0]], Object.assign({ color: '#ffffff', weight: 8, opacity: 0.9 }, lineOpts)).addTo(routeGroup);
    const line = L.polyline([coords[0]], Object.assign({ color: item.color, weight: 4.5, opacity: 1 }, lineOpts)).addTo(routeGroup);
    L.circleMarker(coords[0], { radius: 5, color: '#111111', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(routeGroup);
    const head = L.circleMarker(coords[0], { radius: 6, color: '#ffffff', weight: 2, fillColor: item.color, fillOpacity: 1, interactive: false }).addTo(routeGroup);

    let idx = 0;
    let finished = false;

    return {
        step: function (elapsed) {
            if (finished) return true;
            const t = Math.min(1, elapsed / duration);
            const target = easeInOutCubic(t) * total;
            while (idx < cum.length - 2 && cum[idx + 1] < target) idx++;
            const segLen = (cum[idx + 1] - cum[idx]) || 1;
            const f = Math.min(1, Math.max(0, (target - cum[idx]) / segLen));
            const a = coords[idx], b = coords[idx + 1];
            const p = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);
            const pts = coords.slice(0, idx + 1);
            pts.push(p);
            casing.setLatLngs(pts);
            line.setLatLngs(pts);
            head.setLatLng(p);
            if (t >= 1) {
                finished = true;
                routeGroup.removeLayer(head);
                addDestination(item, coords[coords.length - 1]);
            }
            return finished;
        }
    };
}

function addDestination(item, latlng) {
    const p = item.feature.properties;
    const marker = L.marker(latlng, {
        icon: L.divIcon({
            className: 'dest-wrap',
            html: `<div class="dest-pulse" style="--c:${item.color}"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9]
        }),
        keyboard: false,
        zIndexOffset: 1000
    }).addTo(routeGroup);
    marker.bindTooltip(`${p.dest_name}: ${p.walk_min.toFixed(1)} min, ${Math.round(p.distance_m)} m`, {
        permanent: item.single,
        direction: 'top',
        offset: [0, -8],
        className: 'dest-label'
    });
}

// ---------- Legend ----------
function addLegend() {
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
        const div = L.DomUtil.create('div', 'legend');
        const classes = CLASS_COLORS.map((c, i) =>
            `<div><span style="background:${c}"></span> ${CLASS_LABELS[i]}</div>`).join('');
        const services = SERVICES.map(s =>
            `<div><i class="${s.icon} icon-box"></i> ${s.name} <span class="route-swatch" style="background:${s.color}" title="route colour"></span></div>`).join('');
        div.innerHTML = `
            <h3>Legend</h3>
            <div class="legend-container">
                <div class="legend-column"><h4>Walk time (min)</h4><div class="legend-colors">${classes}</div></div>
                <div class="legend-column legend-services"><h4>Services and route colour</h4>
                    ${services}
                    <div><i class="fa-solid fa-building-columns icon-box"></i> Maynooth University</div>
                </div>
            </div>`;
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    legend.addTo(map);
}

// ---------- Init ----------
function showLoadError(err) {
    console.error(err);
    const el = document.getElementById('load-error');
    el.hidden = false;
    el.innerHTML = 'The map data could not be loaded. If you opened index.html straight from a folder, ' +
        'start a small local server instead (for example <code>python -m http.server</code> in this folder) ' +
        'and open <code>http://localhost:8000</code>.';
}

buildServiceSelect();
buildSidebarRows();
addLegend();

Promise.all([
    fetch('data/hexes_walktime.geojson').then(r => r.json()),
    fetch('data/routes.geojson').then(r => r.json()),
    fetch('data/MU_Campus_Centroid.geojson').then(r => r.json()),
    loadServicePoints()
]).then(([hexData, routeData, uniData]) => {
    routeData.features.forEach(f => {
        routeIndex.set(f.properties.hex_id + '|' + f.properties.service, f);
    });

    hexLayer = L.geoJSON(hexData, {
        style: styleHex,
        onEachFeature: (feature, layer) => {
            const id = feature.properties.hex_id;
            hexLayers[id] = layer;
            hexProps[id] = feature.properties;
            layer.on('click', () => selectHex(id));
            layer.bindTooltip(() => tooltipText(feature), { sticky: true });
        }
    }).addTo(map);

    homeBounds = hexLayer.getBounds();
    map.fitBounds(homeBounds);

    // University marker
    const uniLayer = L.geoJSON(uniData, {
        pointToLayer: (f, latlng) => L.marker(latlng, {
            icon: L.divIcon({
                html: '<i class="fa-solid fa-building-columns icon-box"></i>',
                className: 'fa-icon-marker',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            })
        }),
        onEachFeature: (f, layer) => layer.bindTooltip(f.properties.name || 'Maynooth University')
    }).addTo(map);

    syncServicePoints();

    L.control.layers(
        { 'OpenStreetMap': osm, 'Light (Carto)': carto, 'Positron (Carto)': CartoDB_Positron },
        { 'Roads and lines (Stadia Terrain)': stadiaLines, 'Service points': pointsRoot, 'Maynooth University': uniLayer },
        { collapsed: true }
    ).addTo(map);
}).catch(showLoadError);
