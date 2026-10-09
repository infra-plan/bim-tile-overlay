import { tileToLonLat } from './tile-math.js';
import { createTileCache } from './cache.js';
import { selectTiles, resolveDisplayTiles, tileKey } from './tile-selection.js';

const DEFAULT_MAX_CACHED_TILES = 1024;

// Each zoom level sits this much higher (in viewer units) than the one below,
// so a finer tile draws over a coarser one shown underneath as a fallback.
const Z_STEP_PER_ZOOM = 0.01;

const DEPRECATED_OPTIONS = {
    maxCacheSize: 'Use `maxCachedTiles` instead.',
    zoomScaleFactor: 'Use `detailScale` instead.',
    progressInterval: 'Tiles now appear individually as they load.',
};

/**
 * Overlays web map tiles onto an Autodesk APS Viewer as a camera-synced
 * 3D ground plane. Each tile is its own mesh, and detail depends on distance:
 * ground close to the camera gets high-zoom tiles, distant ground coarser ones.
 *
 * While new tiles load, the tiles already on screen stay as fallbacks (a coarser
 * tile underneath after zooming in, finer tiles after zooming out), so the
 * ground doesn't flicker or go blank.
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
     * @param {import('./coordinate-transformer.js').CoordinateTransformer} transformer - Coordinate transformer
     * @param {Object} options
     * @param {string} options.urlTemplate - Tile URL template with {z}, {x}, {y} placeholders
     *   (e.g., 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
     * @param {[number, number]} options.zoomRange - Min and max zoom levels [minZoom, maxZoom]
     * @param {{ west: number, south: number, east: number, north: number }} options.maxBounds
     *   Maximum geographic bounds for tile fetching
     * @param {number} [options.groundZ] - Z elevation of the ground plane in viewer coordinates.
     *   Defaults to modelBBox.min.z - 5.
     * @param {number} [options.debounceMs=150] - Debounce delay for camera change updates (ms)
     * @param {number} [options.detailScale=1] - Tile detail relative to distance. Tiles are
     *   refined until they appear at most 256 / detailScale px on screen, so 2 gives finer tiles.
     * @param {number} [options.maxTiles=500] - Upper limit on tiles shown at once. When reached,
     *   distant ground is left coarser.
     * @param {number} [options.maxCachedTiles=1024] - Maximum number of loaded tile images kept
     *   in memory, so tiles that come back into view appear without downloading again.
     * @param {function} [options.onTileError] - Callback when a tile fails to load.
     *   Called with `{ url, x, y, zoom }`. If not provided, failures are logged to console.warn.
     * @param {string} [options.sceneName] - Overlay scene name. Defaults to 'bim-tile-overlay'.
     * @param {number} [options.maxCacheSize] - Deprecated and ignored. Use `maxCachedTiles`.
     * @param {number} [options.zoomScaleFactor] - Deprecated and ignored. Use `detailScale`.
     * @param {number} [options.progressInterval] - Deprecated and ignored.
     */
    constructor(viewer, transformer, options) {
        this._viewer = viewer;
        this._transformer = transformer;
        this._urlTemplate = options.urlTemplate;
        this._zoomRange = options.zoomRange;
        this._maxBounds = options.maxBounds;
        this._groundZ = options.groundZ ?? (transformer.modelBBox.min.z - 5);
        this._debounceMs = options.debounceMs ?? 150;
        this._detailScale = options.detailScale;
        this._maxTiles = options.maxTiles;
        this._onTileError = options.onTileError || null;
        this._sceneName = options.sceneName || 'bim-tile-overlay';

        for (const [name, hint] of Object.entries(DEPRECATED_OPTIONS)) {
            if (options[name] !== undefined) {
                console.warn(`[bim-tile-overlay] \`${name}\` is deprecated and ignored. ${hint}`);
            }
        }

        // LRU cache of loaded tile images, keyed by URL
        this._cache = createTileCache(options.maxCachedTiles ?? DEFAULT_MAX_CACHED_TILES);
        this._isActive = false;
        this._sceneAdded = false;
        // Tiles chosen for the current camera
        this._wanted = [];
        // Tiles on screen: key → mesh. A mesh holds its own image, so a tile
        // stays on screen even after its image leaves the cache.
        this._shown = new Map();
        // Downloads in flight: key → Image
        this._loads = new Map();
        // Tiles loaded since the last display update: key → Image. Held here
        // (not only in the cache) so they can't be evicted before being shown.
        this._loaded = new Map();
        // Display updates are batched to at most one per animation frame
        this._refreshScheduled = false;
        // Resolvers for promises waiting until no downloads are in flight
        this._idleWaiters = [];

        // Bind methods for event listener add/remove
        this._debouncedUpdate = this._debounce(this._updateTiles.bind(this), this._debounceMs);
        this._onCameraChange = () => {
            if (this._isActive) this._debouncedUpdate();
        };
    }

    /**
     * Enable the tile overlay and start following camera changes.
     * Resolves once the tiles for the current view have loaded (or failed).
     */
    async enable() {
        if (this._isActive) return;
        this._isActive = true;

        if (!this._sceneAdded) {
            this._viewer.overlays.addScene(this._sceneName);
            this._sceneAdded = true;
        }
        this._viewer.addEventListener(
            Autodesk.Viewing.CAMERA_CHANGE_EVENT,
            this._onCameraChange
        );

        this._updateTiles();
        await this._whenIdle();
    }

    /**
     * Disable the tile overlay. Removes all tiles from the viewer, cancels pending
     * downloads and stops following the camera. Loaded tile images stay cached,
     * so re-enabling shows them immediately.
     */
    disable() {
        if (!this._isActive) return;
        this._isActive = false;

        this._viewer.removeEventListener(
            Autodesk.Viewing.CAMERA_CHANGE_EVENT,
            this._onCameraChange
        );

        for (const key of [...this._loads.keys()]) this._cancelLoad(key);
        for (const mesh of this._shown.values()) this._removeMesh(mesh);
        this._shown.clear();
        this._loaded.clear();
        this._wanted = [];
        this._viewer.impl.invalidate(true, true, true);
        this._checkIdle();
    }

    /**
     * Fully destroy the overlay, releasing all GPU resources and cached images.
     * After calling destroy(), this instance should not be reused.
     */
    destroy() {
        this.disable();
        this._cache.clear();
    }

    /**
     * Update the tiles for the current camera immediately, without waiting for
     * a camera change event. Resolves once the tiles have loaded (or failed).
     */
    async update() {
        this._updateTiles();
        await this._whenIdle();
    }

    // ── Private methods ──────────────────────────────────────────────

    _updateTiles() {
        if (!this._isActive) return;

        const cam = this._viewer.navigation.getCamera();
        const container = this._viewer.container;
        const camera = {
            position: cam.position,
            target: this._viewer.navigation.getTarget(),
            up: cam.up,
            fov: cam.fov || 45,
            aspect: cam.aspect || (container ? container.clientWidth / container.clientHeight : 1),
        };

        this._wanted = selectTiles(camera, this._transformer, {
            zoomRange: this._zoomRange,
            maxBounds: this._maxBounds,
            groundZ: this._groundZ,
            viewportHeight: container?.clientHeight || globalThis.innerHeight || 1000,
            detailScale: this._detailScale,
            maxTiles: this._maxTiles,
        });

        // Cancel downloads that are no longer needed, start the missing ones
        const wantedKeys = new Set(this._wanted.map(tileKey));
        for (const key of [...this._loads.keys()]) {
            if (!wantedKeys.has(key)) this._cancelLoad(key);
        }
        for (const tile of this._wanted) {
            const key = tileKey(tile);
            if (this._shown.has(key) || this._loads.has(key)) continue;
            if (this._cache.get(this._tileUrl(tile))) continue;
            this._loadTile(tile);
        }

        this._refreshDisplay();
        this._checkIdle();
    }

    /** Show the tiles for the current view, with fallbacks for those still loading. */
    _refreshDisplay() {
        const imageFor = (tile) =>
            this._loaded.get(tileKey(tile)) ?? this._cache.get(this._tileUrl(tile));
        const isReady = (tile) => imageFor(tile) !== undefined;
        const toShow = resolveDisplayTiles(this._wanted, isReady, new Set(this._shown.keys()));

        const showKeys = new Set();
        for (const tile of toShow) {
            const key = tileKey(tile);
            showKeys.add(key);
            if (this._shown.has(key)) continue;
            const mesh = this._createTileMesh(tile, imageFor(tile));
            this._viewer.overlays.addMesh(mesh, this._sceneName);
            this._shown.set(key, mesh);
        }
        this._loaded.clear();
        for (const [key, mesh] of this._shown) {
            if (showKeys.has(key)) continue;
            this._removeMesh(mesh);
            this._shown.delete(key);
        }

        this._viewer.impl.invalidate(true, true, true);
    }

    _loadTile(tile) {
        const key = tileKey(tile);
        const url = this._tileUrl(tile);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            this._loads.delete(key);
            this._cache.put(url, img);
            this._loaded.set(key, img);
            this._scheduleRefresh();
        };
        img.onerror = () => {
            this._loads.delete(key);
            const errorInfo = { url, x: tile.x, y: tile.y, zoom: tile.z };
            if (this._onTileError) {
                this._onTileError(errorInfo);
            } else {
                console.warn(`[bim-tile-overlay] Failed to load tile: ${url}`);
            }
            this._checkIdle();
        };
        this._loads.set(key, img);
        img.src = url;
    }

    _cancelLoad(key) {
        const img = this._loads.get(key);
        img.onload = null;
        img.onerror = null;
        img.src = ''; // Aborts the download
        this._loads.delete(key);
    }

    /**
     * Update the display on the next animation frame. Tiles that load in the
     * same frame are shown together, with one display update and one redraw.
     */
    _scheduleRefresh() {
        if (this._refreshScheduled) return;
        this._refreshScheduled = true;
        const nextFrame = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 0));
        nextFrame(() => {
            this._refreshScheduled = false;
            if (this._isActive) this._refreshDisplay();
            this._checkIdle();
        });
    }

    _whenIdle() {
        if (this._loads.size === 0) return Promise.resolve();
        return new Promise((resolve) => this._idleWaiters.push(resolve));
    }

    _checkIdle() {
        if (this._loads.size > 0 || this._refreshScheduled) return;
        for (const resolve of this._idleWaiters.splice(0)) resolve();
    }

    _tileUrl({ z, x, y }) {
        return this._urlTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }

    _createTileMesh(tile, image) {
        const { z, x, y } = tile;
        const nwLL = tileToLonLat(x, y, z);
        const seLL = tileToLonLat(x + 1, y + 1, z);

        // Transform the 4 geographic corners to viewer coordinates
        const nw = this._transformer.lonLatToViewer(nwLL.lon, nwLL.lat);
        const ne = this._transformer.lonLatToViewer(seLL.lon, nwLL.lat);
        const sw = this._transformer.lonLatToViewer(nwLL.lon, seLL.lat);
        const se = this._transformer.lonLatToViewer(seLL.lon, seLL.lat);

        const width = Math.sqrt(Math.pow(ne.x - nw.x, 2) + Math.pow(ne.y - nw.y, 2));
        const height = Math.sqrt(Math.pow(sw.x - nw.x, 2) + Math.pow(sw.y - nw.y, 2));

        const centerX = (nw.x + ne.x + sw.x + se.x) / 4;
        const centerY = (nw.y + ne.y + sw.y + se.y) / 4;
        const rotation = Math.atan2(ne.y - nw.y, ne.x - nw.x);

        const texture = new THREE.Texture(image);
        texture.needsUpdate = true;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.DoubleSide,
            transparent: true,
        });

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        const zOffset = (z - this._zoomRange[0]) * Z_STEP_PER_ZOOM;
        mesh.position.set(centerX, centerY, this._groundZ + zOffset);
        mesh.rotation.z = rotation;
        mesh.renderOrder = z;
        mesh.userData.tileKey = tileKey(tile);
        return mesh;
    }

    _removeMesh(mesh) {
        this._viewer.overlays.removeMesh(mesh, this._sceneName);
        mesh.material.map.dispose();
        mesh.material.dispose();
        mesh.geometry.dispose();
    }

    _debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }
}
