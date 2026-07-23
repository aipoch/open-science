import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveExecutable: vi.fn((path: string) => path),
  augmentedPathEnv: vi.fn((env: NodeJS.ProcessEnv) => ({ ...env, PATH: '/augmented/bin' })),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./claude-executable', () => ({
  resolveClaudeExecutableForSpawn: mocks.resolveExecutable
}))
vi.mock('../settings/shell-path', () => ({ augmentedPathEnv: mocks.augmentedPathEnv }))
vi.mock('../logger', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error })
}))

import { buildAgentSpawnEnv, spawnClaudeAgentAcp, toUnpackedAsarPath } from './agent-process'

const originalDebugAgent = process.env.OPEN_SCIENCE_DEBUG_AGENT

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.OPEN_SCIENCE_DEBUG_AGENT
})

afterEach(() => {
  if (originalDebugAgent === undefined) delete process.env.OPEN_SCIENCE_DEBUG_AGENT
  else process.env.OPEN_SCIENCE_DEBUG_AGENT = originalDebugAgent
})

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

  it('drops inherited CLAUDE_CODE_OAUTH_TOKEN so a custom gateway cannot carry a subscription', () => {
    // The setup-token flow writes CLAUDE_CODE_OAUTH_TOKEN to the shell. A custom / official gateway
    // that does not set this var would let the parent's subscription token bleed into the spawned
    // agent and authenticate as the wrong account. The filter strips the var unconditionally so the
    // override block is the only path that can carry auth forward.
    const env = buildAgentSpawnEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-leaked-from-shell',
        PATH: '/usr/bin'
      },
      {
        CLAUDE_CONFIG_DIR: '/provider/config',
        ANTHROPIC_AUTH_TOKEN: 'provider-token'
      },
      '/bin/claude'
    )

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('provider-token')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/provider/config')
  })

  it('preserves the legacy local Claude auth context until claude-default is removed', () => {
    const env = buildAgentSpawnEnv(
      {
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        CLAUDE_CODE_OAUTH_TOKEN: 'local-subscription-token',
        CLAUDE_CONFIG_DIR: '/inherited/config',
        PATH: '/usr/bin'
      },
      { ANTHROPIC_MODEL: 'claude-opus' },
      '/bin/claude'
    )

    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('local-subscription-token')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus')
  })

  it('drops inherited CLAUDE_CONFIG_DIR even when envOverrides provides a different one', () => {
    // The override block is the only path that can set CLAUDE_CONFIG_DIR for the child. The
    // parent shell may have a different value (developer who happens to have a Claude Code login
    // elsewhere); the override must always win.
    const env = buildAgentSpawnEnv(
      {
        CLAUDE_CONFIG_DIR: '/parent/shell/claude',
        PATH: '/usr/bin'
      },
      { CLAUDE_CONFIG_DIR: '/app/claude' },
      '/bin/claude'
    )

    expect(env.CLAUDE_CONFIG_DIR).toBe('/app/claude')
  })
})

describe('spawnClaudeAgentAcp', () => {
  it('rejects startup without a detected Claude executable', () => {
    expect(() => spawnClaudeAgentAcp()).toThrow(
      'Claude executable path is not configured. Complete Claude detection in settings first.'
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('spawns the packaged ACP entry through Electron-as-Node with isolated provider env', () => {
    const child = { on: vi.fn() }
    mocks.spawn.mockReturnValue(child)
    mocks.resolveExecutable.mockReturnValue('/resolved/claude')

    expect(
      spawnClaudeAgentAcp({
        executablePath: '/bin/claude',
        envOverrides: {
          CLAUDE_CONFIG_DIR: '/provider/config',
          ANTHROPIC_AUTH_TOKEN: 'secret'
        }
      })
    ).toBe(child)

    const [runtime, args, options] = mocks.spawn.mock.calls[0]!
    expect(runtime).toBe(process.execPath)
    expect(args).toEqual([expect.stringContaining('claude-agent-acp/dist/index.js')])
    expect(options).toMatchObject({
      stdio: 'pipe',
      windowsHide: true,
      env: expect.objectContaining({
        PATH: '/augmented/bin',
        CLAUDE_CODE_EXECUTABLE: '/resolved/claude',
        CLAUDE_CONFIG_DIR: '/provider/config',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        ELECTRON_RUN_AS_NODE: '1'
      })
    })
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child.on).toHaveBeenCalledWith('exit', expect.any(Function))
  })

  it('enables SDK diagnostics only when explicitly requested', () => {
    process.env.OPEN_SCIENCE_DEBUG_AGENT = '1'
    mocks.spawn.mockReturnValue({ on: vi.fn() })

    spawnClaudeAgentAcp({
      executablePath: '/bin/claude',
      envOverrides: { CLAUDE_CONFIG_DIR: '/provider/config' }
    })

    expect(mocks.spawn.mock.calls[0]?.[2]?.env).toEqual(
      expect.objectContaining({ DEBUG_CLAUDE_AGENT_SDK: '1' })
    )
  })
})
