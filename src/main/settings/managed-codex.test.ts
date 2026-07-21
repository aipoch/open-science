import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

// When armed, the rename from the staged scratch dir to the final destination throws EPERM,
// simulating the Windows "operation not permitted" error that triggered the bug report.
const injectRenameEperm = vi.hoisted(() => ({ armed: false }))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (src: string, dest: string) => {
      if (injectRenameEperm.armed && src.includes('.codex-install-')) {
        injectRenameEperm.armed = false
        const err = Object.assign(new Error('EPERM: operation not permitted, rename'), {
          code: 'EPERM'
        })
        throw err
      }
      return actual.rename(src, dest)
    })
  }
})

const { errorLogSpy, warnLogSpy } = vi.hoisted(() => ({
  errorLogSpy: vi.fn(),
  warnLogSpy: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnLogSpy,
    error: errorLogSpy
  })
}))

// The smoke check reaps the adapter + its Codex grandchild via terminateProcessTree. Stub it with a
// spy that reports a clean reap but does NOT kill the child, so the tests can assert it is invoked on
// both the success and error paths. Because it no longer kills, each fake adapter must exit on its own
// for the handshake promise to settle without hitting the 15s timeout.
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
  CODEX_ACP_VERSION,
  CODEX_ACP_INTEGRITY,
  CODEX_INTEGRITIES,
  CODEX_VERSION,
  managedCodexAdapterEntry,
  managedCodexBinary,
  managedCodexRoot,
  installManagedCodex,
  resolveManagedCodexPlatform,
  sanitizeManagedCodexDiagnostic,
  verifyManagedCodexPair,
  uninstallManagedCodex
} from './managed-codex'

const tarEntry = (name: string, content: Buffer, mode = 0o644): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'ascii')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded])
}

const buildTgz = (entries: { name: string; content: Buffer; mode?: number }[]): Buffer =>
  gzipSync(
    Buffer.concat([
      ...entries.map((entry) => tarEntry(entry.name, entry.content, entry.mode)),
      Buffer.alloc(1024)
    ])
  )

const sha512 = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

describe('managed Codex paths and platform resolution', () => {
  it.each([
    ['darwin', 'x64', 'darwin-x64', 'x86_64-apple-darwin', 'codex'],
    ['darwin', 'arm64', 'darwin-arm64', 'aarch64-apple-darwin', 'codex'],
    ['linux', 'x64', 'linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
    ['linux', 'arm64', 'linux-arm64', 'aarch64-unknown-linux-musl', 'codex'],
    ['win32', 'x64', 'win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    ['win32', 'arm64', 'win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe']
  ] as const)(
    'maps %s %s to its published native package and target',
    (platform, arch, key, target, binName) => {
      expect(resolveManagedCodexPlatform({ platform, arch })).toEqual({ key, target, binName })
    }
  )

  it('exposes pinned versions and stable install paths', () => {
    const root = '/data/open-science'
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })

    expect(CODEX_ACP_VERSION).toBe('1.1.4')
    expect(CODEX_VERSION).toBe('0.144.6')
    expect(CODEX_ACP_INTEGRITY).toMatch(/^sha512-/)
    expect(Object.keys(CODEX_INTEGRITIES).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64'
    ])
    expect(managedCodexRoot(root)).toBe(join(root, 'codex-managed'))
    expect(managedCodexAdapterEntry(root)).toBe(
      join(root, 'codex-managed', 'adapter', 'dist', 'index.js')
    )
    expect(managedCodexBinary(root, platform)).toBe(
      join(root, 'codex-managed', 'codex', 'vendor', platform.target, 'bin', 'codex')
    )
  })
})

describe('installManagedCodex', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
    errorLogSpy.mockClear()
    warnLogSpy.mockClear()
    terminateProcessTreeSpy.mockClear()
    terminateProcessTreeSpy.mockImplementation(() => Promise.resolve({ reaped: true }))
  })

  it('verifies an installed adapter and Codex binary with a real ACP initialize exchange', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'adapter.js')
    const codexPath = join(root, 'codex')
    const codexHome = join(root, 'home')
    await writeFile(
      adapterPath,
      [
        'let stdinEnded = false',
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('end', () => { stdinEnded = true })",
        "process.stdin.on('data', (chunk) => {",
        '  const request = JSON.parse(chunk)',
        '  setTimeout(() => {',
        '    if (stdinEnded) process.exit(3)',
        `    if (request.method !== 'initialize' || process.env.CODEX_PATH !== ${JSON.stringify(codexPath)} || process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}) process.exit(2)`,
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n')",
        // Self-exit so the smoke check settles: the mocked terminateProcessTree no longer kills us.
        '    process.exit(0)',
        '  }, 25)',
        '})'
      ].join('\n')
    )

    await expect(verifyManagedCodexPair(adapterPath, codexPath, codexHome)).resolves.toBeUndefined()
    await expect(readFile(adapterPath, 'utf8')).resolves.toContain(
      "request.method !== 'initialize'"
    )
  })

  it('strips host Codex credentials from the smoke child and forces an ephemeral config.toml', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'reporting-adapter.js')
    const codexPath = join(root, 'codex')
    const codexHome = join(root, 'home')
    const reportPath = join(root, 'env-report.json')
    // On initialize the adapter records the credential env it actually received and the config.toml it
    // sees in CODEX_HOME, then completes the handshake so verifyManagedCodexPair resolves.
    await writeFile(
      adapterPath,
      [
        "const fs = require('fs')",
        "const path = require('path')",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        '  const request = JSON.parse(chunk)',
        '  const report = {',
        '    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,',
        '    CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,',
        '    CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,',
        '    CODEX_HOME: process.env.CODEX_HOME ?? null,',
        "    configToml: fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8')",
        '  }',
        `  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report))`,
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n')",
        // Self-exit so the smoke check settles: the mocked terminateProcessTree no longer kills us.
        '  process.exit(0)',
        '})'
      ].join('\n')
    )

    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      CODEX_CONFIG: process.env.CODEX_CONFIG
    }
    process.env.OPENAI_API_KEY = 'host-openai-key'
    process.env.CODEX_API_KEY = 'host-codex-key'
    process.env.CODEX_CONFIG = '/host/codex/config'

    try {
      await expect(
        verifyManagedCodexPair(adapterPath, codexPath, codexHome)
      ).resolves.toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, string | null>
    // (a) None of the host credential/config vars reach the smoke child.
    expect(report.OPENAI_API_KEY).toBeNull()
    expect(report.CODEX_API_KEY).toBeNull()
    expect(report.CODEX_CONFIG).toBeNull()
    // The smoke child is pointed at the ephemeral scratch home instead.
    expect(report.CODEX_HOME).toBe(codexHome)
    // (b) A config.toml forcing the in-memory credential store exists before the handshake.
    expect(report.configToml).toContain('cli_auth_credentials_store = "ephemeral"')
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.toBe(
      'cli_auth_credentials_store = "ephemeral"\n'
    )
  })

  it('rejects an adapter pair that does not complete ACP initialize', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'broken-adapter.js')
    await writeFile(adapterPath, "process.stdout.write('not-json\\n')\n")

    await expect(
      verifyManagedCodexPair(adapterPath, join(root, 'codex'), join(root, 'home'))
    ).rejects.toThrow(/ACP initialize check/)
    expect(errorLogSpy).toHaveBeenCalledWith(
      'ACP initialize check failed',
      expect.objectContaining({ status: 0, initialized: false, stdoutLineCount: 1 })
    )
  })

  it('treats a completed initialize as success regardless of the adapter exit code', async () => {
    // The check reaps the process tree the moment initialize answers (so a Codex grandchild can't be
    // orphaned), which makes the adapter's own exit code our forced-teardown signal rather than a
    // meaningful one. A valid protocolVersion-1 response is the pairing proof; a later non-zero exit is not.
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'initialized-then-exit.js')
    await writeFile(
      adapterPath,
      'process.stdout.write(\'{"id":1,"result":{"protocolVersion":1}}\\n\'); process.exit(1)\n'
    )

    await expect(
      verifyManagedCodexPair(adapterPath, join(root, 'codex'), join(root, 'home'))
    ).resolves.toBeUndefined()
  })

  it('reaps the whole process tree via terminateProcessTree on the successful handshake path', async () => {
    // A grandchild Codex app-server would be orphaned if the tree were not reaped when initialize
    // answers, so the smoke check must drive terminateProcessTree even on the happy path.
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'reaped-success.js')
    await writeFile(
      adapterPath,
      'process.stdout.write(\'{"id":1,"result":{"protocolVersion":1}}\\n\'); process.exit(0)\n'
    )

    await expect(
      verifyManagedCodexPair(adapterPath, join(root, 'codex'), join(root, 'home'))
    ).resolves.toBeUndefined()
    // The initialize handler and the terminal `finish` path both reap, but through one memoized promise:
    // exactly one teardown, driven with the adapter child handle. A second concurrent call is a defect.
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(1)
    expect(terminateProcessTreeSpy.mock.calls[0]?.[0]).toBeDefined()
    // A clean reap must not warn.
    expect(warnLogSpy).not.toHaveBeenCalled()
  })

  it('still reaps the process tree exactly once when the adapter exits without a valid ACP response', async () => {
    // On the error/non-initialized path the parent is torn down in `finish`, so the grandchild is not
    // leaked even when the handshake fails. The adapter self-exits with non-JSON output.
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'reaped-error.js')
    await writeFile(adapterPath, "process.stdout.write('boom\\n'); process.exit(1)\n")

    await expect(
      verifyManagedCodexPair(adapterPath, join(root, 'codex'), join(root, 'home'))
    ).rejects.toThrow(/ACP initialize check/)
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces a degraded reap (reaped:false) as a warning while the handshake still succeeds', async () => {
    // A taskkill fallback / surviving descendant leaves the tree only partially reaped. The pairing is
    // still valid (initialize answered), but the degraded cleanup must not be swallowed silently.
    terminateProcessTreeSpy.mockImplementation(() => Promise.resolve({ reaped: false }))
    root = await mkdtemp(join(tmpdir(), 'managed-codex-pair-'))
    const adapterPath = join(root, 'degraded-reap.js')
    await writeFile(
      adapterPath,
      'process.stdout.write(\'{"id":1,"result":{"protocolVersion":1}}\\n\'); process.exit(0)\n'
    )

    await expect(
      verifyManagedCodexPair(adapterPath, join(root, 'codex'), join(root, 'home'))
    ).resolves.toBeUndefined()
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(1)
    // The degraded teardown is reported once (memoized), not per call site.
    expect(warnLogSpy).toHaveBeenCalledTimes(1)
  })

  it('installs the pinned adapter and complete native vendor subtree after both smoke checks pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })
    const adapterTgz = buildTgz([
      {
        name: 'package/dist/index.js',
        content: Buffer.from('#!/usr/bin/env node\nconsole.log("codex-acp")\n'),
        mode: 0o755
      }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('native-codex'),
        mode: 0o755
      },
      {
        name: `package/vendor/${platform.target}/codex-path/rg`,
        content: Buffer.from('managed-rg'),
        mode: 0o755
      },
      {
        name: `package/vendor/${platform.target}/codex-resources/zsh/bin/zsh`,
        content: Buffer.from('managed-zsh'),
        mode: 0o755
      }
    ])
    const metadataUrls: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      metadataUrls.push(url)
      return url.includes('agentclientprotocol%2fcodex-acp')
        ? { dist: { tarball: 'https://reg/adapter.tgz', integrity: sha512(adapterTgz) } }
        : { dist: { tarball: 'https://reg/codex.tgz', integrity: sha512(nativeTgz) } }
    }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => {
      const body = url.includes('adapter') ? adapterTgz : nativeTgz
      return { stream: Readable.from(body), totalBytes: body.length }
    }

    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'old-install'), 'old')

    const verifyPair = vi.fn().mockResolvedValue(undefined)
    const outcome = await installManagedCodex({
      installId: 'codex-1',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: () => Promise.resolve('1.1.4'),
      verifyCodex: () => Promise.resolve('0.144.6'),
      verifyPair,
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
    })

    expect(outcome).toEqual({
      result: { installId: 'codex-1', ok: true },
      adapterPath: managedCodexAdapterEntry(root),
      adapterVersion: '1.1.4',
      codexPath: managedCodexBinary(root, platform),
      codexVersion: '0.144.6'
    })
    expect(metadataUrls).toEqual([
      'https://reg/@agentclientprotocol%2fcodex-acp/1.1.4',
      'https://reg/@openai%2fcodex/0.144.6-darwin-arm64'
    ])
    expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toContain('codex-acp')
    expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe('native-codex')
    expect(verifyPair).toHaveBeenCalledWith(
      expect.stringContaining(join('adapter', 'dist', 'index.js')),
      expect.stringContaining(join('codex', 'vendor', platform.target, 'bin', 'codex')),
      expect.stringContaining('smoke-home')
    )
    expect(
      await readFile(
        join(managedCodexRoot(root), 'codex', 'vendor', platform.target, 'codex-path', 'rg'),
        'utf8'
      )
    ).toBe('managed-rg')
    await expect(readFile(join(managedCodexRoot(root), 'old-install'))).rejects.toThrow()
  })

  it('runs the smoke handshake from a home outside the staged runtime tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('native-codex'),
        mode: 0o755
      }
    ])
    const fetchJson = async (url: string): Promise<unknown> =>
      url.includes('agentclientprotocol%2fcodex-acp')
        ? { dist: { tarball: 'https://reg/adapter.tgz', integrity: sha512(adapterTgz) } }
        : { dist: { tarball: 'https://reg/codex.tgz', integrity: sha512(nativeTgz) } }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => ({
      stream: Readable.from(url.includes('adapter') ? adapterTgz : nativeTgz)
    })

    let capturedAdapterPath = ''
    let capturedSmokeHome = ''
    const verifyPair = vi.fn(async (adapterPath: string, _codexPath: string, smokeHome: string) => {
      capturedAdapterPath = adapterPath
      capturedSmokeHome = smokeHome
    })

    const outcome = await installManagedCodex({
      installId: 'codex-smoke-home',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: () => Promise.resolve('1.1.4'),
      verifyCodex: () => Promise.resolve('0.144.6'),
      verifyPair,
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
    })

    expect(outcome.result.ok).toBe(true)
    // The staged runtime is adapter/dist/index.js three levels below the staged root that gets moved
    // into the final install; the smoke home must never live under it, or Codex writes would ride along.
    const stagedRoot = dirname(dirname(dirname(capturedAdapterPath)))
    expect(capturedSmokeHome).not.toBe(stagedRoot)
    expect(capturedSmokeHome.startsWith(`${stagedRoot}${sep}`)).toBe(false)
    // It is a sibling of the staged runtime inside the auto-removed scratch dir.
    expect(dirname(capturedSmokeHome)).toBe(dirname(stagedRoot))
    // The final installed runtime never contains the smoke home either.
    expect(capturedSmokeHome.startsWith(`${managedCodexRoot(root)}${sep}`)).toBe(false)
  })

  it('preserves the previous runtime when the native package fails SRI verification', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex'),
        mode: 0o755
      }
    ])
    const fetchJson = async (url: string): Promise<unknown> =>
      url.includes('agentclientprotocol%2fcodex-acp')
        ? { dist: { tarball: 'https://reg/adapter.tgz', integrity: sha512(adapterTgz) } }
        : { dist: { tarball: 'https://reg/codex.tgz', integrity: 'sha512-wrong' } }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => ({
      stream: Readable.from(url.includes('adapter') ? adapterTgz : nativeTgz)
    })

    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')
    let smokeChecks = 0

    const outcome = await installManagedCodex({
      installId: 'codex-sri-failure',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: async () => {
        smokeChecks += 1
        return '1.1.4'
      },
      verifyCodex: async () => {
        smokeChecks += 1
        return '0.144.6'
      },
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toMatch(/pinned manifest/)
    expect(smokeChecks).toBe(0)
    expect(await readFile(join(managedCodexRoot(root), 'previous-runtime'), 'utf8')).toBe('keep-me')
    await expect(readFile(managedCodexAdapterEntry(root))).rejects.toThrow()
  })

  it('preserves the previous runtime when the extracted Codex binary fails its smoke check', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'arm64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('broken-codex'),
        mode: 0o755
      }
    ])
    const fetchJson = async (url: string): Promise<unknown> => {
      const adapter = url.includes('agentclientprotocol%2fcodex-acp')
      const body = adapter ? adapterTgz : nativeTgz
      return {
        dist: {
          tarball: adapter ? 'https://reg/adapter.tgz' : 'https://reg/codex.tgz',
          integrity: sha512(body)
        }
      }
    }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => {
      const body = url.includes('adapter') ? adapterTgz : nativeTgz
      return { stream: Readable.from(body), totalBytes: body.length }
    }

    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    const outcome = await installManagedCodex({
      installId: 'codex-smoke-failure',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: () => Promise.resolve('1.1.4'),
      verifyCodex: () => Promise.resolve(undefined),
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toMatch(/Codex binary failed its --version check/)
    expect(await readFile(join(managedCodexRoot(root), 'previous-runtime'), 'utf8')).toBe('keep-me')
  })

  it('falls back to copy+delete when rename throws EPERM (Windows antivirus / locked files)', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-eperm'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-eperm'),
        mode: 0o755
      }
    ])
    const fetchJson = async (url: string): Promise<unknown> =>
      url.includes('agentclientprotocol%2fcodex-acp')
        ? { dist: { tarball: 'https://reg/adapter.tgz', integrity: sha512(adapterTgz) } }
        : { dist: { tarball: 'https://reg/codex.tgz', integrity: sha512(nativeTgz) } }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => ({
      stream: Readable.from(url.includes('adapter') ? adapterTgz : nativeTgz)
    })

    // Activate the EPERM rename injection (checked by the module-level mock below).
    injectRenameEperm.armed = true

    try {
      const outcome = await installManagedCodex({
        installId: 'codex-eperm',
        onEvent: () => undefined,
        dataRoot: root,
        registries: ['https://reg'],
        platform,
        fetchJson,
        fetchTarball,
        verifyAdapter: () => Promise.resolve('1.1.4'),
        verifyCodex: () => Promise.resolve('0.144.6'),
        verifyPair: vi.fn().mockResolvedValue(undefined),
        integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
      })

      expect(outcome.result.ok).toBe(true)
      expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toBe('adapter-eperm')
      expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe('codex-eperm')
    } finally {
      injectRenameEperm.armed = false
    }
  })

  it('uninstalls only the managed Codex tree and is idempotent', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    await mkdir(join(managedCodexRoot(root), 'adapter', 'dist'), { recursive: true })
    await writeFile(managedCodexAdapterEntry(root), 'adapter')
    await writeFile(join(root, 'unrelated-runtime'), 'keep-me')

    await uninstallManagedCodex(root)
    await uninstallManagedCodex(root)

    await expect(readFile(managedCodexAdapterEntry(root))).rejects.toThrow()
    expect(await readFile(join(root, 'unrelated-runtime'), 'utf8')).toBe('keep-me')
  })
})

describe('sanitizeManagedCodexDiagnostic', () => {
  it('redacts credential-like values and bounds child output', () => {
    const diagnostic = sanitizeManagedCodexDiagnostic(
      `Authorization: Bearer live-token\napi_key=secret-value\ntoken: another-secret\nsk-1234567890abcdef\n${'x'.repeat(5000)}`
    )

    expect(diagnostic.text).not.toContain('live-token')
    expect(diagnostic.text).not.toContain('secret-value')
    expect(diagnostic.text).not.toContain('another-secret')
    expect(diagnostic.text).not.toContain('sk-1234567890abcdef')
    expect(diagnostic.text).toContain('[redacted]')
    expect(diagnostic.text.length).toBeLessThanOrEqual(4 * 1024)
    expect(diagnostic.truncated).toBe(true)
  })
})
