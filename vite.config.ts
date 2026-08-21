/// <reference types="vitest/config" />
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
  plugins: [react(), tailwindcss(), writeVersionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
