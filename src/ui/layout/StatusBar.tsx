import { dismissToast, useApp } from '@/store/app';
import { useCompute } from '@/compute/store';
import { Icon } from '../components/Icon';
import { Spinner, cx } from '../components/Primitives';

export function StatusBar() {
    const hover = useApp((s) => s.hover);
    const selection = useApp((s) => s.selection);
    const gpu = useApp((s) => s.gpu);
    const isIntegrated = /intel|swiftshader|llvmpipe/i.test(gpu);
    const jobs = useCompute((s) => s.jobs);
    const running = Object.values(jobs).filter((j) => j.state === 'running').length;
    const queued = Object.values(jobs).filter((j) => j.state === 'queued').length;
    const results = useCompute((s) => s.results.length);
    return (
        <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-stroke bg-bg-1 px-3 text-[11px] text-text-1">
            <span className="mono min-w-0 flex-1 truncate">{hover || '\u00a0'}</span>
            {(running > 0 || queued > 0) && (
                <button type="button" onClick={() => useApp.setState({ tab: 'analysis' })} className="fade-in flex items-center gap-1.5 text-accent hover:brightness-125">
                    <Spinner size={11} />
                    {running} rodando{queued ? ` · ${queued} na fila` : ''}
                </button>
            )}
            {results > 0 && (
                <button type="button" onClick={() => useCompute.setState((s) => ({ dockOpen: !s.dockOpen }))} className="flex items-center gap-1 transition-colors hover:text-text-0">
                    <Icon name="chart" size={12} /> {results} resultado{results > 1 ? 's' : ''}
                </button>
            )}
            {selection && (
                <span className="fade-in text-accent">
                    Seleção: {selection.residues} res · {selection.atoms} átomos
                </span>
            )}
            {gpu && (
                <span className={cx('flex items-center gap-1', isIntegrated ? 'text-warn' : 'text-text-2')} title={isIntegrated ? 'Rodando na GPU integrada. Use scripts/launch.sh para forçar a NVIDIA.' : 'GPU em uso pelo renderizador'}>
                    <Icon name="gpu" size={12} />
                    {gpu}
                </span>
            )}
        </footer>
    );
}

const TOAST_ICON = { ok: 'check', error: 'alert', info: 'info' } as const;

export function Toasts() {
    const toasts = useApp((s) => s.toasts);
    return (
        <div className="pointer-events-none fixed right-[370px] bottom-10 z-50 flex flex-col items-end gap-1.5">
            {toasts.map((t) => (
                <div
                    key={t.id}
                    role={t.kind === 'error' ? 'alert' : 'status'}
                    className={cx(
                        'glass pointer-events-auto relative flex max-w-md cursor-pointer items-start gap-2 overflow-hidden rounded-lg py-2 pr-3 pl-2.5 text-[12px] shadow-[var(--shadow-pop)]',
                        t.leaving ? 'toast-out' : 'toast-in',
                        t.kind === 'error' ? 'border-err/50! text-err' : t.kind === 'ok' ? 'text-ok' : 'text-text-0',
                    )}
                    onClick={() => dismissToast(t.id)}
                    title="Clique para fechar"
                >
                    <Icon name={TOAST_ICON[t.kind]} size={14} className="mt-px shrink-0" />
                    <span className="leading-snug text-text-0">{t.text}</span>
                    <span
                        className={cx('toast-life absolute bottom-0 left-0 h-[2px] w-full opacity-60', t.kind === 'error' ? 'bg-err' : t.kind === 'ok' ? 'bg-ok' : 'bg-accent')}
                        style={{ animationDuration: `${t.ms}ms` }}
                    />
                </div>
            ))}
        </div>
    );
}
