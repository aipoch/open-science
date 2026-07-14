import { describe, expect, it } from 'vitest'

import { buildAgentSpawnEnv, toUnpackedAsarPath } from './agent-process'

describe('ACP agent process packaging paths', () => {
  it('uses the real unpacked path for executables resolved inside app.asar', () => {
    expect(
      toUnpackedAsarPath(
        '/Applications/Open Science.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
      )
    ).toBe(
      '/Applications/Open Science.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    )
  })

  it('unpacks asar paths that use Windows separators', () => {
    // The regex accepts back-slashes too, so a packaged Windows install redirects into
    // app.asar.unpacked the same way the POSIX case above does.
    expect(
      toUnpackedAsarPath(
        'C:\\Program Files\\Open Science\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
      )
    ).toBe(
      'C:\\Program Files\\Open Science\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
    )
  })

  it('leaves development node_modules paths unchanged', () => {
    expect(
      toUnpackedAsarPath(
        '/home/dev/project/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
      )
    ).toBe('/home/dev/project/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  })
})

describe('buildAgentSpawnEnv', () => {
  // A custom provider is isolated (its overrides include CLAUDE_CONFIG_DIR).
  const isolatedOverrides = {
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_AUTH_TOKEN: 'provider-token',
    ANTHROPIC_MODEL: 'gateway-model',
    CLAUDE_CONFIG_DIR: '/root/claude'
  }

  it('drops inherited ANTHROPIC_* for an isolated provider so parent creds cannot leak', () => {
    const env = buildAgentSpawnEnv(
      {
        ANTHROPIC_BASE_URL: 'https://proxy.example', // inherited proxy — must not survive
        ANTHROPIC_API_KEY: 'inherited-token', // not overridden — must be dropped, not leaked
        ANTHROPIC_CUSTOM_HEADERS: 'x: y',
        PATH: '/usr/bin'
      },
      isolatedOverrides,
      '/bin/claude'
    )

    // Only the provider's own endpoint/token/model remain.
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('provider-token')
    // Inherited ANTHROPIC_* that the provider does not set are removed entirely.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
    // Non-Anthropic inherited vars are preserved.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe('/bin/claude')
  })

  it('keeps inherited ANTHROPIC_* for a non-isolated (claude-default) provider', () => {
    const env = buildAgentSpawnEnv(
      {
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        CLAUDE_CONFIG_DIR: '/inherited/isolated-config',
        PATH: '/usr/bin'
      },
      // claude-default overrides carry no CLAUDE_CONFIG_DIR → not isolated.
      { ANTHROPIC_MODEL: 'claude-opus' },
      '/bin/claude'
    )

    // Reuses the user's global environment (proxy, login, etc.).
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example')
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus')
    // Native credential stores are keyed to Claude's implicit config context.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe('/bin/claude')
  })
})
