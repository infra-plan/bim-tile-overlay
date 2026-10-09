import proj4 from 'proj4';

// Revit (and Autodesk Viewer) stores all coordinates in feet.
// Most geographic CRS projections use meters, so we convert between the two.
const FT_PER_M = 3.28084;

/**
 * Transforms coordinates between WGS84 (lon/lat) and a BIM viewer's
 * internal coordinate system, using a local CRS as an intermediate step.
 *
 * The pipeline is:
 *   WGS84 (lon, lat)
 *     ↔ Local CRS in meters (e.g., EPSG:3765)
 *     ↔ CRS in feet (Revit internal unit)
 *     ↔ BIM internal coordinates (via rotation matrix + translation)
 *     ↔ Display/viewer coordinates (minus globalOffset)
 */
export class CoordinateTransformer {
    /**
     * @param {Object} config
     * @param {string} config.crs - proj4 definition string for the local CRS
     *   (e.g., EPSG:3765 for Croatia HTRS96/TM). Must be a projected CRS in meters.
     * @param {number[]} config.refPointTransform - Column-major 4x3 transform matrix
     *   from the BIM model metadata. Elements [0],[1] encode cos/sin of rotation,
     *   elements [9],[10] encode the X/Y translation.
     * @param {{ x: number, y: number, z: number }} config.globalOffset - Viewer global offset
     * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} }} config.modelBBox - Model bounding box
     */
    constructor(config) {
        const { crs, refPointTransform, globalOffset, modelBBox } = config;

        // Per-instance WGS84 ↔ local CRS converter. Built from the definition
        // directly rather than registered globally with proj4.defs(), so several
        // transformers with different CRSs can coexist.
        // EPSG:4326 (WGS84) is the universal standard for lon/lat coordinates and
        // is always the input/output format; the local CRS is only used as an
        // intermediate projection for accurate meter-based math.
        this._converter = proj4('EPSG:4326', crs);

        this.globalOffset = globalOffset;
        this.modelBBox = modelBBox;

        // refPointTransform (column-major): CRS_feet = M * internal_feet + translation
        // M = [cos, -sin; sin, cos], translation = [rpt[9], rpt[10]]
        this.cosTheta = refPointTransform[0];
        this.sinTheta = refPointTransform[1];
        this.translationX = refPointTransform[9];
        this.translationY = refPointTransform[10];
    }

    /**
     * Create a CoordinateTransformer directly from an Autodesk APS Viewer instance.
     * Extracts the necessary metadata automatically.
     *
     * @param {Object} viewer - Autodesk Viewer instance
     * @param {string} crs - proj4 definition string for the local CRS
     * @returns {CoordinateTransformer}
     */
    static fromAPSViewer(viewer, crs) {
        const metadata = viewer.model.getData().metadata;
        const globalOffset = viewer.model.getData().globalOffset;
        const modelBBox = viewer.model.getBoundingBox();

        // refPointTransform is always at metadata['custom values'].refPointTransform
        // for georeferenced Revit models. If missing, the model either isn't from Revit
        // or doesn't have a survey/project base point set.
        const customValues = metadata?.['custom values'];
        if (!customValues?.refPointTransform) {
            throw new Error(
                "Model metadata missing required 'refPointTransform'. " +
                'Ensure the Revit model has a survey/project base point set. ' +
                "Check viewer.model.getData().metadata['custom values'] for available fields."
            );
        }
        const refPointTransform = customValues.refPointTransform;

        return new CoordinateTransformer({
            crs,
            refPointTransform,
            globalOffset,
            modelBBox,
        });
    }

    /**
     * Convert WGS84 longitude/latitude to viewer display coordinates.
     *
     * @param {number} lon - Longitude in degrees
     * @param {number} lat - Latitude in degrees
     * @param {number} [z=0] - Elevation in meters
     * @returns {{ x: number, y: number, z: number }} Viewer coordinates
     */
    lonLatToViewer(lon, lat, z = 0) {
        const projected = this._converter.forward([lon, lat]);
        const crsFtX = projected[0] * FT_PER_M;
        const crsFtY = projected[1] * FT_PER_M;

        // CRS_feet → internal: internal = M⁻¹ * (CRS_feet - translation)
        // M⁻¹ = [cos, sin; -sin, cos]
        const dx = crsFtX - this.translationX;
        const dy = crsFtY - this.translationY;
        const internalX = this.cosTheta * dx + this.sinTheta * dy;
        const internalY = -this.sinTheta * dx + this.cosTheta * dy;

        // internal → display
        return {
            x: internalX - this.globalOffset.x,
            y: internalY - this.globalOffset.y,
            z: z * FT_PER_M - this.globalOffset.z,
        };
    }

    /**
     * Convert viewer display coordinates to WGS84 longitude/latitude.
     *
     * @param {number} x - Viewer x coordinate
     * @param {number} y - Viewer y coordinate
     * @param {number} [z=0] - Viewer z coordinate (not used in lon/lat output)
     * @returns {{ lon: number, lat: number, z: number }} Geographic coordinates
     */
    viewerToLonLat(x, y, z = 0) {
        // display → internal
        const internalX = x + this.globalOffset.x;
        const internalY = y + this.globalOffset.y;

        // internal → CRS_feet: CRS = M * internal + translation
        // M = [cos, -sin; sin, cos]
        const crsFtX = this.cosTheta * internalX - this.sinTheta * internalY + this.translationX;
        const crsFtY = this.sinTheta * internalX + this.cosTheta * internalY + this.translationY;

        // CRS_feet → meters → WGS84
        const easting = crsFtX / FT_PER_M;
        const northing = crsFtY / FT_PER_M;

        // Convert back from local CRS to WGS84 (EPSG:4326)
        const lonLat = this._converter.inverse([easting, northing]);
        return { lon: lonLat[0], lat: lonLat[1], z };
    }

    /**
     * Get the model's bounding box in WGS84 coordinates.
     *
     * @returns {{ west: number, south: number, east: number, north: number }}
     */
    getModelBoundsLL84() {
        const min = this.modelBBox.min;
        const max = this.modelBBox.max;

        // All four corners are needed: when the model is rotated relative to
        // north, the min/max corners alone don't span the geographic extent.
        const corners = [
            this.viewerToLonLat(min.x, min.y),
            this.viewerToLonLat(max.x, min.y),
            this.viewerToLonLat(min.x, max.y),
            this.viewerToLonLat(max.x, max.y),
        ];
        const lons = corners.map((c) => c.lon);
        const lats = corners.map((c) => c.lat);

        return {
            west: Math.min(...lons),
            south: Math.min(...lats),
            east: Math.max(...lons),
            north: Math.max(...lats),
        };
    }
}
