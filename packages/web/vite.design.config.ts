/**
 * The design catalog (a small self-made Storybook): `npm run design` serves it
 * on :6006, `npm run build:design` writes a static copy to dist-design/ that
 * works from any folder (relative URLs).
 */
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./design'),
  base: './',
  publicDir: here('./public'),
  resolve: { alias: { '@gmemo/core': here('../core/src/index.ts') } },
  plugins: [react()],
  // Escape non-ASCII in bundles (some hosts reject literal U+FFFD characters).
  esbuild: { charset: 'ascii' },
  server: { port: 6006 },
  build: {
    outDir: here('./dist-design'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rollupOptions: {
      input: { index: here('./design/index.html'), preview: here('./design/preview.html') },
    },
  },
});
