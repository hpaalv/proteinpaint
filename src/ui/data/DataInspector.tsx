import { useState } from 'react';
import * as E from '@/engine';
import type { Column, ColumnKind, Dataset } from '@/dataset/types';
import { CHART_TYPES, type ChartSpec, type ChartType, type Gate, type Panel, type StructureCellSpec } from '@/panels/types';
import { RAMPS, SERIES_PALETTES, THEMES, type RampId, type SeriesPaletteId, type ThemeId } from '@/panels/theme';
import { gateLabel } from '@/panels/charts';
import {
    addPanel,
    duplicatePanel,
    patchChart,
    patchPanel,
    patchStructure,
    patchText,
    removeCell,
    removePanel,
    selectPanel,
    useData,
} from '@/store/data';
import { exportPanelImage, exportCellImage, exportTableCsv } from '@/store/dataActions';
import { Button, Field, IconButton, Section, Segmented, Select, Slider, TextInput, Toggle, cx } from '../components/Primitives';
import { useActiveCell, useActivePanel } from './hooks';

// ---------------------------------------------------------------------------
// Column pickers
// ---------------------------------------------------------------------------

function columnsOf(dataset: Dataset, kinds?: ColumnKind[]): Column[] {
    return kinds ? dataset.columns.filter((c) => kinds.includes(c.kind)) : dataset.columns;
}

function ColumnSelect({
    dataset,
    value,
    onChange,
    kinds,
    allowEmpty,
    label,
}: {
    dataset: Dataset;
    value: string | undefined;
    onChange: (key: string | undefined) => void;
    kinds?: ColumnKind[];
    allowEmpty?: boolean;
    label: string;
}) {
    const options = columnsOf(dataset, kinds);
    return (
        <Field label={label}>
            <Select
                value={value ?? ''}
                onChange={(v) => onChange(v || undefined)}
                options={[...(allowEmpty ? [{ value: '', label: '— nenhum —' }] : []), ...options.map((c) => ({ value: c.key, label: c.unit ? `${c.label} (${c.unit})` : c.label }))]}
            />
        </Field>
    );
}

function MultiColumnSelect({ dataset, values, onChange, kinds, label }: { dataset: Dataset; values: string[]; onChange: (keys: string[]) => void; kinds?: ColumnKind[]; label: string }) {
    const [query, setQuery] = useState('');
    const options = columnsOf(dataset, kinds).filter((c) => !query || c.label.toLowerCase().includes(query.toLowerCase()) || c.key.toLowerCase().includes(query.toLowerCase()));
    return (
        <Field label={`${label} · ${values.length} escolhida${values.length === 1 ? '' : 's'}`}>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="filtrar métricas…"
                className="h-6 w-full rounded border border-stroke-2 bg-bg-1 px-2 text-[11.5px] outline-none focus:border-accent"
            />
            <div className="scroll-themed max-h-44 overflow-y-auto rounded-md border border-stroke bg-bg-1 p-1">
                {options.map((c) => {
                    const on = values.includes(c.key);
                    return (
                        <button
                            key={c.key}
                            type="button"
                            onClick={() => onChange(on ? values.filter((k) => k !== c.key) : [...values, c.key])}
                            className={cx('flex h-6 w-full items-center gap-1.5 rounded px-1.5 text-left text-[11.5px] transition-colors', on ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-3')}
                        >
                            <span className={cx('h-2.5 w-2.5 shrink-0 rounded-[3px] border', on ? 'border-accent bg-accent' : 'border-stroke-2')} />
                            <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        </button>
                    );
                })}
            </div>
            {values.length > 0 && (
                <button type="button" onClick={() => onChange([])} className="self-start text-[10.5px] text-text-2 hover:text-text-0">
                    limpar
                </button>
            )}
        </Field>
    );
}

// ---------------------------------------------------------------------------
// Chart menus
// ---------------------------------------------------------------------------

const CHART_ORDER: ChartType[] = ['scatter', 'histogram', 'violin', 'box', 'bar', 'stacked', 'line', 'heatmap', 'correlation', 'dumbbell', 'parallel', 'funnel'];

/** A tiny glyph per chart type — faster to recognise than a label alone. */
function ChartGlyph({ type, className }: { type: ChartType; className?: string }) {
    const paths: Record<ChartType, React.ReactNode> = {
        scatter: (
            <>
                <circle cx="6" cy="16" r="2" />
                <circle cx="11" cy="9" r="2" />
                <circle cx="17" cy="12" r="2" />
                <circle cx="19" cy="6" r="2" />
            </>
        ),
        histogram: (
            <>
                <rect x="4" y="12" width="3.4" height="8" />
                <rect x="8.5" y="7" width="3.4" height="13" />
                <rect x="13" y="10" width="3.4" height="10" />
                <rect x="17.5" y="15" width="3.4" height="5" />
            </>
        ),
        violin: (
            <>
                <path d="M8 4c3 3 3 13 0 16-3-3-3-13 0-16z" />
                <path d="M17 6c2.5 2.5 2.5 9.5 0 12-2.5-2.5-2.5-9.5 0-12z" />
            </>
        ),
        box: (
            <>
                <rect x="5" y="8" width="6" height="8" />
                <path d="M8 4v4M8 16v4" />
                <rect x="14" y="10" width="6" height="6" />
                <path d="M17 6v4M17 16v3" />
            </>
        ),
        bar: (
            <>
                <rect x="4" y="9" width="4" height="11" />
                <rect x="10" y="5" width="4" height="15" />
                <rect x="16" y="13" width="4" height="7" />
            </>
        ),
        stacked: (
            <>
                <rect x="5" y="13" width="5" height="7" />
                <rect x="5" y="7" width="5" height="5" />
                <rect x="14" y="11" width="5" height="9" />
                <rect x="14" y="5" width="5" height="5" />
            </>
        ),
        line: <path d="M4 17l5-6 4 3 7-9" />,
        heatmap: (
            <>
                <rect x="4" y="5" width="6" height="6" />
                <rect x="12" y="5" width="6" height="6" />
                <rect x="4" y="13" width="6" height="6" />
                <rect x="12" y="13" width="6" height="6" />
            </>
        ),
        correlation: (
            <>
                <rect x="4" y="4" width="7" height="7" />
                <rect x="13" y="13" width="7" height="7" />
                <path d="M4 20l16-16" />
            </>
        ),
        dumbbell: (
            <>
                <circle cx="7" cy="8" r="2" />
                <circle cx="17" cy="16" r="2" />
                <path d="M8.6 9.6l6.8 4.8" />
            </>
        ),
        parallel: (
            <>
                <path d="M5 4v16M12 4v16M19 4v16" />
                <path d="M5 9l7 6 7-8" />
            </>
        ),
        funnel: <path d="M4 5h16l-6 7v7l-4-2v-5z" />,
    };
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
            {paths[type]}
        </svg>
    );
}

function ChartTypeGallery({ value, onChange }: { value: ChartType; onChange: (t: ChartType) => void }) {
    return (
        <div className="grid grid-cols-4 gap-1">
            {CHART_ORDER.map((t) => (
                <button
                    key={t}
                    type="button"
                    title={CHART_TYPES[t].hint}
                    onClick={() => onChange(t)}
                    className={cx(
                        'press flex h-[46px] flex-col items-center justify-center gap-0.5 rounded-md border text-[9.5px]',
                        value === t ? 'border-accent bg-accent/12 text-accent' : 'border-stroke-2 bg-bg-2 text-text-2 hover:border-text-2 hover:text-text-0',
                    )}
                >
                    <ChartGlyph type={t} />
                    {CHART_TYPES[t].label.split(' ')[0]}
                </button>
            ))}
        </div>
    );
}

function PalettePicker({ value, onChange }: { value: SeriesPaletteId; onChange: (v: SeriesPaletteId) => void }) {
    return (
        <Field label="Paleta das séries">
            <div className="flex flex-col gap-1">
                {(Object.keys(SERIES_PALETTES) as SeriesPaletteId[]).map((id) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => onChange(id)}
                        className={cx('press flex items-center gap-2 rounded-md border px-1.5 py-1', value === id ? 'border-accent bg-accent/10' : 'border-stroke-2 hover:border-text-2')}
                    >
                        <span className="flex gap-0.5">
                            {SERIES_PALETTES[id].slice(0, 7).map((c) => (
                                <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
                            ))}
                        </span>
                        <span className={cx('text-[10.5px]', value === id ? 'text-accent' : 'text-text-2')}>{id}</span>
                    </button>
                ))}
            </div>
        </Field>
    );
}

function RampPicker({ value, onChange }: { value: RampId; onChange: (v: RampId) => void }) {
    return (
        <Field label="Escala de cor">
            <div className="grid grid-cols-2 gap-1">
                {(Object.keys(RAMPS) as RampId[]).map((id) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => onChange(id)}
                        className={cx('press flex flex-col gap-1 rounded-md border p-1', value === id ? 'border-accent' : 'border-stroke-2 hover:border-text-2')}
                    >
                        <span className="h-2.5 w-full rounded-[3px]" style={{ background: `linear-gradient(90deg, ${RAMPS[id].join(',')})` }} />
                        <span className={cx('text-[10px]', value === id ? 'text-accent' : 'text-text-2')}>{id}</span>
                    </button>
                ))}
            </div>
        </Field>
    );
}

function ReferenceEditor({ spec, cellId }: { spec: ChartSpec; cellId: string }) {
    const lines = spec.reference ?? [];
    return (
        <Field label="Linhas de referência">
            {lines.map((r, i) => (
                <div key={i} className="flex items-center gap-1">
                    <Segmented<'x' | 'y'>
                        className="w-[76px] shrink-0"
                        value={r.axis}
                        onChange={(axis) => patchChart(cellId, { reference: lines.map((l, k) => (k === i ? { ...l, axis } : l)) })}
                        options={[
                            { value: 'x', label: 'X' },
                            { value: 'y', label: 'Y' },
                        ]}
                    />
                    <input
                        type="number"
                        value={r.value}
                        onChange={(e) => patchChart(cellId, { reference: lines.map((l, k) => (k === i ? { ...l, value: Number(e.target.value) } : l)) })}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="tnum h-6 w-16 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent"
                    />
                    <input
                        value={r.label ?? ''}
                        placeholder="rótulo"
                        onChange={(e) => patchChart(cellId, { reference: lines.map((l, k) => (k === i ? { ...l, label: e.target.value } : l)) })}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="h-6 min-w-0 flex-1 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent"
                    />
                    <IconButton icon="trash" size={20} title="Remover" onClick={() => patchChart(cellId, { reference: lines.filter((_, k) => k !== i) })} />
                </div>
            ))}
            <Button icon="plus" variant="ghost" onClick={() => patchChart(cellId, { reference: [...lines, { axis: 'y', value: 0 }] })}>
                Adicionar linha
            </Button>
        </Field>
    );
}

function GateEditor({ dataset, spec, cellId }: { dataset: Dataset; spec: ChartSpec; cellId: string }) {
    const gates = spec.gates ?? [];
    const numeric = dataset.columns.filter((c) => c.kind === 'number');
    const update = (i: number, patch: Partial<Gate>) => patchChart(cellId, { gates: gates.map((g, k) => (k === i ? { ...g, ...patch } : g)) });
    return (
        <Field label="Critérios cumulativos">
            {gates.map((g, i) => (
                <div key={i} className="flex items-center gap-1">
                    <span className="tnum w-4 shrink-0 text-center text-[10px] text-text-2">{i + 1}</span>
                    <Select className="min-w-0 flex-1" value={g.key} onChange={(key) => update(i, { key })} options={numeric.map((c) => ({ value: c.key, label: c.label }))} />
                    <Select
                        className="w-14 shrink-0"
                        value={g.op}
                        onChange={(op) => update(i, { op: op as Gate['op'] })}
                        options={[
                            { value: '>=', label: '≥' },
                            { value: '<=', label: '≤' },
                            { value: '>', label: '>' },
                            { value: '<', label: '<' },
                            { value: '==', label: '=' },
                        ]}
                    />
                    <input
                        type="number"
                        step="any"
                        value={g.value}
                        onChange={(e) => update(i, { value: Number(e.target.value) })}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="tnum h-6 w-16 shrink-0 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent"
                    />
                    <IconButton icon="trash" size={20} title="Remover critério" onClick={() => patchChart(cellId, { gates: gates.filter((_, k) => k !== i) })} />
                </div>
            ))}
            <Button
                icon="plus"
                variant="ghost"
                onClick={() => {
                    const col = numeric[0];
                    if (col) patchChart(cellId, { gates: [...gates, { key: col.key, op: '>=', value: Number((col.range?.[0] ?? 0).toFixed(2)) }] });
                }}
            >
                Adicionar critério
            </Button>
            {gates.length > 0 && <p className="text-[10px] leading-snug text-text-2">{gates.map((g) => gateLabel(dataset, g)).join(' · ')}</p>}
        </Field>
    );
}

function ChartMenus({ dataset, cellId, spec }: { dataset: Dataset; cellId: string; spec: ChartSpec }) {
    const info = CHART_TYPES[spec.type];
    const numericKinds: ColumnKind[] = ['number'];
    const catKinds: ColumnKind[] = ['category', 'text', 'number'];
    const has = (e: string) => info.encodings.includes(e as never);

    return (
        <>
            <Section title="Tipo de gráfico">
                <ChartTypeGallery value={spec.type} onChange={(type) => patchChart(cellId, { type })} />
                <p className="text-[10.5px] leading-snug text-text-2">{info.hint}</p>
            </Section>

            <Section title="Dados">
                {has('x') && (
                    <ColumnSelect
                        dataset={dataset}
                        label={spec.type === 'histogram' ? 'Métrica' : spec.type === 'violin' || spec.type === 'box' || spec.type === 'bar' || spec.type === 'stacked' || spec.type === 'dumbbell' ? 'Agrupar por' : 'Eixo X'}
                        value={spec.x}
                        kinds={spec.type === 'histogram' || spec.type === 'scatter' || spec.type === 'line' ? numericKinds : catKinds}
                        allowEmpty={spec.type === 'violin' || spec.type === 'box' || spec.type === 'dumbbell'}
                        onChange={(x) => patchChart(cellId, { x })}
                    />
                )}
                {has('y') && <ColumnSelect dataset={dataset} label={spec.type === 'bar' ? 'Valor (vazio = contagem)' : 'Eixo Y'} value={spec.y} kinds={numericKinds} allowEmpty={spec.type === 'bar'} onChange={(y) => patchChart(cellId, { y })} />}
                {has('y2') && <ColumnSelect dataset={dataset} label="Segunda métrica" value={spec.y2} kinds={numericKinds} allowEmpty onChange={(y2) => patchChart(cellId, { y2 })} />}
                {has('group') && <ColumnSelect dataset={dataset} label={spec.type === 'stacked' ? 'Empilhar por' : 'Separar séries por'} value={spec.group} kinds={['category', 'text']} allowEmpty onChange={(group) => patchChart(cellId, { group })} />}
                {has('color') && <ColumnSelect dataset={dataset} label="Cor por" value={spec.color} allowEmpty onChange={(color) => patchChart(cellId, { color })} />}
                {has('size') && <ColumnSelect dataset={dataset} label="Tamanho por" value={spec.size} kinds={numericKinds} allowEmpty onChange={(size) => patchChart(cellId, { size })} />}
                {has('rowKey') && <ColumnSelect dataset={dataset} label="Linhas (vazio = um design por linha)" value={spec.rowKey} kinds={['category', 'text']} allowEmpty onChange={(rowKey) => patchChart(cellId, { rowKey })} />}
                {has('columns') && <MultiColumnSelect dataset={dataset} label="Métricas" values={spec.columns ?? []} kinds={numericKinds} onChange={(columns) => patchChart(cellId, { columns })} />}
                {spec.type === 'funnel' && <GateEditor dataset={dataset} spec={spec} cellId={cellId} />}
                {(spec.type === 'bar' || spec.type === 'heatmap' || spec.type === 'dumbbell' || spec.type === 'line') && (
                    <Field label="Agregação">
                        <Select
                            value={spec.aggregate ?? 'mean'}
                            onChange={(v) => patchChart(cellId, { aggregate: v as ChartSpec['aggregate'] })}
                            options={[
                                { value: 'mean', label: 'média' },
                                { value: 'median', label: 'mediana' },
                                { value: 'max', label: 'máximo' },
                                { value: 'min', label: 'mínimo' },
                                { value: 'count', label: 'contagem' },
                                { value: 'sum', label: 'soma' },
                            ]}
                        />
                    </Field>
                )}
            </Section>

            <Section title="Títulos e eixos">
                <Field label="Título do gráfico">
                    <TextInput value={spec.title} onChange={(title) => patchChart(cellId, { title })} placeholder="sem título" />
                </Field>
                <Field label="Subtítulo">
                    <TextInput value={spec.subtitle ?? ''} onChange={(subtitle) => patchChart(cellId, { subtitle })} placeholder="opcional" />
                </Field>
                {spec.type !== 'funnel' && spec.type !== 'correlation' && spec.type !== 'heatmap' && spec.type !== 'parallel' && (
                    <>
                        <Field label="Nome do eixo X">
                            <TextInput value={spec.xLabel ?? ''} onChange={(xLabel) => patchChart(cellId, { xLabel })} placeholder="padrão: nome da coluna" />
                        </Field>
                        <Field label="Nome do eixo Y">
                            <TextInput value={spec.yLabel ?? ''} onChange={(yLabel) => patchChart(cellId, { yLabel })} placeholder="padrão: nome da coluna" />
                        </Field>
                        <div className="flex gap-4">
                            <Toggle checked={spec.xLog ?? false} onChange={(xLog) => patchChart(cellId, { xLog })} label="X log" />
                            <Toggle checked={spec.yLog ?? false} onChange={(yLog) => patchChart(cellId, { yLog })} label="Y log" />
                        </div>
                    </>
                )}
            </Section>

            <Section title="Aparência">
                {(spec.type === 'heatmap' || spec.type === 'correlation' || (spec.type === 'scatter' && spec.color)) && <RampPicker value={spec.ramp ?? 'ocean'} onChange={(ramp) => patchChart(cellId, { ramp })} />}
                {spec.type === 'heatmap' && (
                    <Field label="Centro da escala (diverge aqui)">
                        <TextInput
                            value={spec.rampCenter === null || spec.rampCenter === undefined ? '' : String(spec.rampCenter)}
                            onChange={(v) => patchChart(cellId, { rampCenter: v.trim() === '' ? null : Number(v) })}
                            placeholder="ex.: 1 para retenção"
                            mono
                        />
                    </Field>
                )}
                {spec.type !== 'heatmap' && spec.type !== 'correlation' && <PalettePicker value={spec.palette ?? 'okabe-ito'} onChange={(palette) => patchChart(cellId, { palette })} />}
                {(spec.type === 'scatter' || spec.type === 'violin' || spec.type === 'box' || spec.type === 'line' || spec.type === 'dumbbell') && (
                    <Slider label="Tamanho dos pontos" value={spec.markerSize ?? 9} min={3} max={22} step={0.5} defaultValue={9} onChange={(markerSize) => patchChart(cellId, { markerSize })} format={(v) => v.toFixed(1)} />
                )}
                {spec.type === 'scatter' && <Slider label="Opacidade" value={spec.opacity ?? 0.9} min={0.1} max={1} step={0.05} defaultValue={0.9} onChange={(opacity) => patchChart(cellId, { opacity })} format={(v) => `${Math.round(v * 100)}%`} />}
                {spec.type === 'line' && <Slider label="Espessura da linha" value={spec.lineWidth ?? 2} min={0.5} max={6} step={0.5} defaultValue={2} onChange={(lineWidth) => patchChart(cellId, { lineWidth })} format={(v) => v.toFixed(1)} />}
                {spec.type === 'histogram' && (
                    <Slider
                        label="Número de faixas"
                        value={spec.bins ?? 0}
                        min={0}
                        max={60}
                        step={1}
                        defaultValue={0}
                        onChange={(bins) => patchChart(cellId, { bins })}
                        format={(v) => (v === 0 ? 'automático' : v.toFixed(0))}
                    />
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <Toggle checked={spec.showLegend !== false} onChange={(showLegend) => patchChart(cellId, { showLegend })} label="Legenda" />
                    <Toggle checked={spec.showGrid !== false} onChange={(showGrid) => patchChart(cellId, { showGrid })} label="Grade" />
                    {(spec.type === 'bar' || spec.type === 'stacked' || spec.type === 'heatmap' || spec.type === 'correlation') && (
                        <Toggle checked={spec.showValues ?? false} onChange={(showValues) => patchChart(cellId, { showValues })} label="Valores" />
                    )}
                    {spec.type === 'scatter' && <Toggle checked={spec.trend ?? false} onChange={(trend) => patchChart(cellId, { trend })} label="Tendência" />}
                    {(spec.type === 'scatter' || spec.type === 'correlation') && <Toggle checked={spec.showStats ?? false} onChange={(showStats) => patchChart(cellId, { showStats })} label="Correlação" />}
                    {(spec.type === 'violin' || spec.type === 'box') && (
                        <>
                            <Toggle checked={spec.showBox ?? true} onChange={(showBox) => patchChart(cellId, { showBox })} label="Quartis" />
                            <Toggle checked={spec.showPoints ?? spec.type === 'box'} onChange={(showPoints) => patchChart(cellId, { showPoints })} label="Pontos" />
                        </>
                    )}
                    {spec.type === 'line' && <Toggle checked={spec.showBand ?? false} onChange={(showBand) => patchChart(cellId, { showBand })} label="Banda de erro" />}
                    {spec.type === 'stacked' && <Toggle checked={spec.normalize ?? true} onChange={(normalize) => patchChart(cellId, { normalize })} label="Porcentagem" />}
                </div>
                {spec.type === 'scatter' && (
                    <Slider label="Rotular os maiores" value={spec.labelTop ?? 0} min={0} max={25} step={1} defaultValue={0} onChange={(labelTop) => patchChart(cellId, { labelTop })} format={(v) => (v === 0 ? 'nenhum' : `${v} designs`)} />
                )}
                {(spec.type === 'bar' || spec.type === 'dumbbell' || spec.type === 'heatmap') && (
                    <>
                        <Field label="Ordenar">
                            <Select
                                value={spec.sort ?? 'value-desc'}
                                onChange={(v) => patchChart(cellId, { sort: v as ChartSpec['sort'] })}
                                options={[
                                    { value: 'value-desc', label: 'maior valor primeiro' },
                                    { value: 'value-asc', label: 'menor valor primeiro' },
                                    { value: 'label', label: 'por nome' },
                                    { value: 'natural', label: 'ordem da tabela' },
                                ]}
                            />
                        </Field>
                        <Slider label="Mostrar no máximo" value={spec.limit ?? 0} min={0} max={60} step={1} defaultValue={0} onChange={(limit) => patchChart(cellId, { limit })} format={(v) => (v === 0 ? 'tudo' : `${v}`)} />
                    </>
                )}
                {spec.type === 'correlation' && (
                    <Field label="Coeficiente">
                        <Segmented<'pearson' | 'spearman'>
                            value={spec.method ?? 'pearson'}
                            onChange={(method) => patchChart(cellId, { method })}
                            options={[
                                { value: 'pearson', label: 'Pearson' },
                                { value: 'spearman', label: 'Spearman' },
                            ]}
                        />
                    </Field>
                )}
            </Section>

            {spec.type !== 'funnel' && spec.type !== 'parallel' && (
                <Section title="Referências" defaultOpen={false}>
                    <ReferenceEditor spec={spec} cellId={cellId} />
                </Section>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Structure and text menus
// ---------------------------------------------------------------------------

function StructureMenus({ dataset, cellId, spec }: { dataset: Dataset; cellId: string; spec: StructureCellSpec }) {
    const rows = dataset.rows.filter((r) => r.structurePath);
    return (
        <>
            <Section title="Estrutura">
                <Field label="Mostrar">
                    <Segmented<'selected' | 'row' | 'file'>
                        value={spec.source.kind}
                        onChange={(kind) =>
                            patchStructure(cellId, {
                                source:
                                    kind === 'selected'
                                        ? { kind: 'selected' }
                                        : kind === 'row'
                                          ? { kind: 'row', rowId: rows[0]?.id ?? '' }
                                          : { kind: 'file', path: dataset.loose[0]?.path ?? '' },
                            })
                        }
                        options={[
                            { value: 'selected', label: 'Seleção', title: 'Segue o design clicado nos gráficos' },
                            { value: 'row', label: 'Fixo' },
                            { value: 'file', label: 'Arquivo' },
                        ]}
                    />
                </Field>
                {spec.source.kind === 'row' && (
                    <Select
                        value={spec.source.rowId}
                        onChange={(rowId) => patchStructure(cellId, { source: { kind: 'row', rowId } })}
                        options={rows.map((r) => ({ value: r.id, label: r.id }))}
                    />
                )}
                {spec.source.kind === 'file' && (
                    <Select
                        value={spec.source.path}
                        onChange={(path) => patchStructure(cellId, { source: { kind: 'file', path } })}
                        options={dataset.loose.map((l) => ({ value: l.path, label: `${l.group}/${l.name}` }))}
                    />
                )}
                {dataset.loose.length > 0 && (
                    <Field label="Carregar junto (alvo, referência)">
                        <div className="flex flex-col gap-1">
                            {dataset.loose.map((l) => {
                                const on = spec.withFiles.includes(l.path);
                                return (
                                    <button
                                        key={l.path}
                                        type="button"
                                        onClick={() => patchStructure(cellId, { withFiles: on ? spec.withFiles.filter((p) => p !== l.path) : [...spec.withFiles, l.path] })}
                                        className={cx('flex h-6 items-center gap-1.5 rounded px-1.5 text-left text-[11px]', on ? 'bg-accent/15 text-accent' : 'text-text-2 hover:bg-bg-3 hover:text-text-0')}
                                    >
                                        <span className={cx('h-2.5 w-2.5 shrink-0 rounded-[3px] border', on ? 'border-accent bg-accent' : 'border-stroke-2')} />
                                        <span className="mono min-w-0 flex-1 truncate">{l.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </Field>
                )}
                <Field label="Título da célula">
                    <TextInput value={spec.title} onChange={(title) => patchStructure(cellId, { title })} placeholder="sem título" />
                </Field>
            </Section>
            <Section title="Visual 3D">
                <Field label="Estilo">
                    <Select
                        value={spec.look}
                        onChange={(look) => patchStructure(cellId, { look })}
                        options={(Object.keys(E.LOOK_PRESETS) as E.LookPreset[]).map((p) => ({ value: p, label: E.LOOK_PRESETS[p].label }))}
                    />
                </Field>
                <Field label="Vista">
                    <Select
                        value={spec.view}
                        onChange={(view) => patchStructure(cellId, { view: view as StructureCellSpec['view'] })}
                        options={[
                            { value: 'auto', label: 'Automática' },
                            { value: 'side', label: 'Lateral' },
                            { value: 'top', label: 'Topo' },
                            { value: 'threequarter', label: '¾' },
                            { value: 'groove', label: 'Sulco' },
                            { value: 'back', label: 'Verso' },
                        ]}
                    />
                </Field>
                <Field label="Cor">
                    <Select
                        value={spec.colorBy}
                        onChange={(colorBy) => patchStructure(cellId, { colorBy: colorBy as StructureCellSpec['colorBy'] })}
                        options={[
                            { value: 'role', label: 'Papel da cadeia' },
                            { value: 'chain', label: 'Cadeia' },
                            { value: 'plddt', label: 'pLDDT' },
                            { value: 'secondary-structure', label: 'Estrutura secundária' },
                            { value: 'uniform', label: 'Cor única' },
                        ]}
                    />
                </Field>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <Toggle checked={spec.surface} onChange={(surface) => patchStructure(cellId, { surface })} label="Superfície no alvo" />
                    <Toggle checked={spec.interface} onChange={(v) => patchStructure(cellId, { interface: v })} label="Interações" />
                    <Toggle checked={spec.spin} onChange={(spin) => patchStructure(cellId, { spin })} label="Girar" />
                </div>
            </Section>
        </>
    );
}

// ---------------------------------------------------------------------------
// Panel menus
// ---------------------------------------------------------------------------

function PanelMenus({ panel }: { panel: Panel }) {
    const panels = useData((s) => s.panels);
    return (
        <>
            <Section title="Painel">
                <div className="flex gap-1">
                    <Select className="min-w-0 flex-1" value={panel.id} onChange={selectPanel} options={panels.map((p) => ({ value: p.id, label: p.title }))} />
                    <IconButton icon="plus" size={26} title="Novo painel" onClick={addPanel} />
                    <IconButton icon="layers" size={26} title="Duplicar painel" onClick={duplicatePanel} />
                    <IconButton icon="trash" size={26} title="Remover painel" onClick={() => removePanel(panel.id)} />
                </div>
                <Field label="Título">
                    <TextInput value={panel.title} onChange={(title) => patchPanel({ title })} />
                </Field>
                <Field label="Subtítulo">
                    <TextInput value={panel.subtitle} onChange={(subtitle) => patchPanel({ subtitle })} placeholder="opcional" />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Slider label="Colunas" value={panel.cols} min={1} max={6} step={1} defaultValue={2} onChange={(cols) => patchPanel({ cols })} format={(v) => v.toFixed(0)} />
                    <Slider label="Linhas" value={panel.rows} min={1} max={8} step={1} defaultValue={2} onChange={(rows) => patchPanel({ rows })} format={(v) => v.toFixed(0)} />
                </div>
                <Slider label="Espaço entre células" value={panel.gap} min={0} max={32} step={1} defaultValue={12} onChange={(gap) => patchPanel({ gap })} format={(v) => `${v.toFixed(0)} px`} />
                <Toggle checked={panel.letters} onChange={(letters) => patchPanel({ letters })} label="Letras nas células (A, B, C)" />
            </Section>
            <Section title="Tema">
                <Segmented<ThemeId>
                    value={panel.theme}
                    onChange={(theme) => patchPanel({ theme })}
                    options={(Object.keys(THEMES) as ThemeId[]).map((id) => ({ value: id, label: THEMES[id].label }))}
                />
                <Field label="Fundo ao exportar">
                    <Segmented<Panel['background']>
                        value={panel.background}
                        onChange={(background) => patchPanel({ background })}
                        options={[
                            { value: 'theme', label: 'Do tema' },
                            { value: 'white', label: 'Branco' },
                            { value: 'transparent', label: 'Transparente' },
                        ]}
                    />
                </Field>
            </Section>
        </>
    );
}

function ExportSection({ panel }: { panel: Panel }) {
    const [dpi, setDpi] = useState(300);
    const [includeTitle, setIncludeTitle] = useState(true);
    const [transparent, setTransparent] = useState(panel.background === 'transparent');
    const cell = useActiveCell();
    const busy = useData((s) => s.exporting);
    return (
        <Section title="Exportar">
            <div className="grid grid-cols-2 gap-2">
                <Field label="Largura">
                    <Segmented<string>
                        value={String(panel.widthMm)}
                        onChange={(v) => patchPanel({ widthMm: Number(v) })}
                        options={[
                            { value: '85', label: '85 mm' },
                            { value: '120', label: '120' },
                            { value: '180', label: '180' },
                        ]}
                    />
                </Field>
                <Field label="Resolução">
                    <Segmented<string>
                        value={String(dpi)}
                        onChange={(v) => setDpi(Number(v))}
                        options={[
                            { value: '150', label: '150' },
                            { value: '300', label: '300 dpi' },
                            { value: '600', label: '600' },
                        ]}
                    />
                </Field>
            </div>
            <Toggle checked={transparent} onChange={setTransparent} label="Fundo transparente" />
            <Toggle checked={includeTitle} onChange={setIncludeTitle} label="Incluir título do painel" />
            <Button
                variant="primary"
                icon="camera"
                loading={busy}
                onClick={() => void exportPanelImage({ widthMm: panel.widthMm, dpi, includeTitle, background: transparent ? 'transparent' : panel.background === 'transparent' ? 'theme' : panel.background })}
            >
                Salvar painel (PNG)
            </Button>
            {cell?.content.kind === 'chart' && (
                <Button icon="chart" onClick={() => void exportCellImage(cell.id, { widthMm: Math.round(panel.widthMm / Math.max(1, panel.cols)) * 2, dpi, transparent })}>
                    Salvar só este gráfico
                </Button>
            )}
            <Button icon="download" onClick={() => void exportTableCsv()}>
                Exportar dados filtrados (CSV)
            </Button>
            <p className="text-[10.5px] leading-snug text-text-2">
                Cada gráfico é redesenhado no tamanho final (texto e linhas nítidos), e as células 3D passam pelo render com supersampling.
            </p>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export function DataInspector() {
    const dataset = useData((s) => s.dataset);
    const panel = useActivePanel();
    const cell = useActiveCell();
    const [tab, setTab] = useState<'cell' | 'panel'>('cell');

    if (!dataset || !panel) {
        return (
            <aside className="flex w-[330px] shrink-0 items-center justify-center border-l border-stroke bg-bg-1 px-6 text-center">
                <p className="text-[12px] text-text-2">Abra uma pasta de análise para montar os painéis.</p>
            </aside>
        );
    }

    return (
        <aside className="flex w-[330px] shrink-0 flex-col border-l border-stroke bg-bg-1">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
                <Segmented<'cell' | 'panel'>
                    className="flex-1"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'cell', label: cell ? (cell.content.kind === 'chart' ? 'Gráfico' : cell.content.kind === 'structure' ? 'Estrutura 3D' : 'Texto') : 'Célula' },
                        { value: 'panel', label: 'Painel' },
                    ]}
                />
                {cell && <IconButton icon="trash" size={24} title="Remover célula" onClick={() => removeCell(cell.id)} />}
            </div>
            <div className="scroll-themed min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                <div key={`${tab}-${cell?.id ?? 'none'}`} className="panel-enter stagger">
                    {tab === 'cell' ? (
                        cell ? (
                            <>
                                {cell.content.kind === 'chart' && <ChartMenus dataset={dataset} cellId={cell.id} spec={cell.content.chart} />}
                                {cell.content.kind === 'structure' && <StructureMenus dataset={dataset} cellId={cell.id} spec={cell.content.structure} />}
                                {cell.content.kind === 'text' && (
                                    <Section title="Texto">
                                        <textarea
                                            value={cell.content.text.text}
                                            onChange={(e) => patchText(cell.id, { text: e.target.value })}
                                            onKeyDown={(e) => e.stopPropagation()}
                                            rows={6}
                                            className="scroll-themed w-full resize-y rounded-md border border-stroke-2 bg-bg-1 p-2 text-[12px] text-text-0 outline-none focus:border-accent"
                                        />
                                        <Slider label="Tamanho" value={cell.content.text.size} min={9} max={28} step={1} defaultValue={12} onChange={(size) => patchText(cell.id, { size })} format={(v) => `${v.toFixed(0)} px`} />
                                        <Segmented<'left' | 'center'>
                                            value={cell.content.text.align}
                                            onChange={(align) => patchText(cell.id, { align })}
                                            options={[
                                                { value: 'left', label: 'Esquerda' },
                                                { value: 'center', label: 'Centro' },
                                            ]}
                                        />
                                        <Toggle checked={cell.content.text.caption} onChange={(caption) => patchText(cell.id, { caption })} label="Estilo de legenda" />
                                    </Section>
                                )}
                            </>
                        ) : (
                            <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-text-2">
                                Clique numa célula do painel para editá-la, ou use <span className="text-text-1">Adicionar</span> para criar uma.
                            </p>
                        )
                    ) : (
                        <>
                            <PanelMenus panel={panel} />
                            <ExportSection panel={panel} />
                        </>
                    )}
                </div>
            </div>
        </aside>
    );
}
