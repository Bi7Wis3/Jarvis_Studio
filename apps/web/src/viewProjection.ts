// The view's projection. The app has one perspective camera; the flat view (no perspective, as SolidWorks draws by
// default) is that same camera with a parallel projection sized to what it showed at the point it turns about, so
// zooming, panning and turning go through the same controls. Rays and pixel sizes for both come from here.

import { MathUtils, Vector3, type Camera, type PerspectiveCamera, type Raycaster, type Vector2 } from 'three';

/** The height of the flat view in mm, or 0 while the camera draws with perspective. */
export const flatHeight = (camera: Camera): number => (camera.userData.flatHeight as number | undefined) ?? 0;

/** A ray through a screen point (in normalised device coordinates), for either projection. */
export function rayFromCamera(raycaster: Raycaster, ndc: Vector2, camera: Camera): void {
    if (!flatHeight(camera)) {
        raycaster.setFromCamera(ndc, camera);
        return;
    }
    // Parallel rays: from the front of the view volume, along the view direction.
    raycaster.ray.origin.set(ndc.x, ndc.y, -1).unproject(camera);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
    raycaster.camera = camera;
}

/** The size in mm of a screen pixel at a point of the model. */
export function pixelSizeAt(camera: PerspectiveCamera, point: Vector3, viewportHeight: number): number {
    const height = Math.max(1, viewportHeight);
    const flat = flatHeight(camera);
    return flat ? flat / height : (2 * camera.position.distanceTo(point) * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / height;
}

/** How far the flat view reaches in front of and behind the camera, so zooming in never cuts the model open. */
const FLAT_REACH = 20000;

/** Draws flat: a parallel projection as wide as the perspective view is at `distance`, the point the view turns about. */
export function drawFlat(camera: PerspectiveCamera, distance: number): void {
    const height = (2 * distance * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / camera.zoom;
    const width = height * camera.aspect;
    camera.userData.flatHeight = height;
    camera.projectionMatrix.makeOrthographic(-width / 2, width / 2, height / 2, -height / 2, -FLAT_REACH, FLAT_REACH);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** Back to the camera's own perspective projection. */
export function drawPerspective(camera: PerspectiveCamera): void {
    if (flatHeight(camera)) {
        camera.userData.flatHeight = 0;
        camera.updateProjectionMatrix();
    }
}

/** Where the view looks, for code outside the 3D view (Normal to). Kept current by the scene. */
export const liveView = { known: false, direction: new Vector3(0, 0, -1) };

/**
 * The view angles (degrees, as the standard views give them) that look straight at a plane with this world normal,
 * from the side it points to; when the view already looks straight at it, from the other side (Normal to a second
 * time turns the view 180 degrees).
 */
export function normalToAngles(normal: [number, number, number], view: { known: boolean; direction: Vector3 } = liveView): { azimuth: number; elevation: number } {
    const n = new Vector3(...normal).normalize();
    if (view.known && view.direction.dot(n) < -0.9993) {
        n.negate();
    }
    // Straight up or down has no azimuth; the top view stops just short of it too.
    const elevation = Math.max(-89, Math.min(89, MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, n.y))))));
    return { azimuth: Math.abs(n.y) > 0.9999 ? 0 : MathUtils.radToDeg(Math.atan2(n.x, n.z)), elevation };
}
