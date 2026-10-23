import { useEffect, useState } from 'react';
import * as E from '@/engine';
import { useApp, viewer } from '@/store/app';
import { applySavedStyle, deleteStyle, saveCurrentStyle, useStyles } from '@/store/styles';
import { Icon } from '../components/Icon';
import { LightDial, LookPreview } from '../components/LookPreview';
import { Button, ColorInput, Collapse, IconButton, Section, Segmented, Slider, TextInput, Toggle, cx } from '../components/Primitives';
import { act } from '@/store/history';

const PRESET_ORDER: E.LookPreset[] = ['soft', 'chimerax-soft', 'white-figure', 'illustrative', 'glossy', 'clay', 'poster-dark', 'cinematic', 'flat', 'raytraced'];

const COST_DOTS: Record<E.LookDefinition['cost'], number> = { low: 1, medium: 2, high: 3 };

/** Material shortcuts, named as in ChimeraX where there is an equivalent. */
const MATERIALS: { id: string; label: string; title: string; m: E.LayerMaterial }[] = [
    { id: 'dull', label: 'Fosco', title: 'ChimeraX "material dull"', m: { metalness: 0, roughness: 1, bumpiness: 0 } },
    { id: 'satin', label: 'Cetim', title: 'Brilho suave', m: { metalness: 0, roughness: 0.6, bumpiness: 0 } },
    { id: 'shiny', label: 'Brilhante', title: 'ChimeraX "material shiny"', m: { metalness: 0, roughness: 0.25, bumpiness: 0 } },
    { id: 'metal', label: 'Metálico', title: 'Reflexo colorido pelo próprio material', m: { metalness: 0.65, roughness: 0.35, bumpiness: 0 } },
];

type BgPreset = { id: string; label: string; bg: E.LookBackground };
const BACKGROUNDS: BgPreset[] = [
    { id: 'theme', label: 'Tema', bg: { kind: 'solid', a: E.APP_BACKGROUND, b: E.APP_BACKGROUND } },
    { id: 'white', label: 'Branco', bg: { kind: 'solid', a: 0xffffff, b: 0xffffff } },
    { id: 'black', label: 'Preto', bg: { kind: 'solid', a: 0x000000, b: 0x000000 } },
    { id: 'cream', label: 'Creme', bg: { kind: 'solid', a: 0xf6f1e7, b: 0xf6f1e7 } },
    { id: 'vertical', label: 'Gradiente', bg: { kind: 'vertical', a: 0x1d2636, b: 0x07090d } },
    { id: 'radial', label: 'Radial', bg: { kind: 'radial', a: 0x26324a, b: 0x07090d } },
    { id: 'studio', label: 'Estúdio', bg: { kind: 'radial', a: 0xffffff, b: 0xd9dde3 } },
    { id: 'transparent', label: 'Transparente', bg: { kind: 'transparent', a: 0xffffff, b: 0xffffff } },
];

const sameBg = (a: E.LookBackground, b: E.LookBackground) => a.kind === b.kind && a.a === b.a && (a.kind === 'solid' || a.kind === 'transparent' || a.b === b.b);

/** The current look, re-read after every change made through `set`. */
function useLook() {
    const v = viewer();
    const [look, setLook] = useState<E.Look | null>(() => (v ? E.getLook(v) : null));
    const preset = useApp((s) => s.look);
    const rev = useApp((s) => s.lookRev);
    // A look applied elsewhere (saved style, test harness) must show here too.
    useEffect(() => {
        if (v) setLook(E.getLook(v));
    }, [preset, rev, v]);
    const set = (patch: Partial<E.Look>, durationMs = 0) => {
        if (!v) return;
        void E.tuneLook(v, patch, durationMs);
        setLook(E.getLook(v));
        if (useApp.getState().look !== 'custom') useApp.setState({ look: 'custom' });
    };
    return { v, look, set, setLook };
}

function PresetGallery({ onApply }: { onApply: (p: E.LookPreset) => void }) {
    const active = useApp((s) => s.look);
    const v = viewer();
    const gi = v ? E.illuminationSupported(v) : false;
    return (
        <div className="grid grid-cols-2 gap-1.5">
            {PRESET_ORDER.filter((p) => p !== 'raytraced' || gi).map((p) => {
                const def = E.LOOK_PRESETS[p];
                const on = active === p;
                return (
                    <button
                        key={p}
                        type="button"
                        title={def.description}
                        onClick={() => onApply(p)}
                        className={cx(
                            'press group relative flex items-center gap-2 overflow-hidden rounded-lg border p-1.5 text-left',
                            on ? 'border-accent/70 bg-accent/10 shadow-[var(--glow-accent)]' : 'border-stroke-2 bg-bg-2 hover:-translate-y-px hover:border-text-2 hover:bg-bg-3',
                        )}
                    >
                        <LookPreview look={def.look} size={38} className="shrink-0 overflow-hidden rounded-md ring-1 ring-black/30 transition-transform duration-300 group-hover:scale-105" />
                        <span className="flex min-w-0 flex-col">
                            <span className={cx('truncate text-[12px] font-medium', on ? 'text-accent' : 'text-text-0')}>{def.label}</span>
                            <span className="flex items-center gap-0.5" title={`custo de GPU ${def.cost === 'low' ? 'baixo' : def.cost === 'medium' ? 'médio' : 'alto'}`}>
                                {[1, 2, 3].map((i) => (
                                    <span key={i} className={cx('h-1 w-2.5 rounded-full', i <= COST_DOTS[def.cost] ? (def.cost === 'high' ? 'bg-warn/80' : 'bg-text-1') : 'bg-stroke-2')} />
                                ))}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

function LightsEditor({ look, set }: { look: E.Look; set: (p: Partial<E.Look>, d?: number) => void }) {
    const patchLight = (i: number, patch: Partial<E.LookLight>) => set({ lights: look.lights.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
    return (
        <>
            {look.lights.length === 0 && <p className="text-[11.5px] text-text-2">Sem luz direcional: só ambiente (visual chapado).</p>}
            {look.lights.map((l, i) => (
                <div key={i} className="scale-in flex items-center gap-2.5 rounded-lg border border-stroke bg-bg-0/50 p-2">
                    <LightDial light={l} onChange={(p) => patchLight(i, p)} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-[11.5px] font-medium text-text-0">{i === 0 ? 'Principal' : i === 1 ? 'Preenchimento' : i === 2 ? 'Recorte' : `Luz ${i + 1}`}</span>
                            <span className="tnum text-[10.5px] text-text-2">
                                {l.inclination.toFixed(0)}° · {l.azimuth.toFixed(0)}°
                            </span>
                            <span className="flex-1" />
                            <ColorInput value={l.color} onChange={(c) => patchLight(i, { color: c })} size={18} title="Cor da luz" />
                            <IconButton icon="trash" size={20} title="Remover luz" onClick={() => set({ lights: look.lights.filter((_, k) => k !== i) }, 250)} />
                        </div>
                        <Slider label="Intensidade" value={l.intensity} min={0} max={3} onChange={(x) => patchLight(i, { intensity: x })} />
                    </div>
                </div>
            ))}
            {look.lights.length < 4 && (
                <Button
                    icon="plus"
                    variant="ghost"
                    onClick={() => set({ lights: [...look.lights, { inclination: 40, azimuth: 200, color: 0xdfe9ff, intensity: 0.4 }] }, 300)}
                    title="Até 4 luzes direcionais"
                >
                    Adicionar luz
                </Button>
            )}
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <Slider label="Luz ambiente" value={look.ambient} min={0} max={2} defaultValue={0.8} onChange={(x) => set({ ambient: x })} />
                <ColorInput value={look.ambientColor} onChange={(c) => set({ ambientColor: c })} title="Cor do ambiente" />
            </div>
            <Slider label="Exposição" value={look.exposure} min={0.3} max={2} defaultValue={1} onChange={(x) => set({ exposure: x })} />
        </>
    );
}

function MaterialEditor({ look, set }: { look: E.Look; set: (p: Partial<E.Look>, d?: number) => void }) {
    const [layer, setLayer] = useState<E.Layer | 'all'>('all');
    const shown = look.material[layer === 'all' ? 'ribbon' : layer];
    const write = (m: Partial<E.LayerMaterial>) => {
        const next = { ...look.material };
        for (const k of layer === 'all' ? (['ribbon', 'atoms', 'surface'] as E.Layer[]) : [layer]) next[k] = { ...next[k], ...m };
        set({ material: next });
    };
    return (
        <>
            <Segmented<E.Layer | 'all'>
                value={layer}
                onChange={setLayer}
                options={[
                    { value: 'all', label: 'Todas' },
                    { value: 'ribbon', label: 'Fita' },
                    { value: 'atoms', label: 'Átomos' },
                    { value: 'surface', label: 'Superfície' },
                ]}
            />
            <div className="grid grid-cols-4 gap-1">
                {MATERIALS.map((m) => {
                    const on = Math.abs(shown.roughness - m.m.roughness) < 0.01 && Math.abs(shown.metalness - m.m.metalness) < 0.01;
                    return (
                        <Button key={m.id} active={on} title={m.title} onClick={() => write(m.m)} className="px-1">
                            {m.label}
                        </Button>
                    );
                })}
            </div>
            <Slider label="Rugosidade" value={shown.roughness} min={0} max={1} defaultValue={1} onChange={(x) => write({ roughness: x })} title="1 = fosco (dull), baixo = brilhante (shiny)" />
            <Slider label="Metalicidade" value={shown.metalness} min={0} max={1} defaultValue={0} onChange={(x) => write({ metalness: x })} />
            <Toggle checked={look.celShaded} onChange={(x) => set({ celShaded: x })} label="Sombreamento em faixas (cel/toon)" />
            <p className="text-[10.5px] leading-snug text-text-2">Materiais são aplicados nas representações (uma atualização por mudança); as luzes e efeitos, direto na GPU.</p>
        </>
    );
}

function EffectsEditor({ look, set }: { look: E.Look; set: (p: Partial<E.Look>, d?: number) => void }) {
    const v = viewer();
    const gi = v ? E.illuminationSupported(v) : false;
    const off = (x: number, digits = 2) => (x <= 0.005 ? 'off' : x.toFixed(digits));
    return (
        <>
            <Slider label="Oclusão de ambiente" value={look.occlusion} min={0} max={3} step={0.05} defaultValue={0.8} onChange={(x) => set({ occlusion: x })} format={(x) => off(x)} />
            <Collapse open={look.occlusion > 0.005} className="flex flex-col gap-2.5">
                <Slider label="Alcance da oclusão" value={look.occlusionReach} min={2} max={64} step={1} defaultValue={32} onChange={(x) => set({ occlusionReach: x })} format={(x) => `${x.toFixed(0)} Å`} />
                <Toggle checked={look.occlusionMultiScale} onChange={(x) => set({ occlusionMultiScale: x })} label="Várias escalas (fendas + forma geral)" />
            </Collapse>
            <Slider label="Sombras" value={look.shadows} min={0} max={16} step={0.5} defaultValue={0} onChange={(x) => set({ shadows: x })} format={(x) => (x <= 0.05 ? 'off' : `${x.toFixed(1)} Å`)} />
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <Slider label="Contorno (silhueta)" value={look.outline} min={0} max={6} step={1} defaultValue={0} onChange={(x) => set({ outline: x })} format={(x) => (x < 0.5 ? 'off' : `${x.toFixed(0)} px`)} />
                <ColorInput value={look.outlineColor} onChange={(c) => set({ outlineColor: c })} title="Cor do contorno" />
            </div>
            <Collapse open={look.outline >= 0.5}>
                <Slider label="Sensibilidade do contorno" value={1 - look.outlineThreshold} min={0} max={0.95} step={0.01} defaultValue={0.67} onChange={(x) => set({ outlineThreshold: 1 - x })} format={(x) => `${Math.round(x * 100)}%`} title="Mais alto: contorna também dobras internas, não só a borda" />
            </Collapse>
            <Slider label="Névoa (depth cue)" value={look.fog} min={0} max={100} step={1} defaultValue={15} onChange={(x) => set({ fog: x })} format={(x) => (x < 1 ? 'off' : x.toFixed(0))} />
            <Slider label="Profundidade de campo" value={look.dof} min={0} max={24} step={1} defaultValue={0} onChange={(x) => set({ dof: x })} format={(x) => (x < 1 ? 'off' : x.toFixed(0))} title="Desfoca o que está longe do centro da câmera" />
            <Collapse open={look.dof >= 1}>
                <Slider label="Faixa em foco" value={look.dofRange} min={2} max={120} step={1} defaultValue={20} onChange={(x) => set({ dofRange: x })} format={(x) => `${x.toFixed(0)}`} />
            </Collapse>
            <Slider label="Brilho (bloom)" value={look.bloom} min={0} max={2} step={0.05} defaultValue={0} onChange={(x) => set({ bloom: x })} format={(x) => off(x)} />
            <Slider label="Nitidez" value={look.sharpen} min={0} max={1} step={0.05} defaultValue={0} onChange={(x) => set({ sharpen: x })} format={(x) => off(x)} />
            {gi ? (
                <>
                    <Toggle checked={look.illumination} onChange={(x) => set({ illumination: x }, 300)} label="Ray tracing (iluminação global)" />
                    <Collapse open={look.illumination}>
                        <Slider label="Rebatimentos" value={look.giBounces} min={1} max={8} step={1} defaultValue={4} onChange={(x) => set({ giBounces: x })} format={(x) => x.toFixed(0)} />
                        <p className="pt-1.5 text-[10.5px] leading-snug text-text-2">Refina enquanto a câmera está parada; ao girar, volta ao modo rápido.</p>
                    </Collapse>
                </>
            ) : (
                <p className="text-[10.5px] text-text-2">Ray tracing indisponível nesta GPU.</p>
            )}
        </>
    );
}

function BackgroundEditor({ look, set }: { look: E.Look; set: (p: Partial<E.Look>, d?: number) => void }) {
    const bg = look.background;
    return (
        <>
            <div className="grid grid-cols-4 gap-1">
                {BACKGROUNDS.map((b) => {
                    const on = sameBg(bg, b.bg);
                    const swatch =
                        b.bg.kind === 'transparent'
                            ? undefined
                            : b.bg.kind === 'solid'
                              ? `#${b.bg.a.toString(16).padStart(6, '0')}`
                              : `${b.bg.kind === 'radial' ? 'radial-gradient(circle' : 'linear-gradient(180deg'}, #${b.bg.a.toString(16).padStart(6, '0')}, #${b.bg.b.toString(16).padStart(6, '0')})`;
                    return (
                        <button
                            key={b.id}
                            type="button"
                            onClick={() => set({ background: b.bg }, 350)}
                            className={cx('press flex flex-col items-center gap-1 rounded-md border p-1 text-[10.5px]', on ? 'border-accent text-accent' : 'border-stroke-2 text-text-1 hover:border-text-2 hover:text-text-0')}
                        >
                            <span className={cx('h-5 w-full rounded-[4px] ring-1 ring-black/30', b.bg.kind === 'transparent' && 'checker')} style={swatch ? { background: swatch } : undefined} />
                            {b.label}
                        </button>
                    );
                })}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-text-1">
                {bg.kind === 'vertical' ? 'Topo' : bg.kind === 'radial' ? 'Centro' : 'Cor'}
                <ColorInput value={bg.a} onChange={(c) => set({ background: { ...bg, a: c, b: bg.kind === 'solid' || bg.kind === 'transparent' ? c : bg.b } })} />
                {(bg.kind === 'vertical' || bg.kind === 'radial') && (
                    <>
                        {bg.kind === 'vertical' ? 'Base' : 'Borda'}
                        <ColorInput value={bg.b} onChange={(c) => set({ background: { ...bg, b: c } })} />
                    </>
                )}
                {bg.kind === 'transparent' && <span className="text-text-2">· a cor só aparece na tela</span>}
            </div>
        </>
    );
}

/**
 * Light coming out of the molecule itself: the selected atoms are made emissive and
 * the bloom pass spreads that into the scene. Useful to make a hotspot, an epitope or
 * a ligand read as lit from inside, which no amount of external lighting does.
 */
function EmissiveEditor({ look, set }: { look: E.Look; set: (p: Partial<E.Look>, d?: number) => void }) {
    const selection = useApp((s) => s.selection);
    const active = useApp((s) => s.structures.find((x) => x.id === s.activeId) ?? s.structures[0]);
    const [glow, setGlow] = useState(0);
    const v = viewer();
    if (!v) return null;
    const apply = (value: number) => {
        setGlow(value);
        void act('brilho da seleção', () => E.setEmissive(v, { kind: 'selection' }, value));
        // Emissive atoms barely show without the bloom pass; turn it on the first time.
        if (value > 0.02 && (look.bloom ?? 0) < 0.01) set({ bloom: 0.8 }, 250);
    };
    return (
        <>
            <p className="text-[10.5px] leading-snug text-text-2">
                Faz a <span className="text-text-1">seleção atual</span> emitir luz. Selecione os resíduos (aba Seleção, trilha de sequência ou clique) e ajuste o brilho.
            </p>
            <Slider
                label="Brilho da seleção"
                value={glow}
                min={0}
                max={1}
                step={0.02}
                defaultValue={0}
                disabled={!selection}
                onChange={apply}
                format={(x) => (x < 0.02 ? 'apagado' : `${Math.round(x * 100)}%`)}
            />
            {!selection && <p className="text-[10.5px] text-warn">Nada selecionado.</p>}
            <Slider label="Difusão do brilho (bloom)" value={look.bloom} min={0} max={2} step={0.05} defaultValue={0} onChange={(bloom) => set({ bloom })} format={(x) => (x < 0.01 ? 'off' : x.toFixed(2))} />
            <Button
                variant="ghost"
                icon="close"
                onClick={() => {
                    setGlow(0);
                    if (active) void act('limpar brilho', () => E.clearEmissive(v, active.id));
                }}
            >
                Apagar o brilho
            </Button>
        </>
    );
}

function CameraEditor() {
    const v = viewer();
    const [projection, setProjectionState] = useState<E.CameraProjection>('orthographic');
    const clip = useApp((s) => s.clip);
    const [motion, setMotion] = useState<'off' | 'spin' | 'rock'>('off');
    if (!v) return null;
    return (
        <>
            <Segmented<E.CameraProjection>
                value={projection}
                onChange={(p) => {
                    setProjectionState(p);
                    E.setProjection(v, p);
                }}
                options={[
                    { value: 'orthographic', label: 'Ortográfica' },
                    { value: 'perspective', label: 'Perspectiva' },
                ]}
            />
            <Slider
                label="Corte de profundidade"
                value={clip}
                min={0}
                max={95}
                step={1}
                defaultValue={0}
                onChange={(x) => {
                    useApp.setState({ clip: x });
                    E.setClip(v, x);
                }}
                format={(x) => (x === 0 ? 'off' : `${x.toFixed(0)}%`)}
            />
            <Segmented<'off' | 'spin' | 'rock'>
                value={motion}
                onChange={(m) => {
                    setMotion(m);
                    E.setSpin(v, m === 'spin');
                    if (m === 'rock') E.setRock(v, true);
                }}
                options={[
                    { value: 'off', label: 'Parado' },
                    { value: 'spin', label: 'Girar' },
                    { value: 'rock', label: 'Balançar' },
                ]}
            />
            <div className="grid grid-cols-4 gap-1">
                <Button onClick={() => E.rotateView(v, 'y', 90)} title="Girar 90° no eixo vertical">
                    Y 90°
                </Button>
                <Button onClick={() => E.rotateView(v, 'x', 90)} title="Girar 90° no eixo horizontal">
                    X 90°
                </Button>
                <Button onClick={() => E.rotateView(v, 'z', 90)} title="Girar 90° em torno da direção de visão">
                    Z 90°
                </Button>
                <Button onClick={() => E.rotateView(v, 'y', 180)}>180°</Button>
            </div>
            <p className="text-[10.5px] text-text-2">Vistas pela geometria do complexo (docking, sulco): aba Figura.</p>
        </>
    );
}

function SavedStyles() {
    const styles = useStyles((s) => s.styles);
    const [name, setName] = useState('');
    return (
        <>
            <div className="flex gap-1.5">
                <TextInput
                    value={name}
                    onChange={setName}
                    onSubmit={() => {
                        saveCurrentStyle(name);
                        setName('');
                    }}
                    placeholder="Nome do estilo atual…"
                    className="min-w-0 flex-1"
                />
                <Button
                    icon="plus"
                    onClick={() => {
                        saveCurrentStyle(name);
                        setName('');
                    }}
                >
                    Salvar
                </Button>
            </div>
            {styles.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-text-2">Salve o visual atual (luzes, materiais, efeitos, fundo e paleta de cadeias) para aplicar em qualquer estrutura depois.</p>
            ) : (
                <div className="flex flex-col gap-1">
                    {styles.map((s) => (
                        <div key={s.id} className="group scale-in flex items-center gap-2 rounded-md border border-transparent p-1 hover:border-stroke-2 hover:bg-bg-2">
                            <button type="button" className="press flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void applySavedStyle(s)} title="Aplicar">
                                <LookPreview look={s.look} size={30} className="shrink-0 rounded ring-1 ring-black/30" />
                                <span className="min-w-0 flex-1 truncate text-[12px] text-text-0">{s.name}</span>
                            </button>
                            <span className="text-[10.5px] text-text-2 opacity-0 transition-opacity group-hover:opacity-100">{new Date(s.created).toLocaleDateString('pt-BR')}</span>
                            <IconButton icon="trash" size={22} title="Apagar estilo" className="opacity-0 group-hover:opacity-100" onClick={() => deleteStyle(s.id)} />
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

export function StudioPanel() {
    const { v, look, set, setLook } = useLook();
    if (!v || !look) return null;

    const applyPreset = (p: E.LookPreset) => {
        void E.applyLookPreset(v, p);
        useApp.setState({ look: p });
        setLook(E.getLook(v));
    };

    return (
        <div>
            <Section title="Visual">
                <PresetGallery onApply={applyPreset} />
                <p className="flex items-center gap-1.5 text-[10.5px] text-text-2">
                    <Icon name="sun" size={11} /> Os presets mudam luz, material, efeitos e fundo, nunca as representações nem as cores.
                </p>
            </Section>
            <Section title="Luzes">
                <LightsEditor look={look} set={set} />
            </Section>
            <Section title="Material">
                <MaterialEditor look={look} set={set} />
            </Section>
            <Section title="Efeitos">
                <EffectsEditor look={look} set={set} />
            </Section>
            <Section title="Luz da seleção">
                <EmissiveEditor look={look} set={set} />
            </Section>
            <Section title="Fundo">
                <BackgroundEditor look={look} set={set} />
            </Section>
            <Section title="Câmera" defaultOpen={false}>
                <CameraEditor />
            </Section>
            <Section title="Meus estilos">
                <SavedStyles />
            </Section>
        </div>
    );
}
