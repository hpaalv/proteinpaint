/**
 * Checks the fixes asked for after the Fase 4 review:
 *   electron scripts/selftest5.cjs <out-dir>
 * backbone atoms when the ribbon is hidden, per-layer transparency, click-to-deselect,
 * undo/redo, and the depth-clipping indicator.
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

async function main() {
    let win = null;
    registerIpc(() => win);
    registerCore(() => win);
    win = new BrowserWindow({
        x: 0, y: 0, width: 1700, height: 1050, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/Security|CONTEXT_LOST/.test(message)) log.push({ console: message.slice(0, 300) }); });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1' } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name, wait = 1200) => {
        await new Promise((r) => setTimeout(r, wait));
        fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const step = async (name, code) => {
        const t0 = Date.now();
        try { log.push({ step: name, ok: true, ms: Date.now() - t0, value: await js(code) }); }
        catch (e) { failed = true; log.push({ step: name, ok: false, error: String(e) }); }
    };
    const pre = `const { E, useApp, viewer, actions, history } = window.__pp; const v = viewer();
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const s = () => useApp.getState().structures[0];
        const atomCount = () => { const d = v.plugin.state.data; let n = 0;
            for (const c of v.plugin.managers.structure.hierarchy.current.structures[0].components) {
                const tag = (c.cell.transform.tags || []).find((t) => t.startsWith('pp-layer:'));
                if (tag && JSON.parse(tag.slice(9)).layer === 'atoms') n += c.cell.obj.data.elementCount;
            } return n; };`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('load', `${pre} await actions.loadPaths([${JSON.stringify(DESIGN)}]); await wait(800); return s().name;`);
    await step('atoms with the ribbon on (side chains only)', `${pre}
        await E.setLayer(v, { kind: 'structure', id: s().id }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1 });
        await wait(400); return atomCount();`);
    await step('hide the ribbon → atoms cover the backbone', `${pre}
        await E.setLayer(v, { kind: 'structure', id: s().id }, 'ribbon', null); await wait(600);
        return { atoms: atomCount(), layers: E.layerSummary(v, s().id).map((l) => l.layer) };`);
    await shot('00-atoms-backbone');
    await step('per-layer transparency', `${pre}
        await E.setLayer(v, { kind: 'structure', id: s().id }, 'ribbon', { layer: 'ribbon', style: 'cartoon' }); await wait(400);
        await E.setLayerOpacity(v, { kind: 'structure', id: s().id }, 'ribbon', 0.35); await wait(300);
        await E.setLayerOpacity(v, { kind: 'structure', id: s().id }, 'atoms', 0.5); await wait(300);
        return E.layerOpacities(v, s().id);`);
    await shot('01-transparency');
    await step('undo twice, then redo', `${pre}
        history.record('teste'); await E.setLayer(v, { kind: 'structure', id: s().id }, 'surface', { layer: 'surface', style: 'molecular', opacity: 1 }); await wait(700);
        const withSurface = E.layerSummary(v, s().id).map((l) => l.layer);
        await history.undo(); await wait(900);
        const afterUndo = E.layerSummary(v, s().id).map((l) => l.layer);
        await history.redo(); await wait(900);
        const afterRedo = E.layerSummary(v, s().id).map((l) => l.layer);
        return { withSurface, afterUndo, afterRedo };`);
    await shot('02-undo-redo');
    await step('empty-click deselect binding is active', `${pre}
        // Mol*'s own input observer turns a real click into this action; what the app
        // controls is whether the binding exists at all (it used to be disabled).
        let found = null;
        for (const cell of v.plugin.state.behaviors.cells.values()) {
            const b = cell.params && cell.params.values && cell.params.values.bindings;
            if (b && b.clickDeselectAllOnEmpty) found = b.clickDeselectAllOnEmpty;
        }
        await E.selectChain(v, s().id, 'A', 'set'); await wait(200);
        const before = E.selectionSummary(v).residues;
        v.plugin.managers.interactivity.lociSelects.deselectAll(); await wait(300);
        return { binding: found && found.triggers.length, before, after: E.selectionSummary(v) ? E.selectionSummary(v).residues : 0 };`);

    await step('labels with leader lines', `${pre}
        await E.selectChain(v, s().id, 'C', 'set'); await wait(300);
        const r = await E.labelSelection(v, { ...E.DEFAULT_LABEL_STYLE, content: 'residue', leaderLength: 7 });
        if (!r.ok) throw new Error(r.error);
        await wait(600);
        let leaders = 0, texts = 0;
        v.plugin.state.data.cells.forEach((c) => {
            const t = (c.transform.tags || []).join(' ');
            if (t.includes('pp-overlay:label-leaders')) leaders++;
            if (t.includes('pp-overlay:label-text')) texts++;
        });
        return { labelled: r.value, leaders, texts };`);
    await shot('04-labels');
    await step('clear labels', `${pre} await E.clearLabels(v); await wait(400);
        let left = 0; v.plugin.state.data.cells.forEach((c) => { const t = (c.transform.tags || []).join(' ');
            if (t.includes('pp-overlay:label-')) left++; });
        return { left };`);

    await step('measure between two selections', `${pre}
        await E.selectChain(v, s().id, 'C', 'set'); await wait(250);
        const a = E.captureSelection(v, 'a'); if (!a.ok) throw new Error(a.error);
        await E.selectChain(v, s().id, 'A', 'set'); await wait(250);
        const b = E.captureSelection(v, 'b'); if (!b.ok) throw new Error(b.error);
        const r = await E.measureBetweenSelections(v, 4); if (!r.ok) throw new Error(r.error);
        const m = r.value;
        return { min: +m.minDistance.toFixed(2), centroid: +m.centroidDistance.toFixed(1), contacts: m.contacts, pair: m.minPair, sides: [m.atomsA, m.atomsB] };`);
    await step('glow from the selection', `${pre}
        await E.applyLookPreset(v, 'poster-dark', 0); await wait(400);
        await E.selectChain(v, s().id, 'A', 'set'); await wait(250);
        const r = await E.setEmissive(v, { kind: 'selection' }, 0.9); if (!r.ok) throw new Error(r.error);
        await E.tuneLook(v, { bloom: 1.1 }, 0); E.clearSelection(v); await wait(700);
        const painted = v.entry(s().id).paint.filter((p) => p.kind === 'emissive').length;
        const c = await E.clearEmissive(v, s().id); await wait(400);
        return { painted, cleared: c.ok, left: v.entry(s().id).paint.filter((p) => p.kind === 'emissive').length };`);

    await step('clipping indicator', `${pre} E.setClip(v, 60); useApp.setState({ clip: 60 }); await wait(400);
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Corte de profundidade'));
        return { shown: Boolean(btn), text: btn && btn.textContent.trim() };`);
    await shot('03-clip-indicator');

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
