import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so registerNotebookEnvIpcHandlers can be exercised headless.
const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sentProgress: ProvisionProgress[] = []
const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => registered.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, progress: ProvisionProgress) => sentProgress.push(progress)
        }
      }
    ]
  }
}))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerSpies.info,
      warn: vi.fn(),
      error: loggerSpies.error
    })
  }
})

import type { ProvisionProgress, RuntimeProvisioner } from './provisioner'
import {
  createNotebookEnvHandlers,
  registerNotebookEnvIpcHandlers,
  runStartupGate,
  serializeProvisioner
} from './env-ipc'

const fakeProvisioner = (over: Partial<RuntimeProvisioner> = {}): RuntimeProvisioner => ({
  status: vi
    .fn()
    .mockReturnValue({ pythonReady: false, rReady: false, version: 0, provisioning: false }),
  provisionPython: vi.fn().mockResolvedValue(undefined),
  provisionR: vi.fn().mockResolvedValue(undefined),
  upgradeIfNeeded: vi.fn().mockResolvedValue(undefined),
  repair: vi.fn().mockResolvedValue(undefined),
  restoreRelocatedEnvs: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  ...over
})

describe('createNotebookEnvHandlers', () => {
  it('status returns the provisioner status', async () => {
    const provisioner = fakeProvisioner()
    const handlers = createNotebookEnvHandlers(provisioner)
    expect(await handlers.status()).toEqual({
      pythonReady: false,
      rReady: false,
      version: 0,
      provisioning: false
    })
    expect(provisioner.status).toHaveBeenCalledOnce()
  })

  it('provision dispatches python vs R by language and forwards progress', async () => {
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async (cb: (p: ProvisionProgress) => void) => {
        cb({ phase: 'done', message: 'ok', progress: 1 })
      })
    })
    const emitted: ProvisionProgress[] = []
    const handlers = createNotebookEnvHandlers(provisioner)
    await handlers.provision('python', (p) => emitted.push(p))
    expect(provisioner.provisionPython).toHaveBeenCalledOnce()
    expect(emitted).toEqual([{ phase: 'done', message: 'ok', progress: 1 }])
    await handlers.provision('r', () => {})
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('repair delegates by language as an explicit force-recovery', async () => {
    const provisioner = fakeProvisioner()
    const handlers = createNotebookEnvHandlers(provisioner)
    await handlers.repair('r', () => {})
    // UI repair is the user's Reset: it force-clears the quarantine (force: true).
    expect(provisioner.repair).toHaveBeenCalledWith('r', expect.any(Function), { force: true })
  })

  it('cancel forwards the language to the provisioner while that language is provisioning', () => {
    const provisioner = fakeProvisioner({
      // Keep R provisioning in flight so its language is pending when we cancel.
      provisionR: vi.fn().mockReturnValue(new Promise<void>(() => {}))
    })
    const handlers = createNotebookEnvHandlers(provisioner)
    void handlers.provision('r', () => {})
    handlers.cancel('r')
    expect(provisioner.cancel).toHaveBeenCalledWith('r')
  })

  it('cancel forwards the language to the provisioner while a Reset (repair) is in flight', () => {
    // A Reset runs through repair; it must bump the per-language pending count (serializeLanguage), or
    // the Cancel button shown during a Reset would be dropped as idle and the Reset be un-abortable.
    const provisioner = fakeProvisioner({
      repair: vi.fn().mockReturnValue(new Promise<void>(() => {})) // keep the Reset in flight
    })
    const handlers = createNotebookEnvHandlers(provisioner)
    void handlers.repair('python', () => {})
    handlers.cancel('python')
    expect(provisioner.cancel).toHaveBeenCalledWith('python')
  })

  it('cancel is a NO-OP when the language is idle (does not arm the next unrelated provision)', () => {
    const provisioner = fakeProvisioner()
    const handlers = createNotebookEnvHandlers(provisioner)
    handlers.cancel('r') // nothing provisioning -> must not reach the provisioner
    expect(provisioner.cancel).not.toHaveBeenCalled()
  })

  it('idempotent: the production triple-wrap still forwards a queued cancel to the base provisioner', () => {
    // In production the provisioner is wrapped 3x (main/ipc.ts, registerNotebookEnvIpcHandlers,
    // createNotebookEnvHandlers). If each wrap owned its own queue+pending, a request queued at the
    // OUTER layer wouldn't exist in an inner layer's pending, so cancel routed inward would be dropped
    // as idle. Idempotent serialization collapses them to ONE queue, so a queued cancel reaches base.
    let releasePython!: () => void
    const base = fakeProvisioner({
      provisionPython: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          releasePython = resolve
        })
      )
    })
    const wrapped = serializeProvisioner(serializeProvisioner(serializeProvisioner(base)))

    void wrapped.provisionPython(() => {}) // running
    void wrapped.provisionR(() => {}) // queued behind python (same single queue)
    wrapped.cancel('r') // must reach base despite the triple wrap

    expect(base.cancel).toHaveBeenCalledWith('r')
    releasePython()
  })

  it('idempotent: re-wrapping an already-serialized provisioner returns the same instance', () => {
    const once = serializeProvisioner(fakeProvisioner())
    expect(serializeProvisioner(once)).toBe(once)
  })

  it('counts multiple pending requests for one language (cancel stays live until the last settles)', async () => {
    // Two same-language requests must both be tracked; if the first to settle deleted the language, a
    // cancel while the second is still in flight would be wrongly dropped as idle.
    let releaseFirst!: () => void
    let firstStarted = false
    const base = fakeProvisioner({
      provisionR: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              firstStarted = true
              releaseFirst = resolve
            })
        )
        .mockImplementation(() => new Promise<void>(() => {})) // second stays pending
    })
    const wrapped = serializeProvisioner(base)

    const first = wrapped.provisionR(() => {}) // running
    void wrapped.provisionR(() => {}) // second queued (count = 2)
    await vi.waitFor(() => expect(firstStarted).toBe(true))

    releaseFirst() // first settles -> count drops to 1, NOT 0
    await first
    wrapped.cancel('r') // second still pending -> must still forward
    expect(base.cancel).toHaveBeenCalledWith('r')
  })

  it('UI provision awaits recovery BEFORE touching a prefix (barrier)', async () => {
    // A UI-triggered provision must wait for crash recovery to finish reconciling, or recovery's prefix
    // cleanup could race the rebuild the user just started.
    const order: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        order.push('provision')
      })
    })
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      order.push('recovery')
    })
    const handlers = createNotebookEnvHandlers(provisioner, waitForRecovery)
    await handlers.provision('python', () => {})
    expect(waitForRecovery).toHaveBeenCalledOnce()
    expect(order).toEqual(['recovery', 'provision'])
  })

  it('UI repair awaits recovery BEFORE touching a prefix (barrier)', async () => {
    const order: string[] = []
    const provisioner = fakeProvisioner({
      repair: vi.fn().mockImplementation(async () => {
        order.push('repair')
      })
    })
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      order.push('recovery')
    })
    const handlers = createNotebookEnvHandlers(provisioner, waitForRecovery)
    await handlers.repair('python', () => {})
    expect(order).toEqual(['recovery', 'repair'])
  })

  it('UI provision refuses when the default env is recovery-blocked (but repair is the recovery)', async () => {
    // After recovery leaves the default prefix blocked (an unknown-liveness orphan may still hold it),
    // a UI PROVISION must refuse rather than materialize over it. REPAIR is the explicit Reset/recovery
    // — it deliberately bypasses that gate (force-clears the quarantine), so it must NOT refuse.
    const provisioner = fakeProvisioner()
    const assertProvisionAllowed = vi.fn((lang: string) => {
      if (lang === 'python') throw new Error('RUNTIME_RECOVERY_BLOCKED: python is recovering')
    })
    const handlers = createNotebookEnvHandlers(provisioner, async () => {}, assertProvisionAllowed)

    await expect(handlers.provision('python', () => {})).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    expect(provisioner.provisionPython).not.toHaveBeenCalled()

    // Repair (the Reset entry) proceeds — it's the recovery, so it force-clears rather than refusing.
    await handlers.repair('python', () => {})
    expect(provisioner.repair).toHaveBeenCalledWith('python', expect.any(Function), { force: true })

    // A non-blocked language still provisions.
    await handlers.provision('r', () => {})
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('serializes concurrent provisioning calls so a second call does not start a conflicting run', async () => {
    let resolveFirst: (() => void) | undefined
    const started: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        started.push('python')
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }),
      provisionR: vi.fn().mockImplementation(async () => {
        started.push('r')
      })
    })
    const handlers = createNotebookEnvHandlers(provisioner)

    const first = handlers.provision('python', () => {})
    // Second call fires while the first is still in flight (before resolveFirst is called).
    const second = handlers.provision('r', () => {})

    // The second call must not start provisionR until the first finishes.
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['python'])
    expect(provisioner.provisionR).not.toHaveBeenCalled()

    resolveFirst?.()
    await Promise.all([first, second])

    expect(started).toEqual(['python', 'r'])
    expect(provisioner.provisionPython).toHaveBeenCalledOnce()
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('serializes provision and repair calls against each other', async () => {
    let resolveFirst: (() => void) | undefined
    const started: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        started.push('provision-python')
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }),
      repair: vi.fn().mockImplementation(async () => {
        started.push('repair')
      })
    })
    const handlers = createNotebookEnvHandlers(provisioner)

    const first = handlers.provision('python', () => {})
    const second = handlers.repair('python', () => {})

    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['provision-python'])
    expect(provisioner.repair).not.toHaveBeenCalled()

    resolveFirst?.()
    await Promise.all([first, second])

    expect(started).toEqual(['provision-python', 'repair'])
  })
})

describe('registerNotebookEnvIpcHandlers', () => {
  beforeEach(() => {
    registered.clear()
    sentProgress.length = 0
    loggerSpies.info.mockReset()
    loggerSpies.error.mockReset()
  })
  afterEach(() => {
    registered.clear()
    sentProgress.length = 0
  })

  it('still registers every channel when the provisioner could not be built', () => {
    registerNotebookEnvIpcHandlers(undefined, '/tmp/nope')
    expect([...registered.keys()].sort()).toEqual([
      'notebook-env:cancel',
      'notebook-env:provision',
      'notebook-env:repair',
      'notebook-env:status'
    ])
  })

  it('status reports not-ready and provision/repair reject with an actionable reason', async () => {
    registerNotebookEnvIpcHandlers(undefined, '/tmp/nope')
    const status = await registered.get('notebook-env:status')?.({})
    expect(status).toMatchObject({ pythonReady: false, rReady: false, provisioning: false })
    await expect(registered.get('notebook-env:provision')?.({}, 'python')).rejects.toThrow(
      /micromamba/i
    )
    await expect(registered.get('notebook-env:repair')?.({}, 'python')).rejects.toThrow(
      /micromamba/i
    )
  })

  it('broadcasts the requested language scope for UI provision and repair', async () => {
    const provisioner = fakeProvisioner({
      provisionR: vi.fn().mockImplementation(async (report: (p: ProvisionProgress) => void) => {
        report({ phase: 'fetch-r', message: 'Downloading R', progress: 0.4 })
      }),
      repair: vi.fn().mockImplementation(async (_lang, report) => {
        report({ phase: 'repair', message: 'Repairing Python', progress: 0.2 })
      })
    })
    registerNotebookEnvIpcHandlers(provisioner, '/tmp/nope')

    await registered.get('notebook-env:provision')?.({}, 'r')
    await registered.get('notebook-env:repair')?.({}, 'python')

    expect(sentProgress).toEqual([
      { phase: 'fetch-r', message: 'Downloading R', progress: 0.4, scope: 'r' },
      { phase: 'repair', message: 'Repairing Python', progress: 0.2, scope: 'python' }
    ])
  })

  it('logs a provision failure with diagnostics and rethrows the original error', async () => {
    const failure = Object.assign(new Error('micromamba timed out after 600000ms'), {
      code: 'MICROMAMBA_TIMEOUT',
      data: { timeoutMs: 600_000, offline: true }
    })
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockRejectedValue(failure)
    })
    registerNotebookEnvIpcHandlers(provisioner, 'F:\\openScience\\data\\OpenScience\\runtime')

    await expect(registered.get('notebook-env:provision')?.({}, 'python')).rejects.toBe(failure)

    expect(loggerSpies.error).toHaveBeenCalledOnce()
    const [message, fields] = loggerSpies.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('runtime operation failed')
    expect(fields).toMatchObject({
      operation: 'provision',
      language: 'python',
      root: 'F:\\openScience\\data\\OpenScience\\runtime',
      error: 'micromamba timed out after 600000ms',
      code: 'MICROMAMBA_TIMEOUT',
      data: { timeoutMs: 600_000, offline: true }
    })
    expect(fields.operationId).toEqual(expect.any(String))
    expect(fields.durationMs).toEqual(expect.any(Number))
  })

  it('redacts credentials from persisted runtime diagnostics without changing the thrown error', async () => {
    const channel = 'https://user:basic-secret@example.com/t/path-secret/conda?token=query-secret'
    const failure = Object.assign(new Error(`micromamba timed out (${channel})`), {
      code: 'MICROMAMBA_TIMEOUT',
      data: {
        argv: ['micromamba', '-c', channel],
        stderrTail: 'api_key=stderr-secret',
        stdoutTail: 'Bearer stdout-secret'
      }
    })
    const provisioner = fakeProvisioner({
      provisionPython: vi
        .fn()
        .mockImplementation(async (report: (p: ProvisionProgress) => void) => {
          report({ phase: 'fetch-python', message: `Retrying ${channel}`, progress: 0.1 })
          throw failure
        })
    })
    registerNotebookEnvIpcHandlers(provisioner, '/runtime')

    await expect(registered.get('notebook-env:provision')?.({}, 'python')).rejects.toBe(failure)

    const persisted = JSON.stringify({
      info: loggerSpies.info.mock.calls,
      error: loggerSpies.error.mock.calls
    })
    for (const secret of [
      'basic-secret',
      'path-secret',
      'query-secret',
      'stderr-secret',
      'stdout-secret'
    ]) {
      expect(persisted).not.toContain(secret)
    }
    expect(persisted).toContain('[redacted]')
    expect(failure.message).toContain('basic-secret')
  })

  it('logs operation lifecycle and phase changes without logging every download chunk', async () => {
    const provisioner = fakeProvisioner({
      provisionPython: vi
        .fn()
        .mockImplementation(async (report: (p: ProvisionProgress) => void) => {
          report({ phase: 'fetch-python', message: 'Downloading Python (10%)', progress: 0.1 })
          report({ phase: 'fetch-python', message: 'Downloading Python (20%)', progress: 0.2 })
          report({
            phase: 'fetch-python',
            message: 'Downloading Python (resuming…)',
            progress: 0.2,
            download: {
              phase: 'reconnecting',
              transferred: 20,
              total: 100,
              percent: 20,
              bytesPerSecond: 0,
              attempt: 1
            }
          })
          report({ phase: 'create-python', message: 'Creating Python', progress: 0.45 })
        })
    })
    registerNotebookEnvIpcHandlers(provisioner, '/runtime')

    await registered.get('notebook-env:provision')?.({}, 'python')

    expect(loggerSpies.info.mock.calls.map(([message]) => message)).toEqual([
      'runtime operation started',
      'runtime operation progress',
      'runtime operation progress',
      'runtime operation progress',
      'runtime operation completed'
    ])
    const progressFields = loggerSpies.info.mock.calls
      .filter(([message]) => message === 'runtime operation progress')
      .map(([, fields]) => fields as Record<string, unknown>)
    expect(progressFields).toMatchObject([
      { phase: 'fetch-python', message: 'Downloading Python (10%)' },
      {
        phase: 'fetch-python',
        message: 'Downloading Python (resuming…)',
        download: { phase: 'reconnecting', attempt: 1, transferred: 20, total: 100 }
      },
      { phase: 'create-python', message: 'Creating Python' }
    ])
    const operationIds = new Set(
      loggerSpies.info.mock.calls.map(
        ([, fields]) => (fields as { operationId: string }).operationId
      )
    )
    expect(operationIds.size).toBe(1)
  })
})

describe('runStartupGate', () => {
  it('is detect-only on a fresh empty root: restores relocated envs but does not provision python', async () => {
    const provisioner = fakeProvisioner()
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-'))
    await runStartupGate(provisioner, dir, () => {})
    // Fresh envs are built lazily on first notebook use, not eagerly here.
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
    // restoreRelocatedEnvs still runs (needed for data-root relocations).
    expect(provisioner.restoreRelocatedEnvs).toHaveBeenCalledOnce()
  })

  it('does nothing when already ready', async () => {
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_ENV_VERSION, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate2-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, DEFAULT_ENV_VERSION, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
  })

  it('upgrades when an older-version marker with an existing python bin is found', async () => {
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate3-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, 0, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.upgradeIfNeeded).toHaveBeenCalledOnce()
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
  })

  it('repairs when a marker exists but the python bin is missing', async () => {
    const { writeReadyMarker } = await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate4-'))
    writeReadyMarker(dir, 0, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.repair).toHaveBeenCalledWith('python', expect.any(Function))
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
  })

  it('never provisions R at startup', async () => {
    const provisioner = fakeProvisioner()
    const dir = mkdtempSync(join(tmpdir(), 'os-gate5-'))
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.provisionR).not.toHaveBeenCalled()
  })

  it('does NOT eagerly repair Python for an R-first user (residual default-r, no marker, no python)', async () => {
    // A user who ran R first has a lazily-built default-r dir but no Python and no ready marker
    // (provisionR never writes it). needsRepair keys off the residual default-r, so the action is
    // 'repair' — but there is no Python to repair, so startup must stay detect-only (no eager DL).
    const { rBin, envPrefix, DEFAULT_R_ENV } = await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-rfirst-'))
    const rbin = rBin(envPrefix(dir, DEFAULT_R_ENV))
    mkdirSync(join(rbin, '..'), { recursive: true })
    writeFileSync(rbin, 'x')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.repair).not.toHaveBeenCalled()
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
  })

  it('reports failure via broadcast instead of throwing', async () => {
    // restoreRelocatedEnvs always runs, so failing it exercises the gate's try/catch on a fresh root.
    const provisioner = fakeProvisioner({
      restoreRelocatedEnvs: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const dir = mkdtempSync(join(tmpdir(), 'os-gate6-'))
    const broadcast = vi.fn()
    await expect(runStartupGate(provisioner, dir, broadcast)).resolves.toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('boom') })
    )
  })

  it('refuses to rebuild over a recovery-blocked prefix through the REAL provisioner self-guard', async () => {
    // The startup gate drives repair/upgrade/restore through the provisioner, so the block guarantee
    // must survive that real path — not just a mock guard on the UI handlers. Wire a real
    // DefaultRuntimeProvisioner with the isPrefixBlocked dep ipc.ts injects (← isPrefixRecoveryBlocked),
    // set up a marker-but-no-bin state so the planner picks 'repair', and assert the gate refuses:
    // nothing is spawned, the (possibly-live) prefix is not deleted, and the error is broadcast.
    const { writeReadyMarker, envPrefix, DEFAULT_PY_ENV } = await import('./runtime-paths')
    const { DefaultRuntimeProvisioner } = await import('./provisioner')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-blocked-'))
    const prefix = envPrefix(dir, DEFAULT_PY_ENV)
    mkdirSync(prefix, { recursive: true }) // a partial prefix an orphan may still be writing
    writeReadyMarker(dir, 0, 't') // marker present + no bin => planStartupAction === 'repair'

    const runArgv = vi.fn().mockResolvedValue(undefined)
    const provisioner = new DefaultRuntimeProvisioner({
      root: dir,
      mm: '/mm',
      channel: 'conda-forge',
      fetchBundle: async (spec) => ({ lockPath: join(dir, `${spec.name}.lock`) }),
      runArgv,
      verify: async () => undefined,
      isPrefixBlocked: (p) => p === prefix
    })
    const broadcast = vi.fn()
    await runStartupGate(provisioner, dir, broadcast)

    expect(runArgv).not.toHaveBeenCalled() // no rebuild spawned
    expect(existsSync(prefix)).toBe(true) // prefix not rm -rf'd out from under a possible survivor
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'error',
        message: expect.stringMatching(/RUNTIME_RECOVERY_BLOCKED/)
      })
    )
  })

  it('awaits recovery BEFORE touching any prefix (restore/upgrade/repair)', async () => {
    // The barrier must resolve before the gate's first prefix op, or recovery's cleanup could race a
    // rebuild. Use an existing-but-stale marker so the gate would call upgradeIfNeeded, and assert
    // recovery settled first.
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-barrier-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, 0, 't')

    const order: string[] = []
    const provisioner = fakeProvisioner({
      restoreRelocatedEnvs: vi.fn().mockImplementation(async () => {
        order.push('restore')
      }),
      upgradeIfNeeded: vi.fn().mockImplementation(async () => {
        order.push('upgrade')
      })
    })
    let recovered = false
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      recovered = true
      order.push('recovery')
    })

    await runStartupGate(provisioner, dir, () => {}, waitForRecovery)

    expect(waitForRecovery).toHaveBeenCalledOnce()
    // Recovery ran, and it ran before ANY provisioner prefix op.
    expect(recovered).toBe(true)
    expect(order[0]).toBe('recovery')
    expect(order).toEqual(['recovery', 'restore', 'upgrade'])
  })
})
