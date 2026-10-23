/**
 * Shared controls. Dense desktop sizing (28 px rows), the same look everywhere.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function cx(...parts: (string | false | null | undefined)[]): string {
    return parts.filter(Boolean).join(' ');
}

export function Button({
    children,
    onClick,
    icon,
    variant = 'default',
    disabled,
    title,
    className,
    active,
    loading,
}: {
    children?: ReactNode;
    onClick?: () => void;
    icon?: IconName;
    variant?: 'default' | 'primary' | 'ghost' | 'danger';
    disabled?: boolean;
    title?: string;
    className?: string;
    active?: boolean;
    /** Shows a spinner in place of the icon and blocks clicks. */
    loading?: boolean;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled || loading}
            onClick={onClick}
            aria-busy={loading || undefined}
            className={cx(
                'press inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40',
                loading && 'disabled:cursor-progress disabled:opacity-80',
                variant === 'primary' && 'bg-accent text-bg-0 shadow-[0_1px_0_rgb(255_255_255/0.25)_inset] hover:brightness-110 hover:shadow-[var(--glow-accent)]',
                variant === 'default' && 'border border-stroke-2 bg-bg-2 text-text-0 hover:border-text-2 hover:bg-bg-3',
                variant === 'ghost' && 'text-text-1 hover:bg-bg-3 hover:text-text-0',
                variant === 'danger' && 'border border-err/40 text-err hover:bg-err/10',
                active && 'border-accent! bg-accent/15! text-accent!',
                className,
            )}
        >
            {loading ? <Spinner size={13} /> : icon && <Icon name={icon} size={14} />}
            {children}
        </button>
    );
}

export function IconButton({
    icon,
    onClick,
    title,
    active,
    size = 28,
    className,
    disabled,
}: {
    icon: IconName;
    onClick?: () => void;
    title: string;
    active?: boolean;
    size?: number;
    className?: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            disabled={disabled}
            onClick={onClick}
            style={{ width: size, height: size }}
            className={cx(
                'press inline-flex shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
                active ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-3 hover:text-text-0',
                className,
            )}
        >
            <Icon name={icon} size={Math.round(size * 0.55)} />
        </button>
    );
}

export function Segmented<T extends string>({
    value,
    options,
    onChange,
    className,
}: {
    value: T;
    options: readonly { value: T; label: ReactNode; title?: string }[];
    onChange: (v: T) => void;
    className?: string;
}) {
    // Equal-width segments, so the thumb is a translate of its own width: no measuring.
    const index = options.findIndex((o) => o.value === value);
    return (
        <div className={cx('relative flex rounded-md border border-stroke-2 bg-bg-1 p-0.5', className)}>
            <div className="pointer-events-none absolute inset-0.5 flex">
                <div
                    className={cx('h-full rounded bg-bg-3 shadow-sm ring-1 ring-white/5 transition-[transform,opacity] duration-300 ease-[var(--ease-spring)]', index < 0 && 'opacity-0')}
                    style={{ width: `${100 / Math.max(1, options.length)}%`, transform: `translateX(${Math.max(0, index) * 100}%)` }}
                />
            </div>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    title={o.title}
                    onClick={() => onChange(o.value)}
                    className={cx(
                        'relative flex h-6 min-w-0 flex-1 basis-0 items-center justify-center gap-1 rounded px-2 text-[12px] whitespace-nowrap transition-colors duration-200',
                        value === o.value ? 'text-text-0' : 'text-text-2 hover:text-text-0',
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Slider({
    label,
    value,
    min,
    max,
    step = 0.01,
    onChange,
    format = (v) => v.toFixed(2),
    defaultValue,
    disabled,
    title,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    format?: (v: number) => string;
    /** Double-clicking the label restores it. */
    defaultValue?: number;
    disabled?: boolean;
    title?: string;
}) {
    const fill = `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%`;
    const changed = defaultValue !== undefined && Math.abs(value - defaultValue) > 1e-9;
    return (
        <label className={cx('group flex flex-col gap-0.5', disabled && 'opacity-50')} title={title}>
            <span
                className="flex justify-between text-[11px] text-text-1"
                onDoubleClick={(e) => {
                    if (defaultValue === undefined || disabled) return;
                    e.preventDefault();
                    onChange(defaultValue);
                }}
            >
                <span className="flex items-center gap-1">
                    {label}
                    {changed && <span className="h-1 w-1 rounded-full bg-accent/70" title="Alterado (clique duplo no nome restaura)" />}
                </span>
                <span className="tnum text-text-0 transition-colors group-hover:text-accent">{format(value)}</span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                style={{ ['--fill' as string]: fill }}
                onChange={(e) => onChange(Number(e.target.value))}
            />
        </label>
    );
}

/** Height-animated show/hide without measuring (CSS grid rows). Children stay mounted. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
    return (
        <div className="pp-collapse" data-open={open} aria-hidden={!open || undefined}>
            <div className={className} {...(!open && { inert: '' as unknown as boolean })}>
                {children}
            </div>
        </div>
    );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={cx('spin shrink-0', className)} aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
    );
}

/** A colour well: swatch that opens the system picker. */
export function ColorInput({ value, onChange, title, size = 22 }: { value: number; onChange: (v: number) => void; title?: string; size?: number }) {
    const hex = `#${value.toString(16).padStart(6, '0')}`;
    return (
        <label
            title={title ?? hex}
            className="press relative inline-block shrink-0 cursor-pointer rounded-[6px] border border-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] hover:scale-110"
            style={{ background: hex, width: size, height: size }}
        >
            <input type="color" value={hex} onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
    );
}

export function Section({
    title,
    children,
    actions,
    defaultOpen = true,
}: {
    title: string;
    children: ReactNode;
    actions?: ReactNode;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <section className="border-b border-stroke">
            <header className="flex h-8 items-center gap-1 px-3">
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    aria-expanded={open}
                    className="flex flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wider text-text-1 uppercase transition-colors duration-200 hover:text-text-0"
                >
                    <Icon name="chevron" size={12} className={cx('transition-transform duration-300 ease-[var(--ease)]', open && 'rotate-90')} />
                    {title}
                </button>
                {actions}
            </header>
            <Collapse open={open}>
                <div className="flex flex-col gap-2.5 px-3 pb-3">{children}</div>
            </Collapse>
        </section>
    );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-1">{label}</span>
            {children}
        </div>
    );
}

export function Select<T extends string>({ value, options, onChange, className }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value as T)}
            className={cx('h-7 rounded-md border border-stroke-2 bg-bg-2 px-2 text-[12px] text-text-0 outline-none focus:border-accent', className)}
        >
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    );
}

export function TextInput({
    value,
    onChange,
    onSubmit,
    placeholder,
    className,
    mono,
    autoFocus,
}: {
    value: string;
    onChange: (v: string) => void;
    onSubmit?: (v: string) => void;
    placeholder?: string;
    className?: string;
    mono?: boolean;
    autoFocus?: boolean;
}) {
    return (
        <input
            value={value}
            autoFocus={autoFocus}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') onSubmit?.(value);
            }}
            className={cx(
                'h-7 rounded-md border border-stroke-2 bg-bg-1 px-2 text-[12px] text-text-0 outline-none placeholder:text-text-2 focus:border-accent',
                mono && 'mono',
                className,
            )}
        />
    );
}

/** Text that turns into an input on double-click — for renaming structures and chains. */
export function EditableText({ value, placeholder, onCommit, className }: { value: string; placeholder: string; onCommit: (v: string) => void; className?: string }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    if (editing) {
        return (
            <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                    setEditing(false);
                    onCommit(draft);
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') {
                        setDraft(value);
                        setEditing(false);
                    }
                }}
                className={cx('h-6 min-w-0 rounded border border-accent bg-bg-1 px-1 text-[12px] text-text-0 outline-none', className)}
            />
        );
    }
    return (
        <span title="Clique duplo para renomear" onDoubleClick={() => setEditing(true)} className={cx('truncate', !value && 'text-text-1', className)}>
            {value || placeholder}
        </span>
    );
}

export function Swatch({ color, onClick, active, title, size = 18 }: { color: string; onClick?: () => void; active?: boolean; title?: string; size?: number }) {
    return (
        <button
            type="button"
            title={title ?? color}
            onClick={onClick}
            style={{ background: color, width: size, height: size }}
            className={cx('press shrink-0 rounded-[5px] border hover:scale-110', active ? 'border-text-0 ring-1 ring-accent' : 'border-black/30')}
        />
    );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="group flex cursor-pointer items-center gap-2 text-left text-[12px] text-text-0">
            <span className={cx('relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-accent' : 'bg-stroke-2 group-hover:bg-text-2')}>
                <span
                    className={cx(
                        'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-300 ease-[var(--ease-spring)] group-active:scale-90',
                        checked ? 'translate-x-3.5' : 'translate-x-0.5',
                    )}
                />
            </span>
            {label}
        </button>
    );
}

export function Empty({ children }: { children: ReactNode }) {
    return <p className="px-3 py-4 text-center text-[12px] leading-relaxed text-text-2">{children}</p>;
}

/** A row of joined action buttons — for "apply this style" choices that have no persistent value. */
export function ActionRow<T extends string>({ options, onPick }: { options: readonly { value: T; label: ReactNode; title?: string }[]; onPick: (v: T) => void }) {
    return (
        <div className="flex overflow-hidden rounded-md border border-stroke-2 bg-bg-2">
            {options.map((o, i) => (
                <button
                    key={o.value}
                    type="button"
                    title={o.title}
                    onClick={() => onPick(o.value)}
                    className={cx('h-7 flex-1 px-1.5 text-[12px] whitespace-nowrap text-text-0 transition-colors duration-200 hover:bg-bg-3 active:bg-accent/20', i > 0 && 'border-l border-stroke-2')}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}
