/**
 * Convert WGS84 longitude/latitude to Web Mercator tile coordinates.
 *
 * @param {number} lon - Longitude in degrees
 * @param {number} lat - Latitude in degrees
 * @param {number} zoom - Zoom level
 * @returns {{ x: number, y: number }} Tile coordinates
 */
export function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(
        ((1 -
            Math.log(
                Math.tan((lat * Math.PI) / 180) +
                    1 / Math.cos((lat * Math.PI) / 180)
            ) /
                Math.PI) /
            2) *
            n
    );
    return { x, y };
}

/**
 * Convert Web Mercator tile coordinates to WGS84 longitude/latitude.
 * Returns the north-west corner of the tile.
 *
 * @param {number} x - Tile x coordinate
 * @param {number} y - Tile y coordinate
 * @param {number} zoom - Zoom level
 * @returns {{ lon: number, lat: number }} Geographic coordinates
 */
export function tileToLonLat(x, y, zoom) {
    const n = Math.pow(2, zoom);
    const lon = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat = (latRad * 180) / Math.PI;
    return { lon, lat };
}
