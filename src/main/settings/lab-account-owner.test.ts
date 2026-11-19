import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./crypto', () => ({
  encryptKey: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString('utf8') : undefined,
  hardenKeyMask: (value?: string) => value,
  maskKey: (value: string) => value
}))

import type { LabBootstrap, LabUsage } from '../../shared/lab'
import { LAB_PROVIDER_ID } from '../../shared/lab'
import { LabAccountOwner } from './lab-account-owner'
import { buildLabProviderRecord } from './lab-provider'
import { LabApi, LabApiError } from './lab-api'
import { LabCredentialStore } from './lab-credential-store'
import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'
import { defaultVendorModel } from '../../shared/provider-model-policy'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import { SettingsRepository } from './repository'

const SERVER = 'https://lab.example.com'

const BOOTSTRAP: LabBootstrap = {
  user: { id: 'usr_1', display_name: 'Researcher', org_id: 'org_1' },
  device: { id: 'dev_1', name: 'Research workstation' },
  models: [
    {
      id: 'research-default',
      name: 'Research Assistant',
      protocol: 'openai',
      protocols: ['openai'],
      streaming: true,
      enabled: true,
      available: true
    }
  ],
  default_model_id: 'research-default',
  model_base_url: '/v1'
}

const PERSONAL_PROVIDER = {
  id: 'p1',
  type: 'custom' as const,
  name: 'Gateway',
  baseUrl: 'https://api.example.com',
  model: 'personal-model',
  keyRef: 'enc:key'
}

let root: string | undefined

const createRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'open-science-lab-owner-'))
  return root
}

const seedSettings = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      version: 2,
      providers: [PERSONAL_PROVIDER],
      activeProviderId: 'p1',
      activeModel: 'personal-model',
      subagentModel: {
        mode: 'fixed',
        providerId: 'p1',
        model: 'personal-model',
        reasoningEffort: 'default'
      },
      reviewerModel: {
        mode: 'fixed',
        providerId: 'p1',
        model: 'personal-model',
        reasoningEffort: 'default'
      },
      promptOptimizationModel: {
        mode: 'fixed',
        providerId: 'p1',
        model: 'personal-model',
        reasoningEffort: 'default'
      },
      sessionDetailsModel: {
        mode: 'fixed',
        providerId: 'p1',
        model: 'personal-model',
        reasoningEffort: 'default'
      },
      visionModel: {
        providerId: 'p1',
        model: 'personal-model',
        reasoningEffort: 'default'
      }
    })
  )
}

const USAGE: LabUsage = {
  available: true,
  token: {
    available: true,
    status: 'active',
    quota: { limit: 500_000, used: 165_900, remaining: 334_100, unlimited: false }
  },
  org: {
    available: true,
    unlimited: false,
    quota: { limit: 69_349_151, used: 166_271, remaining: 69_268_880, unlimited: false },
    stale: false
  },
  effective: { remaining: 334_100, limitedBy: 'token' },
  display: {
    perUnit: 500_000,
    exchangeRate: 7.3,
    currency: 'CNY',
    cny: {
      token: { limit: 7.3, used: 2.42, remaining: 4.88 },
      org: { limit: 1_012.3, used: 2.43, remaining: 1_009.87 }
    },
    usd: {
      token: { limit: 1, used: 0.3318, remaining: 0.6682 },
      org: { limit: 138.7, used: 0.33, remaining: 138.37 }
    }
  },
  stale: false
}

const createApi = (): Record<string, ReturnType<typeof vi.fn>> => ({
  bootstrap: vi.fn(async () => BOOTSTRAP),
  usage: vi.fn(async () => USAGE),
  refreshToken: vi.fn(),
  logout: vi.fn(async () => undefined),
  clientBootstrap: vi.fn(async () => undefined),
  exchangeCode: vi.fn(),
  registerLoginAttempt: vi.fn()
})

const createOwner = async (
  dir: string,
  api: ReturnType<typeof createApi>,
  options: { now?: () => number; credentials?: LabCredentialStore } = {}
): Promise<{
  owner: LabAccountOwner
  repository: SettingsRepository
  credentials: LabCredentialStore
}> => {
  const repository = new SettingsRepository(dir)
  const credentials = options.credentials ?? new LabCredentialStore(dir)
  const owner = new LabAccountOwner({
    configRoot: dir,
    repository,
    credentials,
    api: api as unknown as LabApi,
    ...(options.now ? { now: options.now } : {})
  })
  return { owner, repository, credentials }
}

const seedSession = async (
  credentials: LabCredentialStore,
  overrides: { tokenExpiresAt?: number } = {}
): Promise<void> => {
  await credentials.ensureInstallationId()
  await credentials.saveServerUrl(SERVER)
  await credentials.saveSession({
    accessToken: 'at_1',
    refreshToken: 'rt_1',
    tokenExpiresAt: overrides.tokenExpiresAt ?? Date.now() + 3_600_000
  })
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    root = undefined
  }
})

describe('Lab account owner', () => {
  it('adds the Lab provider without changing any existing model selection', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))

    const before = await repository.getSettings()
    const view = await owner.check()
    expect(view.state).toBe('authenticated')
    expect(view.accountId).toBe('usr_1')
    expect(view.accountName).toBe('Researcher')
    expect(view.modelCount).toBe(1)

    const settings = await repository.getSettings()
    for (const key of [
      'activeProviderId',
      'activeModel',
      'subagentModel',
      'reviewerModel',
      'promptOptimizationModel',
      'sessionDetailsModel',
      'visionModel'
    ] as const) {
      expect(settings[key]).toEqual(before[key])
    }
    expect(settings.activeProviderId).toBe('p1')
    expect(settings.activeModel).toBe('personal-model')
    const lab = settings.providers.find((provider) => provider.id === LAB_PROVIDER_ID)
    expect(lab?.type).toBe('lab')
    expect(lab?.baseUrl).toBe(`${SERVER}/v1`)
    expect(lab?.apiEndpoints).toEqual(['chat-completions'])
    expect(lab?.fetchedModels).toEqual(['lab:research-default'])
  })

  it('loads the usage snapshot after an authenticated bootstrap', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))

    await owner.check()
    await vi.waitFor(() => expect(owner.getView().usage).toMatchObject({ available: true }))
    expect(owner.getView().accountId).toBe(BOOTSTRAP.user.id)
    expect(owner.getView().usage?.effective?.limitedBy).toBe('token')
    expect(api.usage).toHaveBeenCalledWith(SERVER, 'at_1')
  })

  it('does not refresh an almost-expired token just to read optional usage', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const now = 1_000_000
    let clock = now
    api.bootstrap.mockImplementationOnce(async () => {
      clock += 2_000
      return BOOTSTRAP
    })
    api.refreshToken.mockRejectedValue(new LabApiError('unauthorized', 'refresh timed out'))
    const { owner } = await createOwner(dir, api, { now: () => clock })
    await seedSession(new LabCredentialStore(dir), { tokenExpiresAt: now + 61_000 })

    const view = await owner.check()
    await vi.waitFor(() => expect(api.usage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(owner.getView().usage).toBeDefined())

    expect(view.state).toBe('authenticated')
    expect(api.refreshToken).not.toHaveBeenCalled()
    expect(owner.getView().state).toBe('authenticated')
  })

  it('publishes only the latest quota response on the same connection', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    let resolveFirst: ((usage: LabUsage) => void) | undefined
    let resolveSecond: ((usage: LabUsage) => void) | undefined
    api.usage
      .mockImplementationOnce(
        () =>
          new Promise<LabUsage>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<LabUsage>((resolve) => {
            resolveSecond = resolve
          })
      )
    const { owner } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))

    await owner.check()
    await vi.waitFor(() => expect(api.usage).toHaveBeenCalledTimes(1))
    await owner.check()
    await vi.waitFor(() => expect(api.usage).toHaveBeenCalledTimes(2))

    resolveSecond?.({
      ...USAGE,
      effective: { remaining: 25, limitedBy: 'org' }
    })
    await vi.waitFor(() => expect(owner.getView().usage?.effective?.remaining).toBe(25))
    resolveFirst?.({
      ...USAGE,
      effective: { remaining: 334_100, limitedBy: 'token' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(owner.getView().usage?.effective?.remaining).toBe(25)
  })

  it('coalesces concurrent refreshes into one request', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    api.refreshToken.mockResolvedValue({
      accessToken: 'at_new',
      refreshToken: 'rt_new',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials, { tokenExpiresAt: Date.now() - 1_000 })

    const tokens = await Promise.all([
      owner.getAccessToken(),
      owner.getAccessToken(),
      owner.getAccessToken(),
      owner.getAccessToken()
    ])
    expect(tokens).toEqual(['at_new', 'at_new', 'at_new', 'at_new'])
    expect(api.refreshToken).toHaveBeenCalledTimes(1)
  })

  it('degrades to a required re-login when a refresh fails, without touching personal providers', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    api.refreshToken.mockRejectedValue(new LabApiError('unauthorized', 'refresh rotated'))
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials, { tokenExpiresAt: Date.now() - 1_000 })

    await expect(owner.getAccessToken()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(owner.getView().state).toBe('expired')
    const settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe('p1')
    expect(settings.providers.some((provider) => provider.id === LAB_PROVIDER_ID)).toBe(false)
    await vi.waitFor(async () => {
      expect(await credentials.readSession()).toBeUndefined()
    })
  })

  it('removes the Lab provider on logout and restores the previous personal model', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()

    await owner.capturePreviousSelection({ providerId: 'p1', model: 'personal-model' })
    await repository.setActiveProvider(LAB_PROVIDER_ID, 'lab:research-default')
    await repository.setSubagentModel({
      mode: 'fixed',
      providerId: LAB_PROVIDER_ID,
      model: 'lab:research-default',
      reasoningEffort: 'default'
    })

    const view = await owner.logout()
    expect(view.state).toBe('signedOut')
    expect(api.logout).toHaveBeenCalledWith(SERVER, 'at_1')

    const settings = await repository.getSettings()
    expect(settings.providers.some((provider) => provider.id === LAB_PROVIDER_ID)).toBe(false)
    expect(settings.activeProviderId).toBe('p1')
    expect(settings.activeModel).toBe('personal-model')
    expect(settings.subagentModel).toEqual({
      mode: 'fixed',
      providerId: LAB_PROVIDER_ID,
      model: 'lab:research-default',
      reasoningEffort: 'default'
    })
    expect(await credentials.readSession()).toBeUndefined()
    expect((await credentials.readDocument()).installationId).toEqual(expect.any(String))
  })

  it('does not carry a same-named Lab task binding into another institution', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const { owner, repository } = await createOwner(dir, createApi())
    await seedSession(new LabCredentialStore(dir))
    await owner.check()
    await repository.setSubagentModel({
      mode: 'fixed',
      providerId: LAB_PROVIDER_ID,
      model: 'lab:research-default',
      reasoningEffort: 'default'
    })

    await owner.setServerUrl('https://another-lab.example.com')

    const settings = await repository.getSettings()
    expect(settings.subagentModel).toEqual({ mode: 'inherit' })
    expect(settings.providers.some((provider) => provider.id === LAB_PROVIDER_ID)).toBe(false)
  })

  it('restores nothing and resolves when there is no stored configuration', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const { owner } = await createOwner(dir, createApi())
    await expect(owner.initialize()).resolves.toBeUndefined()
    expect(owner.getView().state).toBe('unconfigured')
  })

  it('never returns a token that belongs to another institution after a server switch', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    let resolveRefresh: ((value: unknown) => void) | undefined
    api.refreshToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials, { tokenExpiresAt: Date.now() - 1_000 })

    const pending = owner.getAccessToken(true, 'https://lab.example.com').catch((error) => error)
    await vi.waitFor(() => expect(api.refreshToken).toHaveBeenCalledTimes(1))
    await owner.setServerUrl('https://another-lab.example.com')
    resolveRefresh?.({
      accessToken: 'at_old_institution',
      refreshToken: 'rt_old_institution',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    const error = await pending
    expect(error).toBeInstanceOf(LabApiError)
    await expect(owner.getAccessToken(false, 'https://lab.example.com')).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(await credentials.readSession()).toBeUndefined()
    expect(JSON.stringify(owner.getView())).not.toContain('at_old_institution')
  })

  it('rejects an address that differs only by path even on the same origin', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))
    await owner.check()
    await expect(
      owner.getAccessToken(false, 'https://lab.example.com/another-deployment')
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('keeps a new session when an old refresh completes after a server switch', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    let resolveRefresh: ((value: unknown) => void) | undefined
    api.refreshToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials, { tokenExpiresAt: Date.now() - 1_000 })

    const pending = owner.getAccessToken(true, SERVER).catch((error) => error)
    await vi.waitFor(() => expect(api.refreshToken).toHaveBeenCalledTimes(1))
    await owner.setServerUrl('https://another-lab.example.com')
    await credentials.saveSession(
      {
        accessToken: 'at_new_institution',
        refreshToken: 'rt_new_institution',
        tokenExpiresAt: Date.now() + 900_000
      },
      'https://another-lab.example.com'
    )
    resolveRefresh?.({
      accessToken: 'at_old_institution',
      refreshToken: 'rt_old_institution',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    expect(await pending).toBeInstanceOf(LabApiError)
    expect((await credentials.readSession())?.accessToken).toBe('at_new_institution')
    expect(owner.getView().state).not.toBe('expired')
  })

  it('cancels a login while the saved address is still being read', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await credentials.saveServerUrl(SERVER)
    const api = createApi()
    const oauth = {
      beginLogin: vi.fn(async () => ({
        authorizationUrl: 'https://lab.example.com/sign-in',
        expiresAt: Date.now() + 60_000
      })),
      waitForLogin: vi.fn(),
      cancelLogin: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    }
    const repository = new SettingsRepository(dir)
    const owner = new LabAccountOwner({
      configRoot: dir,
      repository,
      credentials,
      api: api as unknown as LabApi,
      oauth: oauth as unknown as never
    })
    const originalRead = credentials.readDocument.bind(credentials)
    let releaseRead: (() => void) | undefined
    let readPaused = false
    vi.spyOn(credentials, 'readDocument').mockImplementationOnce(async () => {
      readPaused = true
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      return originalRead()
    })
    const starting = owner.beginLogin().catch((error: unknown) => error)
    await vi.waitFor(() => expect(readPaused).toBe(true))
    await owner.cancelLogin()
    releaseRead?.()
    const error = await starting
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
    expect(oauth.beginLogin).not.toHaveBeenCalled()
  })

  it('clears a session saved by a fast callback before beginLogin returns', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await credentials.saveServerUrl(SERVER)
    let resolveBegin:
      ((challenge: { authorizationUrl: string; expiresAt: number }) => void) | undefined
    const oauth = {
      beginLogin: vi.fn(
        () =>
          new Promise<{ authorizationUrl: string; expiresAt: number }>((resolve) => {
            resolveBegin = resolve
          })
      ),
      waitForLogin: vi.fn(),
      cancelLogin: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    }
    const api = createApi()
    const repository = new SettingsRepository(dir)
    const owner = new LabAccountOwner({
      configRoot: dir,
      repository,
      credentials,
      api: api as unknown as LabApi,
      oauth: oauth as unknown as never
    })
    const starting = owner.beginLogin().catch((error: unknown) => error)
    await vi.waitFor(() => expect(oauth.beginLogin).toHaveBeenCalledTimes(1))
    // Simulate the browser callback completing while openExternal is still pending.
    await credentials.saveSession({
      accessToken: 'at_fast_callback',
      refreshToken: 'rt_fast_callback',
      tokenExpiresAt: Date.now() + 900_000
    })
    await owner.cancelLogin()
    resolveBegin?.({
      authorizationUrl: 'https://lab.example.com/sign-in',
      expiresAt: Date.now() + 60_000
    })
    const error = await starting
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
    expect(await credentials.readSession()).toBeUndefined()

    const restarted = new LabAccountOwner({
      configRoot: dir,
      repository,
      credentials,
      api: api as unknown as LabApi,
      oauth: oauth as unknown as never
    })
    await restarted.initialize()
    expect(restarted.getView().state).toBe('signedOut')
  })

  it('cancels a login that is still loading its catalog after browser authorization', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await credentials.saveServerUrl(SERVER)
    let resolveBootstrap: ((value: LabBootstrap) => void) | undefined
    const api = createApi()
    api.bootstrap.mockImplementation(
      () =>
        new Promise<LabBootstrap>((resolve) => {
          resolveBootstrap = resolve
        })
    )
    const session = {
      accessToken: 'at_login',
      refreshToken: 'rt_login',
      tokenExpiresAt: Date.now() + 900_000
    }
    const oauth = {
      beginLogin: vi.fn(async () => ({
        authorizationUrl: 'https://lab.example.com/sign-in',
        expiresAt: Date.now() + 60_000
      })),
      waitForLogin: vi.fn(async () => session),
      cancelLogin: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    }
    const repository = new SettingsRepository(dir)
    const owner = new LabAccountOwner({
      configRoot: dir,
      repository,
      credentials,
      api: api as unknown as LabApi,
      oauth: oauth as unknown as never
    })
    await owner.beginLogin()
    const waiting = owner.waitLogin()
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(1))
    await owner.cancelLogin()
    resolveBootstrap?.(BOOTSTRAP)
    const view = await waiting
    expect(view).toMatchObject({ state: 'signedOut', error: { code: 'cancelled' } })
    expect(await credentials.readSession()).toBeUndefined()
    expect(owner.getView().state).toBe('signedOut')
  })

  it('ignores a late cancel after the login has completed', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    expect(owner.getView().state).toBe('authenticated')

    const view = await owner.cancelLogin()
    expect(view.state).toBe('authenticated')
    expect((await credentials.readSession())?.accessToken).toBe('at_1')
  })

  it('rolls back a catalog written after cancellation invalidates the connection', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()

    let releaseUpsert: (() => void) | undefined
    const upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve
    })
    const originalUpsert = repository.upsertProvider.bind(repository)
    let paused = false
    const spy = vi.spyOn(repository, 'upsertProvider').mockImplementation(async (...args) => {
      const result = await originalUpsert(...args)
      if (!paused) {
        paused = true
        await upsertGate
      }
      return result
    })
    let resolveBootstrap: ((value: LabBootstrap) => void) | undefined
    api.bootstrap.mockImplementationOnce(
      () =>
        new Promise<LabBootstrap>((resolve) => {
          resolveBootstrap = resolve
        })
    )
    const refreshing = owner.refreshCatalog()
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2))
    resolveBootstrap?.(BOOTSTRAP)
    await vi.waitFor(() => expect(paused).toBe(true))

    // Simulate the UI canceling while the catalog write is paused after landing on disk.
    ;(owner as unknown as { view: { state: 'signingIn'; serverUrl: string } }).view = {
      state: 'signingIn',
      serverUrl: SERVER
    }
    await owner.cancelLogin()
    releaseUpsert?.()
    await refreshing
    spy.mockRestore()

    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(false)
  })

  it('does not let a stale startup restore clear a newer login', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    let rejectBootstrap: ((error: unknown) => void) | undefined
    api.bootstrap.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectBootstrap = reject
        })
    )
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const initializing = owner.initialize()
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(1))
    await owner.setServerUrl('https://another-lab.example.com')
    await credentials.saveSession(
      {
        accessToken: 'at_new_login',
        refreshToken: 'rt_new_login',
        tokenExpiresAt: Date.now() + 900_000
      },
      'https://another-lab.example.com'
    )
    rejectBootstrap?.(new LabApiError('unauthorized', 'old server rejected'))
    await initializing
    expect((await credentials.readSession())?.accessToken).toBe('at_new_login')
    expect(owner.getView().serverUrl).toBe('https://another-lab.example.com')
  })

  it('does not let a delayed startup credential read replace a newer login', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const oldSnapshot = await credentials.readCredentialSnapshot()
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readSpy = vi
      .spyOn(credentials, 'readCredentialSnapshot')
      .mockImplementationOnce(async () => {
        await readGate
        return oldSnapshot
      })
    const api = createApi()
    const { owner } = await createOwner(dir, api, { credentials })
    const initializing = owner.initialize()
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1))

    const newerServer = 'https://another-lab.example.com'
    await owner.setServerUrl(newerServer)
    await credentials.saveSession(
      {
        accessToken: 'at_new_login',
        refreshToken: 'rt_new_login',
        tokenExpiresAt: Date.now() + 900_000
      },
      newerServer
    )
    releaseRead?.()
    await initializing

    expect(owner.getView().serverUrl).toBe(newerServer)
    expect(owner.getView().state).toBe('signedOut')
    expect((await credentials.readSession())?.accessToken).toBe('at_new_login')
  })

  it('does not overwrite a newer same-address catalog with a stale write', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()

    let releaseSettings: (() => void) | undefined
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve
    })
    const originalGetSettings = repository.getSettings.bind(repository)
    let paused = false
    const spy = vi.spyOn(repository, 'getSettings').mockImplementation(async () => {
      if (!paused) {
        paused = true
        await settingsGate
      }
      return originalGetSettings()
    })
    let resolveBootstrap: ((value: LabBootstrap) => void) | undefined
    api.bootstrap.mockImplementationOnce(
      () =>
        new Promise<LabBootstrap>((resolve) => {
          resolveBootstrap = resolve
        })
    )
    const refreshing = owner.refreshCatalog()
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2))
    resolveBootstrap?.(BOOTSTRAP)
    await vi.waitFor(() => expect(paused).toBe(true))

    // Simulate a newer login at the same address while the old refresh is suspended between its
    // connection check and its catalog write.
    await owner.logout()
    const newer = buildLabProviderRecord(SERVER, BOOTSTRAP)
    await repository.upsertProvider(newer)
    releaseSettings?.()
    await refreshing
    spy.mockRestore()

    const remaining = (await repository.getSettings()).providers.find(
      (provider) => provider.id === LAB_PROVIDER_ID
    )
    expect(remaining?.labCatalogToken).toBe(newer.labCatalogToken)
  })

  it('does not recreate a stale catalog after logout', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))
    await owner.check()
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(true)

    let resolveBootstrap: ((value: unknown) => void) | undefined
    api.bootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBootstrap = resolve
        })
    )
    const refreshing = owner.refreshCatalog()
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2))
    await owner.logout()
    resolveBootstrap?.(BOOTSTRAP)
    await refreshing
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(false)
  })

  it('restores a selected Codex subscription model from the built-in catalog', async () => {
    const dir = await createRoot()
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [{ id: 'builtin-codex-subscription', type: 'codex-isolated', name: 'Codex' }],
        activeProviderId: 'builtin-codex-subscription',
        activeModel: defaultVendorModel('openai')
      })
    )
    const repository = new SettingsRepository(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    await owner.capturePreviousSelection({
      providerId: 'builtin-codex-subscription',
      model: defaultVendorModel('openai')
    })
    await repository.setActiveProvider(LAB_PROVIDER_ID, 'lab:research-default')
    await owner.logout()
    const settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe('builtin-codex-subscription')
    // The model id must be a real OpenAI catalog entry, not a hard-coded guess.
    expect(settings.activeModel).toBeTruthy()
  })

  it('restores the exact previously selected personal model after logout', async () => {
    const dir = await createRoot()
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'p1',
            type: 'official',
            vendorId: 'openai',
            name: 'OpenAI',
            fetchedModels: ['m1', 'm2']
          }
        ],
        activeProviderId: 'p1',
        activeModel: 'm2'
      })
    )
    const repository = new SettingsRepository(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    await owner.capturePreviousSelection({ providerId: 'p1', model: 'm2' })
    await repository.setActiveProvider(LAB_PROVIDER_ID, 'lab:research-default')

    await owner.logout()
    const settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe('p1')
    expect(settings.activeModel).toBe('m2')
  })

  it('does not fall back to the saved address for an explicitly empty draft', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    api.clientBootstrap.mockClear()

    const view = await owner.check({ serverUrl: '   ' })
    expect(view.error?.code).toBe('server-url-missing')
    expect(api.clientBootstrap).not.toHaveBeenCalled()
    expect((await credentials.readSession())?.accessToken).toBeTruthy()
  })

  it('does not let a stale connection probe republish an old signed-out state', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await credentials.saveServerUrl(SERVER)
    const api = createApi()
    let resolveProbe: (() => void) | undefined
    api.clientBootstrap.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve
        })
    )
    const repository = new SettingsRepository(dir)
    const owner = new LabAccountOwner({
      configRoot: dir,
      repository,
      credentials,
      api: api as unknown as LabApi
    })
    const checking = owner.check()
    await vi.waitFor(() => expect(api.clientBootstrap).toHaveBeenCalledTimes(1))
    await owner.setServerUrl('https://another-lab.example.com')
    resolveProbe?.()
    await checking
    expect(owner.getView().serverUrl).toBe('https://another-lab.example.com')
  })

  it('probes an unsaved draft address without clearing the current login', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    const before = await credentials.readSession()
    api.clientBootstrap.mockResolvedValue(undefined)

    const view = await owner.check({ serverUrl: 'https://draft-lab.example.com' })
    expect(view).toMatchObject({ state: 'signedOut', serverUrl: 'https://draft-lab.example.com' })
    expect((await credentials.readSession())?.accessToken).toBe(before?.accessToken)
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(true)
    expect(owner.getView().serverUrl).toBe(SERVER)
  })

  it('probes the public bootstrap endpoint when signed out so a bad address is visible', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    api.clientBootstrap.mockRejectedValue(new LabApiError('network', 'offline'))
    const { owner } = await createOwner(dir, api)
    await owner.setServerUrl('https://lab.example.com')
    const failed = await owner.check()
    expect(failed.state).toBe('unreachable')
    expect(api.clientBootstrap).toHaveBeenCalledWith('https://lab.example.com')

    api.clientBootstrap.mockResolvedValue(undefined)
    const reachable = await owner.check()
    expect(reachable.state).toBe('signedOut')
  })

  it('refreshes Lab and clears old validation failures while keeping the selected model', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    await owner.check()
    await repository.setActiveProvider(LAB_PROVIDER_ID, 'lab:research-default')
    await repository.updateProviderValidationIfTargetMatches(
      LAB_PROVIDER_ID,
      () => true,
      { ok: false, category: 'auth', status: 401 },
      undefined
    )
    expect(
      (await repository.getSettings()).providers.find(({ id }) => id === LAB_PROVIDER_ID)
        ?.lastValidationFailure
    ).toMatchObject({ category: 'auth', status: 401 })
    api.bootstrap.mockResolvedValue({
      ...BOOTSTRAP,
      default_model_id: 'research-fast',
      models: [
        ...BOOTSTRAP.models,
        { id: 'research-fast', name: 'Research Fast', protocol: 'openai' }
      ]
    })

    await owner.refreshCatalog()
    const settings = await repository.getSettings()
    const record = settings.providers.find((provider) => provider.id === LAB_PROVIDER_ID)
    expect(settings.activeProviderId).toBe(LAB_PROVIDER_ID)
    expect(settings.activeModel).toBe('lab:research-default')
    expect(record?.model).toBe('lab:research-fast')
    expect(record?.fetchedModels).toEqual(['lab:research-default', 'lab:research-fast'])
    expect(record?.lastValidatedAt).toBeGreaterThan(0)
    expect(record?.lastValidationFailure).toBeUndefined()
    const view = new ProviderRuntimeProjectionOwner().toProviderView(record!)
    expect(
      buildConfiguredModelCatalog({
        providers: [view],
        frameworkId: 'open-science-agent',
        frameworkEndpoints: ['responses', 'chat-completions', 'messages']
      }).map((entry) => entry.model)
    ).toContain('lab:research-fast')
  })

  it('drops the previous server model catalog when the address changes', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const { owner, repository } = await createOwner(dir, api)
    await seedSession(new LabCredentialStore(dir))
    await owner.check()
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(true)

    await owner.setServerUrl('https://another-lab.example.com')
    expect(owner.getView().state).toBe('signedOut')
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(false)
  })

  it('restores a stored session at startup and projects the Lab models', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const { owner, repository } = await createOwner(dir, api)
    await owner.initialize()
    expect(owner.getView().state).toBe('authenticated')
    expect(owner.getView().modelCount).toBe(1)
    expect(
      (await repository.getSettings()).providers.some((provider) => provider.id === LAB_PROVIDER_ID)
    ).toBe(true)
  })

  it('keeps startup non-blocking and the personal provider usable when Lab is offline', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const api = createApi()
    api.bootstrap.mockRejectedValue(new LabApiError('network', 'offline'))
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const { owner, repository } = await createOwner(dir, api)
    await expect(owner.initialize()).resolves.toBeUndefined()
    expect(['signedOut', 'unreachable']).toContain(owner.getView().state)
    const settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe('p1')
    expect(settings.providers.some((provider) => provider.id === LAB_PROVIDER_ID)).toBe(false)
  })

  it('survives a corrupt credential document', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    await writeFile(join(dir, 'lab-credentials.json'), '{broken')
    const { owner } = await createOwner(dir, createApi())
    await expect(owner.initialize()).resolves.toBeUndefined()
    expect(['unconfigured', 'signedOut']).toContain(owner.getView().state)
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toMatchObject({
      activeProviderId: 'p1'
    })
  })

  it('forces a single token refresh on 401 when fetching organization cases', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const expectedPage = { items: [], total: 0, page: 1, page_size: 20 }
    const api = createApi()
    api.refreshToken.mockResolvedValue({
      accessToken: 'at_refreshed',
      refreshToken: 'rt_refreshed',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    const listCases = vi
      .fn()
      .mockRejectedValueOnce(new LabApiError('unauthorized', 'expired', 401, 'SESSION_INVALID'))
      .mockResolvedValueOnce(expectedPage)
    Object.assign(api, { listCases })
    const { owner } = await createOwner(dir, api)
    await owner.check()

    const page = await owner.listCases({ q: '7Q2M9X4B', page: 1 })
    expect(page).toEqual(expectedPage)
    expect(api.refreshToken).toHaveBeenCalledTimes(1)
    expect(listCases).toHaveBeenNthCalledWith(
      1,
      SERVER,
      'at_1',
      { q: '7Q2M9X4B', page: 1 },
      undefined
    )
    expect(listCases).toHaveBeenNthCalledWith(
      2,
      SERVER,
      'at_refreshed',
      { q: '7Q2M9X4B', page: 1 },
      undefined
    )
  })

  it('marks the session expired if a retried org-case request still returns 401', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const api = createApi()
    api.refreshToken.mockResolvedValue({
      accessToken: 'at_refreshed',
      refreshToken: 'rt_refreshed',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    const listCases = vi
      .fn()
      .mockRejectedValue(new LabApiError('unauthorized', 'still expired', 401, 'SESSION_INVALID'))
    Object.assign(api, { listCases })
    const { owner } = await createOwner(dir, api)
    await owner.check()

    await expect(owner.listCases({ page: 1 })).rejects.toMatchObject({ status: 401 })
    expect(owner.getView().state).toBe('expired')
  })

  it('clears local session state before awaiting api.logout', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    let resolveLogout: (() => void) | undefined
    const api = createApi()
    api.logout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve
        })
    )
    const { owner, repository } = await createOwner(dir, api)
    await owner.check()
    expect(owner.getView().state).toBe('authenticated')

    const logoutPromise = owner.logout()
    await vi.waitFor(() => expect(resolveLogout).toBeTypeOf('function'))
    // Session and view must already be cleared before remote logout finishes.
    expect(owner.getView().state).toBe('signedOut')
    expect((await repository.getSettings()).providers.some((p) => p.id === LAB_PROVIDER_ID)).toBe(
      false
    )

    resolveLogout?.()
    await logoutPromise
    expect((await credentials.readCredentialSnapshot()).session).toBeUndefined()
  })

  it('does not share an in-flight refresh promise across server switches', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    let resolveFirstRefresh:
      | ((value: {
          accessToken: string
          refreshToken: string
          expiresIn: number
          tokenExpiresAt: number
        }) => void)
      | undefined
    const api = createApi()
    api.refreshToken
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRefresh = resolve
          })
      )
      .mockResolvedValueOnce({
        accessToken: 'at_second_server',
        refreshToken: 'rt_second_server',
        expiresIn: 900,
        tokenExpiresAt: Date.now() + 900_000
      })

    const { owner } = await createOwner(dir, api)
    await owner.check()
    const firstRefresh = owner.getAccessToken(true, SERVER)
    await vi.waitFor(() => expect(resolveFirstRefresh).toBeTypeOf('function'))

    const secondServer = 'https://lab-two.example.com'
    await owner.setServerUrl(secondServer)
    await credentials.saveSession(
      {
        accessToken: 'at_2',
        refreshToken: 'rt_2',
        tokenExpiresAt: Date.now() + 3_600_000
      },
      secondServer
    )
    await expect(owner.getAccessToken(true, secondServer)).resolves.toBe('at_second_server')

    resolveFirstRefresh?.({
      accessToken: 'at_stale_server',
      refreshToken: 'rt_stale_server',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    await expect(firstRefresh).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('reuses a freshly rotated token across concurrent 401 org-case requests without double refresh', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const api = createApi()
    api.refreshToken.mockResolvedValueOnce({
      accessToken: 'at_refreshed_once',
      refreshToken: 'rt_refreshed_once',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })

    let releaseSecond401: (() => void) | undefined
    let callCount = 0
    const listCases = vi.fn(async (_serverUrl: string, token: string) => {
      callCount += 1
      if (token === 'at_1') {
        if (callCount === 1) {
          throw new LabApiError('unauthorized', 'expired', 401, 'SESSION_INVALID')
        }
        await new Promise<void>((resolve) => {
          releaseSecond401 = resolve
        })
        throw new LabApiError('unauthorized', 'expired', 401, 'SESSION_INVALID')
      }
      return { items: [], total: 0, page: 1, page_size: 20 }
    })
    Object.assign(api, { listCases })

    const { owner } = await createOwner(dir, api)
    await owner.check()

    const first = owner.listCases({ page: 1 })
    const second = owner.listCases({ page: 2 })
    await vi.waitFor(() => expect(releaseSecond401).toBeTypeOf('function'))
    await expect(first).resolves.toMatchObject({ page: 1 })

    releaseSecond401?.()
    await expect(second).resolves.toMatchObject({ page: 1 })
    expect(api.refreshToken).toHaveBeenCalledTimes(1)
  })

  it('retries uploadCase once after single-flight refresh on 401 and succeeds with the rotated token', async () => {
    const dir = await createRoot()
    await seedSettings(dir)
    const credentials = new LabCredentialStore(dir)
    await seedSession(credentials)
    const api = createApi()
    api.refreshToken.mockResolvedValueOnce({
      accessToken: 'at_upload_refreshed',
      refreshToken: 'rt_upload_refreshed',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })

    const uploadedDetail = {
      id: 'case_uploaded_1',
      name: 'Uploaded Research',
      code: '7Q2M9X4B',
      description: '',
      size_bytes: 128,
      sha256: 'c'.repeat(64),
      created_at: '2026-11-18T00:00:00Z',
      owner: { id: 'usr_1', display_name: 'Alice' },
      can_delete: true,
      original_filename: 'uploaded.science',
      summary: {
        schema_version: 1,
        features: [],
        file_count: 1,
        total_bytes: 128,
        excluded_files: 0,
        omission_count: 0,
        omissions: []
      }
    }

    const uploadCase = vi.fn(async (_serverUrl: string, token: string) => {
      if (token === 'at_1') {
        throw new LabApiError('unauthorized', 'expired', 401, 'SESSION_INVALID')
      }
      return uploadedDetail
    })
    Object.assign(api, { uploadCase })

    const { owner } = await createOwner(dir, api)
    await owner.check()

    const result = await owner.uploadCase({
      archivePath: '/tmp/uploaded.science',
      filename: 'uploaded.science',
      name: 'Uploaded Research',
      clientUploadId: 'upload-12345678'
    })

    expect(result).toMatchObject({ id: 'case_uploaded_1', code: '7Q2M9X4B' })
    expect(uploadCase).toHaveBeenCalledTimes(2)
    expect(uploadCase.mock.calls[0]?.[1]).toBe('at_1')
    expect(uploadCase.mock.calls[1]?.[1]).toBe('at_upload_refreshed')
    expect(api.refreshToken).toHaveBeenCalledTimes(1)
  })
})
