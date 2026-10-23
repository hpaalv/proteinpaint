/**
 * One Mol* viewer — a canvas plus everything loaded into it.
 *
 * Unlike the Helix singleton, the engine is an instance: the figure composer
 * (docs/PLAN.md, Fase 5) puts several viewers side by side, each with its own
 * structures, camera and lighting. Every engine module takes the Viewer it acts on.
 */

import { PluginSpec } from 'molstar/lib/mol-plugin/spec';
import { PluginBehaviors } from 'molstar/lib/mol-plugin/behavior';
import { Binding } from 'molstar/lib/mol-util/binding';
import { DefaultFocusLociBindings as CameraFocusBindings } from 'molstar/lib/mol-plugin/behavior/dynamic/camera';
import { StructureFocusRepresentation } from 'molstar/lib/mol-plugin/behavior/dynamic/selection/structure-focus-representation';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { PluginConfig } from 'molstar/lib/mol-plugin/config';
import { Color } from 'molstar/lib/mol-util/color';
import { PLDDTConfidenceColorThemeProvider } from 'molstar/lib/extensions/model-archive/quality-assessment/color/plddt';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import type { StructureElement } from 'molstar/lib/mol-model/structure';
import { DEFAULT_CHAIN_PALETTE, type ChainPaletteId } from '@/data/palettes';
import { registerThemes } from './themes';
import { unclipFocus } from './camera';
import { setDebugMode } from 'molstar/lib/mol-util/debug';
import { setSubtreeVisibility } from 'molstar/lib/mol-plugin/behavior/static/state';
import { ok, err, errorMessage, type Look, type ColorSettings, type MeasurementInfo, type ResidueDataset, type Result, type StructureId, type StructureInfo } from './types';

/**
 * One colour or transparency painted onto a set of atoms. Bundles are independent of
 * any Structure instance, so they survive components being rebuilt and superposition.
 */
export type PaintOp = (
    | { kind: 'color'; color: number | null; bundle: StructureElement.Bundle }
    | { kind: 'transparency'; value: number; bundle: StructureElement.Bundle }
    /** Glow: the atoms emit light, picked up by the bloom pass (look.ts). */
    | { kind: 'emissive'; value: number; bundle: StructureElement.Bundle }
    /** Many colours or values in one state update (distance fades, footprints). */
    | { kind: 'color-layers'; layers: { color: number; bundle: StructureElement.Bundle }[] }
    | { kind: 'transparency-layers'; layers: { value: number; bundle: StructureElement.Bundle }[] }
) & {
    /** Groups ops that can be removed together ('fade', 'footprint'); untagged = user paint. */
    tag?: string;
};

export interface StructureEntry {
    info: StructureInfo;
    trajectory: StateObjectSelector;
    model: StateObjectSelector;
    structure: StateObjectSelector;
    color: ColorSettings;
    /** Per-chain colour overrides (auth_asym_id → 0xRRGGBB) on top of the palette. */
    chainColors: Record<string, number>;
    /** Paint applied so far, in order — replayed onto components created later. */
    paint: PaintOp[];
    /** Per-residue datasets from computations, by id. */
    datasets: Map<string, ResidueDataset>;
}

export const DEFAULT_COLOR: ColorSettings = {
    scheme: 'chain',
    uniform: 0xb8bec6,
    ramp: 'viridis',
    domain: null,
    heteroatomsByElement: true,
    dataset: null,
    dataFallback: 'neutral',
};

/** Backing-store resolution capped at 2× physical pixels: beyond that SSAO cost grows with no visible gain. */
function pixelScale(): number {
    const dpr = window.devicePixelRatio || 1;
    return dpr > 2 ? 2 / dpr : 1;
}

/**
 * Trimmed spec: Mol*'s default registers ~60 UI actions and behaviours for its own
 * React UI. Kept: picking/highlight/selection, focus with surroundings, and the
 * computed properties interface analysis needs (interactions, SASA, secondary
 * structure, valence model).
 *
 * StructureInfo is dropped on purpose: it offsets chain colours per loaded model, so
 * the scene would disagree with the chain chips in the UI.
 */
function buildSpec(): PluginSpec {
    const { Representation, Camera, CustomProps } = PluginBehaviors;
    return {
        actions: [],
        behaviors: [
            PluginSpec.Behavior(Representation.HighlightLoci),
            // A click on empty space clears the selection (Mol*'s default binding).
            PluginSpec.Behavior(Representation.SelectLoci),
            PluginSpec.Behavior(Representation.DefaultLociLabelProvider),
            PluginSpec.Behavior(Representation.FocusLoci),
            PluginSpec.Behavior(Camera.FocusLoci, {
                durationMs: 350,
                bindings: {
                    ...CameraFocusBindings,
                    clickResetCameraOnEmpty: Binding.Empty,
                    clickResetCameraOnEmptySelectMode: Binding.Empty,
                },
            }),
            PluginSpec.Behavior(StructureFocusRepresentation),
            PluginSpec.Behavior(CustomProps.AccessibleSurfaceArea),
            PluginSpec.Behavior(CustomProps.Interactions),
            PluginSpec.Behavior(CustomProps.SecondaryStructure),
            PluginSpec.Behavior(CustomProps.ValenceModel),
        ],
        config: [
            [PluginConfig.General.ResolutionMode, 'native'],
            [PluginConfig.General.PixelScale, pixelScale()],
            // Ask the browser for the discrete GPU on hybrid machines.
            [PluginConfig.General.PowerPreference, 'high-performance'],
            // Weighted blended order-independent transparency. Depth peeling (dpoit) silently
            // drew nothing transparent on ANGLE/EGL with NVIDIA PRIME offload — cavities and
            // see-through surfaces vanished — while wboit renders them on the same driver.
            [PluginConfig.General.Transparency, (window as unknown as { __ppTransparency?: 'blended' | 'wboit' | 'dpoit' }).__ppTransparency ?? 'wboit'],
            [PluginConfig.VolumeStreaming.Enabled, false],
        ],
    };
}

type Listener = () => void;

/**
 * Hydrogens on screen: the polar ones (what an H-bond is drawn to), all, or none.
 * Only matters for files that have them — see "Adicionar hidrogênios".
 */
export type HydrogenDisplay = 'polar' | 'all' | 'none';

export function hydrogenParams(mode: HydrogenDisplay): Record<string, unknown> {
    if (mode === 'all') return { ignoreHydrogens: false };
    return { ignoreHydrogens: true, ignoreHydrogensVariant: mode === 'polar' ? 'non-polar' : 'all' };
}

/**
 * What the page draws behind a transparent canvas: a CSS background, the
 * transparency checkerboard, or nothing (the canvas paints its own solid colour).
 */
export type Backdrop = { kind: 'none' } | { kind: 'checker' } | { kind: 'css'; css: string };

let parallelCompileDisabled = false;

/**
 * Hides KHR_parallel_shader_compile from Mol*.
 *
 * With the extension, Mol* links shaders asynchronously and, when a render must be
 * synchronous, reads uniform locations without waiting for the link. Spec-conformant
 * drivers block there; ANGLE on EGL with NVIDIA PRIME offload instead reports
 * "program not linked", the locations stay null, and the scene stays blank until
 * something recompiles the shaders — every first launch with a cold shader cache.
 * Synchronous linking costs a little once, then the GPU program cache serves it.
 */
function disableParallelShaderCompile(): void {
    if (parallelCompileDisabled) return;
    parallelCompileDisabled = true;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const original = proto.getExtension;
        proto.getExtension = function (this: WebGLRenderingContext, name: string) {
            if (name === 'KHR_parallel_shader_compile') return null;
            return original.call(this, name);
        } as typeof original;
    }
}

export class Viewer {
    readonly entries = new Map<StructureId, StructureEntry>();
    chainPalette: ChainPaletteId = DEFAULT_CHAIN_PALETTE;
    /** Measurements in creation order (the Mol* nodes hold the geometry). */
    measurements: MeasurementInfo[] = [];
    /** Which hydrogens atom representations draw (style.ts `hydrogenParams`). */
    hydrogens: HydrogenDisplay = 'polar';
    /** User depth cut, 0–99 % of the scene radius (camera.ts). */
    clip = 0;
    /** Look currently applied (look.ts); null until the first applyLook. */
    look: Look | null = null;
    private listeners = new Set<Listener>();
    private backdropListeners = new Set<(b: Backdrop) => void>();
    backdrop: Backdrop = { kind: 'none' };
    private disposed = false;

    private constructor(readonly plugin: PluginContext) {}

    static async create(canvas: HTMLCanvasElement, container: HTMLDivElement, background: number): Promise<Result<Viewer>> {
        disableParallelShaderCompile();
        try {
            const plugin = new PluginContext(buildSpec());
            await plugin.init();
            // Reads ma_qa_metric from ModelCIF and falls back to the B-factor column, where
            // AF2/ColabFold PDBs keep pLDDT. Registered alone: the full QA behaviour pulls
            // in Mol*'s React UI.
            plugin.representation.structure.themes.colorThemeRegistry.add(PLDDTConfidenceColorThemeProvider);
            registerThemes(plugin);

            if (!(await plugin.initViewerAsync(canvas, container))) {
                plugin.dispose();
                return err('Falha ao inicializar o WebGL2. Verifique o driver da GPU.');
            }

            plugin.canvas3d?.setProps({
                camera: { mode: 'orthographic', helper: { axes: { name: 'off', params: {} } } },
                renderer: { backgroundColor: Color(background) },
                // Extra samples accumulate only while the camera is idle: fluid while
                // rotating, fully antialiased the moment it stops.
                multiSample: { mode: 'temporal' },
                // Eased camera moves: linear starts and stops read as mechanical.
                cameraResetDurationMs: 450,
                cameraResetEasing: 'cubic-in-out',
            });
            // The camera viewport is only set by handleResize. If the first structure arrives
            // before any resize has run, Mol*'s automatic framing divides by a 0×0 viewport
            // and the camera position becomes NaN — a permanently blank scene. The canvas is
            // laid out by now, so size the viewport immediately.
            plugin.canvas3d?.handleResize();
            // Selection mode on: a click toggles the residue, shift-click extends along the chain.
            plugin.selectionMode = true;
            const viewer = new Viewer(plugin);
            unclipFocus(viewer);
            return ok(viewer);
        } catch (e) {
            return err(`Não foi possível criar o visualizador: ${errorMessage(e)}`);
        }
    }

    get canvas3d() {
        return this.plugin.canvas3d;
    }

    /** Structure list or metadata changed (load, remove, rename, visibility, model). */
    onChange(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Background drawn by the page behind the canvas (look.ts, gradients). */
    onBackdrop(listener: (b: Backdrop) => void): () => void {
        this.backdropListeners.add(listener);
        listener(this.backdrop);
        return () => this.backdropListeners.delete(listener);
    }

    setBackdrop(b: Backdrop): void {
        const same = b.kind === this.backdrop.kind && (b.kind !== 'css' || (this.backdrop.kind === 'css' && this.backdrop.css === b.css));
        if (same) return;
        this.backdrop = b;
        for (const l of this.backdropListeners) l(b);
    }

    notify(): void {
        for (const l of this.listeners) l();
    }

    infos(): StructureInfo[] {
        return [...this.entries.values()].map((e) => e.info);
    }

    entry(id: StructureId): StructureEntry | undefined {
        return this.entries.get(id);
    }

    /**
     * The entry a Structure object came from. Loci carry the displayed structure, which
     * after a superposition is a transformed copy; its units still point at the entry's
     * Model, so the model id is what ties them back.
     */
    idOf(structure: { models: ReadonlyArray<{ id: string }> }): StructureId | null {
        const modelId = structure.models[0]?.id;
        if (!modelId) return null;
        for (const [id, e] of this.entries) {
            const model = e.model.cell?.obj?.data as { id: string } | undefined;
            if (model?.id === modelId) return id;
        }
        return null;
    }

    /** Position among loaded structures — drives per-structure colouring. */
    entityIndex(id: StructureId): number {
        return [...this.entries.keys()].indexOf(id);
    }

    /** Unmasked renderer string of this viewer's WebGL context (e.g. "ANGLE (NVIDIA …)"). */
    gpuRenderer(): string {
        try {
            const gl = this.plugin.canvas3d?.webgl.gl;
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
        } catch {
            return '';
        }
    }

    /**
     * Hides or shows a state node with everything beneath it. Flagging only the node
     * (updateCellState) leaves its representations, which are child nodes, on screen.
     */
    setHidden(ref: string, hidden: boolean): void {
        setSubtreeVisibility(this.plugin.state.data, ref, hidden);
    }

    handleResize(): void {
        this.plugin.canvas3d?.handleResize();
    }

    /** Hover label stream (Mol*'s own text for the atom under the cursor). */
    onHoverLabel(callback: (label: string) => void): () => void {
        // Mol* labels are HTML fragments; reduce to plain text so nothing from a file is rendered as markup.
        const toText = (html: string) => html.replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
        const sub = this.plugin.behaviors.labels.highlight.subscribe((h) => callback(h.labels.map((l) => toText(String(l))).join(' · ')));
        return () => sub.unsubscribe();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listeners.clear();
        this.backdropListeners.clear();
        this.plugin.dispose();
    }
}

/** Test-only: Mol*'s debug mode checks every shader link and throws with the driver's log. */
export function enableEngineDebug(): void {
    setDebugMode(true);
}
