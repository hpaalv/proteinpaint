/**
 * End-to-end check of the compute integration (Fase 2) in a real Electron window:
 *   electron scripts/selftest2.cjs <out-dir>
 * Loads a pMHC–binder design and two HLA-A2 crystals, runs every tool through the
 * app's own submit path, waits for the result to be applied to the scene and saves
 * screenshots with the results dock open.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('../electron/ipc.cjs');
const { registerCore } = require('../electron/core.cjs');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.env.PP_GPU === 'nvidia') app.commandLine.appendSwitch('use-angle', 'gl-egl');

const outDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
fs.mkdirSync(outDir, { recursive: true });
const log = [];
let failed = false;

const DESIGN = '/home/paulo/Downloads/analises/na1_binder_9_model_7.cif';
const HLA1 = '/home/paulo/Downloads/1a1m_mhc_all.pdb';
const HLA2 = '/home/paulo/Downloads/ChimeraX/PDB/1ao7.cif';

async function main() {
    let win = null;
    registerIpc(() => win);
    registerCore(() => win);
    win = new BrowserWindow({
        // Pinned to the built-in panel: this machine's primary display is an
        // external monitor driven through PRIME, and cycling GPU windows on that
        // output froze its image (docs/STATUS.md).
        x: 0, y: 0, width: 1700, height: 1050, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/Security|CONTEXT_LOST/.test(message)) log.push({ console: message.slice(0, 400) }); });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1', transparency: process.env.PP_TRANSPARENCY || '', ...(process.env.PP_ENGINE_DEBUG ? { engineDebug: '1' } : {}) } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name) => {
        await new Promise((r) => setTimeout(r, 1500));
        fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        const info = await js('const c = document.querySelector("canvas"); const r = c.getBoundingClientRect(); return { css: [Math.round(r.width), Math.round(r.height)], buffer: [c.width, c.height], url: c.toDataURL("image/png") }');
        fs.writeFileSync(path.join(outDir, `${name}-canvas.png`), Buffer.from(info.url.split(',')[1], 'base64'));
        log.push({ shot: name, canvasCss: info.css, canvasBuffer: info.buffer });
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
    const pre = `const { E, useApp, viewer, compute } = window.__pp; const C = compute.store; const v = viewer();
        const S = () => useApp.getState().structures;
        const byName = (n) => S().find((s) => s.name.startsWith(n));
        const waitResult = async (tool, count, timeoutS) => {
            for (let i = 0; i < timeoutS * 5; i++) {
                const rs = C.useCompute.getState().results.filter((r) => r.tool === tool);
                if (rs.length >= count) return rs[0];
                const errs = Object.values(C.useCompute.getState().jobs).filter((j) => j.tool === tool && j.state === 'error');
                if (errs.length) throw new Error(errs[0].error);
                await new Promise((r) => setTimeout(r, 200));
            }
            throw new Error('timeout ' + tool);
        };`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    for (const f of [DESIGN, HLA1, HLA2]) {
        await step(`load ${path.basename(f)}`, `const { actions } = window.__pp; await actions.loadPaths([${JSON.stringify(f)}]); return window.__pp.useApp.getState().structures.length;`);
        await shot(`00-after-load-${path.basename(f)}`);
    }
    await step('picking (click at the centre of the canvas)', `
        await new Promise((r) => setTimeout(r, 1500));
        const c = window.__pp.viewer().canvas3d; const cv = document.querySelector('canvas');
        const hits = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45], [0.5, 0.55]]) {
            const p = c.identify([Math.round(cv.width * fx), Math.round(cv.height * fy)]);
            if (p && p.id) hits.push(p.id.objectId);
        }
        if (!hits.length) throw new Error('nenhum pick');
        return hits.length + '/5 pontos acertaram';`);
    await step('capabilities', `${pre} for (let i = 0; i < 150 && !C.useCompute.getState().caps; i++) await new Promise(r => setTimeout(r, 200)); const c = C.useCompute.getState().caps; if (!c) throw new Error(C.useCompute.getState().capsError || 'no caps'); return { pyrosetta: c.pyrosetta, mhcx: c.mhcxgraph, kv: c.pykvfinder, gpu: c.torch_cuda, limits: c.limits };`);

    await step('rosetta interface (design A × B,C)', `${pre}
        const s = byName('na1'); const input = await C.inputFor(s.id);
        await C.submit('rosetta_interface', { input, side_a: ['A'], side_b: ['B', 'C'], alanine_scan: true }, 'Interface teste', { structureIds: [s.id] });
        const r = await waitResult('rosetta_interface', 1, 180);
        const d = r.data; const ds = E.datasetsOf(v, s.id).map((x) => x.id);
        await E.showDataset(v, s.id, 'rosetta:dG');
        E.focusStructure(v, s.id);
        return { dG: d.metrics.dG_separated, sc: d.metrics.sc_value, hb: d.hbonds.length, unsat: d.unsats.length, ala: d.alanine_scan.length, datasets: ds };`);
    await shot('10-rosetta-interface');

    await step('kvfinder (1A1M groove, peptide as ligand)', `${pre}
        for (const s of S()) if (!s.name.startsWith('1a1m')) await E.setVisible(v, s.id, false);
        const s = byName('1a1m'); const input = await C.inputFor(s.id);
        await C.submit('kvfinder', { input, region: 'ligand', chains: ['A'], ligand_chains: ['C'], include_depth: true, include_hydropathy: true }, 'KV teste', { structureIds: [s.id] });
        const r = await waitResult('kvfinder', 1, 120);
        E.focusStructure(v, s.id);
        return { n: r.data.n, vols: r.data.cavities.map((c) => c.volume), setId: r.meta.extra.setId };`);
    await shot('11-kvfinder-surface-by-cavity');
    await step('kvfinder restyle (points, depth)', `${pre}
        const r = C.useCompute.getState().results.find((x) => x.tool === 'kvfinder');
        const a = await E.styleCavities(v, r.meta.extra.setId, { repr: 'spheres', color: 'depth' });
        if (!a.ok) throw new Error(a.error); return true;`);
    await shot('12-kvfinder-spheres-depth');
    await step('kvfinder cavities alone (protein hidden)', `${pre}
        const r = C.useCompute.getState().results.find((x) => x.tool === 'kvfinder');
        const s = byName('1a1m'); await E.setVisible(v, s.id, false);
        await E.styleCavities(v, r.meta.extra.setId, { repr: 'surface', color: 'cavity' });
        E.focusCavity(v, r.meta.extra.setId, r.data.cavities[0].tag);
        await new Promise((res) => setTimeout(res, 1500));
        const cells = [...v.plugin.state.data.cells.values()].filter((c) => (c.transform.tags || []).some((t) => t.startsWith('pp-cavity')) || /Cavidades/.test(c.obj?.label || ''));
        const info = cells.map((c) => {
            const kids = v.plugin.state.data.tree.children.get(c.transform.ref).toArray().map((k) => { const kc = v.plugin.state.data.cells.get(k); return { status: kc.status, err: kc.errorText, type: kc.obj?.type?.name, label: kc.obj?.label, hidden: kc.state.isHidden, visuals: kc.obj?.data?.repr?.renderObjects?.length }; });
            return { label: c.obj?.label, status: c.status, err: c.errorText, atoms: c.obj?.data?.elementCount, hidden: c.state.isHidden, kids };
        });
        return { reprs: v.canvas3d.reprCount.value, bs: v.canvas3d.boundingSphereVisible.radius, info };`);
    await shot('12b-kvfinder-cavities-only');
    await step('protein back, transparent surface over cavities', `${pre}
        const s = byName('1a1m'); await E.setVisible(v, s.id, true);
        await E.setLayer(v, { kind: 'structure', id: s.id }, 'surface', { layer: 'surface', style: 'molecular', opacity: 0.35 });
        return true;`);
    await shot('12c-kvfinder-in-groove');
    await step('cleanup surface', `${pre} const s = byName('1a1m'); await E.setLayer(v, { kind: 'structure', id: s.id }, 'surface', null); return true;`);

    if (process.env.PP_SHORT) { fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2)); app.exit(failed ? 1 : 0); return; }
    await step('electrostatics (1A1M chain A)', `${pre}
        const r0 = C.useCompute.getState().results.find((x) => x.tool === 'kvfinder'); await E.removeCavities(v, r0.meta.extra.setId);
        const s = byName('1a1m'); const input = await C.inputFor(s.id);
        await C.submit('electrostatics', { input, chains: ['A'] }, 'APBS teste', { structureIds: [s.id], extra: { chains: ['A'] } });
        const r = await waitResult('electrostatics', 1, 300);
        return { charge: r.data.net_charge, dime: r.data.grid.dime, hasPotential: Boolean(E.hasPotential(v, s.id)) };`);
    await shot('13-electrostatics');

    await step('tmalign (1AO7:A → 1A1M:A)', `${pre}
        const s1 = byName('1a1m'); const s2 = byName('1ao7');
        E.removePotential(v, s1.id);
        await E.setVisible(v, s2.id, true);
        const [ri, mi] = [await C.inputFor(s1.id), await C.inputFor(s2.id)];
        await C.submit('tmalign', { reference: { input: ri, chains: ['A'] }, mobile: { input: mi, chains: ['A'] } }, 'TM teste', { structureIds: [s1.id, s2.id], extra: { apply: true } });
        const r = await waitResult('tmalign', 1, 60);
        return { tm: r.data.tm_reference, rmsd: r.data.rmsd };`);

    await step('mhcxgraph multiple (1A1M + 1AO7)', `${pre}
        const s1 = byName('1a1m'); const s2 = byName('1ao7');
        const inputs = [{ input: await C.inputFor(s1.id), name: '1A1M' }, { input: await C.inputFor(s2.id), name: '1AO7' }];
        await C.submit('mhcxgraph', { structures: inputs, settings: { run_mode: 'multiple', node_granularity: 'ca_only', include_waters: false }, selector: { chains: ['A', 'C'] }, heatmap: false }, 'MHCX teste', { structureIds: [s1.id, s2.id] });
        const r = await waitResult('mhcxgraph', 1, 300);
        return { mode: r.data.mode, proteins: r.data.proteins, names: r.data.names, nodes: r.data.comparisons[0].nodes.length, comps: r.data.comparisons[0].components.length, dashboard: Boolean(r.data.dashboard) };`);
    await shot('14-mhcxgraph-graph');
    await step('mhcxgraph: click "Projetar" in the dock (node colours)', `${pre}
        const s1 = byName('1a1m'); const s2 = byName('1ao7');
        for (const s of S()) await E.setVisible(v, s.id, s.id === s1.id || s.id === s2.id);
        const nodeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Nó');
        if (nodeBtn) nodeBtn.click();
        await new Promise((r) => setTimeout(r, 300));
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Projetar'));
        if (!btn) throw new Error('botão Projetar não encontrado');
        btn.click();
        for (let i = 0; i < 100 && !useApp.getState().busy; i++) await new Promise((r) => setTimeout(r, 50));
        for (let i = 0; i < 600 && useApp.getState().busy; i++) await new Promise((r) => setTimeout(r, 100));
        E.focusStructure(v, s1.id);
        const d = E.datasetsOf(v, s1.id).find((x) => x.id === 'mhcx');
        return { coloredResidues: d ? Object.keys(d.colors || {}).length : 0 };`);
    await shot('15-mhcxgraph-projected');

    await step('colour by metric (Rosetta per-residue)', `${pre}
        const s = byName('na1');
        const ds = E.datasetsOf(v, s.id).map((d) => ({ id: d.id, n: Object.keys(d.values).length }));
        const dG = E.datasetsOf(v, s.id).find((d) => d.id === 'rosetta:dG');
        if (!dG) throw new Error('nenhum dataset de ΔG por resíduo');
        const r = await E.showDataset(v, s.id, 'rosetta:dG'); if (!r.ok) throw new Error(r.error);
        const domain = E.datasetDomain(dG);
        const colors = E.datasetColors(dG);
        const distinct = new Set(Object.values(colors)).size;
        await E.setColorSettings(v, s.id, { scheme: 'chain' });
        return { datasets: ds, domain: domain.map((x) => +x.toFixed(2)), coloured: Object.keys(colors).length, distinctColours: distinct, clipped: E.datasetClipped(dG) };`);

    await step('dssp (design, GPU)', `${pre}
        const s = byName('na1'); const input = await C.inputFor(s.id);
        await C.submit('dssp', { input, device: 'auto' }, 'DSSP teste', { structureIds: [s.id] });
        const r = await waitResult('dssp', 1, 120);
        return { device: r.data.device, chains: r.data.chains.map((c) => c.chain + ':' + c.helix.toFixed(2)) };`);

    await step('relax nstruct 2 (interface, 1 repeat)', `${pre}
        const s = byName('na1'); const input = await C.inputFor(s.id); const g = C.groupId();
        for (let k = 0; k < 2; k++) await C.submit('rosetta_relax', { input, side_a: ['A'], side_b: ['B', 'C'], repeats: 1, region: 'interface', seed: 100 + k }, 'Relax ' + k, { structureIds: [s.id], group: g, extra: { load: 'best' } });
        const r = await waitResult('rosetta_relax', 1, 600);
        return { runs: r.data.runs.map((x) => ({ seed: x.result.seed, score: Math.round(x.result.score_after), dG: x.result.interface && x.result.interface.dG_separated, s: Math.round(x.result.seconds) })), loaded: Object.keys(r.data.loaded).length, structures: S().length };`);

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
