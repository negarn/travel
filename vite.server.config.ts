import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist-server',
    rollupOptions: {
      output: {
        entryFileNames: 'productionServer.mjs'
      }
    },
    ssr: 'server/productionServer.ts',
    target: 'node20'
  }
});
