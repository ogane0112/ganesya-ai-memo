import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@gmemo/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
});
