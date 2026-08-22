import { describe, expect, it } from 'vitest'

import { AcpSessionInteractionOwner } from '../session-interaction-owner'
import {
  ACP_STEERING_METHOD,
  HOST_CONCURRENT_PROMPT_POLICY,
  PRODUCTION_HOST_FOLLOW_UP_BLOCKERS,
  SHIPPED_CLAUDE_AGENT_ACP_VERSION,
  SHIPPED_CODEX_ACP_VERSION,
  admitSecondSessionPrompt,
  buildSteerRequest,
  parseSteerOutcome,
  readSteeringAdvertisement,
  resolveShippedNativeSendNowCapability
} from './native-send-now-capability'

describe('native Send now capability spike', () => {
  it('pins the shipped adapter versions this spike inspected', () => {
    expect(SHIPPED_CLAUDE_AGENT_ACP_VERSION).toBe('0.60.0')
    expect(SHIPPED_CODEX_ACP_VERSION).toBe('1.1.4')
    expect(ACP_STEERING_METHOD).toBe('_session/steering')
    expect(HOST_CONCURRENT_PROMPT_POLICY).toBe('reject')
  })

  it('reads Claude-style top-level steering advertisement', () => {
    expect(
      readSteeringAdvertisement({
        protocolVersion: 1,
        _meta: { steering: { supported: true } }
      })
    ).toEqual({ supported: true })
  })

  it('reads nested agentCapabilities._meta steering advertisement', () => {
    expect(
      readSteeringAdvertisement({
        protocolVersion: 1,
        agentCapabilities: { _meta: { steering: { modes: ['queue', 'steer'] } } }
      })
    ).toEqual({ supported: true })
  })

  it('does not treat a queue-only advertisement as steering', () => {
    expect(
      readSteeringAdvertisement({
        protocolVersion: 1,
        _meta: { steering: { modes: ['queue'] } }
      })
    ).toEqual({ supported: false })
  })

  it('does not invent steering from an empty initialize _meta', () => {
    expect(readSteeringAdvertisement({ protocolVersion: 1, agentCapabilities: {} })).toEqual({
      supported: false
    })
  })

  it.each([
    [{ outcome: 'injected' }, { kind: 'injected' }],
    [{ outcome: 'startedNewTurn' }, { kind: 'started-new-turn' }],
    [
      { outcome: 'promptRequired', reason: 'noRunningTurn' },
      { kind: 'prompt-required', reason: 'noRunningTurn' }
    ]
  ] as const)('accepts a recognized steering outcome %j', (result, expected) => {
    expect(parseSteerOutcome(result)).toEqual(expected)
  })

  it('rejects an empty success object as an unrecognized extension', () => {
    expect(parseSteerOutcome({})).toEqual({
      kind: 'rejected',
      reason: 'unrecognized-success',
      raw: {}
    })
  })

  it('rejects a result with no outcome field', () => {
    const raw = { turnId: 'turn_456' }
    expect(parseSteerOutcome(raw)).toEqual({
      kind: 'rejected',
      reason: 'missing-outcome',
      raw
    })
  })

  it('rejects an unknown outcome instead of treating it as injected', () => {
    const raw = { outcome: 'failed' }
    expect(parseSteerOutcome(raw)).toEqual({
      kind: 'rejected',
      reason: 'unknown-outcome',
      raw
    })
  })

  it('builds the underscore steering request without exposing delivery priority', () => {
    expect(buildSteerRequest('sess_1', [{ type: 'text', text: 'focus on tests' }])).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'focus on tests' }]
    })
  })

  it('uses advertised steering for every framework and both Codex routes', () => {
    const advertised = { supported: true } as const
    for (const lookup of [
      { frameworkId: 'claude-code' as const, advertisement: advertised },
      { frameworkId: 'opencode' as const, advertisement: advertised },
      {
        frameworkId: 'codex' as const,
        route: 'codex-responses' as const,
        advertisement: advertised
      },
      {
        frameworkId: 'codex' as const,
        route: 'codex-bridge' as const,
        advertisement: advertised
      }
    ]) {
      const capability = resolveShippedNativeSendNowCapability(lookup)
      expect(capability).toMatchObject({
        kind: 'steering-extension',
        delivery: 'safe-breakpoint',
        method: ACP_STEERING_METHOD,
        frameworkCanDispatch: true,
        hostCanDispatch: false,
        usesSecondSessionPrompt: false,
        hostBlockers: ['no-steering-side-band']
      })
      expect(admitSecondSessionPrompt(capability)).toEqual({
        allowed: false,
        reason: 'wrong-mechanism',
        hostBlockers: ['no-steering-side-band']
      })
    }
  })

  it('treats unadvertised Claude Code as adapter-queued prompt blocked by the host', () => {
    const capability = resolveShippedNativeSendNowCapability({ frameworkId: 'claude-code' })
    expect(capability).toEqual({
      kind: 'queued-prompt',
      delivery: 'next-model-pause',
      frameworkCanDispatch: true,
      hostCanDispatch: false,
      usesSecondSessionPrompt: true,
      hostBlockers: [...PRODUCTION_HOST_FOLLOW_UP_BLOCKERS]
    })
    expect(admitSecondSessionPrompt(capability)).toEqual({
      allowed: false,
      reason: 'host-not-ready',
      hostBlockers: [...PRODUCTION_HOST_FOLLOW_UP_BLOCKERS]
    })
  })

  it.each([
    ['opencode', undefined],
    ['codex', 'codex-responses'],
    ['codex', 'codex-responses-compatibility'],
    ['codex', 'codex-bridge']
  ] as const)('has no unadvertised native Send now for %s %s', (frameworkId, route) => {
    const capability = resolveShippedNativeSendNowCapability({
      frameworkId,
      ...(route ? { route } : {})
    })
    expect(capability).toEqual({
      kind: 'none',
      delivery: 'unavailable',
      frameworkCanDispatch: false,
      hostCanDispatch: false,
      usesSecondSessionPrompt: false,
      hostBlockers: ['framework-unsupported']
    })
    expect(admitSecondSessionPrompt(capability)).toEqual({
      allowed: false,
      reason: 'framework-unsupported',
      hostBlockers: ['framework-unsupported']
    })
  })

  it('would admit a second session/prompt only after host blockers are gone', () => {
    expect(
      admitSecondSessionPrompt({
        kind: 'queued-prompt',
        delivery: 'next-model-pause',
        frameworkCanDispatch: true,
        hostCanDispatch: true,
        usesSecondSessionPrompt: true,
        hostBlockers: []
      })
    ).toEqual({ allowed: true, mode: 'queued-prompt-adopt-after-stop' })
  })

  it('keeps the host from admitting a second prompt while one is already running', () => {
    const owner = new AcpSessionInteractionOwner()
    const first = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    expect(() => owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })).toThrow(
      'An ACP interaction is already running for this session'
    )
    expect(owner.current('session-1')).toBe(first)
  })
})
