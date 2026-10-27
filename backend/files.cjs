/**
 * File access shared by the Electron main process (electron/ipc.cjs) and the web
 * server (server/main.cjs): reading structures with native gunzip, folder and
 * dataset scans. No Electron imports here.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);
const STRUCTURE_EXT = /\.(pdb|ent|cif|mmcif|bcif|pdbqt)(\.gz)?$/i;
const TABLE_EXT = /\.(csv|tsv|txt)$/i;
const DOC_EXT = /\.(md|rst)$/i;

/**
 * Reads one structure file and gunzips it here, so the renderer receives plain
 * bytes. Returns a transferable record; failures are reported per file so one bad
 * file in a folder of 500 designs does not abort the rest.
 */
async function readStructure(filePath) {
    try {
        let bytes = await fs.readFile(filePath);
        let name = path.basename(filePath);
        if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            bytes = await gunzip(bytes);
            name = name.replace(/\.gz$/i, '');
        }
        const stat = await fs.stat(filePath);
        return { ok: true, name, path: filePath, size: stat.size, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } catch (e) {
        return { ok: false, name: path.basename(filePath), path: filePath, error: String(e && e.message ? e.message : e) };
    }
}

async function scanFolder(root, maxDepth = 4) {
    const out = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth) await walk(full, depth + 1);
            } else if (STRUCTURE_EXT.test(entry.name)) {
                out.push(full);
            }
        }
    }
    await walk(root, 0);
    // Natural sort, so design_2 comes before design_10.
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Reads many files concurrently, capped so a huge folder does not exhaust file handles. */
async function readMany(paths, concurrency = 16) {
    const results = new Array(paths.length);
    let next = 0;
    async function worker() {
        while (next < paths.length) {
            const i = next++;
            results[i] = await readStructure(paths[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return results;
}

/** Paths dropped onto the window: folders are expanded, files read as-is. */
async function expandPaths(paths) {
    const files = [];
    for (const p of paths) {
        try {
            const stat = await fs.stat(p);
            if (stat.isDirectory()) files.push(...(await scanFolder(p)));
            else files.push(p);
        } catch {
            files.push(p);
        }
    }
    return files;
}

/** Structures and tables of a dataset folder, in one walk. */
async function scanDataset(root) {
    const structures = [];
    const tables = [];
    const docs = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < 4) await walk(full, depth + 1);
            } else if (STRUCTURE_EXT.test(entry.name)) {
                structures.push(full);
            } else if (TABLE_EXT.test(entry.name)) {
                const stat = await fs.stat(full).catch(() => null);
                // A 200 MB text file is not a metadata table; keep the dialog responsive.
                if (stat && stat.size < 64 * 1024 * 1024) tables.push({ path: full, size: stat.size });
            } else if (DOC_EXT.test(entry.name)) {
                docs.push(full);
            }
        }
    }
    await walk(root, 0);
    structures.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { folder: root, structures, tables, docs };
}

/** Structures that exist only in memory (fetched from RCSB) are written here so the Python tools can read them. */
async function writeTemp(dir, name, text) {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
    await fs.writeFile(file, text, 'utf8');
    return file;
}

function pngBytes(dataUrl) {
    return Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
}

module.exports = { STRUCTURE_EXT, readStructure, scanFolder, readMany, expandPaths, scanDataset, writeTemp, pngBytes };
