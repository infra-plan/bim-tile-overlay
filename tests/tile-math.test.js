import { describe, it, expect } from 'vitest';
import { lonLatToTile, tileToLonLat } from '../src/tile-math.js';

describe('lonLatToTile', () => {
    it('converts (0, 0) at zoom 0 to tile (0, 0)', () => {
        const tile = lonLatToTile(0, 0, 0);
        expect(tile.x).toBe(0);
        expect(tile.y).toBe(0);
    });

    it('converts (0, 0) at zoom 1 to tile (1, 1)', () => {
        // At zoom 1, the world is 2x2 tiles. (0,0) is center → tile (1,1)
        const tile = lonLatToTile(0, 0, 1);
        expect(tile.x).toBe(1);
        expect(tile.y).toBe(1);
    });

    it('converts known London coordinates at zoom 10', () => {
        // London: lon=-0.1276, lat=51.5074
        // At zoom 10, expected tile ~(511, 340)
        const tile = lonLatToTile(-0.1276, 51.5074, 10);
        expect(tile.x).toBe(511);
        expect(tile.y).toBe(340);
    });

    it('converts known Zagreb coordinates at zoom 15', () => {
        // Zagreb: lon=15.9819, lat=45.8150
        const tile = lonLatToTile(15.9819, 45.8150, 15);
        // At zoom 15, Zagreb should be around tile (17853, 11554)
        expect(tile.x).toBeGreaterThan(17000);
        expect(tile.x).toBeLessThan(18000);
        expect(tile.y).toBeGreaterThan(11000);
        expect(tile.y).toBeLessThan(12000);
    });

    it('handles negative longitude (western hemisphere)', () => {
        // New York: lon=-74.006, lat=40.7128
        const tile = lonLatToTile(-74.006, 40.7128, 10);
        expect(tile.x).toBeGreaterThan(0);
        expect(tile.y).toBeGreaterThan(0);
    });

    it('handles extreme latitude (near poles)', () => {
        // Near north pole: lat=85
        const tile = lonLatToTile(0, 85, 5);
        expect(tile.y).toBe(0); // Top row at high latitude
    });
});

describe('tileToLonLat', () => {
    it('converts tile (0, 0) at zoom 0 to (-180, ~85.05)', () => {
        const ll = tileToLonLat(0, 0, 0);
        expect(ll.lon).toBeCloseTo(-180, 1);
        expect(ll.lat).toBeCloseTo(85.0511, 1); // Web Mercator max latitude
    });

    it('converts tile (0, 0) at zoom 1 to (-180, ~85.05)', () => {
        const ll = tileToLonLat(0, 0, 1);
        expect(ll.lon).toBeCloseTo(-180, 1);
        expect(ll.lat).toBeCloseTo(85.0511, 1);
    });

    it('converts tile (1, 1) at zoom 1 to (0, 0)', () => {
        const ll = tileToLonLat(1, 1, 1);
        expect(ll.lon).toBeCloseTo(0, 1);
        expect(ll.lat).toBeCloseTo(0, 1);
    });

    it('returns NW corner of the tile', () => {
        // The NW corner of tile (1,1) at zoom 1 should be (0, 0)
        // The NW corner of tile (2,2) at zoom 2 should also be (0, 0)
        const ll = tileToLonLat(2, 2, 2);
        expect(ll.lon).toBeCloseTo(0, 1);
        expect(ll.lat).toBeCloseTo(0, 1);
    });
});

describe('round-trip consistency', () => {
    it('lonLatToTile → tileToLonLat returns a point within the original tile', () => {
        const zoom = 15;
        const lon = 15.9819; // Zagreb
        const lat = 45.8150;

        const tile = lonLatToTile(lon, lat, zoom);
        const nw = tileToLonLat(tile.x, tile.y, zoom);
        const se = tileToLonLat(tile.x + 1, tile.y + 1, zoom);

        // Original point should be within the tile's geographic bounds
        expect(lon).toBeGreaterThanOrEqual(nw.lon);
        expect(lon).toBeLessThan(se.lon);
        expect(lat).toBeLessThanOrEqual(nw.lat); // NW has higher lat
        expect(lat).toBeGreaterThan(se.lat);     // SE has lower lat
    });

    it('round-trip works for multiple zoom levels', () => {
        const testPoints = [
            { lon: -74.006, lat: 40.7128 },  // New York
            { lon: 139.6917, lat: 35.6895 }, // Tokyo
            { lon: 15.9819, lat: 45.8150 },  // Zagreb
        ];

        for (const { lon, lat } of testPoints) {
            for (const zoom of [5, 10, 15, 18]) {
                const tile = lonLatToTile(lon, lat, zoom);
                const nw = tileToLonLat(tile.x, tile.y, zoom);
                const se = tileToLonLat(tile.x + 1, tile.y + 1, zoom);

                expect(lon).toBeGreaterThanOrEqual(nw.lon);
                expect(lon).toBeLessThan(se.lon);
                expect(lat).toBeLessThanOrEqual(nw.lat);
                expect(lat).toBeGreaterThan(se.lat);
            }
        }
    });
});
