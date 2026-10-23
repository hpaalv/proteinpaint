/**
 * Review batch 7 (2026-10-23), in a real Electron window:
 *   electron scripts/selftest8.cjs <out-dir>
 * Closing a structure takes its labels, measurements and overlays along; ↑/↓ selection
 * levels; interface side chains in chain colours; adding hydrogens; explore focus
 * without the clipping "wall"; interface secondary structure; data mode: a real mouse
 * click on a chart point opens the design in the 3D cell, with interface side chains.
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

const DESIGN = '/home/paulo/Downloads/analises/na1_binder_9_model_7.cif';
const HLA = '/home/paulo/Downloads/1a1m_mhc_all.pdb';
const FOLDER = process.env.PP_DATASET || path.join(__dirname, '..', 'data', 'pilot', 'pmhc_pkg');

async function main() {
    let win = null;
    registerIpc(() => win);
    registerCore(() => win);
    win = new BrowserWindow({
        // Built-in panel only (docs/STATUS.md: the PRIME-driven external monitor froze).
        x: 0, y: 0, width: 1700, height: 1050, show: true,
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
    const step = async (name, code, check) => {
        const t0 = Date.now();
        try {
            const value = await js(code);
            const bad = check ? check(value) : null;
            if (bad) failed = true;
            log.push({ step: name, ok: !bad, ms: Date.now() - t0, value, ...(bad ? { error: bad } : {}) });
        } catch (e) {
            failed = true;
            log.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e) });
        }
    };
    const key = async (keyCode) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await new Promise((r) => setTimeout(r, 500));
    };
    const pre = `const { useApp, actions, E, compute } = window.__pp; const v = window.__pp.viewer();
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const ids = () => useApp.getState().structures.map((s) => s.id);
        const byName = (n) => useApp.getState().structures.find((s) => s.name.startsWith(n));
        const overlays = () => v.plugin.state.data.selectQ((q) => q.root.subtree()).filter((c) => (c.transform.tags || []).some((t) => t.startsWith('pp-overlay:'))).length;`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('load design + HLA-A2', `${pre} await actions.loadPaths(${JSON.stringify([DESIGN, HLA])}); await wait(1500); return useApp.getState().structures.map((s) => s.name + ' H=' + s.hydrogenCount);`);

    // -- 1. closing takes everything along ------------------------------------------
    await step('decorate the HLA: labels, a distance, interface lines', `${pre}
        const hla = byName('1a1m');
        useApp.setState({ activeId: hla.id });
        await E.selectChain(v, hla.id, 'C');
        await E.labelSelection(v);
        const root = v.plugin.managers.structure.hierarchy.current.structures.find((s) => s.cell.transform.ref === v.entry(hla.id).structure.ref).cell.obj.data;
        const loci = v.plugin.managers.structure.selection.getLoci(root);
        const atom = (k) => ({ kind: 'element-loci', structure: loci.structure, elements: [{ unit: loci.elements[0].unit, indices: [k] }] });
        const node = await v.plugin.managers.structure.measurement.addDistance(atom(0), atom(20));
        v.measurements.push({ ref: node.selection.ref, kind: 'distance', label: 'test', atoms: [], value: 1, unit: 'Å' });
        const report = await E.analyzeInterface(v, { structureId: hla.id, chains: ['A'] }, { structureId: hla.id, chains: ['C'] }, E.DEFAULT_CONTACTS);
        await E.showInteractions(v, report.value, new Set(['hydrogen-bond', 'salt-bridge']));
        await E.showInteractionAtoms(v, report.value, new Set(['hydrogen-bond', 'salt-bridge']));
        useApp.setState({ interfaceReport: report.value });
        actions.syncStructures();
        return { overlays: overlays(), measurements: v.measurements.length, hbonds: report.value.interactions.length };`,
        (x) => (x.overlays >= 3 && x.measurements === 1 ? null : 'decorations missing'));
    await shot('01-decorated');
    await step('close the HLA', `${pre}
        await actions.closeStructure(byName('1a1m').id); await wait(600);
        return { overlays: overlays(), measurements: v.measurements.length, report: useApp.getState().interfaceReport, left: useApp.getState().structures.map((s) => s.name) };`,
        (x) => (x.overlays === 0 && x.measurements === 0 && x.report === null ? null : 'leftovers after closing'));
    await shot('02-closed');

    // -- 2. ↑ / ↓ selection levels ---------------------------------------------------
    await step('select one residue of the binder', `${pre}
        const d = byName('na1'); useApp.setState({ activeId: d.id });
        await E.selectResidues(v, d.id, 'A', ['20']); await wait(300); actions.syncSelection();
        return useApp.getState().selection.label;`);
    const levels = [];
    for (let i = 0; i < 5; i++) {
        await key('Up');
        levels.push(await js(`const s = window.__pp.useApp.getState().selection; return s ? s.label : null;`));
    }
    log.push({ step: '↑ ×5', ok: new Set(levels).size >= 3, value: levels });
    if (new Set(levels).size < 3) failed = true;
    await key('Down');
    await key('Down');
    await step('↓ ×2', `return window.__pp.useApp.getState().selection?.label;`);

    // -- 4. interface side chains in chain colours -----------------------------------
    await step('interface atoms use the chain colours', `${pre}
        const d = byName('na1');
        const report = await E.analyzeInterface(v, { structureId: d.id, chains: ['A'] }, { structureId: d.id, chains: ['B', 'C'] }, E.DEFAULT_CONTACTS);
        useApp.setState({ interfaceReport: report.value, tab: 'interface' });
        await E.showInteractions(v, report.value, new Set(['hydrogen-bond', 'salt-bridge', 'pi-stacking', 'cation-pi']));
        await E.showInteractionAtoms(v, report.value, new Set(['hydrogen-bond', 'salt-bridge', 'pi-stacking', 'cation-pi']));
        const reprs = [];
        v.plugin.state.data.cells.forEach((c) => { if ((c.transform.tags || []).includes('pp-interaction-atoms') && c.transform.params?.colorTheme) reprs.push(c.transform.params.colorTheme.name + '/' + c.transform.params.colorTheme.params?.base?.name); });
        return reprs;`,
        (x) => (x.length && x.every((t) => t.startsWith('pp-hetero/pp-chain-map')) ? null : 'wrong theme'));
    await step('focus the interface', `${pre} await E.selectChain(v, byName('na1').id, 'C'); E.focusSelection(v); await wait(800); E.clearSelection(v); return true;`);
    await shot('03-interface-sidechains', 1500);

    // -- 8. explore focus no longer clips ---------------------------------------------
    await step('explore focus keeps the scene radius', `${pre}
        actions.setTool('explore');
        const d = byName('na1');
        await E.selectResidues(v, d.id, 'A', ['20']);
        E.focusSelection(v, true); await wait(900);
        const cam = v.canvas3d.camera.state; const scene = v.canvas3d.boundingSphere.radius;
        E.clearSelection(v);
        return { cameraRadius: +cam.radius.toFixed(1), sceneRadius: +scene.toFixed(1), distance: +Math.hypot(cam.position[0]-cam.target[0], cam.position[1]-cam.target[1], cam.position[2]-cam.target[2]).toFixed(1) };`,
        (x) => (x.cameraRadius >= x.sceneRadius * 0.99 ? null : 'focus still clips'));
    await shot('04-explore', 1500);
    await step('back to select', `${pre} actions.setTool('select'); E.clearFocus(v); E.resetView(v); await wait(800); return useApp.getState().tool;`);

    // -- 7. interface secondary structure ---------------------------------------------
    await step('interface secondary structure', `${pre}
        const d = byName('na1');
        const r = await E.interfaceSecondaryStructure(v, d.id, ['A'], ['B', 'C']);
        if (!r.ok) throw new Error(r.error);
        const tally = (l) => l.reduce((m, x) => (m[x.ss] = (m[x.ss] || 0) + 1, m), {});
        return { source: r.value.source, binder: tally(r.value.sideA.residues), target: tally(r.value.sideB.residues) };`);
    await step('open the comparison view', `${pre}
        compute.store.addResult({ id: 'interface-ss', tool: 'dssp', label: 'Estrutura secundária da interface', created: Date.now(), structureIds: [], data: null, meta: { tool: 'dssp', structureIds: [] }, jobIds: [] });
        await wait(1500); return compute.store.useCompute.getState().dockOpen;`);
    await shot('05-interface-ss', 1800);

    // -- 3. hydrogens ----------------------------------------------------------------
    await step('add hydrogens (PDB2PQR + PROPKA)', `${pre}
        const d = byName('na1');
        await v.entry(d.id) && E.setChainColor(v, d.id, 'A', 0xff8800);
        const { addHydrogens } = window.__pp.hydrogens;
        await addHydrogens(d.id);
        for (let i = 0; i < 600; i++) { await wait(200); if (useApp.getState().structures.some((s) => s.hydrogenCount > 0)) break; }
        await wait(800);
        const s = useApp.getState().structures.find((x) => x.hydrogenCount > 0);
        return s && { name: s.name, hydrogens: s.hydrogenCount, roles: s.chains.map((c) => c.authAsymId + ':' + c.role), structures: useApp.getState().structures.length, chainA: v.entry(s.id).chainColors.A };`,
        (x) => (x && x.hydrogens > 1000 && x.structures === 1 && x.chainA === 0xff8800 ? null : 'hydrogens not added / not replaced'));
    await step('hide and show hydrogens', `${pre}
        await E.setHydrogenDisplay(v, 'all'); await wait(300);
        const types = []; v.plugin.state.data.cells.forEach((c) => { const t = c.transform.params?.type; if (t && t.name === 'ball-and-stick') types.push(String(t.params.ignoreHydrogens)); });
        await E.setHydrogenDisplay(v, 'polar');
        return types;`);
    await step('interface atoms on the protonated model', `${pre}
        const d = useApp.getState().structures[0];
        const report = await E.analyzeInterface(v, { structureId: d.id, chains: ['A'] }, { structureId: d.id, chains: ['B', 'C'] }, E.DEFAULT_CONTACTS);
        useApp.setState({ interfaceReport: report.value, activeId: d.id, tab: 'interface' });
        await E.showInteractions(v, report.value, new Set(['hydrogen-bond', 'salt-bridge']));
        await E.showInteractionAtoms(v, report.value, new Set(['hydrogen-bond', 'salt-bridge']));
        await E.selectChain(v, d.id, 'C'); E.focusSelection(v); await wait(800); E.clearSelection(v);
        return report.value.interactions.filter((r) => r.kind === 'hydrogen-bond').length;`);
    await shot('06-hydrogens', 1800);

    // -- 5. sequence track modes -------------------------------------------------------
    await step('sequence track: tucked away', `${pre} window.__pp.setSequenceMode('auto'); await wait(500); return useApp.getState().sequenceMode;`);
    await shot('07-sequence-auto', 800);
    await step('sequence track: fixed again', `${pre} window.__pp.setSequenceMode('fixed'); return useApp.getState().sequenceMode;`);

    // -- 9 + 10. data mode: click a point → 3D cell, with side chains --------------------
    const pd = `const { data: D } = window.__pp; const S = () => D.useData.getState(); const wait = (ms) => new Promise((r) => setTimeout(r, ms));`;
    await step('data workspace with the pilot', `${pd} window.__pp.useApp.setState({ workspace: 'data' }); await wait(300); await D.openDatasetPath(${JSON.stringify(FOLDER)}); await wait(800);
        D.addPanel(); D.patchPanel({ title: 'Clique', cols: 2, rows: 1 });
        D.addChartCell({ type: 'scatter', title: 'Área × i_pTM', x: 'rp_area', y: 'rp_i_pTM' });
        D.addStructureCell({ interface: true });
        await wait(1500);
        return D.activePanel().cells.map((c) => c.content.kind);`);
    const target = await js(`${pd}
        const cell = D.activePanel().cells.find((c) => c.content.kind === 'chart');
        const chart = window.__pp.charts.get(cell.id);
        const opt = chart.getOption();
        const series = opt.series.findIndex((s) => s.type === 'scatter' && s.data && s.data.some((d) => d.rowId && S().dataset.rows.find((r) => r.id === d.rowId)?.structurePath));
        const datum = opt.series[series].data.find((d) => S().dataset.rows.find((r) => r.id === d.rowId)?.structurePath);
        const [px, py] = chart.convertToPixel({ seriesIndex: series }, datum.value);
        const rect = chart.getDom().getBoundingClientRect();
        return { x: Math.round(rect.left + px), y: Math.round(rect.top + py), rowId: datum.rowId };`);
    log.push({ step: 'point to click', value: target });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
    await new Promise((r) => setTimeout(r, 200));
    win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await step('the click opened the design in the 3D cell', `${pd}
        for (let i = 0; i < 150; i++) { const vw = [...window.__pp.viewers.values()].find((x) => x.infos().length); if (vw) break; await wait(100); }
        await wait(1500);
        const vw = [...window.__pp.viewers.values()].find((x) => x.infos().length);
        const atoms = []; vw?.plugin.state.data.cells.forEach((c) => { if ((c.transform.tags || []).includes('pp-interaction-atoms')) atoms.push(c.transform.ref); });
        return { focused: S().focused, expected: ${JSON.stringify(target.rowId)}, loaded: vw ? vw.infos().map((s) => s.name) : [], sideChainNodes: atoms.length };`,
        (x) => (x.focused === x.expected && x.loaded.length && x.sideChainNodes > 0 ? null : 'click did not open the design / no side chains'));
    await shot('08-data-click', 2500);

    // Double click: the design opens in the structure workspace.
    for (const clickCount of [1, 2]) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount });
    }
    await step('double click opens it in the structure workspace', `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 100 && window.__pp.useApp.getState().workspace !== 'structure'; i++) await wait(100);
        await wait(1500);
        return { workspace: window.__pp.useApp.getState().workspace, structures: window.__pp.useApp.getState().structures.map((s) => s.name) };`,
        (x) => (x.workspace === 'structure' && x.structures.some((n) => n.includes('l119')) ? null : 'double click did nothing'));
    await shot('09-dblclick', 1500);

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error(e);
    app.exit(2);
});
