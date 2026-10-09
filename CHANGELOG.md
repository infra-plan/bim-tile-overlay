# Changelog

## Unreleased

### Changes

- **Detail by distance.** Instead of one stitched texture at a single zoom level (chosen from the width of the visible area), each tile is now its own plane and detail depends on its distance from the camera. A camera close to the ground looking toward the horizon now gets sharp ground nearby (previously the whole view dropped to a coarse zoom, e.g. 3.3 m/px instead of 0.05 m/px).
- **No flicker while loading.** Tiles already on screen stay as fallbacks until their replacements load: the coarser tile after zooming in, the finer tiles after zooming out. Tiles on screen keep their own image, so evicting them from the cache can't blank them.
- Tiles are cached individually (LRU, keyed by URL). Panning only downloads the new tiles, and returning to a previous view downloads nothing.
- Downloads for tiles that leave the view are cancelled; `disable()` cancels all pending downloads.
- New options: `detailScale` (default 1), `maxTiles` (default 500), `maxCachedTiles` (default 1024).
- Deprecated and ignored, with a console warning: `zoomScaleFactor` (use `detailScale`), `progressInterval`, `maxCacheSize` (use `maxCachedTiles`).
- `enable()` and `update()` resolve once the visible tiles have loaded or failed.

### Fixes

- `getModelBoundsLL84()` now covers all four bounding-box corners, so bounds are correct for models rotated relative to north (previously zero-width at 45°)
- Camera looking straight down (top view) no longer collapses the visible area to a single point; `getViewportBounds` now accepts an optional `camera.up`, which `TileOverlay` passes from the viewer camera
- `CoordinateTransformer` no longer registers its CRS globally with proj4, so multiple transformers with different CRSs don't overwrite each other
- `CoordinateTransformer.fromAPSViewer()` treats a missing model `globalOffset` as zero instead of failing on the first transform
- `exports` map simplified to `types` + `default` conditions

## 1.0.0 (2026-03-19)

Initial release.

### Features

- **TileOverlay** — camera-synced map tile overlay for Autodesk APS Viewer
  - Dynamic tile fetching based on camera frustum
  - Progressive rendering (configurable update interval)
  - LRU cache that frees bitmap memory on eviction
  - Debounced camera change handling
  - Enable/disable/destroy lifecycle
- **CoordinateTransformer** — WGS84 ↔ local CRS ↔ BIM coordinate pipeline
  - Supports any proj4-compatible CRS
  - Static factory `fromAPSViewer()` for automatic metadata extraction
  - Bidirectional transforms: `lonLatToViewer()` and `viewerToLonLat()`
  - Model bounding box in WGS84 via `getModelBoundsLL84()`
- **Utility functions** — `lonLatToTile`, `tileToLonLat`, `getViewportBounds`, `createTileCache`
- TypeScript definitions
- Full test suite (vitest)
