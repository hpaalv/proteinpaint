import { useState } from 'react';
import * as E from '@/engine';
import { run, setSequenceMode, toast, useApp, viewer, type PointerTool, type SequenceMode, type Workspace } from '@/store/app';
import { fetchId, openFiles, openFolder, setTool } from '@/store/actions';
import { openDatasetFolder, useData } from '@/store/data';
import { redo, undo, useHistory } from '@/store/history';
import { useFilteredRows } from '@/ui/data/hooks';
import { Icon } from '../components/Icon';
import { Button, IconButton, Segmented, TextInput, cx } from '../components/Primitives';

const TOOLS: readonly { value: PointerTool; label: React.ReactNode; title: string }[] = [
    { value: 'select', label: <><Icon name="cursor" size={13} /> Selecionar</>, title: 'Clique alterna o resíduo; Shift+clique estende pela cadeia (S)' },
    { value: 'explore', label: <><Icon name="compass" size={13} /> Explorar</>, title: 'Clique foca o resíduo e mostra a vizinhança de 5 Å com interações (E)' },
    { value: 'measure', label: <><Icon name="ruler" size={13} /> Medir</>, title: 'Clique nos átomos para medir distância/ângulo/diedro (M)' },
];

/** Dataset summary and quick actions, shown while the data workspace is open. */
function DataTopBarExtras() {
    const dataset = useData((s) => s.dataset);
    const selection = useData((s) => s.selection);
    const rows = useFilteredRows();
    return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button icon="open" onClick={() => void openDatasetFolder()} title="Abrir pasta com estruturas + metadados">
                Pasta de análise
            </Button>
            {dataset && (
                <span className="fade-in flex min-w-0 items-center gap-2 text-[11.5px] text-text-2">
                    <span className="mono truncate text-text-1" title={dataset.folder}>
                        {dataset.name}
                    </span>
                    <span className="tnum">· {rows.length} designs</span>
                    {selection.size > 0 && <span className="tnum text-accent">· {selection.size} selecionados</span>}
                </span>
            )}
        </div>
    );
}

/** ChimeraX-style spec box: Enter replaces the selection, Shift+Enter adds, Alt+Enter removes. */
function SpecBox() {
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const submit = async (modifier: E.SelectModifier) => {
        const v = viewer();
        if (!v || !text.trim()) return;
        const r = await E.selectBySpec(v, text, modifier);
        if (!r.ok) setError(r.error);
        else {
            setError(null);
            toast(`${r.value} átomos`, 'ok', 1500);
        }
    };
    return (
        <div className="relative flex min-w-0 flex-1 items-center">
            <Icon name="select" size={13} className="pointer-events-none absolute left-2 text-text-2" />
            <input
                value={text}
                spellCheck={false}
                placeholder="/B:30-45   :TYR,PHE   /A & sel :<5   #2/C@CA"
                onChange={(e) => {
                    setText(e.target.value);
                    setError(null);
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void submit(e.shiftKey ? 'add' : e.altKey ? 'remove' : 'set');
                    if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
                title="Seleção estilo ChimeraX. Enter: substituir · Shift+Enter: adicionar · Alt+Enter: remover"
                className={cx(
                    'mono h-7 w-full min-w-0 rounded-md border bg-bg-1 pr-2 pl-7 text-[12px] text-text-0 outline-none placeholder:text-text-2',
                    error ? 'border-err' : 'border-stroke-2 focus:border-accent',
                )}
            />
            {error && <div className="glass fade-in absolute top-8 left-0 z-30 rounded-md px-2 py-1 text-[11px] text-err">{error}</div>}
        </div>
    );
}

const SEQUENCE_MODE_LABEL: Record<SequenceMode, string> = {
    fixed: 'fixa embaixo da cena',
    auto: 'recolhida — aparece ao levar o mouse à borda de baixo',
    off: 'desligada',
};
const SEQUENCE_NEXT: Record<SequenceMode, SequenceMode> = { fixed: 'auto', auto: 'off', off: 'fixed' };

export function TopBar() {
    const workspace = useApp((s) => s.workspace);
    const past = useHistory((s) => s.past);
    const future = useHistory((s) => s.future);
    const tool = useApp((s) => s.tool);
    const sequenceMode = useApp((s) => s.sequenceMode);
    const [id, setId] = useState('');

    return (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-stroke bg-bg-1 px-2">
            <div className="flex items-center gap-1.5 pr-2 pl-1">
                <div className="brand-glow h-4 w-4 rounded-[5px] shadow-[0_0_12px_-2px_color-mix(in_srgb,var(--accent)_70%,transparent)]" />
                <span className="text-[13px] font-semibold tracking-tight">ProteinPaint</span>
            </div>
            <Segmented<Workspace>
                className="w-[182px] shrink-0"
                value={workspace}
                onChange={(w) => useApp.setState({ workspace: w })}
                options={[
                    { value: 'structure', label: <><Icon name="target" size={12} /> Estrutura</>, title: 'Visualização e cálculos (Alt+1…9)' },
                    { value: 'data', label: <><Icon name="chart" size={12} /> Dados</>, title: 'Tabela de designs, gráficos e painéis' },
                ]}
            />
            <div className="mx-1 h-5 w-px bg-stroke" />
            <Button icon="file" onClick={() => void openFiles()} title="Abrir arquivos (Ctrl+O)">
                Abrir
            </Button>
            <Button icon="open" onClick={() => void openFolder()} title="Abrir pasta de designs na biblioteca (Ctrl+Shift+O)">
                Pasta
            </Button>
            {workspace === 'structure' ? (
                <>
                    <TextInput
                        value={id}
                        onChange={setId}
                        onSubmit={(v) => {
                            void fetchId(v);
                            setId('');
                        }}
                        placeholder="PDB / UniProt"
                        className="mono w-28"
                    />
                    <div className="mx-1 h-5 w-px bg-stroke" />
                    <Segmented value={tool} options={TOOLS} onChange={setTool} className="w-[312px] shrink-0" />
                    <div className="mx-1 h-5 w-px bg-stroke" />
                    <SpecBox />
                    <div className="mx-1 h-5 w-px bg-stroke" />
                    <IconButton icon="undo" title="Desfazer (Ctrl+Z)" disabled={past.length === 0} onClick={() => void undo()} />
                    <IconButton icon="redo" title="Refazer (Ctrl+Y)" disabled={future.length === 0} onClick={() => void redo()} />
                    <div className="mx-1 h-5 w-px bg-stroke" />
                    <IconButton icon="focus" title="Focar na seleção (F)" onClick={() => { const v = viewer(); if (v) void run(E.focusSelection(v)); }} />
                    <IconButton icon="reset" title="Resetar vista (R)" onClick={() => { const v = viewer(); if (v) E.resetView(v); }} />
                    <IconButton
                        icon="seq"
                        title={`Trilha de sequência: ${SEQUENCE_MODE_LABEL[sequenceMode]} (clique para alternar: fixa → recolhida → desligada)`}
                        active={sequenceMode !== 'off'}
                        onClick={() => {
                            const next = SEQUENCE_NEXT[sequenceMode];
                            setSequenceMode(next);
                            toast(`Trilha de sequência: ${SEQUENCE_MODE_LABEL[next]}`, 'info', 1800);
                        }}
                    />
                    <IconButton icon="camera" title="Figura: vistas, exportar imagem e animação (Alt+8)" onClick={() => useApp.setState({ tab: 'figure' })} />
                </>
            ) : (
                <DataTopBarExtras />
            )}
        </header>
    );
}
