import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  net: { fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-app', isPackaged: false }
}))

import { ProviderAccountsModule } from './provider-accounts'
import { SettingsDocumentStore } from './document-store'
import { SettingsRepository } from './repository'
import { encryptKey, tryDecryptKey } from './crypto'
import { XAI_SUBSCRIPTION_PROVIDER_ID, type UpsertProviderRequest } from '../../shared/settings'

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const draft: UpsertProviderRequest = {
  type: 'custom',
  name: 'Original',
  key: 'old-key',
  baseUrl: 'https://lab.example/v1',
  model: 'model-a',
  apiEndpoints: ['anthropic']
}

const discovery = {
  issuer: 'https://auth.x.ai',
  device_authorization_endpoint: 'https://auth.x.ai/device',
  token_endpoint: 'https://auth.x.ai/token',
  userinfo_endpoint: 'https://auth.x.ai/userinfo'
}

// Real accounts, encrypted references and serialized file storage; only HTTP and scheduling vary.
describe('provider completion races', () => {
  let dir: string
  let document: SettingsDocumentStore
  let repository: SettingsRepository
  let accounts: ProviderAccountsModule

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'provider-completion-'))
    document = new SettingsDocumentStore(dir)
    repository = new SettingsRepository(document)
    let sequence = 0
    accounts = new ProviderAccountsModule({
      repository,
      storageRoot: dir,
      userClaudeDir: join(dir, 'claude'),
      userCodexDir: join(dir, 'codex'),
      allocateSettingsIdSequence: () => ++sequence,
      resolveCodexExecutable: async () => '/unused',
      resolveCodexProxyEnvironment: async () => undefined,
      runClaudeSubscriptionProbe: async () => ({ ok: true, category: 'ok' })
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await accounts.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // Pause the next public document mutation before its serialized callback runs. No private
  // method replacement and no timing-dependent race: both old upsert and conditional writes use it.
  const pauseCommit = (): { entered: Promise<void>; release: () => void } => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const mutate = document.mutate.bind(document)
    vi.spyOn(document, 'mutate').mockImplementationOnce(async (update) => {
      entered.resolve()
      await release.promise
      return mutate(update)
    })
    return { entered: entered.promise, release: () => release.resolve() }
  }

  it.each(['edit', 'delete'] as const)(
    'M01: a queued validation cannot undo a completed %s',
    async (operation) => {
      await accounts.upsertProvider(draft)
      const original = (await repository.getSettings()).providers[0]
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'pong' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        )
      )
      const commit = pauseCommit()
      const pending = accounts.validateProvider({ providerId: original.id })
      await commit.entered
      if (operation === 'edit') {
        await accounts.upsertProvider({ ...draft, id: original.id, name: 'Edited', key: 'new-key' })
      } else {
        await accounts.deleteProvider(original.id)
      }
      const expected = (await repository.getSettings()).providers
      commit.release()
      const result = await pending
      expect.soft((await repository.getSettings()).providers).toEqual(expected)
      expect(result).toMatchObject({ ok: true, applied: false })
    }
  )

  it.each(['cancel', 'logout'] as const)(
    'M02: %s during userinfo prevents late login persistence and caching',
    async (operation) => {
      await accounts.upsertProvider({ type: 'xai-subscription' })
      const entered = deferred<void>()
      const email = deferred<Response>()
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('openid-configuration')) return Response.json(discovery)
          if (url === discovery.device_authorization_endpoint)
            return Response.json({
              device_code: 'device',
              user_code: 'ABCD',
              verification_uri: 'https://auth.x.ai/activate',
              interval: 1,
              expires_in: 900
            })
          if (url === discovery.userinfo_endpoint) {
            entered.resolve()
            return email.promise // Intentionally ignores abort, as a late response can do.
          }
          return Response.json({ access_token: 'late-access', refresh_token: 'late-refresh' })
        })
      )
      await accounts.beginXaiOAuthLogin()
      const pending = accounts.waitXaiOAuthLogin().then(
        () => 'signed in',
        () => 'cancelled'
      )
      await entered.promise
      if (operation === 'cancel') accounts.cancelXaiOAuthLogin()
      else await accounts.logoutXaiOAuth()
      email.resolve(Response.json({ email: 'test@example.com' }))
      const outcome = await pending
      expect.soft((await repository.getSettings()).providers[0].keyRef).toBeUndefined()
      expect.soft(await accounts.getXaiOAuthAccessToken().catch(() => undefined)).toBeUndefined()
      expect(outcome).toBe('cancelled')
    }
  )

  it.each(['cancel', 'logout'] as const)(
    'M02: %s also invalidates a login already queued for storage',
    async (operation) => {
      await accounts.upsertProvider({ type: 'xai-subscription' })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('openid-configuration')) return Response.json(discovery)
          if (url === discovery.device_authorization_endpoint)
            return Response.json({
              device_code: 'device',
              user_code: 'ABCD',
              verification_uri: 'https://auth.x.ai/activate',
              interval: 1,
              expires_in: 900
            })
          if (url === discovery.userinfo_endpoint) return Response.json({})
          return Response.json({ access_token: 'late-access', refresh_token: 'late-refresh' })
        })
      )
      await accounts.beginXaiOAuthLogin()
      const commit = pauseCommit()
      const pending = accounts.waitXaiOAuthLogin().then(
        () => 'signed in',
        () => 'cancelled'
      )
      await commit.entered
      // Logout queues behind the account save; cancel invalidates it synchronously.
      const logout = operation === 'logout' ? accounts.logoutXaiOAuth() : undefined
      if (operation === 'cancel') accounts.cancelXaiOAuthLogin()
      commit.release()
      const outcome = await pending
      await logout
      expect.soft((await repository.getSettings()).providers[0].keyRef).toBeUndefined()
      expect(outcome).toBe('cancelled')
    }
  )

  it('M01: an xAI validation cannot mark credentials from a later login as verified', async () => {
    await accounts.upsertProvider({ type: 'xai-subscription' })
    const original = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...original, keyRef: encryptKey('old-refresh') })
    let login = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('openid-configuration')) return Response.json(discovery)
        if (url === discovery.device_authorization_endpoint)
          return Response.json({
            device_code: 'device',
            user_code: 'ABCD',
            verification_uri: 'https://auth.x.ai/activate',
            interval: 1,
            expires_in: 900
          })
        if (url === discovery.token_endpoint)
          return Response.json({
            access_token: login ? 'new-access' : 'old-access',
            refresh_token: login ? 'new-refresh' : 'old-refresh'
          })
        return Response.json({})
      })
    )
    await accounts.getXaiOAuthAccessToken()
    const commit = pauseCommit()
    const validation = accounts.validateProvider({ providerId: original.id })
    await commit.entered
    login = true
    await accounts.beginXaiOAuthLogin()
    await accounts.waitXaiOAuthLogin()
    commit.release()
    expect.soft(await validation).toMatchObject({ ok: true, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(tryDecryptKey(stored.keyRef)).toBe('new-refresh')
    expect(stored.lastValidatedAt).toBeUndefined()
  })

  it('M03: normal xAI refresh rotation applies the catalog it reports as loaded', async () => {
    await accounts.upsertProvider({ type: 'xai-subscription' })
    const original = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...original, keyRef: encryptKey('old-refresh') })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('openid-configuration')) return Response.json(discovery)
        if (url === discovery.token_endpoint)
          return Response.json({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh'
          })
        return Response.json({ data: [{ id: 'grok-audit-new' }] })
      })
    )
    const result = await accounts.refreshProviderModels({
      providerId: XAI_SUBSCRIPTION_PROVIDER_ID
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(tryDecryptKey(stored.keyRef)).toBe('rotated-refresh')
    expect(result).toMatchObject({ ok: true, models: ['grok-audit-new'] })
    expect(stored.fetchedModels).toEqual(['grok-audit-new'])
  })
})
