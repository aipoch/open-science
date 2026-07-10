import { describe, expect, it } from 'vitest'

import { buildProviderEnv, getIsolatedClaudeConfigDir } from './provider-env'

const options = { storageRoot: '/root', claudeExecutablePath: '/bin/claude' }

describe('provider-env', () => {
  it('builds isolated env for a custom provider (always bearer)', () => {
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
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CONFIG_DIR: getIsolatedClaudeConfigDir('/root')
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

  it('omits base URL and isolated config dir for claude-default with a model override', () => {
    const env = buildProviderEnv({ type: 'claude-default', model: 'claude-opus' }, options)

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      ANTHROPIC_MODEL: 'claude-opus'
    })
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('omits the model for claude-default when none is set', () => {
    const env = buildProviderEnv({ type: 'claude-default' }, options)

    expect(env).toEqual({ CLAUDE_CODE_EXECUTABLE: '/bin/claude' })
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })
})
