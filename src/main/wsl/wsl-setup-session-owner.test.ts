import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WSL_SETUP_SESSION_TOKEN_TTL_MS, WslSetupSessionOwner } from './wsl-setup-session-owner'

const temporaryRoots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-wsl-session-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('WslSetupSessionOwner', () => {
  it('consumes a token once after its durable session binding succeeds', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()

    expect(owner.authorizeToken(token)).toBe(true)
    await owner.bind(token, 'session-1')

    expect(owner.authorizeToken(token)).toBe(false)
    await expect(owner.bind(token, 'session-2')).rejects.toThrow('WSL_SETUP_SESSION_TOKEN_INVALID')
    await expect(owner.isBound('session-1')).resolves.toBe(true)
    await expect(owner.isBound('session-2')).resolves.toBe(false)

    const stored = await readFile(join(root, 'wsl-setup-sessions.json'), 'utf8')
    expect(stored).toContain('session-1')
    expect(stored).not.toContain(token)
    expect(stored).not.toContain(token.slice(0, token.indexOf('.')))
  })

  it('rejects expired tokens at the exact TTL boundary', async () => {
    const root = await makeRoot()
    let now = 1_000
    const owner = new WslSetupSessionOwner(root, { platform: 'win32', now: () => now })
    const token = owner.mintLocalToken()

    now += WSL_SETUP_SESSION_TOKEN_TTL_MS - 1
    expect(owner.authorizeToken(token)).toBe(true)

    now += 1
    expect(owner.authorizeToken(token)).toBe(false)
    await expect(owner.bind(token, 'expired-session')).rejects.toThrow(
      'WSL_SETUP_SESSION_TOKEN_INVALID'
    )
  })

  it('never persists an unbound one-time setup token across restart', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()

    const restartedOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    expect(restartedOwner.authorizeToken(token)).toBe(false)
    await expect(readFile(join(root, 'wsl-setup-sessions.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.each([
    undefined,
    null,
    42,
    '',
    '.',
    'missing-secret.',
    '.missing-id',
    'missing-separator',
    'unknown-id.unknown-secret'
  ])('rejects malformed or unknown token %j', async (token) => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })

    expect(owner.authorizeToken(token)).toBe(false)
  })

  it('rejects a modified secret without consuming the valid token', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()
    const separator = token.indexOf('.')
    const modified = `${token.slice(0, separator + 1)}x${token.slice(separator + 2)}`

    expect(owner.authorizeToken(modified)).toBe(false)
    expect(owner.authorizeToken(token)).toBe(true)
  })

  it.each(['', 'x'.repeat(513), 'session\0id', 'session\r\nid'])(
    'rejects invalid session id %j before writing or consuming its token',
    async (sessionId) => {
      const root = await makeRoot()
      const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
      const token = owner.mintLocalToken()

      await expect(owner.bind(token, sessionId)).rejects.toThrow('Invalid WSL setup Session id.')
      await expect(readFile(join(root, 'wsl-setup-sessions.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(owner.authorizeToken(token)).toBe(true)

      await owner.bind(token, 'valid-session')
      await expect(owner.isBound('valid-session')).resolves.toBe(true)
    }
  )

  it('never mints or accepts setup authority off Windows', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'linux' })

    expect(() => owner.mintLocalToken()).toThrow(
      'WSL setup Sessions are only available on Windows.'
    )
    expect(owner.authorizeToken('id.secret')).toBe(false)
    await expect(owner.isBound('session-1')).resolves.toBe(false)
    await expect(owner.bind('id.secret', 'session-1')).rejects.toThrow(
      'WSL_SETUP_SESSION_TOKEN_INVALID'
    )
  })

  it('restores durable setup authority in a new owner after restart', async () => {
    const root = await makeRoot()
    const firstOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = firstOwner.mintLocalToken()
    await firstOwner.bind(token, 'durable-session')

    const restartedOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    await expect(restartedOwner.isBound('durable-session')).resolves.toBe(true)

    await restartedOwner.forget('durable-session')
    const afterForget = new WslSetupSessionOwner(root, { platform: 'win32' })
    await expect(afterForget.isBound('durable-session')).resolves.toBe(false)
  })

  it('projects only durable setup bindings into restart Session summaries', async () => {
    const root = await makeRoot()
    const firstOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = firstOwner.mintLocalToken()
    await firstOwner.bind(token, 'setup-session')
    firstOwner.commitBinding(token, 'setup-session')

    const restartedOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const summaries = await restartedOwner.projectSessionSummaries([
      { id: 'setup-session', title: 'Setup' },
      { id: 'ordinary-session', title: 'Ordinary' }
    ])

    expect(summaries).toEqual([
      { id: 'setup-session', title: 'Setup', wslSetup: true },
      { id: 'ordinary-session', title: 'Ordinary' }
    ])

    await restartedOwner.forget('setup-session')
    await expect(
      restartedOwner.projectSessionSummaries([{ id: 'setup-session', title: 'Setup' }])
    ).resolves.toEqual([{ id: 'setup-session', title: 'Setup' }])
  })

  it('removes crash-orphaned bindings that have no persisted app Session', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const retainedToken = owner.mintLocalToken()
    const orphanedToken = owner.mintLocalToken()
    await owner.bind(retainedToken, 'persisted-session')
    owner.commitBinding(retainedToken, 'persisted-session')
    await owner.bind(orphanedToken, 'crash-before-session-persist')

    await owner.reconcileBoundSessions(new Set(['persisted-session']))

    const restarted = new WslSetupSessionOwner(root, { platform: 'win32' })
    await expect(restarted.isBound('persisted-session')).resolves.toBe(true)
    await expect(restarted.isBound('crash-before-session-persist')).resolves.toBe(false)
  })

  it('does not grant live authority when the durable binding write fails', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()

    // Load the empty durable set, then make its parent unusable so only the persistence step fails.
    await expect(owner.isBound('unwritten-session')).resolves.toBe(false)
    await rm(root, { recursive: true })
    await writeFile(root, 'blocks the session document path')

    await expect(owner.bind(token, 'unwritten-session')).rejects.toThrow()
    await expect(owner.isBound('unwritten-session')).resolves.toBe(false)
    expect(owner.authorizeToken(token)).toBe(true)

    await rm(root)
    await mkdir(root)
    await owner.bind(token, 'unwritten-session')
    await expect(owner.isBound('unwritten-session')).resolves.toBe(true)
  })

  it('restores an unexpired token when a prepared binding rolls back', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()

    await owner.bind(token, 'failed-startup')
    expect(owner.authorizeToken(token)).toBe(false)
    await owner.rollbackBinding(token, 'failed-startup')

    await expect(owner.isBound('failed-startup')).resolves.toBe(false)
    expect(owner.authorizeToken(token)).toBe(true)
    await owner.bind(token, 'retried-startup')
    owner.commitBinding(token, 'retried-startup')
    expect(owner.authorizeToken(token)).toBe(false)
    await expect(owner.isBound('retried-startup')).resolves.toBe(true)
  })

  it('keeps prepared ownership valid across TTL while commit or rollback finishes', async () => {
    const root = await makeRoot()
    let now = 1_000
    const owner = new WslSetupSessionOwner(root, { platform: 'win32', now: () => now })
    const committedToken = owner.mintLocalToken()
    await owner.bind(committedToken, 'slow-commit')
    now += WSL_SETUP_SESSION_TOKEN_TTL_MS

    expect(() => owner.commitBinding(committedToken, 'slow-commit')).not.toThrow()
    await expect(owner.isBound('slow-commit')).resolves.toBe(true)

    const rolledBackToken = owner.mintLocalToken()
    await owner.bind(rolledBackToken, 'slow-rollback')
    now += WSL_SETUP_SESSION_TOKEN_TTL_MS
    await owner.rollbackBinding(rolledBackToken, 'slow-rollback')

    await expect(owner.isBound('slow-rollback')).resolves.toBe(false)
    expect(owner.authorizeToken(rolledBackToken)).toBe(false)
  })

  it('serializes concurrent consumption so exactly one session receives authority', async () => {
    const root = await makeRoot()
    const owner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const token = owner.mintLocalToken()

    const results = await Promise.allSettled([
      owner.bind(token, 'concurrent-a'),
      owner.bind(token, 'concurrent-b')
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const bound = await Promise.all([owner.isBound('concurrent-a'), owner.isBound('concurrent-b')])
    expect(bound.filter(Boolean)).toHaveLength(1)

    const restartedOwner = new WslSetupSessionOwner(root, { platform: 'win32' })
    const durable = await Promise.all([
      restartedOwner.isBound('concurrent-a'),
      restartedOwner.isBound('concurrent-b')
    ])
    expect(durable.filter(Boolean)).toHaveLength(1)
  })
})
