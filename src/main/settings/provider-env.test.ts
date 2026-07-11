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

  it('uses the shared app config dir for a local (claude-default) provider, no endpoint/token', () => {
    const env = buildProviderEnv({ type: 'claude-default', model: 'claude-opus' }, options)

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir('/root'),
      ANTHROPIC_MODEL: 'claude-opus'
    })
    // Local reuses the auth stored in the app dir, so no endpoint/token is injected here.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('omits the model for a local provider when none is set', () => {
    const env = buildProviderEnv({ type: 'claude-default' }, options)

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir('/root')
    })
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })
})
