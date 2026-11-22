import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone dev page for the talent-flow centrepiece: npm run wow:flow -> http://localhost:5181/
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 5181, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
