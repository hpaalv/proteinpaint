import { memo, useRef } from 'react';
import * as E from '@/engine';
import { intToHex } from '@/data/palettes';
import { useApp, viewer } from '@/store/app';
import { cx } from '../components/Primitives';

const CELL = 10;

/** Letter tint by residue class — a quick read of the sequence's chemistry. */
const CLASS_TINT: Record<string, string> = {
    D: '#FF7A85', E: '#FF7A85',
    K: '#6FA8FF', R: '#6FA8FF', H: '#9DC1FF',
    S: '#9BD8A4', T: '#9BD8A4', N: '#9BD8A4', Q: '#9BD8A4', Y: '#9BD8A4',
    C: '#F2DC7B', G: '#C7CDD6', P: '#C7CDD6',
    F: '#E9EDF3', W: '#E9EDF3',
};

interface RowProps {
    s: E.StructureInfo;
    c: E.ChainInfo;
    color: string;
    selected: Set<string> | undefined;
}

const ChainRow = memo(function ChainRow({ s, c, color, selected }: RowProps) {
    const drag = useRef<{ start: number; modifier: E.SelectModifier } | null>(null);
    const hoverRef = useRef<HTMLDivElement>(null);

    const commit = (from: number, to: number, modifier: E.SelectModifier) => {
        const v = viewer();
        if (!v) return;
        const [a, b] = from <= to ? [from, to] : [to, from];
        const keys = c.residues.slice(a, b + 1).map((r) => E.residueKey(r.seq, r.insCode));
        void E.selectResidues(v, s.id, c.authAsymId, keys, modifier);
    };

    const indexAt = (e: React.MouseEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        return Math.max(0, Math.min(c.residues.length - 1, Math.floor((e.clientX - rect.left) / CELL)));
    };

    return (
        <div className="flex h-[22px] items-center">
            <div className="sticky left-0 z-10 flex h-full w-[150px] shrink-0 items-center gap-1.5 border-r border-stroke bg-bg-1 px-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
                <span className="mono truncate text-[11px] text-text-1" title={`${s.alias || s.name} /${c.authAsymId}`}>
                    {(s.alias || s.name).slice(0, 12)} <span className="text-text-0">/{c.authAsymId}</span>
                </span>
            </div>
            <div
                className="relative flex h-full cursor-crosshair"
                style={{ width: c.residues.length * CELL }}
                onMouseDown={(e) => {
                    const i = indexAt(e);
                    drag.current = { start: i, modifier: e.shiftKey ? 'add' : e.altKey ? 'remove' : 'set' };
                }}
                onMouseUp={(e) => {
                    if (!drag.current) return;
                    commit(drag.current.start, indexAt(e), drag.current.modifier);
                    drag.current = null;
                }}
                onMouseLeave={() => {
                    drag.current = null;
                    if (hoverRef.current) hoverRef.current.style.opacity = '0';
                }}
                onMouseMove={(e) => {
                    const i = indexAt(e);
                    const r = c.residues[i];
                    const el = hoverRef.current;
                    if (el && r) {
                        el.style.opacity = '1';
                        el.style.transform = `translateX(${i * CELL}px)`;
                        el.textContent = `${r.name} ${r.seq}${r.insCode}`;
                    }
                }}
            >
                {c.residues.map((r, i) => {
                    const sel = selected?.has(E.residueKey(r.seq, r.insCode));
                    return (
                        <span
                            key={i}
                            className={cx('mono flex h-full shrink-0 items-center justify-center text-[10px] leading-none', sel && 'bg-accent text-bg-0')}
                            style={{ width: CELL, color: sel ? undefined : (CLASS_TINT[r.code] ?? '#AEB6C2') }}
                        >
                            {r.code}
                        </span>
                    );
                })}
                <div ref={hoverRef} className="glass pointer-events-none absolute -top-5 left-0 rounded px-1 text-[10px] whitespace-nowrap text-text-0 opacity-0" />
            </div>
        </div>
    );
});

function Ruler({ length }: { length: number }) {
    return (
        <div className="flex h-4 items-end">
            <div className="sticky left-0 z-10 h-full w-[150px] shrink-0 border-r border-stroke bg-bg-1" />
            <div className="relative h-full" style={{ width: length * CELL }}>
                {Array.from({ length: Math.floor(length / 10) }, (_, k) => (
                    <span key={k} className="tnum absolute bottom-0 text-[9px] text-text-2" style={{ left: (k + 1) * 10 * CELL - CELL }}>
                        {(k + 1) * 10}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function SequenceTrack() {
    const mode = useApp((s) => s.sequenceMode);
    const structures = useApp((s) => s.structures);
    const selected = useApp((s) => s.selectedResidues);
    if (mode === 'off' || structures.length === 0) return null;
    const v = viewer();
    const rows = structures.flatMap((s) => (s.visible ? s.chains.filter((c) => c.isPolymer && c.residues.length > 0).map((c) => ({ s, c })) : []));
    const longest = Math.max(0, ...rows.map((r) => r.c.residues.length));
    const body = (
        <>
            <Ruler length={longest} />
            {rows.map(({ s, c }) => {
                const entry = v?.entry(s.id);
                const color = v && entry ? intToHex(E.chainColor(v, entry, c.authAsymId)) : '#888';
                return <ChainRow key={`${s.id}:${c.authAsymId}`} s={s} c={c} color={color} selected={selected.get(s.id)?.get(c.authAsymId)} />;
            })}
        </>
    );

    if (mode === 'fixed') return <div className="scroll-themed max-h-[180px] shrink-0 overflow-auto border-t border-stroke bg-bg-1 pb-1">{body}</div>;

    // Tucked away: floats over the bottom of the scene and slides up while the pointer
    // is on it. Only a transform moves, so the canvas keeps its size and nothing re-lays out.
    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[188px]">
            <div className="pointer-events-auto absolute inset-x-0 bottom-0 translate-y-[calc(100%-7px)] transition-transform duration-300 ease-[var(--ease)] hover:translate-y-0">
                <div className="mx-auto h-[7px] w-24 rounded-t-md bg-stroke-2/80" title="Trilha de sequência" />
                <div className="scroll-themed max-h-[180px] overflow-auto border-t border-stroke bg-bg-1/95 pb-1 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur-sm">{body}</div>
            </div>
        </div>
    );
}
