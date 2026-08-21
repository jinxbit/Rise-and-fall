/// <reference types="vitest/config" />
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Unique per build so the client can detect a newer deploy is live (issue #247).
const buildId = Date.now().toString(36)

/** Emits version.json into the build output so running tabs can poll for a newer buildId. */
function writeVersionFile(): Plugin {
  let outDir = 'dist'
  return {
    name: 'write-version-file',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      writeFileSync(resolve(process.cwd(), outDir, 'version.json'), JSON.stringify({ buildId }))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    writeVersionFile(),
    VitePWA({
      // Custom src/sw.ts (not the default generated worker) so it can also
      // handle `push`/`notificationclick` for turn notifications — see that
      // file's doc comment for why navigations are deliberately left alone.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Only the hashed, content-addressed build output — never index.html
        // or version.json, which must always be fetched fresh (issue #247).
        globPatterns: ['assets/**/*.{js,css,woff2}'],
      },
      registerType: 'autoUpdate',
      devOptions: { enabled: false },
      manifest: {
        name: 'Rise & Fall',
        short_name: 'Rise & Fall',
        description: 'A turn-based strategy game of empires rising and falling.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
