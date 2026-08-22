import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AcpSessionInteractionOwner } from '../session-interaction-owner'
import { ACP_STEERING_METHOD, parseSteerOutcome } from './native-send-now-capability'
import {
  STEERING_IDLE_BEHAVIOR,
  admitSteeringDispatch,
  buildSteeringDispatchRequest,
  dispatchSteering,
  interpretSteeringDispatch,
  retainInitializeCapabilities,
  retainProductionInitializeCapabilities
} from './native-send-now-steering-dispatch'

const promptText = (params: {
  prompt?: ReadonlyArray<{ type?: string; text?: string }>
}): string => {
  const block = params.prompt?.find((entry) => entry.type === 'text')
  return typeof block?.text === 'string' ? block.text : ''
}

const LATEST_CLAUDE_INITIALIZE = Object.freeze({
  protocolVersion: 1,
  agentCapabilities: {
    sessionCapabilities: { close: {}, delete: {}, resume: {} }
  },
  _meta: { steering: { supported: true } }
})

const LATEST_CODEX_INITIALIZE = Object.freeze({
  protocolVersion: 1,
  agentCapabilities: {
    sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {} }
  },
  _meta: { steering: { supported: true } }
})

describe('native Send now steering dispatch spike', () => {
  it('retains steering from latest Claude and Codex initialize _meta', () => {
    expect(retainInitializeCapabilities(LATEST_CLAUDE_INITIALIZE)).toEqual({
      close: true,
      delete: true,
      resume: true,
      steering: true
    })
    expect(retainInitializeCapabilities(LATEST_CODEX_INITIALIZE).steering).toBe(true)
  })

  it('shows production initialize keep-list drops steering', () => {
    expect(retainProductionInitializeCapabilities(LATEST_CLAUDE_INITIALIZE)).toEqual({
      close: true,
      delete: true,
      resume: true
    })
  })

  it('admits steering only for an advertised live prompt', () => {
    expect(admitSteeringDispatch({ advertised: true, hasLivePrompt: true })).toEqual({
      allowed: true
    })
    expect(admitSteeringDispatch({ advertised: false, hasLivePrompt: true })).toEqual({
      allowed: false,
      reason: 'not-advertised'
    })
    expect(admitSteeringDispatch({ advertised: true, hasLivePrompt: false })).toEqual({
      allowed: false,
      reason: 'no-live-turn'
    })
  })

  it('builds a host-owned idle fallback without exposing delivery priority', () => {
    expect(
      buildSteeringDispatchRequest('sess_1', [{ type: 'text', text: 'focus on tests' }])
    ).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'focus on tests' }],
      _meta: { steering: { idleBehavior: STEERING_IDLE_BEHAVIOR } }
    })
  })

  it('treats injected as Send now without interrupt', () => {
    expect(interpretSteeringDispatch(parseSteerOutcome({ outcome: 'injected' }))).toEqual({
      kind: 'injected'
    })
  })

  it('refuses startedNewTurn because the host does not own the detached turn', () => {
    expect(interpretSteeringDispatch(parseSteerOutcome({ outcome: 'startedNewTurn' }))).toEqual({
      kind: 'refused',
      reason: 'started-new-turn'
    })
  })

  it('refuses an empty extension success instead of treating it as injected', async () => {
    await expect(
      dispatchSteering({
        advertised: true,
        hasLivePrompt: true,
        sessionId: 'sess_1',
        prompt: [{ type: 'text', text: 'two' }],
        request: async () => ({})
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'unrecognized-success' })
  })

  it('does not reserve a second prompt interaction to steer', () => {
    const owner = new AcpSessionInteractionOwner()
    const first = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    expect(admitSteeringDispatch({ advertised: true, hasLivePrompt: true }).allowed).toBe(true)
    expect(owner.current('session-1')).toBe(first)
    expect(() => owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })).toThrow(
      'An ACP interaction is already running for this session'
    )
  })
})

describe('advertised _session/steering protocol spike', () => {
  it('injects follow-up without a second session/prompt', async () => {
    const prompts: string[] = []
    const steers: string[] = []
    let enteredFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const agent = acp
      .agent({ name: 'latest-steering-fake' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { close: {}, delete: {}, resume: {} } },
        authMethods: [],
        _meta: { steering: { supported: true } }
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'sess-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        prompts.push(promptText(ctx.params))
        enteredFirst()
        await firstHold
        return { stopReason: 'end_turn' as const }
      })
      .onRequest(ACP_STEERING_METHOD, { parse: (params) => params }, (ctx) => {
        steers.push(
          promptText(ctx.params as { prompt?: ReadonlyArray<{ type?: string; text?: string }> })
        )
        return { outcome: 'injected' as const }
      })

    await acp.client({ name: 'spike' }).connectWith(agent, async (ctx) => {
      const initialize = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'spike', version: '0' },
        clientCapabilities: {}
      })
      const capabilities = retainInitializeCapabilities(initialize)
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: '/tmp',
        mcpServers: []
      })
      const first = ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'one' }]
      })
      await firstStarted
      const result = await dispatchSteering({
        advertised: capabilities.steering,
        hasLivePrompt: true,
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'two' }],
        request: (method, params) => ctx.request(method, params)
      })
      expect(result).toEqual({ kind: 'injected' })
      expect(prompts).toEqual(['one'])
      expect(steers).toEqual(['two'])
      releaseFirst()
      await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
      expect(prompts).toEqual(['one'])
    })
  })

  it('refuses Codex-shaped startedNewTurn instead of treating it as Send now', async () => {
    const agent = acp
      .agent({ name: 'codex-idle-steer-fake' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
        _meta: { steering: { supported: true } }
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'sess-1' }))
      .onRequest(ACP_STEERING_METHOD, { parse: (params) => params }, () => ({
        outcome: 'startedNewTurn' as const
      }))

    await acp.client({ name: 'spike' }).connectWith(agent, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'spike', version: '0' },
        clientCapabilities: {}
      })
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: '/tmp',
        mcpServers: []
      })
      await expect(
        dispatchSteering({
          advertised: true,
          hasLivePrompt: true,
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'two' }],
          request: (method, params) => ctx.request(method, params)
        })
      ).resolves.toEqual({ kind: 'refused', reason: 'started-new-turn' })
    })
  })
})
