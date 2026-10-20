import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PY_ENV,
  envPrefix,
  pkgsCache,
  pythonBin,
  rBin,
  rScriptBin,
  rLibraryDir
} from '@aipoch/environment'
import {
  DefaultRuntimeProvisioner,
  type FetchedBundle,
  type ProvisionerDeps
} from '@aipoch/environment'
import { createProductionProvisioner } from './environment-production'

import { serializeProvisioner } from '@aipoch/environment'
import { EnvironmentLeaseManager } from '@aipoch/environment'
import { createNotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'

import { micromambaCacheLockKey } from '@aipoch/environment'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-prov-'))
const TEST_WINDOWS_PATH_BUDGET = { maxCacheRelativePath: 1, maxEnvRelativePath: 1 } as const

// Builds injected deps whose create "materializes" the interpreter file so verify passes.
const makeDeps = (root: string, overrides: Partial<ProvisionerDeps> = {}): ProvisionerDeps => {
  const created: string[] = []
  return {
    root,
    mm: '/mm',
    channel: 'conda-forge',
    fetchBundle: async (spec): Promise<FetchedBundle> => ({
      lockPath: join(root, `${spec.name}.lock`),
      pathBudget: TEST_WINDOWS_PATH_BUDGET
    }),
    runArgv: async (argv: string[]): Promise<void> => {
      // argv[3] is --prefix / -p value depending on form; find the prefix and drop a bin file.
      const pIdx = argv.findIndex((a) => a === '--prefix' || a === '-p')
      const prefix = argv[pIdx + 1]
      const platform = overrides.platform ?? process.platform
      const isPython = prefix === envPrefix(root, DEFAULT_PY_ENV, platform)
      const bin = isPython ? pythonBin(prefix, platform) : rBin(prefix, platform)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'x')
      if (!isPython && platform === 'win32') writeFileSync(rScriptBin(prefix, platform), 'x')
      created.push(argv[1])
    },
    maintainCache: async () => undefined,
    cache: {
      path: pkgsCache(root),
      lockKey: micromambaCacheLockKey(pkgsCache(root))
    },
    verify: async (): Promise<void> => undefined,
    now: () => 't-now',
    ...overrides
  }
}

describe('DefaultRuntimeProvisioner.createNamedEnvironment', () => {
  it.skipIf(process.platform === 'win32')(
    'verifies a managed R environment with app-owned user state and only its prefix library',
    async () => {
      const root = makeRoot()
      const prefix = envPrefix(root, 'r-stats')
      const bin = rBin(prefix)
      const expectedHome = join(root, 'home')
      const expectedLibrary = rLibraryDir(prefix)
      const inheritedKeys = ['HOME', 'R_USER', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE'] as const
      const inherited = Object.fromEntries(inheritedKeys.map((key) => [key, process.env[key]]))
      process.env.HOME = join(root, 'host-home')
      process.env.R_USER = join(root, 'host-r-user')
      process.env.R_LIBS = join(root, 'host-r-libs')
      process.env.R_LIBS_USER = join(root, 'host-r-user-library')
      process.env.R_LIBS_SITE = join(root, 'host-r-site-library')
      const provisioner = createProductionProvisioner(
        { root, channel: 'https://conda.example/conda-forge' },
        {
          runner: { initialPath: '/fake/micromamba', resolve: async () => '/fake/micromamba' },
          maintainCache: async () => undefined,
          captureExplicitLock: async () => '@EXPLICIT\n',
          runArgv: async () => {
            mkdirSync(expectedLibrary, { recursive: true })
            mkdirSync(dirname(bin), { recursive: true })
            writeFileSync(
              bin,
              [
                `#!${process.execPath}`,
                `if (process.env.HOME !== ${JSON.stringify(expectedHome)}) process.exit(41)`,
                `if (process.env.R_USER !== ${JSON.stringify(expectedHome)}) process.exit(42)`,
                `if (process.env.R_LIBS_USER !== ${JSON.stringify(expectedLibrary)}) process.exit(43)`,
                'if (process.env.R_LIBS || process.env.R_LIBS_SITE) process.exit(44)',
                `const prefix = ${JSON.stringify(prefix)}`,
                "process.stdout.write(['OPEN_SCIENCE_R_HOME=' + prefix + '/lib/R', 'OPEN_SCIENCE_R_BASE_LIBRARY=' + prefix + '/lib/R/library', 'OPEN_SCIENCE_R_LIBRARY=' + process.env.R_LIBS_USER].join('\\n') + '\\n')"
              ].join('\n') + '\n'
            )
            chmodSync(bin, 0o755)
          }
        }
      )

      try {
        await expect(provisioner.createNamedEnvironment('r-stats', 'r')).resolves.toMatchObject({
          name: 'r-stats',
          language: 'r',
          ready: true
        })
      } finally {
        for (const key of inheritedKeys) {
          const value = inherited[key]
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  )
})

// The startup gate calls repair/upgrade/restore through the provisioner, so the block guarantee has to
// live in the provisioner itself (ipc.ts injects isPrefixBlocked ← service.isPrefixRecoveryBlocked).
// These prove a recovery-blocked prefix refuses every prefix-WRITE path — the coverage the UI-only
// assertProvisionAllowed mock never exercised.
describe('DefaultRuntimeProvisioner prefix-block self-guard (startup gate path)', () => {
  it('cancels an unprepared repair waiting for a package mutation lease through the host lifecycle', async () => {
    const root = makeRoot()
    const interpreter = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
    mkdirSync(dirname(interpreter), { recursive: true })
    writeFileSync(interpreter, 'original')
    const leases = new EnvironmentLeaseManager()
    const mutation = await leases.acquire(DEFAULT_PY_ENV, 'exclusive').granted
    let waiting!: () => void
    const queued = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const deps = makeDeps(root)
    const rebuild = vi.fn(deps.runArgv)
    const onVerified = vi.fn()
    const provisioner = serializeProvisioner(
      new DefaultRuntimeProvisioner({
        ...deps,
        runArgv: rebuild,
        withPrefixLock: async (environment, operation) => {
          const acquisition = leases.acquire(environment, 'exclusive')
          waiting()
          const lease = await acquisition.granted
          try {
            return await operation()
          } finally {
            lease.release()
          }
        }
      })
    )
    const lifecycle = createNotebookEnvironmentLifecycle({
      provisioner,
      root,
      projectProgress: () => undefined,
      onRepairCompleted: onVerified
    })
    const result = lifecycle.repair('python', DEFAULT_PY_ENV).catch((error) => error)
    try {
      await queued
      expect(leases.snapshot().environments[0].waiters.exclusive).toBe(1)
      provisioner.cancel('python')
      mutation.release()

      expect.soft(await result).toEqual(new Error('Runtime setup cancelled.'))
      expect.soft(readFileSync(interpreter, 'utf8')).toBe('original')
      expect.soft(rebuild).not.toHaveBeenCalled()
      expect.soft(onVerified).not.toHaveBeenCalled()
    } finally {
      mutation.release()
      leases.dispose()
      await result
    }
  })
})

configureTestRuntimeMetadata()
