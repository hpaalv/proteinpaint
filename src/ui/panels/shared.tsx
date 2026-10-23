import * as E from '@/engine';
import { run, useApp, viewer } from '@/store/app';
import { useCompute } from '@/compute/store';
import { addHydrogens } from '@/compute/hydrogens';
import { Button, Segmented, Select, Spinner, Toggle } from '../components/Primitives';

export function useActive(): E.StructureInfo | null {
    return useApp((s) => s.structures.find((x) => x.id === s.activeId) ?? null);
}

export type TargetKind = 'selection' | 'structure' | 'chain';

/** "Apply to": the selection, the active structure, or one of its chains. */
export function TargetPicker({
    kind,
    chain,
    onKind,
    onChain,
}: {
    kind: TargetKind;
    chain: string;
    onKind: (k: TargetKind) => void;
    onChain: (c: string) => void;
}) {
    const active = useActive();
    const hasSelection = useApp((s) => s.selection !== null);
    const chains = active?.chains.filter((c) => c.isPolymer) ?? [];
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-text-1">Aplicar a</span>
            <Segmented<TargetKind>
                value={kind}
                onChange={onKind}
                options={[
                    { value: 'selection', label: hasSelection ? 'Seleção' : 'Seleção (vazia)' },
                    { value: 'structure', label: 'Estrutura' },
                    { value: 'chain', label: 'Cadeia' },
                ]}
            />
            {kind === 'chain' && chains.length > 0 && (
                <Select
                    value={chain || chains[0]!.authAsymId}
                    onChange={onChain}
                    options={chains.map((c) => ({ value: c.authAsymId, label: `${c.authAsymId}${c.alias ? ` · ${c.alias}` : ''} · ${E.CHAIN_ROLE_LABELS[c.role]}` }))}
                />
            )}
        </div>
    );
}

export function resolveTarget(kind: TargetKind, chain: string, active: E.StructureInfo | null): E.StyleTarget | null {
    if (kind === 'selection') return { kind: 'selection' };
    if (!active) return null;
    if (kind === 'structure') return { kind: 'structure', id: active.id };
    const c = chain || active.chains.find((x) => x.isPolymer)?.authAsymId;
    return c ? { kind: 'chain', id: active.id, chain: c } : null;
}

export function NoStructure() {
    return <p className="px-3 py-6 text-center text-[12px] text-text-2">Carregue uma estrutura.</p>;
}

/**
 * The hydrogen box that sits wherever H-bonds are drawn: show the polar hydrogens
 * (the ones a bond points at), all of them, or none — and, for a file without any,
 * a one-click way to add them, since an H-bond drawn to an invisible H reads wrong.
 */
export function HydrogenControl({ structure }: { structure: E.StructureInfo | null }) {
    const mode = useApp((s) => s.hydrogens);
    const adding = useCompute((s) => Object.values(s.jobs).some((j) => j.tool === 'hydrogens' && (j.state === 'queued' || j.state === 'running')));
    const set = (m: E.HydrogenDisplay) => {
        const v = viewer();
        if (!v) return;
        useApp.setState({ hydrogens: m });
        void run(E.setHydrogenDisplay(v, m));
    };
    const missing = structure !== null && structure.hydrogenCount === 0;
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
            <Toggle checked={mode !== 'none'} onChange={(x) => set(x ? 'polar' : 'none')} label="Mostrar hidrogênios" />
            {mode !== 'none' && <Toggle checked={mode === 'all'} onChange={(x) => set(x ? 'all' : 'polar')} label="Incluir os apolares (C–H)" />}
            {missing ? (
                <div className="flex items-center gap-2">
                    <span className="flex-1 text-[10.5px] leading-snug text-text-2">Este arquivo não tem hidrogênios.</span>
                    <Button onClick={() => structure && void addHydrogens(structure.id)} disabled={adding} title="PDB2PQR + PROPKA a pH 7; a estrutura é substituída pela versão com H">
                        {adding ? <Spinner size={12} /> : null}
                        Adicionar
                    </Button>
                </div>
            ) : (
                structure && <span className="text-[10.5px] text-text-2">{structure.hydrogenCount.toLocaleString('pt-BR')} hidrogênios no arquivo</span>
            )}
        </div>
    );
}

/** Interface sides from the chain roles: binder(s) against everything else, or first chain against the rest. */
export function defaultSides(s: E.StructureInfo): { a: string[]; b: string[] } {
    const polymer = s.chains.filter((c) => c.isPolymer);
    const binders = polymer.filter((c) => c.role === 'binder').map((c) => c.authAsymId);
    if (binders.length > 0) return { a: binders, b: polymer.filter((c) => c.role !== 'binder').map((c) => c.authAsymId) };
    return { a: polymer.slice(0, 1).map((c) => c.authAsymId), b: polymer.slice(1).map((c) => c.authAsymId) };
}
