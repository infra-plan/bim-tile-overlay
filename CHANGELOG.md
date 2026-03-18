# Changelog

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
