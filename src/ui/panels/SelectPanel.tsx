import { useState } from 'react';
import * as E from '@/engine';
import { run, toast, useApp, viewer } from '@/store/app';
import { Button, Collapse, ColorInput, Field, Section, Segmented, Select, Slider, Toggle, cx } from '../components/Primitives';
import { Icon } from '../components/Icon';
import { act } from '@/store/history';

const CLASSES: { cls: E.ResidueClass; label: string }[] = [
    { cls: 'hydrophobic', label: 'Hidrofóbicos' },
    { cls: 'aromatic', label: 'Aromáticos' },
    { cls: 'charged', label: 'Carregados' },
    { cls: 'positive', label: 'Positivos' },
    { cls: 'negative', label: 'Negativos' },
    { cls: 'polar', label: 'Polares' },
    { cls: 'gly-pro', label: 'Gly / Pro' },
    { cls: 'disulfide', label: 'Dissulfetos' },
    { cls: 'helix', label: 'Hélices' },
    { cls: 'sheet', label: 'Fitas β' },
    { cls: 'loop', label: 'Loops' },
    { cls: 'backbone', label: 'Backbone' },
    { cls: 'sidechain', label: 'Cadeias laterais' },
    { cls: 'ligand', label: 'Ligantes' },
    { cls: 'water', label: 'Água' },
];

const SPEC_HELP: [string, string][] = [
    ['/A', 'cadeia A'],
    ['/A,C:30-45', 'resíduos 30–45 das cadeias A e C'],
    [':TYR,TRP', 'por nome de resíduo'],
    ['/B:50@CA,CB', 'átomos por nome'],
    ['#2/A', 'cadeia A da 2ª estrutura'],
    ['/B :<5', 'resíduos a 5 Å de /B (inclui /B)'],
    ['sel @<4 & ~sel', 'átomos a 4 Å da seleção, sem ela'],
    ['protein & ~/A', 'operadores & | ~ e ( )'],
];

/**
 * The label button: one click labels the selection with the current style, and the
 * caret opens the rest — content, size, colour, plate and the leader line.
 */
function LabelButton() {
    const [open, setOpen] = useState(false);
    const [style, setStyle] = useState<E.LabelStyle>(E.DEFAULT_LABEL_STYLE);
    const [count, setCount] = useState<number | null>(null);
    const v = viewer();

    const applyStyle = async (next: E.LabelStyle) => {
        setStyle(next);
        // Re-label in place while labels are on screen, so a slider shows its effect.
        if (v && count !== null) {
            const r = await E.labelSelection(v, next);
            if (r.ok) setCount(r.value);
        }
    };

    return (
        <>
            <div className="col-span-3 flex">
                <button
                    type="button"
                    onClick={async () => {
                        if (!v) return;
                        const n = await act('rotular seleção', () => E.labelSelection(v, style));
                        if (n !== null) setCount(n);
                    }}
                    className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-l-md border border-r-0 border-stroke-2 bg-bg-2 px-2.5 text-[12px] font-medium text-text-0 hover:border-text-2 hover:bg-bg-3"
                >
                    <Icon name="tag" size={14} /> Rotular
                </button>
                <button
                    type="button"
                    title="Opções de rótulo"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    className={cx(
                        'press inline-flex h-7 w-7 items-center justify-center rounded-r-md border border-stroke-2 bg-bg-2 text-text-1 hover:border-text-2 hover:bg-bg-3',
                        open && 'border-accent text-accent',
                    )}
                >
                    <Icon name="chevronDown" size={13} className={cx('transition-transform duration-300', open && 'rotate-180')} />
                </button>
            </div>
            <div className="col-span-3">
                <Collapse open={open}>
                    <div className="flex flex-col gap-2.5 rounded-md border border-stroke bg-bg-0/60 p-2">
                        <Field label="Mostrar">
                            <Select
                                value={style.content}
                                onChange={(content) => void applyStyle({ ...style, content: content as E.LabelContent })}
                                options={[
                                    { value: 'residue', label: 'TYR45' },
                                    { value: 'residue-chain', label: 'A/TYR45' },
                                    { value: 'name-only', label: 'TYR' },
                                    { value: 'number-only', label: '45' },
                                    { value: 'chain-only', label: 'A' },
                                ]}
                            />
                        </Field>
                        <Toggle checked={style.leader} onChange={(leader) => void applyStyle({ ...style, leader })} label="Guia pontilhada até o rótulo" />
                        <Collapse open={style.leader}>
                            <div className="flex flex-col gap-2.5">
                                <Slider
                                    label="Distância do rótulo"
                                    value={style.leaderLength}
                                    min={0}
                                    max={20}
                                    step={0.5}
                                    defaultValue={E.DEFAULT_LABEL_STYLE.leaderLength}
                                    onChange={(leaderLength) => void applyStyle({ ...style, leaderLength })}
                                    format={(x) => `${x.toFixed(1)} Å`}
                                />
                                <Slider
                                    label="Tracejado"
                                    value={style.leaderDashes}
                                    min={1}
                                    max={16}
                                    step={1}
                                    defaultValue={E.DEFAULT_LABEL_STYLE.leaderDashes}
                                    onChange={(leaderDashes) => void applyStyle({ ...style, leaderDashes })}
                                    format={(x) => (x <= 1 ? 'contínua' : `${x.toFixed(0)} traços`)}
                                />
                                <div className="flex items-center gap-2 text-[11px] text-text-1">
                                    Cor da guia
                                    <ColorInput value={style.leaderColor} onChange={(leaderColor) => void applyStyle({ ...style, leaderColor })} />
                                </div>
                            </div>
                        </Collapse>
                        <Slider
                            label="Tamanho do texto"
                            value={style.size}
                            min={0.3}
                            max={3}
                            step={0.05}
                            defaultValue={E.DEFAULT_LABEL_STYLE.size}
                            onChange={(size) => void applyStyle({ ...style, size })}
                            format={(x) => `${x.toFixed(2)} Å`}
                        />
                        <div className="flex items-center gap-2 text-[11px] text-text-1">
                            Cor do texto
                            <ColorInput value={style.color} onChange={(color) => void applyStyle({ ...style, color })} />
                            <span className="flex-1" />
                            <Toggle checked={style.outline} onChange={(outline) => void applyStyle({ ...style, outline })} label="Contorno" />
                        </div>
                        <Toggle checked={style.background} onChange={(background) => void applyStyle({ ...style, background })} label="Placa atrás do texto" />
                        <Collapse open={style.background}>
                            <div className="flex items-center gap-2 text-[11px] text-text-1">
                                Cor da placa
                                <ColorInput value={style.backgroundColor} onChange={(backgroundColor) => void applyStyle({ ...style, backgroundColor })} />
                                <span className="flex-1" />
                                <span className="tnum text-text-2">{Math.round(style.backgroundOpacity * 100)}%</span>
                            </div>
                        </Collapse>
                        <div className="flex items-center gap-1.5">
                            <Button
                                variant="ghost"
                                onClick={async () => {
                                    if (!v) return;
                                    await E.clearLabels(v);
                                    setCount(null);
                                }}
                            >
                                Limpar rótulos
                            </Button>
                            {count !== null && <span className="tnum text-[10.5px] text-text-2">{count} rótulo{count === 1 ? '' : 's'}</span>}
                        </div>
                    </div>
                </Collapse>
            </div>
        </>
    );
}

export function SelectPanel() {
    const selection = useApp((s) => s.selection);
    const [modifier, setModifier] = useState<E.SelectModifier>('set');
    const [level, setLevel] = useState<E.PickLevel>('residue');
    const [radius, setRadius] = useState(5);
    const v = viewer();
    if (!v) return null;

    return (
        <div>
            <Section title="Seleção atual">
                <div className="rounded-md border border-stroke bg-bg-0 px-2 py-1.5 text-[12px]">
                    {selection ? (
                        <>
                            <div className="text-text-0">{selection.label}</div>
                            <div className="mono mt-0.5 truncate text-[11px] text-text-2">{selection.chains.join('  ')}</div>
                        </>
                    ) : (
                        <span className="text-text-2">Nada selecionado</span>
                    )}
                </div>
                <div className="grid grid-cols-3 gap-1">
                    <Button onClick={() => void run(E.focusSelection(v))} icon="focus">Focar</Button>
                    <Button onClick={() => void run(E.focusSelection(v, true))} title="Foca e mostra a vizinhança de 5 Å com interações">Vizinhança</Button>
                    <LabelButton />
                    <Button
                        title="Sobe um nível: resíduo → hélice/fita/alça → cadeia → estrutura → tudo (tecla ↑)"
                        onClick={() => void run(E.promoteSelection(v)).then((l) => l && toast(`Seleção: ${E.SELECTION_LEVEL_NAMES[l]}`, 'info', 1200))}
                    >
                        ↑ Ampliar
                    </Button>
                    <Button title="Volta ao nível anterior (tecla ↓)" onClick={() => E.demoteSelection(v)}>↓ Voltar</Button>
                    <Button onClick={() => void run(E.invertSelection(v))}>Inverter</Button>
                    <Button onClick={() => void run(E.selectAll(v))}>Tudo</Button>
                    <Button onClick={() => { E.clearSelection(v); E.clearFocus(v); }} variant="ghost">Limpar</Button>
                </div>
            </Section>

            <Section title="Clique seleciona">
                <Segmented<E.PickLevel>
                    value={level}
                    onChange={(l) => {
                        setLevel(l);
                        E.setPickLevel(v, l);
                    }}
                    options={[
                        { value: 'atom', label: 'Átomo' },
                        { value: 'residue', label: 'Resíduo' },
                        { value: 'chain', label: 'Cadeia' },
                    ]}
                />
                <p className="text-[11px] text-text-2">Shift+clique estende pela cadeia. Clique no vazio não limpa (Esc limpa).</p>
            </Section>

            <Section title="Por tipo">
                <Segmented<E.SelectModifier>
                    value={modifier}
                    onChange={setModifier}
                    options={[
                        { value: 'set', label: 'Substituir' },
                        { value: 'add', label: '+ Adicionar' },
                        { value: 'remove', label: '− Remover' },
                        { value: 'intersect', label: '∩ Interseção' },
                    ]}
                />
                <div className="grid grid-cols-3 gap-1">
                    {CLASSES.map((c) => (
                        <Button key={c.cls} onClick={() => void run(E.selectClass(v, c.cls, modifier))} className="px-1.5">
                            {c.label}
                        </Button>
                    ))}
                </div>
            </Section>

            <Section title="Vizinhança">
                <Slider label="Raio" value={radius} min={2} max={15} step={0.5} onChange={setRadius} format={(x) => `${x.toFixed(1)} Å`} />
                <div className="grid grid-cols-2 gap-1">
                    <Button onClick={() => void run(E.selectAround(v, radius, modifier, true))}>Resíduos a {radius} Å</Button>
                    <Button onClick={() => void run(E.selectAround(v, radius, modifier, false))}>Átomos a {radius} Å</Button>
                </div>
            </Section>

            <Section title="Linha de comando (topo)" defaultOpen={false}>
                <div className="flex flex-col gap-1">
                    {SPEC_HELP.map(([spec, meaning]) => (
                        <div key={spec} className="flex gap-2 text-[11.5px]">
                            <code className="mono w-32 shrink-0 text-accent">{spec}</code>
                            <span className="text-text-1">{meaning}</span>
                        </div>
                    ))}
                    <p className="mt-1 text-[11px] text-text-2">Enter substitui · Shift+Enter adiciona · Alt+Enter remove</p>
                </div>
            </Section>
        </div>
    );
}
