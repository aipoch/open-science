import { resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import {
  CodexLoginError,
  applyCodexLoginProxyPolicy,
  codexLoginCommand,
  createCodexLoginEnvironment,
  resolveCodexLoginConfiguration,
  resolveConfiguredCodexNativePath
} from './codex-login.mjs'

const configRoot = resolve('open-science-config')
const codexPath = resolve('managed-codex', process.platform === 'win32' ? 'codex.exe' : 'codex')

// The exact Vitest mock tuple types are test-local implementation detail.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const commandDeps = (runCodex = vi.fn()) => ({
  connect: vi.fn().mockResolvedValue({ bootstrap: vi.fn().mockResolvedValue({ ok: true }) }),
  locateApp: vi.fn().mockResolvedValue({ packaged: false }),
  resolveConfigRoot: vi.fn().mockReturnValue(configRoot),
  resolveConfiguration: vi.fn().mockResolvedValue({ codexPath }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  runCodex,
  log: vi.fn()
})

describe('Codex CLI login', () => {
  it('prepares an empty profile before resolving the runtime and registers a successful login', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'osci-first-login-'))
    const nativePath = resolve(root, 'codex')
    const bootstrap = vi.fn(async (request) => {
      if (request.action === 'codex-prepare') {
        await writeFile(nativePath, 'synthetic runtime')
        await writeFile(resolve(root, 'settings.json'), JSON.stringify({ codex: { nativePath } }))
      }
      return { ok: true }
    })
    const deps = {
      ...commandDeps(vi.fn().mockResolvedValue({ code: 0 })),
      resolveConfigRoot: () => root,
      resolveConfiguration: resolveCodexLoginConfiguration,
      connect: vi.fn().mockResolvedValue({ bootstrap })
    }
    try {
      await codexLoginCommand({ configRoot: root }, deps)
      expect(bootstrap.mock.calls.map(([request]) => request.action)).toEqual([
        'codex-prepare',
        'codex-complete'
      ])
      expect(deps.runCodex).toHaveBeenCalledWith(nativePath, expect.any(Array), expect.any(Object))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('preserves configured native login when an older daemon lacks bootstrap', async () => {
    const deps = commandDeps(vi.fn().mockResolvedValue({ code: 0 }))
    const bootstrap = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    deps.connect.mockResolvedValue({ bootstrap })
    await codexLoginCommand({ configRoot }, deps)
    expect(deps.runCodex).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledOnce()
    expect(deps.log.mock.calls.flat().join(' ')).toContain('updated Open Science daemon')
  })

  it('requests a daemon update for an empty profile on an older daemon', async () => {
    const deps = commandDeps()
    deps.connect.mockResolvedValue({
      bootstrap: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    })
    deps.resolveConfiguration.mockRejectedValue(new Error('not configured'))
    await expect(codexLoginCommand({ configRoot }, deps)).rejects.toMatchObject({
      code: 'bootstrap_unavailable'
    })
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it.each([401, 403, 500])(
    'does not bypass bootstrap HTTP %s errors with native login',
    async (status) => {
      const deps = commandDeps()
      const error = Object.assign(new Error('failed'), { status })
      deps.connect.mockResolvedValue({ bootstrap: vi.fn().mockRejectedValue(error) })
      await expect(codexLoginCommand({ configRoot }, deps)).rejects.toBe(error)
      expect(deps.runCodex).not.toHaveBeenCalled()
    }
  )

  it('preserves configured native login when the daemon is unavailable', async () => {
    const deps = commandDeps(vi.fn().mockResolvedValue({ code: 0 }))
    deps.connect.mockRejectedValue(
      Object.assign(new Error('stopped'), { code: 'daemon_unavailable' })
    )
    await codexLoginCommand({ configRoot }, deps)
    expect(deps.runCodex).toHaveBeenCalledOnce()
    expect(deps.log.mock.calls.flat().join(' ')).toContain('updated Open Science daemon')
  })

  it.each([401, 403, 500])(
    'preserves connection health HTTP %s errors before native login',
    async (status) => {
      const deps = commandDeps()
      const error = Object.assign(new Error('health rejected'), {
        code: 'daemon_unavailable',
        status
      })
      deps.connect.mockRejectedValue(error)
      await expect(codexLoginCommand({ configRoot }, deps)).rejects.toBe(error)
      expect(deps.runCodex).not.toHaveBeenCalled()
    }
  )

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

  it('applies the configured manual proxy without inheriting stale proxy values', () => {
    const env = applyCodexLoginProxyPolicy(
      {
        HTTP_PROXY: 'http://stale.example.test:8080',
        NO_PROXY: 'stale.internal'
      },
      {
        mode: 'manual',
        server: 'socks5://127.0.0.1:1086',
        bypassRules: 'example.internal'
      }
    )

    expect(env.HTTP_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(env.HTTPS_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(env.NO_PROXY).toContain('example.internal')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).not.toContain('stale.internal')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('clears inherited proxy values in Direct mode', () => {
    const env = applyCodexLoginProxyPolicy(
      {
        HTTP_PROXY: 'http://stale.example.test:8080',
        HTTPS_PROXY: 'http://stale.example.test:8080',
        NO_PROXY: 'stale.internal'
      },
      { mode: 'direct' }
    )

    expect(env).not.toHaveProperty('HTTP_PROXY')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('NO_PROXY')
  })

  it('preserves inherited proxy values in System mode and adds loopback bypasses', () => {
    const env = applyCodexLoginProxyPolicy(
      {
        HTTPS_PROXY: 'http://system.example.test:8080',
        NO_PROXY: 'existing.internal'
      },
      undefined
    )

    expect(env.HTTPS_PROXY).toBe('http://system.example.test:8080')
    expect(env.NO_PROXY).toContain('existing.internal')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('uses the absolute native Codex path recorded in settings', async () => {
    const networkProxy = { mode: 'direct' }
    const readFile = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ codex: { nativePath: codexPath }, networkProxy }))
    const access = vi.fn().mockResolvedValue(undefined)

    await expect(resolveConfiguredCodexNativePath(configRoot, { readFile, access })).resolves.toBe(
      codexPath
    )
    await expect(resolveCodexLoginConfiguration(configRoot, { readFile, access })).resolves.toEqual(
      {
        codexPath,
        networkProxy
      }
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
    deps.resolveConfiguration.mockResolvedValue({
      codexPath,
      networkProxy: { mode: 'manual', server: 'http://proxy.example.test:3128' }
    })

    await codexLoginCommand({ force: false }, deps)

    expect(runCodex).toHaveBeenNthCalledWith(
      2,
      codexPath,
      ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      expect.objectContaining({
        inherit: true,
        env: expect.objectContaining({
          CODEX_HOME: resolve(configRoot, 'codex-subscription'),
          HOME: resolve(configRoot, 'codex-subscription'),
          HTTPS_PROXY: 'http://proxy.example.test:3128'
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
