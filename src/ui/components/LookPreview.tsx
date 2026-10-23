/**
 * Tiny previews of a look, drawn in SVG from the look's own numbers — background,
 * key-light direction, roughness, occlusion, outline — so every preset and every
 * saved style gets an honest thumbnail without an extra GPU render.
 */

import { memo, useId, useRef } from 'react';
import type * as E from '@/engine';

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Screen position of a light on a unit disc. Mol* lights are given as inclination /
 * azimuth around the view axis; 180° inclination shines from the camera (disc
 * centre), 90° from the side (rim), less than that from behind the molecule.
 */
export function lightToDisc(l: Pick<E.LookLight, 'inclination' | 'azimuth'>): { x: number; y: number; behind: boolean } {
    const r = (180 - l.inclination) / 90;
    const a = (l.azimuth * Math.PI) / 180;
    // Azimuth 0° points right; screen y grows downwards, so the sine is negated.
    return { x: r * Math.cos(a), y: -r * Math.sin(a), behind: r > 1 };
}

export function discToLight(x: number, y: number): { inclination: number; azimuth: number } {
    const r = Math.min(2, Math.hypot(x, y));
    const azimuth = ((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360;
    return { inclination: Math.max(0, Math.min(180, 180 - r * 90)), azimuth };
}

function Sphere({ cx, cy, r, color, look, gid }: { cx: number; cy: number; r: number; color: string; look: E.Look; gid: string }) {
    return (
        <g>
            <circle cx={cx} cy={cy} r={r} fill={`url(#${gid}-shade)`} />
            <circle cx={cx} cy={cy} r={r} fill={color} style={{ mixBlendMode: 'multiply' }} />
            <circle cx={cx} cy={cy} r={r} fill={`url(#${gid}-spec)`} />
            {look.outline >= 0.5 && <circle cx={cx} cy={cy} r={r} fill="none" stroke={hex(look.outlineColor)} strokeWidth={Math.min(3, look.outline * 0.8)} />}
        </g>
    );
}

export const LookPreview = memo(function LookPreview({ look, size = 52, className }: { look: E.Look; size?: number; className?: string }) {
    const gid = useId().replace(/:/g, '');
    const bg = look.background;
    const key = look.lights.reduce<E.LookLight | null>((best, l) => (!best || l.intensity > best.intensity ? l : best), null);
    const p = key ? lightToDisc(key) : { x: -0.3, y: -0.4, behind: false };
    const hx = 50 + Math.max(-1, Math.min(1, p.x)) * 22;
    const hy = 50 + Math.max(-1, Math.min(1, p.y)) * 22;
    const keyI = key?.intensity ?? 0;
    const lit = Math.min(1, look.ambient * 0.55 + keyI * 0.6) * look.exposure;
    const rough = look.material.ribbon.roughness;
    const specSize = 8 + rough * 30;
    const specOpacity = Math.min(0.95, (1 - rough) * 0.9 + 0.08) * Math.min(1, keyI + 0.2);
    const occl = Math.min(0.75, look.occlusion * 0.35);
    const bgFill = bg.kind === 'solid' ? hex(bg.a) : `url(#${gid}-bg)`;

    return (
        <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
            <defs>
                {bg.kind === 'vertical' && (
                    <linearGradient id={`${gid}-bg`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor={hex(bg.a)} />
                        <stop offset="1" stopColor={hex(bg.b)} />
                    </linearGradient>
                )}
                {bg.kind === 'radial' && (
                    <radialGradient id={`${gid}-bg`}>
                        <stop offset="0" stopColor={hex(bg.a)} />
                        <stop offset="1" stopColor={hex(bg.b)} />
                    </radialGradient>
                )}
                {bg.kind === 'transparent' && (
                    <pattern id={`${gid}-bg`} width="16" height="16" patternUnits="userSpaceOnUse">
                        <rect width="16" height="16" fill="#c9ced6" />
                        <rect width="8" height="8" fill="#e9ecf0" />
                        <rect x="8" y="8" width="8" height="8" fill="#e9ecf0" />
                    </pattern>
                )}
                <radialGradient id={`${gid}-shade`} cx={hx / 100} cy={hy / 100} r="0.85" fx={hx / 100} fy={hy / 100}>
                    <stop offset="0" stopColor="#ffffff" stopOpacity={lit} />
                    <stop offset="0.65" stopColor="#b8b8b8" stopOpacity={0.6 + lit * 0.4} />
                    <stop offset="1" stopColor="#3a3a3a" stopOpacity={0.6 + occl * 0.5} />
                </radialGradient>
                <radialGradient id={`${gid}-spec`} cx={hx / 100} cy={hy / 100} r={specSize / 100}>
                    <stop offset="0" stopColor="#ffffff" stopOpacity={specOpacity} />
                    <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
                </radialGradient>
                <radialGradient id={`${gid}-ao`} cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0.4" stopColor="#000" stopOpacity={occl} />
                    <stop offset="1" stopColor="#000" stopOpacity="0" />
                </radialGradient>
            </defs>
            <rect width="100" height="100" fill={bgFill} />
            {look.fog >= 1 && <rect width="100" height="100" fill={hex(bg.kind === 'solid' ? bg.a : bg.b)} opacity={Math.min(0.35, look.fog / 200)} />}
            <Sphere cx={64} cy={62} r={20} color="#e3a35b" look={look} gid={gid} />
            {occl > 0 && <ellipse cx={54} cy={56} rx={14} ry={14} fill={`url(#${gid}-ao)`} />}
            <Sphere cx={42} cy={44} r={26} color="#5fa8e8" look={look} gid={gid} />
        </svg>
    );
});

/**
 * A draggable light on a disc: centre = from the camera, inner ring = from the side,
 * outer band = from behind (rim light).
 */
export function LightDial({ light, onChange, size = 64 }: { light: E.LookLight; onChange: (patch: { inclination: number; azimuth: number }) => void; size?: number }) {
    const ref = useRef<SVGSVGElement>(null);
    const p = lightToDisc(light);
    const R = 22; // radius of the 90° ring in viewBox units
    const drag = (e: React.PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        el.setPointerCapture(e.pointerId);
        const update = (ev: { clientX: number; clientY: number }) => {
            const box = el.getBoundingClientRect();
            const x = ((ev.clientX - box.left) / box.width - 0.5) * 100;
            const y = ((ev.clientY - box.top) / box.height - 0.5) * 100;
            onChange(discToLight(x / R, y / R));
        };
        update(e);
        const move = (ev: PointerEvent) => update(ev);
        const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
    };
    const col = hex(light.color);
    return (
        <svg
            ref={ref}
            viewBox="-50 -50 100 100"
            width={size}
            height={size}
            onPointerDown={drag}
            className="shrink-0 cursor-crosshair touch-none"
            role="slider"
            aria-label="Direção da luz"
            aria-valuetext={`inclinação ${light.inclination.toFixed(0)}°, azimute ${light.azimuth.toFixed(0)}°`}
        >
            <circle r={2 * R + 2} fill="var(--bg-0)" stroke="var(--stroke)" />
            <circle r={R} fill="var(--bg-2)" stroke="var(--stroke-2)" />
            <circle r={R * 0.45} fill="url(#dial-ball)" opacity="0.9" />
            <defs>
                <radialGradient id="dial-ball" cx={0.5 + p.x * 0.25} cy={0.5 + p.y * 0.25} r="0.7">
                    <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
                    <stop offset="1" stopColor="#566" stopOpacity="0.4" />
                </radialGradient>
            </defs>
            <line x1="0" y1="0" x2={p.x * R} y2={p.y * R} stroke={col} strokeOpacity="0.5" strokeDasharray="2 2" />
            <circle cx={p.x * R} cy={p.y * R} r="5.5" fill={col} stroke={p.behind ? 'var(--warn)' : 'var(--text-0)'} strokeWidth="1.5" style={{ filter: `drop-shadow(0 0 4px ${col})` }} />
        </svg>
    );
}
