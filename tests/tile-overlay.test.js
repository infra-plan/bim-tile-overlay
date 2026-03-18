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
    Texture: function Texture() {
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

// Mock document.createElement for canvas
const mockCtx = { drawImage: vi.fn() };
const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => mockCtx),
};
vi.stubGlobal('document', {
    createElement: vi.fn(() => mockCanvas),
});

// Mock Image
class MockImage {
    constructor() {
        this.crossOrigin = '';
        this.src = '';
        this.onload = null;
        this.onerror = null;
    }
    set src(url) {
        this._src = url;
        // Simulate async load — trigger onload in next microtask
        if (url && this.onload) {
            Promise.resolve().then(() => this.onload());
        }
    }
    get src() {
        return this._src;
    }
}
vi.stubGlobal('Image', MockImage);

const { TileOverlay } = await import('../src/tile-overlay.js');

// ── Test helpers ──────────────────────────────────────────────

function createMockViewer() {
    const listeners = {};
    return {
        navigation: {
            getCamera: () => ({
                position: { x: 0, y: 0, z: 100 },
                fov: 45,
                aspect: 1.5,
            }),
            getTarget: () => ({ x: 0, y: 0, z: 0 }),
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
