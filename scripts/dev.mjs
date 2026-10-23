// Dev loop: Vite dev server (hot reload) + Electron pointed at it, on the NVIDIA GPU.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
console.log(`[dev] vite em ${url}`);

const electron = spawn(path.join(root, 'scripts', 'launch.sh'), [], {
    stdio: 'inherit',
    env: { ...process.env, PP_DEV_URL: url },
});
electron.on('exit', async (code) => {
    await server.close();
    process.exit(code ?? 0);
});
