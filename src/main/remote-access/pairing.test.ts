import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteSessionPairingManager } from './pairing'
import { RemoteAccessRepository, TRUSTED_BROWSER_TTL_MS } from './repository'
import type { RemotePairingDecision } from '../../shared/remote-access'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const request = (
  pathname: string,
  headers: Record<string, string> = {},
  method = 'GET'
): IncomingMessage =>
  ({
    method,
    url: pathname,
    headers: {
      host: 'home.example.ts.net',
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      ...headers
    },
    socket: { remoteAddress: '203.0.113.10' }
  }) as unknown as IncomingMessage

type CapturedResponse = {
  response: ServerResponse
  headers: Map<string, string | string[]>
  body: () => string
  status: () => number | undefined
}

const response = (): CapturedResponse => {
  const headers = new Map<string, string | string[]>()
  let body = ''
  let status: number | undefined
  const value = {
    setHeader: (name: string, headerValue: string | string[]) => {
      headers.set(name.toLowerCase(), headerValue)
      return value
    },
    writeHead: (responseStatus: number, responseHeaders?: Record<string, string>) => {
      status = responseStatus
      for (const [name, headerValue] of Object.entries(responseHeaders ?? {})) {
        headers.set(name.toLowerCase(), headerValue)
      }
      return value
    },
    end: (chunk?: string) => {
      body = chunk ?? ''
      return value
    }
  }
  return {
    response: value as unknown as ServerResponse,
    headers,
    body: () => body,
    status: () => status
  }
}

const cookiePair = (header: string): string => header.split(';', 1)[0]

describe('RemoteSessionPairingManager', () => {
  it('grants temporary access without allowing the browser to manage pairing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const changed = vi.fn()
    const manager = await RemoteSessionPairingManager.create({
      repository: new RemoteAccessRepository(root),
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: changed
    })

    const firstResponse = response()
    await expect(
      manager.webAccess.authorizeHttp(
        request('/'),
        firstResponse.response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('handled')
    expect(firstResponse.body()).toContain('<html lang="en">')
    expect(firstResponse.body()).toContain('class="brand-logo"')
    expect(firstResponse.body()).toContain('fill="currentColor"')
    expect(firstResponse.body()).toContain('<div class="brand-name">Open Science</div>')
    expect(firstResponse.body()).not.toContain('>Beta<')
    expect(firstResponse.body()).not.toContain('class="mark"')
    expect(firstResponse.body()).toContain('Approve this browser')
    expect(firstResponse.body()).toContain('Open Science → Settings → Remote')
    expect(firstResponse.body()).toContain('Choose “Allow for up to 12 hours”')
    expect(firstResponse.body()).toContain('“Trust this browser for 180 days”')
    expect(firstResponse.body()).not.toContain('Always trust this browser')
    expect(firstResponse.body()).not.toContain('Choose “Allow once”')
    expect(firstResponse.body()).not.toContain('Settings → Remote control')
    const pendingCookie = cookiePair(firstResponse.headers.get('set-cookie') as string)
    const [pending] = manager.pendingViews()
    expect(pending).toMatchObject({ browser: 'Safari', platform: 'iOS/iPadOS' })
    expect(pending.code).toMatch(/^\d{6}$/)

    await manager.approve(pending.id, 'once')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    expect(JSON.parse(statusResponse.body())).toEqual({ status: 'approved' })
    const setCookies = statusResponse.headers.get('set-cookie') as string[]
    expect(setCookies[0]).toContain('SameSite=Strict')
    expect(setCookies[0]).not.toContain('Max-Age')
    const sessionCookie = cookiePair(setCookies[0])

    const authorizedResponse = response()
    await expect(
      manager.webAccess.authorizeHttp(
        request('/api/bootstrap', { cookie: sessionCookie }),
        authorizedResponse.response,
        new URL('https://home.example.ts.net/api/bootstrap')
      )
    ).resolves.toMatchObject({ kind: 'authorized' })
    await expect(
      manager.webAccess.authorizeWebSocket(
        request('/api/v1/events', {
          cookie: sessionCookie,
          origin: 'https://home.example.ts.net'
        }),
        new URL('https://home.example.ts.net/api/v1/events')
      )
    ).resolves.toMatchObject({
      principalId: expect.any(String),
      isCurrent: expect.any(Function)
    })
    expect(manager.trustedViews()).toHaveLength(0)
    expect(changed).toHaveBeenCalled()
  })

  it('keeps an existing pairing request pending when the queue reaches capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const manager = await RemoteSessionPairingManager.create({
      repository: new RemoteAccessRepository(root),
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    const firstResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      firstResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const firstCookie = cookiePair(firstResponse.headers.get('set-cookie') as string)

    let rejectedResponse: CapturedResponse | undefined
    for (let index = 0; index < 20; index += 1) {
      rejectedResponse = response()
      await manager.webAccess.authorizeHttp(
        request('/', { 'x-forwarded-for': `203.0.113.${index + 11}` }),
        rejectedResponse.response,
        new URL('https://home.example.ts.net/')
      )
    }

    expect(rejectedResponse?.status()).toBe(429)
    expect(rejectedResponse?.headers.get('retry-after')).toBeDefined()

    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: firstCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    expect(JSON.parse(statusResponse.body())).toMatchObject({ status: 'pending' })
  })

  it('creates pairing requests only from the explicit GET root entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const manager = await RemoteSessionPairingManager.create({
      repository: new RemoteAccessRepository(root),
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    await expect(
      manager.webAccess.authorizeHttp(
        request('/favicon.ico'),
        response().response,
        new URL('https://home.example.ts.net/favicon.ico')
      )
    ).resolves.toBe('denied')
    await expect(
      manager.webAccess.authorizeHttp(
        request('/', {}, 'HEAD'),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('denied')
    expect(manager.pendingViews()).toHaveLength(0)

    await expect(
      manager.webAccess.authorizeHttp(
        request('/'),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('handled')
    expect(manager.pendingViews()).toHaveLength(1)
  })

  it('limits rotating pairing cookies from one source without blocking another source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const manager = await RemoteSessionPairingManager.create({
      repository: new RemoteAccessRepository(root),
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    let limited: CapturedResponse | undefined
    for (let index = 0; index < 4; index += 1) {
      limited = response()
      await manager.webAccess.authorizeHttp(
        request('/', {
          cookie: `open_science_remote_pairing=rotated-${index}`,
          'x-forwarded-for': '203.0.113.20'
        }),
        limited.response,
        new URL('https://home.example.ts.net/')
      )
    }

    expect(limited?.status()).toBe(429)
    expect(manager.pendingViews()).toHaveLength(3)

    const otherSource = response()
    await expect(
      manager.webAccess.authorizeHttp(
        request('/', { 'x-forwarded-for': '203.0.113.21' }),
        otherSource.response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('handled')
    expect(otherSource.status()).toBe(200)
    expect(manager.pendingViews()).toHaveLength(4)
  })

  it('keeps the global admission window after idle requests release their slots', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const manager = await RemoteSessionPairingManager.create({
        repository: new RemoteAccessRepository(root),
        isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged: vi.fn()
      })

      for (let index = 0; index < 40; index += 1) {
        const admission = response()
        await manager.webAccess.authorizeHttp(
          request('/', { 'x-forwarded-for': `203.0.113.${index + 1}` }),
          admission.response,
          new URL('https://home.example.ts.net/')
        )
        expect(admission.status()).toBe(200)
        if (index === 19 || index === 39) {
          await vi.advanceTimersByTimeAsync(30_001)
          expect(manager.pendingViews()).toHaveLength(0)
        }
      }

      const limited = response()
      await manager.webAccess.authorizeHttp(
        request('/', { 'x-forwarded-for': '198.51.100.1' }),
        limited.response,
        new URL('https://home.example.ts.net/')
      )

      expect(limited.status()).toBe(429)
      expect(manager.pendingViews()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists always-trusted browsers and rejects the wrong public host or origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    const firstResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      firstResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(firstResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const [trustedBrowser] = (await repository.load()).trustedBrowsers
    if (!trustedBrowser) throw new Error('Expected a persisted trusted browser.')
    expect(manager.trustedViews()).toEqual([
      expect.objectContaining({ id: trustedBrowser.id, expiresAt: trustedBrowser.expiresAt })
    ])

    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const setCookies = statusResponse.headers.get('set-cookie') as string[]
    expect(setCookies[0]).toContain('SameSite=Lax')
    expect(setCookies[0]).toContain('Max-Age=15552000')
    const sessionCookie = cookiePair(setCookies[0])

    const restartedManager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })
    const httpAuthorization = await restartedManager.webAccess.authorizeHttp(
      request('/', { cookie: sessionCookie }),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    expect(httpAuthorization).toMatchObject({
      kind: 'authorized-pairing-manager',
      principalId: trustedBrowser.id
    })
    await expect(
      restartedManager.webAccess.authorizeWebSocket(
        request('/events', {
          cookie: sessionCookie,
          origin: 'https://home.example.ts.net'
        }),
        new URL('https://home.example.ts.net/events')
      )
    ).resolves.toMatchObject({
      principalId: trustedBrowser.id,
      isCurrent: expect.any(Function)
    })
    expect(restartedManager.pendingViews()).toHaveLength(0)

    await expect(
      manager.webAccess.authorizeHttp(
        request(
          '/rpc/remote-access%3Aget-snapshot',
          { cookie: sessionCookie, origin: 'https://home.example.ts.net' },
          'POST'
        ),
        response().response,
        new URL('https://home.example.ts.net/rpc/remote-access%3Aget-snapshot')
      )
    ).resolves.toMatchObject({ kind: 'authorized-pairing-manager' })

    await expect(
      manager.webAccess.authorizeHttp(
        request(
          '/rpc/test',
          { host: 'attacker.example.com', origin: 'https://attacker.example.com' },
          'POST'
        ),
        response().response,
        new URL('https://attacker.example.com/rpc/test')
      )
    ).resolves.toBe('denied')
    await expect(
      manager.webAccess.authorizeHttp(
        request('/rpc/test', { origin: 'https://attacker.example.com' }, 'POST'),
        response().response,
        new URL('https://home.example.ts.net/rpc/test')
      )
    ).resolves.toBe('denied')
  })

  it('rejects and removes a trusted browser after its 180-day authorization expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    let now = 0
    const options = {
      repository,
      isAllowedRemoteHost: (hostname: string) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn(),
      now: () => now
    }
    const manager = await RemoteSessionPairingManager.create(options)
    const pairingResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      pairingResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(pairingResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])

    now = 15_552_000_001
    const restartedManager = await RemoteSessionPairingManager.create(options)
    await expect(
      restartedManager.webAccess.authorizeHttp(
        request('/', { cookie: sessionCookie }),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('handled')
    await vi.waitFor(async () => {
      expect((await repository.load()).trustedBrowsers).toHaveLength(0)
    })
  })

  it('rejects a trusted browser that expires while its last-seen update is queued', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    let now = 0
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn(),
      now: () => now
    })
    const pairingResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      pairingResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(pairingResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])

    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const persist = repository.save.bind(repository)
    const save = vi
      .spyOn(repository, 'save')
      .mockReturnValueOnce(saveGate)
      .mockImplementation((value) => persist(value))
    const preferenceUpdate = manager.setModePreference('off')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())

    now = TRUSTED_BROWSER_TTL_MS - 1
    const authorization = manager.webAccess.authorizeHttp(
      request('/', { cookie: sessionCookie }),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    now = TRUSTED_BROWSER_TTL_MS
    releaseSave?.()
    await preferenceUpdate

    await expect(authorization).resolves.toBe('handled')
    expect((await repository.load()).trustedBrowsers).toHaveLength(0)
  })

  it('rejects a trusted browser that expires while its last-seen update is saving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    let now = 0
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn(),
      now: () => now
    })
    const pairingResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      pairingResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(pairingResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])

    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const persist = repository.save.bind(repository)
    const save = vi.spyOn(repository, 'save').mockImplementationOnce(async (value) => {
      await saveGate
      await persist(value)
    })
    now = TRUSTED_BROWSER_TTL_MS - 1
    const authorization = manager.webAccess.authorizeHttp(
      request('/', { cookie: sessionCookie }),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())

    now = TRUSTED_BROWSER_TTL_MS
    releaseSave?.()

    await expect(authorization).resolves.toBe('handled')
    expect((await repository.load()).trustedBrowsers).toHaveLength(0)
  })

  it('keeps a trusted browser authorized when revocation cannot be persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    const firstResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      firstResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(firstResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])
    const [trustedBrowser] = manager.trustedViews()

    let rejectSave: ((error: Error) => void) | undefined
    const saveFailure = new Promise<void>((_resolve, reject) => {
      rejectSave = reject
    })
    const save = vi.spyOn(repository, 'save').mockReturnValueOnce(saveFailure)
    const revocation = manager.revoke(trustedBrowser.id)
    void revocation.catch(() => undefined)
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())

    await expect(
      manager.webAccess.authorizeHttp(
        request('/', { cookie: sessionCookie }),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toBe('handled')

    rejectSave?.(new Error('disk full'))
    await expect(revocation).rejects.toThrow('disk full')

    expect(manager.trustedViews()).toHaveLength(1)
    await expect(
      manager.webAccess.authorizeHttp(
        request('/', { cookie: sessionCookie }),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toMatchObject({ kind: 'authorized-pairing-manager' })

    const restartedManager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })
    await expect(
      restartedManager.webAccess.authorizeHttp(
        request('/', { cookie: sessionCookie }),
        response().response,
        new URL('https://home.example.ts.net/')
      )
    ).resolves.toMatchObject({ kind: 'authorized-pairing-manager' })
  })

  it('serializes concurrent trusted-browser revocations without losing an update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    await repository.save({
      version: 5,
      mode: 'remoteit-public',
      trustedBrowsers: [
        {
          id: 'first-browser',
          browser: 'Safari',
          platform: 'macOS',
          tokenHash: 'first-token',
          createdAt: 1,
          lastSeenAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER
        },
        {
          id: 'second-browser',
          browser: 'Chrome',
          platform: 'Windows',
          tokenHash: 'second-token',
          createdAt: 2,
          lastSeenAt: 2,
          expiresAt: Number.MAX_SAFE_INTEGER
        }
      ]
    })
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })
    let releaseFirstSave: (() => void) | undefined
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })
    const save = vi
      .spyOn(repository, 'save')
      .mockImplementationOnce(() => firstSaveGate)
      .mockResolvedValue(undefined)

    const firstRevocation = manager.revoke('first-browser')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    const secondRevocation = manager.revoke('second-browser')
    await Promise.resolve()

    expect(save).toHaveBeenCalledOnce()
    releaseFirstSave?.()
    await Promise.all([firstRevocation, secondRevocation])
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].trustedBrowsers).toHaveLength(0)
    expect(manager.trustedViews()).toHaveLength(0)
  })

  it('allows only one concurrent persistent approval for a pairing request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })
    await manager.webAccess.authorizeHttp(
      request('/'),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    const [pending] = manager.pendingViews()
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const save = vi
      .spyOn(repository, 'save')
      .mockReturnValueOnce(saveGate)
      .mockResolvedValue(undefined)

    const firstApproval = manager.approve(pending.id, 'always')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    const secondApproval = manager.approve(pending.id, 'always')
    releaseSave?.()

    const outcomes = await Promise.allSettled([firstApproval, secondApproval])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(manager.trustedViews()).toHaveLength(1)
  })

  it('removes a persistent approval invalidated before the browser claims it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })
    await manager.webAccess.authorizeHttp(
      request('/'),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    const [pending] = manager.pendingViews()
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const persist = repository.save.bind(repository)
    const save = vi.spyOn(repository, 'save')
    save
      .mockImplementationOnce(async (value) => {
        await saveGate
        await persist(value)
      })
      .mockImplementation((value) => persist(value))

    const approval = manager.approve(pending.id, 'always')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    const invalidation = manager.clearTransientAccess()
    releaseSave?.()

    await expect(approval).rejects.toThrow('expired or is no longer pending')
    await invalidation
    expect((await repository.load()).trustedBrowsers).toHaveLength(0)
  })

  it('removes a persistent approval when the browser never claims it before expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    let now = 0
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn(),
      now: () => now
    })
    await manager.webAccess.authorizeHttp(
      request('/'),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    const [pending] = manager.pendingViews()
    await manager.approve(pending.id, 'always')
    expect((await repository.load()).trustedBrowsers).toHaveLength(1)

    const persist = repository.save.bind(repository)
    const save = vi
      .spyOn(repository, 'save')
      .mockRejectedValueOnce(new Error('cleanup persistence failed'))
      .mockImplementation((value) => persist(value))

    now = 11 * 60 * 1_000
    expect(manager.pendingViews()).toHaveLength(0)

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect((await repository.load()).trustedBrowsers).toHaveLength(1)

    await vi.waitFor(async () => {
      manager.pendingViews()
      expect((await repository.load()).trustedBrowsers).toHaveLength(0)
    })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('expires an unobserved pairing request after its short idle lifetime', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const onChanged = vi.fn()
      const manager = await RemoteSessionPairingManager.create({
        repository: new RemoteAccessRepository(root),
        isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged
      })
      await manager.webAccess.authorizeHttp(
        request('/'),
        response().response,
        new URL('https://home.example.ts.net/')
      )
      expect(manager.pendingViews()).toHaveLength(1)
      onChanged.mockClear()

      await vi.advanceTimersByTimeAsync(30_001)

      expect(onChanged).toHaveBeenCalledOnce()
      expect(manager.pendingViews()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes expiration while a persistent approval is still saving', async () => {
    vi.useFakeTimers()
    let releaseSave: (() => void) | undefined
    let approval: Promise<void> | undefined
    let manager: RemoteSessionPairingManager | undefined
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const repository = new RemoteAccessRepository(root)
      const onChanged = vi.fn()
      manager = await RemoteSessionPairingManager.create({
        repository,
        isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged
      })
      await manager.webAccess.authorizeHttp(
        request('/'),
        response().response,
        new URL('https://home.example.ts.net/')
      )
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve
      })
      vi.spyOn(repository, 'save').mockReturnValueOnce(saveGate)
      onChanged.mockClear()

      approval = manager.approve(manager.pendingViews()[0].id, 'always')
      await vi.waitFor(() => expect(repository.save).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1)

      expect(onChanged).toHaveBeenCalledOnce()
      expect(manager.pendingViews()).toHaveLength(0)
    } finally {
      releaseSave?.()
      await approval?.catch(() => undefined)
      manager?.dispose()
      vi.useRealTimers()
    }
  })

  it('removes an unclaimed persistent approval without waiting for another operation', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const repository = new RemoteAccessRepository(root)
      const onChanged = vi.fn()
      const manager = await RemoteSessionPairingManager.create({
        repository,
        isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged
      })
      await manager.webAccess.authorizeHttp(
        request('/'),
        response().response,
        new URL('https://home.example.ts.net/')
      )
      await manager.approve(manager.pendingViews()[0].id, 'always')
      expect((await repository.load()).trustedBrowsers).toHaveLength(1)
      onChanged.mockClear()

      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1)

      await vi.waitFor(async () => {
        expect((await repository.load()).trustedBrowsers).toHaveLength(0)
      })
      expect(onChanged).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('actively removes a claimed trusted browser when its 180-day authorization expires', async () => {
    vi.useFakeTimers()
    let manager: RemoteSessionPairingManager | undefined
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const repository = new RemoteAccessRepository(root)
      const onChanged = vi.fn()
      manager = await RemoteSessionPairingManager.create({
        repository,
        isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged
      })
      const pairingResponse = response()
      await manager.webAccess.authorizeHttp(
        request('/'),
        pairingResponse.response,
        new URL('https://home.example.ts.net/')
      )
      const pendingCookie = cookiePair(pairingResponse.headers.get('set-cookie') as string)
      await manager.approve(manager.pendingViews()[0].id, 'always')
      await manager.webAccess.authorizeHttp(
        request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
        response().response,
        new URL('https://home.example.ts.net/__open_science_remote/pair/status')
      )
      onChanged.mockClear()

      await vi.advanceTimersByTimeAsync(TRUSTED_BROWSER_TTL_MS + 1)

      await vi.waitFor(async () => {
        expect((await repository.load()).trustedBrowsers).toHaveLength(0)
      })
      expect(onChanged).toHaveBeenCalledOnce()
    } finally {
      manager?.dispose()
      vi.useRealTimers()
    }
  })

  it('reports each naturally expired authorization by stable principal ID', async () => {
    vi.useFakeTimers()
    let manager: RemoteSessionPairingManager | undefined
    try {
      vi.setSystemTime(0)
      const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
      roots.push(root)
      const repository = new RemoteAccessRepository(root)
      const onAuthorizationExpired = vi.fn()
      const options = {
        repository,
        isAllowedRemoteHost: (hostname: string) => hostname === 'home.example.ts.net',
        isEnabled: () => true,
        onChanged: vi.fn(),
        onAuthorizationExpired
      }
      manager = await RemoteSessionPairingManager.create(options)

      const grant = async (
        decision: RemotePairingDecision
      ): Promise<{ principalId: string; isCurrent: () => boolean }> => {
        const pairingResponse = response()
        await manager!.webAccess.authorizeHttp(
          request('/'),
          pairingResponse.response,
          new URL('https://home.example.ts.net/')
        )
        const pendingCookie = cookiePair(pairingResponse.headers.get('set-cookie') as string)
        await manager!.approve(manager!.pendingViews()[0].id, decision)
        const statusResponse = response()
        await manager!.webAccess.authorizeHttp(
          request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
          statusResponse.response,
          new URL('https://home.example.ts.net/__open_science_remote/pair/status')
        )
        const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])
        const authorization = await manager!.webAccess.authorizeWebSocket(
          request('/api/v1/events', {
            cookie: sessionCookie,
            origin: 'https://home.example.ts.net'
          }),
          new URL('https://home.example.ts.net/api/v1/events')
        )
        return authorization!
      }

      const oneTimeAuthorization = await grant('once')
      const trustedAuthorization = await grant('always')
      expect(oneTimeAuthorization.isCurrent()).toBe(true)
      expect(trustedAuthorization.isCurrent()).toBe(true)
      onAuthorizationExpired.mockClear()

      const oneTimeTtlMs = 12 * 60 * 60 * 1_000
      await vi.advanceTimersByTimeAsync(oneTimeTtlMs + 1)
      expect(onAuthorizationExpired).toHaveBeenCalledOnce()
      expect(onAuthorizationExpired).toHaveBeenLastCalledWith(oneTimeAuthorization.principalId)
      expect(oneTimeAuthorization.isCurrent()).toBe(false)
      expect(trustedAuthorization.isCurrent()).toBe(true)

      await vi.advanceTimersByTimeAsync(TRUSTED_BROWSER_TTL_MS - oneTimeTtlMs)
      expect(onAuthorizationExpired).toHaveBeenCalledTimes(2)
      expect(onAuthorizationExpired).toHaveBeenLastCalledWith(trustedAuthorization.principalId)
      expect(trustedAuthorization.isCurrent()).toBe(false)
      await vi.waitFor(async () => {
        expect((await repository.load()).trustedBrowsers).toHaveLength(0)
      })
    } finally {
      manager?.dispose()
      vi.useRealTimers()
    }
  })

  it('rejects an invalid pairing decision without granting or persisting access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    await manager.webAccess.authorizeHttp(
      request('/'),
      response().response,
      new URL('https://home.example.ts.net/')
    )
    const [pending] = manager.pendingViews()

    await expect(
      manager.approve(pending.id, 'unexpected' as RemotePairingDecision)
    ).rejects.toThrow('Pairing decision must be once or always.')
    expect(manager.pendingViews()).toHaveLength(1)
    expect(manager.trustedViews()).toHaveLength(0)
    expect((await repository.load()).trustedBrowsers).toHaveLength(0)
  })

  it('rejects an authorization that finishes after remote access was disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    let now = 0
    let enabled = true
    let authorizationGeneration = 0
    const manager = await RemoteSessionPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => hostname === 'home.example.ts.net',
      isEnabled: () => enabled,
      authorizationGeneration: () => authorizationGeneration,
      onChanged: vi.fn(),
      now: () => now
    })
    const firstResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/'),
      firstResponse.response,
      new URL('https://home.example.ts.net/')
    )
    const pendingCookie = cookiePair(firstResponse.headers.get('set-cookie') as string)
    await manager.approve(manager.pendingViews()[0].id, 'always')
    const statusResponse = response()
    await manager.webAccess.authorizeHttp(
      request('/__open_science_remote/pair/status', { cookie: pendingCookie }),
      statusResponse.response,
      new URL('https://home.example.ts.net/__open_science_remote/pair/status')
    )
    const sessionCookie = cookiePair((statusResponse.headers.get('set-cookie') as string[])[0])
    const httpAuthorization = await manager.webAccess.authorizeHttp(
      request(
        '/rpc/test',
        { cookie: sessionCookie, origin: 'https://home.example.ts.net' },
        'POST'
      ),
      response().response,
      new URL('https://home.example.ts.net/rpc/test')
    )
    expect(httpAuthorization).toMatchObject({ kind: 'authorized-pairing-manager' })
    if (typeof httpAuthorization !== 'object') throw new Error('Expected HTTP authorization.')
    expect(httpAuthorization.isCurrent()).toBe(true)
    now = 60_001
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const save = vi.spyOn(repository, 'save').mockReturnValue(saveGate)

    const authorization = manager.webAccess.authorizeWebSocket(
      request('/events', {
        cookie: sessionCookie,
        origin: 'https://home.example.ts.net'
      }),
      new URL('https://home.example.ts.net/events')
    )
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    enabled = false
    authorizationGeneration += 1
    expect(httpAuthorization.isCurrent()).toBe(false)
    releaseSave?.()

    await expect(authorization).resolves.toBeUndefined()
  })

  it('does not treat an allowed provider Host header as authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-pairing-'))
    roots.push(root)
    const manager = await RemoteSessionPairingManager.create({
      repository: new RemoteAccessRepository(root),
      isAllowedRemoteHost: (hostname) => hostname.endsWith('.r3proxy.com'),
      isEnabled: () => true,
      onChanged: vi.fn()
    })

    const directResponse = response()
    await expect(
      manager.webAccess.authorizeHttp(
        request('/', { host: 'session-123.r3proxy.com' }),
        directResponse.response,
        new URL('https://session-123.r3proxy.com/')
      )
    ).resolves.toBe('handled')
    expect(directResponse.body()).toContain('Approve this browser')
    expect(manager.pendingViews()).toHaveLength(1)

    await expect(
      manager.webAccess.authorizeHttp(
        request(
          '/rpc/test',
          {
            host: 'session-123.r3proxy.com',
            origin: 'https://session-123.r3proxy.com'
          },
          'POST'
        ),
        response().response,
        new URL('https://session-123.r3proxy.com/rpc/test')
      )
    ).resolves.toBe('denied')
    await expect(
      manager.webAccess.authorizeHttp(
        request(
          '/rpc/test',
          {
            host: 'session-123.r3proxy.com',
            origin: 'https://different.r3proxy.com'
          },
          'POST'
        ),
        response().response,
        new URL('https://session-123.r3proxy.com/rpc/test')
      )
    ).resolves.toBe('denied')
    await expect(
      manager.webAccess.authorizeHttp(
        request('/', { host: 'r3proxy.com' }),
        response().response,
        new URL('https://r3proxy.com/')
      )
    ).resolves.toBe('denied')

    await expect(
      manager.webAccess.authorizeWebSocket(
        request('/events', {
          host: 'session-123.r3proxy.com',
          origin: 'https://session-123.r3proxy.com'
        }),
        new URL('https://session-123.r3proxy.com/events')
      )
    ).resolves.toBeUndefined()
    await expect(
      manager.webAccess.authorizeWebSocket(
        request('/events', {
          host: 'session-123.r3proxy.com',
          origin: 'https://different.r3proxy.com'
        }),
        new URL('https://session-123.r3proxy.com/events')
      )
    ).resolves.toBeUndefined()
  })
})
