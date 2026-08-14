import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CodexLoginError,
  codexLoginCommand,
  createCodexLoginEnvironment,
  resolveConfiguredCodexNativePath
} from './codex-login.mjs'

const configRoot = resolve('open-science-config')
const codexPath = resolve('managed-codex', process.platform === 'win32' ? 'codex.exe' : 'codex')

// The exact Vitest mock tuple types are test-local implementation detail.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const commandDeps = (runCodex = vi.fn()) => ({
  locateApp: vi.fn().mockResolvedValue({ packaged: false }),
  resolveConfigRoot: vi.fn().mockReturnValue(configRoot),
  resolveNativePath: vi.fn().mockResolvedValue(codexPath),
  mkdir: vi.fn().mockResolvedValue(undefined),
  runCodex,
  log: vi.fn()
})

describe('Codex CLI login', () => {
  it('isolates Codex credentials from the user environment', () => {
    const codexHome = resolve('profile', 'codex-subscription')
    const env = createCodexLoginEnvironment(
      codexHome,
      {
        PATH: '/usr/bin',
        HOME: '/home/alice',
        USERPROFILE: '/users/alice',
        CODEX_HOME: '/home/alice/.codex',
        CODEX_API_KEY: 'secret',
        OPENAI_API_KEY: 'secret',
        CODEX_CONFIG: 'secret',
        CODEX_PATH: '/other/codex',
        DEFAULT_AUTH_REQUEST: 'browser',
        MODEL_PROVIDER: 'other',
        NO_BROWSER: '1'
      },
      'win32'
    )

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CODEX_HOME: codexHome,
      HOME: codexHome,
      USERPROFILE: codexHome
    })
    expect(env).not.toHaveProperty('CODEX_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('CODEX_CONFIG')
    expect(env).not.toHaveProperty('CODEX_PATH')
    expect(env).not.toHaveProperty('DEFAULT_AUTH_REQUEST')
    expect(env).not.toHaveProperty('MODEL_PROVIDER')
    expect(env).not.toHaveProperty('NO_BROWSER')
  })

  it('uses the absolute native Codex path recorded in settings', async () => {
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ codex: { nativePath: codexPath } }))
    const access = vi.fn().mockResolvedValue(undefined)

    await expect(resolveConfiguredCodexNativePath(configRoot, { readFile, access })).resolves.toBe(
      codexPath
    )
    expect(readFile).toHaveBeenCalledWith(resolve(configRoot, 'settings.json'))
    expect(access).toHaveBeenCalledWith(codexPath)
  })

  it('fails closed when no native Codex path is configured', async () => {
    await expect(
      resolveConfiguredCodexNativePath(configRoot, {
        readFile: vi.fn().mockResolvedValue(JSON.stringify({ codex: {} })),
        access: vi.fn()
      })
    ).rejects.toMatchObject({
      code: 'codex_not_configured',
      message: expect.stringContaining('no native CLI path')
    })
  })

  it('does not replace an existing Open Science Codex login by default', async () => {
    const runCodex = vi.fn().mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' })
    const deps = commandDeps(runCodex)

    await codexLoginCommand({ force: false }, deps)

    expect(runCodex).toHaveBeenCalledTimes(1)
    expect(runCodex.mock.calls[0][1]).toEqual([
      '-c',
      'cli_auth_credentials_store="file"',
      'login',
      'status'
    ])
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('--force'))
  })

  it('runs native device auth in the current terminal for a signed-out profile', async () => {
    const runCodex = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, signal: null, stdout: '', stderr: 'Not logged in' })
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
    const deps = commandDeps(runCodex)

    await codexLoginCommand({ force: false }, deps)

    expect(runCodex).toHaveBeenNthCalledWith(
      2,
      codexPath,
      ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      expect.objectContaining({
        inherit: true,
        env: expect.objectContaining({
          CODEX_HOME: resolve(configRoot, 'codex-subscription'),
          HOME: resolve(configRoot, 'codex-subscription')
        })
      })
    )
    expect(deps.log).toHaveBeenLastCalledWith('Codex is signed in for Open Science.')
  })

  it('starts a replacement login without checking status when forced', async () => {
    const runCodex = vi.fn().mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' })
    const deps = commandDeps(runCodex)

    await codexLoginCommand({ force: true }, deps)

    expect(runCodex).toHaveBeenCalledOnce()
    expect(runCodex.mock.calls[0][1]).toContain('--device-auth')
  })

  it('preserves the native login exit code on failure', async () => {
    const runCodex = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, signal: null, stdout: '', stderr: 'Not logged in' })
      .mockResolvedValueOnce({ code: 17, signal: null, stdout: '', stderr: '' })

    await expect(codexLoginCommand({ force: false }, commandDeps(runCodex))).rejects.toEqual(
      expect.objectContaining({
        name: 'CodexLoginError',
        code: 'codex_login_failed',
        exitCode: 17
      })
    )
  })

  it('rejects config-root overrides for packaged profiles', async () => {
    const deps = {
      ...commandDeps(),
      locateApp: vi.fn().mockResolvedValue({ packaged: true })
    }

    await expect(codexLoginCommand({ configRoot, force: false }, deps)).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_cli_usage',
        exitCode: 2
      })
    )
  })

  it('uses a typed error contract for callers', () => {
    expect(new CodexLoginError('failed')).toMatchObject({
      name: 'CodexLoginError',
      code: 'codex_login_failed',
      exitCode: 1
    })
  })
})
