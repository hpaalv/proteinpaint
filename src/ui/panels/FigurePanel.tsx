import { useEffect, useRef, useState } from 'react';
import * as E from '@/engine';
import { hexToInt } from '@/data/palettes';
import { run, toast, useApp, viewer } from '@/store/app';
import { cancelMovie, exportImage, exportMovie } from '@/store/actions';
import type { MovieFormat } from '@/platform/bridge';
import { Icon } from '../components/Icon';
import { Button, ColorInput, Collapse, Field, Section, Segmented, Slider, Toggle, cx } from '../components/Primitives';
import { NoStructure, useActive } from './shared';

// ---------------------------------------------------------------------------
// Canonical views
// ---------------------------------------------------------------------------

const VIEW_ICONS: Record<E.CanonicalView, string> = {
    side: 'M4 18h16M12 18V8M8 8h8l-4-4z',
    top: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    threequarter: 'M5 17l7 4 7-4V7l-7-4-7 4zM12 21V11M19 7l-7 4-7-4',
    groove: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
    back: 'M20 18H4M12 18V8M16 8H8l4-4z',
};

function ViewsSection({ active }: { active: E.StructureInfo }) {
    const [last, setLast] = useState<E.CanonicalView | null>(null);
    const [axes, setAxes] = useState<E.DockingAxes | null>(null);
    const v = viewer();
    const go = (view: E.CanonicalView) => {
        if (!v) return;
        const r = E.canonicalView(v, active.id, view);
        if (!r.ok) return toast(r.error, 'error');
        setLast(view);
        setAxes(r.value);
    };
    return (
        <Section title="Vistas canônicas">
            <div className="grid grid-cols-5 gap-1">
                {(Object.keys(E.CANONICAL_VIEW_LABELS) as E.CanonicalView[]).map((k) => (
                    <button
                        key={k}
                        type="button"
                        title={E.CANONICAL_VIEW_LABELS[k].title}
                        onClick={() => go(k)}
                        className={cx(
                            'press flex h-12 flex-col items-center justify-center gap-1 rounded-md border text-[10.5px]',
                            last === k ? 'border-accent bg-accent/10 text-accent' : 'border-stroke-2 bg-bg-2 text-text-1 hover:border-text-2 hover:text-text-0',
                        )}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                            <path d={VIEW_ICONS[k]} />
                        </svg>
                        {E.CANONICAL_VIEW_LABELS[k].label}
                    </button>
                ))}
            </div>
            <p className="text-[10.5px] leading-snug text-text-2">
                Eixos pela geometria do complexo ativo (como no cdr_panels.py): docking = alvo → binder;
                sulco = {axes ? (axes.grooveFrom === 'peptide' ? 'eixo do peptídeo (N→C)' : 'eixo principal da interface do alvo') : 'eixo do peptídeo, ou da interface sem peptídeo'}.
                Reprodutível entre designs.
            </p>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Distance fade and footprint
// ---------------------------------------------------------------------------

type RefKind = 'interface' | 'selection' | 'binder';

function reference(kind: RefKind, active: E.StructureInfo, cutoff: number): E.FigureReference {
    if (kind === 'selection') return { kind: 'selection' };
    if (kind === 'interface') return { kind: 'interface', cutoff };
    return { kind: 'chains', structureId: active.id, chains: active.chains.filter((c) => c.isPolymer && c.role === 'binder').map((c) => c.authAsymId) };
}

function FadeSection({ active }: { active: E.StructureInfo }) {
    const [ref, setRef] = useState<RefKind>('interface');
    const [near, setNear] = useState(E.DEFAULT_FADE.near);
    const [far, setFar] = useState(E.DEFAULT_FADE.far);
    const [minOpacity, setMinOpacity] = useState(E.DEFAULT_FADE.minOpacity);
    const [perResidue, setPerResidue] = useState(true);
    const [applied, setApplied] = useState(false);
    const [working, setWorking] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    const apply = async () => {
        const v = viewer();
        if (!v) return;
        setWorking(true);
        const r = await run(E.fadeByDistance(v, { reference: reference(ref, active, 4.5), near, far, minOpacity, perResidue }));
        setWorking(false);
        if (r) setApplied(true);
    };
    // Once applied, slider changes re-run it (debounced: each run is one state update).
    useEffect(() => {
        if (!applied) return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void apply(), 180);
        return () => window.clearTimeout(timer.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [near, far, minOpacity, perResidue, ref]);

    return (
        <Section title="Transparência por distância">
            <Field label="Distância até">
                <Segmented<RefKind>
                    value={ref}
                    onChange={setRef}
                    options={[
                        { value: 'interface', label: 'Interface', title: 'Átomos de contato binder ↔ alvo (≤ 4,5 Å), por papel das cadeias' },
                        { value: 'binder', label: 'Binder', title: 'Cadeias com papel "binder" da estrutura ativa' },
                        { value: 'selection', label: 'Seleção' },
                    ]}
                />
            </Field>
            {/* A gradient bar that is the actual mapping: opacity against distance. */}
            <div className="flex flex-col gap-1">
                <div
                    className="h-2.5 rounded-full ring-1 ring-black/30"
                    style={{
                        background: `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${(near / 40) * 100}%, color-mix(in srgb, var(--accent) ${Math.round(minOpacity * 100)}%, transparent) ${(Math.min(far, 40) / 40) * 100}%)`,
                    }}
                />
                <div className="tnum flex justify-between text-[10px] text-text-2">
                    <span>0 Å</span>
                    <span>opaco até {near.toFixed(0)} Å · mínimo a partir de {far.toFixed(0)} Å</span>
                    <span>40</span>
                </div>
            </div>
            <Slider label="Totalmente opaco até" value={near} min={0} max={20} step={0.5} defaultValue={E.DEFAULT_FADE.near} onChange={(x) => setNear(Math.min(x, far - 1))} format={(x) => `${x.toFixed(1)} Å`} />
            <Slider label="Transparência máxima a partir de" value={far} min={4} max={60} step={0.5} defaultValue={E.DEFAULT_FADE.far} onChange={(x) => setFar(Math.max(x, near + 1))} format={(x) => `${x.toFixed(1)} Å`} />
            <Slider label="Opacidade mínima" value={minOpacity} min={0} max={0.9} step={0.01} defaultValue={E.DEFAULT_FADE.minOpacity} onChange={setMinOpacity} format={(x) => `${Math.round(x * 100)}%`} />
            <Toggle checked={perResidue} onChange={setPerResidue} label="Um valor por resíduo (como o script)" />
            <div className="flex gap-1.5">
                <Button variant="primary" icon="layers" loading={working} onClick={() => void apply()} className="flex-1">
                    {applied ? 'Reaplicar' : 'Aplicar gradiente'}
                </Button>
                <Button
                    disabled={!applied}
                    onClick={async () => {
                        const v = viewer();
                        if (v && (await run(E.clearFade(v)))) setApplied(false);
                    }}
                >
                    Limpar
                </Button>
            </div>
        </Section>
    );
}

function FootprintSection({ active }: { active: E.StructureInfo }) {
    const polymer = active.chains.filter((c) => c.isPolymer);
    const defaultTargets = polymer.filter((c) => c.role !== 'binder').map((c) => c.authAsymId);
    const [targets, setTargets] = useState<string[]>(defaultTargets);
    const [source, setSource] = useState<'binder' | 'selection'>('binder');
    const [distance, setDistance] = useState(7);
    const [mode, setMode] = useState<'nearest' | 'uniform'>('nearest');
    const [color, setColor] = useState(hexToInt('#f72585'));
    const [working, setWorking] = useState(false);
    useEffect(() => setTargets(defaultTargets), [active.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const apply = async () => {
        const v = viewer();
        if (!v) return;
        if (targets.length === 0) return toast('Escolha ao menos uma cadeia alvo.', 'error');
        setWorking(true);
        const r = await run(
            E.paintFootprint(v, {
                target: { structureId: active.id, chains: targets },
                source: source === 'selection' ? { kind: 'selection' } : reference('binder', active, 0),
                distance,
                mode,
                color,
            }),
        );
        setWorking(false);
        if (r) toast(`Footprint: ${r.atoms} átomos coloridos.`, 'ok', 2000);
    };

    return (
        <Section title="Footprint na superfície">
            <p className="text-[10.5px] leading-snug text-text-2">
                O <span className="mono">color zone</span> do ChimeraX: átomos do alvo perto da fonte ganham a cor do átomo mais próximo dela. Use com a superfície do alvo
                (aba Estilo).
            </p>
            <Field label="Alvo (cadeias coloridas)">
                <div className="flex flex-wrap gap-1">
                    {polymer.map((c) => {
                        const on = targets.includes(c.authAsymId);
                        return (
                            <button
                                key={c.authAsymId}
                                type="button"
                                onClick={() => setTargets(on ? targets.filter((x) => x !== c.authAsymId) : [...targets, c.authAsymId])}
                                className={cx('press mono h-6 rounded-md border px-2 text-[11px]', on ? 'border-accent bg-accent/15 text-accent' : 'border-stroke-2 text-text-2 hover:text-text-0')}
                                title={E.CHAIN_ROLE_LABELS[c.role]}
                            >
                                {c.authAsymId}
                                {c.alias ? ` · ${c.alias}` : ''}
                            </button>
                        );
                    })}
                </div>
            </Field>
            <Field label="Projetar">
                <Segmented
                    value={source}
                    onChange={setSource}
                    options={[
                        { value: 'binder', label: 'Binder' },
                        { value: 'selection', label: 'Seleção', title: 'Ex.: só as CDRs, selecionadas e pintadas antes' },
                    ]}
                />
            </Field>
            <Slider label="Raio da zona" value={distance} min={2} max={15} step={0.5} defaultValue={7} onChange={setDistance} format={(x) => `${x.toFixed(1)} Å`} />
            <div className="flex items-center gap-2">
                <Segmented
                    className="flex-1"
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: 'nearest', label: 'Cor da fonte' },
                        { value: 'uniform', label: 'Cor única' },
                    ]}
                />
                <Collapse open={mode === 'uniform'}>
                    <ColorInput value={color} onChange={setColor} />
                </Collapse>
            </div>
            <div className="flex gap-1.5">
                <Button variant="primary" icon="target" loading={working} onClick={() => void apply()} className="flex-1">
                    Projetar footprint
                </Button>
                <Button onClick={() => { const v = viewer(); if (v) void run(E.clearFootprint(v)); }}>Limpar</Button>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ImageSection() {
    const [widthMm, setWidthMm] = useState(85);
    const [dpi, setDpi] = useState(300);
    const [supersample, setSupersample] = useState(2);
    const [matchScreen, setMatchScreen] = useState(true);
    const [transparent, setTransparent] = useState(false);
    const [crop, setCrop] = useState(true);
    const busy = useApp((s) => s.busy);
    const v = viewer();
    if (!v) return null;
    const px = E.pixelsForPrint(widthMm, dpi);
    const max = E.maxImageSize(v);
    const vp = E.viewportSize(v);
    return (
        <Section title="Exportar imagem">
            <div className="grid grid-cols-2 gap-2">
                <Field label="Largura">
                    <Segmented<string>
                        value={String(widthMm)}
                        onChange={(x) => setWidthMm(Number(x))}
                        options={[
                            { value: '85', label: '85 mm', title: '1 coluna' },
                            { value: '120', label: '120', title: '1,5 coluna' },
                            { value: '180', label: '180', title: '2 colunas' },
                        ]}
                    />
                </Field>
                <Field label="Resolução">
                    <Segmented<string>
                        value={String(dpi)}
                        onChange={(x) => setDpi(Number(x))}
                        options={[
                            { value: '300', label: '300 dpi' },
                            { value: '600', label: '600' },
                        ]}
                    />
                </Field>
            </div>
            <Field label="Supersampling">
                <Segmented<string>
                    value={String(supersample)}
                    onChange={(x) => setSupersample(Number(x))}
                    options={[
                        { value: '1', label: 'off' },
                        { value: '2', label: '2×' },
                        { value: '3', label: '3×' },
                        { value: '4', label: '4×', title: 'Como o "supersample 4" do ChimeraX; limitado pela GPU' },
                    ]}
                />
            </Field>
            <Toggle checked={matchScreen} onChange={setMatchScreen} label="Contorno proporcional (igual à tela)" />
            <Toggle checked={transparent} onChange={setTransparent} label="Fundo transparente" />
            <Toggle checked={crop} onChange={setCrop} label="Recortar à molécula" />
            <p className="tnum text-[11px] text-text-2">
                {Math.min(px, max)} px de largura{px > max ? ` (limite da GPU: ${max})` : ''}
                {vp && matchScreen ? ` · contorno ×${(Math.min(px, max) / vp.width).toFixed(1)}` : ''}
            </p>
            <Button
                variant="primary"
                icon="camera"
                loading={busy === 'Renderizando imagem'}
                onClick={() => void exportImage({ width: px, transparent, cropToMolecule: crop, supersample, matchScreen }, `proteinpaint_${widthMm}mm_${dpi}dpi.png`)}
            >
                Salvar PNG
            </Button>
        </Section>
    );
}

const SIZES = {
    '720p': { w: 1280, h: 720, label: '720p' },
    '1080p': { w: 1920, h: 1080, label: '1080p' },
    square: { w: 1080, h: 1080, label: 'Quadrado' },
    '4k': { w: 3840, h: 2160, label: '4K' },
} as const;

const FORMATS: { value: MovieFormat; label: string; title: string; alpha: boolean }[] = [
    { value: 'mp4', label: 'MP4', title: 'H.264, toca em qualquer lugar (PowerPoint, navegador)', alpha: false },
    { value: 'webm', label: 'WebM', title: 'VP9 com canal alfa (fundo transparente)', alpha: true },
    { value: 'gif', label: 'GIF', title: 'Paleta otimizada; prefira 720p ou menos', alpha: true },
    { value: 'apng', label: 'APNG', title: 'PNG animado, sem perda, com alfa', alpha: true },
    { value: 'frames', label: 'Quadros', title: 'Sequência de PNG com alfa, numa pasta', alpha: true },
];

function MovieSection() {
    const [motion, setMotion] = useState<'turntable' | 'rock'>('turntable');
    const [axis, setAxis] = useState<'vertical' | 'horizontal'>('vertical');
    const [seconds, setSeconds] = useState(8);
    const [fps, setFps] = useState(30);
    const [amplitude, setAmplitude] = useState(25);
    const [size, setSize] = useState<keyof typeof SIZES>('1080p');
    const [format, setFormat] = useState<MovieFormat>('mp4');
    const [transparent, setTransparent] = useState(false);
    const [supersample, setSupersample] = useState(1);
    const progress = useApp((s) => s.movieProgress);
    const alpha = FORMATS.find((f) => f.value === format)!.alpha;
    const frames = Math.round(seconds * fps);
    const { w, h } = SIZES[size];

    return (
        <Section title="Animação">
            <Segmented
                value={motion}
                onChange={setMotion}
                options={[
                    { value: 'turntable', label: 'Turntable 360°' },
                    { value: 'rock', label: 'Balanço' },
                ]}
            />
            <div className="grid grid-cols-2 gap-2">
                <Field label="Eixo">
                    <Segmented
                        value={axis}
                        onChange={setAxis}
                        options={[
                            { value: 'vertical', label: 'Vertical' },
                            { value: 'horizontal', label: 'Horizontal' },
                        ]}
                    />
                </Field>
                <Field label="Quadros/s">
                    <Segmented<string>
                        value={String(fps)}
                        onChange={(x) => setFps(Number(x))}
                        options={[
                            { value: '24', label: '24' },
                            { value: '30', label: '30' },
                            { value: '60', label: '60' },
                        ]}
                    />
                </Field>
            </div>
            <Slider label="Duração" value={seconds} min={2} max={30} step={1} defaultValue={8} onChange={setSeconds} format={(x) => `${x.toFixed(0)} s · ${Math.round(x * fps)} quadros`} />
            <Collapse open={motion === 'rock'}>
                <Slider label="Amplitude" value={amplitude} min={5} max={90} step={1} defaultValue={25} onChange={setAmplitude} format={(x) => `±${x.toFixed(0)}°`} />
            </Collapse>
            <Field label="Tamanho">
                <Segmented
                    value={size}
                    onChange={setSize}
                    options={(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((k) => ({ value: k, label: SIZES[k].label, title: `${SIZES[k].w}×${SIZES[k].h}` }))}
                />
            </Field>
            <Field label="Formato">
                <Segmented value={format} onChange={setFormat} options={FORMATS.map(({ value, label, title }) => ({ value, label, title }))} />
            </Field>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
                <Toggle checked={supersample > 1} onChange={(x) => setSupersample(x ? 2 : 1)} label="Supersampling 2×" />
                {alpha && <Toggle checked={transparent} onChange={setTransparent} label="Fundo transparente" />}
            </div>
            {progress !== null ? (
                <div className="fade-in flex flex-col gap-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-bg-3">
                        <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200" style={{ transform: `scaleX(${progress})` }} />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="tnum flex-1 text-[11px] text-text-1">{Math.round(progress * 100)}%</span>
                        <Button variant="danger" icon="close" onClick={cancelMovie}>
                            Cancelar
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    variant="primary"
                    icon="spin"
                    onClick={() =>
                        void exportMovie({
                            request: { width: w, height: h, frames, motion, axis, amplitude, transparent: alpha && transparent, supersample },
                            format,
                            fps,
                            name: `proteinpaint_${motion}_${size}`,
                        })
                    }
                >
                    Renderizar {frames} quadros
                </Button>
            )}
            <p className="text-[10.5px] leading-snug text-text-2">
                Cada quadro passa pelo mesmo render da exportação de imagem (multisampling 16×, efeitos do Estúdio) e vai direto para o ffmpeg, sem arquivos intermediários. O turntable fecha o laço sem repetir quadro.
            </p>
        </Section>
    );
}

export function FigurePanel() {
    const active = useActive();
    useApp((s) => s.structures);
    if (!active) return <NoStructure />;
    return (
        <div>
            <ViewsSection active={active} />
            <FadeSection active={active} />
            <FootprintSection active={active} />
            <ImageSection />
            <MovieSection />
            <div className="flex items-center gap-1.5 px-3 py-3 text-[10.5px] text-text-2">
                <Icon name="sun" size={11} /> Luz, material e fundo da figura: aba Estúdio.
            </div>
        </div>
    );
}
