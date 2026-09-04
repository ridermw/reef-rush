import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/reef-rush/',
  plugins: [react()],
  resolve: {
    alias: {
      '@dimforge/rapier3d': fileURLToPath(
        new URL('./node_modules/@dimforge/rapier3d/rapier.js', import.meta.url),
      ),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'react';
          }

          if (id.includes('/node_modules/three/')) {
            return 'three';
          }

          if (id.includes('/node_modules/@dimforge/rapier3d/')) {
            return 'rapier';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
