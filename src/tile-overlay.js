import { lonLatToTile, tileToLonLat } from './tile-math.js';
import { createTileCache } from './cache.js';
import { getViewportBounds } from './viewport.js';

const TILE_SIZE = 256;
const MAX_CANVAS_DIM = 8192; // GPU texture size limit
const DEFAULT_MAX_CACHED_TILES = 512;

/**
 * Overlays web map tiles onto an Autodesk APS Viewer as a camera-synced
 * 3D ground plane. Tiles are fetched dynamically based on what the camera
 * can see and stitched into a single texture.
 *
 * **Progressive rendering:** As tiles load, the overlay updates incrementally
 * so users see partial results instead of waiting for all tiles. The update
 * frequency is controlled by `options.progressInterval` (default: every 5 tiles).
 *
 * @example
 * const overlay = new TileOverlay(viewer, transformer, {
 *     urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
 *     zoomRange: [14, 19],
 *     maxBounds: { west: 16.0, south: 45.7, east: 16.2, north: 45.8 },
 * });
 * overlay.enable();
 */
export class TileOverlay {
    /**
     * @param {Object} viewer - Autodesk APS Viewer instance
     * @param {import('./CoordinateTransformer.js').CoordinateTransformer} transformer - Coordinate transformer
     * @param {Object} options
     * @param {string} options.urlTemplate - Tile URL template with {z}, {x}, {y} placeholders
     *   (e.g., 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
     * @param {[number, number]} options.zoomRange - Min and max zoom levels [minZoom, maxZoom]
     * @param {{ west: number, south: number, east: number, north: number }} options.maxBounds
     *   Maximum geographic bounds for tile fetching
     * @param {number} [options.groundZ] - Z elevation of the ground plane in viewer coordinates.
     *   Defaults to modelBBox.min.z - 5.
     * @param {number} [options.debounceMs=150] - Debounce delay for camera change updates (ms)
     * @param {number} [options.maxCachedTiles=512] - Maximum number of individual tiles kept in
     *   memory. Cached tiles are drawn immediately when they come back into view.
     * @param {number} [options.maxCacheSize] - Deprecated and ignored (stitched canvases are no
     *   longer cached). Use `maxCachedTiles`.
     * @param {number} [options.zoomScaleFactor=12] - Controls tile detail level relative to camera
     *   distance. Higher values = more detailed tiles. See viewport.js for details.
     * @param {number} [options.progressInterval=5] - How often to update the visible plane while
     *   tiles are still loading. For example, the default (5) means the texture refreshes after
     *   every 5th tile finishes loading, plus always on the very last tile. Set to 1 for
     *   per-tile updates, or a higher number to reduce redraws.
     * @param {function} [options.onTileError] - Callback when a tile fails to load.
     *   Called with `{ url, x, y, zoom }`. If not provided, failures are logged to console.warn.
     * @param {string} [options.sceneName] - Overlay scene name. Defaults to 'bim-tile-overlay'.
     */
    constructor(viewer, transformer, options) {
        this._viewer = viewer;
        this._transformer = transformer;
        this._urlTemplate = options.urlTemplate;
        this._zoomRange = options.zoomRange;
        this._maxBounds = options.maxBounds;
        this._groundZ = options.groundZ ?? (transformer.modelBBox.min.z - 5);
        this._debounceMs = options.debounceMs ?? 150;
        this._zoomScaleFactor = options.zoomScaleFactor;
        this._progressInterval = options.progressInterval ?? 5;
        this._onTileError = options.onTileError || null;
        this._sceneName = options.sceneName || 'bim-tile-overlay';

        if (options.maxCacheSize !== undefined) {
            console.warn(
                '[bim-tile-overlay] `maxCacheSize` is deprecated and ignored; ' +
                    'tiles are now cached individually. Use `maxCachedTiles` instead.'
            );
        }

        // LRU cache of loaded tile images, keyed by URL
        this._cache = createTileCache(options.maxCachedTiles ?? DEFAULT_MAX_CACHED_TILES);
        this._plane = null;
        this._currentBoundsKey = null;
        this._isActive = false;
        this._isUpdating = false;
        this._updateQueued = false;
        // Tile loads in flight, so disable() can cancel them
        this._pendingLoads = new Set();
        // Incremented on disable() so a run started before it never applies its result
        this._generation = 0;

        // Bind methods for event listener add/remove
        this._debouncedUpdate = this._debounce(this._updateTiles.bind(this), this._debounceMs);
        this._onCameraChange = () => {
            if (this._isActive) this._debouncedUpdate();
        };
    }

    /**
     * Enable the tile overlay. Adds the plane to the viewer and starts
     * listening to camera changes to dynamically update tiles.
     */
    async enable() {
        if (this._isActive) return;
        this._isActive = true;

        if (!this._plane) {
            this._plane = this._createEmptyPlane();
            this._viewer.overlays.addScene(this._sceneName);
        }

        this._viewer.overlays.addMesh(this._plane, this._sceneName);
        this._viewer.addEventListener(
            Autodesk.Viewing.CAMERA_CHANGE_EVENT,
            this._onCameraChange
        );

        await this._updateTiles();
    }

    /**
     * Disable the tile overlay. Removes the plane from the viewer and stops
     * listening to camera changes. Pending tile downloads are cancelled.
     * The plane and tile cache are preserved for re-enabling.
     */
    disable() {
        if (!this._isActive) return;
        this._isActive = false;
        this._currentBoundsKey = null;
        this._generation++;
        this._cancelPendingLoads();

        this._viewer.removeEventListener(
            Autodesk.Viewing.CAMERA_CHANGE_EVENT,
            this._onCameraChange
        );

        if (this._plane) {
            this._viewer.overlays.removeMesh(this._plane, this._sceneName);
        }
    }

    /**
     * Fully destroy the overlay, releasing all GPU resources (textures,
     * geometry, cached canvases). After calling destroy(), this instance
     * should not be reused.
     */
    destroy() {
        this.disable();

        if (this._plane) {
            this._disposeTexture(this._plane.material.map);
            if (this._plane.geometry) this._plane.geometry.dispose();
            if (this._plane.material) this._plane.material.dispose();
            this._plane = null;
        }

        this._cache.clear();
    }

    /**
     * Force an immediate tile update. Useful for programmatic control
     * (e.g., after changing the URL template or bounds).
     */
    async update() {
        this._currentBoundsKey = null; // Force recalculation
        await this._updateTiles();
    }

    // ── Private methods ──────────────────────────────────────────────

    async _updateTiles() {
        if (!this._isActive) return;
        if (this._isUpdating) {
            // An update is in flight; re-run once it finishes so the latest
            // camera position isn't dropped.
            this._updateQueued = true;
            return;
        }

        this._isUpdating = true;
        try {
            do {
                this._updateQueued = false;
                await this._runUpdate();
            } while (this._updateQueued && this._isActive);
        } finally {
            this._isUpdating = false;
            this._updateQueued = false;
        }
    }

    async _runUpdate() {
        const generation = this._generation;
        const isCurrent = () => this._isActive && generation === this._generation;

        const cam = this._viewer.navigation.getCamera();
        const camera = {
            position: cam.position,
            target: this._viewer.navigation.getTarget(),
            up: cam.up,
            fov: cam.fov || 45,
            aspect: cam.aspect || window.innerWidth / window.innerHeight,
        };

        const viewport = getViewportBounds(camera, this._transformer, {
            zoomRange: this._zoomRange,
            maxBounds: this._maxBounds,
            groundZ: this._groundZ,
            zoomScaleFactor: this._zoomScaleFactor,
        });

        const bounds = viewport.bounds;
        const boundsKey = `${viewport.zoom}_${bounds.west.toFixed(4)}_${bounds.south.toFixed(4)}_${bounds.east.toFixed(4)}_${bounds.north.toFixed(4)}`;
        if (boundsKey === this._currentBoundsKey) return;

        let planeInitialized = false;
        const onProgress = (partialResult) => {
            if (!isCurrent()) return;
            if (!planeInitialized) {
                this._updatePlane(partialResult);
                planeInitialized = true;
            } else {
                this._plane.material.map.image = partialResult.canvas;
                this._plane.material.map.needsUpdate = true;
            }
            this._viewer.impl.invalidate(true, true, true);
        };

        const tileResult = await this._fetchAndStitchTiles(
            bounds,
            viewport.zoom,
            onProgress
        );
        if (!isCurrent()) return;
        if (!planeInitialized) {
            this._updatePlane(tileResult);
        }
        this._currentBoundsKey = boundsKey;
        this._viewer.impl.invalidate(true, true, true);
    }

    async _fetchAndStitchTiles(bounds, zoom, onProgress) {
        let minTile = lonLatToTile(bounds.west, bounds.north, zoom);
        let maxTile = lonLatToTile(bounds.east, bounds.south, zoom);

        let xCount = maxTile.x - minTile.x + 1;
        let yCount = maxTile.y - minTile.y + 1;

        // Reduce zoom if stitched canvas would exceed GPU texture limits
        while (
            (xCount * TILE_SIZE > MAX_CANVAS_DIM || yCount * TILE_SIZE > MAX_CANVAS_DIM) &&
            zoom > 1
        ) {
            zoom--;
            minTile = lonLatToTile(bounds.west, bounds.north, zoom);
            maxTile = lonLatToTile(bounds.east, bounds.south, zoom);
            xCount = maxTile.x - minTile.x + 1;
            yCount = maxTile.y - minTile.y + 1;
        }

        const canvas = document.createElement('canvas');
        canvas.width = xCount * TILE_SIZE;
        canvas.height = yCount * TILE_SIZE;
        const ctx = canvas.getContext('2d');

        // Calculate the exact geographic bounds of the stitched tile grid
        const tileBoundsNW = tileToLonLat(minTile.x, minTile.y, zoom);
        const tileBoundsSE = tileToLonLat(maxTile.x + 1, maxTile.y + 1, zoom);
        const geoBounds = {
            west: tileBoundsNW.lon,
            north: tileBoundsNW.lat,
            east: tileBoundsSE.lon,
            south: tileBoundsSE.lat,
        };

        let settledCount = 0;
        const totalTiles = xCount * yCount;
        const interval = this._progressInterval;

        // Called when a downloaded tile finishes, whether it loaded or failed.
        // Progressive rendering: update the visible plane periodically
        // as tiles settle, controlled by progressInterval option.
        // Always fires on the final tile to ensure complete render.
        const onTileSettled = () => {
            settledCount++;
            if (onProgress && (settledCount % interval === 0 || settledCount === totalTiles)) {
                onProgress({ canvas, geoBounds });
            }
        };

        const tilePromises = [];
        for (let x = minTile.x; x <= maxTile.x; x++) {
            for (let y = minTile.y; y <= maxTile.y; y++) {
                const url = this._urlTemplate
                    .replace('{z}', zoom)
                    .replace('{x}', x)
                    .replace('{y}', y);
                const dx = (x - minTile.x) * TILE_SIZE;
                const dy = (y - minTile.y) * TILE_SIZE;

                // Cached tiles are drawn immediately, without a progress update;
                // if every tile is cached the caller applies the finished canvas.
                const cached = this._cache.get(url);
                if (cached) {
                    ctx.drawImage(cached, dx, dy, TILE_SIZE, TILE_SIZE);
                    settledCount++;
                    continue;
                }

                tilePromises.push(
                    this._loadTile(url).then(({ status, img }) => {
                        if (status === 'cancelled') return;
                        if (status === 'loaded') {
                            ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
                            this._cache.put(url, img);
                        } else {
                            const errorInfo = { url, x, y, zoom };
                            if (this._onTileError) {
                                this._onTileError(errorInfo);
                            } else {
                                console.warn(`[bim-tile-overlay] Failed to load tile: ${url}`);
                            }
                        }
                        onTileSettled();
                    })
                );
            }
        }

        await Promise.all(tilePromises);

        return { canvas, geoBounds };
    }

    /**
     * Load a single tile image. Resolves with `{ status, img }`, where status is
     * 'loaded', 'error', or 'cancelled' (by disable()). Never rejects.
     */
    _loadTile(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const pending = { img, resolve };
            this._pendingLoads.add(pending);
            img.onload = () => {
                this._pendingLoads.delete(pending);
                resolve({ status: 'loaded', img });
            };
            img.onerror = () => {
                this._pendingLoads.delete(pending);
                resolve({ status: 'error', img: null });
            };
            img.src = url;
        });
    }

    _cancelPendingLoads() {
        for (const { img, resolve } of this._pendingLoads) {
            img.onload = null;
            img.onerror = null;
            img.src = ''; // Aborts the download
            resolve({ status: 'cancelled', img: null });
        }
        this._pendingLoads.clear();
    }

    /** Dispose a texture and free its stitched canvas's memory. */
    _disposeTexture(texture) {
        if (!texture) return;
        texture.dispose();
        if (texture.image) {
            texture.image.width = 0;
            texture.image.height = 0;
        }
    }

    _updatePlane(tileResult) {
        const { canvas, geoBounds } = tileResult;

        // Transform the 4 geographic corners to viewer coordinates
        const nw = this._transformer.lonLatToViewer(geoBounds.west, geoBounds.north);
        const ne = this._transformer.lonLatToViewer(geoBounds.east, geoBounds.north);
        const sw = this._transformer.lonLatToViewer(geoBounds.west, geoBounds.south);
        const se = this._transformer.lonLatToViewer(geoBounds.east, geoBounds.south);

        const width = Math.sqrt(Math.pow(ne.x - nw.x, 2) + Math.pow(ne.y - nw.y, 2));
        const height = Math.sqrt(Math.pow(sw.x - nw.x, 2) + Math.pow(sw.y - nw.y, 2));

        const centerX = (nw.x + ne.x + sw.x + se.x) / 4;
        const centerY = (nw.y + ne.y + sw.y + se.y) / 4;
        const rotation = Math.atan2(ne.y - nw.y, ne.x - nw.x);

        // Dispose old texture, its canvas and geometry to free memory
        this._disposeTexture(this._plane.material.map);
        if (this._plane.geometry) this._plane.geometry.dispose();

        const texture = new THREE.Texture(canvas);
        texture.needsUpdate = true;
        texture.minFilter = THREE.LinearFilter;

        this._plane.geometry = new THREE.PlaneGeometry(width, height);
        this._plane.material.map = texture;
        this._plane.material.needsUpdate = true;
        this._plane.position.set(centerX, centerY, this._groundZ);
        this._plane.rotation.z = rotation;
    }

    _createEmptyPlane() {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
        });
        return new THREE.Mesh(geometry, material);
    }

    _debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }
}
