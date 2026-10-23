import { useMemo, useState } from 'react';
import type { ResultEntry } from '@/compute/store';
import type { MhcxComparison, MhcxNode, MhcxResult } from '@/compute/types';
import * as E from '@/engine';
import { hexToInt } from '@/data/palettes';
import { platform } from '@/platform/bridge';
import { toast, useApp, viewer } from '@/store/app';
import { AXIS, Chart, TOOLTIP, type ChartOption } from '../../components/Chart';
import { Button, Segmented, Select, Slider, Toggle, cx } from '../../components/Primitives';
import { Card, fmt, Pane, Table, toCsv } from './common';
import {
    CLASS_COLORS,
    CLASS_LABELS_PT,
    EDGE_DEFAULT,
    MOL_DEFAULTS_DARK,
    PALETTE_LABELS,
    WATER_COLOR,
    extendedPalette,
    groupColors,
    residueClass,
    stdColor,
} from './mhcxStyle';

type ColorMode = 'group' | 'node' | 'class' | 'component';
type BaseRepr = 'cartoon' | 'stick' | 'line' | 'sphere' | 'surface';
const ONE: Record<string, string> = {
    ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
    LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', HOH: 'w',
};

function shortLabel(n: MhcxNode): string {
    return n.mapping.map((m) => `${m.chain}:${ONE[m.resn] ?? m.resn}${m.resi}`).join(' · ');
}

const keyOf = (m: { chain: string; resi: number | string }) => `${m.chain}:${m.resi}`;

export function MhcxView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as MhcxResult;
    const structures = useApp((s) => s.structures);
    const [compKey, setCompKey] = useState(r.comparisons[0]?.key ?? '');
    const cmp: MhcxComparison | undefined = r.comparisons.find((c) => c.key === compKey) ?? r.comparisons[0];
    const [component, setComponent] = useState<number | null>(null);
    const [frame, setFrame] = useState<number | null>(null);
    const [palette, setPalette] = useState('colorblind');
    const [colorMode, setColorMode] = useState<ColorMode>('group');
    const [nodeSize, setNodeSize] = useState(18);
    const [labelSize, setLabelSize] = useState(11);
    const [edgeWidth, setEdgeWidth] = useState(1);
    const [spring, setSpring] = useState(100);
    const [showLabels, setShowLabels] = useState(true);
    const [inactive, setInactive] = useState<'dim' | 'hide'>('dim');
    const [graphSource, setGraphSource] = useState<string>('associated');
    const [selectedNode, setSelectedNode] = useState<MhcxNode | null>(null);
    const [baseRepr, setBaseRepr] = useState<BaseRepr>('cartoon');
    const [baseOpacity, setBaseOpacity] = useState(0.35);
    const [activeSticks, setActiveSticks] = useState(true);
    const [molChainColors, setMolChainColors] = useState(true);
    const [tab, setTab] = useState<'graph' | 'heatmap'>('graph');

    /** proteins[i] → structure in the scene. */
    const structureOfProtein = (p: number): E.StructureId | null => {
        const name = r.proteins[p];
        const idx = name ? r.names.indexOf(name) : -1;
        const sid = idx >= 0 ? entry.structureIds[idx] : undefined;
        return sid && structures.some((s) => s.id === sid) ? sid : null;
    };

    const nodes = cmp?.nodes ?? [];
    const comp = cmp?.components.find((c) => c.id === component) ?? null;
    const fr = comp?.frames.find((f) => f.id === frame) ?? null;
    const active = useMemo(() => new Set<number>(fr ? fr.node_ids : comp ? comp.node_ids : nodes.map((n) => n.id)), [fr, comp, nodes]);

    const nodeColor = useMemo(() => {
        const out = new Map<number, string>();
        if (colorMode === 'group') {
            const g = groupColors(nodes.map((n) => n.group), palette);
            for (const n of nodes) out.set(n.id, g[n.group]!);
        } else if (colorMode === 'node') {
            const pal = extendedPalette(palette, nodes.length);
            nodes.forEach((n, i) => out.set(n.id, pal[i % pal.length]!));
        } else if (colorMode === 'class') {
            for (const n of nodes) out.set(n.id, CLASS_COLORS[residueClass(n.mapping[0]?.resn ?? '')]!);
        } else {
            const pal = extendedPalette(palette, Math.max(1, cmp?.components.length ?? 1));
            const byNode = new Map<number, number>();
            cmp?.components.forEach((c, i) => c.node_ids.forEach((id) => byNode.has(id) || byNode.set(id, i)));
            for (const n of nodes) out.set(n.id, pal[(byNode.get(n.id) ?? 0) % pal.length]!);
        }
        return out;
    }, [nodes, colorMode, palette, cmp]);

    // -- graph ----------------------------------------------------------------

    const graphOption: ChartOption = useMemo(() => {
        let gNodes: MhcxNode[] = nodes;
        let gEdges = cmp?.edges ?? [];
        let colorFor = (n: MhcxNode) => nodeColor.get(n.id) ?? '#888';
        let isActive = (n: MhcxNode) => active.has(n.id);
        if (graphSource !== 'associated') {
            const fg = r.filtered_graphs[graphSource];
            if (fg) {
                gNodes = fg.nodes;
                gEdges = fg.edges;
                const g = groupColors(fg.nodes.map((n) => n.group), palette);
                colorFor = (n) => (colorMode === 'class' ? CLASS_COLORS[residueClass(n.mapping[0]?.resn ?? '')]! : g[n.group]!);
                isActive = () => true;
            }
        }
        const shown = gNodes.filter((n) => inactive === 'dim' || isActive(n));
        const shownIds = new Set(shown.map((n) => n.id));
        const threshold = Number((r.settings as Record<string, unknown>).global_distance_diff_threshold ?? 2);
        return {
            tooltip: { ...TOOLTIP, formatter: (p: unknown) => {
                const d = (p as { dataType: string; data: { tip?: string } }).data;
                return d.tip ?? '';
            } },
            series: [
                {
                    type: 'graph',
                    layout: 'force',
                    roam: true,
                    draggable: true,
                    force: { repulsion: spring * 1.2, edgeLength: spring * 0.5, gravity: 0.06, friction: 0.15 },
                    emphasis: { focus: 'adjacency', lineStyle: { width: edgeWidth * 2.5 } },
                    label: { show: showLabels, position: 'right', fontSize: labelSize, fontWeight: 'bold', color: '#e6ecf5', textBorderColor: '#0b0e14', textBorderWidth: 3 },
                    data: shown.map((n) => {
                        const on = isActive(n);
                        return {
                            id: String(n.id),
                            name: graphSource === 'associated' ? shortLabel(n) : n.label,
                            symbolSize: nodeSize,
                            value: n.id,
                            tip: n.title.replace(/\n/g, '<br/>'),
                            itemStyle: { color: on ? colorFor(n) : '#3a4354', borderColor: on ? '#e6ecf5' : '#2e3a52', borderWidth: on ? 1.5 : 1, opacity: on ? 1 : 0.35 },
                            label: { show: showLabels && on, color: on ? '#e6ecf5' : '#6b7891' },
                        };
                    }),
                    links: gEdges
                        .filter((e) => shownIds.has(e.from) && shownIds.has(e.to))
                        .map((e) => {
                            const on = gNodes.some((n) => n.id === e.from && isActive(n)) && gNodes.some((n) => n.id === e.to && isActive(n));
                            const std = (e as { std?: number | null }).std ?? null;
                            return {
                                source: String(e.from),
                                target: String(e.to),
                                tip: e.title?.replace(/\n/g, '<br/>') ?? '',
                                lineStyle: { color: std !== null && (r.settings as Record<string, unknown>).show_std_edges ? stdColor(std, threshold) : EDGE_DEFAULT, width: on ? edgeWidth : Math.max(0.2, edgeWidth * 0.5), opacity: on ? 0.9 : 0.15 },
                            };
                        }),
                },
            ],
        };
    }, [nodes, cmp, nodeColor, active, graphSource, r, palette, colorMode, inactive, nodeSize, labelSize, edgeWidth, spring, showLabels]);

    // -- 3D projection ----------------------------------------------------------

    const project = async () => {
        const v = viewer();
        if (!v || !cmp) return;
        useApp.setState({ busy: 'Projetando a associação nas estruturas' });
        try {
            let projected = 0;
            for (let p = 0; p < r.proteins.length; p++) {
                const sid = structureOfProtein(p);
                if (!sid) continue;
                const colors: Record<string, number> = {};
                const activeKeys: string[] = [];
                const waterKeys: string[] = [];
                for (const n of nodes) {
                    if (!active.has(n.id)) continue;
                    for (const m of n.mapping) {
                        if (m.model_idx !== p) continue;
                        const k = keyOf(m);
                        colors[k] = hexToInt(m.resn === 'HOH' ? WATER_COLOR : nodeColor.get(n.id) ?? '#ffffff');
                        (m.resn === 'HOH' ? waterKeys : activeKeys).push(k);
                    }
                }
                const info = structures.find((s) => s.id === sid)!;
                if (molChainColors) {
                    info.chains.forEach((c, i) => void E.setChainColor(v, sid, c.authAsymId, hexToInt(MOL_DEFAULTS_DARK[i % MOL_DEFAULTS_DARK.length]!)));
                }
                E.setDataset(v, sid, { id: 'mhcx', label: `MHCXGraph · ${cmp.key}`, source: 'MHCXGraph', kind: 'explicit', values: {}, colors });
                await E.showDataset(v, sid, 'mhcx', 'chain');

                // Base representation, as in the dashboard's selector.
                const all: E.StyleTarget = { kind: 'structure', id: sid };
                await E.clearPaint(v, sid);
                if (baseRepr === 'cartoon' || baseRepr === 'surface') await E.setLayer(v, all, 'ribbon', { layer: 'ribbon', style: 'cartoon' });
                else await E.setLayer(v, all, 'ribbon', null);
                if (baseRepr === 'stick' || baseRepr === 'line' || baseRepr === 'sphere') {
                    await E.setLayer(v, all, 'atoms', { layer: 'atoms', style: baseRepr === 'stick' ? 'sticks' : baseRepr === 'line' ? 'lines' : 'spheres', size: 1 });
                } else await E.setLayer(v, all, 'atoms', null);
                if (baseRepr === 'surface') await E.setLayer(v, all, 'surface', { layer: 'surface', style: 'molecular', opacity: baseOpacity });
                else await E.setLayer(v, all, 'surface', null);
                if (baseOpacity < 1 && baseRepr !== 'surface') await E.setTransparency(v, all, 1 - baseOpacity);

                // Active residues: opaque, side chains as sticks; waters as red spheres.
                E.clearSelection(v);
                const perChain = new Map<string, string[]>();
                for (const k of activeKeys) {
                    const [c, rr] = k.split(':') as [string, string];
                    perChain.set(c, [...(perChain.get(c) ?? []), rr]);
                }
                for (const [c, rs] of perChain) await E.selectResidues(v, sid, c, rs, 'add');
                if (activeKeys.length) {
                    await E.setTransparency(v, { kind: 'selection' }, 0);
                    if (activeSticks) await E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1.25 });
                }
                if (waterKeys.length) {
                    E.clearSelection(v);
                    for (const k of waterKeys) {
                        const [c, rr] = k.split(':') as [string, string];
                        await E.selectResidues(v, sid, c, [rr], 'add');
                    }
                    await E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'spheres', size: 0.35 });
                }
                E.clearSelection(v);
                projected++;
            }
            if (projected === 0) toast('As estruturas desta análise não estão mais na cena.', 'error');
        } finally {
            useApp.setState({ busy: null });
        }
    };

    const selectNode = async (n: MhcxNode) => {
        setSelectedNode(n);
        const v = viewer();
        if (!v) return;
        E.clearSelection(v);
        for (const m of n.mapping) {
            const sid = structureOfProtein(m.model_idx);
            if (sid) await E.selectResidues(v, sid, m.chain, [String(m.resi)], 'add');
        }
        E.focusSelection(v);
    };

    // -- tables -----------------------------------------------------------------

    const summaryRow = cmp?.summary.find((s) => Number(s.component_id) === component && Number(s.frame_id) === (frame ?? 0));
    const perProtein = (cmp?.per_protein ?? []).filter((s) => component === null || (Number(s.component_id) === component && Number(s.frame_id) === (frame ?? 0)));

    const heatOption: ChartOption | null = r.heatmap?.distance?.labels?.length
        ? {
              grid: { left: 90, right: 30, top: 10, bottom: 80 },
              tooltip: { ...TOOLTIP, formatter: (p: unknown) => {
                  const d = (p as { data: [number, number, number] }).data;
                  return `${r.heatmap!.distance.labels[d[0]]} × ${r.heatmap!.distance.labels[d[1]]}<br/>distância ${d[2].toFixed(3)}`;
              } },
              xAxis: { type: 'category', data: r.heatmap.distance.labels, ...AXIS, axisLabel: { ...AXIS.axisLabel, rotate: 45 } },
              yAxis: { type: 'category', data: r.heatmap.distance.labels, ...AXIS },
              visualMap: { min: 0, max: 1, calculable: true, orient: 'vertical', right: 0, top: 'center', itemHeight: 120, textStyle: { color: '#9aa8bf' }, inRange: { color: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'] } },
              series: [
                  {
                      type: 'heatmap',
                      data: r.heatmap.distance.values.flatMap((row, i) => row.map((val, j) => [j, i, val])),
                      label: { show: r.heatmap.distance.labels.length <= 12, color: '#fff', fontSize: 9, formatter: (p: unknown) => ((p as { data: number[] }).data[2]!).toFixed(2) },
                  },
              ],
          }
        : null;

    if (!cmp) return <p className="p-4 text-[12px] text-text-2">O MHCXGraph não encontrou associação.</p>;

    return (
        <div className="flex h-full min-h-0 gap-2">
            {/* Navigation */}
            <div className="scroll-themed flex w-[250px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
                {r.comparisons.length > 1 && (
                    <Select
                        value={cmp.key}
                        onChange={(k) => {
                            setCompKey(k);
                            setComponent(null);
                            setFrame(null);
                        }}
                        options={r.comparisons.map((c) => ({ value: c.key, label: c.key.replace(/_vs_/g, ' × ') }))}
                    />
                )}
                <div className="grid grid-cols-3 gap-1">
                    <Card label="nós" value={nodes.length} />
                    <Card label="arestas" value={cmp.edges.length} />
                    <Card label="componentes" value={cmp.components.length} />
                </div>
                <div className="flex flex-col gap-0.5 rounded-md border border-stroke p-1">
                    <button type="button" onClick={() => { setComponent(null); setFrame(null); }} className={cx('rounded px-1.5 py-1 text-left text-[11.5px]', component === null ? 'bg-accent/15 text-accent' : 'hover:bg-bg-3')}>
                        Todos os nós
                    </button>
                    {cmp.components.map((c) => (
                        <div key={c.id}>
                            <button
                                type="button"
                                onClick={() => { setComponent(c.id); setFrame(c.frames.length ? c.frames[0]!.id : null); }}
                                className={cx('flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11.5px]', component === c.id ? 'bg-accent/15 text-accent' : 'hover:bg-bg-3')}
                            >
                                <span>Componente {c.id}</span>
                                <span className="tnum text-text-2">{c.node_ids.length} nós · {c.frames.length} frame(s)</span>
                            </button>
                            {component === c.id && c.frames.length > 1 && (
                                <div className="ml-3 flex flex-col">
                                    {c.frames.map((f) => (
                                        <button key={f.id} type="button" onClick={() => setFrame(f.id)} className={cx('rounded px-1.5 py-0.5 text-left text-[11px]', frame === f.id ? 'text-accent' : 'text-text-1 hover:text-text-0')}>
                                            Frame {f.id} · {f.node_ids.length} nós{f.rmsds?.length ? ` · RMSD ${Math.max(...f.rmsds).toFixed(2)} Å` : ''}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                {summaryRow && (
                    <div className="grid grid-cols-2 gap-1">
                        <Card label="cobertura média (pond.)" value={fmt(Number(summaryRow.node_cov_wmean), 3)} />
                        <Card label="cobertura p50" value={fmt(Number(summaryRow.node_cov_p50), 3)} />
                        <Card label="duplicação média" value={fmt(Number(summaryRow.mean_dup_rate), 3)} />
                        <Card label="proteínas" value={summaryRow.n_proteins as number} />
                    </div>
                )}
                {fr?.rmsds && fr.rmsds.length > 0 && <div className="text-[10.5px] text-text-2">RMSD do frame: {fr.rmsds.map((x) => x.toFixed(2)).join(' · ')} Å</div>}
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    {r.dashboard && <Button onClick={() => void platform.openHtml(r.dashboard!, 'MHCXGraph · dashboard')}>Dashboard original</Button>}
                    <Button onClick={() => void platform.showFolder(r.output_dir)}>Pasta</Button>
                    <Button onClick={() => void platform.saveText(toCsv(cmp.summary), `mhcxgraph_${cmp.key}_summary.csv`)}>CSV</Button>
                </div>
            </div>

            {/* Graph / heatmap */}
            <Pane
                title={tab === 'graph' ? 'Grafo de associação' : 'Heatmap entre pares (distância de componentes)'}
                className="min-w-0 flex-1"
                actions={
                    <span className="flex gap-1">
                        <button type="button" onClick={() => setTab('graph')} className={`rounded px-1.5 text-[10.5px] ${tab === 'graph' ? 'bg-accent/15 text-accent' : 'text-text-2'}`}>Grafo</button>
                        {heatOption && <button type="button" onClick={() => setTab('heatmap')} className={`rounded px-1.5 text-[10.5px] ${tab === 'heatmap' ? 'bg-accent/15 text-accent' : 'text-text-2'}`}>Heatmap</button>}
                    </span>
                }
            >
                {tab === 'graph' ? (
                    <div className="flex h-full min-h-0 flex-col">
                        <Chart
                            option={graphOption}
                            height="100%"
                            onClick={(p) => {
                                if (p.dataType !== 'node') return;
                                const n = nodes.find((x) => String(x.id) === String((p.data as { id: string }).id));
                                if (n && graphSource === 'associated') void selectNode(n);
                            }}
                        />
                        {colorMode === 'class' && (
                            <div className="flex flex-wrap gap-2 pt-1 text-[10.5px] text-text-1">
                                {Object.entries(CLASS_COLORS).map(([k, c]) => (
                                    <span key={k} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{CLASS_LABELS_PT[k]}</span>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    heatOption && (
                        <div className="flex h-full flex-col">
                            <Chart option={heatOption} height="100%" />
                            <div className="pt-1"><Button onClick={() => void platform.showFolder(r.heatmap!.png)}>Abrir o PNG clusterizado do MHCXGraph</Button></div>
                        </div>
                    )
                )}
            </Pane>

            {/* Style + 3D */}
            <div className="scroll-themed flex w-[270px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
                <span className="text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Grafo</span>
                <Select value={graphSource} onChange={setGraphSource} options={[{ value: 'associated', label: 'Grafo associado' }, ...Object.keys(r.filtered_graphs).map((k) => ({ value: k, label: `Grafo filtrado · ${k}` }))]} />
                <Select value={palette} onChange={setPalette} options={Object.entries(PALETTE_LABELS).map(([value, label]) => ({ value, label }))} />
                <Segmented<ColorMode>
                    value={colorMode}
                    onChange={setColorMode}
                    options={[
                        { value: 'group', label: 'Grupo', title: 'Combinação de cadeias, como no dashboard' },
                        { value: 'node', label: 'Nó', title: 'Uma cor por nó: correspondência resíduo a resíduo' },
                        { value: 'class', label: 'Classe' },
                        { value: 'component', label: 'Comp.' },
                    ]}
                />
                <Segmented<'dim' | 'hide'> value={inactive} onChange={setInactive} options={[{ value: 'dim', label: 'Esmaecer inativos' }, { value: 'hide', label: 'Ocultar inativos' }]} />
                <Slider label="Tamanho do nó" value={nodeSize} min={4} max={40} step={1} onChange={setNodeSize} format={(x) => String(x)} />
                <Slider label="Rótulo" value={labelSize} min={6} max={22} step={1} onChange={setLabelSize} format={(x) => String(x)} />
                <Slider label="Aresta" value={edgeWidth} min={0.2} max={5} step={0.1} onChange={setEdgeWidth} format={(x) => x.toFixed(1)} />
                <Slider label="Mola" value={spring} min={20} max={400} step={5} onChange={setSpring} format={(x) => String(x)} />
                <Toggle checked={showLabels} onChange={setShowLabels} label="Rótulos" />

                <span className="mt-1 text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Estruturas (3D)</span>
                <Segmented<BaseRepr>
                    value={baseRepr}
                    onChange={setBaseRepr}
                    options={[
                        { value: 'cartoon', label: 'Cartoon' },
                        { value: 'stick', label: 'Stick' },
                        { value: 'line', label: 'Line' },
                        { value: 'sphere', label: 'Sphere' },
                        { value: 'surface', label: 'Surf.' },
                    ]}
                />
                <Slider label="Opacidade da base" value={baseOpacity} min={0.05} max={1} onChange={setBaseOpacity} format={(x) => `${Math.round(x * 100)}%`} />
                <Toggle checked={activeSticks} onChange={setActiveSticks} label="Sticks nos resíduos ativos" />
                <Toggle checked={molChainColors} onChange={setMolChainColors} label="Cores de cadeia do MHCXGraph" />
                <Button variant="primary" onClick={() => void project()}>
                    Projetar {fr ? `frame ${fr.id}` : comp ? `componente ${comp.id}` : 'todos os nós'}
                </Button>
                <div className="flex flex-col gap-0.5 text-[10.5px]">
                    {r.proteins.map((p, i) => (
                        <span key={p} className={structureOfProtein(i) ? 'text-text-1' : 'text-text-2 line-through'}>
                            Prot {i}: {p}
                        </span>
                    ))}
                </div>

                {selectedNode && (
                    <div className="rounded-md border border-stroke bg-bg-0 p-2 text-[11px]">
                        <div className="mb-1 flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: nodeColor.get(selectedNode.id) }} />
                            <span className="font-medium">Nó {selectedNode.id}</span>
                            <span className="text-text-2">grupo {selectedNode.group}</span>
                        </div>
                        {selectedNode.mapping.map((m, i) => (
                            <div key={i} className="mono flex justify-between">
                                <span>Prot {m.model_idx} · {m.chain}:{m.resn}{m.resi}</span>
                                <span className="text-text-2">RSA {m.rsa !== null && m.rsa !== undefined ? m.rsa.toFixed(2) : '—'}</span>
                            </div>
                        ))}
                    </div>
                )}
                {perProtein.length > 0 && (
                    <Table
                        rows={perProtein}
                        columns={[
                            { key: 'p', label: 'Proteína', render: (x) => String(x.protein_name) },
                            { key: 'c', label: 'cobertura', align: 'right', render: (x) => Number(x.node_coverage).toFixed(3) },
                            { key: 'u', label: 'únicos', align: 'right', render: (x) => String(x.frame_nodes_unique) },
                        ]}
                    />
                )}
            </div>
        </div>
    );
}
