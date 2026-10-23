import { useEffect, useRef, useState } from 'react';
import * as E from '@/engine';
import { intToHex, hexToInt } from '@/data/palettes';
import { run, useApp, viewer } from '@/store/app';
import { browseTo, closeStructure, loadPaths, pinBrowsed } from '@/store/actions';
import { Icon } from '../components/Icon';
import { Collapse, EditableText, Empty, IconButton, cx } from '../components/Primitives';

const ROLES: E.ChainRole[] = ['binder', 'target', 'mhc', 'b2m', 'peptide', 'ligand', 'unassigned'];

function ChainRow({ s, c }: { s: E.StructureInfo; c: E.ChainInfo }) {
    const v = viewer();
    const selected = useApp((st) => (st.selectedResidues.get(s.id)?.get(c.authAsymId)?.size ?? 0) > 0);
    // Re-read on every render: the swatch must follow palette and scheme changes.
    const entry = v?.entry(s.id);
    const color = v && entry ? intToHex(E.chainColor(v, entry, c.authAsymId)) : '#888888';

    return (
        <div
            className={cx('group flex h-7 items-center gap-1.5 rounded-md pr-1 pl-6 transition-colors duration-150 hover:bg-bg-3', selected && 'bg-accent/8')}
            onClick={(e) => v && void run(E.selectChain(v, s.id, c.authAsymId, e.shiftKey ? 'add' : e.altKey ? 'remove' : 'set'))}
            title="Clique: selecionar cadeia · Shift: adicionar · Alt: remover"
        >
            <label className="relative h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[4px] border border-black/30 transition-[transform,background-color] duration-300 hover:scale-125" style={{ background: color }} onClick={(e) => e.stopPropagation()}>
                <input
                    type="color"
                    value={color}
                    className="absolute inset-0 h-full w-full opacity-0"
                    onChange={(e) => v && void E.setChainColor(v, s.id, c.authAsymId, hexToInt(e.target.value))}
                />
            </label>
            <span className="mono w-5 shrink-0 text-[12px] text-text-0">{c.authAsymId}</span>
            <span className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                <EditableText
                    value={c.alias}
                    placeholder={c.isPolymer ? `${c.residueCount} res` : 'ligante/água'}
                    onCommit={(alias) => v && E.renameChain(v, s.id, c.authAsymId, alias)}
                    className="text-[12px]"
                />
            </span>
            {c.alias && <span className="tnum text-[11px] text-text-2">{c.residueCount}</span>}
            <select
                value={c.role}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => v && void E.setChainRole(v, s.id, c.authAsymId, e.target.value as E.ChainRole)}
                className={cx(
                    'h-5 shrink-0 rounded border-none bg-transparent px-1 text-[11px] outline-none hover:bg-bg-2',
                    c.role === 'binder' ? 'text-accent' : c.role === 'unassigned' ? 'text-text-2' : 'text-text-1',
                )}
                title="Papel da cadeia (alimenta a análise de interface)"
            >
                {ROLES.map((r) => (
                    <option key={r} value={r}>
                        {E.CHAIN_ROLE_LABELS[r]}
                    </option>
                ))}
            </select>
        </div>
    );
}

function StructureRow({ s, index }: { s: E.StructureInfo; index: number }) {
    const [open, setOpen] = useState(true);
    const active = useApp((st) => st.activeId === s.id);
    const browsing = useApp((st) => st.library.browseId === s.id);
    const v = viewer();
    const chains = s.chains.filter((c) => c.isPolymer || c.residueCount > 0);
    const ligandChains = s.chains.length - chains.length;

    return (
        <div className={cx('slide-up rounded-lg border transition-[background-color,border-color,opacity] duration-200', active ? 'border-stroke-2 bg-bg-2' : 'border-transparent hover:bg-bg-2/50', !s.visible && 'opacity-55')}>
            <div className="group flex h-8 items-center gap-1 px-1" onClick={() => useApp.setState({ activeId: s.id })}>
                <button type="button" className="text-text-2 hover:text-text-0" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
                    <Icon name="chevron" size={13} className={cx('transition-transform duration-300 ease-[var(--ease)]', open && 'rotate-90')} />
                </button>
                <span className="mono w-5 shrink-0 text-[11px] text-text-2">#{index + 1}</span>
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">
                    <EditableText value={s.alias} placeholder={s.name} onCommit={(alias) => v && E.renameStructure(v, s.id, alias)} />
                </span>
                {browsing && (
                    <IconButton icon="pin" size={22} title="Fixar na cena (o próximo design abre ao lado)" onClick={() => pinBrowsed()} />
                )}
                <IconButton icon="focus" size={22} title="Enquadrar" className="opacity-0 group-hover:opacity-100" onClick={() => v && E.focusStructure(v, s.id)} />
                <IconButton icon={s.visible ? 'eye' : 'eyeOff'} size={22} title={s.visible ? 'Esconder' : 'Mostrar'} onClick={() => v && void run(E.setVisible(v, s.id, !s.visible))} />
                <IconButton icon="trash" size={22} title="Remover" className="opacity-0 group-hover:opacity-100" onClick={() => void closeStructure(s.id)} />
            </div>
            <Collapse open={open}>
                <div className="pb-1">
                    {s.modelCount > 1 && (
                        <div className="flex h-7 items-center gap-2 pr-2 pl-6 text-[11px] text-text-1">
                            Modelo
                            <input
                                type="range"
                                min={0}
                                max={s.modelCount - 1}
                                step={1}
                                value={s.modelIndex}
                                style={{ ['--fill' as string]: `${(s.modelIndex / Math.max(1, s.modelCount - 1)) * 100}%` }}
                                onChange={(e) => v && void run(E.setModelIndex(v, s.id, Number(e.target.value)))}
                                className="flex-1"
                            />
                            <span className="tnum text-text-0">
                                {s.modelIndex + 1}/{s.modelCount}
                            </span>
                        </div>
                    )}
                    {chains.map((c) => (
                        <ChainRow key={c.authAsymId} s={s} c={c} />
                    ))}
                    <div className="flex gap-2 pr-2 pl-6 text-[11px] text-text-2">
                        <span className="tnum">{s.residueCount} res</span>·<span className="tnum">{s.atomCount.toLocaleString('pt-BR')} átomos</span>
                        {ligandChains > 0 && <>· {ligandChains} sem polímero</>}
                        {s.looksLikePlddt && <span className="text-accent">· pLDDT</span>}
                    </div>
                </div>
            </Collapse>
        </div>
    );
}

function Library() {
    const library = useApp((s) => s.library);
    const listRef = useRef<HTMLDivElement>(null);
    const [filter, setFilter] = useState('');
    const files = filter ? library.files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : library.files;

    useEffect(() => {
        listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [library.current]);

    if (!library.folder) return null;
    const base = library.folder.split('/').pop();
    return (
        <div className="flex min-h-0 flex-1 flex-col border-t border-stroke">
            <div className="flex h-8 items-center gap-1 px-3">
                <span className="flex-1 truncate text-[11px] font-semibold tracking-wider text-text-1 uppercase" title={library.folder}>
                    Biblioteca · {base}
                </span>
                <span className="tnum text-[11px] text-text-2">{library.files.length}</span>
                <IconButton icon="close" size={20} title="Fechar biblioteca" onClick={() => useApp.setState({ library: { folder: null, files: [], current: null, browseId: null } })} />
            </div>
            <div className="px-2 pb-1">
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Filtrar…"
                    className="h-6 w-full rounded border border-stroke bg-bg-0 px-2 text-[12px] outline-none focus:border-accent"
                />
            </div>
            <div ref={listRef} className="scroll-themed min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {files.map((f) => {
                    const name = f.split('/').pop()!;
                    const current = f === library.current;
                    return (
                        <div
                            key={f}
                            data-current={current}
                            title={f}
                            onClick={() => void browseTo(f)}
                            onDoubleClick={() => void loadPaths([f])}
                            className={cx(
                                'mono relative flex h-6 cursor-pointer items-center truncate rounded px-2 text-[11.5px] transition-colors duration-150',
                                current ? 'bg-accent/15 text-accent before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-accent' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
                            )}
                            style={{ contentVisibility: 'auto', containIntrinsicSize: '24px' }}
                        >
                            {name}
                        </div>
                    );
                })}
            </div>
            <div className="border-t border-stroke px-3 py-1.5 text-[11px] text-text-2">Clique: navegar (substitui) · Duplo: abrir ao lado · PgUp/PgDn</div>
        </div>
    );
}

export function Sidebar() {
    const structures = useApp((s) => s.structures);
    const hasLibrary = useApp((s) => s.library.folder !== null);
    return (
        <aside className="flex w-[290px] shrink-0 flex-col border-r border-stroke bg-bg-1">
            <div className="flex h-8 shrink-0 items-center px-3 text-[11px] font-semibold tracking-wider text-text-1 uppercase">
                Estruturas <span className="tnum ml-auto font-normal text-text-2">{structures.length}</span>
            </div>
            <div className={cx('scroll-themed min-h-0 overflow-y-auto px-1.5 pb-2', hasLibrary ? 'max-h-[55%]' : 'flex-1')}>
                {structures.length === 0 ? (
                    <Empty>Nada carregado.</Empty>
                ) : (
                    <div className="flex flex-col gap-1">
                        {structures.map((s, i) => (
                            <StructureRow key={s.id} s={s} index={i} />
                        ))}
                    </div>
                )}
            </div>
            <Library />
        </aside>
    );
}
