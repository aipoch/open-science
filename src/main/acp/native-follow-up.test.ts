import { describe, expect, it } from 'vitest'

import {
  ACP_STEERING_METHOD,
  STEERING_IDLE_BEHAVIOR,
  buildAcpSteeringParams,
  buildOpenCodeHttpFollowUpBody,
  interpretSteerOutcome,
  parseOpenCodeHttpFollowUp,
  parseSteerOutcome,
  readSteeringAdvertisement,
  resolveNativeFollowUpRoute,
  retainInitializeCapabilities
} from './native-follow-up'

const CLAUDE_STEERING_INITIALIZE = Object.freeze({
  protocolVersion: 1,
  agentCapabilities: {
    sessionCapabilities: { close: {}, delete: {}, resume: {} }
  },
  _meta: { steering: { supported: true } }
})

const CODEX_STEERING_INITIALIZE = Object.freeze({
  protocolVersion: 1,
  agentCapabilities: {
    sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {} }
  },
  _meta: { steering: { supported: true } }
})

describe('native follow-up compatibility layer', () => {
  it('reads steering from Claude and Codex initialize _meta', () => {
    expect(readSteeringAdvertisement(CLAUDE_STEERING_INITIALIZE)).toEqual({ supported: true })
    expect(retainInitializeCapabilities(CLAUDE_STEERING_INITIALIZE)).toEqual({
      close: true,
      delete: true,
      resume: true,
      steering: true
    })
    expect(retainInitializeCapabilities(CODEX_STEERING_INITIALIZE).steering).toBe(true)
    expect(readSteeringAdvertisement({ protocolVersion: 1, agentCapabilities: {} })).toEqual({
      supported: false
    })
  })

  it('routes advertised ACP steering and OpenCode HTTP, and refuses the rest', () => {
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'acp-steering' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'codex',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'acp-steering' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: false,
        hasLivePrompt: true,
        frameworkId: 'opencode',
        hasOpenCodeHttp: true,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'opencode-http' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: false,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'unsupported', reason: 'not-advertised' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: false,
        hasLivePrompt: true,
        frameworkId: 'codex',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'unsupported', reason: 'not-advertised' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: false,
        hasLivePrompt: true,
        frameworkId: 'opencode',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'unsupported', reason: 'not-advertised' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: false,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'unsupported', reason: 'no-live-turn' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: 'focus on tests',
        hasAttachments: true
      })
    ).toEqual({ transport: 'unsupported', reason: 'attachments' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: '   '
      })
    ).toEqual({ transport: 'unsupported', reason: 'empty-text' })
  })

  it('builds ACP steering params with host-owned idle promptRequired', () => {
    expect(buildAcpSteeringParams('sess_1', 'focus on tests')).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'focus on tests' }],
      _meta: { steering: { idleBehavior: STEERING_IDLE_BEHAVIOR } }
    })
    expect(ACP_STEERING_METHOD).toBe('_session/steering')
    expect(buildOpenCodeHttpFollowUpBody('http-steer')).toEqual({
      parts: [{ type: 'text', text: 'http-steer' }],
      noReply: true
    })
  })

  it('accepts a persisted v1 user message and rejects a v2 inbox admission', () => {
    expect(
      parseOpenCodeHttpFollowUp(
        {
          info: { id: 'msg_1', role: 'user', sessionID: 'ses_1' },
          parts: [{ type: 'text', text: 'http-steer' }]
        },
        'http-steer'
      )
    ).toBe(true)
    expect(
      parseOpenCodeHttpFollowUp(
        {
          data: {
            admittedSeq: 7,
            id: 'msg_1',
            sessionID: 'ses_1',
            prompt: { text: 'http-steer' },
            delivery: 'steer'
          }
        },
        'http-steer'
      )
    ).toBe(false)
    expect(parseOpenCodeHttpFollowUp({ ok: true }, 'http-steer')).toBe(false)
  })

  it('fail-closes empty, startedNewTurn, and unknown steering outcomes', () => {
    expect(interpretSteerOutcome(parseSteerOutcome({ outcome: 'injected' }))).toEqual({
      kind: 'injected',
      transport: 'acp-steering'
    })
    expect(interpretSteerOutcome(parseSteerOutcome({}))).toEqual({
      kind: 'refused',
      reason: 'unrecognized-success'
    })
    expect(interpretSteerOutcome(parseSteerOutcome({ outcome: 'startedNewTurn' }))).toEqual({
      kind: 'refused',
      reason: 'started-new-turn'
    })
    expect(
      interpretSteerOutcome(
        parseSteerOutcome({ outcome: 'promptRequired', reason: 'noRunningTurn' })
      )
    ).toEqual({ kind: 'refused', reason: 'prompt-required' })
    expect(interpretSteerOutcome(parseSteerOutcome(null))).toEqual({
      kind: 'refused',
      reason: 'missing-outcome'
    })
  })
})
