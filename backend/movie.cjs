/**
 * Movies: raw RGBA frames from the renderer are piped into ffmpeg's stdin, so no
 * intermediate PNG is encoded per frame and memory holds one frame at a time.
 * Shared by the Electron main process and the web server.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOVIE_FORMATS = {
    mp4: { ext: 'mp4', name: 'Vídeo MP4 (H.264)' },
    webm: { ext: 'webm', name: 'Vídeo WebM (VP9, com transparência)' },
    gif: { ext: 'gif', name: 'GIF animado' },
    apng: { ext: 'png', name: 'PNG animado (APNG)' },
    frames: { ext: '', name: 'Sequência de PNG' },
};

function ffmpegArgs(format, output, { width, height, fps }) {
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
    switch (format) {
        case 'mp4':
            // yuv420p + faststart: plays in PowerPoint, browsers and on phones.
            return [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
        case 'webm':
            return [...input, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-auto-alt-ref', '0', output];
        case 'gif':
            // Palette from the whole clip, error diffusion, transparent where alpha is.
            return [
                ...input,
                '-filter_complex',
                'split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128',
                '-loop', '0', output,
            ];
        case 'apng':
            return [...input, '-c:v', 'apng', '-pix_fmt', 'rgba', '-plays', '0', '-f', 'apng', output];
        case 'frames':
            return [...input, '-c:v', 'png', '-pix_fmt', 'rgba', '-start_number', '0', path.join(output, 'frame_%04d.png')];
        default:
            throw new Error(`Formato desconhecido: ${format}`);
    }
}

const movies = new Map();
let movieSeq = 0;

async function movieStart({ format, output, width, height, fps }) {
    const id = ++movieSeq;
    let proc;
    try {
        if (format === 'frames') await fs.mkdir(output, { recursive: true });
        proc = spawn('ffmpeg', ffmpegArgs(format, output, { width, height, fps }), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
        return { ok: false, error: `ffmpeg não pôde ser iniciado: ${e.message || e}` };
    }
    const movie = { proc, stderr: '', exited: null, output };
    movie.exited = new Promise((resolve) => {
        proc.on('error', (e) => {
            movie.stderr += String(e.message || e);
            resolve(-1);
        });
        proc.on('close', (code) => resolve(code));
    });
    proc.stderr.on('data', (d) => (movie.stderr = (movie.stderr + d).slice(-4000)));
    // A closed pipe (ffmpeg died) must not crash the process.
    proc.stdin.on('error', () => {});
    movies.set(id, movie);
    return { ok: true, value: id };
}

/** @param {Buffer} buffer one RGBA frame */
async function movieFrame(id, buffer) {
    const movie = movies.get(id);
    if (!movie) return { ok: false, error: 'Vídeo não iniciado.' };
    if (!movie.proc.stdin.writable) return { ok: false, error: movie.stderr || 'O ffmpeg encerrou.' };
    // Backpressure: wait for ffmpeg to drain before accepting the next frame.
    if (!movie.proc.stdin.write(buffer)) await new Promise((resolve) => movie.proc.stdin.once('drain', resolve));
    return { ok: true, value: true };
}

async function movieFinish(id, cancel) {
    const movie = movies.get(id);
    if (!movie) return { ok: false, error: 'Vídeo não iniciado.' };
    movies.delete(id);
    if (cancel) movie.proc.kill('SIGKILL');
    else movie.proc.stdin.end();
    const code = await movie.exited;
    if (cancel) {
        await fs.rm(movie.output, { force: true }).catch(() => {});
        return { ok: true, value: null };
    }
    return code === 0 ? { ok: true, value: movie.output } : { ok: false, error: movie.stderr.trim() || `ffmpeg saiu com código ${code}` };
}

module.exports = { MOVIE_FORMATS, movieStart, movieFrame, movieFinish };
