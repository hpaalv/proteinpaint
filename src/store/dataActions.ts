/**
 * Actions of the data workspace that reach outside the store: rendering a panel to a
 * file and writing the filtered table.
 *
 * Kept apart from data.ts so the store stays free of UI and platform imports.
 */

import { platform } from '@/platform/bridge';
import { panelCsv, renderChartCell, renderPanel, type PanelExportOptions } from '@/panels/export';
import { THEMES } from '@/panels/theme';
import { chartInstances } from '@/ui/data/ChartCell';
import { structureViewers } from '@/ui/data/StructureCell';
import { toast } from './app';
import { activePanel, filteredRows, useData } from './data';

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'painel';

export async function exportPanelImage(options: PanelExportOptions): Promise<void> {
    const panel = activePanel();
    if (!panel) return;
    if (panel.cells.length === 0) return toast('O painel está vazio.', 'error');
    useData.setState({ exporting: true });
    try {
        const image = await renderPanel(panel, options, {
            chart: (id) => chartInstances.get(id),
            structure: (id) => structureViewers.get(id),
        });
        const saved = await platform.savePng(image.dataUrl, `${slug(panel.title)}_${options.widthMm}mm_${options.dpi}dpi.png`);
        if (saved.ok) toast(`Painel ${image.width}×${image.height} salvo${saved.path ? ` em ${saved.path}` : ''}.`, 'ok', 5000);
        else if (!saved.canceled) toast(saved.error ?? 'Falha ao salvar.', 'error');
    } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        useData.setState({ exporting: false });
    }
}

export async function exportCellImage(cellId: string, options: { widthMm: number; dpi: number; transparent: boolean }): Promise<void> {
    const panel = activePanel();
    const chart = chartInstances.get(cellId);
    if (!panel || !chart) return;
    const cell = panel.cells.find((c) => c.id === cellId);
    const title = cell?.content.kind === 'chart' ? cell.content.chart.title : '';
    useData.setState({ exporting: true });
    try {
        const theme = THEMES[panel.theme];
        const image = await renderChartCell(chart, options.widthMm, options.dpi, options.transparent, panel.background === 'white' ? '#ffffff' : theme.surface);
        const saved = await platform.savePng(image.dataUrl, `${slug(title || panel.title)}_${options.dpi}dpi.png`);
        if (saved.ok) toast(`Gráfico ${image.width}×${image.height} salvo.`, 'ok');
        else if (!saved.canceled) toast(saved.error ?? 'Falha ao salvar.', 'error');
    } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        useData.setState({ exporting: false });
    }
}

/** The rows as they are filtered right now, with every column of the table. */
export async function exportTableCsv(): Promise<void> {
    const { dataset, selection } = useData.getState();
    if (!dataset) return;
    const rows = filteredRows().filter((r) => selection.size === 0 || selection.has(r.id));
    const headers = dataset.columns.map((c) => c.key);
    const csv = panelCsv(headers, rows.map((r) => headers.map((h) => r.values[h] ?? '')));
    const saved = await platform.saveText(csv, `${slug(dataset.name)}_filtrado.csv`);
    if (saved.ok) toast(`${rows.length} linhas salvas${saved.path ? ` em ${saved.path}` : ''}.`, 'ok');
}
