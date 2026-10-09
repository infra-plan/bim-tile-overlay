# Changelog

## Unreleased

### Changes

- Tiles are now cached individually (LRU, keyed by URL) instead of caching whole stitched canvases keyed by exact view bounds. Panning only downloads the new tiles; cached tiles are drawn immediately. Only the stitched canvas on screen is kept, and it's freed when replaced (previously up to 6 canvases of up to 8192² each).
- New option `maxCachedTiles` (default 512). `maxCacheSize` is deprecated and ignored, with a console warning.
- `disable()` cancels pending tile downloads, and an update cancelled this way never applies its partial result.

### Fixes

- `getModelBoundsLL84()` now covers all four bounding-box corners, so bounds are correct for models rotated relative to north (previously zero-width at 45°)
- Camera looking straight down (top view) no longer collapses the visible area to a single point; `getViewportBounds` now accepts an optional `camera.up`, which `TileOverlay` passes from the viewer camera
- Camera changes during an in-flight tile update are no longer dropped; the update re-runs for the latest camera once the current one finishes
- `CoordinateTransformer` no longer registers its CRS globally with proj4, so multiple transformers with different CRSs don't overwrite each other
- Texture now refreshes after the final tile even when that tile fails to load

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
