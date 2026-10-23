/**
 * End-to-end check of the figure studio (Fase 3) in a real Electron window:
 *   electron scripts/selftest3.cjs <out-dir>
 * Applies every look preset, edits lights and materials, orients the camera from the
 * complex's geometry, runs the distance fade and the footprint, exports a supersampled
 * PNG and encodes a short turntable through ffmpeg. Saves window and canvas captures.
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
const PRESETS = ['soft', 'chimerax-soft', 'white-figure', 'illustrative', 'glossy', 'clay', 'poster-dark', 'cinematic', 'flat', 'raytraced'];

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
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1' } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name, wait = 1500) => {
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
    const pre = `const { E, useApp, viewer, actions } = window.__pp; const v = viewer();
        const S = () => useApp.getState().structures; const s = S()[0];
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const click = (text) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(text)); if (!b) throw new Error('botão ' + text); b.click(); };`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('load design', `${pre} await actions.loadPaths([${JSON.stringify(DESIGN)}]); await wait(800);
        return S()[0].chains.map((c) => c.authAsymId + ':' + c.role).join(' ');`);
    await step('open Estúdio tab', `${pre} useApp.setState({ tab: 'scene' }); await wait(400); return E.illuminationSupported(v);`);
    await shot('00-studio-soft');

    // Every preset through the gallery buttons, with the blend measured.
    for (const p of PRESETS) {
        await step(`preset ${p}`, `${pre}
            const label = E.LOOK_PRESETS['${p}'].label;
            const btn = [...document.querySelectorAll('button')].find((b) => b.title === E.LOOK_PRESETS['${p}'].description);
            if (!btn) return 'sem botão (' + label + ')';
            const t0 = performance.now(); btn.click();
            let frames = 0; const t1 = performance.now();
            await new Promise((resolve) => { const f = () => { frames++; if (performance.now() - t1 < 500) requestAnimationFrame(f); else resolve(); }; requestAnimationFrame(f); });
            const look = E.getLook(v);
            return { label, preset: useApp.getState().look, fps500ms: frames * 2, outline: look.outline, bg: look.background.kind, gi: look.illumination };`);
        await shot(`01-preset-${p}`, p === 'raytraced' ? 4000 : 1200);
    }

    await step('lights + material (glossy, rim light, metal)', `${pre}
        await E.applyLookPreset(v, 'white-figure', 0); useApp.setState({ look: 'white-figure' });
        const l = E.getLook(v);
        await E.tuneLook(v, { lights: [...l.lights, { inclination: 30, azimuth: 140, color: 0x88bbff, intensity: 0.8 }], material: { ribbon: { metalness: 0.65, roughness: 0.35, bumpiness: 0 }, atoms: l.material.atoms, surface: l.material.surface } }, 300);
        await wait(300);
        return { lights: E.getLook(v).lights.length, ribbonMetal: E.getLook(v).material.ribbon.metalness };`);
    await shot('02-lights-material');

    await step('surface on MHC + peptide (for footprint)', `${pre}
        for (const c of ['B', 'C']) await E.setLayer(v, { kind: 'chain', id: s.id, chain: c }, 'surface', { layer: 'surface', style: 'molecular', opacity: 1 });
        return E.layerSummary(v, s.id).map((x) => x.layer + ':' + x.style);`);

    for (const view of ['side', 'top', 'threequarter', 'groove']) {
        await step(`canonical view ${view}`, `${pre} const r = E.canonicalView(v, s.id, '${view}', 0); if (!r.ok) throw new Error(r.error);
            const a = r.value; return { grooveFrom: a.grooveFrom, dock: a.dock.map((x) => x.toFixed(2)).join(','), orth: Math.abs(a.dock[0]*a.groove[0]+a.dock[1]*a.groove[1]+a.dock[2]*a.groove[2]).toFixed(4) };`);
        await shot(`03-view-${view}`, 900);
    }

    await step('footprint (nearest colour, 7 Å)', `${pre}
        await E.applyLookPreset(v, 'chimerax-soft', 0); useApp.setState({ look: 'chimerax-soft' });
        await E.setChainColor(v, s.id, 'A', 0xe69f00);
        const t0 = performance.now();
        const r = await E.paintFootprint(v, { target: { structureId: s.id, chains: ['B', 'C'] }, source: { kind: 'chains', structureId: s.id, chains: ['A'] }, distance: 7, mode: 'nearest', color: 0 });
        if (!r.ok) throw new Error(r.error);
        E.canonicalView(v, s.id, 'top', 0);
        return { atoms: r.value.atoms, ms: Math.round(performance.now() - t0) };`);
    await shot('04-footprint-top');

    await step('distance fade (interface, cartoon only)', `${pre}
        await E.clearFootprint(v);
        for (const c of ['B', 'C']) await E.setLayer(v, { kind: 'chain', id: s.id, chain: c }, 'surface', null);
        const t0 = performance.now();
        const r = await E.fadeByDistance(v, { reference: { kind: 'interface', cutoff: 4.5 }, near: 5, far: 28, minOpacity: 0.18, perResidue: true });
        if (!r.ok) throw new Error(r.error);
        E.canonicalView(v, s.id, 'side', 0);
        return { faded: r.value.faded, ms: Math.round(performance.now() - t0) };`);
    await shot('05-fade-side');
    await step('fade cleared, user paint kept', `${pre}
        const before = v.entry(s.id).paint.length;
        const r = await E.clearFade(v); if (!r.ok) throw new Error(r.error);
        return { before, after: v.entry(s.id).paint.length, tags: v.entry(s.id).paint.map((p) => p.tag || 'user') };`);

    await step('figure tab UI', `${pre} useApp.setState({ tab: 'figure' }); await wait(500); return document.querySelectorAll('section').length;`);
    await shot('06-figure-tab');

    await step('PNG 2000 px, 2× supersample, outline matched', `${pre}
        await E.fadeByDistance(v, { reference: { kind: 'interface', cutoff: 4.5 }, near: 5, far: 28, minOpacity: 0.18, perResidue: true });
        const t0 = performance.now();
        const r = await E.renderImage(v, { width: 2000, transparent: true, cropToMolecule: true, supersample: 2, matchScreen: true });
        if (!r.ok) throw new Error(r.error);
        window.__png = r.value.dataUrl;
        return { w: r.value.width, h: r.value.height, k: r.value.supersample, ms: Math.round(performance.now() - t0), kb: Math.round(r.value.dataUrl.length * 0.75 / 1024) };`);
    const png = await js('return window.__png');
    if (png) fs.writeFileSync(path.join(outDir, '07-export-2000px.png'), Buffer.from(png.split(',')[1], 'base64'));

    for (const [format, file] of [['mp4', '08-turntable.mp4'], ['gif', '08-rock.gif']]) {
        await step(`movie ${format} through ffmpeg`, `${pre}
            const out = ${JSON.stringify(path.join(outDir, file))};
            let id = null; const t0 = performance.now();
            const r = await E.renderMovie(v, { width: 640, height: 360, frames: 24, motion: '${format === 'mp4' ? 'turntable' : 'rock'}', axis: 'vertical', amplitude: 20, transparent: false, supersample: 1 },
                async (f) => { if (id === null) { const st = await window.pp.movieStart({ format: '${format}', output: out, width: f.width, height: f.height, fps: 24 }); if (!st.ok) throw new Error(st.error); id = st.value; }
                    const w = await window.pp.movieFrame(id, f.rgba); if (!w.ok) throw new Error(w.error); },
                () => {}, () => false);
            if (!r.ok) throw new Error(r.error);
            const fin = await window.pp.movieFinish(id, false); if (!fin.ok) throw new Error(fin.error);
            return { frames: r.value.frames, size: r.value.width + 'x' + r.value.height, ms: Math.round(performance.now() - t0), file: fin.value };`);
    }

    await step('PNG over a radial gradient (glossy)', `${pre}
        await E.applyLookPreset(v, 'glossy', 0); useApp.setState({ look: 'glossy' });
        const r = await E.renderImage(v, { width: 1200, transparent: false, cropToMolecule: false, supersample: 1, matchScreen: true });
        if (!r.ok) throw new Error(r.error);
        window.__png2 = r.value.dataUrl; return { w: r.value.width, h: r.value.height, backdrop: v.backdrop.kind };`);
    const png2 = await js('return window.__png2');
    if (png2) fs.writeFileSync(path.join(outDir, '07b-export-glossy.png'), Buffer.from(png2.split(',')[1], 'base64'));

    await step('toast + inspector animation sanity', `${pre} useApp.setState({ tab: 'style' }); await wait(100); useApp.setState({ tab: 'scene' }); return document.querySelector('.panel-enter') !== null;`);
    await shot('09-final-studio', 800);

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
