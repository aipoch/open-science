import { describe, expect, it } from 'vitest'

import { buildProviderEnv, getIsolatedClaudeConfigDir } from './provider-env'

const options = { storageRoot: '/root', claudeExecutablePath: '/bin/claude' }

describe('provider-env', () => {
  it('builds isolated env for a custom provider (always bearer)', () => {
    const env = buildProviderEnv(
      {
        type: 'custom',
        baseUrl: 'https://gateway.example/v1',
        model: 'claude-sonnet-4-5',
        key: 'secret-token'
      },
      options
    )

    expect(env).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/bin/claude',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CONFIG_DIR: getIsolatedClaudeConfigDir('/root')
    })
    // Custom providers never use x-api-key; the key is always sent as a bearer token.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
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
