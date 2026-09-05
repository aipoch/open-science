import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection, SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  claudeCodeFramework,
  codeBuddyFramework,
  codexFramework,
  opencodeFramework
} from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { PermissionProfileUnavailableError } from './permission-profile-controller'
import { AcpSessionConfigurator } from './session-configurator'

const backendView = (
  session: AcpBackendGenerationView['session'],
  framework: AcpBackendGenerationView['framework'] = claudeCodeFramework
): AcpBackendGenerationView =>
  Object.freeze({
    framework,
    session: Object.freeze(session),
    prompt: Object.freeze({ systemPromptAppends: Object.freeze([]) }),
    context: Object.freeze({ supportsImageInput: false }),
    adapter: Object.freeze({ nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false })
  })

const selectOption = (
  id: string,
  category: string,
  currentValue: string,
  values: readonly string[]
): SessionConfigOption =>
  ({
    type: 'select',
    id,
    name: id,
    category,
    currentValue,
    options: values.map((value) => ({ value, name: value }))
  }) as SessionConfigOption

describe('AcpSessionConfigurator', () => {
  describe('A03: permission enforcement at the RPC boundary', () => {
    it.each([
      { framework: claudeCodeFramework, bypass: 'bypassPermissions' },
      { framework: codeBuddyFramework, bypass: 'fullAccess' },
      { framework: codexFramework, bypass: 'agent-full-access' }
    ])(
      'rejects an unavailable downgrade for $framework.id before reporting success',
      async ({ framework, bypass }) => {
        for (const profile of ['ask', 'auto'] as const) {
          const request = vi.fn(async () => ({}))
          const input = {
            backend: backendView({ modelRequired: false }, framework),
            connection: { agent: { request } } as unknown as ClientConnection,
            session: {
              sessionId: 'session-1',
              modes: { currentModeId: bypass, availableModes: [{ id: bypass, name: bypass }] }
            } as unknown as ActiveSession,
            permissionProfile: profile
          }
          const configurator = new AcpSessionConfigurator({
            assertCurrentConnection: vi.fn(),
            diagnosticContext: () => ({ framework: framework.id })
          })

          // Both initial attachment and a forced live change use the real framework mapper.
          // Soft assertions preserve the resolved false-success state and RPC evidence in red logs.
          await expect
            .soft(configurator.configure(input))
            .rejects.toThrow(PermissionProfileUnavailableError)
          await expect
            .soft(configurator.configurePermissionProfile(input, true))
            .rejects.toThrow(PermissionProfileUnavailableError)
          expect(request).not.toHaveBeenCalled()
        }
      }
    )

    it('keeps OpenCode broker-enforced profiles available without a mode RPC', async () => {
      const request = vi.fn(async () => ({}))
      const configurator = new AcpSessionConfigurator({
        assertCurrentConnection: vi.fn(),
        diagnosticContext: () => ({ framework: 'opencode' })
      })
      for (const profile of ['ask', 'auto', 'full'] as const) {
        await expect(
          configurator.configurePermissionProfile(
            {
              backend: backendView({ modelRequired: false }, opencodeFramework),
              connection: { agent: { request } } as unknown as ClientConnection,
              session: {
                sessionId: 'session-1',
                modes: {
                  currentModeId: 'build',
                  availableModes: [
                    { id: 'build', name: 'Build' },
                    { id: 'plan', name: 'Plan' }
                  ]
                }
              } as unknown as ActiveSession,
              permissionProfile: profile
            },
            true
          )
        ).resolves.toMatchObject({
          selectedProfile: profile,
          effectiveProfile: profile,
          currentModeId: 'build'
        })
      }
      expect(request).not.toHaveBeenCalled()
    })
  })

  it('applies mode, model, and post-model effort in protocol order and returns immutable facts', async () => {
    const initialOptions = [
      selectOption('model', 'model', 'model-a', ['model-a', 'model-b']),
      selectOption('effort', 'thought_level', 'low', ['low', 'high'])
    ]
    const postModelOptions = [selectOption('effort', 'thought_level', 'medium', ['medium', 'high'])]
    const requests: Array<{ method: unknown; params: unknown }> = []
    const request = vi.fn(async (method: unknown, params: unknown) => {
      requests.push({ method, params })
      return method === acp.methods.agent.session.setConfigOption &&
        (params as { configId?: string }).configId === 'model'
        ? { configOptions: postModelOptions }
        : {}
    })
    const connection = { agent: { request } } as unknown as ClientConnection
    const session = {
      sessionId: 'session-1',
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Full access' }
        ]
      },
      newSessionResponse: { configOptions: initialOptions }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    const facts = await configurator.configure({
      backend: backendView({ model: 'model-b', modelRequired: true, effort: 'high' }),
      connection,
      session,
      permissionProfile: 'full'
    })

    expect(requests).toEqual([
      {
        method: acp.methods.agent.session.setMode,
        params: { sessionId: 'session-1', modeId: 'bypassPermissions' }
      },
      {
        method: acp.methods.agent.session.setConfigOption,
        params: { sessionId: 'session-1', configId: 'model', value: 'model-b' }
      },
      {
        method: acp.methods.agent.session.setConfigOption,
        params: { sessionId: 'session-1', configId: 'effort', value: 'high' }
      }
    ])
    expect(facts).toMatchObject({
      permissionProfile: { selectedProfile: 'full', currentModeId: 'bypassPermissions' },
      appliedModel: 'model-b',
      configOptions: postModelOptions
    })
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts.permissionProfile)).toBe(true)
    expect(Object.isFrozen(facts.permissionProfile.availableModeIds)).toBe(true)
    expect(Object.isFrozen(facts.configOptions)).toBe(true)
  })

  it('applies a permission-only change and returns an immutable profile fact', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const session = {
      sessionId: 'session-1',
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Full access' }
        ]
      }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    const profile = await configurator.configurePermissionProfile({
      backend: backendView({ model: 'unused-model', modelRequired: true, effort: 'high' }),
      connection,
      session,
      permissionProfile: 'full'
    })

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(acp.methods.agent.session.setMode, {
      sessionId: 'session-1',
      modeId: 'bypassPermissions'
    })
    expect(profile).toMatchObject({ selectedProfile: 'full', currentModeId: 'bypassPermissions' })
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.availableModeIds)).toBe(true)
  })

  it.each([
    {
      failure: 'the required model is unavailable',
      configOptions: [selectOption('model', 'model', 'model-a', ['model-a'])],
      request: vi.fn(async () => ({})),
      message: 'The selected model "model-b" is not available for this Codex account.'
    },
    {
      failure: 'the required model request is rejected',
      configOptions: [selectOption('model', 'model', 'model-a', ['model-a', 'model-b'])],
      request: vi.fn(async () => {
        throw new Error('provider rejected model-b')
      }),
      message: 'The selected model "model-b" could not be applied: provider rejected model-b'
    }
  ])('fails startup when $failure', async ({ configOptions, request, message }) => {
    const connection = { agent: { request } } as unknown as ClientConnection
    const session = {
      sessionId: 'session-1',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      newSessionResponse: { configOptions }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    await expect(
      configurator.configure({
        backend: backendView({ model: 'model-b', modelRequired: true, effort: 'high' }),
        connection,
        session,
        permissionProfile: 'ask'
      })
    ).rejects.toThrow(message)
  })

  it('falls back from an optional-model failure and still applies startup effort', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('optional model rejected'))
      .mockResolvedValueOnce({})
    const connection = { agent: { request } } as unknown as ClientConnection
    const configOptions = [
      selectOption('model', 'model', 'model-a', ['model-a', 'model-b']),
      selectOption('effort', 'thought_level', 'low', ['low', 'high'])
    ]
    const session = {
      sessionId: 'session-1',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      newSessionResponse: { configOptions }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    const facts = await configurator.configure({
      backend: backendView({ model: 'model-b', modelRequired: false, effort: 'high' }),
      connection,
      session,
      permissionProfile: 'ask'
    })

    expect(request).toHaveBeenNthCalledWith(1, acp.methods.agent.session.setConfigOption, {
      sessionId: 'session-1',
      configId: 'model',
      value: 'model-b'
    })
    expect(request).toHaveBeenNthCalledWith(2, acp.methods.agent.session.setConfigOption, {
      sessionId: 'session-1',
      configId: 'effort',
      value: 'high'
    })
    expect(facts).toMatchObject({ appliedModel: undefined, configOptions: undefined })
  })

  it('skips a redundant Codex model request while retaining its configuration facts', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const configOptions = [
      selectOption('model', 'model', 'openai/gpt-5', ['openai/gpt-5']),
      selectOption('effort', 'thought_level', 'low', ['low', 'high'])
    ]
    const session = {
      sessionId: 'session-1',
      modes: {
        currentModeId: 'read-only',
        availableModes: [{ id: 'read-only', name: 'Read only' }]
      },
      newSessionResponse: { configOptions }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'codex', generation: 1, status: 'connected' })
    })

    const facts = await configurator.configure({
      backend: backendView({ model: 'gpt-5', modelRequired: true, effort: 'high' }, codexFramework),
      connection,
      session,
      permissionProfile: 'ask'
    })

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(acp.methods.agent.session.setConfigOption, {
      sessionId: 'session-1',
      configId: 'effort',
      value: 'high'
    })
    expect(facts).toMatchObject({
      appliedModel: 'openai/gpt-5',
      configOptions
    })
  })

  it('keeps startup effort best-effort when the protocol request is rejected', async () => {
    const request = vi.fn(async () => {
      throw new Error('effort rejected')
    })
    const connection = { agent: { request } } as unknown as ClientConnection
    const session = {
      sessionId: 'session-1',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      newSessionResponse: {
        configOptions: [selectOption('effort', 'thought_level', 'low', ['low', 'high'])]
      }
    } as unknown as ActiveSession
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    await expect(
      configurator.configure({
        backend: backendView({ modelRequired: false, effort: 'high' }),
        connection,
        session,
        permissionProfile: 'ask'
      })
    ).resolves.toMatchObject({
      permissionProfile: { selectedProfile: 'ask' },
      appliedModel: undefined
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('applies live effort to every eligible open session and returns immutable fallback facts', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const assertCurrentConnection = vi.fn()
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection,
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })
    const sessions = ['session-1', 'session-2'].map((sessionId) => ({
      session: { sessionId } as unknown as ActiveSession,
      configOptions: [selectOption('effort', 'thought_level', 'low', ['low', 'high'])],
      assertCurrent: vi.fn()
    }))

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }),
      connection,
      effort: 'high',
      sessions
    })

    expect(request).toHaveBeenNthCalledWith(1, acp.methods.agent.session.setConfigOption, {
      sessionId: 'session-1',
      configId: 'effort',
      value: 'high'
    })
    expect(request).toHaveBeenNthCalledWith(2, acp.methods.agent.session.setConfigOption, {
      sessionId: 'session-2',
      configId: 'effort',
      value: 'high'
    })
    expect(sessions[0].assertCurrent).toHaveBeenCalledOnce()
    expect(sessions[1].assertCurrent).toHaveBeenCalledOnce()
    expect(assertCurrentConnection).toHaveBeenCalledTimes(2)
    expect(assertCurrentConnection).toHaveBeenCalledWith(connection)
    expect(facts).toEqual({ reconnectRequired: false })
    expect(Object.isFrozen(facts)).toBe(true)
  })

  it('isolates a superseded session and requests reconnect after attempting the remaining sessions', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })
    const configOptions = [selectOption('effort', 'thought_level', 'low', ['low', 'high'])]
    const staleSession = {
      session: { sessionId: 'stale-session' } as unknown as ActiveSession,
      configOptions,
      assertCurrent: vi.fn(() => {
        throw new Error('ACP session startup was superseded.')
      })
    }
    const currentSession = {
      session: { sessionId: 'current-session' } as unknown as ActiveSession,
      configOptions,
      assertCurrent: vi.fn()
    }

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }),
      connection,
      effort: 'high',
      sessions: [staleSession, currentSession]
    })

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(acp.methods.agent.session.setConfigOption, {
      sessionId: 'current-session',
      configId: 'effort',
      value: 'high'
    })
    expect(staleSession.assertCurrent).toHaveBeenCalledOnce()
    expect(currentSession.assertCurrent).toHaveBeenCalledOnce()
    expect(facts).toEqual({ reconnectRequired: true })
  })

  it('requests reconnect without a protocol call when effort is baked into spawn configuration', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const assertCurrent = vi.fn()
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'opencode', generation: 1, status: 'connected' })
    })

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }, opencodeFramework),
      connection,
      effort: 'high',
      sessions: [
        {
          session: { sessionId: 'session-1' } as unknown as ActiveSession,
          configOptions: [selectOption('effort', 'thought_level', 'low', ['low', 'high'])],
          assertCurrent
        }
      ]
    })

    expect(request).not.toHaveBeenCalled()
    expect(assertCurrent).not.toHaveBeenCalled()
    expect(facts).toEqual({ reconnectRequired: true })
  })

  it('requests reconnect when no open Codex session advertises a live effort option', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const assertCurrent = vi.fn()
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'codex', generation: 1, status: 'connected' })
    })

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }, codexFramework),
      connection,
      effort: 'high',
      sessions: [
        {
          session: { sessionId: 'session-1' } as unknown as ActiveSession,
          configOptions: [],
          assertCurrent
        }
      ]
    })

    expect(request).not.toHaveBeenCalled()
    expect(assertCurrent).not.toHaveBeenCalled()
    expect(facts).toEqual({ reconnectRequired: true })
  })

  it('does not request reconnect when a Claude session has no live effort option', async () => {
    const request = vi.fn(async () => ({}))
    const connection = { agent: { request } } as unknown as ClientConnection
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }),
      connection,
      effort: 'high',
      sessions: [
        {
          session: { sessionId: 'session-1' } as unknown as ActiveSession,
          configOptions: [],
          assertCurrent: vi.fn()
        }
      ]
    })

    expect(request).not.toHaveBeenCalled()
    expect(facts).toEqual({ reconnectRequired: false })
  })

  it('isolates a rejected live update and still attempts every remaining eligible session', async () => {
    const request = vi.fn(async (_method: unknown, params: unknown) => {
      if ((params as { sessionId: string }).sessionId === 'rejected-session') {
        throw new Error('live effort rejected')
      }
      return {}
    })
    const connection = { agent: { request } } as unknown as ClientConnection
    const configurator = new AcpSessionConfigurator({
      assertCurrentConnection: vi.fn(),
      diagnosticContext: () => ({ framework: 'claude-code', generation: 1, status: 'connected' })
    })
    const configOptions = [selectOption('effort', 'thought_level', 'low', ['low', 'high'])]

    const facts = await configurator.applyLiveEffort({
      backend: backendView({ modelRequired: false, effort: 'high' }),
      connection,
      effort: 'high',
      sessions: ['rejected-session', 'updated-session'].map((sessionId) => ({
        session: { sessionId } as unknown as ActiveSession,
        configOptions,
        assertCurrent: vi.fn()
      }))
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith(acp.methods.agent.session.setConfigOption, {
      sessionId: 'updated-session',
      configId: 'effort',
      value: 'high'
    })
    expect(facts).toEqual({ reconnectRequired: true })
  })
})
