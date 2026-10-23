/**
 * The look of a viewer — lights, materials, post-processing and background — as one
 * plain value (`Look`), applied to Mol* in one place and blended over time when it
 * changes, so switching a preset reads as a lighting change rather than a cut.
 *
 * Only numbers are blended. Effects that are switched rather than dialled (path
 * tracing, cel shading, materials, which live on the representations) flip once:
 * on at the start of a transition, off at its end, so nothing pops twice.
 */

import type { RendererProps } from 'molstar/lib/mol-gl/renderer';
import type { PostprocessingProps } from 'molstar/lib/mol-canvas3d/passes/postprocessing';
import type { Canvas3DProps } from 'molstar/lib/mol-canvas3d/canvas3d';
import { SsaoParams } from 'molstar/lib/mol-canvas3d/passes/ssao';
import { BackgroundParams } from 'molstar/lib/mol-canvas3d/passes/background';
import { IlluminationPass } from 'molstar/lib/mol-canvas3d/passes/illumination';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { Color } from 'molstar/lib/mol-util/color';
import { applyRepresentationLook } from './style';
import type { Backdrop, Viewer } from './viewer';
import type { Layer, LayerMaterial, Look, LookBackground, LookLight, LookPreset } from './types';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface LookDefinition {
    label: string;
    description: string;
    /** Relative GPU cost while interacting. */
    cost: 'low' | 'medium' | 'high';
    look: Look;
}

const DULL: LayerMaterial = { metalness: 0, roughness: 1, bumpiness: 0 };
const uniformMaterial = (m: LayerMaterial): Record<Layer, LayerMaterial> => ({ ribbon: { ...m }, atoms: { ...m }, surface: { ...m } });
const KEY = (intensity: number, color = 0xffffff, inclination = 150, azimuth = 320): LookLight => ({ inclination, azimuth, color, intensity });

export const APP_BACKGROUND = 0x0b0e14;

const BASE: Look = {
    ambient: 0.8,
    ambientColor: 0xffffff,
    lights: [KEY(0.4)],
    exposure: 1,
    occlusion: 0.8,
    occlusionReach: 32,
    occlusionMultiScale: false,
    shadows: 0,
    outline: 0,
    outlineColor: 0x000000,
    outlineThreshold: 0.33,
    fog: 15,
    dof: 0,
    dofRange: 20,
    bloom: 0,
    sharpen: 0,
    illumination: false,
    giBounces: 4,
    celShaded: false,
    material: uniformMaterial(DULL),
    background: { kind: 'solid', a: APP_BACKGROUND, b: APP_BACKGROUND },
};

const look = (patch: Partial<Look>): Look => ({ ...BASE, ...patch, material: patch.material ?? uniformMaterial(DULL) });

export const LOOK_PRESETS: Record<LookPreset, LookDefinition> = {
    soft: {
        label: 'Trabalho',
        description: 'Ambiente suave com oclusão e névoa leve no fundo escuro do app. Para analisar.',
        cost: 'medium',
        look: look({}),
    },
    'chimerax-soft': {
        label: 'ChimeraX soft',
        description: 'lighting soft + material dull + silhueta 2 px #303030, sem depth cue, fundo branco — o graphics_setup() do cdr_panels.py.',
        cost: 'medium',
        look: look({
            ambient: 0.85,
            lights: [KEY(0.3)],
            occlusion: 0.9,
            outline: 2,
            outlineColor: 0x303030,
            fog: 0,
            background: { kind: 'solid', a: 0xffffff, b: 0xffffff },
        }),
    },
    'white-figure': {
        label: 'Figura branca',
        description: 'Fundo branco, luz principal suave, contorno fino. Limpo para artigo.',
        cost: 'medium',
        look: look({
            ambient: 0.65,
            lights: [KEY(0.55), KEY(0.15, 0xe8eefc, 60, 140)],
            occlusion: 0.7,
            outline: 1,
            outlineColor: 0x1a1a1a,
            outlineThreshold: 0.25,
            fog: 0,
            material: uniformMaterial({ metalness: 0, roughness: 0.75, bumpiness: 0 }),
            background: { kind: 'solid', a: 0xffffff, b: 0xffffff },
        }),
    },
    illustrative: {
        label: 'Goodsell',
        description: 'Ilustrativo: cor chapada, oclusão em várias escalas e contorno forte, no papel creme.',
        cost: 'medium',
        look: look({
            ambient: 1,
            lights: [KEY(0.12)],
            exposure: 1.05,
            occlusion: 1.1,
            occlusionReach: 16,
            occlusionMultiScale: true,
            outline: 3,
            outlineColor: 0x000000,
            outlineThreshold: 0.2,
            fog: 0,
            background: { kind: 'solid', a: 0xf6f1e7, b: 0xf6f1e7 },
        }),
    },
    glossy: {
        label: 'Glossy',
        description: 'Brilho especular, luz de recorte e fundo radial escuro. Para capa.',
        cost: 'medium',
        look: look({
            ambient: 0.35,
            lights: [KEY(0.95, 0xffffff, 130, 300), KEY(0.35, 0xcfe0ff, 60, 120), KEY(0.45, 0xffffff, 20, 200)],
            occlusion: 0.6,
            occlusionReach: 16,
            fog: 0,
            material: {
                ribbon: { metalness: 0, roughness: 0.28, bumpiness: 0 },
                atoms: { metalness: 0, roughness: 0.2, bumpiness: 0 },
                surface: { metalness: 0, roughness: 0.35, bumpiness: 0 },
            },
            background: { kind: 'radial', a: 0x2a3550, b: 0x07090d },
        }),
    },
    clay: {
        label: 'Argila',
        description: 'Fosco, oclusão profunda e sombras, fundo cinza quente. Lê bem a forma.',
        cost: 'high',
        look: look({
            ambient: 0.9,
            ambientColor: 0xfff8f0,
            lights: [KEY(0.35, 0xfff4e8, 145, 330)],
            occlusion: 1.4,
            occlusionReach: 24,
            occlusionMultiScale: true,
            shadows: 6,
            fog: 0,
            background: { kind: 'solid', a: 0xe9e6e1, b: 0xe9e6e1 },
        }),
    },
    'poster-dark': {
        label: 'Pôster escuro',
        description: 'Gradiente escuro, recorte azulado, brilho e névoa. Para pôster e slide.',
        cost: 'high',
        look: look({
            ambient: 0.45,
            lights: [KEY(0.8, 0xfff1e0, 140, 310), KEY(0.5, 0x7fb4ff, 30, 140)],
            occlusion: 0.9,
            outline: 1,
            outlineThreshold: 0.25,
            fog: 30,
            bloom: 0.5,
            material: uniformMaterial({ metalness: 0, roughness: 0.55, bumpiness: 0 }),
            background: { kind: 'radial', a: 0x1b2233, b: 0x05070b },
        }),
    },
    cinematic: {
        label: 'Cinema',
        description: 'Sombras, névoa e profundidade de campo. Para vídeo.',
        cost: 'high',
        look: look({
            ambient: 0.5,
            lights: [KEY(0.75, 0xfff4e6, 140, 310)],
            occlusion: 0.9,
            shadows: 4,
            outline: 1,
            outlineThreshold: 0.25,
            fog: 40,
            dof: 9,
            dofRange: 24,
            background: { kind: 'vertical', a: 0x1d2636, b: 0x07090d },
        }),
    },
    flat: {
        label: 'Chapado',
        description: 'Sem luz direcional nem oclusão, só contorno. O mais leve.',
        cost: 'low',
        look: look({ ambient: 1, lights: [], occlusion: 0, outline: 1, fog: 0 }),
    },
    raytraced: {
        label: 'Ray tracing',
        description: 'Iluminação global por traçado de raios (progressiva: refina com a câmera parada).',
        cost: 'high',
        look: look({
            ambient: 0.6,
            lights: [KEY(0.6)],
            occlusion: 0,
            illumination: true,
            giBounces: 4,
            fog: 0,
            background: { kind: 'solid', a: 0xffffff, b: 0xffffff },
        }),
    },
};

export const DEFAULT_LOOK: LookPreset = 'soft';

export function cloneLook(l: Look): Look {
    return {
        ...l,
        lights: l.lights.map((x) => ({ ...x })),
        material: { ribbon: { ...l.material.ribbon }, atoms: { ...l.material.atoms }, surface: { ...l.material.surface } },
        background: { ...l.background },
    };
}

export function presetLook(preset: LookPreset): Look {
    return cloneLook(LOOK_PRESETS[preset].look);
}

/** Path tracing needs float colour buffers and depth textures; most desktop GPUs have them. */
export function illuminationSupported(viewer: Viewer): boolean {
    const webgl = viewer.canvas3d?.webgl;
    return Boolean(webgl && IlluminationPass.isSupported(webgl));
}

// ---------------------------------------------------------------------------
// Look → Mol* props
// ---------------------------------------------------------------------------

const SSAO_DEFAULTS = PD.getDefaultValues(SsaoParams);
const BACKGROUND_DEFAULTS = PD.getDefaultValues(BackgroundParams);
const OFF = { name: 'off' as const, params: {} };

/** The colour the renderer clears to — what shows behind a gradient's edges and in a cropped export. */
export function backgroundBase(b: LookBackground): number {
    return b.kind === 'solid' || b.kind === 'transparent' ? b.a : mixColor(b.a, b.b, 0.5);
}

const css = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Gradients are drawn by the page behind a transparent canvas, not by Mol*'s
 * background pass: on ANGLE/EGL with NVIDIA PRIME offload that pass covered the frame
 * in black and drew its gradient in a single stray triangle (docs/STATUS.md). The CSS
 * version costs no GPU time and depth fog fades into it naturally.
 */
export function backdropFor(b: LookBackground): Backdrop {
    switch (b.kind) {
        case 'solid':
            return { kind: 'none' };
        case 'transparent':
            return { kind: 'checker' };
        case 'vertical':
            return { kind: 'css', css: `linear-gradient(180deg, ${css(b.a)} 0%, ${css(b.b)} 100%)` };
        case 'radial':
            return { kind: 'css', css: `radial-gradient(ellipse at 50% 50%, ${css(b.a)} 0%, ${css(b.b)} 100%)` };
    }
}

/** Paints the look's gradient onto a 2D context — the export counterpart of backdropFor. */
export function paintGradient(g: CanvasRenderingContext2D, b: LookBackground, width: number, height: number): boolean {
    if (b.kind !== 'vertical' && b.kind !== 'radial') return false;
    const grad =
        b.kind === 'vertical'
            ? g.createLinearGradient(0, 0, 0, height)
            : g.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
    grad.addColorStop(0, css(b.a));
    grad.addColorStop(1, css(b.b));
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
    return true;
}

function canvasProps(l: Look): Partial<Canvas3DProps> {
    const renderer: Partial<RendererProps> = {
        ambientIntensity: l.ambient,
        ambientColor: Color(l.ambientColor),
        light: l.lights.map((x) => ({ inclination: x.inclination, azimuth: x.azimuth, color: Color(x.color), intensity: x.intensity })),
        exposure: l.exposure,
        backgroundColor: Color(backgroundBase(l.background)),
    };
    // Mapped params are replaced whole on update, so every block starts from Mol*'s defaults.
    const occlusion =
        l.occlusion > 0.005
            ? {
                  name: 'on' as const,
                  params: {
                      ...SSAO_DEFAULTS,
                      samples: 32,
                      blurKernelSize: 15,
                      resolutionScale: 1,
                      bias: l.occlusion,
                      radius: Math.log2(Math.max(1, l.occlusionReach)),
                      multiScale: l.occlusionMultiScale
                          ? {
                                name: 'on' as const,
                                params: {
                                    levels: [0.25, 0.5, 1].map((f) => ({ radius: Math.log2(Math.max(1, l.occlusionReach * f)), bias: 1 })),
                                    nearThreshold: 10,
                                    farThreshold: 1500,
                                },
                            }
                          : OFF,
                  },
              }
            : OFF;
    const bg = l.background;
    const variant = OFF;
    const postprocessing: Partial<PostprocessingProps> = {
        occlusion,
        shadow: l.shadows > 0.05 ? { name: 'on', params: { steps: 2, maxDistance: l.shadows, tolerance: 1 } } : OFF,
        outline:
            l.outline >= 0.5
                ? { name: 'on', params: { scale: Math.round(l.outline), threshold: l.outlineThreshold, color: Color(l.outlineColor), includeTransparent: true } }
                : OFF,
        dof:
            l.dof >= 1
                ? { name: 'on', params: { blurSize: Math.round(l.dof), blurSpread: 1, inFocus: 0, PPM: l.dofRange, center: 'camera-target', mode: 'plane' } }
                : OFF,
        // Mol*'s default keeps an emissive bloom pass on; off unless asked for saves a pass per frame.
        bloom: l.bloom > 0.01 ? { name: 'on', params: { strength: l.bloom, radius: 0.5, threshold: 0.75, mode: 'luminosity', transparency: true } } : OFF,
        sharpening: l.sharpen > 0.01 ? { name: 'on', params: { sharpness: l.sharpen, denoise: true } } : OFF,
        background: { ...BACKGROUND_DEFAULTS, variant } as PostprocessingProps['background'],
    };
    return {
        renderer: renderer as RendererProps,
        postprocessing: postprocessing as PostprocessingProps,
        cameraFog: l.fog >= 1 ? { name: 'on', params: { intensity: l.fog } } : OFF,
        transparentBackground: bg.kind !== 'solid',
        illumination: {
            enabled: l.illumination,
            bounces: l.giBounces,
            shadowEnable: true,
        } as Canvas3DProps['illumination'],
    };
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend in linear light: sRGB midpoints of dark→white transitions otherwise look muddy. */
export function mixColor(a: number, b: number, t: number): number {
    const toLin = (c: number) => Math.pow(c / 255, 2.2);
    const toSrgb = (c: number) => Math.round(Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2) * 255);
    let out = 0;
    for (const shift of [16, 8, 0]) out |= toSrgb(lerp(toLin((a >> shift) & 0xff), toLin((b >> shift) & 0xff), t)) << shift;
    return out;
}

function mixLights(a: LookLight[], b: LookLight[], t: number): LookLight[] {
    const n = Math.max(a.length, b.length);
    const out: LookLight[] = [];
    for (let i = 0; i < n; i++) {
        // A light that only exists on one side fades in or out where it stands.
        const x = a[i] ?? { ...b[i]!, intensity: 0 };
        const y = b[i] ?? { ...a[i]!, intensity: 0 };
        let dAz = y.azimuth - x.azimuth;
        if (dAz > 180) dAz -= 360;
        if (dAz < -180) dAz += 360;
        out.push({
            inclination: lerp(x.inclination, y.inclination, t),
            azimuth: (x.azimuth + dAz * t + 360) % 360,
            color: mixColor(x.color, y.color, t),
            intensity: lerp(x.intensity, y.intensity, t),
        });
    }
    return t >= 1 ? out.slice(0, b.length) : out;
}

function mixBackground(a: LookBackground, b: LookBackground, t: number): LookBackground {
    if (t >= 1) return { ...b };
    // A solid colour is a gradient with equal stops, so solid ↔ gradient blends smoothly.
    const asGradient = (x: LookBackground): LookBackground => (x.kind === 'solid' || x.kind === 'transparent' ? { kind: x.kind, a: x.a, b: x.a } : x);
    const x = asGradient(a);
    const y = asGradient(b);
    const gradient = (k: LookBackground['kind']) => k === 'vertical' || k === 'radial';
    const kind = a.kind === b.kind ? a.kind : gradient(b.kind) ? b.kind : gradient(a.kind) ? a.kind : t < 0.5 ? a.kind : b.kind;
    return { kind, a: mixColor(x.a, y.a, t), b: mixColor(x.b, y.b, t) };
}

export function mixLook(a: Look, b: Look, t: number): Look {
    if (t >= 1) return cloneLook(b);
    const n = (k: keyof Look) => lerp(a[k] as number, b[k] as number, t);
    return {
        ambient: n('ambient'),
        ambientColor: mixColor(a.ambientColor, b.ambientColor, t),
        lights: mixLights(a.lights, b.lights, t),
        exposure: n('exposure'),
        occlusion: n('occlusion'),
        // Reach only matters while occlusion is visible: jump it where occlusion fades in from 0.
        occlusionReach: a.occlusion <= 0.005 ? b.occlusionReach : b.occlusion <= 0.005 ? a.occlusionReach : n('occlusionReach'),
        occlusionMultiScale: a.occlusionMultiScale || b.occlusionMultiScale ? (t < 0.5 ? a.occlusionMultiScale : b.occlusionMultiScale) : false,
        shadows: n('shadows'),
        outline: n('outline'),
        outlineColor: a.outline < 0.5 ? b.outlineColor : b.outline < 0.5 ? a.outlineColor : mixColor(a.outlineColor, b.outlineColor, t),
        outlineThreshold: n('outlineThreshold'),
        fog: n('fog'),
        dof: n('dof'),
        dofRange: n('dofRange'),
        bloom: n('bloom'),
        sharpen: n('sharpen'),
        // Switched effects: on from the first frame, off only once the blend is done.
        illumination: b.illumination ? true : a.illumination,
        giBounces: b.giBounces,
        celShaded: b.celShaded,
        material: b.material,
        background: mixBackground(a.background, b.background, t),
    };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const tweens = new WeakMap<Viewer, number>();

/**
 * Sends only the parts of the props that actually changed since the last frame.
 *
 * Canvas3D reacts per block: handing it the whole props object every frame makes it
 * re-evaluate passes that did not move (illumination, background, the renderer's
 * light list) and allocate new param objects 60 times a second. During a blend the
 * only things changing are a handful of numbers.
 */
function changedProps(previous: Record<string, unknown> | null, next: Record<string, unknown>): Partial<Canvas3DProps> {
    if (!previous) return next as Partial<Canvas3DProps>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
        if (JSON.stringify(previous[key]) !== JSON.stringify(value)) out[key] = value;
    }
    return out as Partial<Canvas3DProps>;
}

function prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The look currently applied (a copy). */
export function getLook(viewer: Viewer): Look {
    return cloneLook(viewer.look ?? LOOK_PRESETS[DEFAULT_LOOK].look);
}

function materialsDiffer(a: Look | null, b: Look): boolean {
    if (!a) return true;
    if (a.celShaded !== b.celShaded) return true;
    return (['ribbon', 'atoms', 'surface'] as Layer[]).some((k) => {
        const x = a.material[k];
        const y = b.material[k];
        return x.metalness !== y.metalness || x.roughness !== y.roughness || x.bumpiness !== y.bumpiness;
    });
}

/**
 * Applies a look, blending from the current one over `durationMs`. A later call
 * cancels a blend in flight and starts from wherever it had got to, so dragging a
 * slider or clicking presets in quick succession never jumps.
 */
export function applyLook(viewer: Viewer, target: Look, durationMs = 450): Promise<void> {
    const canvas = viewer.canvas3d;
    if (!canvas) return Promise.resolve();
    const from = viewer.look ? cloneLook(viewer.look) : null;
    const to = cloneLook(target);
    // The illumination pass is unsupported on some GPUs; never ask Mol* for it there.
    if (to.illumination && !illuminationSupported(viewer)) to.illumination = false;

    const previous = tweens.get(viewer);
    if (previous) cancelAnimationFrame(previous);
    tweens.delete(viewer);

    const materials = materialsDiffer(from, to);
    viewer.look = to;
    // Materials live on the representations: one state update, at the start.
    const representations = materials ? applyRepresentationLook(viewer) : Promise.resolve();

    if (!from || durationMs <= 0 || prefersReducedMotion()) {
        canvas.setProps(canvasProps(to));
        viewer.setBackdrop(backdropFor(to.background));
        return representations;
    }
    return new Promise((resolve) => {
        const start = performance.now();
        let previous: Record<string, unknown> | null = null;
        // When a frame costs more than this, the blend drops to half rate: on a heavy
        // scene a smooth 30 fps beats a stuttering 60.
        let minInterval = 0;
        let lastFrame = 0;
        const frame = (now: number) => {
            const t = Math.min(1, (now - start) / durationMs);
            if (t < 1 && now - lastFrame < minInterval) {
                tweens.set(viewer, requestAnimationFrame(frame));
                return;
            }
            lastFrame = now;
            const mixed = mixLook(from, to, easeInOut(t));
            const props = canvasProps(mixed) as Record<string, unknown>;
            const t0 = performance.now();
            canvas.setProps(changedProps(previous, props));
            const cost = performance.now() - t0;
            minInterval = cost > 12 ? 32 : 0;
            previous = props;
            viewer.setBackdrop(backdropFor(mixed.background));
            if (t < 1) tweens.set(viewer, requestAnimationFrame(frame));
            else {
                tweens.delete(viewer);
                void representations.then(resolve);
            }
        };
        tweens.set(viewer, requestAnimationFrame(frame));
    });
}

/** Changes part of the current look. Slider drags call it per input event: no blend there. */
export function tuneLook(viewer: Viewer, patch: Partial<Look>, durationMs = 0): Promise<void> {
    return applyLook(viewer, { ...getLook(viewer), ...patch }, durationMs);
}

export function applyLookPreset(viewer: Viewer, preset: LookPreset, durationMs = 450): Promise<void> {
    return applyLook(viewer, presetLook(preset), durationMs);
}
