/**
 * End-to-end check of the data workspace (Fase 4) in a real Electron window:
 *   electron scripts/selftest4.cjs <out-dir>
 * Opens the pilot folder (structures + metrics.csv), exercises every chart type in a
 * panel, links the selection to a 3D cell, filters, and exports the panel as PNG —
 * once over the theme background and once transparent.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('../electron/ipc.cjs');
const { registerCore } = require('../electron/core.cjs');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.env.PP_GPU === 'nvidia') app.commandLine.appendSwitch('use-angle', 'gl-egl');

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
fs.mkdirSync(outDir, { recursive: true });
const log = [];
let failed = false;

const FOLDER = process.env.PP_DATASET || path.join(__dirname, '..', 'data', 'pilot', 'pmhc_pkg');

async function main() {
    let win = null;
    registerIpc(() => win);
    registerCore(() => win);
    win = new BrowserWindow({
        // Pinned to the built-in panel: this machine's primary display is an external
        // monitor driven through PRIME, and cycling GPU windows on that output froze
        // its image (docs/STATUS.md).
        x: 0, y: 0, width: 1800, height: 1100, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/Security|CONTEXT_LOST/.test(message)) log.push({ console: message.slice(0, 400) }); });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1' } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name, wait = 1200) => {
        await new Promise((r) => setTimeout(r, wait));
        fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        log.push({ shot: name });
    };
    const step = async (name, code) => {
        const t0 = Date.now();
        try {
            const value = await js(code);
            log.push({ step: name, ok: true, ms: Date.now() - t0, value });
        } catch (e) {
            failed = true;
            log.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e) });
        }
    };
    const pre = `const { useApp, data, dataActions, E } = window.__pp; const D = data;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const S = () => D.useData.getState();
        const panel = () => D.activePanel();
        const cells = () => panel().cells;`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('switch to the data workspace', `${pre} useApp.setState({ workspace: 'data' }); await wait(300); return useApp.getState().workspace;`);
    await step('open the pilot folder', `${pre} await D.openDatasetPath(${JSON.stringify(FOLDER)}); await wait(600);
        const d = S().dataset;
        return { rows: d.rows.length, columns: d.columns.length, idKey: d.idKey, matched: d.matched, loose: d.loose.length, table: d.tablePath.split('/').pop(), notes: Boolean(d.notes) };`);
    await step('column inference', `${pre} const d = S().dataset;
        const by = (k) => d.columns.find((c) => c.key === k);
        return { arm: by('arm').kind, cats: by('arm').categories, seq: by('sequence').kind, area: by('rp_area').kind, areaRange: by('rp_area').range.map((v) => Math.round(v)), peptide: by('peptide_contacts').kind, groups: [...new Set(d.columns.map((c) => c.group))] };`);
    await shot('00-opened', 2500);

    await step('starter panel built', `${pre} return cells().map((c) => c.content.kind === 'chart' ? c.content.chart.type : c.content.kind);`);

    // Every chart type, one at a time, in a dedicated panel.
    await step('panel for the gallery', `${pre} D.addPanel(); D.patchPanel({ title: 'Galeria', cols: 3, rows: 4 }); return panel().title;`);
    const TYPES = [
        ['scatter', `{ type: 'scatter', title: 'Área × i_pTM', x: 'rp_area', y: 'rp_i_pTM', color: 'rp_i_pAE', size: 'rp_ires', showStats: true, trend: true, labelTop: 3 }`],
        ['histogram', `{ type: 'histogram', title: 'Carga líquida', x: 'net_charge', group: 'arm' }`],
        ['violin', `{ type: 'violin', title: 'i_pTM por braço', x: 'arm', y: 'rp_i_pTM', showPoints: true }`],
        ['box', `{ type: 'box', title: 'Área por status', x: 'status', y: 'rp_area' }`],
        ['bar', `{ type: 'bar', title: 'Designs por braço', x: 'arm', showValues: true }`],
        ['stacked', `{ type: 'stacked', title: 'Status por braço', x: 'arm', group: 'status', normalize: true, showValues: true }`],
        ['line', `{ type: 'line', title: 'Área × comprimento', x: 'length', y: 'rp_area', group: 'arm', showBand: true }`],
        ['heatmap', `{ type: 'heatmap', title: 'Retenção por alvo', columns: ['ret_WT_Q61','ret_8YJ2','ret_9Z50','ret_3BO8','ret_6AT9','ret_4NQX','ret_8XKE'], ramp: 'blue-red', rampCenter: 1, limit: 25 }`],
        ['correlation', `{ type: 'correlation', title: 'Correlação', columns: ['rp_i_pTM','rp_i_pAE','rp_area','rp_ires','unbound_pLDDT','helix','net_charge'], showValues: true, method: 'spearman' }`],
        ['dumbbell', `{ type: 'dumbbell', title: 'Campanha vs reprevisto', x: 'arm', y: 'camp_i_pTM', y2: 'rp_i_pTM' }`],
        ['parallel', `{ type: 'parallel', title: 'Métricas', columns: ['rp_i_pTM','rp_i_pAE','rp_area','rp_ires','unbound_pLDDT'], color: 'arm' }`],
        ['funnel', `{ type: 'funnel', title: 'Funil de ligação', gates: [ {key:'rp_i_pTM',op:'>=',value:0.85}, {key:'rp_i_pAE',op:'<=',value:0.18}, {key:'rp_area',op:'>=',value:1000}, {key:'rp_ires',op:'>=',value:18}, {key:'unbound_pLDDT',op:'>=',value:0.85}, {key:'rp_offepitope',op:'<=',value:0.20} ] }`],
    ];
    for (const [name, spec] of TYPES) {
        await step(`chart ${name}`, `${pre} D.addChartCell(${spec}); await wait(450);
            const id = S().activeCellId;
            const inst = window.__pp.charts.get(id);
            if (!inst) throw new Error('gráfico não renderizou');
            const opt = inst.getOption();
            return { series: opt.series.length, firstType: opt.series[0].type, points: (opt.series[0].data || []).length };`);
    }
    await shot('01-gallery', 2500);

    await step('funnel counts match the notes', `${pre}
        const cell = cells().find((c) => c.content.kind === 'chart' && c.content.chart.type === 'funnel');
        const { funnelSteps } = window.__pp.chartsApi;
        const steps = funnelSteps(D.filteredRows(), cell.content.chart.gates);
        return steps.map((s) => s.rows.length);`);

    await step('selection links charts to the 3D cell', `${pre}
        D.selectPanel(S().panels[0].id); await wait(300);
        const best = S().dataset.rows.find((r) => r.structurePath && r.id.includes('l119_3405b2ef399189f1_seq1'));
        D.toggleSelected(best.id, false);
        for (let i = 0; i < 120; i++) { const v = window.__pp.viewers.values().next().value; if (v && v.infos().length) break; await wait(100); }
        const viewer = window.__pp.viewers.values().next().value;
        return { focused: S().focused, selected: S().selection.size, loaded: viewer ? viewer.infos().map((s) => s.name) : [], chains: viewer && viewer.infos()[0] ? viewer.infos()[0].chains.map((c) => c.authAsymId + ':' + c.role) : [] };`);
    await shot('02-selection-3d', 2500);

    await step('filter by range and category', `${pre}
        D.addFilter({ kind: 'range', key: 'rp_area', min: 1000, max: 2000 });
        D.addFilter({ kind: 'categories', key: 'arm', values: ['K', 'S'] });
        await wait(400);
        return { rows: D.filteredRows().length, of: S().dataset.rows.length };`);
    await step('keep selection as a filter, then clear', `${pre}
        D.clearFilters(); D.setSelection(S().dataset.rows.slice(0, 11).map((r) => r.id)); D.keepSelection(); await wait(300);
        const kept = D.filteredRows().length; D.clearFilters(); await wait(200);
        return { kept, after: D.filteredRows().length };`);
    await shot('03-filtered', 1500);

    await step('panel export (theme background)', `${pre}
        D.selectPanel(S().panels[1].id); D.patchPanel({ letters: true, subtitle: 'dados piloto pMHC NRAS Q61K' }); await wait(600);
        const { renderPanel } = window.__pp.exportApi;
        const t0 = performance.now();
        const img = await renderPanel(panel(), { widthMm: 180, dpi: 200, includeTitle: true, background: 'theme' }, { chart: (id) => window.__pp.charts.get(id), structure: (id) => window.__pp.viewers.get(id) });
        window.__panel = img.dataUrl;
        return { w: img.width, h: img.height, ms: Math.round(performance.now() - t0), kb: Math.round(img.dataUrl.length * 0.75 / 1024) };`);
    const panelPng = await js('return window.__panel');
    if (panelPng) fs.writeFileSync(path.join(outDir, '04-panel-theme.png'), Buffer.from(panelPng.split(',')[1], 'base64'));

    await step('panel export (transparent, with a 3D cell)', `${pre}
        D.selectPanel(S().panels[0].id); await wait(400);
        const { renderPanel } = window.__pp.exportApi;
        const img = await renderPanel(panel(), { widthMm: 180, dpi: 200, includeTitle: true, background: 'transparent' }, { chart: (id) => window.__pp.charts.get(id), structure: (id) => window.__pp.viewers.get(id) });
        window.__panel2 = img.dataUrl;
        return { w: img.width, h: img.height };`);
    const panelPng2 = await js('return window.__panel2');
    if (panelPng2) fs.writeFileSync(path.join(outDir, '05-panel-transparent.png'), Buffer.from(panelPng2.split(',')[1], 'base64'));

    await step('light theme', `${pre} D.patchPanel({ theme: 'light' }); await wait(700); return panel().theme;`);
    await shot('06-light-theme', 1800);

    await step('resize and move a cell', `${pre}
        const id = cells()[0].id; D.moveCell(id, { x: 0, y: 0, w: 2, h: 1 }); await wait(400);
        const c = cells().find((x) => x.id === id); return { x: c.x, y: c.y, w: c.w, h: c.h };`);
    await shot('07-layout', 1500);

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
