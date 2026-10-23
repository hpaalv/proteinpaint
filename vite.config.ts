import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    // Electron loads the production build from file://, so asset URLs must be relative.
    base: './',
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    build: {
        outDir: 'dist',
        chunkSizeWarningLimit: 8192,
        // Electron 44 ships a current Chromium; no need to down-level anything.
        target: 'esnext',
    },
    server: {
        port: 5273,
        strictPort: true,
    },
});
