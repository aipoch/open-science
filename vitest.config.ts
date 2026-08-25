import { availableParallelism, cpus } from 'node:os'
import { basename, dirname, resolve } from 'path'
import { defineConfig, configDefaults } from 'vitest/config'

const testRoot = resolve('.')
const sharedInstallRoot = basename(dirname(testRoot)) === '.worktree' ? resolve('../..') : testRoot

export function resolveVitestMaxWorkers(
  available = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
): number {
  return Math.max(available - 1, 1)
}

export const VITEST_ARCHITECTURE_TEST_GLOBS = ['**/*.architecture.test.ts'] as const

export const VITEST_PROCESS_TEST_GLOBS = [
  '**/*.integration.test.ts',
  '**/*.certification.test.ts',
  'src/main/notebook/kernel-executor.test.ts',
  'src/main/notebook/full-stack.smoke.test.ts',
  'src/main/local-rpc-transport.test.ts',
  'src/main/session-plan/plan-mcp-server.test.ts',
  'src/main/acp/mcp-http-host.test.ts',
  'src/main/settings/openai-provider-bridge.test.ts',
  'src/main/settings/anthropic-provider-bridge.test.ts',
  'resources/skills/literature-review/kernel.test.ts'
] as const

const VITEST_EXCLUDE_PATTERNS = [
  ...configDefaults.exclude,
  'e2e/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.pnpm-store/**',
  '**/tmp/**',
  '**/.worktrees/**',
  '**/.worktree/**'
]
const VITEST_COVERAGE_EXCLUDE_PATTERNS = [
  '**/*.test.{ts,tsx}',
  '**/*.d.ts',
  'src/**/index.ts', // process entry wiring
  'src/main/ipc.ts', // Electron IPC composition root
  'src/preload/**', // declarative ipcRenderer bridge
  'src/**/*types.ts',
  'src/renderer/src/main.tsx'
]
// Full-suite shards collect partial coverage maps. Only the merged report may enforce thresholds.

function coverageThresholdsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST_DEFER_COVERAGE_THRESHOLDS !== '1'
}

// Mirrors the renderer alias from electron.vite.config.ts so tests that mount real component
// trees (instead of mocking every aliased import) can resolve '@/...' without a build step.
export default defineConfig({
  server: {
    // Vitest may still canonicalize worker URLs through the shared install even when module
    // resolution preserves symlinks. Limit the additional allowance to this repository root.
    fs: { allow: [...new Set([testRoot, sharedInstallRoot])] }
  },
  resolve: {
    // Git worktrees reuse the repository-root dependency install through a local node_modules
    // symlink. Keep that logical path so Vite does not resolve PDF workers outside the test root and
    // reject them before the component suite can run. A normal checkout already has a local install.
    preserveSymlinks: true,
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
    setupFiles: [
      './test/setup-dotenv.ts',
      './test/setup-jsdom-polyfills.ts',
      './test/setup-i18n.ts'
    ],
    // Keep vitest's defaults (node_modules, dist, .git, ...) and also ignore git worktrees — those hold
    // full source + node_modules copies that would otherwise be discovered and run as duplicate (and
    // often stale) suites during local runs. Playwright owns e2e/; Vitest must not execute those specs
    // in its Node workers. .worktree is the project-standard root; .claude remains excluded for
    // existing local checkouts.
    exclude: VITEST_EXCLUDE_PATTERNS,
    // Lift the 5s default: the full coverage run instruments 4400+ tests across parallel workers on a
    // shared CI runner, so a fast fully-mocked test can still be CPU-starved past 5s and time out
    // spuriously. 15s absorbs that contention without masking a genuine hang (real work is far slower).
    testTimeout: 15000,
    // Schema-backed hooks can exceed Vitest's 10s default on loaded runners. Keep a safe repository
    // default while allowing slower platform workflows to raise it explicitly from the CLI.
    hookTimeout: 30000,
    // Pin the pool to Vitest's own CPU-minus-one bound so full-suite runs cannot spawn an unbounded
    // set of short-lived workers. Heavy files below run in later groups and do not share that pool.
    maxWorkers: resolveVitestMaxWorkers(),
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          exclude: [
            ...VITEST_EXCLUDE_PATTERNS,
            ...VITEST_ARCHITECTURE_TEST_GLOBS,
            ...VITEST_PROCESS_TEST_GLOBS
          ]
        }
      },
      {
        extends: true,
        test: {
          name: 'architecture',
          include: [...VITEST_ARCHITECTURE_TEST_GLOBS],
          exclude: [...VITEST_EXCLUDE_PATTERNS],
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 }
        }
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: [...VITEST_PROCESS_TEST_GLOBS],
          exclude: [...VITEST_EXCLUDE_PATTERNS],
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1
        }
      }
    ],
    coverage: {
      provider: 'v8',
      // text for the CI log, lcov for upload/tooling, html for local inspection.
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      // Exclude non-logic files so coverage reflects testable code, not wiring/types.
      exclude: VITEST_COVERAGE_EXCLUDE_PATTERNS,
      // Baseline thresholds: fail CI when global coverage drops below these. Set ~5pts under the
      // current measured baseline (lines 71 / statements 70 / functions 68 / branches 62) so the gate
      // catches regressions while absorbing minor cross-environment variance. Raise over time.
      thresholds: coverageThresholdsEnabled(process.env)
        ? {
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
        : undefined
    }
  }
})

export { coverageThresholdsEnabled, VITEST_COVERAGE_EXCLUDE_PATTERNS, VITEST_EXCLUDE_PATTERNS }
