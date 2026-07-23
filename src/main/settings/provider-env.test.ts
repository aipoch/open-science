import { describe, expect, it } from 'vitest'

import { buildProviderEnv, getAppClaudeConfigDir } from './provider-env'

const options = { storageRoot: '/root', claudeExecutablePath: '/bin/claude' }

describe('provider-env', () => {
  it('builds env for a custom provider under the app config dir (always bearer)', () => {
    const env = buildProviderEnv(
      {
        type: 'custom',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        key: 'test-token'
      },
      options
    )

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir('/root'),
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'test-token'
    })
    // Custom providers never use x-api-key; the key is always sent as a bearer token.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('normalizes a base URL that already carries /v1 so the client does not double it', () => {
    const env = buildProviderEnv(
      {
        type: 'custom',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-5',
        key: 'test-token'
      },
      options
    )

    // The client appends /v1/messages itself; ANTHROPIC_BASE_URL must not carry a redundant /v1.
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
  })

  it('injects CLAUDE_CODE_OAUTH_TOKEN for a claude-isolated provider under the app config dir', () => {
    // claude-isolated authenticates a Claude subscription via a long-lived OAuth token (from
    // `claude setup-token`). The token is portable across config dirs, so isolation comes from the
    // app-owned CLAUDE_CONFIG_DIR + this one env var — no ANTHROPIC_BASE_URL, no ANTHROPIC_AUTH_TOKEN.
    const env = buildProviderEnv(
      {
        type: 'claude-isolated',
        model: 'claude-sonnet-4-5',
        key: 'sk-ant-oauth-token'
      },
      options
    )

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir('/root'),
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oauth-token'
    })
    // claude-isolated never sets the legacy bearer / base-url envs: isolation comes from the token.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('still sets CLAUDE_CONFIG_DIR for claude-isolated when no model or token is provided', () => {
    // The 'isolated' predicate in agent-process.ts keys on 'CLAUDE_CONFIG_DIR' in envOverrides — so
    // the agent's env-strip logic must always find it, even on an unauthenticated provider.
    const env = buildProviderEnv({ type: 'claude-isolated' }, options)

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir('/root')
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})
