import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
  readReadyMarker,
  readyMarkerPath,
  writeReadyMarker
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
import { CHILD_UNCONFIRMED } from './provisioner-runtime'
import { envsLockDir } from './runtime-relocation'
import { serializeProvisioner } from './env-ipc'
import { withExclusiveCacheLock, withSharedCacheLock } from './pkgs-cache-lock'
import { micromambaCacheLockKey, selectMicromambaCache } from './micromamba-cache'
import {
  operationJournalPath,
  recordOperationChildSync,
  recordSpawnIntentSync,
  RuntimeOperationJournal,
  type RuntimeOperationRecord
} from './operation-journal'

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

  it('advances create-phase progress while micromamba extracts (no stall at the floor)', async () => {
    // The create/extract phase reports nothing itself, so the bar must ease upward on a timer instead
    // of freezing at the floor. Inject the tick scheduler so we drive ticks deterministically (no real
    // wall-clock wait / interval-timing flakiness): capture the tick fn once the ticker is scheduled
    // (after the create's journal I/O), fire it a few times, and assert monotonic progress between the
    // floor and (never reaching) the ceiling.
    const root = makeRoot()
    let tick: (() => void) | undefined
    let markScheduled!: () => void
    const scheduled = new Promise<void>((resolve) => (markScheduled = resolve))
    let resolveCreate: (() => void) | undefined
    const deps = makeDeps(root, {
      scheduleTick: (onTick) => {
        tick = onTick
        markScheduled()
        return () => (tick = undefined)
      },
      runArgv: (argv: string[]) =>
        new Promise<void>((resolve) => {
          // Materialize the interpreter now so verify passes once we let the create resolve.
          const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
          const bin = prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix)
          mkdirSync(join(bin, '..'), { recursive: true })
          writeFileSync(bin, 'x')
          resolveCreate = resolve
        })
    })
    const events: ProvisionProgress[] = []
    const done = new DefaultRuntimeProvisioner(deps).provisionPython((p) => events.push(p))

    await scheduled // the ticker is registered (create is now mid-flight)
    tick?.()
    tick?.()
    tick?.()
    const createProgress = events
      .filter((e) => e.phase === 'create-python' && e.message.startsWith('Creating'))
      .map((e) => e.progress)
    // create-start floor + the three ticks above it, monotonic, never reaching the ceiling.
    expect(createProgress).toHaveLength(4)
    expect(createProgress[0]).toBeCloseTo(0.45)
    for (let i = 1; i < createProgress.length; i++)
      expect(createProgress[i]).toBeGreaterThan(createProgress[i - 1])
    expect(createProgress.at(-1)).toBeLessThan(0.88)

    resolveCreate?.()
    await done
    expect(events.at(-1)).toMatchObject({ phase: 'done', progress: 1 })
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

  it('enforces fetched pack cache and environment budgets before micromamba runs', async () => {
    const root = makeRoot()
    const runArgv = vi.fn(async () => undefined)
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, {
        platform: 'win32',
        cache: { path: 'C:\\osp-cache', lockKey: 'c:\\osp-cache' },
        fetchBundle: async (): Promise<FetchedBundle> => ({
          lockPath: join(root, 'python.lock'),
          pathBudget: { maxCacheRelativePath: 300, maxEnvRelativePath: 10 }
        }),
        runArgv
      })
    )

    const failure = provisioner.provisionPython(() => {})
    await expect(failure).rejects.toThrow(/path budget[^]*shorter data-root/i)
    await expect(failure).rejects.not.toThrow(/LongPathsEnabled|administrator/i)
    expect(runArgv).not.toHaveBeenCalled()
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

  it('cancel(runningLang) aborts that run', async () => {
    const root = makeRoot()
    let seenSignal: AbortSignal | undefined
    const deps = makeDeps(root, {
      runArgv: (_argv, signal) =>
        new Promise<void>((_resolve, reject) => {
          seenSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('Runtime setup cancelled.')))
        })
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    const run = provisioner.provisionPython(() => {})
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    provisioner.cancel('python') // targets the running language explicitly
    await expect(run).rejects.toThrow(/cancelled/i)
  })

  it('cancel(otherLang) does NOT abort the running language (the R-cancels-Python bug)', async () => {
    const root = makeRoot()
    let resolveCreate: (() => void) | undefined
    let seenSignal: AbortSignal | undefined
    const deps = makeDeps(root, {
      runArgv: (argv, signal) =>
        new Promise<void>((resolve) => {
          seenSignal = signal
          const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
          const bin = pythonBin(prefix)
          mkdirSync(join(bin, '..'), { recursive: true })
          writeFileSync(bin, 'x')
          resolveCreate = resolve
        })
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    const py = provisioner.provisionPython(() => {})
    await vi.waitFor(() => expect(seenSignal).toBeDefined()) // python create in flight
    // Cancelling R while Python runs must NOT abort Python's signal.
    provisioner.cancel('r')
    expect(seenSignal?.aborted).toBe(false)
    resolveCreate?.() // let python finish normally
    await expect(py).resolves.toBeUndefined()
    expect(provisioner.status().pythonReady).toBe(true)
  })

  it('PRIMITIVE: cancel(lang) arms a one-shot skip consumed by that language’s next run', async () => {
    // This is the low-level provisioner primitive: it can't see the run queue, so it always arms a
    // skip for a not-running language. The "No-op when idle" contract (don't cancel an UNQUEUED future
    // run) is enforced one layer up by serializeProvisioner — see env-ipc.test.ts, which drives a real
    // queue. Here we only pin the primitive: the arm is one-shot (consumed once), so a later run works.
    const root = makeRoot()
    const runArgv = vi.fn(async () => undefined)
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root, { runArgv }))
    provisioner.cancel('r')
    await expect(provisioner.provisionR(() => {})).rejects.toThrow(/cancelled/i)
    expect(runArgv).not.toHaveBeenCalled()
    // The skip flag was consumed — a subsequent R provision runs normally.
    await expect(provisioner.provisionR(() => {})).resolves.toBeUndefined()
    expect(runArgv).toHaveBeenCalledOnce()
  })

  it('rebuilds a half-built prefix with conda-meta but no interpreter (Windows Retry wedge, 3.2)', async () => {
    // A cancelled/crashed create can leave <prefix>/conda-meta with no interpreter. The old cleanup
    // returned early on conda-meta, so every Retry re-ran `create -p` on the half-built prefix and
    // failed forever. Assert the stale prefix is cleared before create and the env ends up materialized.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    mkdirSync(join(prefix, 'conda-meta'), { recursive: true }) // conda-meta but no python bin
    let condaMetaAtCreate: boolean | undefined
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        // The half-built prefix must have been removed before micromamba runs (not wedge it).
        condaMetaAtCreate = existsSync(join(p, 'conda-meta'))
        const bin = pythonBin(p)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })
    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})
    expect(condaMetaAtCreate).toBe(false) // cleared before create
    expect(existsSync(pythonBin(prefix))).toBe(true) // rebuilt successfully
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

  it('re-arms the spawn intent before EACH create attempt (incl. the cache-repair retry)', async () => {
    // A single materialize can spawn twice (create, then retry after a cache repair). The intent must be
    // re-armed before EACH spawn — writing it once per op would leave the first spawn's exited PID in
    // the sidecar while the retry runs, and recovery would reconcile under the live retry child.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(pkgsCache(root), 'leftover-pkg'), { recursive: true })
    writeFileSync(join(pkgsCache(root), 'leftover-pkg', 'partial'), 'x')
    let creates = 0
    let intents = 0
    const runArgv = vi.fn(async (_argv, _signal, _onChild, onBeforeSpawn) => {
      onBeforeSpawn?.() // real runMicromamba re-arms the intent here, before spawning
      intents += 1
      creates += 1
      if (creates === 1) {
        throw new Error(
          'Found incorrect downloads. Aborting (remove_all: The directory is not empty.)'
        )
      }
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'ok')
    })
    const deps = makeDeps(root, {
      fetchBundle: async () => ({ lockPath: join(root, 'python-3.12.lock') }),
      runArgv
    })

    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})

    expect(creates).toBe(2)
    expect(intents).toBe(2) // intent re-armed before BOTH spawns, not once per op
  })

  it('repairs surgically: keeps complete packages + tarballs, removes only the incomplete extract', async () => {
    const root = makeRoot()
    const cache = pkgsCache(root)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    // A COMPLETE extracted package has micromamba's repodata marker — another env depends on it; must survive.
    mkdirSync(join(cache, 'good-pkg', 'info'), { recursive: true })
    writeFileSync(join(cache, 'good-pkg', 'info', 'repodata_record.json'), '{}')
    // A downloaded TARBALL — offline-rebuild material for other envs; must survive.
    writeFileSync(join(cache, 'numpy-1.26.conda'), 'tarball')
    // An INCOMPLETE extraction (no repodata_record.json) — the corrupt one; must be removed.
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
    expect(existsSync(join(cache, 'good-pkg', 'info', 'repodata_record.json'))).toBe(true) // complete kept
    expect(existsSync(join(cache, 'numpy-1.26.conda'))).toBe(true) // tarball kept
  })

  it('does not repair or retry on a non-cache create error (surfaces it once)', async () => {
    const root = makeRoot()
    const fetchBundle = vi.fn(async (): Promise<FetchedBundle> => ({
      lockPath: join(root, 'p.lock'),
      pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
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

  it('recovers an existing Windows MAX_PATH cache leaf once, then retries without reseeding', async () => {
    const root = makeRoot()
    const cache = pkgsCache(root)
    const leaf = 'libstdcxx-devel_win-64-15.2.0-h0a72980_119'
    const packageDir = join(cache, 'https', 'conda.anaconda.org', 'conda-forge', 'noarch', leaf)
    mkdirSync(packageDir, { recursive: true })
    const missing = join(packageDir, 'Library', 'x'.repeat(280))
    let creates = 0
    const fetchBundle = vi.fn(async (): Promise<FetchedBundle> => ({
      lockPath: join(root, 'p.lock'),
      pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
    }))
    const runArgv = vi.fn(async () => {
      creates += 1
      if (creates === 1) {
        throw new Error(
          `Invalid package cache, file '${missing}' is missing\n` +
            `Cannot find a valid extracted directory cache for '${leaf}.conda'\n` +
            'critical Package cache error.'
        )
      }
      const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'ok')
    })
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, {
        platform: 'win32',
        cache: { path: cache, lockKey: cache },
        fetchBundle,
        runArgv
      })
    )

    await provisioner.provisionPython(() => {})

    expect(creates).toBe(2)
    expect(fetchBundle).toHaveBeenCalledOnce()
    expect(existsSync(packageDir)).toBe(false)
  })

  it('proactively clears an over-budget legacy URL-cache leaf before fresh materialization', async () => {
    const root = makeRoot()
    const legacyLeaf = join(
      pkgsCache(root),
      'https',
      'host',
      'channel',
      'win-64',
      'legacy-deep-package-1.0-0'
    )
    const deepFile = join(legacyLeaf, 'Library', 'a'.repeat(100), 'b'.repeat(100), 'file.hpp')
    mkdirSync(join(deepFile, '..'), { recursive: true })
    writeFileSync(deepFile, 'x')
    mkdirSync(join(legacyLeaf, 'info'), { recursive: true })
    writeFileSync(
      join(legacyLeaf, 'info', 'repodata_record.json'),
      JSON.stringify({ url: 'https://host/channel/win-64/legacy-deep-package-1.0-0.conda' })
    )
    const runArgv = vi.fn(async () => {
      expect(existsSync(legacyLeaf)).toBe(false)
      const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'ok')
    })
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, {
        platform: 'win32',
        cache: { path: 'C:\\osp1234567890', lockKey: 'c:\\osp1234567890' },
        fetchBundle: async (): Promise<FetchedBundle> => ({
          lockPath: join(root, 'p.lock'),
          pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
        }),
        runArgv
      })
    )

    await provisioner.provisionPython(() => {})

    expect(runArgv).toHaveBeenCalledOnce()
    expect(existsSync(legacyLeaf)).toBe(false)
  })

  it.each(['legacy', 'selected'] as const)(
    'locks proactive cleanup against the %s physical cache identity',
    async (heldCache) => {
      const root = makeRoot()
      const shortCache = { path: 'C:\\osp1234567890', lockKey: 'c:\\osp1234567890' }
      const heldKey =
        heldCache === 'legacy'
          ? micromambaCacheLockKey(pkgsCache(root), { platform: 'win32' })
          : shortCache.lockKey
      const legacyLeaf = join(
        pkgsCache(root),
        'https',
        'host',
        'channel',
        'win-64',
        'legacy-deep-package-1.0-0'
      )
      const deepFile = join(legacyLeaf, 'Library', 'a'.repeat(100), 'b'.repeat(100), 'file.hpp')
      mkdirSync(join(deepFile, '..'), { recursive: true })
      writeFileSync(deepFile, 'x')
      mkdirSync(join(legacyLeaf, 'info'), { recursive: true })
      writeFileSync(
        join(legacyLeaf, 'info', 'repodata_record.json'),
        JSON.stringify({ url: 'https://host/channel/win-64/legacy-deep-package-1.0-0.conda' })
      )
      let releaseCache!: () => void
      let cacheHeld!: () => void
      const release = new Promise<void>((resolve) => {
        releaseCache = resolve
      })
      const held = new Promise<void>((resolve) => {
        cacheHeld = resolve
      })
      const reader = withSharedCacheLock(heldKey, async () => {
        cacheHeld()
        await release
      })
      await held
      const runArgv = vi.fn(async () => {
        const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'ok')
      })
      const provisioning = new DefaultRuntimeProvisioner(
        makeDeps(root, {
          platform: 'win32',
          cache: shortCache,
          fetchBundle: async (): Promise<FetchedBundle> => ({
            lockPath: join(root, 'p.lock'),
            pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
          }),
          runArgv
        })
      ).provisionPython(() => {})

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(legacyLeaf)).toBe(true)
      expect(runArgv).not.toHaveBeenCalled()
      releaseCache()
      await Promise.all([reader, provisioning])
      expect(existsSync(legacyLeaf)).toBe(false)
      expect(runArgv).toHaveBeenCalledOnce()
    }
  )

  it('preserves original and retry diagnostics when bounded MAX_PATH recovery fails', async () => {
    const root = makeRoot()
    const cache = pkgsCache(root)
    const leaf = 'broken-package-1.0-0'
    const packageDir = join(cache, 'https', 'host', 'channel', 'noarch', leaf)
    mkdirSync(packageDir, { recursive: true })
    const missing = join(packageDir, 'Library', 'x'.repeat(280))
    let creates = 0
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, {
        platform: 'win32',
        cache: { path: cache, lockKey: cache },
        fetchBundle: async (): Promise<FetchedBundle> => ({
          lockPath: join(root, 'p.lock'),
          pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
        }),
        runArgv: async () => {
          creates += 1
          if (creates === 1) {
            throw new Error(
              `Invalid package cache, file '${missing}' is missing for '${leaf}.conda'; Package cache error`
            )
          }
          throw new Error('retry failed due to a different disk error')
        }
      })
    )

    const failure = provisioner.provisionPython(() => {})
    await expect(failure).rejects.toThrow(
      /Original failure:[^]*Invalid package cache[^]*Retry failure:[^]*different disk error/
    )
    await expect(failure).rejects.toThrow(/short Windows package cache[^]*Repair/i)
    await expect(failure).rejects.not.toThrow(/LongPathsEnabled|administrator/i)
    expect(creates).toBe(2)
  })

  it('wires the spawned micromamba child pid into the materialize journal, then clears it on completion', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    // Snapshot the journal exactly while the child is "alive": inside runArgv, after onChild fires,
    // read operation-journal.json from disk — the same on-disk record startup recovery would reconcile.
    let recordDuringCreate: RuntimeOperationRecord | undefined
    const deps = makeDeps(root, {
      runArgv: async (_argv, _signal, onChild) => {
        // Mimic runMicromamba reporting its spawned child's pid.
        onChild?.(4242)
        // The provisioner's onChild does a fire-and-forget journal.update, so poll the on-disk journal
        // until the pid lands (still "during" the create, before we materialize the bin below).
        const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
        await vi.waitFor(async () => {
          const found = (await journal.pending()).find((r) => r.kind === 'materialize')
          expect(found?.childPid).toBe(4242)
          recordDuringCreate = found
        })
        // Still materialize the interpreter bin so verify() passes and materialize reaches complete().
        const bin = pythonBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })

    await new DefaultRuntimeProvisioner(deps).provisionPython(() => {})

    // During the create the journal held the materialize record with the child pid threaded in.
    expect(recordDuringCreate).toMatchObject({
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      targetPath: prefix,
      childPid: 4242
    })
    // journal.complete() cleared the entry once the prefix settled — nothing left in flight.
    const after = await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()
    expect(after).toEqual([])
  })
})

// The real production pairing: serializeProvisioner (owns the queue) + DefaultRuntimeProvisioner (owns
// running/skip). These drive an ACTUAL queue — python running while R waits behind it — so they verify
// the queued-vs-idle cancel contract end-to-end rather than poking the primitive directly.
describe('serializeProvisioner cancel over a real queue', () => {
  it('cancelling a QUEUED language skips it without aborting the running one', async () => {
    const root = makeRoot()
    let resolvePyCreate: (() => void) | undefined
    const rRunArgv = vi.fn()
    const deps = makeDeps(root, {
      runArgv: (argv: string[]) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        if (prefix.endsWith(DEFAULT_R_ENV)) {
          rRunArgv()
          const bin = rBin(prefix)
          mkdirSync(join(bin, '..'), { recursive: true })
          writeFileSync(bin, 'x')
          return Promise.resolve()
        }
        // Python create hangs, so python stays the RUNNING language while R waits in the queue.
        const bin = pythonBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
        return new Promise<void>((resolve) => {
          resolvePyCreate = resolve
        })
      }
    })
    const serialized = serializeProvisioner(new DefaultRuntimeProvisioner(deps))

    const py = serialized.provisionPython(() => {})
    const r = serialized.provisionR(() => {}) // queued behind python
    await vi.waitFor(() => expect(resolvePyCreate).toBeDefined()) // python is running

    serialized.cancel('r') // cancel the QUEUED language
    resolvePyCreate?.() // let python finish normally

    await expect(py).resolves.toBeUndefined() // python was NOT aborted
    await expect(r).rejects.toThrow(/cancelled/i) // R was skipped when its turn came
    expect(rRunArgv).not.toHaveBeenCalled() // R never spawned micromamba
  })

  it('cancelling an IDLE language is a no-op — the next provision of it still runs', async () => {
    const root = makeRoot()
    const rRunArgv = vi.fn()
    const deps = makeDeps(root, {
      runArgv: async (argv: string[]) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        if (prefix.endsWith(DEFAULT_R_ENV)) rRunArgv()
        const bin = prefix.endsWith(DEFAULT_R_ENV) ? rBin(prefix) : pythonBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })
    const serialized = serializeProvisioner(new DefaultRuntimeProvisioner(deps))

    serialized.cancel('r') // nothing pending -> must be a no-op, NOT an armed skip
    await expect(serialized.provisionR(() => {})).resolves.toBeUndefined()
    expect(rRunArgv).toHaveBeenCalledOnce()
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

  it('verifies the R interpreter with its conda prefix for Windows DLL activation', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_R_ENV)
    const verify = vi.fn(async () => undefined)

    await new DefaultRuntimeProvisioner(makeDeps(root, { verify })).provisionR(() => {})

    expect(verify).toHaveBeenLastCalledWith(rBin(prefix), prefix)
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
    expect(argvs[0][2]).toBe('create')
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

  it('holds the shared pkgs cache lock, so a concurrent exclusive repair cannot run mid-create', async () => {
    // Regression: named-env create extracts into the shared pkgs cache but did not take the lock,
    // so a corrupt-cache repair (cache-exclusive) could delete an incomplete extraction it was
    // producing. The create must hold the shared lock across its runArgv.
    const root = makeRoot()
    const order: string[] = []
    let lockHeld!: () => void
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve
    })
    const { deps } = makeNamedEnvDeps(root, {
      runArgv: async (argv) => {
        order.push('create-start')
        lockHeld() // runArgv runs inside the shared lock -> the lock is now held
        await new Promise((r) => setTimeout(r, 10))
        const idx = argv.indexOf('--prefix')
        const bin = pythonBin(argv[idx + 1])
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
        order.push('create-end')
      }
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    // Kick off the create, wait until its runArgv holds the shared lock (the create now journals first,
    // so the lock is taken a tick later), then request the cache EXCLUSIVE on the same root.
    const create = provisioner.createNamedEnvironment('my-analysis', 'python', ['numpy'])
    await held
    const exclusive = withExclusiveCacheLock(selectMicromambaCache(root).lockKey, async () => {
      order.push('repair')
    })
    await Promise.all([create, exclusive])

    // The exclusive repair waited for the create to fully release the shared lock — it never
    // interleaved between create-start and create-end.
    expect(order).toEqual(['create-start', 'create-end', 'repair'])
  })

  it('does not pass the running default-provision abort signal to its own micromamba (no cross-abort)', async () => {
    // Regression: a named create runs on the RAW provisioner and can overlap a default provision (which
    // sets this.abort). If named create forwarded this.abort?.signal, cancelling the default env would
    // abort the unrelated named-env child. Here we hold a default python provision in its verify phase
    // (this.abort SET, cache lock already released) and then run a named create; its micromamba must
    // receive NO signal.
    const root = makeRoot()
    const pyPrefix = envPrefix(root, DEFAULT_PY_ENV)
    const namedPrefix = envPrefix(root, 'my-analysis')
    let namedSignal: AbortSignal | undefined
    let sawNamedRun = false
    let pyVerifyStarted = false
    let resolvePyVerify: (() => void) | undefined
    const deps = makeDeps(root, {
      runArgv: async (argv, signal) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        if (prefix === namedPrefix) {
          sawNamedRun = true
          namedSignal = signal
        }
        const bin = pythonBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      },
      verify: async (bin) => {
        // Hang the DEFAULT python verify so its provision stays "running" (this.abort set) while the
        // named create proceeds; the cache lock is already released (verify is outside it).
        if (bin === pythonBin(pyPrefix)) {
          pyVerifyStarted = true
          await new Promise<void>((resolve) => {
            resolvePyVerify = resolve
          })
        }
      }
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    const py = provisioner.provisionPython(() => {})
    await vi.waitFor(() => expect(pyVerifyStarted).toBe(true))

    await provisioner.createNamedEnvironment('my-analysis', 'python')
    expect(sawNamedRun).toBe(true)
    // The named create's micromamba got NO abort signal, so cancelling the default provision can't
    // abort it.
    expect(namedSignal).toBeUndefined()

    resolvePyVerify?.()
    await py
  })
})

describe('DefaultRuntimeProvisioner.upgradeIfNeeded (shared pkgs cache lock)', () => {
  it('holds the shared pkgs cache lock across the bundle upgrade, so a concurrent exclusive repair cannot run mid-upgrade', async () => {
    // Regression: upgradeFromBundle installs the published lock into the SHARED pkgs cache, so it must
    // hold the shared lock — otherwise a corrupt-cache repair (cache-exclusive) could delete an
    // incomplete extraction it is producing. Unlike create, the shared lock is taken AFTER fetchBundle,
    // so we wait until the install actually starts (lock held) before racing the exclusive.
    const root = makeRoot()
    // An older-but-healthy python marker makes upgradeIfNeeded run upgradeFromBundle (R stays lazy, so
    // only the python env is upgraded here).
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't1')
    const order: string[] = []
    let lockHeld!: () => void
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve
    })
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        order.push('upgrade-start')
        lockHeld() // runArgv runs inside the shared lock -> the lock is now held
        await new Promise((r) => setTimeout(r, 10))
        const pIdx = argv.findIndex((a) => a === '--prefix' || a === '-p')
        const bin = pythonBin(argv[pIdx + 1])
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
        order.push('upgrade-end')
      }
    })

    // Start the upgrade, wait until its install holds the shared lock, then request the cache EXCLUSIVE.
    const upgrade = new DefaultRuntimeProvisioner(deps).upgradeIfNeeded(() => {})
    await held
    const exclusive = withExclusiveCacheLock(selectMicromambaCache(root).lockKey, async () => {
      order.push('repair')
    })
    await Promise.all([upgrade, exclusive])

    // The exclusive repair waited for the upgrade to release the shared lock — it never interleaved
    // between upgrade-start and upgrade-end.
    expect(order).toEqual(['upgrade-start', 'upgrade-end', 'repair'])
  })

  it('refuses the upgrade when the python prefix is recovery-blocked (no install spawned)', async () => {
    const root = makeRoot()
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't') // stale marker -> would upgrade python
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (prefix) => prefix === envPrefix(root, DEFAULT_PY_ENV)
    })
    await expect(new DefaultRuntimeProvisioner(deps).upgradeIfNeeded(() => {})).rejects.toThrow(
      /RUNTIME_RECOVERY_BLOCKED/
    )
    expect(runArgv).not.toHaveBeenCalled()
  })

  it('skips the R upgrade when only the R prefix is recovery-blocked, still upgrading python', async () => {
    const root = makeRoot()
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't')
    // R materialized so the R-upgrade branch is reached, but its prefix is recovery-blocked -> skip it
    // (a blocked R prefix must not fail the already-applied python upgrade).
    const rbin = rBin(envPrefix(root, DEFAULT_R_ENV))
    mkdirSync(join(rbin, '..'), { recursive: true })
    writeFileSync(rbin, 'x')
    const upgraded: string[] = []
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        upgraded.push(basename(prefix))
        const bin = prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      },
      isPrefixBlocked: (prefix) => prefix === envPrefix(root, DEFAULT_R_ENV)
    })
    await new DefaultRuntimeProvisioner(deps).upgradeIfNeeded(() => {})
    expect(upgraded).toContain(DEFAULT_PY_ENV)
    expect(upgraded).not.toContain(DEFAULT_R_ENV)
  })
})

// Every prefix-writing micromamba op must journal its child PID + target prefix, or a crash there
// leaves no record for the next startup to block/kill — which is exactly what makes the self-guard
// blind (review R2-A1). materialize is covered above; these cover the paths that previously ran
// runArgv unjournaled: named create, relocation restore, and the bundle upgrade.
describe('DefaultRuntimeProvisioner journals every prefix write', () => {
  // Reads the in-flight journal record for `prefix` while runArgv is "running", then materializes the
  // bin so verify() passes and the op reaches complete().
  const journalingDeps = (
    root: string,
    prefix: string,
    pid: number,
    capture: (r: RuntimeOperationRecord) => void
  ): Partial<ProvisionerDeps> => ({
    runArgv: async (_argv: string[], _signal, onChild) => {
      onChild?.(pid)
      const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
      await vi.waitFor(async () => {
        const found = (await journal.pending()).find((r) => r.targetPath === prefix)
        expect(found?.childPid).toBe(pid)
        capture(found as RuntimeOperationRecord)
      })
      const bin = prefix.endsWith(DEFAULT_R_ENV) ? rBin(prefix) : pythonBin(prefix)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'x')
    }
  })

  it('journals a named-env create with the child pid, cleared on completion', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, 'my-analysis')
    let during: RuntimeOperationRecord | undefined
    const deps = makeDeps(
      root,
      journalingDeps(root, prefix, 777, (r) => (during = r))
    )
    await new DefaultRuntimeProvisioner(deps).createNamedEnvironment('my-analysis', 'python')
    expect(during).toMatchObject({ runtimeId: 'my-analysis', targetPath: prefix, childPid: 777 })
    expect(await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()).toEqual([])
  })

  it('journals a relocation restore with the child pid, cleared on completion', async () => {
    const root = makeRoot()
    const dir = envsLockDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${DEFAULT_PY_ENV}.lock`),
      '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/noarch/x-1.conda#abc\n'
    )
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    let during: RuntimeOperationRecord | undefined
    const deps = makeDeps(
      root,
      journalingDeps(root, prefix, 888, (r) => (during = r))
    )
    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})
    expect(during).toMatchObject({ runtimeId: DEFAULT_PY_ENV, targetPath: prefix, childPid: 888 })
    expect(await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()).toEqual([])
  })

  it('journals a bundle upgrade with the child pid, cleared on completion', async () => {
    const root = makeRoot()
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't')
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    let during: RuntimeOperationRecord | undefined
    const deps = makeDeps(
      root,
      journalingDeps(root, prefix, 999, (r) => (during = r))
    )
    await new DefaultRuntimeProvisioner(deps).upgradeIfNeeded(() => {})
    expect(during).toMatchObject({ kind: 'upgrade', runtimeId: DEFAULT_PY_ENV, childPid: 999 })
    expect(await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()).toEqual([])
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

  it('clears a half-built (conda-meta, no interpreter) prefix before the offline recreate (3.2 parity)', async () => {
    // The create/materialize path removes a conda-meta-but-no-interpreter leftover; the restore path
    // must too, or `create -p` wedges on it forever. Seed such a leftover and assert it's gone by the
    // time runArgv is entered, and that the env is rebuilt.
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    mkdirSync(join(prefix, 'conda-meta'), { recursive: true }) // conda-meta but no python bin
    let condaMetaAtCreate: boolean | undefined
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        condaMetaAtCreate = existsSync(join(p, 'conda-meta'))
        const bin = pythonBin(p)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })
    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})
    expect(condaMetaAtCreate).toBe(false) // the wedged prefix was cleared before create
    expect(existsSync(pythonBin(prefix))).toBe(true) // rebuilt
  })

  it('keeps a valid prefix AND its lock when the ready-marker write fails (no destructive rebuild)', async () => {
    // A marker-write failure (permissions/disk) must NOT be read as "env corrupt": the existing valid
    // relocated env is kept, its lock retained for a later launch, and it is NOT rebuilt (which would
    // delete the relocated user packages). Force the failure by making the marker path a directory so
    // the atomic rename can't land.
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true }) // a valid, verifiable existing env
    writeFileSync(bin, 'x')
    mkdirSync(readyMarkerPath(root), { recursive: true }) // marker write will fail (rename onto a dir)
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, { runArgv }) // default verify resolves -> env is "valid"

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    expect(runArgv).not.toHaveBeenCalled() // NOT rebuilt
    expect(existsSync(bin)).toBe(true) // prefix kept
    expect(existsSync(join(envsLockDir(root), `${DEFAULT_PY_ENV}.lock`))).toBe(true) // lock retained
  })

  it('does NOT delete the old prefix when journal begin() fails closed (cleanup is inside the wrapper)', async () => {
    // The prefix cleanup must run INSIDE withJournaledPrefixWrite, after begin() succeeds — so a
    // fail-closed begin() never deletes the prefix without a recovery record. Force begin() to fail by
    // making the journal path a directory (its atomic rename can't land) and assert the broken prefix
    // survives and no create was attempted.
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    mkdirSync(join(prefix, 'conda-meta'), { recursive: true }) // broken partial restore would rebuild
    writeFileSync(join(prefix, 'marker'), 'keep')
    mkdirSync(operationJournalPath(root), { recursive: true }) // begin()'s rename now fails -> fail closed
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, { runArgv })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    // begin() threw before the run callback executed, so nothing was deleted and no create ran.
    expect(existsSync(join(prefix, 'conda-meta'))).toBe(true)
    expect(existsSync(join(prefix, 'marker'))).toBe(true)
    expect(runArgv).not.toHaveBeenCalled()
    // The lock is retained for a later launch.
    expect(existsSync(join(envsLockDir(root), `${DEFAULT_PY_ENV}.lock`))).toBe(true)
  })

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

  it('holds the shared pkgs cache lock for its per-env recreate, so a concurrent exclusive repair cannot run mid-restore', async () => {
    // Regression: the offline recreate extracts into the SHARED pkgs cache, so it must hold the shared
    // lock — otherwise a corrupt-cache repair (cache-exclusive) could delete an incomplete extraction
    // it is producing. The recreate now journals first, so wait until its runArgv holds the lock before
    // racing the exclusive (mirroring the createNamedEnvironment / upgrade lock tests).
    const root = makeRoot()
    writeLock(root, DEFAULT_PY_ENV)
    const order: string[] = []
    let lockHeld!: () => void
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve
    })
    const deps = makeDeps(root, {
      runArgv: async (argv) => {
        order.push('restore-start')
        lockHeld()
        await new Promise((r) => setTimeout(r, 10))
        const pIdx = argv.findIndex((a) => a === '-p' || a === '--prefix')
        const bin = pythonBin(argv[pIdx + 1])
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
        order.push('restore-end')
      }
    })

    // Kick off the restore, wait until its recreate holds the shared lock, then request the EXCLUSIVE.
    const restore = new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})
    await held
    const exclusive = withExclusiveCacheLock(selectMicromambaCache(root).lockKey, async () => {
      order.push('repair')
    })
    await Promise.all([restore, exclusive])

    // The exclusive repair waited for the recreate to release the shared lock — it never interleaved
    // between restore-start and restore-end.
    expect(order).toEqual(['restore-start', 'restore-end', 'repair'])
  })
})

// The startup gate calls repair/upgrade/restore through the provisioner, so the block guarantee has to
// live in the provisioner itself (ipc.ts injects isPrefixBlocked ← service.isPrefixRecoveryBlocked).
// These prove a recovery-blocked prefix refuses every prefix-WRITE path — the coverage the UI-only
// assertProvisionAllowed mock never exercised.
describe('DefaultRuntimeProvisioner prefix-block self-guard (startup gate path)', () => {
  const blocking = (
    root: string,
    blockedPrefix: string,
    overrides: Partial<ProvisionerDeps> = {}
  ): ProvisionerDeps =>
    makeDeps(root, { isPrefixBlocked: (prefix) => prefix === blockedPrefix, ...overrides })

  it('refuses provisionPython on a blocked prefix without spawning create', async () => {
    const root = makeRoot()
    const runArgv = vi.fn(async () => undefined)
    const deps = blocking(root, envPrefix(root, DEFAULT_PY_ENV), { runArgv })
    await expect(new DefaultRuntimeProvisioner(deps).provisionPython(() => {})).rejects.toThrow(
      /RUNTIME_RECOVERY_BLOCKED/
    )
    expect(runArgv).not.toHaveBeenCalled()
    expect(readReadyMarker(root)).toBeUndefined()
  })

  it('refuses repair without deleting the existing (possibly-live) prefix', async () => {
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'live-interpreter')
    const runArgv = vi.fn(async () => undefined)
    const deps = blocking(root, prefix, { runArgv })
    await expect(new DefaultRuntimeProvisioner(deps).repair('python', () => {})).rejects.toThrow(
      /RUNTIME_RECOVERY_BLOCKED/
    )
    // The interpreter a survivor may still hold was NOT rm -rf'd, and no rebuild was spawned.
    expect(existsSync(bin)).toBe(true)
    expect(runArgv).not.toHaveBeenCalled()
  })

  it('repair({ force }) clears the quarantine (block + journal) and rebuilds even when blocked', async () => {
    // The explicit user Reset path: force-clears the block so the rebuild — and its inner materialize —
    // are not refused, then re-provisions. Uses a STATEFUL block so clearing actually unblocks.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    // Seed a retained journal record for the prefix (the quarantine's persistent side).
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'stuck',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 1,
      targetPath: prefix
    })
    const blocked = new Set([prefix])
    const cleared: string[] = []
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (p) => blocked.has(p),
      clearPrefixBlock: (p) => {
        blocked.delete(p)
        cleared.push(p)
      }
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    expect(cleared).toEqual([prefix]) // in-memory block cleared
    expect(await journal.pending()).toEqual([]) // retained record cleared -> won't re-arm next startup
    expect(runArgv).toHaveBeenCalled() // rebuild ran (not refused)
    expect(existsSync(pythonBin(prefix))).toBe(true)
  })

  it('repair({ force }) also clears an interrupted install’s runtime-ID block', async () => {
    // An interrupted install blocks BOTH the prefix and the bound runtimeId. A prefix-only Reset would
    // rebuild the env yet leave bound sessions rejected by blockedRuntimeIds until restart, so Reset must
    // clear the runtime-ID block too (from the retained install record's runtimeId).
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'stuck-install',
      kind: 'install',
      runtimeId: 'runtime-xyz',
      phase: 'install-python',
      startedAt: 1,
      targetPath: prefix
    })
    const clearedRuntimes: string[] = []
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => false,
      clearPrefixBlock: () => undefined,
      clearRuntimeBlock: (id) => clearedRuntimes.push(id)
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    expect(clearedRuntimes).toEqual(['runtime-xyz'])
    expect(await journal.pending()).toEqual([])
  })

  it('repair({ force }) refuses when a recorded worker is still alive and cannot be stopped', async () => {
    // Reset deletes + rebuilds the prefix, so it must never drop the block and delete evidence out from
    // under a live worker. When the recorded child can't be confirmed stopped (confirmChildStopped ->
    // false), Reset refuses rather than corrupting a live env. The kill/confirm is injected so the test
    // never signals a real process.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'live',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 1,
      childPid: 4242,
      childStartedAt: Date.now(),
      targetPath: prefix
    })
    const runArgv = vi.fn(async () => undefined)
    const probed: number[] = []
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => true,
      clearPrefixBlock: () => undefined,
      confirmChildStopped: async ({ childPid }) => {
        probed.push(childPid)
        return false // still alive, could not be confirmed stopped
      }
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    expect(probed).toEqual([4242]) // the recorded worker was probed
    // Refused before any rebuild, and the record is left in place (still quarantined).
    expect(runArgv).not.toHaveBeenCalled()
    expect(await journal.pending()).toHaveLength(1)
  })

  it('repair holds the env lock across the whole destructive rm+rebuild cycle', async () => {
    // The rm and the rebuild must run under ONE exclusive env-lock hold, or a package install could slip
    // in between and write into a half-deleted prefix. Assert the rm happens INSIDE the injected lock.
    const root = makeRoot()
    const order: string[] = []
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      withPrefixLock: async (envName, fn) => {
        order.push(`lock:${envName}`)
        try {
          return await fn()
        } finally {
          order.push('unlock')
        }
      }
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {})

    // The lock is taken for the default-python env, the rebuild (runArgv) runs while held, and the lock
    // is only released after — one contiguous critical section.
    expect(order[0]).toBe(`lock:${DEFAULT_PY_ENV}`)
    expect(order[order.length - 1]).toBe('unlock')
    expect(runArgv).toHaveBeenCalled()
  })

  const BOOT_A = '11111111-1111-4111-8111-111111111111'
  const BOOT_B = '22222222-2222-4222-8222-222222222222'
  // Writes a {spawning} sidecar with a chosen boot_id, deterministically (recordSpawnIntentSync would
  // stamp the real machine boot_id, which is undefined off Linux — so we can't use it to test the gate).
  const writeSpawnIntent = (root: string, operationId: string, bootToken: string): void =>
    writeFileSync(
      join(root, `operation-child-${operationId}.json`),
      JSON.stringify({ spawning: true, bootToken })
    )

  it('Reset does not fall back to a stale journal PID for a {spawning} sidecar (reboot proven)', async () => {
    // A {spawning} sidecar means a spawn was attempted but its PID is unknown. The journal may still hold
    // an EARLIER spawn's PID — Reset must NOT probe/kill that stale pid (it may be exited or reused). With
    // no verifiable pid, the ONLY thing that clears it is a proven machine reboot; here the live boot_id
    // differs from the one in the sidecar → reboot proven → clear + rebuild, no probe.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'multi',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 1,
      childPid: 4242, // a stale PID from an earlier spawn
      childStartedAt: 1,
      targetPath: prefix
    })
    writeSpawnIntent(root, 'multi', BOOT_A) // current spawn re-armed the intent; its PID never landed
    const probed: Array<{ childPid: number }> = []
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => false,
      clearPrefixBlock: () => undefined,
      readBootToken: () => BOOT_B, // different boot_id → proves a reboot happened
      confirmChildStopped: async (r) => {
        probed.push(r)
        return true
      }
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    // The stale journal PID was NOT probed (no fallback), and the rebuild proceeded.
    expect(probed).toEqual([])
    expect(runArgv).toHaveBeenCalled()
    expect(await journal.pending()).toEqual([])
  })

  it('Reset REFUSES a no-verifiable-PID orphan when the machine has NOT rebooted', async () => {
    // The unsound old behavior: a {spawning} sidecar with no recorded PID was cleared on any Reset, even
    // an app-only restart — but an app restart does NOT prove a reparented micromamba/pip orphan exited.
    // With the live boot_id equal to the sidecar's (same boot), Reset must refuse and NOT delete the
    // prefix or clear the record, so the possibly-live orphan is never rm'd out from under.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x') // an existing interpreter that must survive the refused Reset
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'multi',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 1,
      targetPath: prefix
    })
    writeSpawnIntent(root, 'multi', BOOT_A) // spawn attempted, PID never landed
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => false,
      clearPrefixBlock: () => undefined,
      readBootToken: () => BOOT_A // SAME boot_id — no reboot proof
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // Nothing destructive: no rebuild spawned, the record is left, the existing interpreter survives.
    expect(runArgv).not.toHaveBeenCalled()
    expect(await journal.pending()).toHaveLength(1)
    expect(existsSync(bin)).toBe(true)
  })

  it('blocks the prefix in-process after an unconfirmed-child failure, refusing an in-session retry', async () => {
    // An unconfirmed-child failure (recording failed, the worker could not be confirmed stopped) leaves a
    // possibly-live orphan. Retaining the journal record only guards the NEXT boot — so the provisioner
    // must ALSO block the prefix in THIS process (deps.blockPrefix), or an in-session retry would spawn a
    // second create that races the orphan on the same prefix. Uses a stateful block so blockPrefix
    // actually feeds isPrefixBlocked, exactly as the service wires it.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const blocked = new Set<string>()
    let attempts = 0
    const runArgv = vi.fn(async (_argv: string[], _s, _c, onBeforeSpawn) => {
      attempts += 1
      onBeforeSpawn?.()
      throw new Error(`create failed: ${CHILD_UNCONFIRMED}`) // worker could not be confirmed stopped
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (p) => blocked.has(p),
      blockPrefix: (p) => blocked.add(p)
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    // First attempt fails unconfirmed and blocks the prefix in-process.
    await expect(provisioner.provisionPython(() => {})).rejects.toThrow(CHILD_UNCONFIRMED)
    expect(blocked.has(prefix)).toBe(true)
    // The retained journal record is kept (guards next boot); the sidecar intent is not cleared.
    expect(
      (await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()).length
    ).toBe(1)

    // An in-session retry is now REFUSED by the block — it never spawns a second, racing create.
    await expect(provisioner.provisionPython(() => {})).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    expect(attempts).toBe(1) // only the first attempt ever spawned
  })

  it('force Reset refuses a prefix this process left live-unconfirmed (no PID to kill)', async () => {
    // After an unconfirmed-child failure THIS process recorded, the orphan's PID never landed, so there is
    // nothing to probe/kill. A force Reset would rm + rebuild the prefix — potentially out from under that
    // still-live orphan — so it must REFUSE this session (the block only clears on restart, when the
    // spawning process is provably gone). Distinct from the {spawning}-sidecar test above, where the
    // intent was injected WITHOUT this process attempting the spawn, so Reset proceeds.
    const root = makeRoot()
    const blocked = new Set<string>()
    const runArgv = vi.fn(async (_argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      throw new Error(`create failed: ${CHILD_UNCONFIRMED}`)
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (p) => blocked.has(p),
      blockPrefix: (p) => blocked.add(p),
      clearPrefixBlock: (p) => blocked.delete(p)
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    await expect(provisioner.provisionPython(() => {})).rejects.toThrow(CHILD_UNCONFIRMED)

    // Force Reset is refused BEFORE the destructive rm (the interpreter-less prefix is untouched) because
    // this same process has an unconfirmed orphan for it.
    await expect(provisioner.repair('python', () => {}, { force: true })).rejects.toThrow(
      /RUNTIME_RECOVERY_BLOCKED/
    )
    // The retained journal record survives (still guarding recovery) — Reset did not clear it.
    expect(
      (await RuntimeOperationJournal.forPath(operationJournalPath(root)).pending()).length
    ).toBe(1)
  })

  it('force Reset refuses a prefix an interrupted INSTALL left live-unconfirmed (injected dep)', async () => {
    // A package install (in the service, not the provisioner) that failed unconfirmed marks its prefix
    // live-unconfirmed in the SERVICE — the provisioner never sees that in its own set. Reset must still
    // refuse via the injected isPrefixLiveUnconfirmed dep, or it would delete + rebuild the prefix out
    // from under the possibly-live installer. A {spawning} sidecar (no verifiable pid) is present, which
    // WITHOUT this dep would be treated as the no-pid escape and cleared. Mirrors ipc.ts wiring.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'install-orphan',
      kind: 'install',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'install-python',
      startedAt: 1,
      targetPath: prefix
    })
    recordSpawnIntentSync(root, 'install-orphan') // installer spawned; its PID never landed
    const liveUnconfirmed = new Set([prefix]) // the service marked it (blockPrefixRecovery)
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => false,
      clearPrefixBlock: () => undefined,
      isPrefixLiveUnconfirmed: (p) => liveUnconfirmed.has(p)
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // Refused before the destructive rm — no rebuild spawned, journal record retained.
    expect(runArgv).not.toHaveBeenCalled()
    expect((await journal.pending()).length).toBe(1)
  })

  it('Reset verifies a recorded worker by pid AND start time (reuse guard)', async () => {
    // A valid sidecar carries childStartedAt; Reset must pass it to the guard so a reused pid is rejected
    // rather than a live unrelated process SIGKILLed.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    await journal.begin({
      operationId: 'valid',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 1,
      targetPath: prefix
    })
    recordOperationChildSync(root, 'valid', { childPid: 9931, childStartedAt: 1_700_000_000_000 })
    let seen: { childPid: number; childStartedAt?: number } | undefined
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => false,
      clearPrefixBlock: () => undefined,
      confirmChildStopped: async (r) => {
        seen = r
        return true // treat as stopped so the rebuild proceeds
      }
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    expect(seen).toEqual({ childPid: 9931, childStartedAt: 1_700_000_000_000 })
  })

  it('cancelling a QUEUED Reset does not delete the environment', async () => {
    // repair must consume a queued cancel BEFORE its destructive rm; otherwise a cancel leaves a
    // deleted-but-not-rebuilt env. Seed a real prefix, arm a cancel, then repair must throw without rm.
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    const runArgv = vi.fn(async () => undefined)
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root, { runArgv }))
    // Arm a cancel for python while nothing is running -> queued-skip on the next python run.
    provisioner.cancel('python')

    await expect(provisioner.repair('python', () => {})).rejects.toThrow(/cancelled/i)

    // The env prefix was NOT deleted, and no rebuild spawned.
    expect(existsSync(bin)).toBe(true)
    expect(runArgv).not.toHaveBeenCalled()
  })

  it('restoreRelocatedEnvs runs each env restore under the shared env lock', async () => {
    const root = makeRoot()
    const dir = envsLockDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${DEFAULT_PY_ENV}.lock`), '{}')
    const locked: string[] = []
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      withPrefixLock: async (envName, fn) => {
        locked.push(envName)
        return fn()
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    expect(locked).toContain(DEFAULT_PY_ENV)
  })

  it('status() reports a recovery-blocked default prefix', () => {
    const root = makeRoot()
    const blocked = new Set([envPrefix(root, DEFAULT_PY_ENV)])
    const provisioner = new DefaultRuntimeProvisioner(
      makeDeps(root, { isPrefixBlocked: (p) => blocked.has(p) })
    )
    const status = provisioner.status()
    expect(status.pythonRecoveryBlocked).toBe(true)
    expect(status.rRecoveryBlocked).toBe(false)
  })

  it('a corrupt journal Reset moves the journal aside BEFORE deleting the prefix (never delete-then-fail)', async () => {
    // The bug: clearQuarantine used to read pending() (corrupt -> []), clear the block, and let repair
    // proceed to rm the prefix — only for the REBUILD's begin() to then throw on the still-corrupt
    // journal, leaving the env deleted, the block cleared, and the journal still corrupt (permanently
    // unrecoverable without a restart). Force Reset must quarantine (move aside) the corrupt journal
    // FIRST, so the rebuild's begin() succeeds.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    mkdirSync(root, { recursive: true })
    writeFileSync(journalPath, '{ not json', 'utf8')
    const cleared: string[] = []
    let corruptCleared = false
    // Mirror production: a corrupt journal blocks EVERY prefix until the clears fire, after which the
    // state isPrefixBlocked reads flips to unblocked (so the rebuild's assertPrefixWritable passes).
    let corruptBlocked = true
    const clearedPrefixes = new Set<string>()
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (p) => corruptBlocked && !clearedPrefixes.has(p),
      clearPrefixBlock: (p) => {
        cleared.push(p)
        clearedPrefixes.add(p)
      },
      clearCorruptBlock: () => {
        corruptCleared = true
        corruptBlocked = false
      }
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    // The corrupt journal was moved aside (not left in place to keep failing begin()), the prefix block
    // and the global corrupt block were both cleared, and the rebuild actually ran and succeeded.
    expect(existsSync(journalPath)).toBe(false)
    expect(cleared).toEqual([envPrefix(root, DEFAULT_PY_ENV)])
    expect(corruptCleared).toBe(true)
    expect(runArgv).toHaveBeenCalled()
    expect(existsSync(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))).toBe(true)
  })

  it('a corrupt journal Reset REFUSES when a surviving sidecar shows a no-PID orphan and NO reboot', async () => {
    // P1 fix: a corrupt journal can't enumerate records, but the child-state SIDECARS survive it. The old
    // code quarantined + returned unconditionally, letting the caller rm a prefix a live orphan may still
    // be writing. Now Reset scans the sidecars and applies the same gate: a {spawning} sidecar with no
    // reboot proof must REFUSE — leaving the (still-corrupt) journal and the prefix untouched.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x') // existing interpreter that must survive the refused Reset
    writeFileSync(journalPath, '{ not json', 'utf8') // corrupt journal
    writeSpawnIntent(root, 'orphan', BOOT_A) // a spawn whose PID never landed, on this boot
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => true,
      readBootToken: () => BOOT_A // SAME boot → no reboot proof
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // Nothing destructive: the corrupt journal is NOT quarantined, no rebuild ran, the interpreter survives.
    expect(existsSync(journalPath)).toBe(true)
    expect(runArgv).not.toHaveBeenCalled()
    expect(existsSync(bin)).toBe(true)
  })

  it('no-PID orphan Reset error message is platform-specific (Linux: reboot, others: manual cleanup)', async () => {
    // On Linux, readBootToken returns boot_id and we can prove a reboot. On macOS/Windows it returns
    // undefined, so bootTokenProvesReboot always fails — there's no programmatic reboot proof. The error
    // message must reflect this: Linux users are told to reboot; macOS/Windows users are given the manual
    // escape hatch (delete the recovery metadata files) since "reboot and retry" would be misleading.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    mkdirSync(dirname(journalPath), { recursive: true })
    writeFileSync(journalPath, '{ not json', 'utf8') // corrupt journal
    writeSpawnIntent(root, 'orphan', BOOT_A) // no-PID orphan with a Linux boot token
    const runArgv = vi.fn(async () => undefined)

    // Simulate a boot token available (Linux-like) but SAME boot (no reboot proof). The actual platform
    // detection is process.platform, so we can't mock it in the test, but we can verify the error message
    // contains appropriate guidance: on the real test platform (likely darwin/win32), it should mention
    // manual cleanup; on Linux CI, it should mention reboot.
    const deps = makeDeps(root, { runArgv, isPrefixBlocked: () => true, readBootToken: () => BOOT_A })
    const error = await new DefaultRuntimeProvisioner(deps)
      .repair('python', () => {}, { force: true })
      .catch((e) => e)
    expect(error.message).toMatch(/RUNTIME_RECOVERY_BLOCKED/)
    // The guidance varies by platform: Linux → reboot, others → manual cleanup.
    if (process.platform === 'linux') {
      expect(error.message).toMatch(/Restart your computer.*reboot proves/)
    } else {
      expect(error.message).toMatch(/manually delete the recovery metadata files/)
    }
  })

  it('a corrupt journal Reset REFUSES when a surviving sidecar is itself CORRUPT (unprobeable)', async () => {
    // A corrupt sidecar (e.g. a contradictory {spawning + childPid} blob, or torn bytes) has no readable
    // boot token and no verifiable pid — it MAY be a live writer, so the corrupt-journal Reset must refuse
    // rather than quarantine + delete. Proves the sidecar-scan treats 'corrupt' as a possible live writer.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeFileSync(journalPath, '{ not json', 'utf8') // corrupt journal
    // Contradictory (mutually-exclusive) sidecar → readOperationChild returns 'corrupt'.
    writeFileSync(
      join(root, 'operation-child-orphan.json'),
      JSON.stringify({ spawning: true, childPid: 4242, childStartedAt: 1 })
    )
    const runArgv = vi.fn(async () => undefined)
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => true,
      readBootToken: () => BOOT_B // even a "rebooted" reader can't clear a corrupt (tokenless) sidecar
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    expect(existsSync(journalPath)).toBe(true) // not quarantined
    expect(runArgv).not.toHaveBeenCalled()
    expect(existsSync(bin)).toBe(true)
  })

  it('a corrupt journal Reset PROCEEDS when the surviving sidecar boot_id proves a reboot', async () => {
    // The sidecar carries the boot_id from spawn time (journal-independent), so even with a corrupt
    // journal a proven machine reboot clears the otherwise-unprobeable orphan: quarantine + rebuild.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    writeFileSync(journalPath, '{ not json', 'utf8')
    writeSpawnIntent(root, 'orphan', BOOT_A) // orphan recorded on boot A
    let corruptBlocked = true
    const cleared = new Set<string>()
    const runArgv = vi.fn(async (argv: string[], _s, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: (p) => corruptBlocked && !cleared.has(p),
      clearPrefixBlock: (p) => cleared.add(p),
      clearCorruptBlock: () => (corruptBlocked = false),
      readBootToken: () => BOOT_B // different boot_id → reboot proven
    })

    await new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })

    // Journal quarantined, the orphan's stale sidecar removed, and the rebuild ran.
    expect(existsSync(journalPath)).toBe(false)
    expect(existsSync(join(root, 'operation-child-orphan.json'))).toBe(false)
    expect(runArgv).toHaveBeenCalled()
    expect(existsSync(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))).toBe(true)
  })

  it('a corrupt journal Reset STILL refuses a live-unconfirmed prefix (guard runs before the corrupt branch)', async () => {
    // Regression: the live-unconfirmed guard must be checked BEFORE readState(). A corrupt journal used
    // to early-return (quarantine + clear + return) without ever reaching that guard, so a prefix an
    // interrupted install/prefix-write left with a possibly-live orphan would be cleared and the caller
    // would rm it out from under that worker. The two conditions co-occur here: journal corrupt AND the
    // prefix is live-unconfirmed → Reset must refuse and NOT move the journal aside or delete anything.
    const root = makeRoot()
    const journalPath = operationJournalPath(root)
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x') // an existing interpreter that must survive the refused Reset
    writeFileSync(journalPath, '{ not json', 'utf8')
    const runArgv = vi.fn(async () => undefined)
    let corruptCleared = false
    const deps = makeDeps(root, {
      runArgv,
      isPrefixBlocked: () => true,
      clearCorruptBlock: () => {
        corruptCleared = true
      },
      // The service marked this prefix live-unconfirmed (e.g. an interrupted managed install).
      isPrefixLiveUnconfirmed: (p) => p === prefix
    })

    await expect(
      new DefaultRuntimeProvisioner(deps).repair('python', () => {}, { force: true })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // Nothing destructive happened: the corrupt journal is untouched (NOT quarantined), the corrupt block
    // was NOT cleared, no rebuild spawned, and the existing interpreter still exists.
    expect(existsSync(journalPath)).toBe(true)
    expect(corruptCleared).toBe(false)
    expect(runArgv).not.toHaveBeenCalled()
    expect(existsSync(bin)).toBe(true)
  })

  it('a running Reset ignores a per-language cancel once past the destructive boundary', async () => {
    // Once repair clears the quarantine and rm's the prefix there is no safe stopping point: aborting
    // the rebuild would leave a missing/half-built env with the block+evidence already cleared. A
    // per-language cancel arriving while the repair is executing must be ignored (a global/undefined
    // cancel still aborts).
    const root = makeRoot()
    const prefix = envPrefix(root, DEFAULT_PY_ENV)
    const bin = pythonBin(prefix)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    // Holder so runArgv can close over the provisioner that is constructed with runArgv (forward ref).
    const ref: { provisioner?: DefaultRuntimeProvisioner } = {}
    // runArgv signature is (argv, signal, onChild, onBeforeSpawn) — signal is the 2nd arg.
    const runArgv = vi.fn(async (argv: string[], signal, _c, onBeforeSpawn) => {
      onBeforeSpawn?.()
      // Fire the cancel WHILE the destructive rebuild is running (well past the rm). Because this repair
      // is uninterruptible, the per-language cancel must be dropped and the run's signal NOT aborted.
      ref.provisioner?.cancel('python')
      expect(signal?.aborted).toBe(false)
      const p = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
      const b = pythonBin(p)
      mkdirSync(join(b, '..'), { recursive: true })
      writeFileSync(b, 'x')
    })
    ref.provisioner = new DefaultRuntimeProvisioner(makeDeps(root, { runArgv }))

    await ref.provisioner.repair('python', () => {})

    // The rebuild was NOT aborted and the env is intact.
    expect(runArgv).toHaveBeenCalled()
    expect(existsSync(bin)).toBe(true)
  })

  it('a per-language cancel is dropped while idle (does not arm a future queued Reset)', () => {
    // cancel(lang) while nothing is running/queued must be a pure no-op at this layer (no crash, no
    // lingering arm) — env-ipc.serializeProvisioner is the layer that enforces "no-op when idle" for the
    // UI, but the primitive itself must not misbehave if called directly.
    const root = makeRoot()
    const provisioner = new DefaultRuntimeProvisioner(makeDeps(root))
    expect(() => provisioner.cancel('python')).not.toThrow()
  })

  it('refuses createNamedEnvironment on a blocked named prefix', async () => {
    const root = makeRoot()
    const runArgv = vi.fn(async () => undefined)
    const deps = blocking(root, envPrefix(root, 'my-analysis'), { runArgv })
    await expect(
      new DefaultRuntimeProvisioner(deps).createNamedEnvironment('my-analysis', 'python')
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    expect(runArgv).not.toHaveBeenCalled()
  })

  it('restoreRelocatedEnvs skips a blocked prefix (leaves its lock) but restores the rest', async () => {
    const root = makeRoot()
    const dir = envsLockDir(root)
    mkdirSync(dir, { recursive: true })
    const lock = '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/noarch/x-1.conda#abc\n'
    writeFileSync(join(dir, `${DEFAULT_PY_ENV}.lock`), lock)
    writeFileSync(join(dir, 'my-analysis.lock'), lock)

    const restored: string[] = []
    const deps = blocking(root, envPrefix(root, 'my-analysis'), {
      runArgv: async (argv) => {
        const prefix = argv[argv.findIndex((a) => a === '-p' || a === '--prefix') + 1]
        restored.push(basename(prefix))
        const bin = prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix)
        mkdirSync(join(bin, '..'), { recursive: true })
        writeFileSync(bin, 'x')
      }
    })

    await new DefaultRuntimeProvisioner(deps).restoreRelocatedEnvs(() => {})

    // default-python restored + its lock consumed; the blocked named env was skipped and its lock kept
    // for a later launch (when the pid is gone/verifiable) rather than rebuilt over a possible survivor.
    expect(restored).toEqual([DEFAULT_PY_ENV])
    expect(existsSync(join(dir, `${DEFAULT_PY_ENV}.lock`))).toBe(false)
    expect(existsSync(join(dir, 'my-analysis.lock'))).toBe(true)
  })
})
