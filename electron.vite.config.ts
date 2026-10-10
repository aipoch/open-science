import { createRequire } from 'node:module'
import { resolve } from 'path'
import { nativeLocaleAssets } from './scripts/native-locale-assets'
import { defineConfig } from 'electron-vite'
import { normalizePath } from 'vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { wsl2BuildDefines } from './scripts/wsl2-build-flags.mjs'

// Supported packages are built on native runners because they carry platform-native dependencies,
// so the build host is also the package target. Keep non-Windows bundles disabled independently of
// renderer visibility and the main-process runtime gate.
export { resolveWsl2BashPreviewBuildEnabled } from './scripts/wsl2-build-flags.mjs'

export default defineConfig(({ command }) => ({
  main: {
    plugins: [nativeLocaleAssets()],
    define: {
      __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__: JSON.stringify('native-locales'),
      ...wsl2BuildDefines(process.platform, command === 'serve', process.env)
    },
    build: {
      // This workspace package is TypeScript source, not a separately built runtime dependency.
      // Bundle it into the Electron main process so development and packaged builds never ask
      // Electron's CommonJS loader to resolve the package directly.
      externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'find-overlay': resolve('src/preload/find-overlay.ts'),
          'installation-assistant': resolve('src/preload/installation-assistant.ts')
        }
      }
    }
  },
  renderer: {
    // Dev scanning must reach lazy Workers before their first use triggers a dependency reload.
    // This prepares dependencies without executing Workers or changing production build entries.
    optimizeDeps:
      command === 'serve'
        ? {
            // Regenerate lazy chunks so a persisted Electron page cannot request stale hashes.
            force: true,
            entries: [
              '*.html',
              'src/**/*.worker.ts',
              'src/**/*-worker.ts',
              normalizePath(
                createRequire(import.meta.url).resolve(
                  '@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker'
                )
              )
            ]
          }
        : undefined,
    // Spreadsheet parsing now splits Worker modules; Vite's default IIFE format cannot emit chunks.
    worker: { format: 'es' },
    resolve: {
      alias: {
        // The decoder's browser entry requires document; its default/worker entry is DOM-free.
        'decode-named-character-reference': createRequire(import.meta.url).resolve(
          'decode-named-character-reference'
        ),
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      // Electron-vite uses the resolved server host in ELECTRON_RENDERER_URL. Explicit IPv4
      // avoids localhost resolving to ::1 in restricted environments where IPv6 loopback cannot
      // bind, which otherwise leaves the isolated dev window without a renderer page.
      host: '127.0.0.1',
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
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'installation-assistant': resolve('src/renderer/installation-assistant.html'),
          'office-preview': resolve('src/renderer/office-preview.html'),
          'reviewer-paged-preview': resolve('src/renderer/reviewer-paged-preview.html')
        }
      }
    }
  }
}))
