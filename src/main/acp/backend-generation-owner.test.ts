import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, codexFramework } from '../agent-framework'
import { AcpBackendGenerationOwner } from './backend-generation-owner'

describe('AcpBackendGenerationOwner', () => {
  it('publishes one immutable secret-free behavior view atomically', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    const sessionOptions = { settingSources: ['user'] }
    const systemPromptAppends = ['Use the app tools.']
    const attempt = owner.prepare(
      { epoch: 7, assertCurrent: vi.fn() },
      {
        framework: codexFramework,
        backendId: 'codex:isolated',
        executablePath: '/private/provider/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex', PROVIDER_TOKEN: 'spawn-secret' },
        args: ['--token=argument-secret'],
        sessionModel: 'gpt-selected',
        sessionModelRequired: true,
        sessionEffort: 'high',
        sessionOptions,
        systemPromptAppends,
        persistentSystemPrompt: 'Stable instructions.',
        contextWindow: 1_000_000,
        supportsImageInput: true,
        contextUsageModel: 'provider-model',
        authentication: { methodId: 'codex-login' },
        providerConfiguration: {
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'https://provider.example',
          headers: { authorization: 'Bearer provider-secret' }
        },
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic usage-secret'
        }
      }
    )

    expect(owner.current.framework.id).toBe('claude-code')

    const view = attempt.publish()
    sessionOptions.settingSources.push('project')
    systemPromptAppends.push('late mutation')

    expect(owner.current).toBe(view)
    expect(view).toMatchObject({
      framework: codexFramework,
      backendId: 'codex:isolated',
      session: {
        model: 'gpt-selected',
        modelRequired: true,
        effort: 'high',
        options: { settingSources: ['user'] }
      },
      prompt: {
        systemPromptAppends: ['Use the app tools.'],
        persistentSystemPrompt: 'Stable instructions.'
      },
      context: { window: 1_000_000, model: 'provider-model', supportsImageInput: true },
      adapter: {
        codexHome: '/data/codex',
        nativeMcpEnabled: false,
        bridgeMcpAliasesEnabled: true
      }
    })
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.session)).toBe(true)
    expect(Object.isFrozen(view.session.options)).toBe(true)
    expect(Object.isFrozen(view.prompt.systemPromptAppends)).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(
      /spawn-secret|argument-secret|provider-secret|usage-secret|provider\.example|\/private\/provider/
    )
  })

  it('consumes attempt-bound initialize material exactly once', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    const authentication = { methodId: 'codex-login', _meta: { token: 'auth-secret' } }
    const providerConfiguration = {
      providerId: 'openai' as const,
      apiType: 'openai' as const,
      baseUrl: 'https://provider.example',
      headers: { authorization: 'Bearer provider-secret' }
    }
    const attempt = owner.prepare(
      { epoch: 1, assertCurrent: vi.fn() },
      {
        framework: codexFramework,
        executablePath: '/bin/codex-acp',
        env: {},
        authentication,
        providerConfiguration
      }
    )
    attempt.publish()

    expect(attempt.consumeInitializeMaterial()).toEqual({
      authentication,
      providerConfiguration
    })
    expect(attempt.consumeInitializeMaterial()).toBeUndefined()
  })

  it('rejects a stale reconnect attempt without replacing the published generation', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    const stale = owner.prepare(
      { epoch: 1, assertCurrent: vi.fn() },
      {
        framework: codexFramework,
        backendId: 'codex:stale',
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: 'model-old'
      }
    )
    const successor = owner.prepare(
      { epoch: 2, assertCurrent: vi.fn() },
      {
        framework: claudeCodeFramework,
        backendId: 'claude-code:current',
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-new'
      }
    )

    expect(() => stale.publish()).toThrow('ACP backend generation was superseded.')
    expect(owner.current.backendId).toBeUndefined()

    successor.publish()
    expect(owner.current.backendId).toBe('claude-code:current')
    expect(owner.current.session.model).toBe('model-new')
  })

  it('clears unconsumed secrets when a published attempt fails', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    const attempt = owner.prepare(
      { epoch: 1, assertCurrent: vi.fn() },
      {
        framework: codexFramework,
        backendId: 'codex:failed',
        executablePath: '/bin/codex-acp',
        env: {},
        authentication: { methodId: 'codex-login', _meta: { token: 'auth-secret' } },
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic usage-secret'
        }
      }
    )
    attempt.publish()
    expect(owner.openCodeUsageApi()).toEqual({
      baseUrl: 'http://127.0.0.1:4242',
      authorization: 'Basic usage-secret'
    })

    attempt.fail()

    expect(attempt.consumeInitializeMaterial()).toBeUndefined()
    expect(owner.openCodeUsageApi()).toBeUndefined()
    expect(owner.current.backendId).toBe('codex:failed')
  })

  it('clears sensitive material when the connection generation is superseded', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    const attempt = owner.prepare(
      { epoch: 1, assertCurrent: vi.fn() },
      {
        framework: codexFramework,
        backendId: 'codex:retiring',
        executablePath: '/bin/codex-acp',
        env: {},
        authentication: { methodId: 'codex-login' },
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic usage-secret'
        }
      }
    )
    attempt.publish()

    owner.supersede(1)

    expect(attempt.consumeInitializeMaterial()).toBeUndefined()
    expect(owner.openCodeUsageApi()).toBeUndefined()
    expect(owner.current.backendId).toBe('codex:retiring')
  })

  it('does not let an older teardown supersede a newer generation', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    owner
      .prepare(
        { epoch: 1, assertCurrent: vi.fn() },
        {
          framework: codexFramework,
          executablePath: '/bin/codex-acp',
          env: {},
          opencodeUsageApi: {
            baseUrl: 'http://127.0.0.1:4242',
            authorization: 'Basic old'
          }
        }
      )
      .publish()
    owner
      .prepare(
        { epoch: 3, assertCurrent: vi.fn() },
        {
          framework: codexFramework,
          executablePath: '/bin/codex-acp',
          env: {},
          opencodeUsageApi: {
            baseUrl: 'http://127.0.0.1:4242',
            authorization: 'Basic successor'
          }
        }
      )
      .publish()

    owner.supersede(1)

    expect(owner.openCodeUsageApi()?.authorization).toBe('Basic successor')
    owner.supersede(3)
    expect(owner.openCodeUsageApi()).toBeUndefined()
  })

  it('live-updates effort by replacing only the immutable Session view', () => {
    const owner = new AcpBackendGenerationOwner(claudeCodeFramework)
    owner
      .prepare(
        { epoch: 1, assertCurrent: vi.fn() },
        {
          framework: claudeCodeFramework,
          backendId: 'claude-code:shared',
          executablePath: '/bin/claude',
          env: {},
          sessionModel: 'claude-model',
          sessionEffort: 'medium',
          contextWindow: 200_000
        }
      )
      .publish()
    const prior = owner.current

    const updated = owner.updateReasoningEffort('high')

    expect(updated).toBe(owner.current)
    expect(updated).not.toBe(prior)
    expect(updated.session).toEqual({
      model: 'claude-model',
      modelRequired: false,
      effort: 'high'
    })
    expect(updated.context).toBe(prior.context)
    expect(prior.session.effort).toBe('medium')

    expect(owner.updateReasoningEffort('default').session.effort).toBeUndefined()
  })
})
