// Type definitions for bim-tile-overlay
// Project: https://github.com/infra-plan/bim-tile-overlay
// By Infra Plan

export interface GeoBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface ViewerCoords {
    x: number;
    y: number;
    z: number;
}

export interface LonLat {
    lon: number;
    lat: number;
    z: number;
}

export interface TileCoords {
    x: number;
    y: number;
}

export interface ViewportResult {
    bounds: GeoBounds;
    zoom: number;
}

export interface TileOverlayOptions {
    /** Tile URL template with {z}, {x}, {y} placeholders */
    urlTemplate: string;
    /** Min and max zoom levels [minZoom, maxZoom] */
    zoomRange: [number, number];
    /** Maximum geographic bounds for tile fetching */
    maxBounds: GeoBounds;
    /** Z elevation of the ground plane in viewer coordinates. Defaults to modelBBox.min.z - 5. */
    groundZ?: number;
    /** Debounce delay for camera change updates in ms. Default: 150 */
    debounceMs?: number;
    /**
     * Tile detail relative to distance. Tiles are refined until they appear at
     * most 256 / detailScale px on screen, so 2 gives finer tiles. Default: 1
     */
    detailScale?: number;
    /** Maximum tiles shown at once. When reached, distant ground stays coarser. Default: 500 */
    maxTiles?: number;
    /**
     * Maximum number of loaded tile images kept in memory, so tiles coming back
     * into view appear without downloading again. Default: 1024
     */
    maxCachedTiles?: number;
    /** @deprecated Ignored. Use `maxCachedTiles`. */
    maxCacheSize?: number;
    /** @deprecated Ignored. Use `detailScale`. */
    zoomScaleFactor?: number;
    /** @deprecated Ignored. Tiles now appear individually as they load. */
    progressInterval?: number;
    /**
     * Callback when a tile fails to load. Called with `{ url, x, y, zoom }`.
     * If not provided, failures are logged to console.warn.
     */
    onTileError?: (error: { url: string; x: number; y: number; zoom: number }) => void;
    /** Overlay scene name. Default: 'bim-tile-overlay' */
    sceneName?: string;
}

export interface CoordinateTransformerConfig {
    /** proj4 definition string for the local CRS (e.g., EPSG:3765 for Croatia HTRS96/TM) */
    crs: string;
    /**
     * Column-major 4x3 transform matrix from BIM model metadata.
     * Elements [0],[1] encode cos/sin of rotation,
     * elements [9],[10] encode the X/Y translation.
     */
    refPointTransform: number[];
    /** Viewer global offset */
    globalOffset: ViewerCoords;
    /** Model bounding box */
    modelBBox: {
        min: ViewerCoords;
        max: ViewerCoords;
    };
}

export interface ViewportOptions {
    /** Min and max zoom levels [minZoom, maxZoom] */
    zoomRange: [number, number];
    /** Maximum geographic bounds to clip to */
    maxBounds: GeoBounds;
    /** Z elevation of the ground plane in viewer coordinates */
    groundZ: number;
    /**
     * Scaling factor that maps the visible longitude span to a tile zoom level.
     * Formula: zoom = log2((360 / lonSpan) * zoomScaleFactor).
     * Default: 12
     */
    zoomScaleFactor?: number;
}

export interface CameraState {
    position: ViewerCoords;
    target: ViewerCoords;
    /** Camera screen-up direction. Defaults to world up (0, 0, 1). */
    up?: ViewerCoords;
    fov: number;
    aspect: number;
}

/**
 * Overlays web map tiles onto an Autodesk APS Viewer as a camera-synced
 * 3D ground plane.
 */
export class TileOverlay {
    constructor(viewer: any, transformer: CoordinateTransformer, options: TileOverlayOptions);
    /** Enable the overlay and follow the camera; resolves once the visible tiles have loaded */
    enable(): Promise<void>;
    /** Remove the tiles and cancel pending downloads, keeping the tile cache */
    disable(): void;
    /** Fully destroy the overlay, releasing all GPU resources */
    destroy(): void;
    /** Update the tiles for the current camera now; resolves once they have loaded */
    update(): Promise<void>;
}

/**
 * Transforms coordinates between WGS84 (lon/lat) and a BIM viewer's
 * internal coordinate system.
 */
export class CoordinateTransformer {
    constructor(config: CoordinateTransformerConfig);
    /** Create from an Autodesk APS Viewer instance */
    static fromAPSViewer(viewer: any, crs: string): CoordinateTransformer;
    /** Model bounding box in viewer coordinates */
    modelBBox: { min: ViewerCoords; max: ViewerCoords };
    /** Convert WGS84 to viewer coordinates */
    lonLatToViewer(lon: number, lat: number, z?: number): ViewerCoords;
    /** Convert viewer coordinates to WGS84 */
    viewerToLonLat(x: number, y: number, z?: number): LonLat;
    /** Get the model bounding box in WGS84 */
    getModelBoundsLL84(): GeoBounds;
}

/** Convert WGS84 lon/lat to Web Mercator tile coordinates */
export function lonLatToTile(lon: number, lat: number, zoom: number): TileCoords;

/** Convert Web Mercator tile coordinates to WGS84 (north-west corner of the tile) */
export function tileToLonLat(x: number, y: number, zoom: number): { lon: number; lat: number };

/** Calculate the geographic bounds visible in the camera's viewport */
export function getViewportBounds(
    camera: CameraState,
    transformer: { viewerToLonLat: (x: number, y: number) => { lon: number; lat: number } },
    options: ViewportOptions
): ViewportResult;

/** Create an LRU cache. Entries with a `canvas` property have it freed on eviction. */
export function createTileCache(maxSize?: number): {
    get(key: string): any;
    put(key: string, value: any): void;
    clear(): void;
    size(): number;
};
