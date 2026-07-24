import { resolve } from 'path'
import { defineConfig, configDefaults } from 'vitest/config'

// Mirrors the renderer alias from electron.vite.config.ts so tests that mount real component
// trees (instead of mocking every aliased import) can resolve '@/...' without a build step.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src'),
      'e-virt-table/dist/index.es.js': resolve('test/fixtures/fake-e-virt-table.ts')
    }
  },
  test: {
    server: {
      deps: {
        inline: ['@file-viewer/renderer-spreadsheet']
      }
    },
    // Loads .env into process.env before tests run. Integration tests gated on RUN_COMPUTE_JOBS=1
    // read their target alias from COMPUTE_TEST_SSH_ALIAS. The file is gitignored; .env.example
    // documents the supported variables.
    setupFiles: ['./test/setup-dotenv.ts', './test/setup-jsdom-polyfills.ts'],
    // Keep vitest's defaults (node_modules, dist, .git, ...) and also ignore git worktrees created
    // under .claude/worktrees — those hold full source + node_modules copies that would otherwise be
    // discovered and run as duplicate (and often stale) suites during local runs.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Lift the 5s default: the full coverage run instruments 4400+ tests across parallel workers on a
    // shared CI runner, so a fast fully-mocked test can still be CPU-starved past 5s and time out
    // spuriously. 15s absorbs that contention without masking a genuine hang (real work is far slower).
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      // text for the CI log, lcov for upload/tooling, html for local inspection.
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      // Exclude non-logic files so coverage reflects testable code, not wiring/types.
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'src/**/index.ts', // process entry / IPC composition wiring
        'src/preload/**', // declarative ipcRenderer bridge
        'src/**/*types.ts',
        'src/renderer/src/main.tsx'
      ],
      // Baseline thresholds: fail CI when global coverage drops below these. Set ~5pts under the
      // current measured baseline (lines 71 / statements 70 / functions 68 / branches 62) so the gate
      // catches regressions while absorbing minor cross-environment variance. Raise over time.
      thresholds: {
        lines: 66,
        functions: 62,
        branches: 57,
        statements: 64,
        // Keep the now-covered update wiring from being masked by the global aggregate.
        'src/main/update/**': {
          lines: 85,
          functions: 75,
          branches: 70,
          statements: 80
        },
        // CSV is a user-facing renderer with bounded-data and fallback behavior worth protecting.
        'src/renderer/src/pages/workspace/previews/renderers/CsvPreview.tsx': {
          lines: 95,
          functions: 95,
          branches: 80,
          statements: 95
        }
      }
    }
  }
})
