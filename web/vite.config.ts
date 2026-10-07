import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');

// Cross-origin isolation so SharedArrayBuffer is available (ARCHITECTURE.md).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  root: webRoot,
  base: './',
  publicDir: path.join(webRoot, 'public'),
  resolve: {
    alias: { '@data': path.join(repoRoot, 'data') },
  },
  server: {
    headers: isolationHeaders,
    fs: { allow: [repoRoot] },
    watch: { ignored: ['**/engine/target/**'] },
  },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: {
    outDir: path.join(repoRoot, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // split vendor code so app updates don't invalidate the (large, stable) three.js chunk
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/lil-gui/')) return 'lil-gui';
          return undefined;
        },
      },
    },
  },
});
