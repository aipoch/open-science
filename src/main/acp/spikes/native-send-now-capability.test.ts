import { describe, expect, it } from 'vitest'

import { AcpSessionInteractionOwner } from '../session-interaction-owner'
import {
  ACP_STEERING_METHOD,
  HOST_CONCURRENT_PROMPT_POLICY,
  SHIPPED_CLAUDE_AGENT_ACP_VERSION,
  SHIPPED_CODEX_ACP_VERSION,
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
      expect(resolveShippedNativeSendNowCapability(lookup)).toEqual({
        kind: 'steering-extension',
        delivery: 'safe-breakpoint',
        method: ACP_STEERING_METHOD,
        hostCanDispatch: false
      })
    }
  })

  it('treats unadvertised Claude Code as adapter-queued prompt, not interrupt-free steer', () => {
    expect(resolveShippedNativeSendNowCapability({ frameworkId: 'claude-code' })).toEqual({
      kind: 'queued-prompt',
      delivery: 'next-model-pause',
      hostCanDispatch: false
    })
  })

  it.each([
    ['opencode', undefined],
    ['codex', 'codex-responses'],
    ['codex', 'codex-responses-compatibility'],
    ['codex', 'codex-bridge']
  ] as const)('has no unadvertised native Send now for %s %s', (frameworkId, route) => {
    expect(
      resolveShippedNativeSendNowCapability({
        frameworkId,
        ...(route ? { route } : {})
      })
    ).toEqual({
      kind: 'none',
      delivery: 'unavailable',
      hostCanDispatch: false
    })
  })

  it('keeps the host from admitting a second prompt while one is already running', () => {
    const owner = new AcpSessionInteractionOwner()
    owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    expect(() => owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })).toThrow(
      'An ACP interaction is already running for this session'
    )
  })
})
