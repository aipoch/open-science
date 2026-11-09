import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { harnessFramework } from './harness'
import { harnessConfigSchema, HARNESS_ACP_ARG } from '../harness-acp/config'
import { isRuntimeHelper } from '../runtime-helper'
import { isProviderUsableByFramework } from '../../shared/settings'
import type { AgentSpawnInput } from './types'

describe('built-in Agent host boundary', () => {
  it('keeps credentials in ACP authentication and uses the runtime helper', () => {
    const config = harnessFramework.prepareModelConfig(
      {
        type: 'custom',
        model: 'model',
        agentProviderId: 'provider/model',
        key: 'upstream-secret',
        contextWindow: 64000
      },
      {
        storageRoot: resolve('data'),
        executablePath: resolve('out/backend/index.cjs'),
        responsesConnection: { baseUrl: 'http://127.0.0.1:1234', token: 'revocable-local-token' },
        reasoningEffort: 'high'
      }
    )
    expect(
      JSON.stringify({ args: config.args, env: config.env, files: config.configFiles })
    ).not.toMatch(/upstream-secret|revocable-local-token/)
    expect(config.authentication?._meta?.['open-science-agent']).toMatchObject({
      token: 'revocable-local-token',
      parameters: { reasoning_effort: 'high' },
      contextWindow: 64000
    })
    expect(isRuntimeHelper(['node', 'main.cjs', ...config.args!])).toBe(true)
    const spawnProcess = vi.fn(() => ({})) as unknown as NonNullable<
      AgentSpawnInput['spawnProcess']
    >
    harnessFramework.spawn({
      executablePath: resolve('out/backend/index.cjs'),
      args: config.args!,
      env: { API_KEY: 'do-not-inherit' },
      spawnProcess
    })
    expect(JSON.stringify(vi.mocked(spawnProcess).mock.calls)).not.toMatch(
      /do-not-inherit|upstream-secret|revocable-local-token/
    )
    expect(vi.mocked(spawnProcess).mock.calls[0][1]).toContain(HARNESS_ACP_ARG)
  })
  it('rejects remote model credentials and unreviewed subscription routes', () => {
    expect(
      harnessConfigSchema.safeParse({
        endpoint: 'https://provider.example/v1/chat/completions',
        token: 'secret',
        model: 'm',
        modelIdentity: 'm',
        contextWindow: 32000,
        maxOutputTokens: 1000
      }).success
    ).toBe(false)
    for (const type of ['codex-isolated', 'claude-shared'] as const)
      expect(
        isProviderUsableByFramework({ type, apiEndpoints: ['chat-completions'] }, harnessFramework)
      ).toBe(false)
    expect(
      isProviderUsableByFramework(
        { type: 'custom', apiEndpoints: ['chat-completions'] },
        harnessFramework
      )
    ).toBe(true)
    expect(harnessFramework.supportsDelegatedWork).toBe(true)
    expect(
      isProviderUsableByFramework(
        { type: 'xai-subscription', apiEndpoints: ['responses'] },
        harnessFramework
      )
    ).toBe(true)
  })
})

it.each(['chat-completions', 'messages', 'responses'] as const)(
  'binds native %s to its loopback path',
  (protocol) => {
    const config = harnessFramework.prepareModelConfig(
      { type: 'custom', model: 'm', agentProviderId: 'p/m', apiEndpoints: [protocol] },
      {
        storageRoot: resolve('data'),
        executablePath: resolve('out/backend/index.cjs'),
        responsesConnection: { baseUrl: 'http://127.0.0.1:1234', token: 'local' }
      }
    )
    const value = harnessConfigSchema.parse(config.authentication?._meta?.['open-science-agent'])
    expect(value.protocol).toBe(protocol)
    expect(value.endpoint).toBe(
      `http://127.0.0.1:1234/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`
    )
    expect(
      harnessConfigSchema.safeParse({ ...value, endpoint: 'http://127.0.0.1:1234/v1/message' })
        .success
    ).toBe(false)
    expect(
      harnessConfigSchema.safeParse({
        ...value,
        protocol: protocol === 'messages' ? 'responses' : 'messages'
      }).success
    ).toBe(false)
    expect(
      isProviderUsableByFramework({ type: 'official', apiEndpoints: [protocol] }, harnessFramework)
    ).toBe(true)
  }
)

it.each(['MiniMax-M3', 'MiniMax-M3.1-Flash', 'MiniMax-M2.7'])(
  'narrows native media capabilities for documented MiniMax model %s',
  (model) => {
    const config = harnessFramework.prepareModelConfig(
      { type: 'custom', vendorId: 'minimax', model, agentProviderId: 'minimax/' + model },
      {
        storageRoot: resolve('data'),
        executablePath: resolve('out/backend/index.cjs'),
        responsesConnection: { baseUrl: 'http://127.0.0.1:1234', token: 'local' }
      }
    )
    expect(
      harnessConfigSchema.parse(config.authentication?._meta?.['open-science-agent'])
        .inputCapabilities
    ).toEqual({
      images: false,
      files: false,
      audio: false,
      video: model.startsWith('MiniMax-M3')
    })
  }
)

it('passes the selected provider image capability to the native harness model', () => {
  const base = {
    type: 'custom' as const,
    model: 'text-only',
    agentProviderId: 'provider/text-only',
    supportsImageInput: false
  }
  const context = {
    storageRoot: resolve('data'),
    executablePath: resolve('out/backend/index.cjs'),
    responsesConnection: { baseUrl: 'http://127.0.0.1:1234', token: 'local' }
  }
  expect(
    harnessConfigSchema.parse(
      harnessFramework.prepareModelConfig(base, context).authentication?._meta?.[
        'open-science-agent'
      ]
    ).inputCapabilities
  ).toEqual({ images: false })
  expect(
    harnessConfigSchema.parse(
      harnessFramework.prepareModelConfig({ ...base, supportsImageInput: true }, context)
        .authentication?._meta?.['open-science-agent']
    ).inputCapabilities
  ).toEqual({ images: true })
})
