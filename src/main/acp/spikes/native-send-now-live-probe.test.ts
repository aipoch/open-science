import { describe, expect, it } from 'vitest'

import {
  LATEST_CLAUDE_AGENT_ACP_VERSION,
  LATEST_CODEX_ACP_VERSION
} from './native-send-now-capability'
import {
  claudeLatestLaunch,
  codexLatestLaunch,
  liveClaudeAvailable,
  liveCodexAvailable,
  liveOpencodeAvailable,
  opencodeLaunch,
  probeLiveAdapter
} from './native-send-now-live-probe'

const LIVE = process.env.NATIVE_SEND_NOW_LIVE === '1'

describe.skipIf(!LIVE)('latest adapter live steering probe', () => {
  it('confirms Claude 0.70.0 advertises _session/steering', async () => {
    expect(liveClaudeAvailable()).toBe(true)
    const result = await probeLiveAdapter(
      'claude-code',
      claudeLatestLaunch(),
      LATEST_CLAUDE_AGENT_ACP_VERSION
    )
    expect(result.advertised).toBe(true)
    expect(result.initializeCapabilities.steering).toBe(true)
    expect(result.createdSession).toBe(true)
    expect(result.idleSteer).toEqual({ kind: 'prompt-required', reason: 'noRunningTurn' })
  }, 60_000)

  it('injects Claude 0.70.0 steering into a live session/prompt', async () => {
    const result = await probeLiveAdapter(
      'claude-code',
      claudeLatestLaunch(),
      LATEST_CLAUDE_AGENT_ACP_VERSION,
      'inject'
    )
    expect(result.promptStarted).toBe(true)
    expect(result.liveSteer).toEqual({ kind: 'injected' })
  }, 60_000)

  it('confirms Codex ACP 1.6.2 advertises _session/steering against shipped native 0.144.6', async () => {
    expect(liveCodexAvailable()).toBe(true)
    const result = await probeLiveAdapter(
      'codex',
      codexLatestLaunch(undefined, '/opt/homebrew/bin/codex'),
      LATEST_CODEX_ACP_VERSION
    )
    expect(result.advertised).toBe(true)
    expect(result.initializeCapabilities.steering).toBe(true)
    expect(result.createdSession).toBe(true)
    expect(result.idleSteer).toEqual({ kind: 'started-new-turn' })
  }, 60_000)

  it('injects Codex ACP 1.6.2 steering into a live session/prompt', async () => {
    const result = await probeLiveAdapter(
      'codex',
      codexLatestLaunch(undefined, '/opt/homebrew/bin/codex'),
      LATEST_CODEX_ACP_VERSION,
      'inject'
    )
    expect(result.promptStarted).toBe(true)
    expect(result.liveSteer).toEqual({ kind: 'injected' })
  }, 60_000)

  it('confirms OpenCode ACP still does not advertise steering', async () => {
    expect(liveOpencodeAvailable()).toBe(true)
    const result = await probeLiveAdapter('opencode', opencodeLaunch(), '1.18.3')
    expect(result.advertised).toBe(false)
    expect(result.initializeCapabilities.steering).toBe(false)
    expect(result.idleSteer).toMatchObject({ kind: 'method-not-found' })
  }, 60_000)
})
