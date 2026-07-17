import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  readReadyMarker
} from './runtime-paths'
import {
  BASE_PYTHON_PACKAGES,
  BASE_R_PACKAGES,
  DEFAULT_PYTHON_SPEC,
  DEFAULT_R_SPEC,
  DefaultRuntimeProvisioner,
  type FetchedBundle,
  type ProvisionProgress,
  type ProvisionerDeps
} from './provisioner'
import { envsLockDir } from './runtime-relocation'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-prov-'))

// Builds injected deps whose create "materializes" the interpreter file so verify passes.
const makeDeps = (root: string, overrides: Partial<ProvisionerDeps> = {}): ProvisionerDeps => {
  const created: string[] = []
  return {
    root,
    mm: '/mm',
    channel: 'conda-forge',
    fetchBundle: async (): Promise<FetchedBundle | undefined> => undefined,
    runArgv: async (argv: string[]): Promise<void> => {
      // argv[3] is --prefix / -p value depending on form; find the prefix and drop a bin file.
      const pIdx = argv.findIndex((a) => a === '--prefix' || a === '-p')
      const prefix = argv[pIdx + 1]
      const isPython = prefix.endsWith(DEFAULT_PY_ENV)
      const bin = isPython ? pythonBin(prefix) : rBin(prefix)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'x')
      created.push(argv[1])
    },
    verify: async (): Promise<void> => undefined,
    now: () => 't-now',
    ...overrides
  }
}

describe('DefaultRuntimeProvisioner.provisionPython', () => {
  it('materializes python, stamps the marker, and emits monotonic progress ending at 1', async () => {
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    const events: ProvisionProgress[] = []
    await provisioner.provisionPython((p) => events.push(p))

    const marker = readReadyMarker(root)
    expect(marker).toEqual({ defaultEnvVersion: DEFAULT_ENV_VERSION, preparedAt: 't-now' })
    expect(events.at(-1)).toMatchObject({ phase: 'done', progress: 1 })
    const progresses = events.map((e) => e.progress)
    for (let i = 1; i < progresses.length; i++)
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1])
    for (const e of events) expect(e.message).not.toBe('')
    const status = provisioner.status()
    expect(status.pythonReady).toBe(true)
    expect(status.version).toBe(DEFAULT_ENV_VERSION)
    expect(status.provisioning).toBe(false)
  })

  it('does not write the marker when create fails', async () => {
    const root = makeRoot()
    const deps = makeDeps(root, {
      runArgv: async () => {
        throw new Error('solve failed')
      }
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    await expect(provisioner.provisionPython(() => {})).rejects.toThrow('solve failed')
    expect(readReadyMarker(root)).toBeUndefined()
  })

  it('does not write the marker when verify fails (arm64/ad-hoc break)', async () => {
    const root = makeRoot()
    const deps = makeDeps(root, {
      verify: async () => {
        throw new Error('bad CPU type')
      }
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    await expect(provisioner.provisionPython(() => {})).rejects.toThrow('bad CPU type')
    expect(readReadyMarker(root)).toBeUndefined()
  })

  it('uses the offline lock form when fetchBundle returns a lock, else online packages', async () => {
    const root = makeRoot()
    const argvs: string[][] = []
    const lockPath = join(root, 'default-python.lock')
    const deps = makeDeps(root, {
      fetchBundle: async (): Promise<FetchedBundle> => ({ lockPath }),
      runArgv: async (argv) => {
        argvs.push(argv)
        const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })
    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})
    expect(argvs[0]).toContain('--offline')
    expect(argvs[0]).toContain(lockPath)
  })
})

describe('DefaultRuntimeProvisioner.provisionR', () => {
  it('materializes R lazily without touching the python version marker', async () => {
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    await provisioner.provisionR(() => {})
    expect(provisioner.status().rReady).toBe(true)
    // R materialization must not stamp/alter the python readiness marker.
    expect(readReadyMarker(root)).toBeUndefined()
  })
})

describe('default specs', () => {
  it('match spec §4 package sets', () => {
    expect(DEFAULT_PYTHON_SPEC).toEqual({
      name: DEFAULT_PY_ENV,
      language: 'python',
      packages: ['python=3.12', 'numpy', 'pandas', 'scipy', 'matplotlib', 'plotly', 'openpyxl']
    })
    expect(DEFAULT_R_SPEC).toEqual({
      name: DEFAULT_R_ENV,
      language: 'r',
      packages: ['r-base', 'r-jsonlite', 'r-ggplot2', 'r-dplyr', 'r-openxlsx']
    })
  })

  it('base floor (named-env) sets are minimal and distinct from the default specs', () => {
    expect(BASE_PYTHON_PACKAGES).toEqual(['python=3.12', 'matplotlib'])
    expect(BASE_R_PACKAGES).toEqual(['r-base', 'r-jsonlite'])
  })
})

// Deps whose runArgv drops the right interpreter bin under whatever --prefix argv carries, and whose
// language for the fake bin is picked by the caller (unlike makeDeps, which hardcodes on DEFAULT_PY_ENV).
const makeNamedEnvDeps = (
  root: string,
  overrides: Partial<ProvisionerDeps> = {}
): { deps: ProvisionerDeps; argvs: string[][] } => {
  const argvs: string[][] = []
  const deps: ProvisionerDeps = {
    root,
    mm: '/mm',
    channel: 'conda-forge',
    fetchBundle: async () => undefined,
    runArgv: async (argv) => {
      argvs.push(argv)
      const idx = argv.indexOf('--prefix')
      const prefix = argv[idx + 1]
      // Named envs are always Python in these tests unless the packages carry r-base.
      const isR = argv.includes('r-base')
      const bin = isR ? rBin(prefix) : pythonBin(prefix)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'x')
    },
    verify: async () => undefined,
    ...overrides
  }
  return { deps, argvs }
}

describe('DefaultRuntimeProvisioner.createNamedEnvironment', () => {
  it('builds the create argv from the base floor + user packages (deduped), targeting envs/<name>', async () => {
    const root = makeRoot()
    const { deps, argvs } = makeNamedEnvDeps(root)
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const info = await provisioner.createNamedEnvironment('my-analysis', 'python', [
      'numpy',
      'matplotlib' // duplicate of the base floor package -> must be deduped
    ])

    expect(argvs).toHaveLength(1)
    const argv = argvs[0]
    expect(argv).toContain('--prefix')
    expect(argv[argv.indexOf('--prefix') + 1]).toBe(envPrefix(root, 'my-analysis'))
    // Base floor present, user packages appended, no duplicate 'matplotlib'.
    expect(argv.filter((a) => a === 'matplotlib')).toHaveLength(1)
    expect(argv).toEqual(expect.arrayContaining(['python=3.12', 'matplotlib', 'numpy']))

    expect(info).toEqual({ name: 'my-analysis', language: 'python', ready: true, isDefault: false })
    // Named envs never touch the .env-ready marker.
    expect(readReadyMarker(root)).toBeUndefined()
  })

  it('uses the R base floor for language "r"', async () => {
    const root = makeRoot()
    const { deps, argvs } = makeNamedEnvDeps(root)
    const provisioner = new DefaultRuntimeProvisioner(deps)

    await provisioner.createNamedEnvironment('r-stats', 'r')

    expect(argvs[0]).toEqual(expect.arrayContaining(['r-base', 'r-jsonlite']))
  })
})

describe('DefaultRuntimeProvisioner.listEnvironments', () => {
  it('returns [] when the envs dir does not exist', () => {
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    expect(provisioner.listEnvironments()).toEqual([])
  })

  it('classifies python/r/default/ready and skips dirs with neither interpreter', () => {
    const root = makeRoot()
    // default-python: has a python bin -> python, isDefault.
    const pyDefaultPrefix = envPrefix(root, DEFAULT_PY_ENV)
    mkdirSync(join(pythonBin(pyDefaultPrefix), '..'), { recursive: true })
    writeFileSync(pythonBin(pyDefaultPrefix), 'x')
    // named python env.
    const namedPrefix = envPrefix(root, 'my-analysis')
    mkdirSync(join(pythonBin(namedPrefix), '..'), { recursive: true })
    writeFileSync(pythonBin(namedPrefix), 'x')
    // named r env.
    const rPrefix = envPrefix(root, 'r-stats')
    mkdirSync(join(rBin(rPrefix), '..'), { recursive: true })
    writeFileSync(rBin(rPrefix), 'x')
    // half-created dir: neither bin present -> skipped.
    mkdirSync(envPrefix(root, 'half-baked'), { recursive: true })

    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    const infos = provisioner.listEnvironments()

    expect(infos.map((i) => i.name).sort()).toEqual(['default-python', 'my-analysis', 'r-stats'])
    const byName = Object.fromEntries(infos.map((i) => [i.name, i]))
    expect(byName['default-python']).toMatchObject({
      language: 'python',
      ready: true,
      isDefault: true
    })
    expect(byName['my-analysis']).toMatchObject({
      language: 'python',
      ready: true,
      isDefault: false
    })
    expect(byName['r-stats']).toMatchObject({ language: 'r', ready: true, isDefault: false })
  })
})

describe('DefaultRuntimeProvisioner.removeEnvironment', () => {
  it('refuses to remove default-python or default-r', () => {
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    expect(() => provisioner.removeEnvironment(DEFAULT_PY_ENV)).toThrow(/Refusing to remove/)
    expect(() => provisioner.removeEnvironment(DEFAULT_R_ENV)).toThrow(/Refusing to remove/)
  })

  it('removes a named env and returns the refreshed list', () => {
    const root = makeRoot()
    const namedPrefix = envPrefix(root, 'my-analysis')
    mkdirSync(join(pythonBin(namedPrefix), '..'), { recursive: true })
    writeFileSync(pythonBin(namedPrefix), 'x')

    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    expect(provisioner.listEnvironments()).toHaveLength(1)

    const remaining = provisioner.removeEnvironment('my-analysis')

    expect(remaining).toEqual([])
    expect(existsSync(namedPrefix)).toBe(false)
  })
})

describe('DefaultRuntimeProvisioner.restoreRelocatedEnvs', () => {
  // Writes a relocation lock at <root>/envs.lock/<name>.lock with one package URL.
  const writeLock = (root: string, name: string): void => {
    const dir = envsLockDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.lock`),
      '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/noarch/x-1.conda#abc\n'
    )
  }

  it('recreates each env offline from its lock, stamps the marker, and consumes the locks', async () => {
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    writeLock(root, 'my-analysis')

    const argvs: string[][] = []
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        argvs.push(argv)
        const pIdx = argv.findIndex((a) => a === '-p' || a === '--prefix')
        const prefix = argv[pIdx + 1]
        const bin = prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    // Both recreations used the offline lock form.
    expect(argvs.every((argv) => argv.includes('--offline') && argv.includes('--file'))).toBe(true)
    expect(existsSync(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))).toBe(true)
    // default-python restored → ready marker stamped at the current version.
    expect(readReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
    // Locks are consumed one-shot so a later launch skips restore.
    expect(existsSync(envsLockDir(root))).toBe(true)
    expect(existsSync(join(envsLockDir(root), `${DEFAULT_PY_ENV}.lock`))).toBe(false)
    expect(existsSync(join(envsLockDir(root), 'my-analysis.lock'))).toBe(false)
  })

  it('restores default-python first, then default-r, then named envs', async () => {
    const root = makeRoot()
    // Write in non-priority order to prove the restore reorders rather than following readdir order.
    writeLock(root, 'my-analysis')
    writeLock(root, DEFAULT_R_ENV)
    writeLock(root, DEFAULT_PY_ENV)

    const order: string[] = []
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        order.push(basename(prefix))
        const bin = prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    expect(order).toEqual([DEFAULT_PY_ENV, DEFAULT_R_ENV, 'my-analysis'])
  })

  it('is a no-op with no relocation bundle', async () => {
    const root = makeRoot()
    const deps = makeDeps(root)
    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})
    expect(readReadyMarker(root)).toBeUndefined()
  })

  it('leaves a lock in place when its recreate fails, without stamping the marker', async () => {
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    const deps = makeDeps(root, {
      runArgv: async () => {
        throw new Error('offline create failed')
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    expect(existsSync(join(envsLockDir(root), `${DEFAULT_PY_ENV}.lock`))).toBe(true)
    expect(readReadyMarker(root)).toBeUndefined()
  })
})
