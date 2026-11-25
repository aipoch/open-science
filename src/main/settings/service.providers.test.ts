import { configureTestElectronHost } from '../../../test/runtime-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Unit service tests do not start installed coding agents; the native probe has its own coverage.
vi.mock('../acp/agent-process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/agent-process')>()),
  isClaudeAgentAcpAvailable: () => true,
  resolveClaudeAgentAcpEntry: () => '/fixture/claude-acp'
}))

vi.mock('./provider-acp-validation', () => ({
  ProviderAcpValidator: class {
    validate = vi.fn(async () => ({
      ok: false,
      category: 'unknown',
      message: 'test runtime unavailable'
    }))
    dispose = vi.fn(async () => undefined)
  }
}))

vi.mock('electron', () => ({
  net: { fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

import { configureCredentialStore } from './credential-store-mode'
const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')

describe('SettingsService provider facade', () => {
  it('keeps API provider discovery read-only and separates a verified save from activation', async () => {
    const key = 'synthetic-task-provider-key'
    const framework = 'opencode'
    const model = 'test-model'
    const setup = (request: unknown): ReturnType<typeof service.bootstrap> =>
      service.bootstrap(request, () => undefined)
    const options = { action: 'provider-options', framework }
    const draft = {
      action: 'provider-save',
      providerType: 'custom',
      framework,
      model,
      baseUrl: 'https://gateway.example/v1',
      protocol: 'chat-completions'
    }
    const response = (body: unknown, status = 200): Response => Response.json(body, { status })
    const probe = vi.fn(async (url: string, init?: RequestInit) => {
      const configuredKey = new Headers(init?.headers).get('authorization')
      return url === 'https://gateway.example/v1/chat/completions' &&
        configuredKey === `Bearer ${key}`
        ? response({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        : response({ error: { message: `Rejected ${configuredKey}` } }, 401)
    })
    vi.stubGlobal('fetch', probe)
    try {
      expect(await setup(options)).toMatchObject({
        ok: true,
        providerOptions: {
          framework,
          selectedFramework: null,
          active: { providerId: null, model: null },
          providers: [],
          official: expect.arrayContaining([
            expect.objectContaining({
              vendorId: 'openai',
              models: expect.arrayContaining([
                expect.objectContaining({
                  id: 'gpt-5.4',
                  compatible: false,
                  credentialRequired: true
                })
              ])
            }),
            expect.objectContaining({
              vendorId: 'anthropic',
              models: expect.arrayContaining([
                expect.objectContaining({
                  id: 'claude-haiku-4-5-20251001',
                  compatible: true,
                  credentialRequired: true
                })
              ])
            })
          ])
        }
      })
      expect(probe).not.toHaveBeenCalled()
      expect(await setup({ ...draft, key })).toEqual({ ok: false, code: 'configuration_conflict' })
      await repository.setAgentFramework(framework)
      expect(await setup(draft)).toEqual({ ok: false, code: 'provider_credential_missing' })
      expect(await setup({ ...draft, credentialRef: 'missing-ref' })).toEqual({
        ok: false,
        code: 'credential_invalid'
      })
      const failed = await setup({ ...draft, key: 'rejected-key' })
      expect(failed).toEqual({ ok: false, code: 'provider_validation_failed', category: 'auth' })
      expect(JSON.stringify(failed)).not.toContain('rejected-key')
      expect(await setup(options)).toMatchObject({ ok: true, providerOptions: { providers: [] } })

      const { createdCredential } = await service.createDeviceCredential({
        displayName: 'Synthetic gateway key',
        kind: 'api_key',
        secret: key
      })
      const saved = await setup({ ...draft, credentialRef: createdCredential.id })
      expect(saved).toMatchObject({
        ok: true,
        providerSetup: { model, framework, saved: true, active: false, validation: 'passed' }
      })
      if (!saved.ok || !saved.providerSetup) throw new Error('Missing saved provider identity')
      const { providerId } = saved.providerSetup
      const selection = {
        action: 'provider-activate',
        framework,
        providerId,
        model,
        expectedActiveProviderId: null,
        expectedActiveModel: null
      }
      const before = await setup(options)
      expect(before).toMatchObject({
        ok: true,
        providerOptions: {
          active: { providerId: null, model: null },
          providers: [
            { id: providerId, models: [expect.objectContaining({ id: model, compatible: true })] }
          ]
        }
      })
      expect(JSON.stringify(before)).not.toContain(key)
      expect(await setup({ ...selection, model: 'other-model' })).toEqual({
        ok: false,
        code: 'provider_validation_failed',
        category: 'model-not-found'
      })
      expect(await setup(selection)).toMatchObject({
        ok: true,
        providerSetup: {
          providerId,
          model,
          framework,
          saved: true,
          active: true,
          validation: 'passed'
        }
      })
      expect(await setup(selection)).toEqual({ ok: false, code: 'configuration_conflict' })
      expect(await setup(options)).toMatchObject({
        ok: true,
        providerOptions: { active: { providerId, model } }
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resolves official wire protocols and saves only to the original terminal target', async () => {
    const key = 'synthetic-terminal-key'
    const framework = 'open-science-agent'
    const providerId = '53a8ae2b-957e-452d-b127-2e0b867e5314'
    const setup = (request: unknown): ReturnType<typeof service.bootstrap> =>
      service.bootstrap(request, () => undefined)
    const terminal = { action: 'provider-credential-target', framework, providerId }
    await repository.setAgentFramework(framework)
    for (const { vendorId, model, protocol } of [
      { vendorId: 'anthropic', model: 'claude-haiku-4-5-20251001', protocol: 'messages' },
      { vendorId: 'openai', model: 'gpt-5.4', protocol: 'responses' }
    ]) {
      expect(await setup({ ...terminal, providerType: 'official', vendorId, model })).toMatchObject(
        {
          ok: true,
          providerCredentialTarget: {
            protocol,
            endpoint: expect.stringMatching(new RegExp(`/${protocol}$`))
          }
        }
      )
    }

    const draft = {
      ...terminal,
      providerType: 'custom',
      model: 'local-test-model',
      baseUrl: 'http://127.0.0.1:43210',
      protocol: 'chat-completions'
    }
    const probe = vi.fn(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).get('authorization') === `Bearer ${key}`
        ? Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        : Response.json({ error: { message: 'Rejected key' } }, { status: 401 })
    )
    vi.stubGlobal('fetch', probe)
    try {
      expect(await setup(draft)).toEqual({
        ok: true,
        providerCredentialTarget: {
          protocol: 'chat-completions',
          endpoint: 'http://127.0.0.1:43210/v1/chat/completions'
        }
      })
      const save = {
        ...draft,
        action: 'provider-save',
        key,
        expectedProtocol: 'chat-completions',
        expectedEndpoint: 'http://127.0.0.1:43210/v1/chat/completions'
      }
      expect(await setup({ ...save, expectedProtocol: 'responses' })).toEqual({
        ok: false,
        code: 'configuration_conflict'
      })
      expect(
        await setup({ ...save, expectedEndpoint: 'http://127.0.0.1:9999/v1/chat/completions' })
      ).toEqual({
        ok: false,
        code: 'configuration_conflict'
      })
      expect(probe).not.toHaveBeenCalled()
      expect(await setup({ ...save, key: 'wrong-key' })).toMatchObject({
        ok: false,
        category: 'auth'
      })
      expect(await setup({ action: 'provider-options' })).toMatchObject({
        providerOptions: { providers: [] }
      })
      expect(await setup(save)).toMatchObject({
        ok: true,
        providerSetup: {
          providerId,
          model: draft.model,
          saved: true,
          validation: 'passed',
          active: false
        }
      })
      expect(await setup(draft)).toEqual({ ok: false, code: 'configuration_conflict' })
      expect(await setup({ ...save, key: 'another-key' })).toEqual({
        ok: false,
        code: 'configuration_conflict'
      })
      const options = await setup({ action: 'provider-options' })
      expect(options).toMatchObject({
        providerOptions: {
          active: { providerId: null, model: null },
          providers: [
            { id: providerId, lastValidated: { model: draft.model, protocol: draft.protocol } }
          ]
        }
      })
      expect(JSON.stringify(options)).not.toContain(key)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the newer active provider when an activation probe overlaps another selection', async () => {
    const framework = 'opencode'
    const model = 'gateway-model'
    await repository.setAgentFramework(framework)
    for (const id of ['requested', 'selected-later']) {
      await service.upsertProvider({
        id,
        type: 'custom',
        model,
        baseUrl: 'http://127.0.0.1:43110/v1',
        apiEndpoints: ['chat-completions']
      })
    }
    const waiting = Promise.withResolvers<Response>()
    const probe = vi.fn(() => waiting.promise)
    vi.stubGlobal('fetch', probe)
    try {
      const activation = service.bootstrap(
        {
          action: 'provider-activate',
          framework,
          model,
          providerId: 'requested',
          expectedActiveProviderId: null,
          expectedActiveModel: null
        },
        () => undefined
      )
      await expect.poll(() => probe.mock.calls.length).toBe(1)
      await service.setActiveProvider('selected-later', model)
      waiting.resolve(
        Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
      )
      expect(await activation).toEqual({ ok: false, code: 'configuration_conflict' })
      expect((await service.getSettingsView()).activeProviderId).toBe('selected-later')
    } finally {
      waiting.resolve(new Response(null, { status: 502 }))
      vi.unstubAllGlobals()
    }
  })

  it('returns updated health without claiming a configuration commit when unchanged saved credentials fail', async () => {
    await repository.setAgentFramework('opencode')
    await service.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['chat-completions']
    })
    const before = (await service.getSettingsView()).providers[0]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 }))
    )
    try {
      const result = await service.saveValidatedProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Unsaved rename',
        requireExisting: true
      })
      expect(result.providerId).toBeUndefined()
      expect(result.validation).toMatchObject({
        ok: false,
        category: 'auth',
        status: 403,
        applied: true
      })
      expect(result.snapshot?.providers[0]).toMatchObject({
        id: before.id,
        name: before.name,
        configRevision: before.configRevision,
        lastValidationFailure: { category: 'auth', status: 403 }
      })
      expect(JSON.stringify(result)).not.toContain('existing-secret')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns the committed provider identity when snapshot refresh fails', async () => {
    await repository.setAgentFramework('opencode')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
          )
      )
    )
    vi.spyOn(service, 'getSettingsView').mockRejectedValueOnce(new Error('Snapshot unavailable'))
    try {
      const result = await service.saveValidatedProvider({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://gateway.example/v1',
        model: 'test-model',
        key: 'synthetic-key',
        apiEndpoints: ['chat-completions']
      })
      expect(result).toMatchObject({ validation: { ok: true }, providerId: expect.any(String) })
      expect(result.snapshot).toBeUndefined()
      const restored = new SettingsService({
        repository: new SettingsRepository(dir),
        configRoot: dir
      })
      expect((await restored.getSettingsView()).providers).toEqual([
        expect.objectContaining({ id: result.providerId, name: 'Gateway' })
      ])
      expect(JSON.stringify(result)).not.toContain('synthetic-key')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { framework: 'claude-code', endpoint: 'messages', route: 'claude-anthropic' },
    { framework: 'opencode', endpoint: 'chat-completions', route: 'opencode-openai' },
    { framework: 'codex', endpoint: 'responses', route: 'codex-responses-compatibility' },
    { framework: 'codex', endpoint: 'chat-completions', route: 'codex-bridge' },
    { framework: 'codebuddy', endpoint: 'chat-completions', route: 'codebuddy-openai' }
  ] as const)(
    'resolves the saved custom model through $route after an edit',
    async ({ framework, endpoint, route }) => {
      await repository.setAgentFramework(framework)
      const draft = {
        id: 'custom-edit',
        type: 'custom' as const,
        name: 'Custom',
        baseUrl: 'https://gateway.example/v1',
        model: 'old-model',
        apiEndpoints: [endpoint],
        key: 'synthetic-key'
      }
      await service.upsertProvider(draft)
      await repository.setActiveProvider(draft.id, draft.model)
      const snapshot = await service.upsertProvider({
        ...draft,
        model: 'new-model',
        key: undefined,
        requireExisting: true,
        expectedConfigRevision: 1
      })
      expect(snapshot.activeModel).toBe('new-model')
      const restored = new SettingsService({
        repository: new SettingsRepository(dir),
        configRoot: dir
      })
      expect(await restored.resolveActiveModelChangeTarget()).toMatchObject({
        frameworkId: framework,
        providerId: draft.id,
        route,
        model: 'new-model'
      })
    }
  )

  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let service: InstanceType<typeof SettingsService>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-service-providers-facade-'))
    repository = new SettingsRepository(dir)
    service = new SettingsService({ repository, configRoot: dir })
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not suggest installing Codex in a fresh built-in profile', async () => {
    const before = await repository.getSettings()
    expect(await service.bootstrap({ action: 'status' }, () => {})).toEqual({
      ok: true,
      selectedFramework: null,
      keylessKiloAvailable: true,
      next: {}
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it('builds read-only bootstrap recovery for the selected active model', async () => {
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: 'cli-openai',
      name: 'OpenAI',
      type: 'official',
      vendorId: 'openai',
      model: 'gpt-5.4'
    })
    await repository.setActiveProvider('cli-openai', 'gpt-5.4-mini')
    const before = await repository.getSettings()
    expect(await service.bootstrap({ action: 'status' }, () => {})).toMatchObject({
      ok: true,
      next: {
        provider: [
          'provider',
          'add',
          '--type',
          'official',
          '--vendor',
          'openai',
          '--model',
          'gpt-5.4-mini',
          '--api-key-env',
          'OPENAI_API_KEY',
          '--json'
        ]
      }
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it('projects file storage capability and leaves legacy refs unchanged', async () => {
    configureCredentialStore(['--credential-store=file'], 'linux', true)
    try {
      const legacyRef = `plain:${Buffer.from('legacy-key').toString('base64')}`
      await repository.upsertProvider({
        id: 'legacy',
        type: 'custom',
        name: 'Legacy',
        keyRef: legacyRef
      })
      const snapshot = await service.getSettingsView()
      expect(snapshot.credentialStore).toBe('file')
      expect(service.isEncryptionAvailable()).toBe(true)
      expect((await repository.getSettings()).providers[0].keyRef).toBe(legacyRef)
    } finally {
      configureCredentialStore([], 'linux', true)
    }
  })

  it('keeps provider key migration on the existing whole-settings read path', async () => {
    const legacyRef = `plain:${Buffer.from('legacy-key', 'utf8').toString('base64')}`
    await repository.upsertProvider({
      id: 'legacy-provider',
      type: 'custom',
      name: 'Legacy',
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      apiEndpoints: ['chat-completions'],
      keyRef: legacyRef,
      keyMask: 'le•••••ey'
    })

    await service.getConnectors()
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toContain(legacyRef)

    const snapshot = await service.getSettingsView()
    const stored = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(stored).not.toContain(legacyRef)
    expect(stored).toContain('enc:')
    expect(snapshot.providers[0]).toMatchObject({
      id: 'legacy-provider',
      maskedKey: '••••••••',
      hasKey: true,
      needsKey: false
    })
    expect(JSON.stringify(snapshot)).not.toContain('legacy-key')
  })

  it('preserves the shared id suffix sequence across providers and runtime installs', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123)
    const facade = new SettingsService({
      repository,
      configRoot: dir,
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'expected test failure' }
      })
    })

    try {
      const first = await facade.upsertProvider({
        type: 'custom',
        name: 'First',
        baseUrl: 'https://first.example/v1',
        model: 'first-model',
        key: 'first-key',
        apiEndpoints: ['chat-completions']
      })
      expect(first.providers[0]?.id).toBe('p_123_1')

      const install = await facade.installClaude({ source: 'managed' }, () => undefined)
      expect(install.installId).toBe('install-123-2')

      const second = await facade.upsertProvider({
        type: 'custom',
        name: 'Second',
        baseUrl: 'https://second.example/v1',
        model: 'second-model',
        key: 'second-key',
        apiEndpoints: ['chat-completions']
      })
      expect(second.providers.find((provider) => provider.name === 'Second')?.id).toBe('p_123_3')
    } finally {
      now.mockRestore()
    }
  })
})

await configureTestElectronHost(await import('electron'))
