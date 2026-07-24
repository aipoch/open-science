import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Injectable fault flags for the fs/promises mock — each targets one specific rename call:
//   onStagedMove: throw EPERM when src is the .codex-install- scratch dir (staged→destination)
//   onStagedMoveEio: throw EIO on the same call (non-EPERM staged-failure path)
//   onDestBackup: throw EPERM when dest contains .backup- (destination→backup, upgrade path)
//   onRestore: throw EPERM when src contains .backup- (backup→destination restore)
//   cp: throw EPERM from cp() to exercise the copy-failure→backup-restore branch
const fsFaults = vi.hoisted(() => ({
  renameOnStagedMove: false,
  renameOnStagedMoveEio: false,
  renameOnDestBackup: false,
  renameOnRestore: false,
  cpFailure: false,
  pauseNextWrite: false,
  partialWritePublished: undefined as (() => void) | undefined,
  resumeWrite: undefined as Promise<void> | undefined
}))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (src: string, dest: string) => {
      if (fsFaults.renameOnStagedMove && src.includes('.codex-install-')) {
        fsFaults.renameOnStagedMove = false
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      if (fsFaults.renameOnStagedMoveEio && src.includes('.codex-install-')) {
        fsFaults.renameOnStagedMoveEio = false
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
      }
      if (fsFaults.renameOnDestBackup && dest.includes('.backup-')) {
        fsFaults.renameOnDestBackup = false
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      if (fsFaults.renameOnRestore && src.includes('.backup-')) {
        fsFaults.renameOnRestore = false
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      return actual.rename(src, dest)
    }),
    cp: vi.fn(async (src: string, dest: string, opts?: object) => {
      if (fsFaults.cpFailure) {
        fsFaults.cpFailure = false
        throw Object.assign(new Error('EPERM: operation not permitted, copyfile'), {
          code: 'EPERM'
        })
      }
      return actual.cp(src, dest, opts as Parameters<typeof actual.cp>[2])
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const [file, data] = args
      if (fsFaults.pauseNextWrite && typeof data === 'string') {
        fsFaults.pauseNextWrite = false
        const patchTarget = '    const lastTokenUsage = this.sessionState.lastTokenUsage;'
        const targetOffset = data.indexOf(patchTarget)
        if (targetOffset !== -1) {
          await actual.writeFile(file, data.slice(0, targetOffset))
          fsFaults.partialWritePublished?.()
          await fsFaults.resumeWrite
        }
      }
      return actual.writeFile(...args)
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
  ensureManagedCodexContextUsage,
  managedCodexAdapterEntry,
  managedCodexBinary,
  managedCodexRoot,
  installManagedCodex,
  patchCodexAcpContextUsageSource,
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

  it('falls back to copy+delete when staged→destination rename throws EPERM (first install)', async () => {
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

    fsFaults.renameOnStagedMove = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-eperm-staged',
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
      fsFaults.renameOnStagedMove = false
    }
  })

  it('falls back to copy+delete when destination→backup rename throws EPERM (upgrade path)', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-upgrade'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-upgrade'),
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

    // Pre-seed an existing codex-managed dir (simulates an upgrade/reinstall scenario).
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'old-runtime'), 'old')

    fsFaults.renameOnDestBackup = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-eperm-backup',
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
      expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toBe('adapter-upgrade')
      expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe('codex-upgrade')
      // Old runtime must be gone from the final destination.
      await expect(readFile(join(managedCodexRoot(root), 'old-runtime'))).rejects.toThrow()
    } finally {
      fsFaults.renameOnDestBackup = false
    }
  })

  it('restores backup and surfaces error with backup path when cp fails during EPERM fallback', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-cp-fail'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-cp-fail'),
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

    // Pre-seed an existing install so hasBackup=true when the copy fallback runs.
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    // rename(staged→destination) throws EPERM, then cp also throws EPERM, then restore rename throws EPERM.
    fsFaults.renameOnStagedMove = true
    fsFaults.cpFailure = true
    fsFaults.renameOnRestore = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-cp-fail',
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

      // Install must fail.
      expect(outcome.result.ok).toBe(false)
      // Error must mention the backup path so the user can recover manually.
      expect(outcome.result.error).toMatch(/backup retained at/)
      // errorLog must have been called with the backup path.
      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore backup'),
        expect.anything()
      )
    } finally {
      fsFaults.renameOnStagedMove = false
      fsFaults.cpFailure = false
      fsFaults.renameOnRestore = false
    }
  })

  it('restores the previous install when cp fails during EPERM fallback and restore succeeds', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-restore'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-restore'),
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

    // Pre-seed an existing install so hasBackup=true when the copy fallback runs.
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    // rename(staged→destination) throws EPERM, cp throws EPERM, the restore rename succeeds.
    fsFaults.renameOnStagedMove = true
    fsFaults.cpFailure = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-restore-ok',
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

      // Install must fail with the raw copy error — no "backup retained" annotation needed,
      // because the backup was successfully moved back into place.
      expect(outcome.result.ok).toBe(false)
      expect(outcome.result.error).toContain('copyfile')
      expect(outcome.result.error).not.toMatch(/backup retained at/)
      // The previous install must be back at the destination, intact.
      expect(await readFile(join(managedCodexRoot(root), 'previous-runtime'), 'utf8')).toBe(
        'keep-me'
      )
      expect(errorLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore backup'),
        expect.anything()
      )
    } finally {
      fsFaults.renameOnStagedMove = false
      fsFaults.cpFailure = false
    }
  })

  it('logs the backup path when the destination→backup cp fallback also fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-backup-fail'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-backup-fail'),
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

    // Pre-seed an existing install so step 1 tries to back it up.
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    // rename(destination→backup) throws EPERM, then the cp fallback also throws EPERM.
    fsFaults.renameOnDestBackup = true
    fsFaults.cpFailure = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-backup-fail',
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

      expect(outcome.result.ok).toBe(false)
      // The surfaced error must carry the real cause (the cp failure), not the original EPERM.
      expect(outcome.result.error).toContain('copyfile')
      expect(outcome.result.error).toMatch(/backup may be incomplete at/)
      // The failure must be logged with the backup path so the user can recover manually.
      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to back up existing install'),
        expect.anything()
      )
    } finally {
      fsFaults.renameOnDestBackup = false
      fsFaults.cpFailure = false
    }
  })

  it('surfaces the backup path when a non-EPERM staged rename fails and restore also fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-eio'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-eio'),
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

    // Pre-seed an existing install so hasBackup=true when the staged rename fails.
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    // rename(staged→destination) throws EIO (not EPERM — no cp fallback), then the restore
    // rename also throws EPERM: the previous install survives only at the backup path.
    fsFaults.renameOnStagedMoveEio = true
    fsFaults.renameOnRestore = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-eio-restore-fail',
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

      expect(outcome.result.ok).toBe(false)
      // The real cause (EIO) must surface, annotated with the backup path for manual recovery.
      expect(outcome.result.error).toContain('EIO')
      expect(outcome.result.error).toMatch(/backup retained at/)
      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore backup'),
        expect.anything()
      )
    } finally {
      fsFaults.renameOnStagedMoveEio = false
      fsFaults.renameOnRestore = false
    }
  })

  it('does not retry the next registry when the local replace step fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-local-fail'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-local-fail'),
        mode: 0o755
      }
    ])
    const fetchJson = async (url: string): Promise<unknown> =>
      url.includes('agentclientprotocol%2fcodex-acp')
        ? { dist: { tarball: 'https://reg-a/adapter.tgz', integrity: sha512(adapterTgz) } }
        : { dist: { tarball: 'https://reg-a/codex.tgz', integrity: sha512(nativeTgz) } }
    const fetchJsonSpy = vi.fn(fetchJson)
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => ({
      stream: Readable.from(url.includes('adapter') ? adapterTgz : nativeTgz)
    })

    // rename(staged→destination) throws EPERM, then the cp fallback also throws EPERM — a
    // deterministic local filesystem failure, identical for every registry.
    fsFaults.renameOnStagedMove = true
    fsFaults.cpFailure = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-local-fail',
        onEvent: () => undefined,
        dataRoot: root,
        registries: ['https://reg-a', 'https://reg-b'],
        platform,
        fetchJson: fetchJsonSpy,
        fetchTarball,
        verifyAdapter: () => Promise.resolve('1.1.4'),
        verifyCodex: () => Promise.resolve('0.144.6'),
        verifyPair: vi.fn().mockResolvedValue(undefined),
        integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
      })

      expect(outcome.result.ok).toBe(false)
      expect(outcome.result.error).toContain('copyfile')
      // The second registry must never be contacted for a local filesystem failure
      // (2 fetchJson calls = a single resolve round, all against reg-a).
      expect(fetchJsonSpy).toHaveBeenCalledTimes(2)
      expect(
        fetchJsonSpy.mock.calls.every(([url]) => String(url).startsWith('https://reg-a/'))
      ).toBe(true)
    } finally {
      fsFaults.renameOnStagedMove = false
      fsFaults.cpFailure = false
    }
  })

  it('keeps the backup-path error and the orphaned backup when restore fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: Buffer.from('adapter-orphan'), mode: 0o755 }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('codex-orphan'),
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

    // Pre-seed an existing install so the failed replace leaves an orphaned backup behind.
    await mkdir(managedCodexRoot(root), { recursive: true })
    await writeFile(join(managedCodexRoot(root), 'previous-runtime'), 'keep-me')

    // rename(staged→destination) throws EPERM, cp throws EPERM, restore rename throws EPERM.
    fsFaults.renameOnStagedMove = true
    fsFaults.cpFailure = true
    fsFaults.renameOnRestore = true
    try {
      const outcome = await installManagedCodex({
        installId: 'codex-restore-orphan',
        onEvent: () => undefined,
        dataRoot: root,
        registries: ['https://reg-a', 'https://reg-b'],
        platform,
        fetchJson,
        fetchTarball,
        verifyAdapter: () => Promise.resolve('1.1.4'),
        verifyCodex: () => Promise.resolve('0.144.6'),
        verifyPair: vi.fn().mockResolvedValue(undefined),
        integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
      })

      expect(outcome.result.ok).toBe(false)
      // The backup-path error must survive — not overwritten by a second registry round.
      expect(outcome.result.error).toMatch(/backup retained at/)
      // The orphaned backup dir is deliberately retained for manual recovery.
      const entries = await readdir(root)
      expect(entries.some((entry) => entry.startsWith('codex-managed.backup-'))).toBe(true)
    } finally {
      fsFaults.renameOnStagedMove = false
      fsFaults.cpFailure = false
      fsFaults.renameOnRestore = false
    }
  })

  it('uninstall removes only UUID-shaped backup dirs left behind by failed installs', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    await mkdir(join(managedCodexRoot(root), 'adapter', 'dist'), { recursive: true })
    await writeFile(managedCodexAdapterEntry(root), 'adapter')
    // Production backups are always directories named `<root>.backup-<uuid>`.
    const orphanBackup = `${managedCodexRoot(root)}.backup-123e4567-e89b-42d3-a456-426614174000`
    await mkdir(orphanBackup, { recursive: true })
    await writeFile(join(orphanBackup, 'stranded-runtime'), 'stuck')
    // Look-alikes sharing the prefix must survive: a non-UUID dir and a UUID-named plain file.
    const notOurs = `${managedCodexRoot(root)}.backup-not-ours`
    await mkdir(notOurs, { recursive: true })
    await writeFile(join(notOurs, 'keep-me'), 'not-ours')
    const uuidFile = `${managedCodexRoot(root)}.backup-223e4567-e89b-42d3-a456-426614174000`
    await writeFile(uuidFile, 'not-a-dir')
    await writeFile(join(root, 'unrelated-runtime'), 'keep-me')

    await uninstallManagedCodex(root)

    await expect(readFile(managedCodexAdapterEntry(root))).rejects.toThrow()
    await expect(readFile(join(orphanBackup, 'stranded-runtime'))).rejects.toThrow()
    expect(await readFile(join(notOurs, 'keep-me'), 'utf8')).toBe('not-ours')
    expect(await readFile(uuidFile, 'utf8')).toBe('not-a-dir')
    expect(await readFile(join(root, 'unrelated-runtime'), 'utf8')).toBe('keep-me')
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

describe('patchCodexAcpContextUsageSource', () => {
  it('treats omitted cached input tokens as zero', () => {
    const source = [
      '  const adapter = {',
      '    sessionState: { lastTokenUsage: { inputTokens: 42 } },',
      '    createUsageUpdate(params) {',
      '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
      '    return used;',
      '    }',
      '  };',
      '  return adapter.createUsageUpdate({});'
    ].join('\n')

    const patched = patchCodexAcpContextUsageSource(source)
    const used = Function(patched)() as number

    expect(used).toBe(42)
  })

  it('reports the latest request input and cached input instead of total tokens', () => {
    const source = [
      '  createUsageUpdate(params) {',
      '    this.handleTokenUsageUpdated(params);',
      '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
      '    return { used };',
      '  }'
    ].join('\n')

    const patched = patchCodexAcpContextUsageSource(source)

    expect(patched).toContain(
      'lastTokenUsage.inputTokens + (lastTokenUsage.cachedInputTokens ?? 0)'
    )
    expect(patched).not.toContain('lastTokenUsage?.totalTokens')
    expect(patchCodexAcpContextUsageSource(patched)).toBe(patched)
  })

  it('updates an already-installed managed adapter in place', async () => {
    const patchRoot = await mkdtemp(join(tmpdir(), 'managed-codex-patch-'))
    try {
      const adapterPath = join(patchRoot, 'index.js')
      await writeFile(
        adapterPath,
        [
          '  createUsageUpdate(params) {',
          '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
          '  }'
        ].join('\n')
      )

      await ensureManagedCodexContextUsage(adapterPath)
      await ensureManagedCodexContextUsage(adapterPath)

      expect(await readFile(adapterPath, 'utf8')).toContain(
        'lastTokenUsage.inputTokens + (lastTokenUsage.cachedInputTokens ?? 0)'
      )
    } finally {
      await rm(patchRoot, { recursive: true, force: true })
    }
  })

  it('keeps concurrent context-usage checks from observing a partially patched adapter', async () => {
    const patchRoot = await mkdtemp(join(tmpdir(), 'managed-codex-patch-race-'))
    let releaseWrite: (() => void) | undefined
    try {
      const adapterPath = join(patchRoot, 'index.js')
      await writeFile(
        adapterPath,
        [
          '  const usageSchema = { totalTokens: true };',
          '  createUsageUpdate(params) {',
          '    this.handleTokenUsageUpdated(params);',
          '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
          '    return { used };',
          '  }'
        ].join('\n')
      )

      const partialWritePublished = new Promise<void>((resolve) => {
        fsFaults.partialWritePublished = resolve
      })
      fsFaults.resumeWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      fsFaults.pauseNextWrite = true

      const firstCheck = ensureManagedCodexContextUsage(adapterPath)
      await partialWritePublished
      const secondCheck = ensureManagedCodexContextUsage(adapterPath)

      await expect(secondCheck).resolves.toBeUndefined()
      releaseWrite?.()

      await expect(firstCheck).resolves.toBeUndefined()
      expect(await readFile(adapterPath, 'utf8')).toContain(
        'lastTokenUsage.inputTokens + (lastTokenUsage.cachedInputTokens ?? 0)'
      )
    } finally {
      releaseWrite?.()
      fsFaults.pauseNextWrite = false
      fsFaults.partialWritePublished = undefined
      fsFaults.resumeWrite = undefined
      await rm(patchRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a Codex ACP bundle no longer matches the pinned patch target', () => {
    const drifted = [
      '  createUsageUpdate(params) {',
      '    const used = this.sessionState.lastTokenUsage.totalTokens;',
      '  }'
    ].join('\n')

    expect(() => patchCodexAcpContextUsageSource(drifted)).toThrow(
      /context-usage patch no longer matches/
    )
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
