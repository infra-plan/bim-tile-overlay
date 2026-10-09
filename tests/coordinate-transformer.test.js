import { describe, it, expect } from 'vitest';
import { CoordinateTransformer } from '../src/coordinate-transformer.js';

// EPSG:3765 proj4 definition (Croatia HTRS96/TM)
const CRS_3765 = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// A simplified config mimicking what Autodesk Viewer would provide.
// refPointTransform: identity rotation (cosTheta=1, sinTheta=0) with a translation.
// This makes the math predictable for testing.
function createTestConfig(options = {}) {
    const cosTheta = options.cosTheta ?? 1;
    const sinTheta = options.sinTheta ?? 0;
    const translationX = options.translationX ?? 0;
    const translationY = options.translationY ?? 0;

    // Column-major 4x3 matrix: indices [0]=cos, [1]=sin, [9]=tX, [10]=tY
    const refPointTransform = new Array(12).fill(0);
    refPointTransform[0] = cosTheta;
    refPointTransform[1] = sinTheta;
    refPointTransform[4] = -sinTheta;
    refPointTransform[5] = cosTheta;
    refPointTransform[9] = translationX;
    refPointTransform[10] = translationY;

    return {
        crs: CRS_3765,
        refPointTransform,
        globalOffset: options.globalOffset ?? { x: 0, y: 0, z: 0 },
        modelBBox: options.modelBBox ?? {
            min: { x: -100, y: -100, z: -10 },
            max: { x: 100, y: 100, z: 50 },
        },
    };
}

describe('CoordinateTransformer', () => {
    describe('round-trip accuracy', () => {
        it('lonLatToViewer → viewerToLonLat returns original coordinates', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
            });
            const t = new CoordinateTransformer(config);

            // Zagreb approximate coordinates
            const originalLon = 15.9819;
            const originalLat = 45.8150;

            const viewer = t.lonLatToViewer(originalLon, originalLat);
            const roundTrip = t.viewerToLonLat(viewer.x, viewer.y);

            // Should match to ~6 decimal places (~0.1 meter accuracy)
            expect(roundTrip.lon).toBeCloseTo(originalLon, 5);
            expect(roundTrip.lat).toBeCloseTo(originalLat, 5);
        });

        it('viewerToLonLat → lonLatToViewer returns original coordinates', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
            });
            const t = new CoordinateTransformer(config);

            const viewerX = 50;
            const viewerY = -30;

            const lonLat = t.viewerToLonLat(viewerX, viewerY);
            const roundTrip = t.lonLatToViewer(lonLat.lon, lonLat.lat);

            expect(roundTrip.x).toBeCloseTo(viewerX, 3);
            expect(roundTrip.y).toBeCloseTo(viewerY, 3);
        });

        it('round-trip with rotation (non-zero sinTheta)', () => {
            const angle = Math.PI / 6; // 30 degrees
            const config = createTestConfig({
                cosTheta: Math.cos(angle),
                sinTheta: Math.sin(angle),
                translationX: 1640000,
                translationY: 5070000,
            });
            const t = new CoordinateTransformer(config);

            const originalLon = 15.9819;
            const originalLat = 45.8150;

            const viewer = t.lonLatToViewer(originalLon, originalLat);
            const roundTrip = t.viewerToLonLat(viewer.x, viewer.y);

            expect(roundTrip.lon).toBeCloseTo(originalLon, 5);
            expect(roundTrip.lat).toBeCloseTo(originalLat, 5);
        });

        it('round-trip with globalOffset', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
                globalOffset: { x: 500, y: -300, z: 10 },
            });
            const t = new CoordinateTransformer(config);

            const originalLon = 16.0;
            const originalLat = 45.85;

            const viewer = t.lonLatToViewer(originalLon, originalLat);
            const roundTrip = t.viewerToLonLat(viewer.x, viewer.y);

            expect(roundTrip.lon).toBeCloseTo(originalLon, 5);
            expect(roundTrip.lat).toBeCloseTo(originalLat, 5);
        });
    });

    describe('lonLatToViewer', () => {
        it('returns z coordinate adjusted for feet and globalOffset', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
                globalOffset: { x: 0, y: 0, z: 100 },
            });
            const t = new CoordinateTransformer(config);

            const result = t.lonLatToViewer(16.0, 45.8, 10); // 10 meters elevation
            // 10 meters * 3.28084 ft/m - 100 offset = ~32.8 - 100 = ~-67.2
            expect(result.z).toBeCloseTo(10 * 3.28084 - 100, 2);
        });

        it('defaults z to 0 when not provided', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
                globalOffset: { x: 0, y: 0, z: 0 },
            });
            const t = new CoordinateTransformer(config);

            const result = t.lonLatToViewer(16.0, 45.8);
            expect(result.z).toBeCloseTo(0, 2);
        });
    });

    describe('getModelBoundsLL84', () => {
        it('returns geographic bounds of the model bounding box', () => {
            // Translation values are in feet (CRS meters * 3.28084)
            // Zagreb: ~500000m easting, ~5075000m northing in EPSG:3765
            const config = createTestConfig({
                translationX: 500000 * 3.28084,
                translationY: 5075000 * 3.28084,
                modelBBox: {
                    min: { x: -50, y: -50, z: 0 },
                    max: { x: 50, y: 50, z: 30 },
                },
            });
            const t = new CoordinateTransformer(config);

            const bounds = t.getModelBoundsLL84();

            expect(bounds.west).toBeLessThan(bounds.east);
            expect(bounds.south).toBeLessThan(bounds.north);
            // Should be reasonable coordinates in Croatia region
            expect(bounds.west).toBeGreaterThan(10);
            expect(bounds.east).toBeLessThan(25);
            expect(bounds.south).toBeGreaterThan(40);
            expect(bounds.north).toBeLessThan(50);
        });

        it('bounds.west/south corresponds to min corner and east/north to max', () => {
            const config = createTestConfig({
                translationX: 1640000,
                translationY: 5070000,
                modelBBox: {
                    min: { x: 0, y: 0, z: 0 },
                    max: { x: 100, y: 100, z: 10 },
                },
            });
            const t = new CoordinateTransformer(config);

            const bounds = t.getModelBoundsLL84();

            // min viewer coords should map to smaller lon/lat
            const minLL = t.viewerToLonLat(0, 0);
            const maxLL = t.viewerToLonLat(100, 100);

            expect(bounds.west).toBeCloseTo(Math.min(minLL.lon, maxLL.lon), 5);
            expect(bounds.east).toBeCloseTo(Math.max(minLL.lon, maxLL.lon), 5);
        });

        it('covers all four corners of a rotated model', () => {
            // 45° rotation: the min and max corners share the same longitude,
            // so bounds derived from only those two would have zero width.
            const config = createTestConfig({
                cosTheta: Math.SQRT1_2,
                sinTheta: Math.SQRT1_2,
                translationX: 500000 * 3.28084,
                translationY: 5070000 * 3.28084,
                modelBBox: {
                    min: { x: 0, y: 0, z: 0 },
                    max: { x: 1000, y: 1000, z: 10 },
                },
            });
            const t = new CoordinateTransformer(config);

            const bounds = t.getModelBoundsLL84();

            for (const [x, y] of [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]) {
                const ll = t.viewerToLonLat(x, y);
                expect(ll.lon).toBeGreaterThanOrEqual(bounds.west - 1e-9);
                expect(ll.lon).toBeLessThanOrEqual(bounds.east + 1e-9);
                expect(ll.lat).toBeGreaterThanOrEqual(bounds.south - 1e-9);
                expect(ll.lat).toBeLessThanOrEqual(bounds.north + 1e-9);
            }
            expect(bounds.east - bounds.west).toBeGreaterThan(0.001);
        });
    });

    describe('multiple instances', () => {
        it('a second transformer with a different CRS does not affect the first', () => {
            const a = new CoordinateTransformer(createTestConfig());
            const before = a.lonLatToViewer(16.0, 45.8);

            new CoordinateTransformer({
                ...createTestConfig(),
                crs: '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs',
            });
            const after = a.lonLatToViewer(16.0, 45.8);

            expect(after.x).toBeCloseTo(before.x, 6);
            expect(after.y).toBeCloseTo(before.y, 6);
        });
    });

    describe('fromAPSViewer', () => {
        it('extracts config from a mock viewer object', () => {
            const mockViewer = {
                model: {
                    getData: () => ({
                        metadata: {
                            'custom values': {
                                refPointTransform: new Array(12).fill(0),
                            },
                        },
                        globalOffset: { x: 10, y: 20, z: 5 },
                    }),
                    getBoundingBox: () => ({
                        min: { x: -50, y: -50, z: 0 },
                        max: { x: 50, y: 50, z: 30 },
                    }),
                },
            };

            const t = CoordinateTransformer.fromAPSViewer(mockViewer, CRS_3765);
            expect(t).toBeInstanceOf(CoordinateTransformer);
            expect(t.globalOffset).toEqual({ x: 10, y: 20, z: 5 });
        });
    });
});
