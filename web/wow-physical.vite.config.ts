// Standalone harness for the wow-physical centrepiece: `npm run wow:physical`, then open /wow-physical.html
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 4410, strictPort: true, open: false, fs: { allow: ['..'] } },
  build: { outDir: 'dist-wow-physical', rollupOptions: { input: fileURLToPath(new URL('./wow-physical.html', import.meta.url)) } },
});
