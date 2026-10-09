import { describe, it, expect } from 'vitest';
import { getViewportBounds } from '../src/viewport.js';

// Simple mock transformer: identity mapping (viewer coords = lon/lat directly)
// This makes it easy to verify the frustum math without CRS complexity
const identityTransformer = {
    viewerToLonLat(x, y) {
        return { lon: x, lat: y };
    },
};

const defaultOptions = {
    zoomRange: [10, 18],
    maxBounds: { west: -180, south: -85, east: 180, north: 85 },
    groundZ: 0,
};

describe('getViewportBounds', () => {
    it('returns bounds when camera looks at ground at an angle', () => {
        const camera = {
            // Camera above (10,20) looking slightly forward (not perfectly down)
            position: { x: 10, y: 20, z: 100 },
            target: { x: 10, y: 25, z: 0 },
            fov: 45,
            aspect: 1,
        };

        const result = getViewportBounds(camera, identityTransformer, defaultOptions);

        // Bounds should encompass the area around (10, 20-25)
        expect(result.bounds.west).toBeLessThan(10);
        expect(result.bounds.east).toBeGreaterThan(10);
        expect(result.bounds.south).toBeLessThan(25);
        expect(result.bounds.north).toBeGreaterThan(20);
    });

    it('clamps zoom to zoomRange min', () => {
        const camera = {
            // Very high up → wide view → low zoom
            position: { x: 0, y: 0, z: 100000 },
            target: { x: 0, y: 100, z: 0 },
            fov: 90,
            aspect: 1,
        };

        const result = getViewportBounds(camera, identityTransformer, {
            ...defaultOptions,
            zoomRange: [12, 18],
        });

        expect(result.zoom).toBe(12);
    });

    it('clamps zoom to zoomRange max', () => {
        const camera = {
            // Very close to ground, looking steeply down → tiny visible area → high zoom
            position: { x: 0, y: -0.1, z: 1 },
            target: { x: 0, y: 0, z: 0 },
            fov: 10, // Narrow FOV to ensure tiny footprint
            aspect: 1,
        };

        const result = getViewportBounds(camera, identityTransformer, {
            ...defaultOptions,
            zoomRange: [10, 15],
        });

        expect(result.zoom).toBe(15);
    });

    it('clips bounds to maxBounds', () => {
        const camera = {
            position: { x: 0, y: 0, z: 1000 },
            target: { x: 0, y: 100, z: 0 },
            fov: 90,
            aspect: 2,
        };

        const tightBounds = { west: -5, south: -5, east: 5, north: 5 };
        const result = getViewportBounds(camera, identityTransformer, {
            ...defaultOptions,
            maxBounds: tightBounds,
        });

        expect(result.bounds.west).toBeGreaterThanOrEqual(-5);
        expect(result.bounds.east).toBeLessThanOrEqual(5);
        expect(result.bounds.south).toBeGreaterThanOrEqual(-5);
        expect(result.bounds.north).toBeLessThanOrEqual(5);
    });

    it('returns maxBounds and min zoom when camera faces away from ground', () => {
        const camera = {
            // Camera looking upward — no rays hit the ground
            position: { x: 0, y: 0, z: 10 },
            target: { x: 0, y: 0, z: 100 },
            fov: 45,
            aspect: 1,
        };

        const result = getViewportBounds(camera, identityTransformer, defaultOptions);

        expect(result.bounds).toEqual(defaultOptions.maxBounds);
        expect(result.zoom).toBe(defaultOptions.zoomRange[0]);
    });

    it('respects custom zoomScaleFactor', () => {
        const camera = {
            position: { x: 0, y: 0, z: 100 },
            target: { x: 0, y: 50, z: 0 },
            fov: 45,
            aspect: 1,
        };

        const resultDefault = getViewportBounds(camera, identityTransformer, defaultOptions);
        const resultHigher = getViewportBounds(camera, identityTransformer, {
            ...defaultOptions,
            zoomScaleFactor: 24, // Double the default
        });

        // Higher scale factor → higher zoom level (or equal due to clamping)
        expect(resultHigher.zoom).toBeGreaterThanOrEqual(resultDefault.zoom);
    });

    it('wider aspect ratio produces wider bounds', () => {
        const baseCamera = {
            position: { x: 0, y: 0, z: 50 },
            target: { x: 0, y: 30, z: 0 },
            fov: 45,
        };

        const narrow = getViewportBounds(
            { ...baseCamera, aspect: 1 },
            identityTransformer,
            defaultOptions
        );
        const wide = getViewportBounds(
            { ...baseCamera, aspect: 2 },
            identityTransformer,
            defaultOptions
        );

        const narrowSpan = narrow.bounds.east - narrow.bounds.west;
        const wideSpan = wide.bounds.east - wide.bounds.west;

        expect(wideSpan).toBeGreaterThan(narrowSpan);
    });

    it('uses default fov of 45 when not provided', () => {
        const camera = {
            position: { x: 0, y: 0, z: 50 },
            target: { x: 0, y: 30, z: 0 },
            aspect: 1,
        };

        const result = getViewportBounds(camera, identityTransformer, defaultOptions);

        // Should not throw and should produce valid bounds
        expect(result.bounds.west).toBeLessThan(result.bounds.east);
        expect(result.bounds.south).toBeLessThan(result.bounds.north);
    });

    describe('camera looking straight down', () => {
        // Large maxBounds so clipping doesn't hide the footprint size
        const wideOptions = {
            ...defaultOptions,
            maxBounds: { west: -1e4, south: -1e4, east: 1e4, north: 1e4 },
        };
        // At z=1000 with fov 45: half-height = 1000 * tan(22.5°) ≈ 414.2
        const halfH = 1000 * Math.tan(Math.PI / 8);

        it('returns the full footprint (north-up when no up vector is given)', () => {
            const camera = {
                position: { x: 0, y: 0, z: 1000 },
                target: { x: 0, y: 0, z: 0 },
                fov: 45,
                aspect: 1.5,
            };

            const result = getViewportBounds(camera, identityTransformer, wideOptions);

            expect(result.bounds.west).toBeCloseTo(-halfH * 1.5, 3);
            expect(result.bounds.east).toBeCloseTo(halfH * 1.5, 3);
            expect(result.bounds.south).toBeCloseTo(-halfH, 3);
            expect(result.bounds.north).toBeCloseTo(halfH, 3);
        });

        it('uses camera.up to orient the footprint', () => {
            const camera = {
                position: { x: 0, y: 0, z: 1000 },
                target: { x: 0, y: 0, z: 0 },
                up: { x: 1, y: 0, z: 0 }, // screen top points east
                fov: 45,
                aspect: 1.5,
            };

            const result = getViewportBounds(camera, identityTransformer, wideOptions);

            // Screen width now runs north-south
            expect(result.bounds.west).toBeCloseTo(-halfH, 3);
            expect(result.bounds.east).toBeCloseTo(halfH, 3);
            expect(result.bounds.south).toBeCloseTo(-halfH * 1.5, 3);
            expect(result.bounds.north).toBeCloseTo(halfH * 1.5, 3);
        });
    });
});
