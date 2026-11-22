// Stand-alone harness for the mission-control centrepiece: plays the web app's fictional mock run.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 4330, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  preview: { port: 4330 },
  build: { outDir: 'dist', emptyOutDir: true },
});
