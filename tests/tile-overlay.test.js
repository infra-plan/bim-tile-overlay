import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tileToLonLat } from '../src/tile-math.js';

// Mock THREE.js globals before importing TileOverlay
globalThis.THREE = {
    PlaneGeometry: function PlaneGeometry(width, height) {
        this.width = width;
        this.height = height;
        this.dispose = vi.fn();
    },
    MeshBasicMaterial: function MeshBasicMaterial(opts) {
        this.map = opts?.map ?? null;
        this.side = opts?.side;
        this.transparent = opts?.transparent;
        this.dispose = vi.fn();
    },
    Mesh: function Mesh(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) {
                this.x = x;
                this.y = y;
                this.z = z;
            },
        };
        this.rotation = { z: 0 };
        this.renderOrder = 0;
        this.userData = {};
    },
    Texture: function Texture(image) {
        this.image = image;
        this.needsUpdate = false;
        this.dispose = vi.fn();
    },
    DoubleSide: 2,
};

globalThis.Autodesk = {
    Viewing: {
        CAMERA_CHANGE_EVENT: 'cameraChanged',
    },
};

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
    get src() {
        return this._src;
    }
    _settle() {
        const url = this._src;
        Promise.resolve().then(() => {
            if (this._src !== url) return; // load was aborted
            if (failingUrls.has(url)) this.onerror?.();
            else this.onload?.();
        });
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

// Linear transformer around Zagreb, viewer units in feet
const FT = 0.3048;
const LON0 = 16.0;
const LAT0 = 45.8;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const M_PER_DEG_LAT = 110574;

function createMockTransformer() {
    return {
        modelBBox: {
            min: { x: -100, y: -100, z: -10 },
            max: { x: 100, y: 100, z: 50 },
        },
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
}

function createMockViewer() {
    const listeners = {};
    const scene = new Set();
    const camera = { fov: 45, aspect: 1.5 };
    const target = {};
    const viewer = {
        container: { clientWidth: 1200, clientHeight: 800 },
        navigation: {
            getCamera: () => camera,
            getTarget: () => target,
        },
        overlays: {
            addScene: vi.fn(),
            addMesh: vi.fn((mesh) => scene.add(mesh)),
            removeMesh: vi.fn((mesh) => scene.delete(mesh)),
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
        _scene: scene,
        // Place the camera `heightM` above (xM, yM) facing north,
        // pitched `pitchDeg` below the horizon (90 = straight down)
        _setCamera(heightM, pitchDeg = 90, xM = 0, yM = 0) {
            const h = heightM / FT;
            const p = (pitchDeg * Math.PI) / 180;
            const x = xM / FT;
            const y = yM / FT;
            camera.position = { x, y, z: h };
            camera.up = { x: 0, y: Math.sin(p), z: Math.cos(p) };
            Object.assign(target, { x, y: y + Math.cos(p) * 100, z: h - Math.sin(p) * 100 });
        },
    };
    viewer._setCamera(200);
    return viewer;
}

const defaultOptions = {
    urlTemplate: 'https://tile.example.com/{z}/{x}/{y}.png',
    zoomRange: [12, 19],
    maxBounds: {
        west: LON0 - 5000 / M_PER_DEG_LON,
        east: LON0 + 5000 / M_PER_DEG_LON,
        south: LAT0 - 5000 / M_PER_DEG_LAT,
        north: LAT0 + 5000 / M_PER_DEG_LAT,
    },
};

const shownMeshes = (viewer) => [...viewer._scene];
const shownKeys = (viewer) => shownMeshes(viewer).map((m) => m.userData.tileKey).sort();
const urlFor = (key) => {
    const [z, x, y] = key.split('/');
    return `https://tile.example.com/${z}/${x}/${y}.png`;
};
const zoomOf = (key) => Number(key.split('/')[0]);

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
        heldImages.length = 0;
        imageLoading.hold = false;
    });

    describe('constructor', () => {
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

        it('starts inactive, showing nothing', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            expect(overlay._isActive).toBe(false);
            expect(viewer.overlays.addMesh).not.toHaveBeenCalled();
        });

        it.each([
            ['maxCacheSize', 'maxCachedTiles'],
            ['zoomScaleFactor', 'detailScale'],
            ['progressInterval', 'progressInterval'],
        ])('warns that %s is deprecated', (option) => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            new TileOverlay(viewer, transformer, { ...defaultOptions, [option]: 5 });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(option));
            warn.mockRestore();
        });
    });

    describe('enable', () => {
        it('adds the scene, listens to the camera and shows the loaded tiles', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            expect(viewer.overlays.addScene).toHaveBeenCalledWith('bim-tile-overlay');
            expect(viewer.addEventListener).toHaveBeenCalledWith(
                'cameraChanged',
                expect.any(Function)
            );
            const keys = shownKeys(viewer);
            expect(keys.length).toBeGreaterThan(0);
            expect(keys.map(urlFor).sort()).toEqual([...requestedUrls].sort());
        });

        it('does nothing if already active', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const requests = requestedUrls.length;

            await overlay.enable();
            expect(viewer.overlays.addScene).toHaveBeenCalledTimes(1);
            expect(requestedUrls.length).toBe(requests);
        });

        it('uses custom scene name', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                sceneName: 'my-custom-scene',
            });
            await overlay.enable();

            expect(viewer.overlays.addScene).toHaveBeenCalledWith('my-custom-scene');
            expect(viewer.overlays.addMesh).toHaveBeenCalledWith(
                expect.anything(),
                'my-custom-scene'
            );
        });

        it('shows the most detail near a low camera looking at the horizon', async () => {
            viewer._setCamera(2, 5);
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            const zooms = shownKeys(viewer).map(zoomOf);
            expect(Math.max(...zooms)).toBe(19);
            expect(Math.min(...zooms)).toBeLessThan(16);
        });
    });

    describe('tile meshes', () => {
        it('places each tile at its geographic position on the ground plane', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            for (const mesh of shownMeshes(viewer)) {
                const [z, x, y] = mesh.userData.tileKey.split('/').map(Number);
                const nw = transformer.lonLatToViewer(
                    tileToLonLat(x, y, z).lon,
                    tileToLonLat(x, y, z).lat
                );
                const se = transformer.lonLatToViewer(
                    tileToLonLat(x + 1, y + 1, z).lon,
                    tileToLonLat(x + 1, y + 1, z).lat
                );
                expect(mesh.position.x).toBeCloseTo((nw.x + se.x) / 2, 6);
                expect(mesh.position.y).toBeCloseTo((nw.y + se.y) / 2, 6);
                expect(mesh.geometry.width).toBeCloseTo(se.x - nw.x, 6);
                expect(mesh.geometry.height).toBeCloseTo(nw.y - se.y, 6);
                expect(mesh.position.z).toBeGreaterThanOrEqual(-15);
                expect(mesh.position.z).toBeLessThan(-14);
                expect(mesh.material.map.image.src).toBe(urlFor(mesh.userData.tileKey));
            }
        });

        it('draws higher zoom levels above lower ones', async () => {
            viewer._setCamera(2, 5);
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            const meshes = shownMeshes(viewer);
            const byZoom = (z) => meshes.find((m) => zoomOf(m.userData.tileKey) === z);
            const fine = byZoom(19);
            const coarse = byZoom(16);
            expect(fine.position.z).toBeGreaterThan(coarse.position.z);
            expect(fine.renderOrder).toBeGreaterThan(coarse.renderOrder);
        });
    });

    describe('while new tiles load', () => {
        it('keeps showing the coarser tiles after zooming in', async () => {
            viewer._setCamera(1000);
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const before = shownKeys(viewer);

            imageLoading.hold = true;
            viewer._setCamera(200);
            const updating = overlay.update();

            // Nothing new has loaded: every loading tile is covered by one of
            // the previous, coarser tiles
            const during = shownKeys(viewer);
            const loading = heldImages.map((img) => img.src.match(/(\d+\/\d+\/\d+)\.png$/)[1]);
            expect(loading.length).toBeGreaterThan(0);
            for (const key of during) expect(before).toContain(key);
            for (const key of loading) {
                let [z, x, y] = key.split('/').map(Number);
                let covered = false;
                while (z > 0 && !covered) {
                    z--;
                    x = Math.floor(x / 2);
                    y = Math.floor(y / 2);
                    covered = during.includes(`${z}/${x}/${y}`);
                }
                expect(covered).toBe(true);
            }

            releaseHeldImages();
            await updating;
            const after = shownKeys(viewer);
            expect(Math.min(...after.map(zoomOf))).toBeGreaterThan(
                Math.max(...before.map(zoomOf))
            );
            expect(after.some((k) => before.includes(k))).toBe(false);
        });

        it('keeps showing the finer tiles after zooming out', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const before = shownKeys(viewer);

            imageLoading.hold = true;
            viewer._setCamera(1000);
            const updating = overlay.update();

            const during = shownKeys(viewer);
            for (const key of before) expect(during).toContain(key);

            releaseHeldImages();
            await updating;
            const after = shownKeys(viewer);
            expect(after.some((k) => before.includes(k))).toBe(false);
        });

        it('disposes tiles once they are replaced', async () => {
            viewer._setCamera(1000);
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const oldMeshes = shownMeshes(viewer);

            viewer._setCamera(200);
            await overlay.update();

            for (const mesh of oldMeshes) {
                expect(viewer._scene.has(mesh)).toBe(false);
                expect(mesh.material.map.dispose).toHaveBeenCalled();
                expect(mesh.material.dispose).toHaveBeenCalled();
                expect(mesh.geometry.dispose).toHaveBeenCalled();
            }
        });

        it('keeps displayed tiles on screen even when evicted from the cache', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                maxCachedTiles: 2,
            });
            await overlay.enable();

            const keys = shownKeys(viewer);
            expect(keys.length).toBeGreaterThan(2);
            expect(keys.map(urlFor).sort()).toEqual([...requestedUrls].sort());
        });

        it('does not download displayed tiles again after they leave the cache', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                maxCachedTiles: 2,
            });
            await overlay.enable();
            requestedUrls.length = 0;

            await overlay.update(); // Same view

            expect(requestedUrls).toEqual([]);
        });

        it('updates the display once for tiles that finish loading together', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const tileCount = heldImages.length;
            expect(tileCount).toBeGreaterThan(10);
            viewer.impl.invalidate.mockClear();

            releaseHeldImages(); // All tiles load in the same tick
            await enabling;

            expect(viewer.impl.invalidate).toHaveBeenCalledTimes(1);
            expect(shownKeys(viewer)).toHaveLength(tileCount);
        });

        it('cancels downloads of tiles that are no longer wanted', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            overlay.enable();
            const pending = heldImages.slice();
            expect(pending.length).toBeGreaterThan(0);

            viewer._setCamera(200, 90, 3000, 3000); // Far away, no overlap
            overlay.update();

            for (const img of pending) expect(img.src).toBe('');
        });
    });

    describe('tile cache', () => {
        it('downloads nothing when returning to a previous view', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const first = shownKeys(viewer);
            viewer._setCamera(200, 90, 3000, 3000);
            await overlay.update();
            requestedUrls.length = 0;

            viewer._setCamera(200);
            await overlay.update();

            expect(requestedUrls).toEqual([]);
            expect(shownKeys(viewer)).toEqual(first);
        });

        it('only downloads the new tiles after a small pan', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const first = requestedUrls.splice(0);

            viewer._setCamera(200, 90, 80, 0); // About 1.5 tiles east
            await overlay.update();

            expect(requestedUrls.length).toBeGreaterThan(0);
            expect(requestedUrls.length).toBeLessThan(first.length / 2);
            for (const url of requestedUrls) expect(first).not.toContain(url);
        });

        it('limits the number of cached tiles to maxCachedTiles', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                maxCachedTiles: 3,
            });
            await overlay.enable();

            expect(overlay._cache.size()).toBe(3);
        });
    });

    describe('tile errors', () => {
        it('reports failed tiles and shows the rest', async () => {
            const onTileError = vi.fn();
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                onTileError,
            });
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const failing = heldImages[0].src;
            failingUrls.add(failing);
            releaseHeldImages();
            await enabling;

            const [, z, x, y] = failing.match(/(\d+)\/(\d+)\/(\d+)\.png$/).map(Number);
            expect(onTileError).toHaveBeenCalledWith({ url: failing, x, y, zoom: z });
            expect(shownKeys(viewer).map(urlFor)).not.toContain(failing);
            expect(shownKeys(viewer).length).toBe(requestedUrls.length - 1);
        });

        it('logs a warning when no onTileError is given', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const failing = heldImages[0].src;
            failingUrls.add(failing);
            releaseHeldImages();
            await enabling;

            expect(warn).toHaveBeenCalledWith(expect.stringContaining(failing));
            warn.mockRestore();
        });
    });

    describe('disable', () => {
        it('removes all tiles and stops listening', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            overlay.disable();

            expect(overlay._isActive).toBe(false);
            expect(viewer._scene.size).toBe(0);
            expect(viewer.removeEventListener).toHaveBeenCalledWith(
                'cameraChanged',
                expect.any(Function)
            );
        });

        it('cancels pending downloads and resolves enable()', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            imageLoading.hold = true;
            const enabling = overlay.enable();
            const pending = heldImages.slice();

            overlay.disable();
            await enabling;

            for (const img of pending) expect(img.src).toBe('');
            expect(viewer._scene.size).toBe(0);
        });

        it('does nothing if already inactive', () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            overlay.disable();
            expect(viewer.removeEventListener).not.toHaveBeenCalled();
        });

        it('shows cached tiles immediately when re-enabled', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const before = shownKeys(viewer);
            overlay.disable();
            requestedUrls.length = 0;

            const enabling = overlay.enable();

            expect(shownKeys(viewer)).toEqual(before);
            expect(requestedUrls).toEqual([]);
            await enabling;
            expect(viewer.overlays.addScene).toHaveBeenCalledTimes(1);
        });
    });

    describe('destroy', () => {
        it('disposes all tiles and clears the cache', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();
            const meshes = shownMeshes(viewer);

            overlay.destroy();

            expect(viewer._scene.size).toBe(0);
            for (const mesh of meshes) {
                expect(mesh.material.map.dispose).toHaveBeenCalled();
                expect(mesh.geometry.dispose).toHaveBeenCalled();
            }
            expect(overlay._cache.size()).toBe(0);
        });

        it('is safe to call multiple times', async () => {
            const overlay = new TileOverlay(viewer, transformer, defaultOptions);
            await overlay.enable();

            overlay.destroy();
            overlay.destroy();
        });
    });

    describe('camera changes', () => {
        it('update the tiles after the debounce delay', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                debounceMs: 0,
            });
            await overlay.enable();
            const before = shownKeys(viewer);

            viewer._setCamera(1000);
            viewer._listeners.cameraChanged.forEach((cb) => cb());
            await flush();
            await flush();

            expect(shownKeys(viewer)).not.toEqual(before);
        });

        it('are ignored after disable', async () => {
            const overlay = new TileOverlay(viewer, transformer, {
                ...defaultOptions,
                debounceMs: 0,
            });
            await overlay.enable();
            const callback = viewer._listeners.cameraChanged[0];
            overlay.disable();
            requestedUrls.length = 0;

            viewer._setCamera(50);
            callback();
            await flush();

            expect(requestedUrls).toEqual([]);
            expect(viewer._scene.size).toBe(0);
        });
    });

    describe('debounce', () => {
        it('delays execution', () => {
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
