import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  requestServiceLifetime,
  requestExistingRuntimeWeb,
  waitForServiceStopped,
  verifyServiceConfigRoot
} from './runtime-control.mjs'

const generation = 'd1ed69cd-9883-452a-9ddd-e67c4a530a1e'
const serviceGeneration = '042a3798-beda-4e60-9d8a-179223668d45'
const lifetime = {
  version: 1,
  generation: serviceGeneration,
  apps: 1,
  explicit: false,
  stopping: false
}
const owner = { generation, pid: 12345, lifetime }

describe('authenticated CLI service lifetime responses', () => {
  let root: string
  let responseOwner: typeof owner & {
    desktopGeneration: string
    startupOptions: {
      configRoot: string
      dataRoot: string
      profilePath: string
      host: string
      port: number
      credentialStore: string
    }
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-lifetime-unit-'))
    responseOwner = {
      ...owner,
      desktopGeneration: serviceGeneration,
      startupOptions: {
        configRoot: root,
        dataRoot: root,
        profilePath: root,
        host: '127.0.0.1',
        port: 0,
        credentialStore: 'os'
      }
    }
    await writeFile(
      join(root, 'runtime-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        host: 'node',
        birthToken: 'fixture-birth',
        generation,
        pid: owner.pid,
        port: 12345,
        desktop: { generation: serviceGeneration, version: '9.2.1' }
      })
    )
    await writeFile(join(root, 'web-token'), 'fixture-token')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('authenticates the generation and validates both the owner and mutation response', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(responseOwner)))
    expect(await requestServiceLifetime(root, 'start', fetch)).toEqual({
      ...responseOwner,
      identity: {
        configRoot: await realpath(root),
        pid: owner.pid,
        generation,
        serviceGeneration,
        birthToken: 'fixture-birth',
        version: '9.2.1'
      }
    })
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/owner',
      '/service/start'
    ])
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer fixture-token',
        'x-open-science-runtime-generation': generation
      }
    })
  })

  it.each([
    { ...lifetime, generation: 'bad-generation' },
    { ...lifetime, generation },
    { ...lifetime, apps: -1 },
    { ...lifetime, apps: 1.5 },
    { ...lifetime, explicit: 'yes' },
    { ...lifetime, stopping: null },
    { ...lifetime, version: 2 },
    { ...lifetime, reason: 'unknown' },
    null
  ])('rejects malformed or stale lifetime state before sending a mutation: %j', async (invalid) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...responseOwner, lifetime: invalid })))
    await expect(requestServiceLifetime(root, 'stop', fetch)).rejects.toThrow(
      'lifetime response is invalid'
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a mutation response that drops the authenticated lifetime contract', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(responseOwner)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation, pid: owner.pid })))
    await expect(requestServiceLifetime(root, 'stop', fetch)).rejects.toThrow(
      'lifetime identity changed'
    )
  })

  it('keeps missing legacy capability distinct from malformed lifetime state', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ generation, pid: owner.pid })))
    await expect(requestServiceLifetime(root, 'status', fetch)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects an owner generation change without issuing the stop', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...responseOwner, generation: serviceGeneration }))
      )
    await expect(requestServiceLifetime(root, 'stop', fetch)).rejects.toThrow('identity changed')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects a copied Config Root before sending any lifecycle or web-start mutation', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'cli-copied-root-unit-'))
    try {
      await writeFile(
        join(copy, 'runtime-owner.json'),
        await readFile(join(root, 'runtime-owner.json'))
      )
      await writeFile(join(copy, 'web-token'), 'fixture-token')
      const fetch = vi
        .fn()
        .mockImplementation(async () => new Response(JSON.stringify(responseOwner)))
      await expect(requestServiceLifetime(copy, 'force-stop', fetch)).rejects.toThrow(
        'different Config Root'
      )
      expect(fetch).toHaveBeenCalledOnce()
      fetch.mockClear()
      await expect(requestExistingRuntimeWeb({ configRoot: copy }, fetch)).resolves.toBeUndefined()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][1].method).toBe('GET')
    } finally {
      await rm(copy, { recursive: true, force: true })
    }
  })

  it('accepts a symbolic link to the same actual Config Root without requiring a local backend', async () => {
    const alias = `${root}-alias`
    try {
      await symlink(root, alias, 'junction')
      const fetch = vi
        .fn()
        .mockImplementation(async () => new Response(JSON.stringify(responseOwner)))
      await expect(requestServiceLifetime(alias, 'start', fetch)).resolves.toMatchObject({
        pid: owner.pid,
        identity: { version: '9.2.1' }
      })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await rm(alias, { recursive: true, force: true })
    }
  })

  it.each([
    { desktopGeneration: generation },
    { startupOptions: undefined },
    { startupOptions: { configRoot: '/another-root' } }
  ])('rejects missing or inconsistent owner metadata before a mutation: %j', async (patch) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...responseOwner, ...patch })))
    await expect(requestServiceLifetime(root, 'stop', fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps an unverifiable legacy owner read-only and rejects its lifecycle mutations', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ generation, pid: owner.pid })))
    await expect(requestServiceLifetime(root, 'stop', fetch)).rejects.toThrow(
      'cannot prove its Config Root'
    )
    expect(fetch).toHaveBeenCalledOnce()
    await expect(requestServiceLifetime(root, 'status', fetch)).resolves.toBeUndefined()
  })

  it('rejects missing legacy bootstrap root proof rather than treating a token as root identity', async () => {
    await expect(verifyServiceConfigRoot(root, undefined)).rejects.toThrow('absolute Config Root')
  })

  it('rejects a malformed recorded service version without requiring equality to the CLI version', async () => {
    const record = JSON.parse(await readFile(join(root, 'runtime-owner.json'), 'utf8'))
    await writeFile(
      join(root, 'runtime-owner.json'),
      JSON.stringify({ ...record, desktop: { ...record.desktop, version: 'not-a-version' } })
    )
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseOwner)))
    await expect(requestServiceLifetime(root, 'start', fetch)).rejects.toThrow('version is invalid')
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('exact CLI stop confirmation', () => {
  const identity = {
    configRoot: '/fixture',
    generation,
    serviceGeneration,
    pid: 23456,
    birthToken: 'birth-B',
    version: '9.2.1'
  }
  const service = {
    generation,
    pid: identity.pid,
    lifetime: { generation: serviceGeneration },
    identity
  }
  const options = (): {
    isAlive: Mock
    now(): number
    sleep: Mock
    timeoutMs: number
    readBirth: Mock
    readOwner: Mock
  } => {
    let clock = 0
    return {
      isAlive: vi.fn().mockReturnValue(true),
      now: () => clock,
      sleep: vi.fn(async (ms: number) => {
        clock += ms
      }),
      timeoutMs: 1000,
      readBirth: vi.fn().mockResolvedValue('birth-B'),
      readOwner: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ generation, pid: identity.pid, birthToken: identity.birthToken })
        )
    }
  }
  it('does not confirm a live accepted owner just because the earlier discovery PID died', async () => {
    const deps = options()
    await expect(waitForServiceStopped(service, deps)).resolves.toEqual({
      stopped: false,
      reason: 'timeout'
    })
    expect(deps.isAlive.mock.calls.every(([pid]) => pid === identity.pid)).toBe(true)
  })
  it('confirms only after the accepted owner PID exits', async () => {
    const deps = options()
    deps.isAlive.mockReturnValueOnce(true).mockReturnValue(false)
    await expect(waitForServiceStopped(service, deps)).resolves.toEqual({ stopped: true })
  })
  it('keeps PID reuse unconfirmed and never signals the replacement', async () => {
    const deps = options()
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      deps.readBirth.mockResolvedValue('replacement-birth')
      await expect(waitForServiceStopped(service, deps)).resolves.toEqual({
        stopped: false,
        reason: 'process-identity-changed'
      })
      expect(signal).not.toHaveBeenCalled()
    } finally {
      signal.mockRestore()
    }
  })
  it('keeps a replacement generation unconfirmed even if the PID is still live', async () => {
    const deps = options()
    deps.readOwner.mockResolvedValue(
      JSON.stringify({ generation: serviceGeneration, pid: identity.pid, birthToken: 'birth-B' })
    )
    await expect(waitForServiceStopped(service, deps)).resolves.toEqual({
      stopped: false,
      reason: 'owner-generation-changed'
    })
  })
  it('does not interpret unreadable birth identity as an exited process', async () => {
    const deps = options()
    deps.readBirth.mockResolvedValue(undefined)
    await expect(waitForServiceStopped(service, deps)).resolves.toEqual({
      stopped: false,
      reason: 'timeout'
    })
  })
  it('bounds a birth probe that never resolves by the same stop deadline', async () => {
    vi.useFakeTimers()
    try {
      const deps = {
        ...options(),
        now: () => Date.now(),
        timeoutMs: 50,
        readBirth: vi.fn(() => new Promise<string>(() => undefined))
      }
      const confirmation = waitForServiceStopped(service, deps)
      await vi.advanceTimersByTimeAsync(50)
      await expect(confirmation).resolves.toEqual({ stopped: false, reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})
