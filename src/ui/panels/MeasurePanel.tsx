import { useState } from 'react';
import * as E from '@/engine';
import { run, toast, useApp, viewer } from '@/store/app';
import { setMeasureKind, setTool } from '@/store/actions';
import { platform } from '@/platform/bridge';
import { Button, Empty, IconButton, Section, Segmented, Slider, cx } from '../components/Primitives';
import { Icon } from '../components/Icon';

const KIND_LABEL: Record<E.MeasureKind, string> = { distance: 'Distância', angle: 'Ângulo', dihedral: 'Diedro' };

/** Measuring between two groups of atoms, rather than between four clicked ones. */
function BetweenSelections({ v }: { v: E.Viewer }) {
    const selection = useApp((s) => s.selection);
    const [sides, setSides] = useState(() => E.capturedSides(v));
    const [cutoff, setCutoff] = useState(4);
    const [result, setResult] = useState<E.PairMeasure | null>(null);

    const capture = (slot: 'a' | 'b') => {
        const r = E.captureSelection(v, slot);
        if (!r.ok) return toast(r.error, 'error');
        setSides(E.capturedSides(v));
        toast(`Lado ${slot.toUpperCase()}: ${r.value}`, 'ok', 2000);
    };

    return (
        <Section title="Entre duas seleções">
            <p className="text-[10.5px] leading-snug text-text-2">
                Selecione um conjunto, guarde como A; selecione outro, guarde como B. Mede a aproximação mais curta, a distância entre os centros e quantos pares estão em contato.
            </p>
            <div className="grid grid-cols-2 gap-1.5">
                <Button icon="select" onClick={() => capture('a')} disabled={!selection}>
                    Guardar como A
                </Button>
                <Button icon="select" onClick={() => capture('b')} disabled={!selection}>
                    Guardar como B
                </Button>
            </div>
            <div className="flex flex-col gap-0.5 text-[10.5px]">
                <span className={cx('truncate', sides.a ? 'text-accent' : 'text-text-2')}>A: {sides.a ?? 'nada guardado'}</span>
                <span className={cx('truncate', sides.b ? 'text-accent-2' : 'text-text-2')}>B: {sides.b ?? 'nada guardado'}</span>
            </div>
            <Slider label="Contato até" value={cutoff} min={2} max={8} step={0.1} defaultValue={4} onChange={setCutoff} format={(x) => `${x.toFixed(1)} Å`} />
            <div className="grid grid-cols-2 gap-1.5">
                <Button
                    variant="primary"
                    icon="ruler"
                    disabled={!sides.a || !sides.b}
                    onClick={async () => {
                        const r = await run(E.measureBetweenSelections(v, cutoff));
                        if (r) setResult(r);
                    }}
                >
                    Medir A ↔ B
                </Button>
                <Button
                    variant="ghost"
                    onClick={async () => {
                        await E.clearPairMeasure(v);
                        setSides({ a: null, b: null });
                        setResult(null);
                    }}
                >
                    Limpar
                </Button>
            </div>
            {result && (
                <div className="scale-in flex flex-col gap-1.5 rounded-md border border-stroke bg-bg-0 p-2">
                    <div className="grid grid-cols-3 gap-1 text-center">
                        <div>
                            <div className="tnum text-[15px] font-semibold text-accent">{result.minDistance.toFixed(2)}</div>
                            <div className="text-[9.5px] text-text-2">mais curta (Å)</div>
                        </div>
                        <div>
                            <div className="tnum text-[15px] font-semibold text-accent-2">{result.centroidDistance.toFixed(2)}</div>
                            <div className="text-[9.5px] text-text-2">entre centros (Å)</div>
                        </div>
                        <div>
                            <div className="tnum text-[15px] font-semibold">{result.contacts}</div>
                            <div className="text-[9.5px] text-text-2">pares ≤ {result.cutoff.toFixed(1)} Å</div>
                        </div>
                    </div>
                    <div className="mono text-[10.5px] leading-snug text-text-1">
                        {result.minPair[0]} — {result.minPair[1]}
                    </div>
                    <div className="text-[10px] text-text-2">
                        {result.atomsA} × {result.atomsB} átomos comparados · a linha azul marca o par mais próximo, a rosa liga os centros
                    </div>
                </div>
            )}
        </Section>
    );
}

export function MeasurePanel() {
    const tool = useApp((s) => s.tool);
    const kind = useApp((s) => s.measureKind);
    const measurements = useApp((s) => s.measurements);
    const v = viewer();
    if (!v) return null;

    const exportCsv = async () => {
        const rows = measurements.map((m) => [KIND_LABEL[m.kind], ...m.atoms, m.value.toFixed(3), m.unit].join(','));
        const csv = ['tipo,atomo1,atomo2,atomo3,atomo4,valor,unidade', ...rows].join('\n');
        const saved = await platform.saveText(csv, 'medidas.csv');
        if (saved.ok) toast('Medidas salvas.', 'ok', 2000);
    };

    return (
        <div>
            <Section title="Medir clicando">
                <Segmented<E.MeasureKind>
                    value={kind}
                    onChange={setMeasureKind}
                    options={[
                        { value: 'distance', label: 'Distância' },
                        { value: 'angle', label: 'Ângulo' },
                        { value: 'dihedral', label: 'Diedro' },
                    ]}
                />
                <Button variant={tool === 'measure' ? 'default' : 'primary'} icon="ruler" onClick={() => setTool(tool === 'measure' ? 'select' : 'measure')}>
                    {tool === 'measure' ? 'Sair do modo medida' : `Clicar átomos (${kind === 'distance' ? 2 : kind === 'angle' ? 3 : 4})`}
                </Button>
                {tool === 'measure' && (
                    <p className="fade-in flex items-center gap-1.5 text-[10.5px] text-accent">
                        <Icon name="cursor" size={11} /> Clique nos átomos; a medida fecha sozinha ao completar os pontos.
                    </p>
                )}
            </Section>

            <BetweenSelections v={v} />

            <Section
                title={`Medidas (${measurements.length})`}
                actions={
                    measurements.length > 0 ? (
                        <div className="flex gap-1">
                            <IconButton icon="download" size={22} title="Salvar em CSV" onClick={() => void exportCsv()} />
                            <IconButton
                                icon="trash"
                                size={22}
                                title="Limpar medidas e rótulos"
                                onClick={async () => {
                                    await E.clearMeasurements(v);
                                    // "Limpar" used to leave the residue labels behind (Fase 1).
                                    await E.clearLabels(v);
                                    await E.clearPairMeasure(v);
                                }}
                            />
                        </div>
                    ) : undefined
                }
            >
                {measurements.length === 0 ? (
                    <Empty>Nenhuma medida ainda.</Empty>
                ) : (
                    <div className="flex flex-col gap-1">
                        {measurements.map((m) => (
                            <div key={m.ref} className="scale-in flex items-center gap-1 rounded-md border border-stroke bg-bg-0 px-2 py-1">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[10px] text-text-2">{KIND_LABEL[m.kind]}</div>
                                    <div className="mono text-[11px] break-words text-text-0">{m.atoms.join(' — ')}</div>
                                </div>
                                <div className="tnum shrink-0 text-[13px] font-semibold text-accent">
                                    {m.value.toFixed(m.kind === 'distance' ? 2 : 1)}
                                    <span className="ml-0.5 text-[9.5px] font-normal text-text-2">{m.unit}</span>
                                </div>
                                <IconButton icon="trash" size={22} title="Remover" onClick={() => void E.removeMeasurement(v, m.ref)} />
                            </div>
                        ))}
                    </div>
                )}
            </Section>
        </div>
    );
}
