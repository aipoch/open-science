import { describe, expect, it } from 'vitest'

import { AcpSessionInteractionOwner } from '../session-interaction-owner'
import {
  ACP_STEERING_METHOD,
  HOST_CONCURRENT_PROMPT_POLICY,
  PRODUCTION_HOST_FOLLOW_UP_BLOCKERS,
  FIRST_CLAUDE_STEERING_ACP_VERSION,
  FIRST_CODEX_STEERING_ACP_VERSION,
  LATEST_CLAUDE_AGENT_ACP_VERSION,
  LATEST_CODEX_ACP_VERSION,
  LATEST_OPENCODE_VERSION,
  LIVE_LATEST_IDLE_STEER,
  LIVE_LATEST_INJECT_STEER,
  SHIPPED_CLAUDE_AGENT_ACP_VERSION,
  SHIPPED_CODEX_ACP_VERSION,
  SHIPPED_OPENCODE_VERSION,
  admitSecondSessionPrompt,
  buildSteerRequest,
  parseSteerOutcome,
  readSteeringAdvertisement,
  resolveLatestNativeSendNowCapability,
  resolveShippedNativeSendNowCapability
} from './native-send-now-capability'

describe('native Send now capability spike', () => {
  it('pins the shipped adapter versions this spike inspected', () => {
    expect(SHIPPED_CLAUDE_AGENT_ACP_VERSION).toBe('0.60.0')
    expect(SHIPPED_CODEX_ACP_VERSION).toBe('1.1.4')
    expect(SHIPPED_OPENCODE_VERSION).toBe('1.18.3')
    expect(FIRST_CLAUDE_STEERING_ACP_VERSION).toBe('0.61.0')
    expect(FIRST_CODEX_STEERING_ACP_VERSION).toBe('1.2.0')
    expect(LATEST_CLAUDE_AGENT_ACP_VERSION).toBe('0.70.0')
    expect(LATEST_CODEX_ACP_VERSION).toBe('1.6.2')
    expect(LATEST_OPENCODE_VERSION).toBe('1.18.3')
    expect(LIVE_LATEST_IDLE_STEER).toEqual({
      claude: { kind: 'prompt-required', reason: 'noRunningTurn' },
      codex: { kind: 'started-new-turn' },
      opencode: { kind: 'method-not-found' }
    })
    expect(LIVE_LATEST_INJECT_STEER).toEqual({
      claude: { kind: 'injected' },
      codex: { kind: 'injected' }
    })
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
        overlappingPrompt: 'none',
        nativeCliHasMidTurnInput: true,
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
      overlappingPrompt: 'queue-and-handoff',
      nativeCliHasMidTurnInput: true,
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

  it('treats unadvertised OpenCode as admit-and-join-runner, not Send now', () => {
    const capability = resolveShippedNativeSendNowCapability({ frameworkId: 'opencode' })
    expect(capability).toEqual({
      kind: 'none',
      delivery: 'unavailable',
      overlappingPrompt: 'admit-and-join-runner',
      nativeCliHasMidTurnInput: true,
      frameworkCanDispatch: true,
      hostCanDispatch: false,
      usesSecondSessionPrompt: false,
      hostBlockers: ['admit-and-join-runner']
    })
    expect(admitSecondSessionPrompt(capability)).toEqual({
      allowed: false,
      reason: 'admit-and-join-runner',
      hostBlockers: ['admit-and-join-runner']
    })
  })

  it.each(['codex-responses', 'codex-responses-compatibility', 'codex-bridge'] as const)(
    'treats unadvertised Codex %s as replace-and-interrupt, not Send now',
    (route) => {
      const capability = resolveShippedNativeSendNowCapability({
        frameworkId: 'codex',
        route
      })
      expect(capability).toEqual({
        kind: 'none',
        delivery: 'unavailable',
        overlappingPrompt: 'replace-and-interrupt',
        nativeCliHasMidTurnInput: true,
        frameworkCanDispatch: true,
        hostCanDispatch: false,
        usesSecondSessionPrompt: false,
        hostBlockers: ['replace-and-interrupt']
      })
      expect(admitSecondSessionPrompt(capability)).toEqual({
        allowed: false,
        reason: 'replace-and-interrupt',
        hostBlockers: ['replace-and-interrupt']
      })
    }
  )

  it('does not admit OpenCode join even after host blockers are cleared', () => {
    expect(
      admitSecondSessionPrompt({
        kind: 'none',
        delivery: 'unavailable',
        overlappingPrompt: 'admit-and-join-runner',
        nativeCliHasMidTurnInput: true,
        frameworkCanDispatch: true,
        hostCanDispatch: true,
        usesSecondSessionPrompt: false,
        hostBlockers: []
      })
    ).toEqual({
      allowed: false,
      reason: 'admit-and-join-runner',
      hostBlockers: []
    })
  })

  it('does not admit Codex replace-and-interrupt even after host blockers are cleared', () => {
    expect(
      admitSecondSessionPrompt({
        kind: 'none',
        delivery: 'unavailable',
        overlappingPrompt: 'replace-and-interrupt',
        nativeCliHasMidTurnInput: true,
        frameworkCanDispatch: true,
        hostCanDispatch: true,
        usesSecondSessionPrompt: false,
        hostBlockers: []
      })
    ).toEqual({
      allowed: false,
      reason: 'replace-and-interrupt',
      hostBlockers: []
    })
  })

  it('would admit a second session/prompt only after host blockers are gone', () => {
    expect(
      admitSecondSessionPrompt({
        kind: 'queued-prompt',
        delivery: 'next-model-pause',
        overlappingPrompt: 'queue-and-handoff',
        nativeCliHasMidTurnInput: true,
        frameworkCanDispatch: true,
        hostCanDispatch: true,
        usesSecondSessionPrompt: true,
        hostBlockers: []
      })
    ).toEqual({ allowed: true, mode: 'queued-prompt-adopt-after-stop' })
  })

  it.each([
    ['claude-code', undefined],
    ['codex', 'codex-responses'],
    ['codex', 'codex-bridge']
  ] as const)(
    'treats latest unadvertised %s %s as advertised steering, not overlapping prompt',
    (frameworkId, route) => {
      const capability = resolveLatestNativeSendNowCapability({
        frameworkId,
        ...(route ? { route } : {})
      })
      expect(capability).toMatchObject({
        kind: 'steering-extension',
        method: ACP_STEERING_METHOD,
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
  )

  it('keeps latest OpenCode on admit-and-join-runner', () => {
    const capability = resolveLatestNativeSendNowCapability({ frameworkId: 'opencode' })
    expect(capability.overlappingPrompt).toBe('admit-and-join-runner')
    expect(admitSecondSessionPrompt(capability).allowed).toBe(false)
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
