/**
 * Camera. Transitions are animated by Mol* inside its render loop.
 */

import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { displayedStructureRef } from './compare';
import type { Viewer } from './viewer';
import type { CameraProjection, StructureId } from './types';

const TRANSITION_MS = 450;
/** Eased moves: Mol*'s linear default starts and stops abruptly. */
const EASED = { easing: 'cubic-in-out' } as never;

function cameraIsFinite(viewer: Viewer): boolean {
    const s = viewer.canvas3d?.camera.state;
    return Boolean(s && [...s.position, ...s.target, ...s.up].every(Number.isFinite));
}

/**
 * Resets the camera to frame the scene.
 *
 * A structure's representation reaches the canvas a frame after its state commit.
 * Resetting before that frames an empty scene: the zero bounding radius makes Mol*
 * compute a NaN camera position, and every later reset inherits the NaN direction,
 * so the scene stays blank. Wait for content instead, and repair a poisoned camera.
 */
export function resetView(viewer: Viewer, durationMs = TRANSITION_MS): void {
    const canvas = viewer.canvas3d;
    if (!canvas) return;
    if (!cameraIsFinite(viewer)) {
        const target = canvas.boundingSphereVisible.center;
        const radius = Math.max(canvas.boundingSphereVisible.radius, 10);
        canvas.camera.setState({
            target: Vec3.clone(target),
            position: Vec3.add(Vec3(), target, Vec3.create(0, 0, radius * 3)),
            up: Vec3.create(0, 1, 0),
        }, 0);
    }
    let frames = 0;
    const attempt = () => {
        if (canvas.boundingSphereVisible.radius > 0 && canvas.reprCount.value > 0) {
            canvas.requestCameraReset({ durationMs });
            return;
        }
        // Up to ~5 s for a large structure's geometry to arrive.
        if (frames++ < 300) requestAnimationFrame(attempt);
    };
    attempt();
}

/** Frames one structure (its displayed, possibly superposed, coordinates). */
export function focusStructure(viewer: Viewer, id: StructureId, durationMs = TRANSITION_MS): void {
    const entry = viewer.entry(id);
    if (!entry?.structure.cell?.obj) return;
    viewer.plugin.managers.camera.focusObject({
        targets: [{ targetRef: displayedStructureRef(viewer.plugin, entry) }],
        durationMs,
    });
}

export function setProjection(viewer: Viewer, mode: CameraProjection): void {
    viewer.canvas3d?.setProps({ camera: { mode } });
}

export function setSpin(viewer: Viewer, enabled: boolean, speed = 0.4): void {
    viewer.canvas3d?.setProps({
        trackball: { animate: enabled ? { name: 'spin', params: { speed } } : { name: 'off', params: {} } },
    });
}

export function setRock(viewer: Viewer, enabled: boolean, speed = 0.3, angle = 10): void {
    viewer.canvas3d?.setProps({
        trackball: { animate: enabled ? { name: 'rock', params: { speed, angle } } : { name: 'off', params: {} } },
    });
}

/**
 * Depth clipping as a slab around the camera target. Mol* 5.x has no independent
 * near/far planes: `radius` (0–99) is the percentage of the scene radius cut away.
 */
export function setClip(viewer: Viewer, amount: number, clipFar = true): void {
    viewer.clip = Math.max(0, Math.min(99, amount));
    viewer.canvas3d?.setProps({ cameraClipping: { radius: viewer.clip, far: clipFar } });
}

/**
 * Focusing must zoom, not cut.
 *
 * Mol*'s focus (an explore click, "focus selection", framing a structure) stores the
 * focused sphere's radius in the camera state, and the near/far planes are derived
 * from that radius: everything in front of a focused residue — and behind its 5 Å
 * neighbourhood — was clipped away. That was the "invisible wall" of explore mode,
 * undone only by a full view reset. Here the focus keeps its camera distance, but
 * the clipping radius stays the one the scene (or the user's depth cut) asks for.
 */
export function unclipFocus(viewer: Viewer): void {
    const camera = viewer.canvas3d?.camera;
    if (!camera) return;
    const clipRadius = () => {
        const scene = viewer.canvas3d?.boundingSphere.radius ?? 0;
        return scene > 0 ? (scene / 100) * (100 - viewer.clip) : 0;
    };
    type FocusFn = (...args: never[]) => { radius: number };
    const wrap = (name: 'getFocus' | 'getInvariantFocus' | 'getCenter') => {
        const original = (camera[name] as unknown as FocusFn).bind(camera);
        (camera as unknown as Record<string, FocusFn>)[name] = (...args: never[]) => {
            const state = original(...args);
            state.radius = Math.max(state.radius, clipRadius());
            return state;
        };
    };
    wrap('getFocus');
    wrap('getInvariantFocus');
    wrap('getCenter');
}

/** Puts the clipping radius back to the scene's — repairs a view clipped before this fix or by Mol* elsewhere. */
export function restoreClipRadius(viewer: Viewer): void {
    const canvas = viewer.canvas3d;
    if (!canvas) return;
    const scene = canvas.boundingSphere.radius;
    if (scene > 0) canvas.camera.setState({ radius: Math.max((scene / 100) * (100 - viewer.clip), 0.01) });
}

/** Canonical views: rotate the current camera about the target in 90° steps. */
export function rotateView(viewer: Viewer, axis: 'x' | 'y' | 'z', degrees: number): void {
    const camera = viewer.canvas3d?.camera;
    if (!camera) return;
    const snapshot = camera.getSnapshot();
    const { position, target, up } = snapshot;
    const dir = Vec3.sub(Vec3(), position, target);
    const right = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), up, dir));
    const forward = Vec3.normalize(Vec3(), dir);
    const ax = axis === 'x' ? right : axis === 'y' ? Vec3.normalize(Vec3(), up) : forward;
    const rad = (degrees * Math.PI) / 180;
    const rotate = (v: Vec3) => {
        // Rodrigues' rotation formula.
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cross = Vec3.cross(Vec3(), ax, v);
        const dot = Vec3.dot(ax, v);
        return Vec3.add(Vec3(), Vec3.add(Vec3(), Vec3.scale(Vec3(), v, cos), Vec3.scale(Vec3(), cross, sin)), Vec3.scale(Vec3(), ax, dot * (1 - cos)));
    };
    const newDir = rotate(dir);
    const newUp = rotate(up);
    viewer.plugin.managers.camera.setSnapshot(
        { ...snapshot, position: Vec3.add(Vec3(), target, newDir), up: newUp },
        TRANSITION_MS,
        EASED,
    );
}
