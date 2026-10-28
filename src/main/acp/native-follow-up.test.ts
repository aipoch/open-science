import { describe, expect, it } from 'vitest'

import {
  ACP_STEERING_METHOD,
  CODEBUDDY_STEER_METHOD,
  STEERING_IDLE_BEHAVIOR,
  buildAcpSteeringParams,
  buildCodeBuddySteerParams,
  buildOpenCodeHttpFollowUpBody,
  contentBlocksToOpenCodeFollowUpParts,
  interpretSteerOutcome,
  parseOpenCodeHttpFollowUp,
  parseCodeBuddySteer,
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
  it('preserves multiple text blocks and attached files in a 2.x inbox input', () => {
    expect(
      buildOpenCodeHttpFollowUpBody(
        [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'skill guidance' },
          {
            type: 'file',
            mime: 'image/png',
            url: 'data:image/png;base64,aA==',
            filename: 'image.png'
          }
        ],
        2
      )
    ).toEqual({
      text: 'first\n\nskill guidance',
      files: [{ uri: 'data:image/png;base64,aA==', name: 'image.png' }],
      delivery: 'steer',
      resume: false
    })
  })

  it('accepts only a matching 2.x inbox acknowledgement', () => {
    const result = {
      data: {
        type: 'user',
        id: 'msg_1',
        sessionID: 'session',
        delivery: 'steer',
        payload: { text: 'hello' }
      }
    }
    expect(parseOpenCodeHttpFollowUp(result, 'hello', 2, 'session')).toBe(true)
    expect(parseOpenCodeHttpFollowUp(result, 'different', 2, 'session')).toBe(false)
    expect(parseOpenCodeHttpFollowUp(result, 'hello', 2, 'other-session')).toBe(false)
    expect(
      parseOpenCodeHttpFollowUp({ data: { ...result.data, id: '' } }, 'hello', 2, 'session')
    ).toBe(false)
    expect(parseOpenCodeHttpFollowUp({}, 'hello', 2, 'session')).toBe(false)
  })

  it('reads steering from Claude and Codex initialize _meta', () => {
    expect(readSteeringAdvertisement(CLAUDE_STEERING_INITIALIZE)).toEqual({ supported: true })
    expect(retainInitializeCapabilities(CLAUDE_STEERING_INITIALIZE)).toEqual({
      close: true,
      delete: true,
      resume: true,
      steering: true
    })
    expect(retainInitializeCapabilities(CODEX_STEERING_INITIALIZE).steering).toBe(true)
    expect(retainInitializeCapabilities({ agentCapabilities: {} }, 'codebuddy').resume).toBe(true)
    expect(
      readSteeringAdvertisement({
        protocolVersion: 1,
        agentCapabilities: { _meta: { steering: { modes: ['queue', 'steer'] } } }
      })
    ).toEqual({ supported: true })
    expect(
      readSteeringAdvertisement({
        protocolVersion: 1,
        _meta: { steering: { modes: ['queue'] } }
      })
    ).toEqual({ supported: false })
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
        frameworkId: 'codebuddy',
        hasOpenCodeHttp: false,
        text: 'focus on tests'
      })
    ).toEqual({ transport: 'codebuddy-acp-steer' })
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
    ).toEqual({ transport: 'acp-steering' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: '   ',
        hasAttachments: true
      })
    ).toEqual({ transport: 'acp-steering' })
    expect(
      resolveNativeFollowUpRoute({
        advertisedSteering: true,
        hasLivePrompt: true,
        frameworkId: 'claude-code',
        hasOpenCodeHttp: false,
        text: '   ',
        hasForcedSkills: true
      })
    ).toEqual({ transport: 'acp-steering' })
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
    expect(buildAcpSteeringParams('sess_1', [{ type: 'text', text: 'focus on tests' }])).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'focus on tests' }],
      _meta: { steering: { idleBehavior: STEERING_IDLE_BEHAVIOR } }
    })
    expect(ACP_STEERING_METHOD).toBe('_session/steering')
    expect(CODEBUDDY_STEER_METHOD).toBe('session/steer')
    expect(buildCodeBuddySteerParams('sess_1', [{ type: 'text', text: 'focus' }])).toEqual({
      sessionId: 'sess_1',
      contentBlocks: [{ type: 'text', text: 'focus' }]
    })
    expect(parseCodeBuddySteer({ steered: true })).toBe(true)
    expect(parseCodeBuddySteer({ steered: false, reason: 'no active prompt' })).toBe(false)
    expect(buildOpenCodeHttpFollowUpBody([{ type: 'text', text: 'http-steer' }])).toEqual({
      parts: [{ type: 'text', text: 'http-steer' }],
      noReply: true
    })
    expect(
      contentBlocksToOpenCodeFollowUpParts([
        { type: 'text', text: 'see this' },
        { type: 'image', data: 'abc', mimeType: 'image/png' }
      ])
    ).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'image' }
    ])
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
    expect(
      parseOpenCodeHttpFollowUp(
        {
          data: {
            info: { id: 'msg_1', role: 'user', sessionID: 'ses_1' },
            parts: [{ type: 'text', text: 'http-steer' }]
          }
        },
        'http-steer'
      )
    ).toBe(true)
  })

  it('fail-closes empty and unknown steering outcomes, and treats startedNewTurn as injected', () => {
    expect(interpretSteerOutcome(parseSteerOutcome({ outcome: 'injected' }))).toEqual({
      kind: 'injected',
      transport: 'acp-steering'
    })
    expect(interpretSteerOutcome(parseSteerOutcome({}))).toEqual({
      kind: 'refused',
      reason: 'unrecognized-success'
    })
    expect(interpretSteerOutcome(parseSteerOutcome({ outcome: 'startedNewTurn' }))).toEqual({
      kind: 'injected',
      transport: 'acp-steering'
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
    expect(parseSteerOutcome({ turnId: 'turn_456' })).toEqual({
      kind: 'rejected',
      reason: 'missing-outcome',
      raw: { turnId: 'turn_456' }
    })
    expect(parseSteerOutcome({ outcome: 'failed' })).toEqual({
      kind: 'rejected',
      reason: 'unknown-outcome',
      raw: { outcome: 'failed' }
    })
  })
})
