import { useEffect, useState } from 'react';
import * as E from '@/engine';
import { run, toast, useApp, viewer } from '@/store/app';
import { act, record } from '@/store/history';
import { ActionRow, Button, Section, Segmented, Slider } from '../components/Primitives';
import { HydrogenControl, NoStructure, resolveTarget, TargetPicker, useActive, type TargetKind } from './shared';

type RibbonChoice = E.RibbonStyle | 'off';
type AtomChoice = E.AtomStyle | 'off';
type SurfaceChoice = E.SurfaceStyle | 'off';

const TARGET_ROLES: ReadonlySet<E.ChainRole> = new Set(['target', 'mhc', 'b2m', 'peptide']);

export function StylePanel() {
    const active = useActive();
    const [kind, setKind] = useState<TargetKind>('structure');
    const [chain, setChain] = useState('');
    const [atomSize, setAtomSize] = useState(1);
    const [opacity, setOpacity] = useState(1);
    const [atomStyle, setAtomStyle] = useState<AtomChoice>('sticks');
    // The sliders own their value: the engine call that applies it does not re-render
    // this panel, and reading back mid-drag would make the handle jump.
    const [layerAlpha, setLayerAlpha] = useState<Partial<Record<E.Layer, number>>>({});
    useApp((s) => s.structures); // re-render on structure changes
    const activeId = active?.id;
    useEffect(() => {
        const vv = viewer();
        setLayerAlpha(vv && activeId ? E.layerOpacities(vv, activeId) : {});
    }, [activeId, kind, chain]);

    if (!active) return <NoStructure />;
    const v = viewer();
    const target = resolveTarget(kind, chain, active);
    // Which layers this structure actually shows, and how transparent each one is:
    // a control for something that is not on screen is noise.
    const shown = v ? E.layerSummary(v, active.id) : [];
    const has = (layer: E.Layer) => shown.some((x) => x.layer === layer);

    const apply = async (layer: E.Layer, style: E.LayerStyle | null) => {
        if (!v || !target) return;
        const what = layer === 'ribbon' ? 'fita' : layer === 'atoms' ? 'átomos' : 'superfície';
        setLayerAlpha((a) => ({ ...a, [layer]: style && 'opacity' in style ? style.opacity : 1 }));
        await act(style ? `${what}: ${style.style}` : `ocultar ${what}`, () => E.setLayer(v, target, layer, style));
    };

    /** One-click looks designers reach for. */
    const preset = async (name: 'target-surface' | 'interface-sticks' | 'cartoon-only' | 'ligand-spheres') => {
        if (!v) return;
        record(`atalho: ${name}`);
        const id = active.id;
        const polymer = active.chains.filter((c) => c.isPolymer);
        if (name === 'cartoon-only') {
            await run(E.setLayer(v, { kind: 'structure', id }, 'atoms', null));
            await run(E.setLayer(v, { kind: 'structure', id }, 'surface', null));
            await run(E.setLayer(v, { kind: 'structure', id }, 'ribbon', { layer: 'ribbon', style: 'cartoon' }));
        }
        if (name === 'target-surface') {
            const targets = polymer.filter((c) => TARGET_ROLES.has(c.role));
            if (targets.length === 0) return toast('Nenhuma cadeia marcada como alvo/MHC. Ajuste os papéis na árvore.', 'error');
            for (const c of targets) {
                await run(E.setLayer(v, { kind: 'chain', id, chain: c.authAsymId }, 'surface', { layer: 'surface', style: 'molecular', opacity: 0.55 }));
            }
        }
        if (name === 'interface-sticks') {
            const binders = polymer.filter((c) => c.role === 'binder').map((c) => c.authAsymId);
            const others = polymer.filter((c) => c.role !== 'binder').map((c) => c.authAsymId);
            if (binders.length === 0 || others.length === 0) return toast('Marque ao menos uma cadeia como binder.', 'error');
            const sel = await run(E.selectInterface(v, id, binders, others, 4));
            if (sel === null) return;
            await run(E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1 }));
        }
        if (name === 'ligand-spheres') {
            const atoms = await run(E.selectHetero(v, id));
            if (atoms === null) return;
            if (atoms === 0) return toast('Esta estrutura não tem ligantes nem íons.', 'info');
            await run(E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'spheres', size: 1 }));
            E.clearSelection(v);
        }
    };

    return (
        <div>
            <Section title="Alvo">
                <TargetPicker kind={kind} chain={chain} onKind={setKind} onChain={setChain} />
            </Section>
            <Section title="Fita">
                <ActionRow<RibbonChoice>
                    onPick={(s) => void apply('ribbon', s === 'off' ? null : { layer: 'ribbon', style: s })}
                    options={[
                        { value: 'cartoon', label: 'Cartoon' },
                        { value: 'tube', label: 'Tubo' },
                        { value: 'backbone', label: 'Traço' },
                        { value: 'putty', label: 'Putty', title: 'Espessura por B-factor / pLDDT' },
                        { value: 'off', label: 'Ocultar' },
                    ]}
                />
                {has('ribbon') && (
                    <Slider
                        label="Transparência da fita"
                        value={1 - (layerAlpha.ribbon ?? 1)}
                        min={0}
                        max={0.95}
                        defaultValue={0}
                        onChange={(x) => {
                            setLayerAlpha((a) => ({ ...a, ribbon: 1 - x }));
                            if (v && target) void act('transparência da fita', () => E.setLayerOpacity(v, target, 'ribbon', 1 - x));
                        }}
                        format={(x) => (x < 0.01 ? 'opaca' : `${Math.round(x * 100)}%`)}
                    />
                )}
            </Section>
            <Section title="Átomos">
                <Segmented<AtomChoice>
                    value={atomStyle}
                    onChange={(s) => {
                        setAtomStyle(s);
                        void apply('atoms', s === 'off' ? null : { layer: 'atoms', style: s, size: atomSize });
                    }}
                    options={[
                        { value: 'sticks', label: 'Sticks' },
                        { value: 'ball-and-stick', label: 'Bola-vareta' },
                        { value: 'spheres', label: 'Esferas' },
                        { value: 'lines', label: 'Linhas' },
                        { value: 'off', label: 'Ocultar' },
                    ]}
                />
                <Slider label="Espessura" value={atomSize} min={0.3} max={2.5} step={0.05} onChange={setAtomSize} format={(x) => `${x.toFixed(2)}×`} />
                <Button
                    onClick={() => atomStyle !== 'off' && void apply('atoms', { layer: 'atoms', style: atomStyle, size: atomSize })}
                    disabled={atomStyle === 'off'}
                >
                    Aplicar espessura
                </Button>
                {has('atoms') && (
                    <Slider
                        label="Transparência dos átomos"
                        value={1 - (layerAlpha.atoms ?? 1)}
                        min={0}
                        max={0.95}
                        defaultValue={0}
                        onChange={(x) => {
                            setLayerAlpha((a) => ({ ...a, atoms: 1 - x }));
                            if (v && target) void act('transparência dos átomos', () => E.setLayerOpacity(v, target, 'atoms', 1 - x));
                        }}
                        format={(x) => (x < 0.01 ? 'opacos' : `${Math.round(x * 100)}%`)}
                    />
                )}
                <HydrogenControl structure={active} />
            </Section>
            <Section title="Superfície">
                <ActionRow<SurfaceChoice>
                    onPick={(s) => void apply('surface', s === 'off' ? null : { layer: 'surface', style: s, opacity })}
                    options={[
                        { value: 'molecular', label: 'Molecular (SES)' },
                        { value: 'gaussian', label: 'Gaussiana (GPU)' },
                        { value: 'off', label: 'Ocultar' },
                    ]}
                />
                {has('surface') ? (
                    <Slider
                        label="Opacidade da superfície"
                        value={layerAlpha.surface ?? opacity}
                        min={0.05}
                        max={1}
                        defaultValue={1}
                        onChange={(x) => {
                            setOpacity(x);
                            setLayerAlpha((a) => ({ ...a, surface: x }));
                            if (v && target) void act('opacidade da superfície', () => E.setLayerOpacity(v, target, 'surface', x));
                        }}
                        format={(x) => `${Math.round(x * 100)}%`}
                    />
                ) : (
                    <p className="text-[10.5px] text-text-2">A opacidade aparece aqui quando houver superfície.</p>
                )}
            </Section>
            <Section title="Atalhos de design">
                <div className="grid grid-cols-2 gap-1.5">
                    <Button onClick={() => void preset('target-surface')}>Alvo em superfície</Button>
                    <Button onClick={() => void preset('interface-sticks')}>Sticks da interface</Button>
                    <Button onClick={() => void preset('ligand-spheres')}>Ligantes em esferas</Button>
                    <Button onClick={() => void preset('cartoon-only')}>Só cartoon</Button>
                </div>
            </Section>
        </div>
    );
}
