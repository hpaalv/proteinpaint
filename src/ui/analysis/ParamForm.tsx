/**
 * Declarative parameter forms: every analysis lists its parameters as specs (type,
 * range, help, basic/advanced, group), so all of a tool's options are reachable and
 * the layout is uniform. Values are a plain object the tool receives as-is.
 */

import { useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { cx } from '../components/Primitives';

export type FieldSpec =
    | { key: string; label: string; type: 'number'; min?: number; max?: number; step?: number; unit?: string; help?: string; advanced?: boolean; group?: string; when?: (v: Values) => boolean }
    | { key: string; label: string; type: 'bool'; help?: string; advanced?: boolean; group?: string; when?: (v: Values) => boolean }
    | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; help?: string; advanced?: boolean; group?: string; when?: (v: Values) => boolean }
    | { key: string; label: string; type: 'text'; placeholder?: string; help?: string; advanced?: boolean; group?: string; when?: (v: Values) => boolean };

export type Values = Record<string, unknown>;

function HelpDot({ text }: { text?: string }) {
    if (!text) return null;
    return (
        <span title={text} className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-stroke-2 text-[9px] text-text-2">
            ?
        </span>
    );
}

function Field({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
    const label = (
        <span className="flex items-center text-[11.5px] text-text-1">
            {spec.label}
            <HelpDot text={spec.help} />
        </span>
    );
    switch (spec.type) {
        case 'bool':
            return (
                <label className="flex h-6 cursor-pointer items-center justify-between gap-2">
                    {label}
                    <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
                </label>
            );
        case 'select':
            return (
                <label className="flex items-center justify-between gap-2">
                    {label}
                    <select
                        value={String(value)}
                        onChange={(e) => onChange(e.target.value)}
                        className="h-6 max-w-[55%] rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] text-text-0 outline-none focus:border-accent"
                    >
                        {spec.options.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </label>
            );
        case 'text':
            return (
                <label className="flex flex-col gap-1">
                    {label}
                    <input
                        value={String(value ?? '')}
                        placeholder={spec.placeholder}
                        spellCheck={false}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={(e) => onChange(e.target.value)}
                        className="mono h-6 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] text-text-0 outline-none focus:border-accent"
                    />
                </label>
            );
        case 'number':
            return (
                <label className="flex items-center justify-between gap-2">
                    {label}
                    <span className="flex items-center gap-1">
                        <input
                            type="number"
                            value={Number(value)}
                            min={spec.min}
                            max={spec.max}
                            step={spec.step ?? 'any'}
                            onKeyDown={(e) => e.stopPropagation()}
                            onChange={(e) => {
                                const n = Number(e.target.value);
                                if (Number.isFinite(n)) onChange(n);
                            }}
                            className="tnum h-6 w-20 rounded border border-stroke-2 bg-bg-1 px-1.5 text-right text-[11.5px] text-text-0 outline-none focus:border-accent"
                        />
                        {spec.unit && <span className="w-7 text-[10.5px] text-text-2">{spec.unit}</span>}
                    </span>
                </label>
            );
    }
}

export function ParamForm({ specs, values, onChange, children }: { specs: FieldSpec[]; values: Values; onChange: (v: Values) => void; children?: ReactNode }) {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const visible = specs.filter((s) => !s.when || s.when(values));
    const groups = new Map<string, FieldSpec[]>();
    for (const s of visible) {
        if (s.advanced && !showAdvanced) continue;
        const g = s.group ?? '';
        groups.set(g, [...(groups.get(g) ?? []), s]);
    }
    const advancedCount = visible.filter((s) => s.advanced).length;
    return (
        <div className="flex flex-col gap-2">
            {children}
            {[...groups.entries()].map(([g, list]) => (
                <div key={g} className="flex flex-col gap-1.5">
                    {g && <div className="mt-1 text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">{g}</div>}
                    {list.map((spec) => (
                        <Field key={spec.key} spec={spec} value={values[spec.key]} onChange={(v) => onChange({ ...values, [spec.key]: v })} />
                    ))}
                </div>
            ))}
            {advancedCount > 0 && (
                <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className={cx('mt-1 flex items-center gap-1 self-start text-[11px]', showAdvanced ? 'text-accent' : 'text-text-2 hover:text-text-0')}
                >
                    <Icon name={showAdvanced ? 'chevronDown' : 'chevron'} size={12} />
                    {showAdvanced ? 'Ocultar avançados' : `Parâmetros avançados (${advancedCount})`}
                </button>
            )}
        </div>
    );
}
