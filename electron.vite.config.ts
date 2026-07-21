import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // Regenerate lazy optimized chunks so a persisted Electron page cannot request stale hashes.
    optimizeDeps: { force: true },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      // Don't watch git worktrees under .claude/worktrees — full source copies would trigger
      // needless rescans/HMR churn during dev.
      watch: { ignored: ['**/.claude/**'] }
    },
    plugins: [
      // Apply upstream CJS interop for the spreadsheet Worker without injecting renderer presets.
      fileViewerRenderers({
        formats: ['xls', 'xlsx'],
        inject: false,
        chunkStrategy: 'none'
      }),
      react(),
      tailwindcss()
    ]
  }
})
