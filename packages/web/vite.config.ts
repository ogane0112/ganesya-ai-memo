import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const core = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const backend = process.env['GMEMO_DEV_BACKEND'] ?? 'http://localhost:8787';

export default defineConfig({
  resolve: { alias: { '@gmemo/core': core } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Ganesya AI Memo',
        short_name: 'AI Memo',
        description: '人とAIが一緒に書く、自分のノートのGitHub',
        lang: 'ja',
        dir: 'ltr',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        categories: ['productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          { name: '書く', short_name: '書く', url: '/?source=shortcut' },
          { name: '検索', short_name: '検索', url: '/search' },
          { name: 'レビュー', short_name: 'レビュー', url: '/review' },
        ],
        share_target: {
          action: '/capture',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/mcp/,
          /^\/\.well-known\//,
          /^\/oauth\/(authorize|token|register|revoke)/,
        ],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              url.origin === self.location.origin &&
              (url.pathname === '/api/note' || url.pathname === '/api/notes'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'gmemo-notes',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              url.origin === self.location.origin &&
              url.pathname === '/api/file',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'gmemo-files',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/oauth/authorize': { target: backend, changeOrigin: false },
      '/oauth/token': { target: backend, changeOrigin: false },
      '/oauth/register': { target: backend, changeOrigin: false },
      '/oauth/revoke': { target: backend, changeOrigin: false },
      '/mcp': { target: backend, changeOrigin: false },
      '/.well-known': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](@codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/.test(id))
            return 'codemirror';
          if (
            /[\\/](react|react-dom|react-router|react-router-dom|scheduler|cookie|set-cookie-parser)[\\/]/.test(
              id,
            )
          )
            return 'react';
          if (/[\\/](marked|dompurify|yaml)[\\/]/.test(id)) return 'markdown';
          return 'vendor';
        },
      },
    },
  },
});
