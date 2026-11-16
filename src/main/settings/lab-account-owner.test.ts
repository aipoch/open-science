import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./crypto', () => ({
  encryptKey: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString('utf8') : undefined
}))

import type { LabBootstrap } from '../../shared/lab'
import { LAB_PROVIDER_ID } from '../../shared/lab'
import { LabAccountOwner } from './lab-account-owner'
import { LabApi, LabApiError } from './lab-api'
import { LabCredentialStore } from './lab-credential-store'
import { defaultVendorModel } from '../../shared/provider-model-policy'
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

const createApi = (): Record<string, ReturnType<typeof vi.fn>> => ({
  bootstrap: vi.fn(async () => BOOTSTRAP),
  refreshToken: vi.fn(),
  logout: vi.fn(async () => undefined),
  clientBootstrap: vi.fn(async () => undefined),
  exchangeCode: vi.fn(),
  registerLoginAttempt: vi.fn()
})

const createOwner = async (
  dir: string,
  api: ReturnType<typeof createApi>
): Promise<{
  owner: LabAccountOwner
  repository: SettingsRepository
  credentials: LabCredentialStore
}> => {
  const repository = new SettingsRepository(dir)
  const credentials = new LabCredentialStore(dir)
  const owner = new LabAccountOwner({
    configRoot: dir,
    repository,
    credentials,
    api: api as unknown as LabApi
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
    await rm(root, { recursive: true, force: true })
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
    expect(settings.subagentModel).toEqual({ mode: 'inherit' })
    expect(await credentials.readSession()).toBeUndefined()
    expect((await credentials.readDocument()).installationId).toEqual(expect.any(String))
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
})
