import { useRef } from 'react';
import { closeResult, useCompute, type ResultEntry } from '@/compute/store';
import { Icon } from '../components/Icon';
import { cx } from '../components/Primitives';
import { KvfinderView } from './views/KvfinderView';
import { MhcxView } from './views/MhcxView';
import { BatchView, DsspView, ElectrostaticsView, RenumberView, TmalignView } from './views/OtherViews';
import { RelaxView, RosettaInterfaceView } from './views/RosettaView';

function View({ entry }: { entry: ResultEntry }) {
    if (entry.meta.extra?.batch) return <BatchView entry={entry} />;
    switch (entry.tool) {
        case 'rosetta_interface':
            return <RosettaInterfaceView entry={entry} />;
        case 'rosetta_relax':
            return <RelaxView entry={entry} />;
        case 'kvfinder':
            return <KvfinderView entry={entry} />;
        case 'mhcxgraph':
            return <MhcxView entry={entry} />;
        case 'electrostatics':
            return <ElectrostaticsView entry={entry} />;
        case 'dssp':
            return <DsspView entry={entry} />;
        case 'tmalign':
            return <TmalignView entry={entry} />;
        case 'mhcx_renumber':
            return <RenumberView entry={entry} />;
    }
}

/**
 * Results dock under the viewport: one tab per result, resizable by dragging its top
 * edge. Height changes go straight to style (no re-render per pointermove).
 */
export function Dock() {
    const open = useCompute((s) => s.dockOpen);
    const height = useCompute((s) => s.dockHeight);
    const results = useCompute((s) => s.results);
    const activeId = useCompute((s) => s.activeResult);
    const ref = useRef<HTMLDivElement>(null);
    if (!open || results.length === 0) return null;
    const active = results.find((r) => r.id === activeId) ?? results[0]!;

    const startDrag = (e: React.PointerEvent) => {
        const startY = e.clientY;
        const start = height;
        const el = ref.current;
        const move = (ev: PointerEvent) => {
            if (el) el.style.height = `${Math.max(160, Math.min(window.innerHeight - 220, start + startY - ev.clientY))}px`;
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            useCompute.setState({ dockHeight: Math.max(160, Math.min(window.innerHeight - 220, start + startY - ev.clientY)) });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    return (
        <div ref={ref} className="slide-up flex shrink-0 flex-col border-t border-stroke bg-bg-1 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.6)]" style={{ height }}>
            <div onPointerDown={startDrag} className="group flex h-1.5 cursor-ns-resize items-center justify-center">
                <span className="h-[3px] w-10 rounded-full bg-stroke-2 transition-all duration-200 group-hover:w-16 group-hover:bg-accent/70" />
            </div>
            <div className="scroll-themed flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-stroke px-2">
                {results.map((r) => (
                    <div
                        key={r.id}
                        onClick={() => useCompute.setState({ activeResult: r.id })}
                        className={cx(
                            'scale-in flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors duration-200',
                            r.id === active.id ? 'bg-bg-3 text-text-0 ring-1 ring-accent/30' : 'text-text-2 hover:bg-bg-2 hover:text-text-0',
                        )}
                    >
                        <span className="max-w-[240px] truncate">{r.label}</span>
                        <button type="button" title="Fechar" onClick={(e) => { e.stopPropagation(); closeResult(r.id); }} className="text-text-2 hover:text-err">
                            <Icon name="close" size={11} />
                        </button>
                    </div>
                ))}
                <div className="flex-1" />
                <button type="button" title="Recolher" onClick={() => useCompute.setState({ dockOpen: false })} className="text-text-2 hover:text-text-0">
                    <Icon name="chevronDown" size={14} />
                </button>
            </div>
            <div key={active.id} className="fade-in min-h-0 flex-1 p-2">
                <View entry={active} />
            </div>
        </div>
    );
}
