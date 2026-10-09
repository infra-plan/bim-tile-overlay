const DEFAULT_ZOOM_SCALE_FACTOR = 12;

/**
 * Calculate the geographic bounds visible in the camera's viewport by
 * ray-casting the four frustum corners onto a ground plane.
 *
 * @param {{ position: {x:number,y:number,z:number}, target: {x:number,y:number,z:number}, up?: {x:number,y:number,z:number}, fov: number, aspect: number }} camera
 *   Camera state. In Autodesk Viewer: `viewer.navigation.getCamera()` provides position/up/fov/aspect.
 *   `up` is the camera's screen-up direction; if omitted, world up (0, 0, 1) is used, and a
 *   camera looking straight down is treated as north-up.
 * @param {{ viewerToLonLat: (x:number, y:number) => {lon:number, lat:number} }} transformer
 *   Coordinate transformer with a `viewerToLonLat` method.
 * @param {Object} options
 * @param {[number, number]} options.zoomRange - Min and max zoom levels [minZoom, maxZoom]
 * @param {{ west: number, south: number, east: number, north: number }} options.maxBounds - Maximum geographic bounds to clip to
 * @param {number} options.groundZ - Z elevation of the ground plane in viewer coordinates
 * @param {number} [options.zoomScaleFactor=12] - Scaling factor that maps the visible longitude
 *   span to a tile zoom level. The formula is: `zoom = log2((360 / lonSpan) * zoomScaleFactor)`.
 *   Higher values produce higher zoom (more detailed tiles) for the same camera distance.
 *   The default (12) is tuned for typical BIM building-scale models.
 * @returns {{ bounds: {west:number,south:number,east:number,north:number}, zoom: number }}
 */
export function getViewportBounds(camera, transformer, options) {
    const { zoomRange, maxBounds, groundZ } = options;
    const zoomScaleFactor = options.zoomScaleFactor || DEFAULT_ZOOM_SCALE_FACTOR;
    const fov = camera.fov || 45;
    const aspect = camera.aspect || 1;

    // Build camera coordinate frame
    const fwdX = camera.target.x - camera.position.x;
    const fwdY = camera.target.y - camera.position.y;
    const fwdZ = camera.target.z - camera.position.z;
    const fwdLen = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
    const fx = fwdX / fwdLen;
    const fy = fwdY / fwdLen;
    const fz = fwdZ / fwdLen;

    // right = normalize(forward x up), using the camera's up vector if given,
    // otherwise world up (0, 0, 1)
    const up = camera.up || { x: 0, y: 0, z: 1 };
    let rx = fy * up.z - fz * up.y;
    let ry = fz * up.x - fx * up.z;
    let rz = fx * up.y - fy * up.x;
    let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-9) {
        // Forward is parallel to up (e.g. looking straight down with world up).
        // Fall back to north (0, 1, 0) as up, giving a north-up view.
        rx = fy * 0 - fz * 1;
        ry = fz * 0 - fx * 0;
        rz = fx * 1 - fy * 0;
        rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    }
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    // up = right x forward
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    // Half-angles for frustum
    const h = Math.tan((fov * Math.PI) / 360);
    const w = h * aspect;

    // 4 corner ray directions
    const corners = [
        { dx: -w, dy: -h }, // bottom-left
        { dx: w, dy: -h },  // bottom-right
        { dx: -w, dy: h },  // top-left
        { dx: w, dy: h },   // top-right
    ];

    const lonLats = [];
    let anyMissed = false;

    for (const c of corners) {
        const rayX = fx + c.dx * rx + c.dy * ux;
        const rayY = fy + c.dx * ry + c.dy * uy;
        const rayZ = fz + c.dx * rz + c.dy * uz;

        if (rayZ === 0) {
            anyMissed = true;
            continue;
        }
        const t = (groundZ - camera.position.z) / rayZ;
        if (t <= 0) {
            anyMissed = true;
            continue;
        }

        const hitX = camera.position.x + t * rayX;
        const hitY = camera.position.y + t * rayY;
        lonLats.push(transformer.viewerToLonLat(hitX, hitY));
    }

    if (lonLats.length < 2) {
        return { bounds: maxBounds, zoom: zoomRange[0] };
    }

    const lons = lonLats.map((ll) => ll.lon);
    const lats = lonLats.map((ll) => ll.lat);

    const viewBounds = {
        west: Math.min(...lons),
        east: Math.max(...lons),
        south: Math.min(...lats),
        north: Math.max(...lats),
    };

    // If any corner ray missed the ground, extend to maxBounds
    if (anyMissed) {
        viewBounds.west = Math.min(viewBounds.west, maxBounds.west);
        viewBounds.east = Math.max(viewBounds.east, maxBounds.east);
        viewBounds.south = Math.min(viewBounds.south, maxBounds.south);
        viewBounds.north = Math.max(viewBounds.north, maxBounds.north);
    }

    // Compute zoom from visible longitude span.
    // zoomScaleFactor controls tile detail: higher = more detailed tiles for the same view.
    const lonSpan = viewBounds.east - viewBounds.west;
    const computedZoom = Math.round(Math.log2((360 / lonSpan) * zoomScaleFactor));
    const zoom = Math.max(zoomRange[0], Math.min(zoomRange[1], computedZoom));

    // Clip bounds to maxBounds for tile fetching
    const bounds = {
        west: Math.max(viewBounds.west, maxBounds.west),
        south: Math.max(viewBounds.south, maxBounds.south),
        east: Math.min(viewBounds.east, maxBounds.east),
        north: Math.min(viewBounds.north, maxBounds.north),
    };

    return { bounds, zoom };
}
