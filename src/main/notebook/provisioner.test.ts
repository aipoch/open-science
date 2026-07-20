import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pkgsCache,
  pythonBin,
  rBin,
  readRReadyMarker,
  readReadyMarker
} from './runtime-paths'
import {
  BASE_PYTHON_PACKAGES,
  BASE_R_PACKAGES,
  DEFAULT_MANAGED_VERSION,
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
    fetchBundle: async (spec): Promise<FetchedBundle> => ({
      lockPath: join(root, `${spec.name}.lock`)
    }),
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

  it('uses the offline lock form returned by fetchBundle', async () => {
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

  it('cancel() aborts an in-flight create via the signal threaded into runArgv', async () => {
    const root = makeRoot()
    let seenSignal: AbortSignal | undefined
    // runArgv resolves/rejects based on the injected signal, mimicking execFile's abort behavior.
    const deps = makeDeps(root, {
      runArgv: (_argv, signal) =>
        new Promise<void>((_resolve, reject) => {
          seenSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('Runtime setup cancelled.')))
        })
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    const run = provisioner.provisionPython(() => {})
    // Wait until provisionPython (after fetchBundle) reaches the create call and wires the signal.
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    provisioner.cancel()
    await expect(run).rejects.toThrow(/cancelled/i)
  })

  it('removes an invalid partial env and rebuilds it from the verified bundle on retry', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'partial')
    writeFileSync(join(prefix, 'stale-file'), 'stale')
    let verifyCalls = 0
    const fetchBundle = vi.fn(async (): Promise<FetchedBundle> => ({
      lockPath: join(root, 'python-3.12.lock')
    }))
    const runArgv = vi.fn(async () => {
      expect(existsSync(join(prefix, 'stale-file'))).toBe(false)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'rebuilt')
    })
    const deps = makeDeps(root, {
      fetchBundle,
      runArgv,
      verify: async () => {
        verifyCalls += 1
        if (verifyCalls === 1) throw new Error('partial environment')
      }
    })

    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})

    expect(fetchBundle).toHaveBeenCalledOnce()
    expect(runArgv).toHaveBeenCalledOnce()
    expect(readReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
  })

  it('wipes the pkgs cache and re-seeds on a corrupt-cache create failure, then succeeds', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    // Seed a corrupt-looking pkgs cache (as a prior interrupted extract would leave behind).
    mkdirSync(join(pkgsCache(root), 'leftover-pkg'), { recursive: true })
    writeFileSync(join(pkgsCache(root), 'leftover-pkg', 'partial'), 'x')

    let creates = 0
    const fetchBundle = vi.fn(async (): Promise<FetchedBundle> => ({
      lockPath: join(root, 'python-3.12.lock')
    }))
    const runArgv = vi.fn(async () => {
      creates += 1
      // First create fails with micromamba's corrupt-cache signature; the retry (after the cache wipe)
      // sees a clean pkgs cache and materializes the interpreter.
      if (creates === 1) {
        throw new Error(
          'Found incorrect downloads. Aborting (remove_all: The directory is not empty.)'
        )
      }
      expect(existsSync(join(pkgsCache(root), 'leftover-pkg'))).toBe(false) // incomplete extract removed
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'ok')
    })
    const deps = makeDeps(root, { fetchBundle, runArgv })

    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})

    expect(creates).toBe(2)
    expect(fetchBundle).toHaveBeenCalledTimes(2) // re-seeded after the repair
    expect(existsSync(bin)).toBe(true)
    expect(readReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
  })

  it('repairs surgically: keeps complete packages + tarballs, removes only the incomplete extract', async () => {
    const root = makeRoot()
    const cache = pkgsCache(root)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    // A COMPLETE extracted package (has info/index.json) — another env depends on it; must survive.
    mkdirSync(join(cache, 'good-pkg', 'info'), { recursive: true })
    writeFileSync(join(cache, 'good-pkg', 'info', 'index.json'), '{}')
    // A downloaded TARBALL — offline-rebuild material for other envs; must survive.
    writeFileSync(join(cache, 'numpy-1.26.conda'), 'tarball')
    // An INCOMPLETE extraction (no info/index.json) — the corrupt one; must be removed.
    mkdirSync(join(cache, 'bad-pkg'), { recursive: true })
    writeFileSync(join(cache, 'bad-pkg', 'partial'), 'x')

    let creates = 0
    const runArgv = vi.fn(async () => {
      creates += 1
      if (creates === 1) throw new Error('error when extracting package (remove_all: not empty)')
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'ok')
    })
    const deps = makeDeps(root, {
      fetchBundle: vi.fn(async (): Promise<FetchedBundle> => ({ lockPath: join(root, 'p.lock') })),
      runArgv
    })

    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})

    expect(creates).toBe(2)
    expect(existsSync(join(cache, 'bad-pkg'))).toBe(false) // incomplete extract removed
    expect(existsSync(join(cache, 'good-pkg', 'info', 'index.json'))).toBe(true) // complete kept
    expect(existsSync(join(cache, 'numpy-1.26.conda'))).toBe(true) // tarball kept
  })

  it('does not repair or retry on a non-cache create error (surfaces it once)', async () => {
    const root = makeRoot()
    const fetchBundle = vi.fn(async (): Promise<FetchedBundle> => ({
      lockPath: join(root, 'p.lock')
    }))
    const runArgv = vi.fn(async () => {
      throw new Error('CondaHTTPError: connection failed') // not a corrupt-cache signature
    })
    const deps = makeDeps(root, { fetchBundle, runArgv })

    await expect(new DefaultRuntimeProvisioner(deps).provisionPython(() => {})).rejects.toThrow(
      /connection failed/
    )
    expect(runArgv).toHaveBeenCalledOnce() // no retry
    expect(fetchBundle).toHaveBeenCalledOnce() // no re-seed
  })

  it('does not retry a corrupt-cache error once the provision was cancelled', async () => {
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, {
        fetchBundle: vi.fn(async (): Promise<FetchedBundle> => ({
          lockPath: join(root, 'p.lock')
        })),
        runArgv: vi.fn(async function firstCreate() {
          // Simulate the user cancelling right as the create fails with a cache signature: the abort
          // flag is set, so recovery must NOT kick in.
          provisioner.cancel()
          throw new Error('error when extracting package (remove_all: not empty)')
        })
      })
    )

    await expect(provisioner.provisionPython(() => {})).rejects.toThrow(/extracting package/)
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

  it('clears a non-conda leftover prefix so create does not abort on it (Windows Retry)', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_R_ENV)
    // An interrupted prior create leaves the prefix dir WITHOUT conda-meta and WITHOUT an interpreter.
    mkdirSync(prefix, { recursive: true })
    writeFileSync(join(prefix, 'leftover'), 'partial')
    const deps = makeDeps(root, {
      // Mimic micromamba: abort if the prefix exists and is not a conda env (no conda-meta).
      runArgv: async (argv) => {
        const pIdx = argv.findIndex((a) => a === '--prefix' || a === '-p')
        const p = argv[pIdx + 1]
        if (existsSync(p) && !existsSync(join(p, 'conda-meta'))) {
          throw new Error('Non-conda folder exists at prefix - aborting')
        }
        const bin = rBin(p)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })
    await new DefaultRuntimeProvisioner(deps).provisionR(() => {})
    // The leftover was removed before create, so the rebuild succeeded.
    expect(existsSync(join(prefix, 'leftover'))).toBe(false)
    expect(existsSync(rBin(prefix))).toBe(true)
  })

  it('rebuilds an unmarked partial R prefix instead of upgrading it in place', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_R_ENV)
    const bin = rBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'partial')
    writeFileSync(join(prefix, 'stale-file'), 'stale')
    let verifyCalls = 0
    const argvs: string[][] = []
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        argvs.push(argv)
        expect(existsSync(join(prefix, 'stale-file'))).toBe(false)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'rebuilt')
      },
      verify: async () => {
        verifyCalls += 1
        if (verifyCalls === 1) throw new Error('partial R')
      }
    })

    await new DefaultRuntimeProvisioner(deps).provisionR(() => {})

    expect(argvs).toHaveLength(1)
    expect(argvs[0][1]).toBe('create')
    expect(readRReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
  })
})

describe('default specs', () => {
  it('are the MINIMAL protocol floor, pinned to the default managed version (extras install on demand)', () => {
    // The default managed envs are no longer a full scientific stack — just the interpreter + the
    // kernel-protocol floor, matching the curated language packs. numpy/pandas/ggplot2/… install on
    // demand via manage_packages. Pinned to DEFAULT_MANAGED_VERSION for reproducibility.
    expect(DEFAULT_PYTHON_SPEC).toEqual({
      name: DEFAULT_PY_ENV,
      language: 'python',
      version: '3.12',
      packages: ['python=3.12', 'matplotlib-base', 'nomkl']
    })
    expect(DEFAULT_R_SPEC).toEqual({
      name: DEFAULT_R_ENV,
      language: 'r',
      version: '4.4',
      packages: ['r-base=4.4', 'r-jsonlite']
    })
    expect(DEFAULT_MANAGED_VERSION).toEqual({ python: '3.12', r: '4.4' })
    // version drives the packId-keyed offline lock the local bundle adapter looks up.
    expect(DEFAULT_PYTHON_SPEC.version).toBe(DEFAULT_MANAGED_VERSION.python)
    expect(DEFAULT_R_SPEC.version).toBe(DEFAULT_MANAGED_VERSION.r)
  })

  it('the named-env base floor constants stay lean', () => {
    expect(BASE_PYTHON_PACKAGES).toEqual(['python=3.12', 'matplotlib-base', 'nomkl'])
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
      'matplotlib-base' // duplicate of the base floor package -> must be deduped
    ])

    expect(argvs).toHaveLength(1)
    const argv = argvs[0]
    expect(argv).toContain('--prefix')
    expect(argv[argv.indexOf('--prefix') + 1]).toBe(envPrefix(root, 'my-analysis'))
    // Base floor present, user packages appended, no duplicate 'matplotlib-base'.
    expect(argv.filter((a) => a === 'matplotlib-base')).toHaveLength(1)
    expect(argv).toEqual(
      expect.arrayContaining(['python=3.12', 'matplotlib-base', 'nomkl', 'numpy'])
    )

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
    expect(readRReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
  })

  it('removes and rebuilds an invalid partial prefix before consuming its relocation lock', async () => {
    const root = makeRoot()
    writeLock(root, DEFAULT_R_ENV)
    const staleBin = rBin(envPrefix(root, DEFAULT_R_ENV))
    mkdirSync(join(staleBin, '..'), { recursive: true })
    writeFileSync(staleBin, 'stale')
    let verifyCalls = 0
    const argvs: string[][] = []
    const deps = makeDeps(root, {
      verify: async () => {
        verifyCalls += 1
        if (verifyCalls === 1) throw new Error('partial env')
      },
      runArgv: async (argv) => {
        argvs.push(argv)
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        const bin = rBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'rebuilt')
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    expect(argvs).toHaveLength(1)
    expect(readRReadyMarker(root)?.defaultEnvVersion).toBe(DEFAULT_ENV_VERSION)
    expect(existsSync(join(envsLockDir(root), `${DEFAULT_R_ENV}.lock`))).toBe(false)
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
