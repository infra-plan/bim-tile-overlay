import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock THREE.js globals before importing TileOverlay
const mockDispose = vi.fn();
const mockSet = vi.fn();

globalThis.THREE = {
    PlaneGeometry: function PlaneGeometry() { this.dispose = mockDispose; },
    MeshBasicMaterial: function MeshBasicMaterial(opts) {
        this.dispose = mockDispose;
        this.map = null;
        this.needsUpdate = false;
        this.side = opts?.side;
        this.transparent = opts?.transparent;
    },
    Mesh: function Mesh(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = { set: mockSet };
        this.rotation = { z: 0 };
    },
    Texture: function Texture(image) {
        this.image = image;
        this.needsUpdate = false;
        this.minFilter = null;
        this.dispose = mockDispose;
    },
    LinearFilter: 1006,
    DoubleSide: 2,
};

globalThis.Autodesk = {
    Viewing: {
        CAMERA_CHANGE_EVENT: 'cameraChanged',
    },
};

// Mock document.createElement for canvas. Each call returns a fresh canvas
// (sharing one 2D context) so tests can check which canvases are freed.
const mockCtx = { drawImage: vi.fn() };
const createdCanvases = [];
vi.stubGlobal('document', {
    createElement: vi.fn(() => {
        const canvas = { width: 0, height: 0, getContext: () => mockCtx };
        createdCanvases.push(canvas);
        return canvas;
    }),
});

// Mock Image. URLs in failingUrls trigger onerror instead of onload.
// While imageLoading.hold is true, loads stay pending until releaseHeldImages().
const failingUrls = new Set();
const requestedUrls = [];
const heldImages = [];
const imageLoading = { hold: false };
class MockImage {
    constructor() {
        this.crossOrigin = '';
        this.src = '';
        this.onload = null;
        this.onerror = null;
    }
    set src(url) {
        this._src = url;
        if (!url) return;
        requestedUrls.push(url);
        if (imageLoading.hold) {
            heldImages.push(this);
            return;
        }
        // Simulate async load — trigger onload in next microtask
        this._settle();
    }
    _settle() {
        const url = this._src;
        Promise.resolve().then(() => {
            if (this._src !== url) return; // load was aborted
            if (failingUrls.has(url)) this.onerror?.();
            else this.onload?.();
        });
    }
    get src() {
        return this._src;
    }
}
vi.stubGlobal('Image', MockImage);

function releaseHeldImages() {
    imageLoading.hold = false;
    for (const img of heldImages.splice(0)) img._settle();
}

// Let all pending microtask chains (image loads, awaits) run to completion
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const { TileOverlay } = await import('../src/tile-overlay.js');

// ── Test helpers ──────────────────────────────────────────────

function createMockViewer() {
    const listeners = {};
    const camera = {
        position: { x: 0, y: 0, z: 100 },
        fov: 45,
        aspect: 1.5,
    };
    const target = { x: 0, y: 0, z: 0 };
    return {
        navigation: {
            getCamera: () => camera,
            getTarget: () => target,
        },
        overlays: {
            addScene: vi.fn(),
            addMesh: vi.fn(),
            removeMesh: vi.fn(),
        },
        impl: {
            invalidate: vi.fn(),
        },
        addEventListener: vi.fn((event, cb) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(cb);
        }),
        removeEventListener: vi.fn((event, cb) => {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter((l) => l !== cb);
            }
        }),
        _listeners: listeners,
        // Move the camera, keeping it looking straight down
        _moveCamera(x, y) {
            camera.position = { x, y, z: 100 };
            target.x = x;
            target.y = y;
        },
    };
}

function createMockTransformer() {
    return {
        modelBBox: {
            min: { x: -100, y: -100, z: -10 },
            max: { x: 100, y: 100, z: 50 },
        },
        viewerToLonLat: (x, y) => ({
            lon: 16.0 + x * 0.001,
            lat: 45.8 + y * 0.001,
        }),
        lonLatToViewer: (lon, lat) => ({
            x: (lon - 16.0) * 1000,
            y: (lat - 45.8) * 1000,
            z: 0,
        }),
    };
}

const defaultOptions = {
    urlTemplate: 'https://tile.example.com/{z}/{x}/{y}.png',
    zoomRange: [14, 19],
    maxBounds: { west: 15.9, south: 45.7, east: 16.1, north: 45.9 },
};

// ── Tests ──────────────────────────────────────────────────────

describe('TileOverlay', () => {
    let viewer;
    let transformer;

    beforeEach(() => {
        viewer = createMockViewer();
        transformer = createMockTransformer();
        vi.clearAllMocks();
        failingUrls.clear();
        requestedUrls.length = 0;
        createdCanvases.length = 0;
        heldImages.length = 0;
        imageLoading.hold = false;
    });

    describe('constructor', () => {
        it('stores options correctly', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._urlTemplate).toBe(defaultOptions.urlTemplate);
            expect(overlay._zoomRange).toEqual([14, 19]);
            expect(overlay._maxBounds).toEqual(defaultOptions.maxBounds);
        });

        it('uses default groundZ from modelBBox', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._groundZ).toBe(-15); // min.z (-10) - 5
        });

        it('accepts custom groundZ', () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                groundZ: -20,
            });
            expect(overlay._groundZ).toBe(-20);
        });

        it('uses default debounceMs of 150', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._debounceMs).toBe(150);
        });

        it('uses default progressInterval of 5', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._progressInterval).toBe(5);
        });

        it('stores onTileError callback', () => {
            const errorCb = vi.fn();
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                onTileError: errorCb,
            });
            expect(overlay._onTileError).toBe(errorCb);
        });

        it('warns that maxCacheSize is deprecated', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            new TileOverlay(viewer, transformer, { ...defaultOptions, maxCacheSize: 6 });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxCacheSize'));
            warn.mockRestore();
        });

        it('starts inactive', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._isActive).toBe(false);
            expect(overlay._plane).toBeNull();
        });
    });

    describe('enable', () => {
        it('creates plane and adds to viewer', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            expect(viewer.overlays.addScene).toHaveBeenCalledWith('bim-tile-overlay');
            expect(viewer.overlays.addMesh).toHaveBeenCalled();
            expect(overlay._isActive).toBe(true);
            expect(overlay._plane).not.toBeNull();
        });

        it('registers camera change listener', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            expect(viewer.addEventListener).toHaveBeenCalledWith(
                'cameraChanged',
                expect.any(Function)
            );
        });

        it('does nothing if already active', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const addSceneCalls = viewer.overlays.addScene.mock.calls.length;

            await overlay.enable();
            expect(viewer.overlays.addScene.mock.calls.length).toBe(addSceneCalls);
        });

        it('uses custom scene name', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                sceneName: 'my-custom-scene',
            });
            await overlay.enable();

            expect(viewer.overlays.addScene).toHaveBeenCalledWith('my-custom-scene');
        });
    });

    describe('disable', () => {
        it('removes plane from viewer and stops listening', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            overlay.disable();

            expect(overlay._isActive).toBe(false);
            expect(viewer.removeEventListener).toHaveBeenCalledWith(
                'cameraChanged',
                expect.any(Function)
            );
            expect(viewer.overlays.removeMesh).toHaveBeenCalled();
        });

        it('does nothing if already inactive', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            overlay.disable(); // Should not throw
            expect(viewer.removeEventListener).not.toHaveBeenCalled();
        });

        it('resets currentBoundsKey so re-enable triggers update', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            overlay._currentBoundsKey = 'some-key';

            overlay.disable();
            expect(overlay._currentBoundsKey).toBeNull();
        });
    });

    describe('destroy', () => {
        it('calls disable and disposes GPU resources', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            overlay.destroy();

            expect(overlay._isActive).toBe(false);
            expect(overlay._plane).toBeNull();
        });

        it('clears the cache', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            const clearSpy = vi.spyOn(overlay._cache, 'clear');
            overlay.destroy();
            expect(clearSpy).toHaveBeenCalled();
        });

        it('is safe to call multiple times', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            overlay.destroy();
            overlay.destroy(); // Should not throw
        });
    });

    describe('update', () => {
        it('resets boundsKey to force recalculation', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            overlay._currentBoundsKey = 'cached-key';

            await overlay.update();
            // After update, boundsKey should be set to the new calculated value
            expect(overlay._currentBoundsKey).not.toBe('cached-key');
        });
    });

    describe('camera change during an update', () => {
        it('re-runs the update for the latest camera once the current one finishes', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const fetchSpy = vi.spyOn(overlay, '_fetchAndStitchTiles');

            viewer._moveCamera(20, 20);
            const first = overlay._updateTiles(); // in flight
            viewer._moveCamera(40, 40);
            await overlay._updateTiles(); // camera moved while busy
            await first;

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            const [firstBounds] = fetchSpy.mock.calls[0];
            const [secondBounds] = fetchSpy.mock.calls[1];
            expect(secondBounds.west).toBeGreaterThan(firstBounds.west);
            expect(overlay._isUpdating).toBe(false);
        });

        it('does not re-run after being disabled', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const fetchSpy = vi.spyOn(overlay, '_fetchAndStitchTiles');

            viewer._moveCamera(20, 20);
            const first = overlay._updateTiles();
            viewer._moveCamera(40, 40);
            overlay._updateTiles();
            overlay.disable();
            await first;

            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('progressive rendering', () => {
        it('refreshes the texture after the last tile even when it fails', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                progressInterval: 2,
            });
            // Zoom 1 over the whole world: 2x2 tiles, loaded in order
            // (0,0), (0,1), (1,0), (1,1). Fail the last one.
            failingUrls.add('https://tile.example.com/1/1/1.png');
            overlay._onTileError = vi.fn();

            const events = [];
            mockCtx.drawImage.mockImplementation(() => events.push('draw'));
            const onProgress = vi.fn(() => events.push('progress'));

            await overlay._fetchAndStitchTiles(
                { west: -179, south: -80, east: 179, north: 80 },
                1,
                onProgress
            );

            expect(overlay._onTileError).toHaveBeenCalledTimes(1);
            expect(events.filter((e) => e === 'draw')).toHaveLength(3);
            expect(events.at(-1)).toBe('progress');
        });
    });

    describe('tile cache', () => {
        it('only fetches new tiles after a small pan', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const firstRequests = requestedUrls.splice(0);

            viewer._moveCamera(5, 0); // about half a tile east
            await overlay._updateTiles();
            const secondRequests = requestedUrls.splice(0);

            expect(firstRequests.length).toBeGreaterThan(0);
            expect(secondRequests.length).toBeGreaterThan(0);
            expect(secondRequests.length).toBeLessThan(firstRequests.length / 2);
            for (const url of secondRequests) {
                expect(firstRequests).not.toContain(url);
            }
        });

        it('fetches nothing when returning to a previous view', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            viewer._moveCamera(5, 0);
            await overlay._updateTiles();
            requestedUrls.length = 0;

            viewer._moveCamera(0, 0);
            await overlay._updateTiles();

            expect(requestedUrls).toHaveLength(0);
            expect(overlay._plane.material.map.image.width).toBeGreaterThan(0);
        });

        it('retries failed tiles on the next update', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                onTileError: vi.fn(),
            });
            failingUrls.add('https://tile.example.com/1/1/1.png');
            const bounds = { west: -179, south: -80, east: 179, north: 80 };

            await overlay._fetchAndStitchTiles(bounds, 1);
            requestedUrls.length = 0;
            await overlay._fetchAndStitchTiles(bounds, 1);

            expect(requestedUrls).toEqual(['https://tile.example.com/1/1/1.png']);
        });

        it('limits the number of cached tiles to maxCachedTiles', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                maxCachedTiles: 3,
            });

            await overlay._fetchAndStitchTiles({ west: -179, south: -80, east: 179, north: 80 }, 1);

            expect(overlay._cache.size()).toBe(3);
        });

        it('frees the previous stitched canvas when the view changes', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const firstCanvas = overlay._plane.material.map.image;

            viewer._moveCamera(20, 20);
            await overlay._updateTiles();

            expect(overlay._plane.material.map.image).not.toBe(firstCanvas);
            expect(firstCanvas.width).toBe(0);
            expect(firstCanvas.height).toBe(0);
        });
    });

    describe('pending tile loads', () => {
        it('are cancelled on disable', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const pending = heldImages.slice();
            expect(pending.length).toBeGreaterThan(0);

            overlay.disable();
            await enabling;

            for (const img of pending) {
                expect(img.src).toBe('');
            }
            expect(overlay._isUpdating).toBe(false);
        });

        it('a run cancelled by disable does not block a fresh run after re-enable', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const fetchSpy = vi.spyOn(overlay, '_fetchAndStitchTiles');

            overlay.disable();
            const reenabling = overlay.enable();
            releaseHeldImages();
            await enabling;
            await reenabling;
            await flush();

            // The cancelled run's partial canvas must not be left on screen:
            // a fresh run fetches the tiles again and draws a complete canvas.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(overlay._currentBoundsKey).not.toBeNull();
        });
    });

    describe('debounce', () => {
        it('delays execution', async () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            const debounced = overlay._debounce(fn, 100);

            debounced();
            expect(fn).not.toHaveBeenCalled();

            vi.advanceTimersByTime(100);
            expect(fn).toHaveBeenCalledTimes(1);
            vi.useRealTimers();
        });

        it('resets timer on subsequent calls', () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            const debounced = overlay._debounce(fn, 100);

            debounced();
            vi.advanceTimersByTime(50);
            debounced(); // Reset timer
            vi.advanceTimersByTime(50);
            expect(fn).not.toHaveBeenCalled(); // Still waiting

            vi.advanceTimersByTime(50);
            expect(fn).toHaveBeenCalledTimes(1);
            vi.useRealTimers();
        });
    });
});
