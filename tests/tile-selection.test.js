import { describe, it, expect } from 'vitest';
import { selectTiles, resolveDisplayTiles, tileKey } from '../src/tile-selection.js';
import { tileToLonLat } from '../src/tile-math.js';

// Linear transformer around Zagreb, viewer units in feet (like Revit models).
// Good enough locally, and keeps the tests independent of proj4.
const FT = 0.3048;
const LON0 = 16.0;
const LAT0 = 45.8;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const M_PER_DEG_LAT = 110574;
const transformer = {
    lonLatToViewer: (lon, lat) => ({
        x: ((lon - LON0) * M_PER_DEG_LON) / FT,
        y: ((lat - LAT0) * M_PER_DEG_LAT) / FT,
        z: 0,
    }),
    viewerToLonLat: (x, y) => ({
        lon: LON0 + (x * FT) / M_PER_DEG_LON,
        lat: LAT0 + (y * FT) / M_PER_DEG_LAT,
    }),
};

// Square box of the given half-size in meters, centered on the origin
function boxAround(halfSizeM) {
    return {
        west: LON0 - halfSizeM / M_PER_DEG_LON,
        east: LON0 + halfSizeM / M_PER_DEG_LON,
        south: LAT0 - halfSizeM / M_PER_DEG_LAT,
        north: LAT0 + halfSizeM / M_PER_DEG_LAT,
    };
}

// Camera at the origin, `heightM` above the ground, facing north and
// pitched `pitchDeg` below the horizon (90 = straight down).
function cameraAt(heightM, pitchDeg) {
    const h = heightM / FT;
    const p = (pitchDeg * Math.PI) / 180;
    return {
        position: { x: 0, y: 0, z: h },
        target: { x: 0, y: Math.cos(p) * 100, z: h - Math.sin(p) * 100 },
        up: { x: 0, y: Math.sin(p), z: Math.cos(p) },
        fov: 45,
        aspect: 16 / 9,
    };
}

const baseOptions = {
    zoomRange: [10, 21],
    maxBounds: boxAround(5000),
    groundZ: 0,
    viewportHeight: 1000,
};

function tileBounds({ z, x, y }) {
    const nw = tileToLonLat(x, y, z);
    const se = tileToLonLat(x + 1, y + 1, z);
    return { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };
}

// Tiles containing a geographic point (half-open, so shared edges count once)
function tilesContaining(tiles, lon, lat) {
    return tiles.filter((t) => {
        const b = tileBounds(t);
        return lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
    });
}

function tileAhead(tiles, distanceM) {
    const ll = transformer.viewerToLonLat(0, distanceM / FT);
    const found = tilesContaining(tiles, ll.lon, ll.lat);
    expect(found).toHaveLength(1);
    return found[0];
}

// Ground points seen through a grid of screen positions, inside maxBounds
function visibleGroundPoints(camera, maxBounds, groundZ = 0) {
    const f = sub(camera.target, camera.position);
    normalize(f);
    const r = cross(f, camera.up);
    normalize(r);
    const u = cross(r, f);
    const th = Math.tan((camera.fov * Math.PI) / 360);
    const tw = th * camera.aspect;
    const points = [];
    for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
            const sx = (i / 10) * 2 - 1;
            const sy = (j / 10) * 2 - 1;
            const d = {
                x: f.x + sx * tw * r.x + sy * th * u.x,
                y: f.y + sx * tw * r.y + sy * th * u.y,
                z: f.z + sx * tw * r.z + sy * th * u.z,
            };
            if (d.z >= 0) continue;
            const t = (groundZ - camera.position.z) / d.z;
            const ll = transformer.viewerToLonLat(
                camera.position.x + t * d.x,
                camera.position.y + t * d.y
            );
            if (
                ll.lon > maxBounds.west && ll.lon < maxBounds.east &&
                ll.lat > maxBounds.south && ll.lat < maxBounds.north
            ) {
                points.push(ll);
            }
        }
    }
    return points;
}

function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(v) {
    const l = Math.hypot(v.x, v.y, v.z);
    v.x /= l;
    v.y /= l;
    v.z /= l;
}

describe('selectTiles', () => {
    it('gives the ground near a low camera full detail when looking at the horizon', () => {
        // 2 m above the ground, looking 5° below the horizon. The old
        // footprint-width approach picked zoom 15 (3.3 m/px) here.
        const tiles = selectTiles(cameraAt(2, 5), transformer, baseOptions);

        expect(tileAhead(tiles, 5).z).toBe(21);
    });

    it('uses coarser tiles further from the camera', () => {
        const tiles = selectTiles(cameraAt(2, 5), transformer, baseOptions);

        const near = tileAhead(tiles, 5);
        const far = tileAhead(tiles, 1000);
        expect(far.z).toBeLessThanOrEqual(near.z - 3);
    });

    it('uses coarser tiles under a higher camera', () => {
        const options = { ...baseOptions, zoomRange: [10, 24] };
        const low = selectTiles(cameraAt(20, 90), transformer, options);
        const high = selectTiles(cameraAt(200, 90), transformer, options);

        expect(tileAhead(high, 0).z).toBeLessThan(tileAhead(low, 0).z);
    });

    it('covers every visible ground point with exactly one tile', () => {
        for (const [heightM, pitch] of [[2, 5], [20, 30], [200, 90], [50, 60]]) {
            const camera = cameraAt(heightM, pitch);
            const tiles = selectTiles(camera, transformer, baseOptions);
            const points = visibleGroundPoints(camera, baseOptions.maxBounds);

            expect(points.length).toBeGreaterThan(0);
            for (const p of points) {
                expect(tilesContaining(tiles, p.lon, p.lat)).toHaveLength(1);
            }
        }
    });

    it('stays within zoomRange and maxBounds', () => {
        const maxBounds = boxAround(300);
        const tiles = selectTiles(cameraAt(2, 5), transformer, {
            ...baseOptions,
            maxBounds,
            zoomRange: [14, 19],
        });

        expect(tiles.length).toBeGreaterThan(0);
        for (const t of tiles) {
            expect(t.z).toBeGreaterThanOrEqual(14);
            expect(t.z).toBeLessThanOrEqual(19);
            const b = tileBounds(t);
            expect(b.east).toBeGreaterThan(maxBounds.west);
            expect(b.west).toBeLessThan(maxBounds.east);
            expect(b.north).toBeGreaterThan(maxBounds.south);
            expect(b.south).toBeLessThan(maxBounds.north);
        }
    });

    it('skips tiles behind the camera', () => {
        const tiles = selectTiles(cameraAt(2, 5), transformer, baseOptions);

        for (const t of tiles) {
            expect(tileBounds(t).north).toBeGreaterThan(LAT0);
        }
    });

    it('returns no tiles when the camera looks away from the ground', () => {
        const camera = {
            position: { x: 0, y: 0, z: 10 },
            target: { x: 0, y: 10, z: 100 },
            fov: 45,
            aspect: 1,
        };

        expect(selectTiles(camera, transformer, baseOptions)).toEqual([]);
    });

    it('limits the number of tiles to maxTiles, still covering the view', () => {
        const camera = cameraAt(2, 5);
        const tiles = selectTiles(camera, transformer, { ...baseOptions, maxTiles: 20 });

        expect(tiles.length).toBeLessThanOrEqual(20);
        for (const p of visibleGroundPoints(camera, baseOptions.maxBounds)) {
            expect(tilesContaining(tiles, p.lon, p.lat)).toHaveLength(1);
        }
    });

    it('spends a limited tile budget on the ground nearest the camera first', () => {
        const tiles = selectTiles(cameraAt(2, 5), transformer, { ...baseOptions, maxTiles: 60 });

        expect(tileAhead(tiles, 5).z).toBe(21);
    });

    it('uses finer tiles with a higher detailScale', () => {
        const options = { ...baseOptions, zoomRange: [10, 24] };
        const normal = selectTiles(cameraAt(200, 90), transformer, options);
        const sharper = selectTiles(cameraAt(200, 90), transformer, {
            ...options,
            detailScale: 2,
        });

        expect(tileAhead(sharper, 0).z).toBeGreaterThan(tileAhead(normal, 0).z);
    });

    it('handles a camera looking straight down without an up vector', () => {
        const camera = { ...cameraAt(200, 90), up: undefined };
        const tiles = selectTiles(camera, transformer, baseOptions);

        expect(tiles.length).toBeGreaterThan(1);
        expect(tileAhead(tiles, 0)).toBeDefined();
    });
});

describe('resolveDisplayTiles', () => {
    const t = (z, x, y) => ({ z, x, y });
    const keys = (tiles) => tiles.map(tileKey).sort();
    const readySet = (...tiles) => {
        const set = new Set(tiles.map(tileKey));
        return (tile) => set.has(tileKey(tile));
    };

    it('shows wanted tiles that are ready', () => {
        const wanted = [t(5, 10, 10), t(5, 11, 10)];
        const shown = resolveDisplayTiles(wanted, readySet(...wanted), new Set());

        expect(keys(shown)).toEqual(keys(wanted));
    });

    it('shows the nearest ready ancestor while a wanted tile loads', () => {
        // 5/10/10 → parent 4/5/5 (not ready) → grandparent 3/2/2 (ready)
        const shown = resolveDisplayTiles([t(5, 10, 10)], readySet(t(3, 2, 2)), new Set());

        expect(keys(shown)).toEqual(['3/2/2']);
    });

    it('treats currently displayed tiles as ready fallbacks', () => {
        const shown = resolveDisplayTiles([t(5, 10, 10)], readySet(), new Set(['4/5/5']));

        expect(keys(shown)).toEqual(['4/5/5']);
    });

    it('keeps displayed descendants while a wanted tile loads', () => {
        // Zooming out: the children stay until the parent arrives
        const displayed = new Set(['5/10/10', '5/11/10', '6/22/22']);
        const shown = resolveDisplayTiles([t(4, 5, 5)], readySet(), displayed);

        expect(keys(shown)).toEqual(['5/10/10', '5/11/10', '6/22/22']);
    });

    it('drops descendants and ancestors once the wanted tile is ready', () => {
        const displayed = new Set(['3/2/2', '5/10/10']);
        const shown = resolveDisplayTiles([t(4, 5, 5)], readySet(t(4, 5, 5)), displayed);

        expect(keys(shown)).toEqual(['4/5/5']);
    });

    it('shows a shared ancestor once', () => {
        const wanted = [t(5, 10, 10), t(5, 11, 10), t(5, 10, 11)];
        const shown = resolveDisplayTiles(wanted, readySet(t(4, 5, 5)), new Set());

        expect(keys(shown)).toEqual(['4/5/5']);
    });

    it('drops displayed tiles unrelated to the wanted ones', () => {
        const shown = resolveDisplayTiles(
            [t(5, 10, 10)],
            readySet(t(5, 10, 10)),
            new Set(['5/20/20'])
        );

        expect(keys(shown)).toEqual(['5/10/10']);
    });

    it('shows nothing for a loading tile without a fallback', () => {
        expect(resolveDisplayTiles([t(5, 10, 10)], readySet(), new Set())).toEqual([]);
    });
});
