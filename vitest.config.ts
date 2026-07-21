import { resolve } from 'path'
import { defineConfig, configDefaults } from 'vitest/config'

// Mirrors the renderer alias from electron.vite.config.ts so tests that mount real component
// trees (instead of mocking every aliased import) can resolve '@/...' without a build step.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    // Loads .env into process.env before tests run. Integration tests gated on RUN_COMPUTE_JOBS=1
    // read their target alias from COMPUTE_TEST_SSH_ALIAS. The file is gitignored; .env.example
    // documents the supported variables.
    setupFiles: ['./test/setup-dotenv.ts'],
    // Keep vitest's defaults (node_modules, dist, .git, ...) and also ignore git worktrees created
    // under .claude/worktrees — those hold full source + node_modules copies that would otherwise be
    // discovered and run as duplicate (and often stale) suites during local runs.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
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
        statements: 64
      }
    }
  }
})
