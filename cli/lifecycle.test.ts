import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { statusCommand, stopCommand, terminateDaemon, urlCommand } from './index.mjs'

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
})

describe('terminateDaemon', () => {
  const base = {
    sleep: async () => {},
    now: (() => {
      let t = 0
      return () => (t += 1000)
    })(),
    gracefulTimeoutMs: 5_000,
    killTimeoutMs: 2_000
  }

  it('returns true without force-killing when the process exits gracefully', async () => {
    const forceKill = vi.fn()
    const stopped = await terminateDaemon(1, {
      ...base,
      isAlive: () => false,
      forceKill
    })
    expect(stopped).toBe(true)
    expect(forceKill).not.toHaveBeenCalled()
  })

  it('force-kills the tree and returns true when the process dies after the kill', async () => {
    // Stays alive through the graceful window (so the wait times out), then is reaped by force-kill.
    let killed = false
    const forceKill = vi.fn(() => {
      killed = true
    })
    const onForceKill = vi.fn()
    const stopped = await terminateDaemon(99, {
      ...base,
      isAlive: () => !killed,
      forceKill,
      onForceKill
    })
    expect(stopped).toBe(true)
    expect(forceKill).toHaveBeenCalledWith(99)
    expect(onForceKill).toHaveBeenCalledTimes(1)
  })

  it('returns false when the process is still alive after the force-kill window', async () => {
    // force-kill runs but the process refuses to die (isAlive stays true throughout).
    const forceKill = vi.fn()
    const stopped = await terminateDaemon(7, { ...base, isAlive: () => true, forceKill })
    expect(stopped).toBe(false)
    expect(forceKill).toHaveBeenCalledWith(7)
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

  it('does NOT remove state or print stopped when the process survives the force-kill', async () => {
    // Always alive: findCurrentState passes, graceful times out, force-kill fails to reap it.
    const deps = makeDeps({ isAlive: vi.fn().mockReturnValue(true) })
    await expect(stopCommand({}, deps)).rejects.toThrow(/still running/)

    expect(deps.forceKill).toHaveBeenCalledWith(RUNNING_STATE.pid)
    expect(deps.removeState).not.toHaveBeenCalled()
    expect(deps.log).not.toHaveBeenCalledWith('Open Science stopped.')
  })

  it('still force-kills when the graceful shutdown request fails', async () => {
    const deps = makeDeps({
      isAlive: vi.fn().mockReturnValue(true),
      fetch: vi.fn().mockRejectedValue(new Error('connection refused'))
    })
    await expect(stopCommand({}, deps)).rejects.toThrow(/still running/)
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Graceful shutdown failed'))
    expect(deps.forceKill).toHaveBeenCalledWith(RUNNING_STATE.pid)
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
    expect(payload.url).toContain('token=token-abc')
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
