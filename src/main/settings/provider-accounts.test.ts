import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type { ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort, ClaudeSharedAuthStatus } from './claude-shared-auth'
import type { XaiOAuthControllerPort } from './xai-oauth'
import type { ValidateProviderResult } from '../../shared/settings'
import type { ResolvedProvider } from './provider-env'
import type { StoredSettings } from './types'
import { getAgentFramework } from '../agent-framework'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'

vi.mock('electron', () => ({
  net: {
    fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { ProviderAccountsModule } = await import('./provider-accounts')
const { SettingsRepository } = await import('./repository')

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('ProviderAccountsModule', () => {
  it.each(['test', 'save'] as const)(
    'marks an unchanged saved provider unavailable after %s receives 403 without changing its configuration',
    async (operation) => {
      await repository.setAgentFramework('opencode')
      await module.upsertProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Original',
        baseUrl: 'https://gateway.example/v1',
        model: 'model-a',
        key: 'existing-secret',
        apiEndpoints: ['openai']
      })
      await module.setActiveProvider('gateway', 'model-a')
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
            )
        )
      )
      expect((await module.validateProvider({ providerId: 'gateway' })).ok).toBe(true)
      const before = await repository.getSettings()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Forbidden', { status: 403 }))
      )
      const edit = {
        id: 'gateway',
        type: 'custom' as const,
        name: 'Unsaved rename',
        key: '',
        requireExisting: true,
        expectedConfigRevision: before.providers[0].configRevision
      }
      const result =
        operation === 'test'
          ? await module.validateProvider({ edit })
          : (await module.saveValidatedProvider(edit)).validation
      expect(result).toMatchObject({ ok: false, category: 'auth', status: 403, applied: true })
      const after = await new SettingsRepository(dir).getSettings()
      expect(after.providers[0].lastValidationFailure).toMatchObject({
        category: 'auth',
        status: 403
      })
      expect(after.providers[0].lastValidationFailure?.target).toBeUndefined()
      expect(after.providers[0].lastValidatedAt).toBeUndefined()
      expect(after).toEqual({
        ...before,
        providers: [
          {
            ...before.providers[0],
            lastValidatedAt: undefined,
            lastValidatedTarget: undefined,
            lastValidationFailure: after.providers[0].lastValidationFailure
          }
        ]
      })
    }
  )

  it.each([
    { key: 'different-secret' },
    { baseUrl: 'https://different.example/v1' },
    { model: 'different-model' },
    { apiEndpoints: ['responses' as const] }
  ])('does not poison the saved provider when a changed candidate fails: %j', async (change) => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['openai']
    })
    const before = await repository.getSettings()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 }))
    )
    const edit = { id: 'gateway', type: 'custom' as const, requireExisting: true, ...change }
    expect((await module.validateProvider({ edit })).ok).toBe(false)
    expect((await module.saveValidatedProvider(edit)).providerId).toBeUndefined()
    expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
  })

  it.each([429, 500])(
    'does not invalidate a saved connection after a transient edit test HTTP %s',
    async (status) => {
      await repository.setAgentFramework('opencode')
      await module.upsertProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Original',
        baseUrl: 'https://gateway.example/v1',
        model: 'model-a',
        key: 'existing-secret',
        apiEndpoints: ['openai']
      })
      await repository.updateProviderValidationIfTargetMatches(
        'gateway',
        () => true,
        { ok: true, category: 'ok' },
        { model: 'model-a', endpoint: 'openai' }
      )
      const before = await repository.getSettings()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Try later', { status }))
      )
      const edit = { id: 'gateway', type: 'custom' as const, requireExisting: true }
      expect((await module.validateProvider({ edit })).ok).toBe(false)
      expect((await module.saveValidatedProvider(edit)).providerId).toBeUndefined()
      expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
    }
  )

  it.each(['config', 'validation', 'delete'] as const)(
    'discards a same-target edit failure after a concurrent %s change',
    async (change) => {
      await repository.setAgentFramework('opencode')
      await module.upsertProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Original',
        baseUrl: 'https://gateway.example/v1',
        model: 'model-a',
        key: 'existing-secret',
        apiEndpoints: ['openai']
      })
      const response = deferred<Response>()
      const started = deferred<void>()
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          started.resolve()
          return response.promise
        })
      )
      const pending = module.saveValidatedProvider({
        id: 'gateway',
        type: 'custom',
        requireExisting: true
      })
      await started.promise
      if (change === 'config')
        await module.upsertProvider({
          id: 'gateway',
          type: 'custom',
          model: 'new-model',
          requireExisting: true
        })
      else if (change === 'delete') await module.deleteProvider('gateway')
      else
        await repository.updateProviderValidationIfTargetMatches(
          'gateway',
          () => true,
          { ok: true, category: 'ok' },
          { model: 'model-a', endpoint: 'openai' }
        )
      const before = await repository.getSettings()
      response.resolve(new Response('Forbidden', { status: 403 }))
      expect((await pending).validation).toMatchObject({ ok: false, applied: false })
      expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
    }
  )

  it('limits unchanged edit missing-model failures to the tested model and route', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['openai']
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Model model-a not found' } }), {
            status: 404
          })
      )
    )
    const result = await module.validateProvider({
      edit: { id: 'gateway', type: 'custom', requireExisting: true }
    })
    expect(result).toMatchObject({ ok: false, category: 'model-not-found', applied: true })
    expect((await repository.getSettings()).providers[0].lastValidationFailure?.target).toEqual({
      model: 'model-a',
      endpoint: 'openai'
    })
  })

  it.each(['failure', 'success'] as const)(
    'does not commit an older successful save over a newer same-connection %s',
    async (newer) => {
      await repository.setAgentFramework('opencode')
      await module.upsertProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Original',
        baseUrl: 'https://gateway.example/v1',
        model: 'model-a',
        key: 'existing-secret',
        apiEndpoints: ['openai']
      })
      const olderResponse = deferred<Response>()
      const started = deferred<void>()
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => {
            started.resolve()
            return olderResponse.promise
          })
          .mockImplementation(async () =>
            newer === 'failure'
              ? new Response('Forbidden', { status: 403 })
              : new Response(
                  JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
                )
          )
      )
      const pending = module.saveValidatedProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Older rename',
        requireExisting: true
      })
      await started.promise
      expect(
        await module.validateProvider(
          newer === 'failure'
            ? { edit: { id: 'gateway', type: 'custom', requireExisting: true } }
            : { providerId: 'gateway' }
        )
      ).toMatchObject({ ok: newer === 'success', applied: true })
      const before = await repository.getSettings()
      olderResponse.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        )
      )
      await expect(pending).rejects.toThrow('Provider connection status changed')
      expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
    }
  )

  it('checks same-connection validation evidence inside the atomic configuration commit', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['openai']
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
          )
      )
    )
    const queued = deferred<void>()
    const release = deferred<void>()
    const commit = repository.upsertProvider.bind(repository)
    vi.spyOn(repository, 'upsertProvider').mockImplementationOnce(async (...args) => {
      queued.resolve()
      await release.promise
      return commit(...args)
    })
    const pending = module.saveValidatedProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Older rename',
      requireExisting: true
    })
    await queued.promise
    await repository.updateProviderValidationIfTargetMatches(
      'gateway',
      () => true,
      { ok: false, category: 'auth', status: 403 },
      undefined
    )
    const before = await repository.getSettings()
    release.resolve()
    await expect(pending).rejects.toThrow('Provider connection status changed')
    expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
  })

  it('preserves an unrelated failed model when saving the same explicitly entered key', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['openai']
    })
    await repository.updateProviderValidationIfTargetMatches(
      'gateway',
      () => true,
      { ok: false, category: 'model-not-found', status: 404 },
      { model: 'model-b', endpoint: 'openai' }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
          )
      )
    )
    const result = await module.saveValidatedProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Renamed gateway',
      key: 'existing-secret',
      requireExisting: true
    })
    expect(result.providerId).toBe('gateway')
    const saved = (await new SettingsRepository(dir).getSettings()).providers[0]
    expect(saved.name).toBe('Renamed gateway')
    expect(saved.lastValidatedTarget).toEqual({ model: 'model-a', endpoint: 'openai' })
    expect(saved.lastValidationFailure).toMatchObject({
      category: 'model-not-found',
      target: { model: 'model-b', endpoint: 'openai' }
    })
  })

  it('rejects saved-provider success that predates runtime failure but permits a later recovery', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-a',
      key: 'existing-secret',
      apiEndpoints: ['openai']
    })
    const started = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        started.resolve()
        return response.promise
      })
    )
    const pending = module.validateProvider({ providerId: 'gateway' })
    await started.promise
    await repository.updateProviderValidationIfTargetMatches(
      'gateway',
      () => true,
      { ok: false, category: 'auth', status: 403 },
      undefined
    )
    response.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OK' } }]
        })
      )
    )
    expect(await pending).toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toMatchObject({
      category: 'auth',
      status: 403
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'OK' } }]
            })
          )
      )
    )
    expect(await module.validateProvider({ providerId: 'gateway' })).toMatchObject({
      ok: true,
      applied: true
    })
    expect(
      (await new SettingsRepository(dir).getSettings()).providers[0].lastValidationFailure
    ).toBeUndefined()
  })

  it('rejects an invalid new provider without persisting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }))
    )
    const result = await module.saveValidatedProvider({
      type: 'custom',
      name: 'Invalid',
      baseUrl: 'https://gateway.example/v1',
      model: 'test-model',
      key: 'secret',
      apiEndpoints: ['openai']
    })
    expect(result.validation.ok).toBe(false)
    expect(result.providerId).toBeUndefined()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('tests form values with the stored key without changing the active custom provider', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      key: 'stored-secret',
      apiEndpoints: ['openai']
    })
    await module.setActiveProvider('gateway', 'old-model')
    const before = await repository.getSettings()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await module.validateProvider({
      edit: {
        id: 'gateway',
        type: 'custom',
        name: 'Edited',
        model: 'new-model',
        baseUrl: 'https://new.example/v1',
        key: '',
        requireExisting: true,
        expectedConfigRevision: before.providers[0].configRevision
      }
    })
    expect(result.testedTarget).toEqual({ model: 'new-model', endpoint: 'openai' })
    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://new.example/v1/chat/completions')
    expect(JSON.parse(String(init.body)).model).toBe('new-model')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer stored-secret')
    expect(await repository.getSettings()).toEqual(before)
  })

  it('atomically saves tested credentials and the active custom model with the actual tested route', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      key: 'old-secret',
      apiEndpoints: ['openai']
    })
    await module.setActiveProvider('gateway', 'old-model')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
          )
      )
    )
    const result = await module.saveValidatedProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Edited',
      model: 'new-model',
      baseUrl: 'https://new.example/v1',
      key: 'new-secret',
      apiEndpoints: ['anthropic', 'openai'],
      requireExisting: true
    })
    expect(result.validation.ok).toBe(true)
    expect(result.providerId).toBe('gateway')
    const saved = await new SettingsRepository(dir).getSettings()
    expect(saved.activeModel).toBe('new-model')
    expect(saved.providers[0]).toMatchObject({
      model: 'new-model',
      baseUrl: 'https://new.example/v1',
      lastValidatedTarget: { model: 'new-model', endpoint: 'openai' }
    })
    expect(module.resolveProvider(saved.providers[0]).key).toBe('new-secret')
  })

  it('records the route actually probed for the current framework', async () => {
    await repository.setAgentFramework('claude-code')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'OK' }],
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          )
      )
    )
    const result = await module.saveValidatedProvider({
      type: 'custom',
      name: 'Mixed gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'test-model',
      key: 'secret',
      apiEndpoints: ['anthropic', 'responses']
    })
    expect(result.validation.ok).toBe(true)
    expect((await repository.getSettings()).providers[0].lastValidatedTarget).toEqual({
      model: 'test-model',
      endpoint: 'anthropic'
    })
  })

  it('returns bounded diagnostics with echoed credentials redacted before truncation', async () => {
    const key = 'synthetic-private-provider-credential-123456789'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'x'.repeat(280) + key + 'y'.repeat(1000) } }),
            { status: 500 }
          )
      )
    )
    const result = await module.validateProvider({
      edit: {
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://gateway.example/v1',
        model: 'model',
        key,
        apiEndpoints: ['openai']
      }
    })
    expect(result.message).not.toContain('synthetic-private')
    expect(result.message).toContain('[redacted]')
    expect(result.message!.length).toBeLessThanOrEqual(301)
  })

  it('preserves the active official model selection and saved key during a validated edit', async () => {
    await repository.setAgentFramework('claude-code')
    await module.upsertProvider({
      id: 'official',
      type: 'official',
      vendorId: 'anthropic',
      name: 'Anthropic',
      key: 'official-secret'
    })
    await module.setActiveProvider('official', 'claude-sonnet-5')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'OK' }],
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          )
      )
    )
    const result = await module.saveValidatedProvider({
      id: 'official',
      type: 'official',
      name: 'Renamed',
      key: '',
      requireExisting: true
    })
    expect(result.validation.ok).toBe(true)
    const saved = await repository.getSettings()
    expect(saved.activeModel).toBe('claude-sonnet-5')
    expect(module.resolveProvider(saved.providers[0]).key).toBe('official-secret')
  })

  it('does not let an older saved-provider test undo a successful validated rename', async () => {
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'model',
      key: 'secret',
      apiEndpoints: ['openai']
    })
    const response = deferred<Response>()
    const started = deferred<void>()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => {
          started.resolve()
          return response.promise
        })
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
            )
        )
    )
    const older = module.validateProvider({ providerId: 'gateway' })
    await started.promise
    expect(
      (
        await module.saveValidatedProvider({
          id: 'gateway',
          type: 'custom',
          name: 'Renamed',
          requireExisting: true
        })
      ).validation.ok
    ).toBe(true)
    response.resolve(new Response('Invalid credentials', { status: 401 }))
    expect(await older).toMatchObject({ ok: false, applied: false })
    const saved = (await repository.getSettings()).providers[0]
    expect(saved.lastValidationFailure).toBeUndefined()
    expect(saved.lastValidatedAt).toEqual(expect.any(Number))
  })

  it.each(['delete', 'edit'] as const)(
    'never commits a stale successful save after a concurrent %s',
    async (action) => {
      await repository.setAgentFramework('opencode')
      await module.upsertProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Original',
        baseUrl: 'https://gateway.example/v1',
        model: 'old-model',
        key: 'secret',
        apiEndpoints: ['openai']
      })
      const response = deferred<Response>()
      const started = deferred<void>()
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          started.resolve()
          return response.promise
        })
      )
      const pending = module.saveValidatedProvider({
        id: 'gateway',
        type: 'custom',
        name: 'Stale edit',
        model: 'stale-model',
        requireExisting: true
      })
      await started.promise
      if (action === 'delete') await repository.deleteProvider('gateway')
      else
        await module.upsertProvider({
          id: 'gateway',
          type: 'custom',
          name: 'Newer edit',
          model: 'new-model'
        })
      response.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        )
      )
      await expect(pending).rejects.toThrow(
        action === 'delete' ? 'no longer exists' : 'configuration changed'
      )
      const saved = (await repository.getSettings()).providers
      if (action === 'delete') expect(saved).toEqual([])
      else expect(saved[0]).toMatchObject({ name: 'Newer edit', model: 'new-model' })
    }
  )

  it('preserves an invalid saved configuration when both testing and saving a different invalid edit', async () => {
    await module.upsertProvider({
      id: 'gateway',
      type: 'custom',
      name: 'Original',
      baseUrl: 'https://gateway.example/v1',
      model: 'old-model',
      key: 'secret',
      apiEndpoints: ['openai']
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Invalid key', { status: 401 }))
    )
    await module.validateProvider({ providerId: 'gateway' })
    const before = await repository.getSettings()
    const edit = {
      id: 'gateway',
      type: 'custom' as const,
      name: 'Rename',
      key: 'different-secret',
      requireExisting: true
    }
    expect((await module.validateProvider({ edit })).ok).toBe(false)
    expect((await module.saveValidatedProvider(edit)).providerId).toBeUndefined()
    expect(await repository.getSettings()).toEqual(before)
  })

  it('rejects ambiguous validation targets before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      module.validateProvider({ providerId: 'existing', edit: { type: 'custom' } })
    ).rejects.toThrow('one provider validation target')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { active: false, model: 'old-model' },
    { active: true, model: 'old-model' },
    { active: false, model: 'new-model' },
    { active: true, model: 'new-model' }
  ])(
    'uses edited custom credentials and model after persistence ($active, $model)',
    async ({ active, model }) => {
      await repository.setAgentFramework('opencode')
      const original = {
        id: 'edited-custom',
        type: 'custom' as const,
        name: 'Gateway',
        baseUrl: 'https://old.example/v1',
        model: 'old-model',
        key: 'old-key',
        apiEndpoints: ['openai' as const]
      }
      await module.upsertProvider(original)
      if (active) await module.setActiveProvider(original.id, original.model)
      const before = (await repository.getSettings()).providers[0]
      const draft = { ...original, baseUrl: 'https://new.example/v1', model, key: 'new-key' }
      await module.upsertProvider({
        ...draft,
        requireExisting: true,
        expectedConfigRevision: before.configRevision
      })
      const restored = (await new SettingsRepository(dir).getSettings()).providers[0]
      expect(restored).toMatchObject({ baseUrl: draft.baseUrl, model: draft.model })
      expect(module.resolveProvider(restored).key).toBe(draft.key)
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body))
        const accepted = headers.get('authorization') === 'Bearer new-key' && body.model === model
        return new Response(
          JSON.stringify(
            accepted
              ? { choices: [{ message: { role: 'assistant', content: 'OK' } }] }
              : { error: { message: 'invalid credentials for model' } }
          ),
          { status: accepted ? 200 : 401 }
        )
      })
      vi.stubGlobal('fetch', fetchMock)
      try {
        const result = await module.validateProvider({ providerId: original.id })
        expect(fetchMock).toHaveBeenCalledWith(
          'https://new.example/v1/chat/completions',
          expect.anything()
        )
        const sent = fetchMock.mock.calls[0][1]!
        expect(new Headers(sent.headers).get('authorization')).toBe('Bearer new-key')
        // An explicit model and an identical newly created provider both work; only the saved
        // active selection can override the edited record in the ID-only Settings probe.
        expect(await module.validateProvider({ providerId: original.id, model })).toMatchObject({
          ok: true
        })
        await module.upsertProvider({ ...draft, id: 'new-custom' })
        expect(await module.validateProvider({ providerId: 'new-custom' })).toMatchObject({
          ok: true
        })
        expect(JSON.parse(String(sent.body)).model).toBe(model)
        expect(result).toMatchObject({ ok: true })
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it('publishes only validated API credentials, repeats safely, and refuses replacement', async () => {
    await repository.setAgentFramework('codex')
    const validate = vi
      .spyOn(module, 'validateProvider')
      .mockResolvedValue({ ok: true, category: 'ok' })
    await module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')
    const first = await repository.getSettings()
    await module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')
    const restored = await new SettingsRepository(dir).getSettings()
    expect(restored.providers).toHaveLength(1)
    expect(restored.providers[0].keyRef).toBe(first.providers[0].keyRef)
    expect(restored.providers[0].lastValidatedTarget).toEqual({
      model: 'gpt-5.4',
      endpoint: 'responses'
    })
    expect(restored.activeProviderId).toBe('cli-openai')
    await expect(module.bootstrapOpenAi('different-key', 'gpt-5.4')).rejects.toMatchObject({
      code: 'configuration_conflict'
    })
    expect(await repository.getSettings()).toEqual(restored)
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('revalidates the selected model without replacing the provider default or key', async () => {
    await repository.setAgentFramework('codex')
    const validate = vi
      .spyOn(module, 'validateProvider')
      .mockResolvedValue({ ok: true, category: 'ok' })
    await module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')
    const existing = (await repository.getSettings()).providers[0]
    const keyRef = existing.keyRef
    await repository.upsertProvider({ ...existing, name: 'My research account' })
    await repository.setActiveProvider('cli-openai', 'gpt-5.4-mini')
    await expect(module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')).rejects.toMatchObject({
      code: 'configuration_conflict'
    })
    await module.bootstrapOpenAi('synthetic-key', 'gpt-5.4-mini')
    expect(validate).toHaveBeenLastCalledWith({
      draft: { type: 'official', vendorId: 'openai', model: 'gpt-5.4-mini', key: 'synthetic-key' }
    })
    const saved = await new SettingsRepository(dir).getSettings()
    expect(saved.activeModel).toBe('gpt-5.4-mini')
    expect(saved.providers[0]).toMatchObject({
      model: 'gpt-5.4',
      name: 'My research account',
      keyRef,
      lastValidatedTarget: { model: 'gpt-5.4-mini', endpoint: 'responses' }
    })
    validate.mockImplementation(async () => {
      await repository.setActiveProvider('cli-openai', 'gpt-5.4')
      return { ok: true, category: 'ok' }
    })
    await expect(module.bootstrapOpenAi('synthetic-key', 'gpt-5.4-mini')).rejects.toMatchObject({
      code: 'configuration_conflict'
    })
    expect((await repository.getSettings()).activeModel).toBe('gpt-5.4')
  })

  it.each([undefined, 'cli-openai'])(
    'rejects bootstrap with coexisting providers when active provider is %s',
    async (activeProviderId) => {
      await repository.setAgentFramework('codex')
      const validate = vi
        .spyOn(module, 'validateProvider')
        .mockResolvedValue({ ok: true, category: 'ok' })
      await module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')
      await repository.upsertProvider({
        id: 'other-openai',
        name: 'Existing account',
        type: 'official',
        vendorId: 'openai',
        model: 'gpt-5.4'
      })
      await repository.setActiveProvider(activeProviderId)
      const before = await repository.getSettings()
      validate.mockClear()
      await expect(module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')).rejects.toMatchObject({
        code: 'configuration_conflict'
      })
      expect(validate).not.toHaveBeenCalled()
      expect(await new SettingsRepository(dir).getSettings()).toEqual(before)
    }
  )

  it('does not publish API credentials if Settings changes during the probe', async () => {
    await repository.setAgentFramework('codex')
    vi.spyOn(module, 'validateProvider').mockImplementation(async () => {
      await repository.setAgentFramework('opencode')
      return { ok: true, category: 'ok' }
    })
    await expect(module.bootstrapOpenAi('synthetic-key', 'gpt-5.4')).rejects.toMatchObject({
      code: 'configuration_conflict'
    })
    expect((await repository.getSettings()).providers).toEqual([])
  })
  it('bootstraps an app-owned CLI login without deleting authentication and restores it after restart', async () => {
    await repository.setAgentFramework('codex')
    const home = codexSubscriptionStorageDir(dir)
    await mkdir(home, { recursive: true })
    const auth = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-cli-token' })
    await writeFile(join(home, 'auth.json'), auth)
    await module.prepareBootstrapCodex()
    expect((await repository.getSettings()).activeProviderId).toBeUndefined()
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(auth)
    await module.completeBootstrapCodex()
    await module.prepareBootstrapCodex()
    await module.completeBootstrapCodex()
    const restored = await new SettingsRepository(dir).getSettings()
    expect(restored.providers).toHaveLength(1)
    expect(restored.activeProviderId).toBe('builtin-codex-subscription')
    expect(restored.providers[0].lastValidatedAt).toEqual(expect.any(Number))
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(auth)
  })

  it('does not activate rejected subscription credentials', async () => {
    await repository.setAgentFramework('codex')
    await module.prepareBootstrapCodex()
    vi.mocked(codexAuth.getStatus).mockResolvedValue({
      mode: 'isolated',
      supported: true,
      authenticated: false
    })
    await expect(module.completeBootstrapCodex()).rejects.toMatchObject({
      code: 'credential_invalid'
    })
    expect((await repository.getSettings()).activeProviderId).toBeUndefined()
  })

  it('does not activate a login if Settings changed during validation', async () => {
    await repository.setAgentFramework('codex')
    await module.prepareBootstrapCodex()
    await writeFile(
      join(codexSubscriptionStorageDir(dir), 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic' })
    )
    vi.mocked(codexAuth.getStatus).mockImplementation(async () => {
      await repository.setAgentFramework('opencode')
      return { mode: 'isolated', supported: true, authenticated: true }
    })
    await expect(module.completeBootstrapCodex()).rejects.toMatchObject({
      code: 'configuration_conflict'
    })
    expect((await repository.getSettings()).activeProviderId).toBeUndefined()
  })

  it('validates an API key before any provider or credential publication', async () => {
    await repository.setAgentFramework('codex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid key', { status: 401 })))
    await expect(module.bootstrapOpenAi('synthetic-invalid-key', 'gpt-5.4')).rejects.toMatchObject({
      code: 'credential_invalid'
    })
    const restored = await new SettingsRepository(dir).getSettings()
    expect(restored.providers).toEqual([])
    expect(restored.activeProviderId).toBeUndefined()
    vi.unstubAllGlobals()
  })
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let codexAuth: CodexAuthControllerPort
  let claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  let claudeSharedAuth: ClaudeSharedAuthControllerPort
  let xaiOAuth: XaiOAuthControllerPort
  let module: InstanceType<typeof ProviderAccountsModule>
  let runClaudeSubscriptionProbe: (
    provider: ResolvedProvider,
    settings: StoredSettings
  ) => Promise<ValidateProviderResult>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-provider-accounts-'))
    repository = new SettingsRepository(dir)
    let settingsIdSequence = 0
    codexAuth = {
      getStatus: vi.fn(async (mode: CodexAuthStatus['mode'] = 'isolated') => ({
        mode,
        supported: true,
        authenticated: true
      })),
      loginIsolated: vi.fn(async (): Promise<CodexAuthStatus> => ({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })),
      cancelLogin: vi.fn(async () => undefined),
      logoutIsolated: vi.fn(async (): Promise<CodexAuthStatus> => ({
        mode: 'isolated',
        supported: true,
        authenticated: false
      }))
    }
    claudeIsolatedAuth = {
      getStatus: vi.fn(async () => ({ supported: true, authenticated: false })),
      loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: false })),
      loginIsolated: vi.fn(async () => ({ supported: true, authenticated: false })),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn(async () => ({ supported: true, authenticated: false }))
    }
    claudeSharedAuth = {
      getStatus: vi.fn(async () => ({ supported: true, authenticated: true })),
      loginShared: vi.fn(async () => ({ supported: true, authenticated: true })),
      cancelLogin: vi.fn()
    }
    xaiOAuth = {
      beginLogin: vi.fn(async () => ({
        userCode: 'GROK-1234',
        verificationUri: 'https://auth.x.ai/activate',
        expiresAt: Date.now() + 300_000,
        intervalSeconds: 5
      })),
      waitForLogin: vi.fn(async () => ({ accountEmail: 'researcher@example.com' })),
      cancelLogin: vi.fn(),
      getAccessToken: vi.fn(async () => 'access-token'),
      getAccessCredential: vi.fn(async () => ({ token: 'access-token' })),
      logout: vi.fn(async () => undefined)
    }
    runClaudeSubscriptionProbe = vi.fn(async (): Promise<ValidateProviderResult> => ({
      ok: true,
      category: 'ok'
    }))
    module = new ProviderAccountsModule({
      repository,
      storageRoot: dir,
      userClaudeDir: join(dir, 'user-claude'),
      userCodexDir: join(dir, 'user-codex'),
      allocateSettingsIdSequence: () => {
        settingsIdSequence += 1
        return settingsIdSequence
      },
      resolveCodexExecutable: vi.fn(async () => '/codex-acp'),
      resolveCodexProxyEnvironment: vi.fn(async () => undefined),
      runClaudeSubscriptionProbe,
      codexAuth,
      claudeIsolatedAuth,
      claudeSharedAuth,
      xaiOAuth
    })

    return async () => {
      vi.unstubAllGlobals()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects stale human edits while preserving credentials and allowing background catalog changes', async () => {
    const draft = {
      id: 'cas-provider',
      type: 'custom' as const,
      name: 'Original',
      baseUrl: 'https://old.example',
      model: 'test',
      key: 'secret'
    }
    await module.upsertProvider(draft)
    const original = (await repository.getSettings()).providers[0]
    await module.upsertProvider({
      ...draft,
      key: undefined,
      baseUrl: 'https://new.example',
      requireExisting: true,
      expectedConfigRevision: original.configRevision
    })
    await expect(
      module.upsertProvider({
        ...draft,
        key: undefined,
        name: 'Stale edit',
        requireExisting: true,
        expectedConfigRevision: original.configRevision
      })
    ).rejects.toThrow('Provider configuration changed')
    const latest = (await repository.getSettings()).providers[0]
    expect(latest).toMatchObject({
      baseUrl: 'https://new.example',
      keyRef: original.keyRef,
      configRevision: 2
    })
    await repository.updateProviderModelCatalogIfTargetMatches(latest, ['fresh-model'])
    await module.upsertProvider({
      ...draft,
      key: undefined,
      baseUrl: latest.baseUrl,
      name: 'Reapplied',
      requireExisting: true,
      expectedConfigRevision: latest.configRevision
    })
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      name: 'Reapplied',
      fetchedModels: ['fresh-model'],
      configRevision: 3,
      keyRef: original.keyRef
    })
    await repository.deleteProvider(draft.id)
    await expect(module.upsertProvider({ ...draft, expectedConfigRevision: 3 })).rejects.toThrow(
      'Provider configuration changed'
    )
  })

  it('accepts the zero revision of a legacy provider and rejects a second old form', async () => {
    await repository.upsertProvider({
      id: 'legacy',
      type: 'custom',
      name: 'Legacy',
      baseUrl: 'https://example.com',
      model: 'test',
      keyRef: 'plain:secret'
    })
    await module.upsertProvider({
      id: 'legacy',
      type: 'custom',
      name: 'First',
      expectedConfigRevision: 0
    })
    await expect(
      module.upsertProvider({
        id: 'legacy',
        type: 'custom',
        name: 'Second',
        expectedConfigRevision: 0
      })
    ).rejects.toThrow('Provider configuration changed')
  })

  it('owns custom provider persistence, projection, selection, and deletion', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })

    let settings = await repository.getSettings()
    const stored = settings.providers[0]
    expect(stored.id).toMatch(/^p_/)
    expect(stored.keyRef).toMatch(/^enc:/)
    expect(module.toProviderView(stored)).toMatchObject({
      id: stored.id,
      name: 'Lab gateway',
      models: ['lab-model'],
      maskedKey: '••••-key',
      hasKey: true,
      needsKey: false
    })

    await module.setActiveProvider(stored.id, 'unknown-model')
    settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe(stored.id)
    expect(settings.activeModel).toBe('lab-model')

    await module.deleteProvider(stored.id)
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it.each([
    ['id', 'p'.repeat(129), 'Provider ID must not exceed 128 characters.'],
    ['name', 'n'.repeat(129), 'Provider name must not exceed 128 characters.'],
    [
      'baseUrl',
      `https://gateway.example/${'x'.repeat(2_049)}`,
      'Base URL must not exceed 2048 characters.'
    ],
    ['model', 'm'.repeat(513), 'Model ID must not exceed 512 characters.'],
    ['key', 'k'.repeat(16 * 1024 + 1), 'API key must not exceed 16384 bytes.']
  ] as const)(
    'rejects an oversized provider %s before persistence',
    async (field, value, message) => {
      await expect(
        module.upsertProvider({
          type: 'custom',
          name: 'Lab gateway',
          baseUrl: 'https://lab.example/v1',
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['openai'],
          [field]: value
        })
      ).rejects.toThrow(message)

      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it.each([
    ['gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    ['ftp://gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    [
      'https://user:password@gateway.example/v1',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?api_key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?tenant=lab',
      'Base URL must not include query parameters or fragments.'
    ],
    [
      'https://gateway.example/v1#fragment',
      'Base URL must not include query parameters or fragments.'
    ]
  ])(
    'rejects an unsafe custom provider Base URL before persistence: %s',
    async (baseUrl, error) => {
      await expect(
        module.upsertProvider({
          type: 'custom',
          name: 'Lab gateway',
          baseUrl,
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['openai']
        })
      ).rejects.toThrow(error)

      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('rejects an oversized unsaved validation draft before provider probing', async () => {
    await expect(
      module.validateProvider({
        draft: {
          type: 'custom',
          name: 'n'.repeat(129),
          baseUrl: 'https://lab.example/v1',
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['responses']
        }
      })
    ).rejects.toThrow('Provider name must not exceed 128 characters.')
  })

  it('rejects creating a provider after the durable provider limit is reached', async () => {
    for (let index = 0; index < 64; index += 1) {
      await module.upsertProvider({
        type: 'custom',
        name: `Provider ${index}`,
        baseUrl: `https://provider-${index}.example/v1`,
        model: `model-${index}`,
        key: `key-${index}`,
        apiEndpoints: ['openai']
      })
    }

    await expect(
      module.upsertProvider({
        type: 'custom',
        name: 'Provider 65',
        baseUrl: 'https://provider-65.example/v1',
        model: 'model-65',
        key: 'key-65',
        apiEndpoints: ['openai']
      })
    ).rejects.toThrow('Provider limit of 64 reached.')

    expect((await repository.getSettings()).providers).toHaveLength(64)
  })

  it('rejects a stale update without recreating the deleted provider', async () => {
    const draft = {
      type: 'custom' as const,
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai' as const]
    }
    await module.upsertProvider(draft)
    const providerId = (await repository.getSettings()).providers[0].id
    await module.deleteProvider(providerId)

    await expect(
      module.upsertProvider({ ...draft, id: providerId, requireExisting: true })
    ).rejects.toThrow('Provider no longer exists.')
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('serializes Codex edits with deletion so authentication is not restored after removal', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })

    const editCancellation = deferred<void>()
    const deleteCancellation = deferred<void>()
    vi.mocked(codexAuth.cancelLogin)
      .mockImplementationOnce(() => editCancellation.promise)
      .mockImplementationOnce(() => deleteCancellation.promise)
    const edit = module
      .upsertProvider({
        id: 'builtin-codex-subscription',
        type: 'codex-shared',
        requireExisting: true
      })
      .then(
        () => 'saved' as const,
        () => 'rejected' as const
      )
    await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledOnce())

    const deletion = module.deleteProvider('builtin-codex-subscription')
    const deletionEnteredDuringEdit = vi.mocked(codexAuth.cancelLogin).mock.calls.length === 2
    if (deletionEnteredDuringEdit) {
      deleteCancellation.resolve()
      await deletion
      editCancellation.resolve()
    } else {
      editCancellation.resolve()
      await expect(edit).resolves.toBe('saved')
      await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledTimes(2))
      deleteCancellation.resolve()
    }
    await Promise.allSettled([edit, deletion])

    await expect(
      readFile(join(codexSubscriptionStorageDir(dir), 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(deletionEnteredDuringEdit).toBe(false)
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('serializes isolated Codex logout with a concurrent authentication-mode edit', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })

    const logoutCancellation = deferred<void>()
    const editCancellation = deferred<void>()
    const editEntered = deferred<void>()
    vi.mocked(codexAuth.cancelLogin)
      .mockImplementationOnce(() => logoutCancellation.promise)
      .mockImplementationOnce(() => {
        editEntered.resolve()
        return editCancellation.promise
      })

    const logout = module.logoutIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledOnce())
    const originalGetSettings = repository.getSettings.bind(repository)
    const editRead = deferred<StoredSettings>()
    const getSettings = vi.spyOn(repository, 'getSettings').mockImplementation(async () => {
      const settings = await originalGetSettings()
      editRead.resolve(settings)
      return settings
    })
    const edit = module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      requireExisting: true,
      reimportCodexAuthentication: true
    })

    const editEnteredDuringLogout = await Promise.race([
      editRead.promise.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false)))
    ])
    if (editEnteredDuringLogout) {
      editCancellation.resolve()
      await edit
      logoutCancellation.resolve()
    } else {
      logoutCancellation.resolve()
      await editEntered.promise
      editCancellation.resolve()
    }
    await Promise.all([logout, edit])
    getSettings.mockRestore()

    expect(editEnteredDuringLogout).toBe(false)
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      id: 'builtin-codex-subscription',
      codexAuthMode: 'imported'
    })
    await expect(
      readFile(join(codexSubscriptionStorageDir(dir), 'auth.json'), 'utf8')
    ).resolves.toContain('user')
  })

  it('does not restore isolated Codex validation after a concurrent logout', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    const staleSettings = await repository.getSettings()
    const staleRead = deferred<StoredSettings>()
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(() => staleRead.promise)

    const login = module.loginIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.loginIsolated).toHaveBeenCalledOnce())
    await module.logoutIsolatedCodex()
    staleRead.resolve(staleSettings)

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.codexAuthMode).toBe('isolated')
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('does not restore isolated Codex mode after a concurrent shared-mode edit', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })
    const staleSettings = await repository.getSettings()
    const staleRead = deferred<StoredSettings>()
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(() => staleRead.promise)

    const login = module.loginIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.loginIsolated).toHaveBeenCalledOnce())
    await module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      requireExisting: true,
      reimportCodexAuthentication: true
    })
    staleRead.resolve(staleSettings)

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      id: 'builtin-codex-subscription',
      codexAuthMode: 'imported'
    })
  })

  it('persists and projects the Codex subscription transport preference', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'https' })

    let stored = (await repository.getSettings()).providers[0]
    expect(stored.codexTransport).toBe('https')
    expect(module.toProviderView(stored).codexTransport).toBe('https')

    await module.upsertProvider({
      id: stored.id,
      type: 'codex-isolated',
      codexTransport: 'websocket',
      requireExisting: true
    })
    stored = (await repository.getSettings()).providers[0]
    expect(stored.codexTransport).toBe('websocket')
  })

  it.each([
    ['auto', 'https'],
    ['auto', 'websocket'],
    ['https', 'auto'],
    ['websocket', 'auto']
  ] as const)(
    'clears learned transport state when the preference changes from %s to %s',
    async (initialTransport, nextTransport) => {
      await module.upsertProvider({
        type: 'codex-isolated',
        codexTransport: initialTransport
      })
      const initial = (await repository.getSettings()).providers[0]
      await repository.upsertProvider({
        ...initial,
        codexAutoUseHttps: true
      })

      await module.upsertProvider({
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexTransport: nextTransport,
        requireExisting: true
      })

      expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBeUndefined()
    }
  )

  it('does not retain learned transport state while a manual preference is resaved', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'https' })
    const manual = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...manual,
      codexAutoUseHttps: true
    })

    await module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexTransport: 'https',
      requireExisting: true
    })

    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBeUndefined()
  })

  it('preserves learned HTTPS while an Auto preference is resaved', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'auto' })
    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...stored,
      codexAutoUseHttps: true
    })

    await module.upsertProvider({
      id: stored.id,
      type: 'codex-isolated',
      codexTransport: 'auto',
      requireExisting: true
    })

    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBe(true)
  })

  it.each([
    {
      sourceType: 'claude-isolated',
      sourceId: 'builtin-claude-isolated',
      destinationType: 'claude-shared',
      destinationId: 'builtin-claude-shared'
    },
    {
      sourceType: 'claude-shared',
      sourceId: 'builtin-claude-shared',
      destinationType: 'claude-isolated',
      destinationId: 'builtin-claude-isolated'
    }
  ] as const)(
    'allows a require-existing edit from $sourceType to $destinationType',
    async ({ sourceType, sourceId, destinationType, destinationId }) => {
      await module.upsertProvider({ type: sourceType })

      await expect(
        module.upsertProvider({ id: sourceId, type: destinationType, requireExisting: true })
      ).resolves.toBeUndefined()

      expect((await repository.getSettings()).providers.map((provider) => provider.id)).toEqual(
        expect.arrayContaining([sourceId, destinationId])
      )
    }
  )

  it('projects an ephemeral runtime target without changing the stored provider selection', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    const target = module.resolveRuntimeTarget(
      stored,
      { kind: 'configured', requestedModel: 'lab-model' },
      getAgentFramework('codex')
    )

    expect(target).toMatchObject({
      providerId: stored.id,
      effectiveModel: 'lab-model',
      provider: { model: 'lab-model', key: 'secret-key' },
      needsChatResponsesBridge: true
    })
    expect(module.resolveProviderApiEndpoints(stored)).toEqual(['openai'])
    expect(module.resolveProvider(stored)).toMatchObject({
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key'
    })
    expect(module.resolveRuntimeModelCatalog(stored, getAgentFramework('codex'))).toEqual([
      expect.objectContaining({ providerId: stored.id, effectiveModel: 'lab-model' })
    ])
    expect(module.resolveRuntimeReasoningEffortProfile(stored, 'lab-model')).toMatchObject({
      supported: true
    })
    expect(await repository.getSettings()).toEqual(before)
    expect(JSON.stringify(before)).not.toContain('secret-key')
  })

  it('rejects an unavailable required model instead of applying the configured fallback', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    expect(() =>
      module.resolveRuntimeTarget(
        stored,
        { kind: 'required', model: 'unavailable-model' },
        getAgentFramework('codex')
      )
    ).toThrow(
      `The requested model "unavailable-model" is not available for provider "Lab gateway".`
    )
    expect(await repository.getSettings()).toEqual(before)
  })

  it('keeps an exact required model when a subscription catalog is unknown', async () => {
    await module.upsertProvider({ type: 'claude-shared' })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    const target = module.resolveRuntimeTarget(
      stored,
      { kind: 'required', model: 'account-model' },
      getAgentFramework('claude-code')
    )

    expect(target).toMatchObject({
      effectiveModel: 'account-model',
      provider: { model: 'account-model' }
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it('keeps only the newest validation result for one provider id', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    const firstStatus = deferred<CodexAuthStatus>()
    vi.mocked(codexAuth.getStatus)
      .mockImplementationOnce(() => firstStatus.promise)
      .mockResolvedValueOnce({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })

    const first = module.validateProvider({ providerId: 'builtin-codex-subscription' })
    await vi.waitFor(() => expect(codexAuth.getStatus).toHaveBeenCalledOnce())
    const second = await module.validateProvider({ providerId: 'builtin-codex-subscription' })
    firstStatus.resolve({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'old failure'
    })

    expect(second).toMatchObject({ ok: true, applied: true })
    await expect(first).resolves.toMatchObject({ ok: false, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeTypeOf('number')
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('keeps another model selectable after a model-specific validation failure', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'model-a',
      key: 'secret-key',
      apiEndpoints: ['anthropic']
    })
    const providerId = (await repository.getSettings()).providers[0].id
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'pong' }],
              usage: { input_tokens: 1, output_tokens: 1 }
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('', { status: 404 }))
    )

    await expect(module.validateProvider({ providerId, model: 'model-a' })).resolves.toMatchObject({
      ok: true,
      category: 'ok'
    })

    await expect(module.validateProvider({ providerId, model: 'model-b' })).resolves.toMatchObject({
      ok: false,
      category: 'model-not-found'
    })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeTypeOf('number')
    expect(stored.lastValidatedTarget).toEqual({ model: 'model-a', endpoint: 'anthropic' })
    expect(stored.lastValidationFailure?.target).toEqual({
      model: 'model-b',
      endpoint: 'anthropic'
    })
    const catalog = buildConfiguredModelCatalog({
      providers: [module.toProviderView(stored)],
      frameworkId: 'claude-code',
      frameworkEndpoints: ['anthropic']
    })
    expect(catalog.map((entry) => entry.model)).toEqual(['model-a'])
  })

  it('coalesces shared Claude status reads and invalidates them across logout and login', async () => {
    await module.upsertProvider({ type: 'claude-shared' })
    const stored = (await repository.getSettings()).providers[0]
    const firstStatus = deferred<ClaudeSharedAuthStatus>()
    vi.mocked(claudeSharedAuth.getStatus).mockImplementationOnce(() => firstStatus.promise)

    const first = module.isProviderKeyUsable(stored)
    const second = module.isProviderKeyUsable(stored)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
    firstStatus.resolve({ supported: true, authenticated: true })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    await module.logoutClaudeShared()
    const disconnected = (await repository.getSettings()).providers[0]
    await expect(module.isProviderKeyUsable(disconnected)).resolves.toBe(false)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

    await module.loginClaudeShared()
    const reconnected = (await repository.getSettings()).providers[0]
    await expect(module.isProviderKeyUsable(reconnected)).resolves.toBe(true)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('cancels the correct authentication owners before deleting subscription records', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    await module.deleteProvider('builtin-codex-subscription')
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()

    await module.upsertProvider({ type: 'claude-isolated' })
    await module.upsertProvider({ type: 'claude-shared' })
    await module.deleteProvider('builtin-claude-shared')
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('owns the single xAI OAuth provider lifecycle without persisting an access token', async () => {
    await module.upsertProvider({ type: 'xai-subscription' })
    const stored = (await repository.getSettings()).providers[0]

    expect(stored).toMatchObject({
      id: 'builtin-xai-subscription',
      type: 'xai-subscription',
      name: 'xAI (Grok) OAuth',
      model: 'grok-4.7',
      apiEndpoints: ['anthropic', 'openai', 'responses']
    })
    expect(stored.keyRef).toBeUndefined()
    await expect(module.beginXaiOAuthLogin()).resolves.toMatchObject({ userCode: 'GROK-1234' })
    await expect(module.waitXaiOAuthLogin()).resolves.toEqual({
      accountEmail: 'researcher@example.com'
    })
    await expect(module.getXaiOAuthAccessToken()).resolves.toBe('access-token')

    await module.deleteProvider(stored.id)
    expect(xaiOAuth.logout).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not apply an in-flight xAI validation after logout', async () => {
    await module.upsertProvider({ type: 'xai-subscription' })
    const pendingToken = deferred<{ token: string; keyRef?: string }>()
    vi.mocked(xaiOAuth.getAccessCredential).mockImplementationOnce(() => pendingToken.promise)

    const pending = module.validateProvider({ providerId: 'builtin-xai-subscription' })
    await vi.waitFor(() => expect(xaiOAuth.getAccessCredential).toHaveBeenCalledOnce())
    await module.logoutXaiOAuth()
    pendingToken.reject(new Error('Sign in to xAI (Grok) OAuth to continue.'))

    await expect(pending).resolves.toMatchObject({ ok: false, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('exposes authentication lifecycle operations through the Module Interface', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })

    module.cancelCodexLogin()
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    await expect(module.loginIsolatedCodex()).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })

    await module.upsertProvider({ type: 'claude-isolated' })
    vi.mocked(claudeIsolatedAuth.loginIsolated).mockResolvedValueOnce({
      supported: true,
      authenticated: true
    })
    vi.mocked(claudeIsolatedAuth.loginIsolatedBrowser).mockResolvedValueOnce({
      supported: true,
      authenticated: false,
      cancelled: true,
      message: 'Sign-in cancelled.'
    })

    await expect(module.loginIsolatedClaude('setup-token')).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })
    await expect(module.loginIsolatedClaudeBrowser()).resolves.toMatchObject({
      ok: false,
      applied: false,
      cancelled: true
    })
    await module.cancelClaudeIsolatedLogin()
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()

    module.cancelClaudeLogin()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
  })

  it('cancels every provider login when its application owner is disposed', async () => {
    await module.dispose()

    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(xaiOAuth.cancelLogin).toHaveBeenCalledOnce()
  })

  it('returns bounded failures for missing model catalogs', async () => {
    await expect(module.refreshProviderModels({ providerId: 'missing-provider' })).resolves.toEqual(
      {
        ok: false,
        category: 'unknown',
        message: 'Provider not found.'
      }
    )

    await module.upsertProvider({
      type: 'custom',
      name: 'No catalog',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const providerId = (await repository.getSettings()).providers[0].id
    await expect(module.refreshProviderModels({ providerId })).resolves.toEqual({
      ok: false,
      category: 'unknown',
      message: 'This provider has no model-list endpoint.'
    })
  })

  it('probes a custom gateway over its own route under a foreign framework and persists health only', async () => {
    // An incompatible pairing no longer short-circuits the probe. The endpoint is still tested over
    // its own declared route (framework-agnostic), the framework mismatch rides along as a flag,
    // and the outcome persists as endpoint health — never as an 'incompatible' failure that would
    // go stale the moment the framework changes.
    const probedUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        probedUrls.push(String(input))
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const storedProvider = (await repository.getSettings()).providers[0]
    const result = await module.validateProvider({ providerId: storedProvider.id })
    expect(result).toMatchObject({
      ok: true,
      category: 'ok',
      applied: true,
      frameworkIncompatible: true
    })
    // The default framework (Claude Code) speaks /v1/messages only; the probe must exercise the
    // provider's own /v1/chat/completions route, not the framework's. A verified endpoint pairs
    // its success with the specific route mismatch.
    expect(probedUrls).toEqual(['https://lab.example/v1/chat/completions'])
    expect(result.message).toContain('/v1/chat/completions')

    const saved = (await repository.getSettings()).providers[0]
    expect(saved.lastValidatedAt).toBeGreaterThan(0)
    expect(saved.lastValidatedTarget).toEqual({ model: 'lab-model', endpoint: 'openai' })
    expect(saved.lastValidationFailure).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('probes an official vendor over its own route under a foreign framework and persists health only', async () => {
    // OpenCode Zen speaks only /v1/chat/completions; Claude Code cannot drive it. The vendor's own
    // route is still probed, the pairing rides along as a flag, and the vendor's default model is
    // the persisted target.
    const probedUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        probedUrls.push(String(input))
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    await module.upsertProvider({
      type: 'official',
      vendorId: 'opencode',
      name: 'Zen',
      key: 'synthetic-key'
    })
    const providerId = (await repository.getSettings()).providers[0].id

    const result = await module.validateProvider({ providerId })

    expect(result).toMatchObject({ ok: true, category: 'ok', frameworkIncompatible: true })
    expect(probedUrls).toEqual(['https://opencode.ai/zen/v1/chat/completions'])
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidatedTarget).toEqual({ model: 'kimi-k2.7-code', endpoint: 'openai' })
    expect(stored.lastValidationFailure).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('keeps the actionable probe failure when an incompatible pairing also fails its probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
      )
    )
    await module.upsertProvider({
      type: 'custom',
      name: 'Local',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:14b',
      apiEndpoints: ['openai']
    })
    const providerId = (await repository.getSettings()).providers[0].id

    const result = await module.validateProvider({ providerId })

    expect(result).toMatchObject({ ok: false, category: 'auth', frameworkIncompatible: true })
    // A failed probe keeps its own category copy; the pairing message must not replace it.
    expect(result.message).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('moves a custom gateway between loopback and remote with matching key requirements', async () => {
    // A keyless loopback gateway saves; retargeting it at a remote host then requires a key again.
    await module.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:14b',
      apiEndpoints: ['openai']
    })
    const providerId = (await repository.getSettings()).providers[0].id
    await expect(
      module.upsertProvider({
        id: providerId,
        requireExisting: true,
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://gateway.example/v1',
        model: 'qwen3:14b',
        apiEndpoints: ['openai']
      })
    ).rejects.toThrow('API key is required for a custom provider.')

    // Relaxing a keyed remote gateway down to a loopback base keeps its stored key.
    await module.upsertProvider({
      id: providerId,
      requireExisting: true,
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'qwen3:14b',
      apiEndpoints: ['openai'],
      key: 'sk-secret'
    })
    await module.upsertProvider({
      id: providerId,
      requireExisting: true,
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:14b',
      apiEndpoints: ['openai']
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.baseUrl).toBe('http://localhost:11434')
    expect(stored.keyMask).toBeTruthy()
  })

  it('validates a Claude shared profile by its OAuth state under a foreign framework instead of probing', async () => {
    // claude-shared is framework-bound by credential, not endpoint. Under a foreign framework its
    // auth-status check owns the verdict; no pairing flag, no probe against a base URL it lacks,
    // and no stored failure that would hide the profile from selectors.
    await repository.setAgentFramework('opencode')
    await module.upsertProvider({ type: 'claude-shared' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const providerId = (await repository.getSettings()).providers[0].id

    const result = await module.validateProvider({ providerId })

    expect(result.frameworkIncompatible).toBeUndefined()
    expect(result.category).not.toBe('bad-url')
    expect(fetchMock).not.toHaveBeenCalled()
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidationFailure).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('persists SenseNova regions through the existing settings field without rewriting legacy records', async () => {
    await module.upsertProvider({
      type: 'official',
      vendorId: 'sensenova',
      name: 'SenseNova',
      key: 'synthetic-key'
    })
    const original = (await new SettingsRepository(dir).getSettings()).providers[0]
    expect(original.region).toBeUndefined()
    expect(
      module.resolveRuntimeTarget(
        original,
        { kind: 'provider-default' },
        getAgentFramework('codex')
      ).provider.baseUrl
    ).toBe('https://token.sensenova.cn')
    await module.upsertProvider({
      id: original.id,
      requireExisting: true,
      type: 'official',
      vendorId: 'sensenova',
      name: 'SenseNova',
      region: 'global'
    })
    const restored = (await new SettingsRepository(dir).getSettings()).providers[0]
    expect(restored).toMatchObject({ region: 'global', keyRef: original.keyRef })
    expect(
      module.resolveRuntimeTarget(
        restored,
        { kind: 'provider-default' },
        getAgentFramework('codex')
      ).provider.openaiBaseUrl
    ).toBe('https://token.sensenova.ai/v1')
  })

  it('discards a model catalog fetched for a provider target changed during refresh', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      model: 'deepseek-v4-pro',
      key: 'old-key'
    })
    const original = (await repository.getSettings()).providers[0]
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId: original.id })
    await requestStarted.promise
    await module.upsertProvider({
      id: original.id,
      requireExisting: true,
      type: 'official',
      name: 'OpenAI replacement',
      vendorId: 'openai',
      key: 'new-key'
    })
    const edited = (await repository.getSettings()).providers[0]
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: false })
    await expect(repository.getSettings()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: original.id,
          name: 'OpenAI replacement',
          vendorId: 'openai',
          keyRef: edited.keyRef
        })
      ]
    })
    expect((await repository.getSettings()).providers[0].fetchedModels).toBeUndefined()
  })

  it('preserves unrelated provider edits while applying a pending model catalog refresh', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'old-key'
    })
    const original = (await repository.getSettings()).providers[0]
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId: original.id })
    await requestStarted.promise
    await module.upsertProvider({
      id: original.id,
      requireExisting: true,
      type: 'official',
      name: 'Renamed DeepSeek',
      vendorId: 'deepseek'
    })
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: true, models: ['deepseek-v5'] })
    await expect(repository.getSettings()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: original.id,
          name: 'Renamed DeepSeek',
          keyRef: original.keyRef,
          fetchedModels: ['deepseek-v5']
        })
      ]
    })
  })

  it.each([
    { vendorId: 'deepseek', model: 'deepseek-v4-pro', preserved: true },
    { vendorId: 'anthropic', model: 'claude-opus-5', preserved: false }
  ] as const)(
    'resolves configured models after catalog refresh for $vendorId',
    async ({ vendorId, model, preserved }) => {
      await module.upsertProvider({
        type: 'official',
        name: vendorId,
        vendorId,
        key: 'key'
      })
      const providerId = (await repository.getSettings()).providers[0].id
      await module.setActiveProvider(providerId, model)
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'replacement-model' }] }))
      )

      await expect(module.refreshProviderModels({ providerId })).resolves.toMatchObject({
        ok: true,
        models: ['replacement-model']
      })
      const settings = await repository.getSettings()
      const provider = settings.providers[0]
      expect(settings.activeModel).toBe(model)

      let outcome: string
      try {
        const target = module.resolveRuntimeTarget(
          provider,
          { kind: 'configured', requestedModel: settings.activeModel },
          getAgentFramework('claude-code')
        )
        outcome = `resolved ${target.effectiveModel}`
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error)
      }

      expect(outcome).toBe(
        preserved
          ? `resolved ${model}`
          : `The configured model is no longer available from provider "${vendorId}": "${model}". Pick another model in Settings → Model.`
      )
    }
  )

  it('does not recreate a provider deleted while its model catalog refresh is pending', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'old-key'
    })
    const providerId = (await repository.getSettings()).providers[0].id
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId })
    await requestStarted.promise
    await module.deleteProvider(providerId)
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: false })
    await expect(repository.getSettings()).resolves.toMatchObject({ providers: [] })
  })

  it.each(['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const)(
    'rejects an invalid %s on an unsaved validation draft',
    async (field) => {
      await expect(
        module.validateProvider({
          draft: {
            type: 'custom',
            baseUrl: 'https://lab.example/v1',
            model: 'lab-model',
            key: 'secret-key',
            apiEndpoints: ['openai'],
            [field]: 0
          }
        })
      ).rejects.toThrow(/positive whole number of tokens/)
    }
  )
})
