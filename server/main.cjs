/**
 * ProteinPaint web server: the app without Electron, for an HPC node reached through
 * an SSH tunnel. The browser on the user's machine renders (WebGL on its own GPU);
 * files and the compute core stay here. Serves dist/ and the /api the web bridge
 * (src/platform/web.ts) calls — the same surface as electron/preload.cjs.
 *
 *   PP_TOKEN=… PP_PORT=5273 node server/main.cjs        (hpc/pp-hpc does this in a job)
 *
 * The node is shared with other users, so nothing is served without the token: it
 * arrives once in the URL and becomes an HttpOnly, SameSite=Strict cookie. POSTs also
 * need an X-PP header, which a cross-site page cannot send without a preflight we never
 * answer. Paths are confined to PP_ROOTS (default: $HOME) after resolving symlinks.
 *
 * Env: PP_TOKEN (required), PP_PORT (0 = any free port), PP_HOST (default 127.0.0.1),
 *      PP_ROOTS (':'-separated), PP_TEMP_DIR, PP_INFO_FILE (JSON written once listening).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const files = require('../backend/files.cjs');
const movie = require('../backend/movie.cjs');
const { createCore } = require('../backend/core.cjs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TOKEN = process.env.PP_TOKEN || '';
const PORT = Number(process.env.PP_PORT ?? 5273);
const HOST = process.env.PP_HOST || '127.0.0.1';
const TEMP_DIR = process.env.PP_TEMP_DIR || path.join(os.tmpdir(), `proteinpaint-${os.userInfo().username}`);
const COOKIE = 'pp_token';
/** Large PNG exports arrive as data URLs and movie frames as raw RGBA. */
const MAX_BODY = 1024 * 1024 * 1024;

if (TOKEN.length < 16) {
    console.error('PP_TOKEN ausente ou curto demais (mínimo 16 caracteres).');
    process.exit(2);
}

fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
const ROOTS = [...(process.env.PP_ROOTS || os.homedir()).split(':').filter(Boolean), TEMP_DIR].map((r) => fs.realpathSync(path.resolve(r)));

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function tokenOk(candidate) {
    const a = Buffer.from(String(candidate || ''));
    const b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieToken(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
}

function insideRoots(real) {
    return ROOTS.some((r) => real === r || real.startsWith(r + path.sep));
}

/**
 * Resolves a client path to a real path inside the roots. A path that does not exist
 * yet (a file being saved) is checked through its nearest existing ancestor.
 */
function guard(p) {
    if (typeof p !== 'string' || !p) throw httpError(400, 'Caminho vazio.');
    const abs = path.resolve(p);
    let probe = abs;
    let rest = '';
    for (;;) {
        try {
            const real = fs.realpathSync(probe);
            const full = rest ? path.join(real, rest) : real;
            if (!insideRoots(full)) throw httpError(403, `Fora das pastas permitidas: ${abs}`);
            return full;
        } catch (e) {
            if (e.status) throw e;
            const parent = path.dirname(probe);
            if (parent === probe) throw httpError(403, `Fora das pastas permitidas: ${abs}`);
            rest = rest ? path.join(path.basename(probe), rest) : path.basename(probe);
            probe = parent;
        }
    }
}

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Compute core and server-sent events
// ---------------------------------------------------------------------------

/** @type {Set<http.ServerResponse>} */
const listeners = new Set();

function broadcast(event, payload) {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of listeners) res.write(line);
}

const core = createCore({
    onJob: (job) => broadcast('job', job),
    onDown: (error) => broadcast('down', error),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function listDir(dir, showHidden) {
    const real = guard(dir);
    const entries = [];
    for (const d of await fsp.readdir(real, { withFileTypes: true })) {
        if (!showHidden && d.name.startsWith('.')) continue;
        const full = path.join(real, d.name);
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        entries.push({ name: d.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    const parent = path.dirname(real);
    return { dir: real, parent: parent !== real && insideRoots(parent) ? parent : null, entries };
}

const METHODS = {
    info: () => ({ home: os.homedir(), roots: ROOTS, temp: TEMP_DIR, user: os.userInfo().username, host: os.hostname() }),
    list: (dir, showHidden) => listDir(dir, Boolean(showHidden)),
    core: (method, params) => core.reply(method, params),
    expandPaths: (paths) => files.expandPaths(paths.map(guard)),
    scanFolder: async (folder) => files.scanFolder(guard(folder)),
    scanDataset: (folder) => files.scanDataset(guard(folder)),
    writeTemp: (name, text) => files.writeTemp(TEMP_DIR, name, text),
    writeText: async (file, text) => {
        const real = guard(file);
        await fsp.writeFile(real, text, 'utf8');
        return { ok: true, path: real };
    },
    writePng: async (file, dataUrl) => {
        const real = guard(file);
        await fsp.writeFile(real, files.pngBytes(dataUrl));
        return { ok: true, path: real };
    },
    mkdir: async (dir) => {
        const real = guard(dir);
        await fsp.mkdir(real, { recursive: true });
        return real;
    },
    movieStart: (opts) => movie.movieStart({ ...opts, output: guard(opts.output) }),
    movieFinish: (id, cancel) => movie.movieFinish(id, cancel),
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(httpError(413, 'Corpo grande demais.'));
                req.destroy();
            } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.csv': 'text/csv; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.pdb': 'text/plain; charset=utf-8',
    '.cif': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.gif': 'image/gif',
};

/** Streams a file; job outputs (HTML dashboards, PNGs, logs) open in a browser tab. */
async function sendFile(res, real, { download, sandbox }) {
    const st = await fsp.stat(real);
    if (st.isDirectory()) throw httpError(400, 'É uma pasta.');
    const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' };
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`;
    // Generated HTML (MHCXGraph's dashboard) runs scripts; an opaque origin keeps them
    // away from the API and the cookie.
    if (sandbox) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-downloads';
    res.writeHead(200, headers);
    fs.createReadStream(real).pipe(res);
}

async function api(req, res, url) {
    const route = url.pathname.slice('/api/'.length);
    if (req.method === 'POST' && req.headers['x-pp'] !== '1') throw httpError(403, 'Cabeçalho X-PP ausente.');

    if (route === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(ping);
            listeners.delete(res);
        });
        return;
    }

    if (route === 'call' && req.method === 'POST') {
        const { method, args } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
        if (!fn) throw httpError(404, `Método desconhecido: ${method}`);
        return sendJson(res, 200, { value: await fn(...(Array.isArray(args) ? args : [])) });
    }

    // One structure, gunzipped, as raw bytes (the web bridge's readFiles).
    if (route === 'read' && req.method === 'GET') {
        const real = guard(url.searchParams.get('path'));
        const r = await files.readStructure(real);
        if (!r.ok) throw httpError(404, r.error);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': r.bytes.byteLength,
            'Cache-Control': 'no-store',
            'X-PP-Name': encodeURIComponent(r.name),
            'X-PP-Size': String(r.size),
        });
        return res.end(Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength));
    }

    if (route === 'raw' && req.method === 'GET') {
        const real = guard(url.searchParams.get('path'));
        const ext = path.extname(real).toLowerCase();
        return sendFile(res, real, { download: url.searchParams.has('download'), sandbox: ext === '.html' || ext === '.htm' || ext === '.svg' });
    }

    if (route === 'movie/frame' && req.method === 'POST') {
        const id = Number(url.searchParams.get('id'));
        return sendJson(res, 200, { value: await movie.movieFrame(id, await readBody(req)) });
    }

    throw httpError(404, 'Rota desconhecida.');
}

// ---------------------------------------------------------------------------
// Static app
// ---------------------------------------------------------------------------

async function sendApp(res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '/index.html') {
        // The marker tells the bundle to install the web bridge (src/platform/web.ts).
        // Read on every load: a rebuild while serving replaces the hashed asset names.
        const indexHtml = (await fsp.readFile(path.join(DIST, 'index.html'), 'utf8')).replace('<head>', '<head><meta name="pp-web" content="1">');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(indexHtml);
    }
    const file = path.join(DIST, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(DIST + path.sep)) throw httpError(404, 'Não encontrado.');
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw httpError(404, 'Não encontrado.');
    // Vite fingerprints assets, so they can be cached for good.
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    fs.createReadStream(file).pipe(res);
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>ProteinPaint</title>
<body style="background:#0b0e14;color:#e6ecf5;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;line-height:1.5"><h2 style="margin:0 0 8px">ProteinPaint</h2>
Abra o endereço completo, com <code>?token=…</code>, que o <code>hpc/pp-hpc start</code> imprimiu
(ou rode <code>hpc/pp-hpc status</code> no HPC para vê-lo de novo).</div></body>`;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        const fromQuery = url.searchParams.get('token');
        if (fromQuery !== null && tokenOk(fromQuery)) {
            // Trade the URL token for a cookie and drop it from the address bar.
            url.searchParams.delete('token');
            res.writeHead(303, {
                'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/`,
                Location: url.pathname + (url.search || ''),
            });
            return res.end();
        }
        if (!tokenOk(cookieToken(req))) {
            if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sem autorização (token).' });
            res.writeHead(401, { 'Content-Type': MIME['.html'] });
            return res.end(LOGIN_PAGE);
        }
        if (url.pathname.startsWith('/api/')) return await api(req, res, url);
        return await sendApp(res, url);
    } catch (e) {
        const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500);
        if (res.headersSent) return res.destroy();
        return sendJson(res, status, { error: String(e && e.message ? e.message : e) });
    }
});

server.listen(PORT, HOST, () => {
    const { port } = server.address();
    const info = { host: os.hostname(), port, pid: process.pid, url: `http://localhost:${port}/?token=${TOKEN}` };
    if (process.env.PP_INFO_FILE) fs.writeFileSync(process.env.PP_INFO_FILE, JSON.stringify(info), { mode: 0o600 });
    console.log(`ProteinPaint em ${HOST}:${port} (nó ${info.host}) · pastas: ${ROOTS.join(', ')}`);
});

function shutdown() {
    // Take the compute core (and its Rosetta workers) down with us.
    core.stop();
    for (const res of listeners) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
