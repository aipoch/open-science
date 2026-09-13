import { resolve } from 'path'
import { nativeLocaleAssets } from './scripts/native-locale-assets'
import { defineConfig } from 'electron-vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Supported packages are built on native runners because they carry platform-native dependencies,
// so the build host is also the package target. Keep non-Windows bundles disabled independently of
// renderer visibility and the main-process runtime gate.
export const resolveWsl2BashPreviewBuildEnabled = (
  platform: NodeJS.Platform,
  rollbackValue: string | undefined
): boolean => platform === 'win32' && rollbackValue !== '0'

export default defineConfig(({ command }) => ({
  main: {
    plugins: [nativeLocaleAssets()],
    define: {
      __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__: JSON.stringify('native-locales'),
      __OPEN_SCIENCE_WSL2_BASH_PREVIEW__: resolveWsl2BashPreviewBuildEnabled(
        process.platform,
        process.env.OPEN_SCIENCE_BUILD_WSL2_BASH_PREVIEW
      )
        ? 'true'
        : 'false',
      __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__:
        command === 'serve' && process.env.OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW === '1'
          ? 'true'
          : 'false'
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
          'find-overlay': resolve('src/preload/find-overlay.ts')
        }
      }
    }
  },
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
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'office-preview': resolve('src/renderer/office-preview.html'),
          'reviewer-paged-preview': resolve('src/renderer/reviewer-paged-preview.html')
        }
      }
    }
  }
}))
