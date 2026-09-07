import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ACP_MODEL_CALL_USAGE_META_KEY,
  ACP_MODEL_TURN_COUNT_META_KEY,
  ACP_TURN_TOKEN_USAGE_META_KEY,
  toAcpTurnTokenUsage
} from '../../shared/acp'

const PINNED_SKILL_MAPPER_FIXTURE = [
  'function buildPromptItems(prompt) {',
  '  return prompt.map((block) => {',
  '    switch (block.type) {',
  '      case "text":',
  '        return { type: "text", text: block.text, text_elements: [] };',
  '      default:',
  '        return null;',
  '    }',
  '  }).filter((block) => block !== null);',
  '}'
].join('\n')

const PINNED_MODEL_CATALOG_STARTUP_FIXTURE = [
  'function startCodexConnection(codexPath, env) {',
  '  const spawnEnv = env ?? process.env;',
  '  let codex;',
  '  if (codexPath) {',
  '    codex = process.platform === "win32" ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv }) : spawn(codexPath, ["app-server"], { env: spawnEnv });',
  '  } else {',
  '    const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");',
  '    codex = spawn(process.execPath, [bundledCodexPath, "app-server"], { env: spawnEnv });',
  '  }',
  '  return codex;',
  '}'
].join('\n')

const adapterFixture = (marker: string): Buffer =>
  Buffer.from(
    `${marker}\n${PINNED_SKILL_MAPPER_FIXTURE}\n${PINNED_MODEL_CATALOG_STARTUP_FIXTURE}\n`
  )

const withPinnedSkillMapper = (source: string): string =>
  `${source}\n${PINNED_SKILL_MAPPER_FIXTURE}\n${PINNED_MODEL_CATALOG_STARTUP_FIXTURE}`

// Injectable fault flags for the fs/promises mock — each targets one specific rename call:
//   onStagedMove: throw EPERM when src is the .codex-install- scratch dir (staged→destination)
//   onStagedMoveEio: throw EIO on the same call (non-EPERM staged-failure path)
//   onDestBackup: throw EPERM when dest contains .backup- (destination→backup, upgrade path)
//   onRestore: throw EPERM when src contains .backup- (backup→destination restore)
//   cp: throw EPERM from cp() to exercise the copy-failure→backup-restore branch
//   adapterReplaceFailures: transiently lock the destination during temp→adapter publication
const fsFaults = vi.hoisted(() => ({
  renameOnStagedMove: false,
  renameOnStagedMoveEio: false,
  renameOnDestBackup: false,
  renameOnRestore: false,
  cpFailure: false,
  adapterReplaceFailures: 0,
  adapterReplaceFailureCode: 'EPERM' as 'EPERM' | 'EBUSY',
  pauseNextWrite: false,
  partialWritePublished: undefined as (() => void) | undefined,
  resumeWrite: undefined as Promise<void> | undefined
}))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (src: string, dest: string) => {
      if (fsFaults.renameOnStagedMove && src.includes('.codex-install-') && !src.endsWith('.tmp')) {
        fsFaults.renameOnStagedMove = false
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      if (
        fsFaults.renameOnStagedMoveEio &&
        src.includes('.codex-install-') &&
        !src.endsWith('.tmp')
      ) {
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
      if (
        fsFaults.adapterReplaceFailures > 0 &&
        src.endsWith('.tmp') &&
        dest.endsWith('index.js')
      ) {
        fsFaults.adapterReplaceFailures -= 1
        const code = fsFaults.adapterReplaceFailureCode
        throw Object.assign(new Error(`${code}: destination is temporarily locked, rename`), {
          code
        })
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
        const patchTarget = '    const contextTokenUsage = this.sessionState.lastTokenUsage;'
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
  patchCodexAcpModelCatalogStartupSource,
  patchCodexAcpSkillInputSource,
  patchCodexAcpTurnUsageSource,
  resolveManagedCodexPlatform,
  runManagedCodexVersion,
  sanitizeManagedCodexDiagnostic,
  verifyManagedCodexPair,
  uninstallManagedCodex
} from './managed-codex'

it('runs Windows Codex command shims through the shell during version verification', async () => {
  const spawnVersion = vi.fn(async () => ({ status: 0, stdout: 'codex-cli 0.144.6' }))

  await expect(
    runManagedCodexVersion(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
      ['--version'],
      { NO_BROWSER: '1' },
      'win32',
      spawnVersion
    )
  ).resolves.toBe('0.144.6')
  expect(spawnVersion).toHaveBeenCalledWith(
    '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"',
    ['--version'],
    expect.objectContaining({ shell: true })
  )
})

it('aborts a running Codex version check', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 25)

  await expect(
    runManagedCodexVersion(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      undefined,
      process.platform,
      undefined,
      controller.signal
    )
  ).resolves.toBeUndefined()
  expect(Date.now() - startedAt).toBeLessThan(750)
})

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

    expect(CODEX_ACP_VERSION).toBe('1.6.2')
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
        content: adapterFixture('#!/usr/bin/env node\nconsole.log("codex-acp")'),
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

    const controller = new AbortController()
    const verifyAdapter = vi.fn().mockResolvedValue('1.6.2')
    const verifyCodex = vi.fn().mockResolvedValue('0.144.6')
    const verifyPair = vi.fn().mockResolvedValue(undefined)
    const outcome = await installManagedCodex({
      installId: 'codex-1',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter,
      verifyCodex,
      verifyPair,
      signal: controller.signal,
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
    })

    expect(outcome).toEqual({
      result: { installId: 'codex-1', ok: true },
      adapterPath: managedCodexAdapterEntry(root),
      adapterVersion: '1.6.2',
      codexPath: managedCodexBinary(root, platform),
      codexVersion: '0.144.6'
    })
    expect(metadataUrls).toEqual([
      'https://reg/@agentclientprotocol%2fcodex-acp/1.6.2',
      'https://reg/@openai%2fcodex/0.144.6-darwin-arm64'
    ])
    expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toContain('codex-acp')
    expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe('native-codex')
    expect(verifyAdapter).toHaveBeenCalledWith(expect.any(String), controller.signal)
    expect(verifyCodex).toHaveBeenCalledWith(expect.any(String), controller.signal)
    expect(verifyPair).toHaveBeenCalledWith(
      expect.stringContaining(join('adapter', 'dist', 'index.js')),
      expect.stringContaining(join('codex', 'vendor', platform.target, 'bin', 'codex')),
      expect.stringContaining('smoke-home'),
      controller.signal
    )
    expect(
      await readFile(
        join(managedCodexRoot(root), 'codex', 'vendor', platform.target, 'codex-path', 'rg'),
        'utf8'
      )
    ).toBe('managed-rg')
    await expect(readFile(join(managedCodexRoot(root), 'old-install'))).rejects.toThrow()
  })

  it('updates only the adapter when paired with a user-owned Codex CLI', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-adapter-'))
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })
    const adapterTgz = buildTgz([
      {
        name: 'package/dist/index.js',
        content: adapterFixture('adapter-only'),
        mode: 0o755
      }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('managed-codex-should-not-be-installed'),
        mode: 0o755
      }
    ])
    const externalCodexPath = join(root, 'user-bin', 'codex')
    await mkdir(dirname(externalCodexPath), { recursive: true })
    await writeFile(externalCodexPath, 'user-owned-codex')
    await mkdir(dirname(managedCodexAdapterEntry(root)), { recursive: true })
    await writeFile(managedCodexAdapterEntry(root), 'old-adapter')

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
    const verifyPair = vi.fn().mockResolvedValue(undefined)

    const outcome = await installManagedCodex({
      installId: 'adapter-only',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: () => Promise.resolve('1.6.2'),
      verifyCodex: () => Promise.resolve('0.144.6'),
      verifyPair,
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) },
      existingCodexPath: externalCodexPath
    })

    expect(outcome).toEqual({
      result: { installId: 'adapter-only', ok: true },
      adapterPath: managedCodexAdapterEntry(root),
      adapterVersion: '1.6.2',
      codexPath: externalCodexPath,
      codexVersion: '0.144.6'
    })
    expect(metadataUrls).toEqual(['https://reg/@agentclientprotocol%2fcodex-acp/1.6.2'])
    expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toContain('adapter-only')
    expect(await readFile(externalCodexPath, 'utf8')).toBe('user-owned-codex')
    await expect(readFile(managedCodexBinary(root, platform))).rejects.toThrow()
    expect(verifyPair).toHaveBeenCalledWith(
      expect.stringContaining(join('adapter', 'dist', 'index.js')),
      externalCodexPath,
      expect.stringContaining('smoke-home')
    )
  })

  it('falls back to the managed Codex CLI when the user-owned CLI is incompatible', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-fallback-'))
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })
    const adapterTgz = buildTgz([
      {
        name: 'package/dist/index.js',
        content: adapterFixture('fallback-adapter'),
        mode: 0o755
      }
    ])
    const nativeTgz = buildTgz([
      {
        name: `package/vendor/${platform.target}/bin/codex`,
        content: Buffer.from('managed-compatible-codex'),
        mode: 0o755
      }
    ])
    const externalCodexPath = join(root, 'user-bin', 'codex')
    await mkdir(dirname(externalCodexPath), { recursive: true })
    await writeFile(externalCodexPath, 'user-owned-incompatible-codex')

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
    const verifyPair = vi.fn(async (_adapterPath: string, codexPath: string) => {
      if (codexPath === externalCodexPath) throw new Error('incompatible Codex CLI')
    })

    const outcome = await installManagedCodex({
      installId: 'codex-fallback',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson,
      fetchTarball,
      verifyAdapter: () => Promise.resolve('1.6.2'),
      verifyCodex: () => Promise.resolve('0.144.6'),
      verifyPair,
      integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) },
      existingCodexPath: externalCodexPath
    })

    expect(outcome).toEqual({
      result: { installId: 'codex-fallback', ok: true },
      adapterPath: managedCodexAdapterEntry(root),
      adapterVersion: '1.6.2',
      codexPath: managedCodexBinary(root, platform),
      codexVersion: '0.144.6'
    })
    expect(metadataUrls).toContain('https://reg/@openai%2fcodex/0.144.6-darwin-arm64')
    expect(await readFile(externalCodexPath, 'utf8')).toBe('user-owned-incompatible-codex')
    expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe(
      'managed-compatible-codex'
    )
    expect(verifyPair).toHaveBeenCalledTimes(2)
  })

  it('runs the smoke handshake from a home outside the staged runtime tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'darwin', arch: 'arm64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: adapterFixture('adapter'), mode: 0o755 }
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
      verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter'), mode: 0o755 }
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
        return '1.6.2'
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter'), mode: 0o755 }
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
      verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-eperm'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
        verifyCodex: () => Promise.resolve('0.144.6'),
        verifyPair: vi.fn().mockResolvedValue(undefined),
        integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
      })

      expect(outcome.result.ok).toBe(true)
      expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toContain('adapter-eperm')
      expect(await readFile(managedCodexBinary(root, platform), 'utf8')).toBe('codex-eperm')
    } finally {
      fsFaults.renameOnStagedMove = false
    }
  })

  it('falls back to copy+delete when destination→backup rename throws EPERM (upgrade path)', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-codex-'))
    const platform = resolveManagedCodexPlatform({ platform: 'linux', arch: 'x64' })
    const adapterTgz = buildTgz([
      { name: 'package/dist/index.js', content: adapterFixture('adapter-upgrade'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
        verifyCodex: () => Promise.resolve('0.144.6'),
        verifyPair: vi.fn().mockResolvedValue(undefined),
        integrities: { adapter: sha512(adapterTgz), codex: sha512(nativeTgz) }
      })

      expect(outcome.result.ok).toBe(true)
      expect(await readFile(managedCodexAdapterEntry(root), 'utf8')).toContain('adapter-upgrade')
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-cp-fail'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-restore'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-backup-fail'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-eio'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-local-fail'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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
      { name: 'package/dist/index.js', content: adapterFixture('adapter-orphan'), mode: 0o755 }
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
        verifyAdapter: () => Promise.resolve('1.6.2'),
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

  it("recombines the pinned adapter's exclusive input and cached input for context usage", () => {
    const source = [
      '  createUsageUpdate(params) {',
      '    this.handleTokenUsageUpdated(params);',
      '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
      '    return { used };',
      '  }'
    ].join('\n')

    const patched = patchCodexAcpContextUsageSource(source)

    expect(patched).toContain(
      ': contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
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
        withPinnedSkillMapper(
          [
            '  createUsageUpdate(params) {',
            '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
            '  }'
          ].join('\n')
        )
      )

      await ensureManagedCodexContextUsage(adapterPath)
      await ensureManagedCodexContextUsage(adapterPath)

      expect(await readFile(adapterPath, 'utf8')).toContain(
        ': contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
      )
    } finally {
      await rm(patchRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'preserves executable access when patching an installed adapter',
    async () => {
      const patchRoot = await mkdtemp(join(tmpdir(), 'managed-codex-patch-mode-'))
      try {
        const adapterPath = join(patchRoot, 'index.js')
        await writeFile(
          adapterPath,
          withPinnedSkillMapper(
            [
              '  createUsageUpdate(params) {',
              '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
              '  }'
            ].join('\n')
          )
        )
        await chmod(adapterPath, 0o755)

        await ensureManagedCodexContextUsage(adapterPath)

        await expect(access(adapterPath, constants.X_OK)).resolves.toBeUndefined()
      } finally {
        await rm(patchRoot, { recursive: true, force: true })
      }
    }
  )

  it.each(['EPERM', 'EBUSY'] as const)(
    'retries an atomic adapter replace after a transient %s destination lock',
    async (errorCode) => {
      const patchRoot = await mkdtemp(join(tmpdir(), 'managed-codex-patch-lock-'))
      try {
        const adapterPath = join(patchRoot, 'index.js')
        await writeFile(
          adapterPath,
          withPinnedSkillMapper(
            [
              '  createUsageUpdate(params) {',
              '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
              '  }'
            ].join('\n')
          )
        )
        fsFaults.adapterReplaceFailureCode = errorCode
        fsFaults.adapterReplaceFailures = 1

        await ensureManagedCodexContextUsage(adapterPath)

        expect(await readFile(adapterPath, 'utf8')).toContain(
          ': contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
        )
      } finally {
        fsFaults.adapterReplaceFailures = 0
        fsFaults.adapterReplaceFailureCode = 'EPERM'
        await rm(patchRoot, { recursive: true, force: true })
      }
    }
  )

  it('keeps concurrent context-usage checks from observing a partially patched adapter', async () => {
    const patchRoot = await mkdtemp(join(tmpdir(), 'managed-codex-patch-race-'))
    let releaseWrite: (() => void) | undefined
    try {
      const adapterPath = join(patchRoot, 'index.js')
      await writeFile(
        adapterPath,
        withPinnedSkillMapper(
          [
            '  const usageSchema = { totalTokens: true };',
            '  createUsageUpdate(params) {',
            '    this.handleTokenUsageUpdated(params);',
            '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
            '    return { used };',
            '  }'
          ].join('\n')
        )
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
        ': contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
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

describe('patchCodexAcpTurnUsageSource', () => {
  type FixtureTokenUsage = {
    totalTokens: number
    inputTokens: number
    cachedInputTokens?: number
    outputTokens: number
    reasoningOutputTokens: number
  }

  const fixture = [
    '  const sessionState = { currentTurnId: null, lastTokenUsage: null, totalTokenUsage: null };',
    '  const activePrompt = { complete() {} };',
    '  const adapter = {',
    '    sessionState,',
    '    handleTokenUsageUpdated(params) {',
    '      this.sessionState.lastTokenUsage = params.tokenUsage.last;',
    '      this.sessionState.totalTokenUsage = params.tokenUsage.total;',
    '    },',
    '  createUsageUpdate(params) {',
    '    this.handleTokenUsageUpdated(params);',
    '    return null;',
    '  },',
    '    buildPromptUsage(usage) { return usage; },',
    '    buildQuotaMeta() { return { quota: { remaining: 42 } }; },',
    '    startPrompt() {',
    '    sessionState.currentTurnId = null;',
    '    sessionState.lastTokenUsage = null;',
    '    },',
    '    commandResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: this.buildQuotaMeta(sessionState), }; },',
    '    normalResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: this.buildQuotaMeta(sessionState), }; },',
    '    cancelledResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: this.buildQuotaMeta(sessionState), }; },',
    '    finishPrompt() {',
    '      const response = this.normalResponse();',
    '      activePrompt.complete();',
    '      return response;',
    '    }',
    '  };',
    '  return adapter;'
  ].join('\n')

  // Mirrors codex-acp 1.1.4's buildPromptUsage -> toPromptUsage output rather than using the
  // passthrough mapper above, so this fixture covers the adapter-to-runtime cache-field contract.
  const fixtureWithPinnedPromptUsage = fixture.replace(
    '    buildPromptUsage(usage) { return usage; },',
    [
      '    buildPromptUsage(tokenCount) {',
      '      if (tokenCount == null) return null;',
      '      return {',
      '        totalTokens: tokenCount.totalTokens,',
      '        inputTokens: tokenCount.inputTokens,',
      '        cachedReadTokens: tokenCount.cachedInputTokens,',
      '        outputTokens: tokenCount.outputTokens,',
      '        thoughtTokens: tokenCount.reasoningOutputTokens',
      '      };',
      '    },'
    ].join('\n')
  )

  const usage = (
    totalTokens: number,
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
    reasoningOutputTokens: number
  ): FixtureTokenUsage => ({
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens
  })

  const uncachedUsage = (
    totalTokens: number,
    inputTokens: number,
    outputTokens: number,
    reasoningOutputTokens: number
  ): FixtureTokenUsage => ({
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens
  })

  it('accumulates every model request in one Codex prompt without double-counting updates', () => {
    const patched = patchCodexAcpTurnUsageSource(fixture)
    const adapter = Function(patched)() as {
      startPrompt: () => void
      createUsageUpdate: (params: unknown) => void
      finishPrompt: () => {
        usage: ReturnType<typeof usage> | null
        _meta?: Record<string, unknown>
      }
    }

    // Seed the previous completed turn so the first update is derived from cumulative totals.
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(100, 70, 13, 15, 2),
        total: usage(100, 70, 13, 15, 2)
      }
    })
    adapter.startPrompt()
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(18, 12, 3, 3, 0),
        total: usage(118, 82, 16, 18, 2)
      }
    })
    // Codex can repeat the same cumulative snapshot; a zero delta must not add the request twice.
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(18, 12, 3, 3, 0),
        total: usage(118, 82, 16, 18, 2)
      }
    })
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(27, 19, 5, 3, 0),
        total: usage(145, 101, 21, 21, 2)
      }
    })

    const response = adapter.finishPrompt()
    expect(response.usage).toEqual(usage(27, 19, 5, 3, 0))
    expect(response._meta?.['open-science/turn-usage']).toEqual(usage(45, 31, 8, 6, 0))
    expect(response._meta?.['open-science/model-turn-count']).toBe(2)
    expect(response._meta?.[ACP_MODEL_CALL_USAGE_META_KEY]).toEqual([
      usage(18, 12, 3, 3, 0),
      usage(27, 19, 5, 3, 0)
    ])
    expect(patchCodexAcpTurnUsageSource(patched)).toBe(patched)
  })

  it('preserves cached-input totals through the pinned adapter mapping and ACP normalization', () => {
    const adapter = Function(patchCodexAcpTurnUsageSource(fixtureWithPinnedPromptUsage))() as {
      startPrompt: () => void
      createUsageUpdate: (params: unknown) => void
      finishPrompt: () => { _meta?: Record<string, unknown> }
    }

    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(100, 70, 13, 15, 2),
        total: usage(100, 70, 13, 15, 2)
      }
    })
    adapter.startPrompt()
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(18, 12, 3, 3, 0),
        total: usage(118, 82, 16, 18, 2)
      }
    })
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(27, 19, 5, 3, 0),
        total: usage(145, 101, 21, 21, 2)
      }
    })

    const response = adapter.finishPrompt()
    expect(toAcpTurnTokenUsage(response._meta?.[ACP_TURN_TOKEN_USAGE_META_KEY])).toEqual({
      inputTokens: 31,
      cacheTokens: 8,
      outputTokens: 6
    })
  })

  it('merges whole-turn usage with the pinned adapter quota metadata', () => {
    const adapter = Function(patchCodexAcpTurnUsageSource(fixture))() as {
      startPrompt: () => void
      createUsageUpdate: (params: unknown) => void
      finishPrompt: () => { _meta?: Record<string, unknown> }
    }

    adapter.startPrompt()
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(18, 12, 3, 3, 0),
        total: usage(18, 12, 3, 3, 0)
      }
    })

    expect(adapter.finishPrompt()._meta).toEqual({
      quota: { remaining: 42 },
      [ACP_TURN_TOKEN_USAGE_META_KEY]: usage(18, 12, 3, 3, 0),
      [ACP_MODEL_TURN_COUNT_META_KEY]: 1,
      [ACP_MODEL_CALL_USAGE_META_KEY]: [usage(18, 12, 3, 3, 0)]
    })
  })

  it('uses the first request snapshot when a resumed session has no cumulative baseline', () => {
    const adapter = Function(patchCodexAcpTurnUsageSource(fixture))() as {
      startPrompt: () => void
      createUsageUpdate: (params: unknown) => void
      finishPrompt: () => { usage: ReturnType<typeof usage> | null }
    }

    adapter.startPrompt()
    adapter.createUsageUpdate({
      tokenUsage: {
        last: usage(18, 12, 3, 3, 0),
        total: usage(10_018, 8_012, 1_003, 903, 100)
      }
    })

    const response = adapter.finishPrompt() as {
      usage: ReturnType<typeof usage> | null
      _meta?: Record<string, unknown>
    }
    expect(response.usage).toEqual(usage(18, 12, 3, 3, 0))
    expect(response._meta?.['open-science/turn-usage']).toEqual(usage(18, 12, 3, 3, 0))
  })

  it('normalizes omitted cached-input counters without double-counting repeated updates', () => {
    const adapter = Function(patchCodexAcpTurnUsageSource(fixture))() as {
      startPrompt: () => void
      createUsageUpdate: (params: unknown) => void
      finishPrompt: () => { _meta?: Record<string, unknown> }
    }

    adapter.createUsageUpdate({
      tokenUsage: {
        last: uncachedUsage(100, 70, 15, 2),
        total: uncachedUsage(100, 70, 15, 2)
      }
    })
    adapter.startPrompt()
    for (const snapshot of [
      uncachedUsage(118, 82, 18, 2),
      uncachedUsage(118, 82, 18, 2),
      uncachedUsage(145, 101, 21, 2)
    ]) {
      adapter.createUsageUpdate({
        tokenUsage: {
          last:
            snapshot.totalTokens === 118
              ? uncachedUsage(18, 12, 3, 0)
              : uncachedUsage(27, 19, 3, 0),
          total: snapshot
        }
      })
    }

    expect(adapter.finishPrompt()._meta?.['open-science/turn-usage']).toEqual(
      usage(45, 31, 0, 6, 0)
    )
  })

  it('upgrades the existing turn-usage patch to normalize cached-input counters', () => {
    const normalized = patchCodexAcpTurnUsageSource(fixture)
    const legacy = normalized
      .replace(
        [
          '    const normalizeTokenUsage = (usage) =>',
          '      usage == null',
          '        ? usage',
          '        : { ...usage, cachedInputTokens: usage.cachedInputTokens ?? 0 };',
          '    const previousTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);'
        ].join('\n'),
        '    const previousTotalTokenUsage = this.sessionState.totalTokenUsage;'
      )
      .replace(
        '    const currentTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);',
        '    const currentTotalTokenUsage = this.sessionState.totalTokenUsage;'
      )
      .replace(
        '    const lastTokenUsage = normalizeTokenUsage(this.sessionState.lastTokenUsage);',
        '    const lastTokenUsage = this.sessionState.lastTokenUsage;'
      )

    expect(legacy).not.toBe(normalized)
    expect(patchCodexAcpTurnUsageSource(legacy)).toBe(normalized)
  })

  it('upgrades the overwritten turn-usage metadata shape in an existing managed adapter', () => {
    const patched = patchCodexAcpTurnUsageSource(fixture)
    const latestUsage = [
      'usage: this.buildPromptUsage(',
      '  sessionState.lastTokenUsage',
      '),'
    ].join('\n')
    const overwrittenUsage = [
      latestUsage,
      '...(sessionState.promptTokenUsageObserved',
      '  ? {',
      '      _meta: {',
      `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage),`,
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount`,
      '      }',
      '    }',
      '  : {}),'
    ].join('\n')
    const mergedMeta = [
      '_meta: {',
      '  ...this.buildQuotaMeta(sessionState),',
      '  ...(sessionState.promptTokenUsageObserved',
      '    ? {',
      `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage),`,
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount,`,
      `        "${ACP_MODEL_CALL_USAGE_META_KEY}": sessionState.promptModelCalls.map((usage) => this.buildPromptUsage(usage))`,
      '      }',
      '    : {})',
      '}'
    ].join('\n')
    const overwritten = patched.replaceAll(
      `${latestUsage} ${mergedMeta}`,
      `${overwrittenUsage} _meta: this.buildQuotaMeta(sessionState)`
    )

    expect(overwritten).not.toBe(patched)
    expect(patchCodexAcpTurnUsageSource(overwritten)).toBe(patched)
  })

  it('repairs an overwritten response when other response sites already match the current patch', () => {
    const patched = patchCodexAcpTurnUsageSource(fixture)
    const latestUsage = [
      'usage: this.buildPromptUsage(',
      '  sessionState.lastTokenUsage',
      '),'
    ].join('\n')
    const overwrittenUsage = [
      latestUsage,
      '...(sessionState.promptTokenUsageObserved',
      '  ? {',
      '      _meta: {',
      `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage),`,
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount`,
      '      }',
      '    }',
      '  : {}),'
    ].join('\n')
    const mixedResponseSites = `${patched}\n${overwrittenUsage}`

    expect(patchCodexAcpTurnUsageSource(mixedResponseSites)).toBe(`${patched}\n${latestUsage}`)
  })

  it('patches Codex ACP 1.6.2 extra terminalFailure usage site', () => {
    const adapter162 = fixture.replace(
      '    cancelledResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: this.buildQuotaMeta(sessionState), }; },',
      [
        '    cancelledResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: this.buildQuotaMeta(sessionState), }; },',
        '    terminalFailureResponse() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), _meta: { ...this.buildQuotaMeta(sessionState) } }; },'
      ].join('\n')
    )

    expect(() => patchCodexAcpTurnUsageSource(adapter162)).not.toThrow()
    const patched = patchCodexAcpTurnUsageSource(adapter162)
    expect(
      patched.split('usage: this.buildPromptUsage(\n  sessionState.lastTokenUsage\n),').length - 1
    ).toBe(4)
    expect(patched).toContain('promptTokenUsageObserved')
  })

  it('fails closed when PromptResponse usage sites drift past the known 1.1.4 and 1.6.2 shapes', () => {
    const drifted = `${fixture}\n    extraA() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), }; }\n    extraB() { return { usage: this.buildPromptUsage(sessionState.lastTokenUsage), }; }`

    expect(() => patchCodexAcpTurnUsageSource(drifted)).toThrow(
      /turn-usage patch no longer matches/
    )
  })

  it('composes with the context-usage patch without duplicate declarations', () => {
    const contextFixture = fixture.replace(
      '    this.handleTokenUsageUpdated(params);\n    return null;',
      [
        '    this.handleTokenUsageUpdated(params);',
        '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
        '    return used;'
      ].join('\n')
    )
    const composed = patchCodexAcpTurnUsageSource(patchCodexAcpContextUsageSource(contextFixture))

    expect(() => Function(composed)).not.toThrow()
    expect(composed).toContain(
      ': contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
    )
  })
})

describe('patchCodexAcpModelCatalogStartupSource', () => {
  it('passes a generated model catalog to the native app-server at process startup', () => {
    const patched = patchCodexAcpModelCatalogStartupSource(PINNED_MODEL_CATALOG_STARTUP_FIXTURE)
    const spawn = vi.fn(() => ({ pid: 1 }))
    const startCodexConnection = Function(
      'spawn',
      'process',
      'createRequire',
      'importMetaUrl',
      `${patched.replace('import.meta.url', 'importMetaUrl')}; return startCodexConnection;`
    )(
      spawn,
      { platform: 'darwin', execPath: '/runtime/node', env: {} },
      () => ({ resolve: () => '/runtime/bundled-codex.js' }),
      'file:///runtime/adapter.js'
    ) as (codexPath: string, env: NodeJS.ProcessEnv) => unknown
    const catalogPath = '/data/codex/model-catalog-with spaces.json'

    startCodexConnection('/runtime/codex', {
      CODEX_CONFIG: JSON.stringify({ model_catalog_json: catalogPath, model: 'MiniMax-M3' })
    })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/codex',
      ['app-server', '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`],
      expect.objectContaining({ env: expect.any(Object) })
    )
    expect(patchCodexAcpModelCatalogStartupSource(patched)).toBe(patched)
  })

  it('keeps the native app-server command unchanged without a generated catalog', () => {
    const patched = patchCodexAcpModelCatalogStartupSource(PINNED_MODEL_CATALOG_STARTUP_FIXTURE)
    const spawn = vi.fn(() => ({ pid: 1 }))
    const startCodexConnection = Function(
      'spawn',
      'process',
      'createRequire',
      'importMetaUrl',
      `${patched.replace('import.meta.url', 'importMetaUrl')}; return startCodexConnection;`
    )(
      spawn,
      { platform: 'darwin', execPath: '/runtime/node', env: {} },
      () => ({ resolve: () => '/runtime/bundled-codex.js' }),
      'file:///runtime/adapter.js'
    ) as (codexPath: string, env: NodeJS.ProcessEnv) => unknown

    startCodexConnection('/runtime/codex', { CODEX_CONFIG: JSON.stringify({ model: 'gpt-5.4' }) })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/codex',
      ['app-server'],
      expect.objectContaining({ env: expect.any(Object) })
    )
  })

  it('fails closed when the pinned app-server spawn source drifts', () => {
    const drifted = PINNED_MODEL_CATALOG_STARTUP_FIXTURE.replace(
      'spawn(codexPath, ["app-server"], { env: spawnEnv })',
      'spawn(codexPath, ["app-server", "--stdio"], { env: spawnEnv })'
    )

    expect(() => patchCodexAcpModelCatalogStartupSource(drifted)).toThrow(
      /model-catalog startup patch no longer matches/
    )
  })
})

describe('patchCodexAcpSkillInputSource', () => {
  it('maps a private ACP descriptor to native Skill input before unchanged text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-codex-skill-input-'))
    const codexHome = join(root, 'codex-home')
    const skillPath = join(codexHome, 'skills', 'mcp-pubmed', 'SKILL.md')
    try {
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, '# PubMed')
      const source = [
        'function buildPromptItems(prompt) {',
        '  return prompt.map((block) => {',
        '    switch (block.type) {',
        '      case "text":',
        '        return { type: "text", text: block.text, text_elements: [] };',
        '      default:',
        '        return null;',
        '    }',
        '  }).filter((block) => block !== null);',
        '}'
      ].join('\n')

      const patched = patchCodexAcpSkillInputSource(source)
      const buildPromptItems = Function(
        'path4',
        'fs4',
        'process',
        `${patched}; return buildPromptItems;`
      )(await import('node:path'), await import('node:fs'), { env: { CODEX_HOME: codexHome } }) as (
        prompt: unknown[]
      ) => unknown[]

      expect(
        buildPromptItems([
          {
            type: 'text',
            text: 'Search PubMed',
            _meta: {
              'open-science/skill-inputs': [{ name: 'mcp-pubmed', path: skillPath }]
            }
          }
        ])
      ).toEqual([
        { type: 'skill', name: 'mcp-pubmed', path: skillPath },
        { type: 'text', text: 'Search PubMed', text_elements: [] }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'ignores a descriptor whose apparent Skill path escapes through a symlink',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'managed-codex-skill-symlink-'))
      const codexHome = join(root, 'codex-home')
      const outsidePath = join(root, 'outside-SKILL.md')
      const skillPath = join(codexHome, 'skills', 'escape', 'SKILL.md')
      try {
        await mkdir(dirname(skillPath), { recursive: true })
        await writeFile(outsidePath, '# Outside')
        await symlink(outsidePath, skillPath)
        const source = [
          'function buildPromptItems(prompt) {',
          '  return prompt.map((block) => {',
          '    switch (block.type) {',
          '      case "text":',
          '        return { type: "text", text: block.text, text_elements: [] };',
          '      default:',
          '        return null;',
          '    }',
          '  }).filter((block) => block !== null);',
          '}'
        ].join('\n')
        const patched = patchCodexAcpSkillInputSource(source)
        const buildPromptItems = Function(
          'path4',
          'fs4',
          'process',
          `${patched}; return buildPromptItems;`
        )(await import('node:path'), await import('node:fs'), {
          env: { CODEX_HOME: codexHome }
        }) as (prompt: unknown[]) => unknown[]

        expect(
          buildPromptItems([
            {
              type: 'text',
              text: 'Keep this text',
              _meta: {
                'open-science/skill-inputs': [{ name: 'escape', path: skillPath }]
              }
            }
          ])
        ).toEqual([{ type: 'text', text: 'Keep this text', text_elements: [] }])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('ignores invalid and duplicate descriptors while preserving original text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-codex-skill-validation-'))
    const codexHome = join(root, 'codex-home')
    const validPath = join(codexHome, 'skills', 'mcp-pubmed', 'SKILL.md')
    const outsidePath = join(root, 'outside', 'SKILL.md')
    try {
      await mkdir(dirname(validPath), { recursive: true })
      await mkdir(dirname(outsidePath), { recursive: true })
      await writeFile(validPath, '# PubMed')
      await writeFile(outsidePath, '# Outside')
      const source = [
        'function buildPromptItems(prompt) {',
        '  return prompt.map((block) => {',
        '    switch (block.type) {',
        '      case "text":',
        '        return { type: "text", text: block.text, text_elements: [] };',
        '      default:',
        '        return null;',
        '    }',
        '  }).filter((block) => block !== null);',
        '}'
      ].join('\n')
      const patched = patchCodexAcpSkillInputSource(source)
      const buildPromptItems = Function(
        'path4',
        'fs4',
        'process',
        `${patched}; return buildPromptItems;`
      )(await import('node:path'), await import('node:fs'), {
        env: { CODEX_HOME: codexHome }
      }) as (prompt: unknown[]) => unknown[]

      expect(
        buildPromptItems([
          {
            type: 'text',
            text: 'Original text',
            _meta: {
              'open-science/skill-inputs': [
                { name: 'mcp-pubmed', path: validPath },
                { name: 'mcp-pubmed', path: validPath },
                { name: '', path: validPath },
                { name: 'relative', path: 'skills/relative/SKILL.md' },
                { name: 'outside', path: outsidePath },
                { name: 'missing', path: join(codexHome, 'skills', 'missing', 'SKILL.md') }
              ]
            }
          },
          { type: 'text', text: 'No metadata' }
        ])
      ).toEqual([
        { type: 'skill', name: 'mcp-pubmed', path: validPath },
        { type: 'text', text: 'Original text', text_elements: [] },
        { type: 'text', text: 'No metadata', text_elements: [] }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the pinned buildPromptItems source drifts', () => {
    const drifted = [
      'function buildPromptItems(prompt) {',
      '  return prompt.map((block) => ({ type: "text", text: block.text }));',
      '}'
    ].join('\n')

    expect(() => patchCodexAcpSkillInputSource(drifted)).toThrow(
      /Skill-input patch no longer matches/
    )
  })

  it('fails closed when the pinned prompt mapper is renamed or removed', () => {
    const drifted = [
      'function mapPromptItems(prompt) {',
      '  return prompt.map((block) => ({ type: "text", text: block.text }));',
      '}'
    ].join('\n')

    expect(() => patchCodexAcpSkillInputSource(drifted)).toThrow(
      /Skill-input patch no longer matches/
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
