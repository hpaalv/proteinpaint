import { useEffect, useState } from 'react';
import * as E from '@/engine';
import {
    CHAIN_PALETTES,
    CONTINUOUS_RAMPS,
    PAINT_SWATCHES,
    PLDDT_BANDS,
    RAMP_LABELS,
    hexToInt,
    intToHex,
    type ChainPaletteId,
} from '@/data/palettes';
import { run, useApp, viewer } from '@/store/app';
import { Button, Field, Section, Select, Slider, Swatch, Toggle, cx } from '../components/Primitives';
import { NoStructure, resolveTarget, TargetPicker, useActive, type TargetKind } from './shared';

const SCHEMES: E.ColorScheme[] = [
    'chain',
    'role',
    'entity',
    'uniform',
    'secondary-structure',
    'plddt',
    'b-factor',
    'hydrophobicity',
    'residue-charge',
    'rainbow',
    'element',
    'residue-name',
];

function RampBar({ ramp, domain }: { ramp: E.RampId; domain: [number, number] }) {
    return (
        <div className="flex flex-col gap-0.5">
            <div className="h-2.5 rounded-sm border border-black/30" style={{ background: `linear-gradient(to right, ${CONTINUOUS_RAMPS[ramp].join(',')})` }} />
            <div className="tnum flex justify-between text-[10.5px] text-text-1">
                <span>{domain[0].toFixed(1)}</span>
                <span>{domain[1].toFixed(1)}</span>
            </div>
        </div>
    );
}

function NumberBox({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(Number(value.toFixed(2)))), [value]);
    return (
        <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={() => {
                const n = Number(draft.replace(',', '.'));
                if (Number.isFinite(n)) onCommit(n);
                else setDraft(String(value));
            }}
            className="tnum h-7 w-full rounded-md border border-stroke-2 bg-bg-1 px-2 text-[12px] outline-none focus:border-accent"
        />
    );
}

export function ColorPanel() {
    const active = useActive();
    const [kind, setKind] = useState<TargetKind>('selection');
    const [chain, setChain] = useState('');
    const [transparency, setTransparencyValue] = useState(0.5);
    const [custom, setCustom] = useState('#4CC9F0');
    const [palette, setPalette] = useState<ChainPaletteId>(() => viewer()?.chainPalette ?? 'okabe-ito');
    useApp((s) => s.structures);

    if (!active) return <NoStructure />;
    const v = viewer();
    const entry = v?.entry(active.id);
    if (!v || !entry) return <NoStructure />;
    const settings = entry.color;
    const update = (patch: Partial<E.ColorSettings>) => void run(E.setColorSettings(v, active.id, patch));
    const target = resolveTarget(kind, chain, active);
    const domain = settings.domain ?? active.bfactorRange;

    return (
        <div>
            <Section title={`Esquema · ${active.alias || active.name}`}>
                <div className="grid grid-cols-2 gap-1">
                    {SCHEMES.map((s) => (
                        <button
                            key={s}
                            type="button"
                            onClick={() => update({ scheme: s })}
                            className={cx(
                                'h-7 rounded-md border px-2 text-left text-[12px] transition-colors duration-100',
                                settings.scheme === s ? 'border-accent bg-accent/12 text-accent' : 'border-stroke-2 bg-bg-2 text-text-0 hover:bg-bg-3',
                            )}
                        >
                            {E.COLOR_SCHEME_LABELS[s]}
                            {s === 'plddt' && active.looksLikePlddt && <span className="ml-1 text-[10px] text-ok">●</span>}
                        </button>
                    ))}
                </div>
                <Toggle checked={settings.heteroatomsByElement} onChange={(x) => update({ heteroatomsByElement: x })} label="Heteroátomos por elemento (N azul, O vermelho…)" />

                {(settings.scheme === 'chain' || settings.scheme === 'entity') && (
                    <Field label="Paleta de cadeias">
                        <Select<ChainPaletteId>
                            value={palette}
                            onChange={(p) => {
                                setPalette(p);
                                void run(E.setChainPalette(v, p));
                            }}
                            options={Object.values(CHAIN_PALETTES).map((p) => ({ value: p.id, label: p.label }))}
                        />
                        <div className="flex gap-1">
                            {CHAIN_PALETTES[palette].colors.map((c) => (
                                <span key={c} className="h-3 flex-1 rounded-sm" style={{ background: c }} />
                            ))}
                        </div>
                        <p className="text-[11px] text-text-2">{CHAIN_PALETTES[palette].note}</p>
                    </Field>
                )}

                {settings.scheme === 'uniform' && (
                    <div className="flex flex-wrap gap-1">
                        {PAINT_SWATCHES.map((c) => (
                            <Swatch key={c} color={c} active={hexToInt(c) === settings.uniform} onClick={() => update({ uniform: hexToInt(c) })} />
                        ))}
                        <input type="color" value={intToHex(settings.uniform)} onChange={(e) => update({ uniform: hexToInt(e.target.value) })} className="h-[18px] w-[26px]" />
                    </div>
                )}

                {settings.scheme === 'b-factor' && (
                    <div className="flex flex-col gap-2">
                        <Field label="Rampa">
                            <Select<E.RampId> value={settings.ramp} onChange={(ramp) => update({ ramp })} options={Object.entries(RAMP_LABELS).map(([value, label]) => ({ value: value as E.RampId, label }))} />
                        </Field>
                        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-1.5">
                            <Field label="Mín">
                                <NumberBox value={domain[0]} onCommit={(x) => update({ domain: [x, domain[1]] })} />
                            </Field>
                            <Field label="Máx">
                                <NumberBox value={domain[1]} onCommit={(x) => update({ domain: [domain[0], x] })} />
                            </Field>
                            <Button onClick={() => update({ domain: null })} title={`Faixa dos dados: ${active.bfactorRange[0].toFixed(1)}–${active.bfactorRange[1].toFixed(1)}`}>
                                Auto
                            </Button>
                        </div>
                        <RampBar ramp={settings.ramp} domain={domain} />
                    </div>
                )}

                {settings.scheme === 'plddt' && (
                    <div className="flex flex-col gap-1">
                        {PLDDT_BANDS.map((b) => (
                            <div key={b.label} className="flex items-center gap-2 text-[11.5px] text-text-1">
                                <span className="h-3 w-5 rounded-sm" style={{ background: b.color }} />
                                {b.label}
                            </div>
                        ))}
                        {!active.looksLikePlddt && <p className="text-[11px] text-warn">O B-factor deste arquivo não parece pLDDT (AF2/ColabFold); as cores podem não ter significado.</p>}
                    </div>
                )}
            </Section>

            <Section title="Pintar">
                <TargetPicker kind={kind} chain={chain} onKind={setKind} onChain={setChain} />
                <div className="flex flex-wrap gap-1">
                    {PAINT_SWATCHES.map((c) => (
                        <Swatch key={c} color={c} onClick={() => target && void run(E.colorTarget(v, target, hexToInt(c)))} />
                    ))}
                </div>
                <div className="flex items-center gap-1.5">
                    <input type="color" value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase())} className="h-7 w-9" />
                    <Button onClick={() => target && void run(E.colorTarget(v, target, hexToInt(custom)))}>Aplicar {custom}</Button>
                    <Button variant="ghost" onClick={() => target && void run(E.colorTarget(v, target, null))} title="Volta à cor do esquema">
                        Restaurar
                    </Button>
                </div>
                <Slider label="Transparência" value={transparency} min={0} max={1} onChange={setTransparencyValue} format={(x) => `${Math.round(x * 100)}%`} />
                <div className="flex gap-1.5">
                    <Button onClick={() => target && void run(E.setTransparency(v, target, transparency))}>Aplicar transparência</Button>
                    <Button variant="ghost" onClick={() => void run(E.clearPaint(v, active.id))}>
                        Limpar pintura
                    </Button>
                </div>
            </Section>
        </div>
    );
}
