import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { warnLogSpy } = vi.hoisted(() => ({
  warnLogSpy: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnLogSpy,
    error: vi.fn()
  })
}))

// The real smoke reaps the adapter + its Codex grandchild via terminateProcessTree. Stub it with a spy
// that reports a clean reap by default but does NOT kill the child, so the degraded-reap path can be
// forced per test. Because it no longer kills, each fake adapter must exit on its own for the handshake
// promise to settle without hitting the 15s timeout.
const { terminateProcessTreeSpy } = vi.hoisted(() => ({
  terminateProcessTreeSpy: vi.fn<(...args: unknown[]) => Promise<{ reaped: boolean }>>(() =>
    Promise.resolve({ reaped: true })
  )
}))

vi.mock('../process-tree', async (importActual) => ({
  ...(await importActual<typeof import('../process-tree')>()),
  terminateProcessTree: terminateProcessTreeSpy
}))

import {
  collectCandidateDirs,
  detectCodex,
  runAcpInitializeSmoke,
  type CodexDetectDeps
} from './codex-detect'

const createDeps = (
  installed: Record<string, string>,
  overrides: Partial<CodexDetectDeps> = {}
): CodexDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  platform: 'linux',
  isRunnable: (candidate) => Promise.resolve(candidate in installed),
  getAdapterVersion: (candidate) => Promise.resolve(installed[candidate]),
  getCodexVersion: () => Promise.resolve(undefined),
  smokeInitialize: () => Promise.resolve(true),
  resolveNpmBinDirs: () => Promise.resolve([]),
  ...overrides
})

describe('codex-detect', () => {
  it('finds a runnable codex-acp on PATH and reports its adapter version', async () => {
    const result = await detectCodex(
      createDeps({ '/usr/local/bin/codex-acp': '@agentclientprotocol/codex-acp 1.1.4' })
    )

    expect(result).toEqual({
      adapterPath: '/usr/local/bin/codex-acp',
      adapterVersion: '1.1.4'
    })
  })

  it('reports the managed Codex binary when the managed adapter is selected', async () => {
    const adapterPath = '/data/codex-managed/adapter/dist/index.js'
    const codexPath = '/data/codex-managed/codex/vendor/aarch64-unknown-linux-musl/bin/codex'
    const result = await detectCodex(
      createDeps(
        { [adapterPath]: '@agentclientprotocol/codex-acp 1.1.4' },
        {
          extraDirs: ['/data/codex-managed/adapter/dist'],
          managedAdapterPath: adapterPath,
          managedCodexPath: codexPath,
          getCodexVersion: (candidate) =>
            Promise.resolve(candidate === codexPath ? 'codex-cli 0.144.6' : undefined)
        }
      )
    )

    expect(result).toEqual({
      adapterPath,
      adapterVersion: '1.1.4',
      managedCodexPath: codexPath,
      managedCodexVersion: '0.144.6'
    })
  })

  it('rejects an app-managed adapter whose paired native Codex cannot run', async () => {
    const adapterPath = '/data/codex-managed/adapter/dist/index.js'
    const codexPath = '/data/codex-managed/codex/vendor/aarch64-unknown-linux-musl/bin/codex'

    const result = await detectCodex(
      createDeps(
        { [adapterPath]: '@agentclientprotocol/codex-acp 1.1.4' },
        {
          managedAdapterPath: adapterPath,
          managedCodexPath: codexPath,
          getCodexVersion: () => Promise.resolve(undefined)
        }
      )
    )

    expect(result).toBeUndefined()
  })

  it('searches home, extra, well-known, and npm locations without duplicates', async () => {
    const dirs = await collectCandidateDirs(
      createDeps(
        {},
        {
          extraDirs: ['/data/codex-managed/adapter/dist'],
          resolveNpmBinDirs: () => Promise.resolve(['/usr/local/bin', '/home/user/.npm/bin'])
        }
      )
    )

    expect(dirs).toEqual([
      '/usr/bin',
      '/usr/local/bin',
      '/home/user/.local/bin',
      '/data/codex-managed/adapter/dist',
      '/opt/homebrew/bin',
      '/home/user/.npm/bin'
    ])
  })

  it('finds codex-acp in an npm global bin directory when PATH misses', async () => {
    const adapterPath = '/home/user/.npm/bin/codex-acp'
    const result = await detectCodex(
      createDeps(
        { [adapterPath]: '@agentclientprotocol/codex-acp 1.1.4' },
        { resolveNpmBinDirs: () => Promise.resolve(['/home/user/.npm/bin']) }
      )
    )

    expect(result).toEqual({ adapterPath, adapterVersion: '1.1.4' })
  })

  it('finds a Windows npm codex-acp.cmd using win32 path semantics', async () => {
    const npmDir = win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm')
    const adapterPath = win32.join(npmDir, 'codex-acp.cmd')
    const result = await detectCodex(
      createDeps(
        { [adapterPath]: '@agentclientprotocol/codex-acp 1.1.4' },
        {
          platform: 'win32',
          env: {
            PATH: 'C:\\Windows',
            APPDATA: 'C:\\Users\\me\\AppData\\Roaming'
          },
          homePath: 'C:\\Users\\me'
        }
      )
    )

    expect(result).toEqual({ adapterPath, adapterVersion: '1.1.4' })
  })

  it('does not report an adapter that cannot complete its version probe', async () => {
    const result = await detectCodex(
      createDeps(
        {},
        {
          isRunnable: () => Promise.resolve(true),
          getAdapterVersion: () => Promise.resolve(undefined)
        }
      )
    )

    expect(result).toBeUndefined()
  })

  it('rejects a versioned adapter that fails the live ACP initialize smoke check', async () => {
    const result = await detectCodex(
      createDeps(
        { '/usr/local/bin/codex-acp': '@agentclientprotocol/codex-acp 1.1.4' },
        { smokeInitialize: () => Promise.resolve(false) }
      )
    )

    expect(result).toBeUndefined()
  })

  it('smoke-checks each candidate and returns the first that initializes', async () => {
    const first = '/usr/bin/codex-acp'
    const second = '/usr/local/bin/codex-acp'
    const smoked: string[] = []
    const result = await detectCodex(
      createDeps(
        {
          [first]: '@agentclientprotocol/codex-acp 1.1.4',
          [second]: '@agentclientprotocol/codex-acp 1.1.4'
        },
        {
          smokeInitialize: (candidate) => {
            smoked.push(candidate)
            return Promise.resolve(candidate === second)
          }
        }
      )
    )

    expect(result).toEqual({ adapterPath: second, adapterVersion: '1.1.4' })
    expect(smoked).toEqual([first, second])
  })

  it('passes the managed native Codex path into the smoke check for the managed adapter', async () => {
    const adapterPath = '/data/codex-managed/adapter/dist/index.js'
    const codexPath = '/data/codex-managed/codex/vendor/aarch64-unknown-linux-musl/bin/codex'
    let smokeOpts: { codexPath?: string } | undefined
    await detectCodex(
      createDeps(
        { [adapterPath]: '@agentclientprotocol/codex-acp 1.1.4' },
        {
          extraDirs: ['/data/codex-managed/adapter/dist'],
          managedAdapterPath: adapterPath,
          managedCodexPath: codexPath,
          getCodexVersion: (candidate) =>
            Promise.resolve(candidate === codexPath ? 'codex-cli 0.144.6' : undefined),
          smokeInitialize: (_candidate, opts) => {
            smokeOpts = opts
            return Promise.resolve(true)
          }
        }
      )
    )

    expect(smokeOpts).toEqual({ codexPath })
  })
})

// Exercises the REAL runAcpInitializeSmoke (the default dep the other suite stubs out) end-to-end
// against a tiny fake adapter, so a regression in the actual spawn/handshake plumbing is caught. The
// adapter is a `.js` script run under process.execPath via ELECTRON_RUN_AS_NODE, matching the managed
// adapter's launch shape. Only isRunnable/getAdapterVersion are stubbed to point detection at it.
describe('codex-detect: real ACP initialize smoke', () => {
  let tempRoot: string

  // Reads one JSON-RPC line from stdin and, on initialize (id 1), replies with the given
  // protocolVersion — or exits without answering. Written as CommonJS so a bare `.js` in tmp runs
  // without a package.json type declaration.
  const writeFakeAdapter = async (
    name: string,
    behavior: { protocolVersion?: number; exitWithoutReply?: boolean }
  ): Promise<string> => {
    const scriptPath = join(tempRoot, name)
    const reply = behavior.exitWithoutReply
      ? 'process.exit(0)'
      : [
          "const readline = require('node:readline')",
          'const rl = readline.createInterface({ input: process.stdin })',
          "rl.on('line', (line) => {",
          '  try {',
          '    const message = JSON.parse(line)',
          "    if (message.method === 'initialize' && message.id === 1) {",
          `      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: ${behavior.protocolVersion} } }) + '\\n')`,
          // Self-exit so the smoke settles on the child's own exit: the mocked terminateProcessTree no
          // longer kills us, so without this the handshake would hang until the 15s timeout.
          '      process.exit(0)',
          '    }',
          '  } catch {}',
          '})'
        ].join('\n')
    await writeFile(scriptPath, reply, 'utf8')
    return scriptPath
  }

  const detectWithRealSmoke = (
    adapterPath: string
  ): Promise<Awaited<ReturnType<typeof detectCodex>>> =>
    detectCodex({
      env: { PATH: '' },
      homePath: tempRoot,
      platform: process.platform,
      isRunnable: (candidate) => Promise.resolve(candidate === adapterPath),
      getAdapterVersion: (candidate) =>
        Promise.resolve(candidate === adapterPath ? 'codex-acp 1.1.4' : undefined),
      getCodexVersion: () => Promise.resolve(undefined),
      // The production default dep — not a stub.
      smokeInitialize: runAcpInitializeSmoke(process.platform),
      resolveNpmBinDirs: () => Promise.resolve([]),
      managedAdapterPath: adapterPath
    })

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'os-codex-smoke-test-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    warnLogSpy.mockClear()
    terminateProcessTreeSpy.mockClear()
    terminateProcessTreeSpy.mockImplementation(() => Promise.resolve({ reaped: true }))
  })

  it('reports an adapter whose real initialize handshake returns protocolVersion 1 as ready', async () => {
    const adapterPath = await writeFakeAdapter('ready-adapter.js', { protocolVersion: 1 })

    const result = await detectWithRealSmoke(adapterPath)

    expect(result).toEqual({ adapterPath, adapterVersion: '1.1.4' })
    // The smoke reaped the tree cleanly, so it must not emit the degraded-reap warning.
    expect(warnLogSpy).not.toHaveBeenCalled()
  })

  it('still reports the adapter as ready but warns when the process tree is only partially reaped', async () => {
    // A taskkill fallback / surviving descendant leaves the tree only partially reaped. The pairing is
    // still valid (initialize answered protocolVersion 1), so the adapter must be reported ready — but the
    // degraded cleanup must surface as a warning rather than a hard failure.
    terminateProcessTreeSpy.mockImplementation(() => Promise.resolve({ reaped: false }))
    const adapterPath = await writeFakeAdapter('degraded-reap-adapter.js', { protocolVersion: 1 })

    const result = await detectWithRealSmoke(adapterPath)

    // (a) Warn-and-succeed: the adapter is still ready despite the degraded reap.
    expect(result).toEqual({ adapterPath, adapterVersion: '1.1.4' })
    // (b) The degraded teardown is reported exactly once with the fully-reaped warning.
    expect(warnLogSpy).toHaveBeenCalledTimes(1)
    expect(warnLogSpy).toHaveBeenCalledWith(
      'ACP initialize check could not confirm the Codex process tree was fully reaped'
    )
  })

  it('does not report an adapter whose real initialize returns a non-1 protocolVersion', async () => {
    const adapterPath = await writeFakeAdapter('wrong-version-adapter.js', { protocolVersion: 2 })

    const result = await detectWithRealSmoke(adapterPath)

    expect(result).toBeUndefined()
  })

  it('does not report an adapter that exits without answering initialize', async () => {
    // Exits immediately so the smoke settles on the child `exit` event — never the 15s timeout.
    const adapterPath = await writeFakeAdapter('silent-adapter.js', { exitWithoutReply: true })

    const result = await detectWithRealSmoke(adapterPath)

    expect(result).toBeUndefined()
  })
})

describe('detectNativeCodex', () => {
  it('detects native Codex on macOS in the ChatGPT.app bundle', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      getCodexVersion: (path) =>
        path === '/Applications/ChatGPT.app/Contents/Resources/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined)
    })

    expect(result).toEqual({
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      version: '0.144.2'
    })
  })

  it('detects native Codex on Windows in LocalAppData', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows\\System32',
        LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local'
      },
      getCodexVersion: (path) =>
        path === win32.join('C:\\Users\\User\\AppData\\Local', 'Programs', 'ChatGPT', 'codex.exe')
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined)
    })

    expect(result).toEqual({
      path: 'C:\\Users\\User\\AppData\\Local\\Programs\\ChatGPT\\codex.exe',
      version: '0.144.2'
    })
  })

  it('detects native Codex on PATH', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'linux',
      env: { PATH: '/usr/bin:/usr/local/bin' },
      getCodexVersion: (path) =>
        path === '/usr/local/bin/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined)
    })

    expect(result).toEqual({
      path: '/usr/local/bin/codex',
      version: '0.144.2'
    })
  })

  it('returns undefined when no native Codex is found', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      getCodexVersion: () => Promise.resolve(undefined)
    })

    expect(result).toBeUndefined()
  })

  it('finds native Codex in augmented Homebrew dir even when absent from raw PATH', async () => {
    // Regression: the ACP smoke test resolves codex through an augmented PATH that includes
    // /opt/homebrew/bin. detectNativeCodex must search the same dirs so a successful adapter
    // handshake never disagrees with the independent native-CLI probe (which would block Continue).
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'darwin',
      env: { PATH: '/usr/bin' }, // raw PATH does NOT include /opt/homebrew/bin
      homePath: '/Users/test',
      getCodexVersion: (path) =>
        path === '/opt/homebrew/bin/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toEqual({ path: '/opt/homebrew/bin/codex', version: '0.144.2' })
  })

  it('finds native Codex in an npm global bin dir', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      homePath: '/home/user',
      getCodexVersion: (path) =>
        path === '/home/user/.npm-global/bin/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined),
      resolveNpmBinDirs: () => Promise.resolve(['/home/user/.npm-global/bin'])
    })

    expect(result).toEqual({ path: '/home/user/.npm-global/bin/codex', version: '0.144.2' })
  })

  it('finds native Codex in ~/.local/bin via homePath', async () => {
    const { detectNativeCodex } = await import('./codex-detect')
    const result = await detectNativeCodex({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      homePath: '/home/user',
      getCodexVersion: (path) =>
        path === '/home/user/.local/bin/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toEqual({ path: '/home/user/.local/bin/codex', version: '0.144.2' })
  })
})

describe('detectCodexComponents', () => {
  it('reports both components found when adapter passes smoke test', async () => {
    const { detectCodexComponents } = await import('./codex-detect')
    const result = await detectCodexComponents({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homePath: '/Users/test',
      isRunnable: (path) =>
        Promise.resolve(
          path === '/usr/local/bin/codex-acp' ||
            path === '/Applications/ChatGPT.app/Contents/Resources/codex'
        ),
      getAdapterVersion: (path) =>
        path === '/usr/local/bin/codex-acp'
          ? Promise.resolve('codex-acp 1.0.0')
          : Promise.resolve(undefined),
      getCodexVersion: (path) =>
        path === '/Applications/ChatGPT.app/Contents/Resources/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined),
      smokeInitialize: () => Promise.resolve(true),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toMatchObject({
      nativeCliFound: true,
      nativeCliPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      nativeCliVersion: '0.144.2',
      adapterFound: true,
      adapterPath: '/usr/local/bin/codex-acp',
      adapterVersion: '1.0.0',
      adapterFailureReason: undefined
    })
  })

  it('reports native found but adapter missing when no adapter exists', async () => {
    const { detectCodexComponents } = await import('./codex-detect')
    const result = await detectCodexComponents({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homePath: '/Users/test',
      isRunnable: (path) =>
        Promise.resolve(path === '/Applications/ChatGPT.app/Contents/Resources/codex'),
      getAdapterVersion: () => Promise.resolve(undefined),
      getCodexVersion: (path) =>
        path === '/Applications/ChatGPT.app/Contents/Resources/codex'
          ? Promise.resolve('codex-cli 0.144.2')
          : Promise.resolve(undefined),
      smokeInitialize: () => Promise.resolve(false),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toMatchObject({
      nativeCliFound: true,
      nativeCliPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      nativeCliVersion: '0.144.2',
      adapterFound: false,
      adapterPath: undefined,
      adapterVersion: undefined
    })
  })

  it('reports adapter smoke-test failure when version succeeds but initialization fails', async () => {
    const { detectCodexComponents } = await import('./codex-detect')
    const result = await detectCodexComponents({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homePath: '/Users/test',
      isRunnable: (path) => Promise.resolve(path === '/usr/local/bin/codex-acp'),
      getAdapterVersion: (path) =>
        path === '/usr/local/bin/codex-acp'
          ? Promise.resolve('codex-acp 1.0.0')
          : Promise.resolve(undefined),
      getCodexVersion: () => Promise.resolve(undefined),
      smokeInitialize: () => Promise.resolve(false),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toMatchObject({
      nativeCliFound: false,
      adapterFound: true,
      adapterPath: '/usr/local/bin/codex-acp',
      adapterVersion: '1.0.0',
      adapterFailureReason: 'smoke-test-failed'
    })
  })

  it('reports version-probe failure when adapter exists but version check fails', async () => {
    const { detectCodexComponents } = await import('./codex-detect')
    const result = await detectCodexComponents({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homePath: '/Users/test',
      isRunnable: (path) => Promise.resolve(path === '/usr/local/bin/codex-acp'),
      getAdapterVersion: () => Promise.resolve(undefined), // Version probe fails
      getCodexVersion: () => Promise.resolve(undefined),
      smokeInitialize: () => Promise.resolve(false),
      resolveNpmBinDirs: () => Promise.resolve([])
    })

    expect(result).toMatchObject({
      nativeCliFound: false,
      adapterFound: true,
      adapterPath: '/usr/local/bin/codex-acp',
      adapterVersion: undefined,
      adapterFailureReason: 'version-probe-failed'
    })
  })
})
