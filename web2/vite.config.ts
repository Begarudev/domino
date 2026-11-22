import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

// web2 imports the data layer from ../web/src and ../shared, and the sample run from ../docs.
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB2_PORT ?? 5180),
    fs: { allow: [repo] },
    proxy: { '/api': { target: process.env.DOMINO_API ?? 'http://127.0.0.1:4321', changeOrigin: true } },
  },
  preview: { host: '127.0.0.1', port: 4180, proxy: { '/api': { target: process.env.DOMINO_API ?? 'http://127.0.0.1:4321', changeOrigin: true } } },
});
