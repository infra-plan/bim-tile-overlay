import { tileToLonLat } from './tile-math.js';

const TILE_SIZE = 256;
const DEFAULT_MAX_TILES = 500;

/**
 * Key identifying a tile, e.g. '15/17762/11603'.
 *
 * @param {{ z: number, x: number, y: number }} tile
 * @returns {string}
 */
export function tileKey({ z, x, y }) {
    return `${z}/${x}/${y}`;
}

/**
 * Choose which tiles to show for a camera, with detail depending on distance:
 * ground close to the camera gets high-zoom tiles, distant ground gets coarser
 * ones. Starting from the whole world, a tile is split into its four children
 * while it would appear larger than 256 px on screen (at its closest visible
 * point), until `zoomRange[1]` is reached.
 *
 * Only tiles that are both inside `maxBounds` and visible in the camera's view
 * are returned. The returned tiles never overlap.
 *
 * @param {{ position: {x:number,y:number,z:number}, target: {x:number,y:number,z:number}, up?: {x:number,y:number,z:number}, fov?: number, aspect?: number }} camera
 *   Camera state in viewer coordinates. `up` is the camera's screen-up direction;
 *   if omitted, world up (0, 0, 1) is used (north-up when looking straight down).
 * @param {{ lonLatToViewer: (lon:number, lat:number) => {x:number,y:number} }} transformer
 * @param {Object} options
 * @param {[number, number]} options.zoomRange - Min and max zoom levels
 * @param {{ west: number, south: number, east: number, north: number }} options.maxBounds
 * @param {number} options.groundZ - Z elevation of the ground plane in viewer coordinates
 * @param {number} [options.viewportHeight=1000] - Viewer height in pixels
 * @param {number} [options.detailScale=1] - Higher values give finer tiles (2 splits
 *   tiles until they appear at most 128 px on screen)
 * @param {number} [options.maxTiles=500] - Upper limit on the number of tiles. When
 *   reached, the tiles furthest from the camera are left coarser.
 * @returns {{ z: number, x: number, y: number }[]}
 */
export function selectTiles(camera, transformer, options) {
    const [minZoom, maxZoom] = options.zoomRange;
    const { maxBounds, groundZ } = options;
    const viewportHeight = options.viewportHeight || 1000;
    const detailScale = options.detailScale || 1;
    const maxTiles = options.maxTiles || DEFAULT_MAX_TILES;
    const maxScreenSize = TILE_SIZE / detailScale;

    const view = buildView(camera, viewportHeight);
    const measure = (tile) => tileScreenSize(tile, view, transformer, maxBounds, groundZ);

    // Below minZoom, split every visible tile
    let level = [{ z: 0, x: 0, y: 0 }];
    for (let z = 0; z < minZoom; z++) {
        level = level.filter((tile) => measure(tile) !== null).flatMap(children);
    }

    // From minZoom on, keep splitting the tile that appears largest on screen.
    // If maxTiles is reached, the tiles left unsplit are the ones closest to
    // the target size, so detail goes to the ground nearest the camera first.
    const result = [];
    const toSplit = createMaxHeap();
    const consider = (tile) => {
        const screenSize = measure(tile);
        if (screenSize === null) return 0; // Not visible or outside maxBounds
        if (tile.z < maxZoom && screenSize > maxScreenSize) toSplit.push(tile, screenSize);
        else result.push(tile);
        return 1;
    };

    let count = 0;
    for (const tile of level) count += consider(tile);
    // Splitting replaces one tile with up to four
    while (toSplit.size() && count + 3 <= maxTiles) {
        const tile = toSplit.pop();
        count--;
        for (const child of children(tile)) count += consider(child);
    }
    while (toSplit.size()) result.push(toSplit.pop());

    return result;
}

/**
 * Decide which tiles to display, given the wanted tiles and which tiles have
 * their image available. Wanted tiles that are still loading are covered by
 * what is already on screen, so the view doesn't flicker:
 * - currently displayed descendants are kept (e.g. after zooming out), and
 * - the nearest available ancestor is shown underneath (e.g. after zooming in).
 *
 * Tiles in `displayed` count as available.
 *
 * @param {{ z: number, x: number, y: number }[]} wanted - Tiles from selectTiles()
 * @param {(tile: { z: number, x: number, y: number }) => boolean} isReady
 *   Whether a tile's image is loaded
 * @param {Set<string>} displayed - Keys of the tiles currently displayed
 * @returns {{ z: number, x: number, y: number }[]} Tiles to display
 */
export function resolveDisplayTiles(wanted, isReady, displayed) {
    const available = (tile) => displayed.has(tileKey(tile)) || isReady(tile);

    // Displayed tiles indexed by each of their ancestors
    const displayedByAncestor = new Map();
    for (const key of displayed) {
        const tile = parseTileKey(key);
        for (let a = parent(tile); a; a = parent(a)) {
            const aKey = tileKey(a);
            if (!displayedByAncestor.has(aKey)) displayedByAncestor.set(aKey, []);
            displayedByAncestor.get(aKey).push(tile);
        }
    }

    const shown = new Map();
    for (const tile of wanted) {
        const key = tileKey(tile);
        if (available(tile)) {
            shown.set(key, tile);
            continue;
        }
        for (const d of displayedByAncestor.get(key) || []) {
            shown.set(tileKey(d), d);
        }
        for (let a = parent(tile); a; a = parent(a)) {
            if (available(a)) {
                shown.set(tileKey(a), a);
                break;
            }
        }
    }
    return [...shown.values()];
}

// ── Helpers ──────────────────────────────────────────────────────

function parseTileKey(key) {
    const [z, x, y] = key.split('/').map(Number);
    return { z, x, y };
}

function parent({ z, x, y }) {
    if (z === 0) return null;
    return { z: z - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) };
}

function children({ z, x, y }) {
    const cz = z + 1;
    return [
        { z: cz, x: 2 * x, y: 2 * y },
        { z: cz, x: 2 * x + 1, y: 2 * y },
        { z: cz, x: 2 * x, y: 2 * y + 1 },
        { z: cz, x: 2 * x + 1, y: 2 * y + 1 },
    ];
}

/** Binary max-heap of tiles by priority. */
function createMaxHeap() {
    const items = [];
    const swap = (i, j) => ([items[i], items[j]] = [items[j], items[i]]);
    return {
        size: () => items.length,
        push(tile, priority) {
            items.push({ tile, priority });
            let i = items.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (items[p].priority >= items[i].priority) break;
                swap(i, p);
                i = p;
            }
        },
        pop() {
            const top = items[0];
            const last = items.pop();
            if (items.length) {
                items[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < items.length && items[l].priority > items[m].priority) m = l;
                    if (r < items.length && items[r].priority > items[m].priority) m = r;
                    if (m === i) break;
                    swap(i, m);
                    i = m;
                }
            }
            return top.tile;
        },
    };
}

/**
 * Camera position, the four side planes of its view pyramid (inward normals)
 * and the scale from angular size to screen pixels.
 */
function buildView(camera, viewportHeight) {
    const pos = camera.position;
    const f = normalize(sub(camera.target, pos));

    // right = forward x up; if forward is parallel to up (looking straight
    // down with world up), fall back to north (0, 1, 0) as up.
    let r = cross(f, camera.up || { x: 0, y: 0, z: 1 });
    if (length(r) < 1e-9) r = cross(f, { x: 0, y: 1, z: 0 });
    r = normalize(r);
    const u = cross(r, f);

    const th = Math.tan(((camera.fov || 45) * Math.PI) / 360);
    const tw = th * (camera.aspect || 1);

    const plane = (a, b) => {
        const n = cross(a, b);
        return dot(n, f) < 0 ? scale(n, -1) : n;
    };
    const planes = [
        plane(u, add(f, scale(r, -tw))), // left
        plane(u, add(f, scale(r, tw))), // right
        plane(r, add(f, scale(u, -th))), // bottom
        plane(r, add(f, scale(u, th))), // top
    ];

    return { pos, planes, projScale: viewportHeight / (2 * th) };
}

/**
 * How large a tile appears on screen, in pixels, at its closest visible point.
 * Returns null when no part of the tile inside maxBounds is visible.
 */
function tileScreenSize(tile, view, transformer, maxBounds, groundZ) {
    const nw = tileToLonLat(tile.x, tile.y, tile.z);
    const se = tileToLonLat(tile.x + 1, tile.y + 1, tile.z);

    // Only the part inside maxBounds matters. Clipping first also keeps
    // coordinates local, so the CRS projection stays accurate for huge tiles.
    const west = Math.max(nw.lon, maxBounds.west);
    const east = Math.min(se.lon, maxBounds.east);
    const south = Math.max(se.lat, maxBounds.south);
    const north = Math.min(nw.lat, maxBounds.north);
    if (west >= east || south >= north) return null;

    const toViewer = (lon, lat) => {
        const p = transformer.lonLatToViewer(lon, lat);
        return { x: p.x, y: p.y, z: groundZ };
    };
    const quad = [
        toViewer(west, north),
        toViewer(east, north),
        toViewer(east, south),
        toViewer(west, south),
    ];

    // Visible part of the tile
    let polygon = quad;
    for (const n of view.planes) {
        polygon = clipPolygon(polygon, n, view.pos);
        if (polygon.length === 0) return null;
    }

    // Full tile width, scaled from the clipped part's width
    const clippedWidth = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const tileWidth = clippedWidth * ((se.lon - nw.lon) / (east - west));

    const horizontal = distanceToPolygon2D(view.pos, polygon);
    const vertical = view.pos.z - groundZ;
    const distance = Math.max(Math.hypot(horizontal, vertical), 1e-6);

    return (tileWidth / distance) * view.projScale;
}

/** Keep the part of a convex polygon on the inner side of a plane through `origin`. */
function clipPolygon(points, normal, origin) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const da = dot(normal, sub(a, origin));
        const db = dot(normal, sub(b, origin));
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) {
            const t = da / (da - db);
            out.push(add(a, scale(sub(b, a), t)));
        }
    }
    return out;
}

/** Horizontal distance from a point to a convex polygon (0 if inside). */
function distanceToPolygon2D(p, polygon) {
    let inside = true;
    let sign = 0;
    let min = Infinity;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if (c !== 0) {
            if (sign === 0) sign = Math.sign(c);
            else if (Math.sign(c) !== sign) inside = false;
        }
        min = Math.min(min, distanceToSegment2D(p, a, b));
    }
    return inside ? 0 : min;
}

function distanceToSegment2D(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function length(a) {
    return Math.hypot(a.x, a.y, a.z);
}
function normalize(a) {
    return scale(a, 1 / (length(a) || 1));
}
