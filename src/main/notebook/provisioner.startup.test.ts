import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/repository'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  writeReadyMarker
} from './runtime-paths'
import {
  createProductionProvisioner,
  planStartupAction,
  type ProductionProvisionerDeps
} from './provisioner'
import { selectMicromambaCache } from './micromamba-cache'
import { notebookWorkloadCacheRoot } from './notebook-workload-cache-paths'
import type { NotebookProcessSandbox } from './process-sandbox'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-start-'))
const touchBin = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

describe('planStartupAction', () => {
  it('is fresh on an empty root', () => {
    expect(planStartupAction(makeRoot(), DEFAULT_ENV_VERSION)).toBe('fresh')
  })

  it('is ready when python is provisioned at the expected version', () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't')
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('ready')
  })

  it('is upgrade when outdated but the python bin is healthy (additive path)', () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't')
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('upgrade')
  })

  it('is repair when a marker exists but the python bin is missing (corrupt)', () => {
    const root = makeRoot()
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't') // marker but no bin
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('repair')
  })

  it('is repair when an env dir exists without a marker', () => {
    const root = makeRoot()
    mkdirSync(envPrefix(root, DEFAULT_R_ENV), { recursive: true })
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('repair')
  })
})

describe('createProductionProvisioner', () => {
  const micromambaBinName = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'

  it('builds a RuntimeProvisioner when micromamba resolves via the OPEN_SCIENCE_MICROMAMBA_BIN override', () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', micromambaBinName)
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath } }
    })

    expect(typeof provisioner.status).toBe('function')
    expect(typeof provisioner.provisionPython).toBe('function')
    expect(typeof provisioner.provisionR).toBe('function')
    expect(typeof provisioner.upgradeIfNeeded).toBe('function')
    expect(typeof provisioner.repair).toBe('function')
  })

  it('derives home from root (dev/prod resolved by the caller) when no explicit home is given', () => {
    // root = <home>/<PROD_SESSION_DIR_NAME>/runtime, matching resolveMicromamba's storage-root branch;
    // the factory must derive `home` back out of `root` without any env/PATH help.
    const home = mkdtempSync(join(tmpdir(), 'os-home-'))
    const root = join(home, PROD_SESSION_DIR_NAME, 'runtime')
    mkdirSync(root, { recursive: true })
    const mmPath = join(
      home,
      PROD_SESSION_DIR_NAME,
      'runtime',
      'micromamba',
      'bin',
      micromambaBinName
    )
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      // Isolate from the real machine's env/PATH/resourcesPath so only the derived home can resolve it.
      micromamba: { env: {} }
    })

    expect(typeof provisioner.status).toBe('function')
  })

  it('lets an explicit opts.micromamba.home override the derived one', () => {
    const wrongRootHome = mkdtempSync(join(tmpdir(), 'os-wronghome-'))
    const root = join(wrongRootHome, PROD_SESSION_DIR_NAME, 'runtime') // derived home won't have a bin
    mkdirSync(root, { recursive: true })

    const realHome = mkdtempSync(join(tmpdir(), 'os-realhome-'))
    const mmPath = join(
      realHome,
      PROD_SESSION_DIR_NAME,
      'runtime',
      'micromamba',
      'bin',
      micromambaBinName
    )
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      micromamba: { env: {}, home: realHome }
    })

    expect(typeof provisioner.status).toBe('function')
  })

  it('throws a clear error when micromamba cannot be resolved anywhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'os-empty-home-'))
    const root = join(home, PROD_SESSION_DIR_NAME, 'runtime')
    mkdirSync(root, { recursive: true })

    expect(() =>
      createProductionProvisioner({
        root,
        channel: 'conda-forge',
        micromamba: { env: {} } // no override, no bundled bin here, no PATH
      })
    ).toThrow(/micromamba binary not found/)
  })

  it('preflights the Windows runner before fetching a runtime bundle', async () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', 'micromamba.exe')
    touchBin(mmPath)
    const events: string[] = []
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        cdnBase: 'https://runtime.invalid',
        micromamba: {
          env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath, LOCALAPPDATA: join(root, 'local') },
          platform: 'win32',
          preflight: async () => {
            events.push('preflight')
          }
        }
      },
      {
        maintainCache: async () => undefined,
        fetchBundle: async () => {
          events.push('fetch')
          throw new Error('stop after observing fetch')
        }
      }
    )

    await expect(provisioner.provisionPython(() => undefined)).rejects.toThrow(
      /stop after observing fetch/
    )
    expect(events).toEqual(['preflight', 'fetch'])
  })

  it('does not fetch a runtime bundle when every Windows runner fails preflight', async () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', 'micromamba.exe')
    touchBin(mmPath)
    const fetch = vi.fn(async () => {
      throw new Error('bundle fetched before runner preflight')
    })
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        cdnBase: 'https://runtime.invalid',
        micromamba: {
          env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath, LOCALAPPDATA: join(root, 'local') },
          platform: 'win32',
          preflight: async () => {
            throw new Error('runner preflight failed')
          }
        }
      },
      {
        fetchBundle: fetch
      }
    )

    await expect(provisioner.provisionPython(() => undefined)).rejects.toThrow(
      /runner preflight failed/
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the runner selected during preparation for the micromamba subprocess', async () => {
    const root = makeRoot()
    const primary = join(root, 'bin', 'micromamba.exe')
    const compatibility = join(root, 'bin', 'micromamba-compat.exe')
    const lockPath = join(root, 'python.lock')
    touchBin(primary)
    touchBin(compatibility)
    writeFileSync(lockPath, '@EXPLICIT\n')
    const runArgv = vi.fn<NonNullable<ProductionProvisionerDeps['runArgv']>>(async () => undefined)
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: primary } }
      },
      {
        runner: { initialPath: primary, resolve: async () => compatibility },
        fetchBundle: async () => ({ lockPath }),
        maintainCache: async () => undefined,
        runArgv,
        verify: async () => undefined
      }
    )

    await provisioner.provisionPython(() => undefined)

    expect(runArgv).toHaveBeenCalledOnce()
    expect(runArgv.mock.calls[0]?.[0]?.[0]).toBe(compatibility)
  })

  it('resolves the package channel only when a named environment needs online solving', async () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', micromambaBinName)
    touchBin(mmPath)
    const resolveChannel = vi.fn(async () => 'https://fast-mirror.invalid/conda-forge')
    const runArgv = vi.fn<NonNullable<ProductionProvisionerDeps['runArgv']>>(async () => undefined)
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: resolveChannel,
        micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath } }
      },
      {
        runner: { initialPath: mmPath, resolve: async () => mmPath },
        maintainCache: async () => undefined,
        runArgv,
        verify: async () => undefined
      }
    )

    expect(resolveChannel).not.toHaveBeenCalled()

    await provisioner.createNamedEnvironment('analysis', 'python')

    expect(resolveChannel).toHaveBeenCalledOnce()
    expect(runArgv.mock.calls[0]?.[0]).toContain('https://fast-mirror.invalid/conda-forge')
  })

  it('routes a contextual named environment create through the Notebook process sandbox', async () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', micromambaBinName)
    touchBin(mmPath)
    const cleanup = vi.fn()
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async () => ({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { PATH: process.env.PATH },
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        processSandbox,
        micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath } }
      },
      {
        runner: { initialPath: mmPath, resolve: async () => mmPath },
        maintainCache: async () => undefined,
        verify: async () => undefined,
        captureExplicitLock: async () => '@EXPLICIT\n'
      }
    )

    await provisioner.createNamedEnvironment('analysis', 'python', ['numpy'], {
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: root
    })

    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'python',
        cwd: root
      })
    )
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('binds the default cache-maintenance adapter to the selected app cache', async () => {
    const root = makeRoot()
    const primary = join(root, 'bin', micromambaBinName)
    const compatibility = join(root, 'bin', `compat-${micromambaBinName}`)
    touchBin(primary)
    touchBin(compatibility)
    const runCacheMaintenance = vi.fn<
      NonNullable<ProductionProvisionerDeps['runCacheMaintenance']>
    >(async () => undefined)
    const runArgv = vi.fn<NonNullable<ProductionProvisionerDeps['runArgv']>>(async () => undefined)
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: primary } }
      },
      {
        runner: { initialPath: primary, resolve: async () => compatibility },
        fetchBundle: async () => ({ lockPath: join(root, 'python.lock') }),
        runCacheMaintenance,
        runArgv,
        verify: async () => undefined
      }
    )

    await provisioner.provisionPython(() => undefined)

    expect(runCacheMaintenance).toHaveBeenCalled()
    const selectedCacheCall = runCacheMaintenance.mock.calls.find(
      ([, env]) => env?.CONDA_PKGS_DIRS === selectMicromambaCache(root).path
    )
    expect(selectedCacheCall?.[0]).toEqual([
      compatibility,
      '--no-rc',
      'clean',
      '--packages',
      '--yes'
    ])
    expect(selectedCacheCall?.[1]).toMatchObject({
      MAMBA_ROOT_PREFIX: root,
      CONDA_PKGS_DIRS: selectMicromambaCache(root).path
    })
    for (const call of runCacheMaintenance.mock.calls) {
      expect(call[2]).toBeInstanceOf(AbortSignal)
      expect(call[3]).toEqual(expect.any(Function))
      expect(call[4]).toEqual(expect.any(Function))
    }
  })

  it('projects the workload cache environment into the default provisioning subprocess', async () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', micromambaBinName)
    const lockPath = join(root, 'python.lock')
    touchBin(mmPath)
    writeFileSync(lockPath, '@EXPLICIT\n')
    const spawnMicromamba = vi.fn<NonNullable<ProductionProvisionerDeps['runMicromamba']>>(
      async (argv, _env, _signal, _onChild, onBeforeSpawn) => {
        onBeforeSpawn?.()
        const prefix = argv[argv.findIndex((arg) => arg === '-p' || arg === '--prefix') + 1]
        touchBin(pythonBin(prefix))
      }
    )
    const provisioner = createProductionProvisioner(
      {
        root,
        channel: 'conda-forge',
        micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath } }
      },
      {
        runner: { initialPath: mmPath, resolve: async () => mmPath },
        fetchBundle: async () => ({ lockPath }),
        maintainCache: async () => undefined,
        runMicromamba: spawnMicromamba,
        verify: async () => undefined,
        retainWorkingCache: async () => async () => true,
        captureExplicitLock: async () => '@EXPLICIT\n'
      }
    )

    await provisioner.provisionPython(() => undefined)

    const cacheRoot = notebookWorkloadCacheRoot(root)
    expect(spawnMicromamba).toHaveBeenCalledOnce()
    expect(spawnMicromamba.mock.calls[0]?.[1]).toMatchObject({
      PIP_CACHE_DIR: join(cacheRoot, 'pip'),
      UV_CACHE_DIR: join(cacheRoot, 'uv'),
      HF_DATASETS_CACHE: join(cacheRoot, 'huggingface', 'datasets'),
      TORCH_HOME: join(cacheRoot, 'torch')
    })
  })
})
