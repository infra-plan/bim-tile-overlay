# bim-tile-overlay

Overlay web map tiles (OSM, aerial imagery, custom XYZ) onto an **Autodesk APS Viewer** as a camera-synced 3D ground plane.

[![Infra Plan](assets/logo.png)](https://infraplan.hr)

**By [Infra Plan](https://infraplan.hr)**

![Demo](assets/demo.gif)

## The Problem

Placing geographic map tiles under a BIM model in Autodesk Viewer requires:

1. Working out which part of the ground the camera can see
2. Converting between the viewer's internal coordinate system and WGS84
3. Choosing map tiles with detail that fits the distance: sharp near the camera, coarser far away
4. Fetching and caching those tiles, and positioning each one in 3D space
5. Updating everything in real-time as the camera moves, without the ground flickering

This library handles all of that.

## Quick Start

```bash
npm install bim-tile-overlay proj4
```

```javascript
import { TileOverlay, CoordinateTransformer } from 'bim-tile-overlay';

// After viewer has loaded a model:
const transformer = CoordinateTransformer.fromAPSViewer(
    viewer,
    // proj4 definition for your local CRS (this example uses Croatia HTRS96/TM)
    '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
);

const overlay = new TileOverlay(viewer, transformer, {
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    zoomRange: [14, 19],
    maxBounds: transformer.getModelBoundsLL84(),
});

await overlay.enable();
```

## How It Works

```
Start from the whole world (zoom 0)
  → Skip tiles outside maxBounds or outside the camera's view
  → Split a tile into its 4 children while it would appear
    larger than 256 px on screen (at its closest visible point)
  → Fetch the chosen XYZ tiles in parallel (reusing cached tiles)
  → Show each tile as its own THREE.js plane in viewer space
  → Update on camera change (debounced)
```

Detail depends on distance, so a camera close to the ground looking toward the
horizon gets sharp ground nearby and coarser tiles in the distance.

While new tiles load, the tiles already on screen stay as fallbacks: after
zooming in, the coarser tile stays underneath until its children arrive; after
zooming out, the finer tiles stay until their parent arrives.

**Coordinate pipeline:**
```
WGS84 (lon, lat)
  ↔ Local CRS (meters) → via proj4
  ↔ CRS in feet → × 3.28084
  ↔ BIM internal coords → via refPointTransform rotation + translation
  ↔ Viewer display coords → minus globalOffset
```

## API Reference

### `TileOverlay`

Main class. Creates a map tile overlay on the viewer.

```javascript
const overlay = new TileOverlay(viewer, transformer, options);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `urlTemplate` | `string` | *required* | Tile URL with `{z}`, `{x}`, `{y}` placeholders |
| `zoomRange` | `[number, number]` | *required* | Min and max zoom levels |
| `maxBounds` | `GeoBounds` | *required* | Geographic bounds to clip tile fetching |
| `groundZ` | `number` | `modelBBox.min.z - 5` | Z elevation of the ground plane |
| `debounceMs` | `number` | `150` | Camera change debounce delay (ms) |
| `detailScale` | `number` | `1` | Tile detail vs. distance. Tiles are refined until they appear at most 256 / `detailScale` px on screen, so `2` gives finer tiles |
| `maxTiles` | `number` | `500` | Max tiles shown at once. When reached, distant ground stays coarser |
| `maxCachedTiles` | `number` | `1024` | Max loaded tile images kept in memory, so tiles coming back into view appear without downloading again |
| `onTileError` | `function` | `console.warn` | Called with `{ url, x, y, zoom }` when a tile fails to load |
| `sceneName` | `string` | `'bim-tile-overlay'` | Viewer overlay scene name |
| `zoomScaleFactor` | `number` | — | *Deprecated, ignored.* Use `detailScale` |
| `progressInterval` | `number` | — | *Deprecated, ignored.* Tiles appear individually as they load |
| `maxCacheSize` | `number` | — | *Deprecated, ignored.* Use `maxCachedTiles` |

**Methods:**

| Method | Description |
|--------|-------------|
| `enable()` | Show the overlay and start tracking the camera; resolves once the visible tiles have loaded |
| `disable()` | Remove the tiles and cancel pending downloads; the tile cache is kept, so re-enabling is instant |
| `destroy()` | Fully dispose all GPU resources and cache |
| `update()` | Update the tiles for the current camera now; resolves once they have loaded |

### `CoordinateTransformer`

Converts between WGS84 and the viewer's coordinate system.

```javascript
// From viewer (recommended):
const transformer = CoordinateTransformer.fromAPSViewer(viewer, crsDefinition);

// Manual config:
const transformer = new CoordinateTransformer({
    crs: '+proj=tmerc +lat_0=0 +lon_0=16.5 ...',
    refPointTransform: [...],  // From model metadata
    globalOffset: { x, y, z },
    modelBBox: { min: { x, y, z }, max: { x, y, z } },
});
```

**Methods:**

| Method | Description |
|--------|-------------|
| `lonLatToViewer(lon, lat, z?)` | WGS84 → viewer coordinates |
| `viewerToLonLat(x, y, z?)` | Viewer coordinates → WGS84 |
| `getModelBoundsLL84()` | Model bounding box in WGS84 |

### Utility Functions

```javascript
import { lonLatToTile, tileToLonLat, getViewportBounds, createTileCache } from 'bim-tile-overlay';
```

| Function | Description |
|----------|-------------|
| `lonLatToTile(lon, lat, zoom)` | WGS84 → tile {x, y} coordinates |
| `tileToLonLat(x, y, zoom)` | Tile coordinates → WGS84 (NW corner) |
| `getViewportBounds(camera, transformer, options)` | Camera frustum → geographic bounds + zoom |
| `createTileCache(maxSize?)` | LRU cache; frees an entry's `canvas` memory on eviction |

## Finding Your CRS

Your BIM model needs a local Coordinate Reference System (CRS) for accurate positioning. Common ones:

| Region | CRS | Code |
|--------|-----|------|
| Croatia | HTRS96/TM | EPSG:3765 |
| UK | British National Grid | EPSG:27700 |
| Germany | ETRS89/UTM zone 32N | EPSG:25832 |
| US (New York) | NAD83/NY Long Island | EPSG:2263 |

Find your CRS definition at [epsg.io](https://epsg.io/) and pass the proj4 string.

## Requirements

- **Autodesk Viewer** (APS / Forge) with a loaded, georeferenced model — the Viewer script provides `THREE.js` and `Autodesk` globals that this library uses internally; you do not need to install them separately
- **proj4** (peer dependency) — `npm install proj4`
- The BIM model must have `refPointTransform` in its metadata (set via Revit's survey/project point)

## Contributing

Contributions are welcome! Please open an issue or pull request.

## License

MIT - [Infra Plan](https://infraplan.hr)
