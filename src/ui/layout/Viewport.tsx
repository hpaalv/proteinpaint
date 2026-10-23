import { useEffect, useRef, useState } from 'react';
import * as E from '@/engine';
import { setViewer, useApp, viewer } from '@/store/app';
import { dropFiles, syncSelection, syncStructures } from '@/store/actions';
import { describeGpu, platform } from '@/platform/bridge';
import { Icon } from '../components/Icon';
import { Spinner, cx } from '../components/Primitives';

const BACKGROUND = 0x0b0e14;

/**
 * The 3D canvas. Mol* owns the canvas and its input; React only mounts it once and
 * mirrors the viewer's events into the store.
 */
export function Viewport() {
    const containerRef = useRef<HTMLDivElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [dragging, setDragging] = useState(false);
    const ready = useApp((s) => s.ready);
    const initError = useApp((s) => s.initError);
    const busy = useApp((s) => s.busy);
    const empty = useApp((s) => s.structures.length === 0);
    const tool = useApp((s) => s.tool);
    const progress = useApp((s) => s.measureProgress);
    const movie = useApp((s) => s.movieProgress);
    const clip = useApp((s) => s.clip);

    useEffect(() => {
        let disposed = false;
        const cleanups: (() => void)[] = [];
        (async () => {
            const container = containerRef.current;
            const canvas = canvasRef.current;
            if (!container || !canvas) return;
            const created = await E.Viewer.create(canvas, container, BACKGROUND);
            if (disposed) {
                if (created.ok) created.value.dispose();
                return;
            }
            if (!created.ok) {
                useApp.setState({ initError: created.error });
                return;
            }
            const v = created.value;
            setViewer(v);
            const preset = useApp.getState().look;
            void E.applyLook(v, E.presetLook(preset === 'custom' ? E.DEFAULT_LOOK : preset), 0);
            await E.styleFocusView(v);
            // Gradient / transparent figure backgrounds are painted here, behind the canvas.
            // Written straight to the element: during a look blend it changes every frame.
            cleanups.push(
                v.onBackdrop((b) => {
                    const el = backdropRef.current;
                    if (!el) return;
                    el.classList.toggle('checker', b.kind === 'checker');
                    el.style.background = b.kind === 'css' ? b.css : '';
                }),
            );
            cleanups.push(v.onChange(syncStructures));
            cleanups.push(E.onSelectionChange(v, syncSelection));
            cleanups.push(v.onHoverLabel((label) => useApp.setState({ hover: label })));
            const resize = new ResizeObserver(() => v.handleResize());
            resize.observe(container);
            cleanups.push(() => resize.disconnect());
            useApp.setState({ ready: true });
            // GPU name is informational; a failure here must never block the app.
            platform
                .gpuInfo()
                .catch(() => null)
                .then((info) => useApp.setState({ gpu: describeGpu(info, v.gpuRenderer()) }));
        })();
        return () => {
            disposed = true;
            for (const c of cleanups) c();
            viewer()?.dispose();
            setViewer(null);
            useApp.setState({ ready: false });
        };
    }, []);

    return (
        <div
            ref={backdropRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-0"
            onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
            }}
            onDragLeave={(e) => {
                if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void dropFiles([...e.dataTransfer.files]);
            }}
        >
            <div ref={containerRef} className="absolute inset-0">
                {/* Hidden until the viewer is up: no flash of an uncleared WebGL buffer. */}
                <canvas ref={canvasRef} className={cx('absolute inset-0 h-full w-full transition-opacity duration-500', ready ? 'opacity-100' : 'opacity-0')} />
            </div>

            {ready && empty && !busy && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="slide-up flex flex-col items-center gap-3 text-center">
                        <div className="brand-glow mb-1 h-12 w-12 rounded-2xl shadow-[0_8px_40px_-6px_color-mix(in_srgb,var(--accent)_55%,transparent)]" />
                        <div className="text-[22px] font-semibold tracking-tight text-text-0">ProteinPaint</div>
                        <div className="max-w-sm text-[13px] leading-relaxed text-text-1">
                            Arraste arquivos PDB/mmCIF ou uma pasta de designs para cá,
                            <br />
                            ou use <span className="text-text-0">Abrir</span> / digite um código PDB ou UniProt no topo.
                        </div>
                        <div className="mono mt-2 text-[11px] text-text-2">Ctrl+O arquivos · Ctrl+Shift+O pasta · F focar · R resetar · Esc limpar seleção</div>
                    </div>
                </div>
            )}

            {clip > 0 && (
                <button
                    type="button"
                    onClick={() => {
                        const v = viewer();
                        if (v) E.setClip(v, 0);
                        useApp.setState({ clip: 0 });
                    }}
                    title="O corte de profundidade está escondendo o que está além de um plano. Clique para remover."
                    className="glass scale-in absolute top-3 left-3 flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] text-warn hover:brightness-125"
                >
                    <Icon name="layers" size={12} /> Corte de profundidade {clip.toFixed(0)}% · remover
                </button>
            )}

            {tool === 'measure' && progress && (
                <div className="glass fade-in absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[12px] text-text-0">
                    Medindo · clique nos átomos <span className="tnum text-accent">{progress.picked}/{progress.needed}</span>
                </div>
            )}

            {busy && (
                <>
                    {/* Thin bar along the top edge: determinate for animations, a sweep otherwise. */}
                    <div className={cx('pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent/15', movie === null && 'progress-indeterminate')}>
                        {movie !== null && <div className="h-full origin-left bg-accent transition-transform duration-200" style={{ transform: `scaleX(${movie})` }} />}
                    </div>
                    <div className="glass scale-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-text-0 shadow-[var(--shadow-pop)]">
                        <Spinner size={13} className="text-accent" />
                        {busy}
                    </div>
                </>
            )}

            {dragging && (
                <div className="scale-in pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/8 backdrop-blur-[2px]">
                    <div className="flex items-center gap-2 text-[14px] text-accent">
                        <Icon name="download" size={18} /> Solte para abrir
                    </div>
                </div>
            )}

            {initError && (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                    <div className="max-w-md rounded-lg border border-err/40 bg-bg-1 p-4 text-[13px] text-err">{initError}</div>
                </div>
            )}
        </div>
    );
}
