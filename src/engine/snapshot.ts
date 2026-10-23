/**
 * Image and movie export through Mol*'s off-screen ImagePass (16× multisampling, full
 * post-processing) — unlike canvas.toDataURL, which is capped at screen resolution.
 *
 * Two things make an export look like the screen rather than a different picture:
 * - Silhouettes are a width in pixels. Rendered at 4× the viewport they would come out
 *   4× thinner, so the outline width is scaled by output/viewport ("igual à tela").
 * - Supersampling renders k× larger and downsamples, which smooths what multisampling
 *   cannot (outline aliasing, thin sticks), as ChimeraX's `supersample` does.
 */

import { Task } from 'molstar/lib/mol-task';
import type { PostprocessingProps } from 'molstar/lib/mol-canvas3d/passes/postprocessing';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { backgroundBase, paintGradient } from './look';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type Result } from './types';

export interface ImageRequest {
    /** Output width in pixels (of the full frame, before cropping); height follows the viewport. */
    width: number;
    transparent: boolean;
    /** Crop to the molecule's bounds (with a 10% margin) instead of the full viewport. */
    cropToMolecule: boolean;
    /** Render k× larger and downsample; 1 = off. */
    supersample?: number;
    /** Scale silhouette width with the output size so the figure matches the screen. */
    matchScreen?: boolean;
}

/** Pixel size of the visible viewport, for 1×/2×/4× choices. */
export function viewportSize(viewer: Viewer): { width: number; height: number } | null {
    const canvas = viewer.canvas3d;
    if (!canvas) return null;
    const { width, height } = canvas.webgl.gl.canvas as HTMLCanvasElement;
    return { width, height };
}

/** Pixels needed for a figure `mm` wide at `dpi`. */
export function pixelsForPrint(mm: number, dpi = 300): number {
    return Math.round((mm / 25.4) * dpi);
}

/** The largest image this GPU can render off-screen. */
export function maxImageSize(viewer: Viewer): number {
    const webgl = viewer.canvas3d?.webgl;
    return webgl ? Math.floor(Math.min(webgl.maxRenderbufferSize, webgl.maxTextureSize) / 2) : 4096;
}

interface RawRequest {
    width: number;
    height: number;
    /** Multiplier for pixel-sized effects (outline). */
    effectScale: number;
}

/**
 * One off-screen render to pixels, always on a transparent background: the figure's
 * background (solid or gradient) is laid under it in 2D afterwards, and the alpha
 * channel is what cropping to the molecule measures. Mol*'s own autocrop relies on a
 * preview render this path never makes, so it silently left the full frame.
 *
 * The on-screen loop is paused meanwhile: it would compete for the GPU and, with
 * temporal multisampling, restart its accumulation.
 */
async function renderRaw(viewer: Viewer, request: RawRequest): Promise<ImageData> {
    const plugin = viewer.plugin;
    const helper = plugin.helpers.viewportScreenshot;
    const canvas = viewer.canvas3d;
    if (!helper || !canvas) throw new Error('O visualizador ainda não está pronto.');
    helper.behaviors.values.next({
        ...helper.values,
        resolution: { name: 'custom', params: { width: request.width, height: request.height } },
        transparent: true,
        format: { name: 'png', params: {} },
        axes: { name: 'off', params: {} },
    });
    helper.resetCrop();
    const { width, height, viewport } = helper.getSizeAndViewport();

    plugin.animationLoop.stop({ noDraw: true });
    try {
        // The getter refreshes the pass from the canvas props (and raises AO samples).
        const pass = helper.imagePass;
        const outline = pass.props.postprocessing.outline;
        if (outline.name === 'on' && request.effectScale !== 1) {
            const postprocessing = {
                ...pass.props.postprocessing,
                outline: { name: 'on' as const, params: { ...(outline.params as { scale: number; threshold: number; color: never; includeTransparent: boolean }), scale: Math.max(1, Math.round(outline.params.scale * request.effectScale)) } },
            } as unknown as PostprocessingProps;
            pass.setProps({ postprocessing });
        }
        await pass.updateBackground();
        return await plugin.runTask(Task.create('Imagem', (ctx) => pass.getImageData(ctx, width, height, viewport)));
    } finally {
        plugin.animationLoop.start({ immediate: true });
    }
}

/** Box-filter downsampling in halving steps: one big drawImage step aliases. */
function downsample(image: ImageData, factor: number): HTMLCanvasElement {
    let source = document.createElement('canvas');
    source.width = image.width;
    source.height = image.height;
    source.getContext('2d')!.putImageData(image, 0, 0);
    let w = image.width;
    let h = image.height;
    const targetW = Math.max(1, Math.round(image.width / factor));
    const targetH = Math.max(1, Math.round(image.height / factor));
    while (w > targetW || h > targetH) {
        const nw = Math.max(targetW, Math.floor(w / 2));
        const nh = Math.max(targetH, Math.floor(h / 2));
        const next = document.createElement('canvas');
        next.width = nw;
        next.height = nh;
        const g = next.getContext('2d')!;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(source, 0, 0, w, h, 0, 0, nw, nh);
        source = next;
        w = nw;
        h = nh;
    }
    return source;
}

function toCanvas(image: ImageData): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    c.getContext('2d')!.putImageData(image, 0, 0);
    return c;
}

/** Bounding box of pixels with any coverage, grown by `margin` × the larger side. */
function contentBox(c: HTMLCanvasElement, margin: number): { x: number; y: number; w: number; h: number } | null {
    const { width, height } = c;
    const data = c.getContext('2d')!.getImageData(0, 0, width, height).data;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            if (data[row + x * 4 + 3]! > 4) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < 0) return null;
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * margin);
    const x = Math.max(0, x0 - pad);
    const yy = Math.max(0, y0 - pad);
    return { x, y: yy, w: Math.min(width, x1 + pad + 1) - x, h: Math.min(height, y1 + pad + 1) - yy };
}

/**
 * Lays the figure's background under a transparent render and optionally crops it.
 * The gradient spans the full frame before cropping, as it does on screen.
 */
function finish(viewer: Viewer, scene: HTMLCanvasElement, options: { transparent: boolean; crop: boolean }): HTMLCanvasElement {
    const box = options.crop ? contentBox(scene, 0.05) : null;
    const full = document.createElement('canvas');
    full.width = scene.width;
    full.height = scene.height;
    const g = full.getContext('2d')!;
    const bg = viewer.look?.background;
    if (!options.transparent && bg && bg.kind !== 'transparent') {
        if (!paintGradient(g, bg, full.width, full.height)) {
            g.fillStyle = `#${backgroundBase(bg).toString(16).padStart(6, '0')}`;
            g.fillRect(0, 0, full.width, full.height);
        }
    }
    g.drawImage(scene, 0, 0);
    if (!box) return full;
    const out = document.createElement('canvas');
    out.width = box.w;
    out.height = box.h;
    out.getContext('2d')!.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return out;
}

function sizes(viewer: Viewer, width: number, supersample: number) {
    const viewport = viewportSize(viewer)!;
    const max = maxImageSize(viewer);
    const outW = Math.min(max, Math.max(64, Math.round(width)));
    const outH = Math.min(max, Math.max(64, Math.round((outW * viewport.height) / viewport.width)));
    // Supersampling is limited by what the GPU can allocate.
    const k = Math.max(1, Math.min(supersample, Math.floor(max / Math.max(outW, outH))));
    return { viewport, outW, outH, k };
}

export async function renderImage(viewer: Viewer, request: ImageRequest): Promise<Result<{ dataUrl: string; width: number; height: number; supersample: number }>> {
    if (!viewer.plugin.helpers.viewportScreenshot || !viewportSize(viewer)) return err('O visualizador ainda não está pronto.');
    try {
        const { viewport, outW, outH, k } = sizes(viewer, request.width, request.supersample ?? 1);
        const effectScale = request.matchScreen === false ? k : ((outW * k) / viewport.width);
        const image = await renderRaw(viewer, { width: outW * k, height: outH * k, effectScale });
        const canvas = finish(viewer, k > 1 ? downsample(image, k) : toCanvas(image), { transparent: request.transparent, crop: request.cropToMolecule });
        return ok({ dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, supersample: k });
    } catch (e) {
        return err(`Falha ao gerar a imagem: ${errorMessage(e)}`);
    }
}

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

export interface MovieRequest {
    width: number;
    /** Even, so H.264 accepts it; follows the viewport aspect when omitted. */
    height?: number;
    frames: number;
    motion: 'turntable' | 'rock';
    /** Screen axis the camera orbits around. */
    axis: 'vertical' | 'horizontal';
    /** Rock amplitude in degrees (turntable is always 360°). */
    amplitude: number;
    transparent: boolean;
    supersample: number;
}

export interface MovieFrame {
    index: number;
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
}

/**
 * Renders the frames of a turntable or rock and hands each to `sink` (which encodes
 * or writes it) before rendering the next, so memory stays at one frame. A turntable
 * ends one step short of 360° so the loop is seamless.
 */
export async function renderMovie(
    viewer: Viewer,
    request: MovieRequest,
    sink: (frame: MovieFrame) => Promise<void>,
    progress: (done: number, total: number) => void,
    canceled: () => boolean,
): Promise<Result<{ frames: number; width: number; height: number }>> {
    const canvas = viewer.canvas3d;
    if (!canvas || !viewer.plugin.helpers.viewportScreenshot) return err('O visualizador ainda não está pronto.');
    const camera = canvas.camera;
    const base = camera.getSnapshot();
    // Spin/rock animation would fight the scripted camera.
    const trackball = canvas.props.trackball.animate;
    canvas.setProps({ trackball: { animate: { name: 'off', params: {} } } });
    try {
        const { viewport, k } = sizes(viewer, request.width, request.supersample);
        const outW = Math.round(request.width / 2) * 2;
        const outH = request.height ? Math.round(request.height / 2) * 2 : Math.round((outW * viewport.height) / viewport.width / 2) * 2;
        const effectScale = (outW * k) / viewport.width;

        const dir = Vec3.sub(Vec3(), base.position, base.target);
        const up = Vec3.normalize(Vec3(), base.up);
        const right = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), up, dir));
        const axis = request.axis === 'vertical' ? up : right;

        for (let i = 0; i < request.frames; i++) {
            if (canceled()) return err('Cancelado.');
            const phase = i / request.frames;
            const degrees = request.motion === 'turntable' ? 360 * phase : request.amplitude * Math.sin(2 * Math.PI * phase);
            const rad = (degrees * Math.PI) / 180;
            const position = Vec3.add(Vec3(), base.target, rodrigues(dir, axis, rad));
            camera.setState({ ...base, position, up: rodrigues(up, axis, rad) }, 0);
            const image = await renderRaw(viewer, { width: outW * k, height: outH * k, effectScale });
            const c = finish(viewer, k > 1 ? downsample(image, k) : toCanvas(image), { transparent: request.transparent, crop: false });
            const rgba = c.getContext('2d')!.getImageData(0, 0, outW, outH).data;
            await sink({ index: i, width: outW, height: outH, rgba });
            progress(i + 1, request.frames);
        }
        return ok({ frames: request.frames, width: outW, height: outH });
    } catch (e) {
        return err(`Falha ao renderizar o vídeo: ${errorMessage(e)}`);
    } finally {
        camera.setState(base, 0);
        canvas.setProps({ trackball: { animate: trackball } });
        canvas.requestDraw();
    }
}

function rodrigues(v: Vec3, axis: Vec3, rad: number): Vec3 {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const k = Vec3.cross(Vec3(), axis, v);
    const d = Vec3.dot(axis, v) * (1 - c);
    return Vec3.create(v[0]! * c + k[0]! * s + axis[0]! * d, v[1]! * c + k[1]! * s + axis[1]! * d, v[2]! * c + k[2]! * s + axis[2]! * d);
}
