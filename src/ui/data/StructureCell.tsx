import { useEffect, useRef, useState } from 'react';
import * as E from '@/engine';
import { platform, asBytes } from '@/platform/bridge';
import type { StructureCellSpec } from '@/panels/types';
import { THEMES, type ThemeId } from '@/panels/theme';
import { cellRowId, rowById, useData } from '@/store/data';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/Primitives';

/**
 * The background of a 3D cell comes from its own look preset (a "Figura branca" cell
 * is white even on a dark panel), so the theme only seeds the canvas before the first
 * look is applied — otherwise the first frame flashes the wrong colour.
 */

/** Viewers by cell id, so the panel export can render each 3D cell at figure size. */
export const structureViewers = new Map<string, E.Viewer>();

function backgroundOf(theme: ThemeId): number {
    const hex = THEMES[theme].background.replace('#', '');
    return parseInt(hex.length === 6 ? hex : '101520', 16);
}

/**
 * A 3D cell inside a panel: its own Mol* viewer (the engine was built as instances
 * exactly for this), loading whatever the cell's source points at — usually the
 * design selected in the charts, optionally with the target behind it.
 *
 * Loading is serialised per cell and keyed by what is actually displayed, so
 * clicking through fifty designs does not queue fifty loads.
 */
export function StructureCell({ cellId, spec, theme }: { cellId: string; spec: StructureCellSpec; theme: ThemeId }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewerRef = useRef<E.Viewer | null>(null);
    const loadToken = useRef(0);
    const [status, setStatus] = useState<'init' | 'empty' | 'loading' | 'ready' | 'error'>('init');
    // Bumped once the viewer exists: the load effect runs before creation finishes,
    // and without this it would return early and never be retried.
    const [viewerReady, setViewerReady] = useState(0);
    const [message, setMessage] = useState('');

    const rowId = useData((s) => cellRowId(s, cellId, spec));
    const dataset = useData((s) => s.dataset);
    const pointer = useData((s) => s.cellPointer[cellId] ?? 'select');
    const path = spec.source.kind === 'file' ? spec.source.path : (rowById(rowId)?.structurePath ?? null);
    const key = [path, ...spec.withFiles].join('|');

    // One viewer per cell, created once.
    useEffect(() => {
        let disposed = false;
        (async () => {
            const container = containerRef.current;
            const canvas = canvasRef.current;
            if (!container || !canvas) return;
            const created = await E.Viewer.create(canvas, container, backgroundOf(theme));
            if (!created.ok) {
                if (!disposed) {
                    setStatus('error');
                    setMessage(created.error);
                }
                return;
            }
            if (disposed) {
                created.value.dispose();
                return;
            }
            viewerRef.current = created.value;
            structureViewers.set(cellId, created.value);
            setViewerReady((n) => n + 1);
            const resize = new ResizeObserver(() => created.value.handleResize());
            resize.observe(container);
            E.trackFocusColors(created.value);
            setStatus('empty');
            return () => resize.disconnect();
        })();
        return () => {
            disposed = true;
            structureViewers.delete(cellId);
            viewerRef.current?.dispose();
            viewerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cellId]);

    // Select or explore on click, as the structure workspace's pointer tools.
    useEffect(() => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        E.setPointerMode(viewer, pointer);
        if (pointer === 'select') E.clearFocus(viewer);
    }, [viewerReady, pointer]);

    // Load whatever the cell points at.
    useEffect(() => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        const token = ++loadToken.current;
        (async () => {
            // Clear what is there, so a cell never shows the previous design underneath.
            for (const info of viewer.infos()) await E.removeStructure(viewer, info.id);
            if (token !== loadToken.current) return;
            if (!path) {
                setStatus('empty');
                return;
            }
            setStatus('loading');
            const paths = [...spec.withFiles, path];
            const files = await platform.readFiles(paths);
            if (token !== loadToken.current) return;
            let loaded = 0;
            for (const f of files) {
                if (!f.ok || !f.bytes) continue;
                const r = await E.loadBytes(viewer, asBytes(f.bytes), { name: f.name, source: 'file', path: f.path });
                if (token !== loadToken.current) return;
                if (!r.ok) continue;
                loaded++;
                await E.applyDefaultPreset(viewer, r.value.id);
                if (spec.colorBy !== 'chain') await E.setColorSettings(viewer, r.value.id, { scheme: spec.colorBy === 'plddt' ? 'plddt' : spec.colorBy === 'uniform' ? 'uniform' : spec.colorBy });
                if (spec.surface) {
                    for (const c of r.value.chains.filter((c) => c.isPolymer && c.role !== 'binder')) {
                        await E.setLayer(viewer, { kind: 'chain', id: r.value.id, chain: c.authAsymId }, 'surface', { layer: 'surface', style: 'molecular', opacity: 0.6 });
                    }
                }
            }
            if (token !== loadToken.current) return;
            if (loaded === 0) {
                setStatus('error');
                setMessage('Não foi possível ler a estrutura.');
                return;
            }
            const main = viewer.infos()[viewer.infos().length - 1];
            if (main && spec.interface) {
                const binders = main.chains.filter((c) => c.isPolymer && c.role === 'binder').map((c) => c.authAsymId);
                const others = main.chains.filter((c) => c.isPolymer && c.role !== 'binder').map((c) => c.authAsymId);
                if (binders.length && others.length) {
                    const report = await E.analyzeInterface(viewer, { structureId: main.id, chains: binders }, { structureId: main.id, chains: others }, E.DEFAULT_CONTACTS);
                    if (report.ok) {
                        const kinds = new Set(['hydrogen-bond', 'salt-bridge', 'pi-stacking', 'cation-pi'] as E.InteractionKind[]);
                        await E.showInteractions(viewer, report.value, kinds);
                        // The side chains behind each line, as in the structure workspace: a
                        // dashed line between two ribbons does not show what makes the contact.
                        await E.showInteractionAtoms(viewer, report.value, kinds);
                    }
                }
            }
            await E.applyLook(viewer, E.presetLook((spec.look as E.LookPreset) ?? 'white-figure'), 0);
            if (main && spec.view !== 'auto') E.canonicalView(viewer, main.id, spec.view, 0);
            else if (main) {
                // "auto": the docking view when the complex allows it, else just frame it.
                const r = E.canonicalView(viewer, main.id, 'side', 0);
                if (!r.ok) E.resetView(viewer, 0);
            }
            E.setSpin(viewer, spec.spin);
            setStatus('ready');
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewerReady, key, spec.look, spec.view, spec.colorBy, spec.surface, spec.interface, spec.spin, dataset]);

    return (
        <div className="relative h-full w-full">
            <div ref={containerRef} className="absolute inset-0">
                <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            </div>
            {status === 'empty' && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                    <Icon name="target" size={18} className="opacity-40" />
                    <p className="text-[11.5px] leading-relaxed text-text-2">
                        {spec.source.kind === 'selected' ? 'Clique num ponto de um gráfico para abrir o design aqui (duplo clique abre no modo Estrutura).' : 'Escolha a estrutura desta célula no menu.'}
                    </p>
                </div>
            )}
            {status === 'loading' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <Spinner size={18} className="text-accent" />
                </div>
            )}
            {status === 'error' && <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11.5px] text-err">{message}</div>}
        </div>
    );
}
