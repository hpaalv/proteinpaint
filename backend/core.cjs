/**
 * Client of the Python compute core (ppcore/server.py), shared by the Electron main
 * process and the web server.
 *
 * The server runs on the app's own Python (PP_APP_PYTHON, default .pyenv); it launches
 * per-job workers on that interpreter or on the PyRosetta one. One server per app
 * instance, started on first use and killed with the app, so no stray Rosetta process
 * outlives it.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PP_APP_PYTHON || path.join(ROOT, '.pyenv', 'bin', 'python');

/**
 * @param {{ onJob: (job: unknown) => void, onDown: (error: string | null) => void, onReady?: (limits: unknown) => void }} events
 */
function createCore(events) {
    /** @type {import('node:child_process').ChildProcess | null} */
    let server = null;
    let nextId = 1;
    /** @type {Map<number, {resolve: (v: unknown) => void, reject: (e: Error) => void}>} */
    const pending = new Map();
    let serverError = null;

    function start() {
        if (server) return;
        serverError = null;
        server = spawn(PYTHON, ['-u', '-m', 'ppcore.server'], {
            cwd: ROOT,
            env: { ...process.env, PYTHONPATH: ROOT, PYTHONUNBUFFERED: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const rl = readline.createInterface({ input: server.stdout });
        rl.on('line', (line) => {
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                return;
            }
            if (msg.id !== undefined && pending.has(msg.id)) {
                const p = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error));
                else p.resolve(msg.result);
            } else if (msg.event === 'job') {
                events.onJob(msg.job);
            } else if (msg.event === 'ready') {
                events.onReady?.(msg.limits);
            }
        });
        let stderr = '';
        server.stderr.on('data', (d) => {
            stderr = (stderr + d.toString()).slice(-4000);
        });
        server.on('exit', (code) => {
            serverError = code ? `O núcleo de cálculo saiu com código ${code}.\n${stderr}` : null;
            for (const p of pending.values()) p.reject(new Error(serverError || 'Núcleo de cálculo encerrado.'));
            pending.clear();
            server = null;
            events.onDown(serverError);
        });
        server.on('error', (e) => {
            serverError = `Não foi possível iniciar o Python do app (${PYTHON}): ${e.message}`;
        });
    }

    function call(method, params) {
        start();
        return new Promise((resolve, reject) => {
            if (!server || !server.stdin.writable) return reject(new Error(serverError || 'Núcleo de cálculo indisponível.'));
            const id = nextId++;
            pending.set(id, { resolve, reject });
            server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }

    /** {ok, value} | {ok: false, error}: the shape the renderer's bridge expects. */
    async function reply(method, params) {
        try {
            return { ok: true, value: await call(method, params) };
        } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
        }
    }

    function stop() {
        if (server) server.kill('SIGTERM');
    }

    return { call, reply, stop };
}

module.exports = { createCore };
