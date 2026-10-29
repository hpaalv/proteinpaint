import { useEffect } from 'react';
import { useApp } from '@/store/app';
import { useData } from '@/store/data';
import { useActivePanel } from './hooks';
import { Icon } from '../components/Icon';
import { Button, cx } from '../components/Primitives';
import { DataInspector } from './DataInspector';
import { DataSidebar } from './DataSidebar';
import { DataTable } from './DataTable';
import { PanelCanvas } from './PanelCanvas';
import { openDatasetFolder, selectPanel } from '@/store/data';

/**
 * The data workspace: columns and filters on the left, the panel being composed in
 * the middle with the designs table under it, and the menus of the selected cell on
 * the right. The 3D workspace keeps its own chrome — these two never share a layout.
 */
export function DataWorkspace() {
    const dataset = useData((s) => s.dataset);
    const panels = useData((s) => s.panels);
    const activeId = useData((s) => s.activePanelId);
    const panel = useActivePanel();
    const tableOpen = useData((s) => s.tableOpen);
    const shown = useApp((s) => s.panels);

    // Escape clears the selection, as it does in the 3D workspace.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
            if (e.key === 'Escape') useData.setState({ selection: new Set() });
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className="flex min-h-0 flex-1">
            <div className={cx('flex shrink-0', !shown.left && 'hidden')}>
                <DataSidebar />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                {panels.length > 1 && (
                    <div className="scroll-themed flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-stroke px-2">
                        {panels.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => selectPanel(p.id)}
                                className={cx(
                                    'press flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] transition-colors',
                                    p.id === activeId ? 'bg-bg-3 text-text-0 ring-1 ring-accent/30' : 'text-text-2 hover:bg-bg-2 hover:text-text-0',
                                )}
                            >
                                {p.title}
                            </button>
                        ))}
                    </div>
                )}
                {panel ? (
                    <PanelCanvas panel={panel} />
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
                        <div className="brand-glow h-11 w-11 rounded-2xl opacity-80" />
                        <div className="text-[15px] font-semibold">Análise de dados</div>
                        <p className="max-w-sm text-[12.5px] leading-relaxed text-text-1">
                            Abra a pasta com os designs: as estruturas e a tabela de metadados. O app liga cada linha à sua estrutura e monta os painéis de figura.
                        </p>
                        {!dataset && (
                            <Button variant="primary" icon="open" onClick={() => void openDatasetFolder()}>
                                Abrir pasta de análise
                            </Button>
                        )}
                    </div>
                )}
                {dataset && shown.bottom && tableOpen && <DataTable />}
                {dataset && shown.bottom && !tableOpen && (
                    <button
                        type="button"
                        onClick={() => useData.setState({ tableOpen: true })}
                        className="flex h-7 shrink-0 items-center justify-center gap-1.5 border-t border-stroke text-[11px] text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
                    >
                        <Icon name="seq" size={12} /> Mostrar tabela de designs
                    </button>
                )}
            </div>
            <div className={cx('flex shrink-0', !shown.right && 'hidden')}>
                <DataInspector />
            </div>
        </div>
    );
}
