import { EventEmitter } from 'node:events'
import { closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(actual.homedir) }
})

import {
  buildAppLaunchArgs,
  formatStartupFailure,
  isProcessAlive,
  openLaunchLog,
  parseCliArgs,
  runCli,
  reportCliError,
  statusCommand,
  stopCommand,
  terminateDaemon,
  urlCommand,
  waitForStartup
} from './index.mjs'
import {
  DEV_CONFIG_DIR,
  PROD_CONFIG_DIR,
  findServiceState,
  readWebToken,
  STATE_FILE,
  TOKEN_FILE
} from './config-root.mjs'
import { connectToOpenScience } from '../packages/open-science/index.mjs'

// A running daemon's on-disk state, as findServiceState would return it.
const RUNNING_STATE = { pid: 4242, port: 44100, configRoot: '/tmp/os-config' }

type CommandDeps = {
  findServiceState: Mock
  readWebToken: Mock
  isAlive: Mock
  forceKill: Mock
  removeState: Mock
  fetch: Mock
  sleep: Mock
  now: Mock
  log: Mock
  warn: Mock
}

// Builds an injectable deps bag over the command functions, with sensible "healthy running daemon"
// defaults that individual tests override. `sleep`/`now` are faked so timeout loops resolve instantly.
const makeDeps = (overrides: Partial<CommandDeps> = {}): CommandDeps => {
  let clock = 0
  return {
    findServiceState: vi.fn().mockResolvedValue(RUNNING_STATE),
    readWebToken: vi.fn().mockResolvedValue('token-abc'),
    isAlive: vi.fn().mockReturnValue(true),
    // Legacy destructive seam: retained in the harness so regression tests prove stopCommand never
    // delegates a persisted PID to the old external process-tree kill path.
    forceKill: vi.fn(),
    removeState: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    // Advance a virtual clock instead of really waiting, so wait loops terminate immediately.
    sleep: vi.fn().mockImplementation(async (ms) => {
      clock += ms
    }),
    now: vi.fn().mockImplementation(() => (clock += 1000)),
    log: vi.fn(),
    warn: vi.fn(),
    ...overrides
  }
}

afterEach(() => {
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.mocked(homedir).mockReset()
})

describe('C01 automatic service discovery', () => {
  const withCandidates = async (
    preferred: 'dead' | 'unhealthy' | 'healthy',
    check: (fixture: { deps: CommandDeps; devRoot: string; prodRoot: string }) => Promise<void>
  ): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'open-science-candidates-'))
    const devRoot = join(home, DEV_CONFIG_DIR)
    const prodRoot = join(home, PROD_CONFIG_DIR)
    vi.mocked(homedir).mockReturnValue(home)
    vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', undefined)
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', undefined)
    let stopped = false
    try {
      for (const [configRoot, pid, port] of [
        [devRoot, 4241, 44101],
        [prodRoot, 4242, 44102]
      ] as const) {
        await mkdir(configRoot)
        await writeFile(
          join(configRoot, STATE_FILE),
          JSON.stringify({ configRoot, pid, port, startedAt: '2026-09-01T00:00:00Z' })
        )
        await writeFile(join(configRoot, TOKEN_FILE), `token-${port}`)
      }
      const deps = makeDeps({
        findServiceState: vi.fn((options) => findServiceState(options)),
        readWebToken: vi.fn(readWebToken),
        removeState: vi.fn((root) => rm(join(root, STATE_FILE), { force: true })),
        isAlive: vi.fn((pid) => (pid === 4241 ? preferred !== 'dead' : !stopped)),
        fetch: vi.fn(async (input: string) => {
          const url = new URL(input)
          const healthy = url.port === '44102' ? !stopped : preferred === 'healthy'
          if (url.pathname === '/api/shutdown' && healthy) stopped = true
          return {
            ok: healthy,
            status: healthy ? 200 : 503,
            json: async () => ({ data: { appName: 'Open Science' } }),
            arrayBuffer: async () => new ArrayBuffer(0)
          }
        })
      })
      await check({ deps, devRoot, prodRoot })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  it.each(['dead', 'unhealthy'] as const)(
    'connects the SDK past a %s candidate',
    async (preferred) => {
      await withCandidates(preferred, async ({ deps }) => {
        const client = await connectToOpenScience({ fetch: deps.fetch })
        expect(client.baseUrl).toBe('http://127.0.0.1:44102')
      })
    }
  )

  it('reuses the healthy production service on start past an unhealthy candidate', async () => {
    await withCandidates('unhealthy', async ({ deps }) => {
      vi.stubGlobal('fetch', deps.fetch)
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await runCli(['start', '--no-open', '--app-path', join(tmpdir(), 'missing-open-science-app')])
      expect(log).toHaveBeenCalledWith('Open Science is already running (PID 4242).')
    })
  })

  it.each(['dead', 'unhealthy'] as const)(
    'finds the healthy production service on both queries with a %s preferred PID',
    async (preferred) => {
      await withCandidates(preferred, async ({ deps, devRoot, prodRoot }) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          deps.log.mockClear()
          deps.fetch.mockClear()
          await statusCommand({ json: true }, deps)
          expect.soft(JSON.parse(deps.log.mock.calls[0][0])).toMatchObject({
            running: true,
            configRoot: prodRoot
          })
          expect
            .soft(deps.fetch)
            .toHaveBeenCalledWith(
              'http://127.0.0.1:44102/api/bootstrap',
              expect.objectContaining({ headers: { authorization: 'Bearer token-44102' } })
            )
        }
        if (preferred === 'unhealthy') {
          expect(deps.removeState).not.toHaveBeenCalledWith(devRoot)
          await expect(readFile(join(devRoot, STATE_FILE), 'utf8')).resolves.toContain('4241')
        }
      })
    }
  )

  it.each(['dead', 'unhealthy'] as const)(
    'gets the healthy URL past a %s candidate',
    async (preferred) => {
      await withCandidates(preferred, async ({ deps }) => {
        await urlCommand({}, deps)
        expect(deps.log).toHaveBeenCalledWith('http://127.0.0.1:44102/?token=token-44102')
      })
    }
  )

  it.each(['dead', 'unhealthy'] as const)(
    'stops only the selected authenticated target past a %s candidate',
    async (preferred) => {
      await withCandidates(preferred, async ({ deps, devRoot, prodRoot }) => {
        await stopCommand({}, deps)
        expect(deps.fetch.mock.calls.filter(([url]) => url.endsWith('/api/shutdown'))).toEqual([
          [
            'http://127.0.0.1:44102/api/shutdown',
            expect.objectContaining({
              method: 'POST',
              headers: { authorization: 'Bearer token-44102' }
            })
          ]
        ])
        expect(deps.removeState).toHaveBeenCalledWith(prodRoot)
        if (preferred === 'unhealthy') expect(deps.removeState).not.toHaveBeenCalledWith(devRoot)
        expect(deps.forceKill).not.toHaveBeenCalled()
      })
    }
  )

  it.each(['dead', 'unhealthy'] as const)(
    'keeps explicit discovery bounded with a %s candidate',
    async (preferred) => {
      await withCandidates(preferred, async ({ deps, devRoot }) => {
        await statusCommand({ json: true, configRoot: devRoot }, deps)
        expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({ running: false })
        expect(deps.fetch.mock.calls.some(([url]) => url.includes(':44102/'))).toBe(false)
      })
    }
  )

  it('preserves development-first selection when both instances are healthy', async () => {
    await withCandidates('healthy', async ({ deps, devRoot }) => {
      await statusCommand({ json: true }, deps)
      expect(JSON.parse(deps.log.mock.calls[0][0])).toMatchObject({
        running: true,
        configRoot: devRoot
      })
      expect(deps.fetch.mock.calls.some(([url]) => url.includes(':44102/'))).toBe(false)
    })
  })

  it.each(['OPEN_SCIENCE_CONFIG_ROOT', 'OPEN_SCIENCE_STORAGE_ROOT'])(
    'keeps discovery bounded by %s',
    async (name) => {
      await withCandidates('unhealthy', async ({ deps, devRoot }) => {
        vi.stubEnv(name, devRoot)
        await statusCommand({ json: true }, deps)
        expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({ running: false })
        expect(deps.fetch.mock.calls.some(([url]) => url.includes(':44102/'))).toBe(false)
        await expect(connectToOpenScience({ fetch: deps.fetch })).rejects.toThrow()
        expect(deps.fetch.mock.calls.some(([url]) => url.includes(':44102/'))).toBe(false)
      })
    }
  )

  it('fails a bounded stop without deleting or signalling a live unhealthy candidate', async () => {
    await withCandidates('unhealthy', async ({ deps, devRoot }) => {
      await expect(stopCommand({ configRoot: devRoot }, deps)).rejects.toThrow(
        'authenticated shutdown request was not accepted'
      )
      expect(deps.removeState).not.toHaveBeenCalled()
      expect(deps.forceKill).not.toHaveBeenCalled()
      expect(deps.fetch.mock.calls.some(([url]) => url.includes(':44102/'))).toBe(false)
    })
  })

  it('does not continue SDK discovery after cancellation', async () => {
    await withCandidates('unhealthy', async ({ deps }) => {
      const controller = new AbortController()
      const reason = new Error('cancel connection')
      deps.fetch.mockImplementationOnce(async () => {
        controller.abort(reason)
        throw reason
      })
      await expect(
        connectToOpenScience({ fetch: deps.fetch, signal: controller.signal })
      ).rejects.toBe(reason)
      expect(deps.fetch).toHaveBeenCalledTimes(1)
    })
  })
})

describe('C05 stop --json output', () => {
  it.each(['already stopped', 'daemon', 'attached web service'] as const)(
    'emits one parseable JSON object when stopping %s',
    async (kind) => {
      let stopped = false
      const deps = makeDeps({
        findServiceState: vi
          .fn()
          .mockResolvedValue(
            kind === 'already stopped'
              ? undefined
              : { ...RUNNING_STATE, attached: kind === 'attached web service' }
          ),
        isAlive: vi.fn(() => kind === 'attached web service' || !stopped),
        fetch: vi.fn(async (url: string) => {
          if (url.endsWith('/api/shutdown')) {
            stopped = true
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }
          }
          return { ok: !stopped }
        })
      })
      await stopCommand(parseCliArgs(['stop', '--json']).options, deps)
      expect(deps.log).toHaveBeenCalledTimes(1)
      const stdout = deps.log.mock.calls.map((args) => args.join(' ')).join('\n')
      expect(JSON.parse(stdout)).toEqual({
        result:
          kind === 'already stopped'
            ? 'already-stopped'
            : kind === 'daemon'
              ? 'daemon-stopped'
              : 'web-service-stopped'
      })
      expect(process.exitCode).toBeUndefined()
    }
  )

  it('keeps rejected shutdown machine-readable and unsuccessful', async () => {
    const deps = makeDeps({ fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) })
    const errorOutput = vi.fn()
    const setExitCode = vi.fn()
    await stopCommand({ json: true }, deps).catch((error) => {
      reportCliError(error, ['stop', '--json'], { error: errorOutput, setExitCode })
    })
    expect(deps.log).not.toHaveBeenCalled()
    expect(JSON.parse(errorOutput.mock.calls[0][0])).toMatchObject({
      error: { code: 'command_failed' },
      exitCode: 1
    })
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(deps.removeState).not.toHaveBeenCalled()
    expect(deps.forceKill).not.toHaveBeenCalled()
  })
})

describe('terminateDaemon', () => {
  const base = {
    sleep: async () => {},
    now: (() => {
      let t = 0
      return () => (t += 1000)
    })(),
    gracefulTimeoutMs: 5_000
  }

  it('returns true when the process exits gracefully', async () => {
    const stopped = await terminateDaemon(1, {
      ...base,
      isAlive: () => false
    })
    expect(stopped).toBe(true)
  })

  it('returns false when the process remains alive through the graceful timeout', async () => {
    const stopped = await terminateDaemon(99, {
      ...base,
      isAlive: () => true
    })
    expect(stopped).toBe(false)
  })
})

describe('headless startup', () => {
  it('starts each launch with an empty diagnostic log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-log-'))
    const logPath = join(directory, 'cli-daemon.log')
    try {
      await writeFile(logPath, 'stale SUID sandbox failure')

      closeSync(openLaunchLog(logPath))

      await expect(readFile(logPath, 'utf8')).resolves.toBe('')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('places the no-sandbox runtime switch before the development app path', () => {
    expect(buildAppLaunchArgs(['app-root'], { noSandbox: true }, 44100)).toEqual([
      '--no-sandbox',
      'app-root',
      '--open-science-headless',
      '--serve=44100'
    ])
    expect(buildAppLaunchArgs(['app-root'], {}, 44100)).not.toContain('--no-sandbox')
  })

  it('stops waiting as soon as the packaged app exits', async () => {
    const child = new EventEmitter()
    const deps = makeDeps({
      findServiceState: vi.fn().mockImplementation(() => {
        child.emit('exit', 1, null)
        return Promise.resolve(undefined)
      })
    })

    await expect(waitForStartup('/tmp/os-config', child, deps, 30_000)).resolves.toEqual({
      kind: 'exit',
      code: 1,
      signal: null
    })
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('keeps waiting after a successful second-instance handoff', async () => {
    const child = new EventEmitter()
    const findServiceState = vi
      .fn()
      .mockImplementationOnce(() => {
        child.emit('exit', 0, null)
        return Promise.resolve(undefined)
      })
      .mockResolvedValue(RUNNING_STATE)
    const deps = makeDeps({ findServiceState })

    await expect(waitForStartup('/tmp/os-config', child, deps, 30_000)).resolves.toEqual({
      kind: 'ready',
      state: RUNNING_STATE
    })
    expect(findServiceState).toHaveBeenCalledTimes(2)
  })

  it('explains the AppImage sandbox failure and the explicit security trade-off', () => {
    const message = formatStartupFailure(
      { kind: 'exit', code: 1, signal: null },
      'FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166\nThe SUID sandbox helper binary was found, but is not configured correctly.',
      { noSandbox: false }
    )

    expect(message).toContain('open-science start --no-sandbox')
    expect(message).toContain('reduces security')
    expect(message).toContain('AppImage')
  })
})

describe('stopCommand', () => {
  it('reports not running and does nothing when no live daemon is found', async () => {
    const deps = makeDeps({ findServiceState: vi.fn().mockResolvedValue(undefined) })
    await stopCommand({}, deps)
    expect(deps.log).toHaveBeenCalledWith('Open Science is not running.')
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(deps.removeState).not.toHaveBeenCalled()
  })

  it('gracefully shuts down, removes state, and prints stopped', async () => {
    // Alive at findCurrentState, then gone on the first graceful poll.
    const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const deps = makeDeps({ isAlive })
    await stopCommand({}, deps)

    expect(deps.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:44100/api/shutdown',
      expect.objectContaining({ method: 'POST' })
    )
    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).toHaveBeenCalledWith(RUNNING_STATE.configRoot)
    expect(deps.log).toHaveBeenCalledWith('Open Science stopped.')
  })

  it('does not signal or remove state when the process survives the graceful timeout', async () => {
    // Always alive: findCurrentState passes and the authenticated graceful shutdown times out.
    const deps = makeDeps({ isAlive: vi.fn().mockReturnValue(true) })
    await expect(stopCommand({}, deps)).rejects.toThrow(/still running/)

    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).not.toHaveBeenCalled()
    expect(deps.log).not.toHaveBeenCalledWith('Open Science stopped.')
  })

  it('fails closed without signalling when the authenticated shutdown request fails', async () => {
    const deps = makeDeps({
      isAlive: vi.fn().mockReturnValue(true),
      fetch: vi.fn().mockRejectedValue(new Error('connection refused'))
    })
    await expect(stopCommand({}, deps)).rejects.toThrow(
      /authenticated shutdown request was not accepted/
    )
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Graceful shutdown failed'))
    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).not.toHaveBeenCalled()
  })

  it('does not force-kill an unrelated live process when stale state contains its reused PID', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-cli-stale-pid-'))
    const forceKill = vi.fn()
    try {
      // Reproduce PID reuse deterministically: this state belongs to a long-gone daemon, while its PID
      // now names the unrelated Vitest process. The real liveness probe therefore reports the PID alive.
      await writeFile(
        join(configRoot, STATE_FILE),
        JSON.stringify({
          pid: process.pid,
          port: 44100,
          startedAt: '2000-01-01T00:00:00.000Z',
          appVersion: '0.0.0',
          configRoot,
          attached: false
        })
      )
      const deps = makeDeps({
        findServiceState: vi.fn((options) => findServiceState(options)),
        isAlive: vi.fn(isProcessAlive),
        forceKill,
        fetch: vi.fn().mockRejectedValue(new Error('connection refused'))
      })

      await expect(stopCommand({ configRoot }, deps)).rejects.toThrow(
        /authenticated shutdown request was not accepted/
      )

      expect(isProcessAlive(process.pid)).toBe(true)
      expect(forceKill).not.toHaveBeenCalled()
      expect(deps.removeState).not.toHaveBeenCalled()
    } finally {
      await rm(configRoot, { recursive: true })
    }
  })

  it('stops only the web service and never kills the pid when the state is attached', async () => {
    // Attached = the web service rides on the running desktop app. The /api/shutdown request succeeds,
    // then the health-check endpoint stops responding (service down) — the app process itself stays up.
    const deps = makeDeps({
      findServiceState: vi.fn().mockResolvedValue({ ...RUNNING_STATE, attached: true }),
      fetch: vi.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/api/shutdown')) {
          return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }
        }
        throw new Error('connection refused')
      })
    })

    await stopCommand({}, deps)

    expect(deps.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:44100/api/shutdown',
      expect.objectContaining({ method: 'POST' })
    )
    // The pid is the user's app — it must never be signalled.
    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).toHaveBeenCalledWith(RUNNING_STATE.configRoot)
    expect(deps.log).toHaveBeenCalledWith(
      'Open Science web service stopped; the app is still running.'
    )
  })

  it('retains attached state when the authenticated shutdown request is not accepted', async () => {
    const deps = makeDeps({
      findServiceState: vi.fn().mockResolvedValue({ ...RUNNING_STATE, attached: true }),
      fetch: vi.fn().mockRejectedValue(new Error('connection refused'))
    })

    await expect(stopCommand({}, deps)).rejects.toThrow(
      /authenticated shutdown request was not accepted/
    )
    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).not.toHaveBeenCalled()
  })

  it('fails loudly without killing the pid when an attached web service refuses to stop', async () => {
    // Attached, but the service keeps answering health checks (never stops). We must fail rather than
    // escalate to a force-kill, because that pid is the desktop app, not a daemon we own.
    const deps = makeDeps({
      findServiceState: vi.fn().mockResolvedValue({ ...RUNNING_STATE, attached: true })
    })

    await expect(stopCommand({}, deps)).rejects.toThrow(/still serving/)
    expect(deps.forceKill).not.toHaveBeenCalled()
    expect(deps.removeState).not.toHaveBeenCalled()
  })
})

describe('statusCommand', () => {
  it('prints the running status and clears the error exit code', async () => {
    const deps = makeDeps()
    await statusCommand({}, deps)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('is running (PID 4242, port 44100)')
    )
    expect(deps.log.mock.calls.flat().join('\n')).not.toContain('token-abc')
    expect(process.exitCode).toBeUndefined()
  })

  it('prints not running and sets a non-zero exit code when the daemon is down', async () => {
    const deps = makeDeps({ findServiceState: vi.fn().mockResolvedValue(undefined) })
    await statusCommand({}, deps)
    expect(deps.log).toHaveBeenCalledWith('Open Science is not running.')
    expect(process.exitCode).toBe(1)
  })

  it('emits machine-readable JSON with --json', async () => {
    const deps = makeDeps()
    await statusCommand({ json: true }, deps)
    const payload = JSON.parse(deps.log.mock.calls[0][0])
    expect(payload).toMatchObject({ running: true, pid: 4242, port: 44100 })
    expect(payload.url).toBeUndefined()
  })
})

describe('urlCommand', () => {
  it('prints the authenticated URL when running', async () => {
    const deps = makeDeps()
    await urlCommand({}, deps)
    expect(deps.log).toHaveBeenCalledWith('http://127.0.0.1:44100/?token=token-abc')
  })

  it('throws when the daemon is not running', async () => {
    const deps = makeDeps({ isAlive: vi.fn().mockReturnValue(false) })
    await expect(urlCommand({}, deps)).rejects.toThrow('Open Science is not running.')
  })
})
