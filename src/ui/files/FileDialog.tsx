/**
 * File dialog of the web build: browses the server's file system (the HPC home)
 * where the desktop app shows a native dialog. One component for the four uses —
 * open structures, choose a folder, save, and browse a job's outputs — driven by the
 * pending request of src/platform/fileDialog.ts.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { rememberDir, useFileDialog, type FileDialogRequest, type FileDialogResult } from '@/platform/fileDialog';
import { listDir, rawUrl, serverInfo, type DirListing, type ServerInfo } from '@/platform/web';
import { Button, Spinner, TextInput, Toggle, cx } from '@/ui/components/Primitives';
import { Icon } from '@/ui/components/Icon';

const STRUCTURE_FILE = /\.(pdb|ent|cif|mmcif|bcif|pdbqt)(\.gz)?$/i;

const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const DATE = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

export function FileDialogHost() {
    const pending = useFileDialog((s) => s.pending);
    if (!pending) return null;
    // Keyed by request so each dialog starts fresh.
    return <FileDialog key={`${pending.request.kind}:${pending.request.title}:${pending.request.start}`} request={pending.request} resolve={pending.resolve} />;
}

function FileDialog({ request, resolve }: { request: FileDialogRequest; resolve: (r: FileDialogResult) => void }) {
    const [info, setInfo] = useState<ServerInfo | null>(null);
    const [listing, setListing] = useState<DirListing | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string[]>(request.kind === 'browse' && request.highlight ? [request.highlight.split('/').pop()!] : []);
    const [anchor, setAnchor] = useState<number | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [pathText, setPathText] = useState('');
    const [fileName, setFileName] = useState(request.kind === 'save' ? request.suggestedName : '');
    const localInput = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    async function go(dir: string, keepSelection = false) {
        setLoading(true);
        setError(null);
        try {
            const l = await listDir(dir, showHidden);
            setListing(l);
            setPathText(l.dir);
            if (!keepSelection) setSelected([]);
            setAnchor(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void serverInfo().then(setInfo, () => {});
        const start = request.start;
        void (async () => {
            const home = (await serverInfo().catch(() => null))?.home;
            try {
                if (!start) throw new Error('no start');
                await listDir(start, showHidden);
                await go(start, true);
            } catch {
                if (home) await go(home);
            }
        })();
        listRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (listing) void go(listing.dir, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showHidden]);

    const entries = useMemo(() => {
        const all = listing?.entries ?? [];
        if (request.kind === 'open' && !showAll) return all.filter((e) => e.dir || STRUCTURE_FILE.test(e.name));
        if (request.kind === 'folder') return all.filter((e) => e.dir);
        return all;
    }, [listing, request.kind, showAll]);

    const dir = listing?.dir ?? '';
    const selectedEntries = entries.filter((e) => selected.includes(e.name));
    const selectedFiles = selectedEntries.filter((e) => !e.dir);
    const selectedDir = selectedEntries.length === 1 && selectedEntries[0]!.dir ? selectedEntries[0]! : null;
    const nameExists = request.kind === 'save' && (listing?.entries ?? []).some((e) => !e.dir && e.name === fileName.trim());

    function finish(result: FileDialogResult) {
        if (result && result.kind === 'paths' && dir) rememberDir(dir);
        resolve(result);
    }

    function confirm() {
        if (!listing) return;
        switch (request.kind) {
            case 'open':
                if (selectedDir && selectedFiles.length === 0) return void go(join(dir, selectedDir.name));
                if (selectedFiles.length) finish({ kind: 'paths', paths: selectedFiles.map((e) => join(dir, e.name)) });
                return;
            case 'folder':
                finish({ kind: 'paths', paths: [selectedDir ? join(dir, selectedDir.name) : dir] });
                return;
            case 'save': {
                const name = fileName.trim();
                if (!name || name.includes('/')) return;
                finish({ kind: 'paths', paths: [join(dir, name)] });
                return;
            }
            case 'browse':
                if (selectedDir) void go(join(dir, selectedDir.name));
                else if (selectedFiles[0]) window.open(rawUrl(join(dir, selectedFiles[0].name)), '_blank', 'noopener');
                return;
        }
    }

    function click(index: number, name: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
        const multi = request.kind === 'open';
        if (multi && e.shiftKey && anchor !== null) {
            const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
            setSelected(entries.slice(a, b + 1).filter((x) => !x.dir).map((x) => x.name));
            return;
        }
        if (multi && (e.ctrlKey || e.metaKey)) {
            setSelected((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
        } else {
            setSelected([name]);
            if (request.kind === 'save') {
                const entry = entries[index];
                if (entry && !entry.dir) setFileName(name);
            }
        }
        setAnchor(index);
    }

    function open(name: string, isDir: boolean) {
        const full = join(dir, name);
        if (isDir) return void go(full);
        if (request.kind === 'open') finish({ kind: 'paths', paths: [full] });
        else if (request.kind === 'save') finish({ kind: 'paths', paths: [full] });
        else if (request.kind === 'browse') window.open(rawUrl(full), '_blank', 'noopener');
    }

    function onKey(e: KeyboardEvent) {
        // The dialog is modal: the app's global shortcuts must not see these keys.
        e.stopPropagation();
        const typing = (e.target as HTMLElement).tagName === 'INPUT';
        if (e.key === 'Escape') {
            e.preventDefault();
            finish(null);
        } else if (e.key === 'Enter' && !typing) {
            e.preventDefault();
            confirm();
        } else if (e.key === 'Backspace' && !typing && listing?.parent) {
            e.preventDefault();
            void go(listing.parent);
        } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && entries.length) {
            e.preventDefault();
            const current = entries.findIndex((x) => x.name === selected[selected.length - 1]);
            const next = Math.max(0, Math.min(entries.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
            setSelected([entries[next]!.name]);
            setAnchor(next);
            listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        }
    }

    // Breadcrumb from the root that contains the folder: above it the server says no.
    const root = info?.roots.filter((r) => dir === r || dir.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
    const allCrumbs = root ? [{ label: root === info?.home ? 'Início' : root, path: root }, ...dir.slice(root.length).split('/').filter(Boolean).map((part, i, all) => ({ label: part, path: join(root, all.slice(0, i + 1).join('/')) }))] : [];
    // Deep paths keep the root and the last three names whole; "…" jumps to the hidden level.
    const crumbs = allCrumbs.length > 4 ? [allCrumbs[0]!, { label: '…', path: allCrumbs[allCrumbs.length - 4]!.path }, ...allCrumbs.slice(-3)] : allCrumbs;

    const places = info
        ? [
              { label: 'Início', path: info.home, icon: 'open' as const },
              ...info.roots.filter((r) => r !== info.home && r !== info.temp).map((r) => ({ label: r.split('/').pop() || r, path: r, icon: 'open' as const })),
              { label: 'Temporários', path: info.temp, icon: 'open' as const },
          ]
        : [];

    return (
        <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" onMouseDown={(e) => e.target === e.currentTarget && finish(null)} onKeyDown={onKey}>
            <div role="dialog" aria-modal="true" aria-label={request.title} className="glass scale-in flex h-[min(620px,90vh)] w-[min(880px,96vw)] flex-col overflow-hidden rounded-xl shadow-[var(--shadow-pop)]">
                <header className="flex items-center gap-2 border-b border-stroke px-4 py-2.5">
                    <Icon name={request.kind === 'save' ? 'download' : 'open'} size={15} className="text-accent" />
                    <h2 className="m-0 flex-1 text-[13px] font-semibold text-text-0">{request.title}</h2>
                    {info && <span className="mono text-[11px] text-text-2">{info.user}@{info.host}</span>}
                    <button type="button" title="Fechar (Esc)" onClick={() => finish(null)} className="press grid h-6 w-6 place-items-center rounded-md text-text-2 hover:bg-bg-3 hover:text-text-0">
                        <Icon name="close" size={14} />
                    </button>
                </header>

                <div className="flex items-center gap-1.5 border-b border-stroke px-3 py-2">
                    <button type="button" title="Pasta acima (Backspace)" disabled={!listing?.parent} onClick={() => listing?.parent && void go(listing.parent)} className="press grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-1 hover:bg-bg-3 hover:text-text-0 disabled:opacity-30">
                        <Icon name="up" size={14} />
                    </button>
                    <nav className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden text-[12px]">
                        {crumbs.map((c, i) => (
                            <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                                {i > 0 && <Icon name="chevron" size={11} className="shrink-0 text-text-2" />}
                                <button type="button" title={c.path} onClick={() => void go(c.path)} className={cx('press max-w-[180px] truncate rounded px-1.5 py-0.5 hover:bg-bg-3', i === crumbs.length - 1 ? 'text-text-0' : 'text-text-1')}>
                                    {c.label}
                                </button>
                            </span>
                        ))}
                    </nav>
                    <TextInput value={pathText} onChange={setPathText} onSubmit={(v) => void go(v.trim())} mono className="ml-auto w-[38%] min-w-[180px] text-[11px]" placeholder="/caminho/da/pasta" />
                </div>

                <div className="flex min-h-0 flex-1">
                    <aside className="hidden w-40 shrink-0 flex-col gap-0.5 border-r border-stroke p-2 sm:flex">
                        <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-text-2 uppercase">Locais</div>
                        {places.map((p) => (
                            <button key={p.path} type="button" title={p.path} onClick={() => void go(p.path)} className={cx('press flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-[12px]', dir === p.path ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-3 hover:text-text-0')}>
                                <Icon name={p.icon} size={13} className="shrink-0" />
                                <span className="truncate">{p.label}</span>
                            </button>
                        ))}
                        <div className="mt-auto flex flex-col gap-1.5 px-1 pt-2">
                            {request.kind === 'open' && <Toggle checked={showAll} onChange={setShowAll} label="Todos os arquivos" />}
                            <Toggle checked={showHidden} onChange={setShowHidden} label="Ocultos" />
                        </div>
                    </aside>

                    <div ref={listRef} tabIndex={-1} className="scroll-themed min-w-0 flex-1 overflow-auto outline-none">
                        {error ? (
                            <div className="flex items-start gap-2 p-4 text-[12px] text-err">
                                <Icon name="alert" size={14} className="mt-px shrink-0" />
                                <span className="break-all">{error}</span>
                            </div>
                        ) : loading && !listing ? (
                            <div className="grid h-full place-items-center text-text-2"><Spinner size={18} /></div>
                        ) : entries.length === 0 ? (
                            <div className="grid h-full place-items-center p-6 text-center text-[12px] text-text-2">
                                {request.kind === 'open' && !showAll ? 'Nenhuma estrutura nem pasta aqui.' : request.kind === 'folder' ? 'Sem subpastas.' : 'Pasta vazia.'}
                            </div>
                        ) : (
                            <table className="w-full border-collapse text-[12px]">
                                <thead className="sticky top-0 z-10 bg-bg-1 text-left text-[10px] tracking-wider text-text-2 uppercase">
                                    <tr>
                                        <th className="px-3 py-1.5 font-semibold">Nome</th>
                                        <th className="w-20 px-3 py-1.5 text-right font-semibold">Tamanho</th>
                                        <th className="w-36 px-3 py-1.5 font-semibold">Modificado</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map((e, i) => {
                                        const on = selected.includes(e.name);
                                        return (
                                            <tr
                                                key={e.name}
                                                data-index={i}
                                                onClick={(ev) => click(i, e.name, ev)}
                                                onDoubleClick={() => open(e.name, e.dir)}
                                                className={cx('cursor-default select-none', on ? 'bg-accent/15 text-text-0' : 'text-text-1 hover:bg-bg-3/70 hover:text-text-0')}
                                            >
                                                <td className="max-w-0 px-3 py-[5px]">
                                                    <span className="flex items-center gap-2">
                                                        <Icon name={e.dir ? 'open' : 'file'} size={13} className={cx('shrink-0', e.dir ? 'text-accent' : STRUCTURE_FILE.test(e.name) ? 'text-ok' : 'text-text-2')} />
                                                        <span className="truncate">{e.name}</span>
                                                    </span>
                                                </td>
                                                <td className="tnum px-3 py-[5px] text-right whitespace-nowrap text-text-2">{e.dir ? '' : formatSize(e.size)}</td>
                                                <td className="tnum px-3 py-[5px] whitespace-nowrap text-text-2">{DATE.format(e.mtime)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>

                <footer className="flex flex-wrap items-center gap-2 border-t border-stroke px-3 py-2.5">
                    {request.kind === 'open' && (
                        <>
                            <input
                                ref={localInput}
                                type="file"
                                multiple
                                hidden
                                onChange={(e) => {
                                    const files = [...(e.target.files ?? [])];
                                    if (files.length) finish({ kind: 'local', files });
                                }}
                            />
                            <Button icon="upload" variant="ghost" title="Enviar arquivos deste computador" onClick={() => localInput.current?.click()}>
                                Do meu computador…
                            </Button>
                            <span className="ml-auto text-[11px] text-text-2">{selectedFiles.length > 1 ? `${selectedFiles.length} arquivos` : 'Ctrl/Shift para vários'}</span>
                        </>
                    )}
                    {request.kind === 'save' && (
                        <>
                            <TextInput value={fileName} onChange={setFileName} onSubmit={() => confirm()} mono autoFocus className="min-w-[200px] flex-1" placeholder="nome do arquivo" />
                            {nameExists && <span className="text-[11px] text-warn">já existe: será substituído</span>}
                            <Button icon="download" variant="ghost" title="Baixar pelo navegador, para este computador" onClick={() => finish({ kind: 'download' })}>
                                Baixar no meu computador
                            </Button>
                        </>
                    )}
                    {request.kind === 'browse' && selectedFiles[0] && (
                        <>
                            <Button icon="eye" variant="ghost" onClick={() => window.open(rawUrl(join(dir, selectedFiles[0]!.name)), '_blank', 'noopener')}>
                                Abrir no navegador
                            </Button>
                            <Button icon="download" variant="ghost" onClick={() => (window.location.href = rawUrl(join(dir, selectedFiles[0]!.name), true))}>
                                Baixar
                            </Button>
                        </>
                    )}
                    <span className={cx(request.kind !== 'open' && 'ml-auto')} />
                    <Button onClick={() => finish(null)}>{request.kind === 'browse' ? 'Fechar' : 'Cancelar'}</Button>
                    {request.kind === 'open' && (
                        <Button variant="primary" icon="check" disabled={!selectedFiles.length && !selectedDir} onClick={confirm}>
                            {selectedDir && !selectedFiles.length ? 'Entrar' : 'Abrir'}
                        </Button>
                    )}
                    {request.kind === 'folder' && (
                        <Button variant="primary" icon="check" disabled={!listing} onClick={confirm} title={selectedDir ? join(dir, selectedDir.name) : dir}>
                            {selectedDir ? `Escolher “${selectedDir.name}”` : 'Escolher esta pasta'}
                        </Button>
                    )}
                    {request.kind === 'save' && (
                        <Button variant="primary" icon="check" disabled={!fileName.trim() || fileName.includes('/') || !listing} onClick={confirm}>
                            {nameExists ? 'Substituir' : 'Salvar aqui'}
                        </Button>
                    )}
                </footer>
            </div>
        </div>
    );
}
