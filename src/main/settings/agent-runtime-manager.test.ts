import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import type { ConnectorSettingsModule } from './connector-settings'
import type { ClaudeDetectDeps } from './claude-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { ProviderPreflightAccess } from './agent-runtime-manager'
import type { SkillCatalogModule } from './skill-catalog'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/no-such-app-root', isPackaged: false }
}))

vi.mock('./environment-check', () => ({
  runEnvironmentCheck: vi.fn(async ({ agentFrameworkId, frameworks }) => ({
    checkedAt: 1,
    platform: 'linux',
    architecture: 'arm64',
    checks: [],
    ready: true,
    canAutoInstall: true,
    agentFrameworkId,
    runtime: frameworks.find((framework: { id: string }) => framework.id === agentFrameworkId)
      ?.runtime ?? {
      found: false
    }
  }))
}))

const { runInstallWithFallbackSpy } = vi.hoisted(() => ({
  runInstallWithFallbackSpy: vi.fn()
}))

vi.mock('./claude-install', async (importActual) => ({
  ...(await importActual<typeof import('./claude-install')>()),
  runInstallWithFallback: runInstallWithFallbackSpy
}))

const { AgentRuntimeManager } = await import('./agent-runtime-manager')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { connectorSkillSourceDir } = await import('../connectors/provision')
const { installManagedClaude, managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { managedCodeBuddyDir, verifyCodeBuddyVersion } = await import('./managed-codebuddy')

type Repository = InstanceType<typeof SettingsRepository>
type ManagerOptions = ConstructorParameters<typeof AgentRuntimeManager>[0]

type RuntimeInventory = {
  claude: Map<string, string | undefined>
  opencode: Map<string, string | undefined>
  codexAdapter: Map<string, string | undefined>
  codexNative: Map<string, string | undefined>
}

const createInventory = (): RuntimeInventory => ({
  claude: new Map(),
  opencode: new Map(),
  codexAdapter: new Map(),
  codexNative: new Map()
})

const buildManagedClaudeTgz = (content: Buffer): Buffer => {
  const header = Buffer.alloc(512)
  header.write('package/claude', 0, 'utf8')
  header.write('0000755\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]))
}

const sha512 = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

const createClaudeDeps = (inventory: RuntimeInventory): ClaudeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.claude.has(path)),
  getVersion: (path) => Promise.resolve(inventory.claude.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createOpencodeDeps = (inventory: RuntimeInventory): OpencodeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.opencode.has(path)),
  getVersion: (path) => Promise.resolve(inventory.opencode.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createCodexDeps = (
  inventory: RuntimeInventory,
  managedAdapterPath: string,
  managedCodexPath: string
): CodexDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isRunnable: (path) => Promise.resolve(inventory.codexAdapter.has(path)),
  getAdapterVersion: (path) => Promise.resolve(inventory.codexAdapter.get(path)),
  getCodexVersion: (path) => Promise.resolve(inventory.codexNative.get(path)),
  smokeInitialize: () => Promise.resolve(true),
  resolveNpmBinDirs: () => Promise.resolve([]),
  managedAdapterPath,
  managedCodexPath
})

describe('AgentRuntimeManager', () => {
  let storageRoot: string
  let repository: Repository
  let inventory: RuntimeInventory
  let managedAdapterPath: string
  let managedCodexPath: string
  let manager: InstanceType<typeof AgentRuntimeManager>

  const makeTreeWritable = async (root: string): Promise<void> => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    await chmod(root, 0o755).catch(() => undefined)
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? makeTreeWritable(join(root, entry.name))
          : chmod(join(root, entry.name), 0o644).catch(() => undefined)
      )
    )
  }

  const createManager = (
    overrides: Partial<ManagerOptions> = {}
  ): InstanceType<typeof AgentRuntimeManager> => {
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined)
    } as unknown as SkillCatalogModule
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule

    return new AgentRuntimeManager({
      repository,
      configRoot: storageRoot,
      userClaudeDir: join(storageRoot, 'user-claude'),
      skills,
      connectors,
      allocateSettingsIdSequence: vi.fn().mockReturnValue(1),
      detectDeps: createClaudeDeps(inventory),
      opencodeDetectDeps: createOpencodeDeps(inventory),
      codexDetectDeps: createCodexDeps(inventory, managedAdapterPath, managedCodexPath),
      allocateOpenCodeUsagePort: () => Promise.resolve(42_424),
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedCodeBuddyImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      resolveCodexProxyEnvironment: () => Promise.resolve(undefined),
      ...overrides
    })
  }

  beforeEach(async () => {
    runInstallWithFallbackSpy.mockReset()
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-manager-'))
    repository = new SettingsRepository(storageRoot)
    inventory = createInventory()
    managedAdapterPath = join(storageRoot, 'codex-managed', 'adapter', 'dist', 'index.js')
    managedCodexPath = join(storageRoot, 'codex-managed', 'codex', 'bin', 'codex')
    manager = createManager()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await makeTreeWritable(storageRoot)
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('persists successful detection for all three runtime storage shapes', async () => {
    // The injected detector platform is Linux, so keep these virtual inventory paths POSIX on every
    // host. Using the host path helpers makes the Windows keys disagree with the detector probes.
    const claudePath = posix.join('/detected', 'claude')
    const opencodePath = posix.join('/detected', 'opencode')
    inventory.claude.set(claudePath, '2.1.0')
    inventory.opencode.set(opencodePath, '1.19.0')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    manager = createManager({
      detectDeps: { ...createClaudeDeps(inventory), env: { PATH: posix.dirname(claudePath) } },
      opencodeDetectDeps: {
        ...createOpencodeDeps(inventory),
        env: { PATH: posix.dirname(opencodePath) }
      }
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: '2.1.0' },
      opencodePath,
      opencodeVersion: '1.19.0',
      codex: {
        resolvedPath: managedAdapterPath,
        version: '1.6.2',
        nativePath: managedCodexPath,
        nativeVersion: '0.144.6'
      }
    })
  })

  it('keeps the install cancellation signal through successful post-install discovery', async () => {
    const claudePath = '/usr/local/bin/claude'
    const opencodePath = '/usr/local/bin/opencode'
    inventory.claude.set(claudePath, '2.1.0')
    inventory.opencode.set(opencodePath, '1.19.0')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    const claudeDeps = createClaudeDeps(inventory)
    const opencodeDeps = createOpencodeDeps(inventory)
    const codexDeps = createCodexDeps(inventory, managedAdapterPath, managedCodexPath)
    const claudeGetVersion = vi.spyOn(claudeDeps, 'getVersion')
    const opencodeGetVersion = vi.spyOn(opencodeDeps, 'getVersion')
    const codexGetAdapterVersion = vi.spyOn(codexDeps, 'getAdapterVersion')
    runInstallWithFallbackSpy.mockImplementation(async ({ installId }) => ({
      installId,
      ok: true
    }))
    manager = createManager({
      detectDeps: claudeDeps,
      opencodeDetectDeps: opencodeDeps,
      codexDetectDeps: codexDeps
    })

    await manager.installClaude({ source: 'npm' }, vi.fn())
    await manager.installOpencode({ source: 'npm' }, vi.fn())
    await manager.installCodex({ source: 'npm' }, vi.fn())

    expect(claudeGetVersion).toHaveBeenCalledWith(claudePath, expect.any(AbortSignal))
    expect(opencodeGetVersion).toHaveBeenCalledWith(opencodePath, expect.any(AbortSignal))
    expect(codexGetAdapterVersion).toHaveBeenCalledWith(managedAdapterPath, expect.any(AbortSignal))
  })

  it('aborts and drains standalone detection before disposal completes', async () => {
    const claudePath = '/usr/local/bin/claude'
    inventory.claude.set(claudePath, '2.1.0')
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const releaseCleanup = Promise.withResolvers<void>()
    const detectDeps = createClaudeDeps(inventory)
    detectDeps.getVersion = async (_path, signal) => {
      entered.resolve(signal)
      await releaseCleanup.promise
      signal?.throwIfAborted()
      return '2.1.0'
    }
    manager = createManager({ detectDeps })

    const callerAbort = new AbortController()
    const detection = manager.detectClaude(callerAbort.signal)
    const observedSignal = await entered.promise
    let disposeSettled = false
    const disposal = manager.dispose().then(() => {
      disposeSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const waitedForCleanup = !disposeSettled
    releaseCleanup.resolve()
    const detectionOutcome = await detection.then(
      () => 'resolved',
      (error: unknown) => (error as Error).name
    )
    await disposal

    expect(observedSignal?.aborted).toBe(true)
    expect(callerAbort.signal.aborted).toBe(false)
    expect(waitedForCleanup).toBe(true)
    expect(detectionOutcome).toBe('AbortError')
  })

  it.each(['getPreflight', 'checkEnvironment'] as const)(
    'aborts and drains all %s runtime probes before disposal completes',
    async (operation) => {
      const claudePath = join(storageRoot, 'claude')
      const opencodePath = join(storageRoot, 'opencode')
      await repository.setClaudeInfo({ resolvedPath: claudePath, version: 'old' })
      await repository.setOpencodeInfo(opencodePath, 'old')
      const claudeEntered = Promise.withResolvers<AbortSignal | undefined>()
      const opencodeEntered = Promise.withResolvers<AbortSignal | undefined>()
      const releaseClaude = Promise.withResolvers<void>()
      const releaseOpencode = Promise.withResolvers<void>()
      manager = createManager({
        detectDeps: {
          ...createClaudeDeps(inventory),
          getVersion: async (_path, signal) => {
            claudeEntered.resolve(signal)
            await releaseClaude.promise
            signal?.throwIfAborted()
            return '2.1.0'
          }
        },
        opencodeDetectDeps: {
          ...createOpencodeDeps(inventory),
          getVersion: async (_path, signal) => {
            opencodeEntered.resolve(signal)
            await releaseOpencode.promise
            // Even a probe that resolves after cancellation must not publish its result.
            return '1.19.0'
          }
        }
      })
      const providers: ProviderPreflightAccess = {
        resolveProviderApiEndpoints: () => [],
        resolveActiveModel: () => undefined,
        isProviderKeyUsable: async () => false
      }
      const pending =
        operation === 'getPreflight' ? manager.getPreflight(providers) : manager.checkEnvironment()
      const outcome = pending.then(
        () => 'resolved',
        (error: Error) => error.name
      )
      const signals = await Promise.all([claudeEntered.promise, opencodeEntered.promise])
      let disposed = false
      const disposal = manager.dispose().then(() => {
        disposed = true
      })
      releaseClaude.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
      const waitedForSibling = !disposed
      releaseOpencode.resolve()
      await disposal

      expect(signals.map((signal) => signal?.aborted)).toEqual([true, true])
      expect(waitedForSibling).toBe(true)
      expect(await outcome).toBe('AbortError')
      expect(await repository.getSettings()).toMatchObject({
        claude: { version: 'old' },
        opencodeVersion: 'old'
      })
      await expect(
        operation === 'getPreflight' ? manager.getPreflight(providers) : manager.checkEnvironment()
      ).rejects.toMatchObject({ name: 'AbortError' })
    }
  )

  it('propagates failed installation cleanup through disposal', async () => {
    const entered = Promise.withResolvers<void>()
    const cleanupFailure = new Error('Installer cleanup was not confirmed')
    runInstallWithFallbackSpy.mockImplementation(
      ({ signal, installId, onCleanupFailure }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              onCleanupFailure?.(cleanupFailure)
              resolve({ installId, ok: false, error: 'Installation cancelled.' })
            },
            { once: true }
          )
          entered.resolve()
        })
    )
    const install = manager.installClaude({ source: 'npm' }, vi.fn())
    await entered.promise
    await expect(manager.dispose()).rejects.toBe(cleanupFailure)
    await expect(install).resolves.toMatchObject({ ok: false })
  })

  it('rejects new detection and install work after disposal starts', async () => {
    await manager.dispose()

    await expect(manager.detectClaude(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    await expect(manager.installClaude({ source: 'managed' }, vi.fn())).resolves.toMatchObject({
      ok: false,
      error: 'Settings service is shutting down.'
    })
  })

  it('cancels the default Codex JavaScript adapter version probe promptly', async () => {
    await mkdir(dirname(managedAdapterPath), { recursive: true })
    await writeFile(managedAdapterPath, 'setTimeout(() => {}, 1000)\n')
    inventory.opencode.set(managedAdapterPath, 'unused')
    manager = createManager({ codexDetectDeps: undefined })
    const controller = new AbortController()
    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 25)

    await expect(manager.detectCodex(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(Date.now() - startedAt).toBeLessThan(750)
  })

  it('rejects and clears a cached CodeBuddy runtime outside the pinned version', async () => {
    const codebuddyPath = posix.join('/detected', 'codebuddy')
    await repository.setCodeBuddyInfo(codebuddyPath, '2.139.0')
    await repository.setAgentFramework('codebuddy')
    manager = createManager({
      codebuddyDetectDeps: {
        env: { PATH: posix.dirname(codebuddyPath) },
        homePath: '/home',
        platform: 'linux',
        isExecutable: (candidate) => Promise.resolve(candidate === codebuddyPath),
        getVersion: () => Promise.resolve('2.139.0'),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    await expect(manager.checkEnvironment()).resolves.toMatchObject({
      agentFrameworkId: 'codebuddy',
      runtime: { found: false }
    })
    const updated = await repository.getSettings()
    expect(updated.codebuddyPath).toBeUndefined()
    expect(updated.codebuddyVersion).toBeUndefined()
  })

  it('revalidates a saved CodeBuddy executable before launching it', async () => {
    const savedPath = join(storageRoot, 'saved', 'codebuddy')
    await mkdir(dirname(savedPath), { recursive: true })
    await writeFile(savedPath, '#!/bin/sh\n')
    await chmod(savedPath, 0o755)
    const getVersion = vi.fn(async (candidate: string) =>
      candidate === savedPath ? '2.139.0' : undefined
    )
    manager = createManager({
      codebuddyDetectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        isExecutable: async () => false,
        getVersion,
        resolveNpmBinDirs: async () => []
      }
    })

    await expect(manager.resolveCodeBuddyExecutable(savedPath)).rejects.toThrow(
      'CodeBuddy executable not found'
    )
    expect(getVersion).toHaveBeenCalledWith(savedPath)
  })

  it('preserves cached runtime records when live detection misses but their paths still exist', async () => {
    const claudePath = join(storageRoot, 'cached', 'claude')
    const opencodePath = join(storageRoot, 'cached', 'opencode')
    await mkdir(dirname(claudePath), { recursive: true })
    for (const path of [claudePath, opencodePath, managedAdapterPath]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '#!/bin/sh\n')
      await chmod(path, 0o755)
    }
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: 'cached-claude' })
    await repository.setOpencodeInfo(opencodePath, 'cached-opencode')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: 'cached-adapter',
      nativePath: managedCodexPath,
      nativeVersion: 'cached-native'
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: 'cached-claude' },
      opencodePath,
      opencodeVersion: 'cached-opencode',
      codex: { resolvedPath: managedAdapterPath, version: 'cached-adapter' }
    })
  })

  it('computes selected-runtime preflight through the narrow provider access interface', async () => {
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    inventory.opencode.set(opencodePath, '1.19.0')
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setAgentFramework('opencode')
    await repository.upsertProvider({
      id: 'provider-a',
      type: 'custom',
      name: 'Provider A',
      model: 'stored-model',
      apiEndpoints: ['openai'],
      keyRef: 'encrypted-key',
      lastValidatedAt: 10
    })
    await repository.setActiveProvider('provider-a', 'model-a')
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(['openai']),
      resolveActiveModel: vi.fn().mockReturnValue('model-a'),
      isProviderKeyUsable: vi.fn().mockResolvedValue(true)
    }

    const result = await manager.getPreflight(providers)
    const storedProvider = (await repository.getSettings()).providers[0]

    expect(result).toMatchObject({
      agentFrameworkId: 'opencode',
      opencodeReady: true,
      activeProviderReady: true,
      agentReady: true
    })
    expect(providers.resolveProviderApiEndpoints).toHaveBeenCalledWith(storedProvider, 'model-a')
    expect(providers.isProviderKeyUsable).toHaveBeenCalledWith(storedProvider)
  })

  it('fails Codex preflight when the installed ACP adapter is below the supported version', async () => {
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    await expect(manager.getPreflight(providers)).resolves.toMatchObject({
      codexReady: false,
      agentReady: false
    })
  })

  it('refuses to launch an installed Codex ACP adapter below the supported version', async () => {
    await mkdir(dirname(managedAdapterPath), { recursive: true })
    await writeFile(managedAdapterPath, '#!/usr/bin/env node\n')
    await chmod(managedAdapterPath, 0o755)
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')

    await expect(
      manager.resolveCodexExecutable(managedAdapterPath, managedCodexPath)
    ).rejects.toThrow(
      'Codex ACP adapter 1.1.4 is no longer supported. Update to 1.6.2 or later in settings.'
    )
  })

  it('avoids a third configured-runtime probe pass across the startup inspection chain', async () => {
    const claudePath = join(storageRoot, 'bin', 'claude')
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    inventory.claude.set(claudePath, '2.1.0')
    inventory.opencode.set(opencodePath, '1.19.0')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: '2.1.0' })
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.6.2',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })

    const claudeDeps = createClaudeDeps(inventory)
    const opencodeDeps = createOpencodeDeps(inventory)
    const codexDeps = createCodexDeps(inventory, managedAdapterPath, managedCodexPath)
    const getClaudeVersion = vi.fn(claudeDeps.getVersion)
    const getOpencodeVersion = vi.fn(opencodeDeps.getVersion)
    const getAdapterVersion = vi.fn(codexDeps.getAdapterVersion)
    const getCodexVersion = vi.fn(codexDeps.getCodexVersion)
    manager = createManager({
      detectDeps: { ...claudeDeps, getVersion: getClaudeVersion },
      opencodeDetectDeps: { ...opencodeDeps, getVersion: getOpencodeVersion },
      codexDetectDeps: { ...codexDeps, getAdapterVersion, getCodexVersion }
    })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    await manager.getPreflight(providers)
    await manager.checkEnvironment()
    const refreshed = await manager.getPreflight(providers)

    expect(refreshed).toMatchObject({
      claudeReady: true,
      opencodeReady: true,
      codexReady: true
    })
    expect(
      getClaudeVersion.mock.calls.filter(([path]) => path === claudePath).length
    ).toBeLessThanOrEqual(2)
    expect(
      getOpencodeVersion.mock.calls.filter(([path]) => path === opencodePath).length
    ).toBeLessThanOrEqual(2)
    expect(
      getAdapterVersion.mock.calls.filter(([path]) => path === managedAdapterPath).length
    ).toBeLessThanOrEqual(2)
    expect(
      getCodexVersion.mock.calls.filter(([path]) => path === managedCodexPath).length
    ).toBeLessThanOrEqual(2)
  })

  it('probes again for an independent Preflight call after an external runtime change', async () => {
    const claudePath = join(storageRoot, 'bin', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: '2.1.0' })
    const claudeDeps = createClaudeDeps(inventory)
    const getVersion = vi.fn(claudeDeps.getVersion)
    manager = createManager({ detectDeps: { ...claudeDeps, getVersion } })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    await manager.getPreflight(providers)
    inventory.claude.set(claudePath, undefined)
    const refreshed = await manager.getPreflight(providers)

    expect(refreshed.claudeReady).toBe(false)
    expect(getVersion).toHaveBeenCalledTimes(2)
  })

  it('projects a newly detected runtime without a third version subprocess', async () => {
    const claudePath = posix.join('/detected', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    const claudeDeps = createClaudeDeps(inventory)
    const getVersion = vi.fn(claudeDeps.getVersion)
    manager = createManager({
      detectDeps: {
        ...claudeDeps,
        env: { PATH: posix.dirname(claudePath) },
        getVersion
      }
    })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    expect((await manager.getPreflight(providers)).claudeReady).toBe(false)
    await manager.checkEnvironment()
    const refreshed = await manager.getPreflight(providers)

    expect(refreshed.claudeReady).toBe(true)
    expect(
      getVersion.mock.calls.filter(([path]) => path === claudePath).length
    ).toBeLessThanOrEqual(2)
  })

  it('reuses a failed configured-runtime probe across the startup chain', async () => {
    const claudePath = join(storageRoot, 'broken', 'claude')
    await mkdir(dirname(claudePath), { recursive: true })
    await writeFile(claudePath, '#!/bin/sh\n')
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: 'stale' })
    const claudeDeps = createClaudeDeps(inventory)
    const getVersion = vi.fn(claudeDeps.getVersion)
    manager = createManager({ detectDeps: { ...claudeDeps, getVersion } })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    expect((await manager.getPreflight(providers)).claudeReady).toBe(false)
    await manager.checkEnvironment()
    expect((await manager.getPreflight(providers)).claudeReady).toBe(false)

    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it('reuses partial Codex probes through fallback detection and component diagnostics', async () => {
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: 'stale-adapter',
      nativePath: managedCodexPath,
      nativeVersion: 'stale-native'
    })
    const codexDeps = createCodexDeps(inventory, managedAdapterPath, managedCodexPath)
    const getAdapterVersion = vi.fn(codexDeps.getAdapterVersion)
    const getCodexVersion = vi.fn(codexDeps.getCodexVersion)
    const smokeInitialize = vi.fn(codexDeps.smokeInitialize)
    manager = createManager({
      codexDetectDeps: { ...codexDeps, getAdapterVersion, getCodexVersion, smokeInitialize }
    })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(undefined),
      resolveActiveModel: vi.fn().mockReturnValue(undefined),
      isProviderKeyUsable: vi.fn().mockResolvedValue(false)
    }

    expect((await manager.getPreflight(providers)).codexReady).toBe(false)
    await manager.checkEnvironment()
    expect((await manager.getPreflight(providers)).codexReady).toBe(false)

    expect(
      getAdapterVersion.mock.calls.filter(([path]) => path === managedAdapterPath)
    ).toHaveLength(1)
    expect(getCodexVersion.mock.calls.filter(([path]) => path === managedCodexPath)).toHaveLength(1)
    expect(smokeInitialize).toHaveBeenCalledTimes(1)
  })

  it('uses the shared allocator and forwards the same event sink through managed installs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const allocateSettingsIdSequence = vi
      .fn<() => number>()
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(13)
      .mockReturnValueOnce(14)
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'claude\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'claude'),
          version: '2.1.0'
        }
      }
    )
    const installManagedOpencodeImpl: NonNullable<ManagerOptions['installManagedOpencodeImpl']> =
      vi.fn(async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'opencode\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'opencode'),
          version: '1.19.0'
        }
      })
    const installManagedCodexImpl: NonNullable<ManagerOptions['installManagedCodexImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'codex\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          adapterPath: managedAdapterPath,
          adapterVersion: '1.6.2',
          codexPath: managedCodexPath,
          codexVersion: '0.144.6'
        }
      }
    )
    const installManagedCodeBuddyImpl: NonNullable<ManagerOptions['installManagedCodeBuddyImpl']> =
      vi.fn(async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'codebuddy\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'codebuddy'),
          version: '2.138.0'
        }
      })
    const claudePath = join(storageRoot, 'installed', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    manager = createManager({
      allocateSettingsIdSequence,
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodeBuddyImpl,
      installManagedCodexImpl
    })

    const results = [
      await manager.installClaude({ source: 'managed' }, onEvent),
      await manager.installOpencode({ source: 'managed' }, onEvent),
      await manager.installCodeBuddy({ source: 'managed' }, onEvent),
      await manager.installCodex({ source: 'managed' }, onEvent)
    ]

    expect(results.map((result) => result.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codebuddy-123-13',
      'install-codex-123-14'
    ])
    expect(allocateSettingsIdSequence).toHaveBeenCalledTimes(4)
    for (const installer of [
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodeBuddyImpl,
      installManagedCodexImpl
    ]) {
      expect(installer).toHaveBeenCalledWith(expect.objectContaining({ onEvent }))
    }
    expect(onEvent.mock.calls.map(([event]) => event.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codebuddy-123-13',
      'install-codex-123-14'
    ])
  })

  it('rejects a second managed runtime install until the active install finishes', async () => {
    const installStarted = Promise.withResolvers<void>()
    const releaseInstall = Promise.withResolvers<void>()
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async ({ installId }) => {
        installStarted.resolve()
        await releaseInstall.promise
        return { result: { installId, ok: false, error: 'first install stopped' } }
      }
    )
    const installManagedOpencodeImpl: NonNullable<ManagerOptions['installManagedOpencodeImpl']> =
      vi.fn(async ({ installId }) => ({
        result: { installId, ok: false, error: 'second installer was invoked' }
      }))
    manager = createManager({ installManagedClaudeImpl, installManagedOpencodeImpl })

    const firstInstall = manager.installClaude({ source: 'managed' }, vi.fn())
    await installStarted.promise

    try {
      await expect(manager.installOpencode({ source: 'managed' }, vi.fn())).resolves.toMatchObject({
        ok: false,
        error: 'Another install is already in progress.'
      })
      expect(installManagedOpencodeImpl).not.toHaveBeenCalled()
    } finally {
      releaseInstall.resolve()
      await firstInstall
    }

    await expect(manager.installOpencode({ source: 'managed' }, vi.fn())).resolves.toMatchObject({
      ok: false,
      error: 'second installer was invoked'
    })
    expect(installManagedOpencodeImpl).toHaveBeenCalledOnce()
  })

  it('rejects managed runtime installs while update handoff holds admission', async () => {
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async ({ installId }) => ({
        result: { installId, ok: false, error: 'installer was invoked' }
      })
    )
    manager = createManager({ installManagedClaudeImpl })
    const releaseAdmission = manager.holdInstallAdmission()

    try {
      await expect(manager.installClaude({ source: 'managed' }, vi.fn())).resolves.toMatchObject({
        ok: false,
        error: 'Another install is already in progress.'
      })
      expect(installManagedClaudeImpl).not.toHaveBeenCalled()
    } finally {
      releaseAdmission()
    }

    await manager.installClaude({ source: 'managed' }, vi.fn())
    expect(installManagedClaudeImpl).toHaveBeenCalledOnce()
  })

  it('keeps admission closed until every overlapping handoff releases it', async () => {
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async ({ installId }) => ({
        result: { installId, ok: false, error: 'installer was invoked' }
      })
    )
    manager = createManager({ installManagedClaudeImpl })
    const releaseUpdate = manager.holdInstallAdmission()
    const releaseDataRoot = manager.holdInstallAdmission()

    releaseUpdate()
    await expect(manager.installClaude({ source: 'managed' }, vi.fn())).resolves.toMatchObject({
      ok: false,
      error: 'Another install is already in progress.'
    })
    expect(installManagedClaudeImpl).not.toHaveBeenCalled()

    releaseDataRoot()
    await manager.installClaude({ source: 'managed' }, vi.fn())
    expect(installManagedClaudeImpl).toHaveBeenCalledOnce()
  })

  it('keeps managed CodeBuddy installs behind the shared install lock', async () => {
    const installStarted = Promise.withResolvers<void>()
    const releaseInstall = Promise.withResolvers<void>()
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async ({ installId }) => {
        installStarted.resolve()
        await releaseInstall.promise
        return { result: { installId, ok: false, error: 'first install stopped' } }
      }
    )
    const installManagedCodeBuddyImpl: NonNullable<ManagerOptions['installManagedCodeBuddyImpl']> =
      vi.fn(async ({ installId }) => ({
        result: { installId, ok: false, error: 'second installer was invoked' }
      }))
    manager = createManager({ installManagedClaudeImpl, installManagedCodeBuddyImpl })

    const firstInstall = manager.installClaude({ source: 'managed' }, vi.fn())
    await installStarted.promise

    try {
      await expect(manager.installCodeBuddy({ source: 'managed' }, vi.fn())).resolves.toMatchObject(
        {
          ok: false,
          error: 'Another install is already in progress.'
        }
      )
      expect(installManagedCodeBuddyImpl).not.toHaveBeenCalled()
    } finally {
      releaseInstall.resolve()
      await firstInstall
    }
  })

  it('verifies a managed Windows CodeBuddy shim through the command shell', async () => {
    const run = vi.fn(async () => ({ stdout: '2.138.0\n' }))
    const binPath = 'C:\\Open Science\\codebuddy.cmd'

    await expect(verifyCodeBuddyVersion(binPath, 'win32', run)).resolves.toBe('2.138.0')
    expect(run).toHaveBeenCalledWith(`"${binPath}"`, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      shell: true
    })
  })

  it('updates only the managed adapter when Codex CLI is user-owned', async () => {
    const externalCodexPath = join(storageRoot, 'user-bin', 'codex')
    inventory.codexNative.set(externalCodexPath, 'codex-cli 0.144.6')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: externalCodexPath,
      nativeVersion: '0.144.6'
    })
    const installManagedCodexImpl: NonNullable<ManagerOptions['installManagedCodexImpl']> = vi.fn(
      async ({ installId }) => ({
        result: { installId, ok: true },
        adapterPath: managedAdapterPath,
        adapterVersion: '1.6.2',
        codexPath: externalCodexPath,
        codexVersion: '0.144.6'
      })
    )
    manager = createManager({ installManagedCodexImpl })

    await manager.installCodex({ source: 'managed' }, vi.fn())

    expect(installManagedCodexImpl).toHaveBeenCalledWith(
      expect.objectContaining({ existingCodexPath: externalCodexPath })
    )
    expect((await repository.getSettings()).codex).toMatchObject({
      resolvedPath: managedAdapterPath,
      version: '1.6.2',
      nativePath: externalCodexPath,
      nativeVersion: '0.144.6'
    })
  })

  it('falls back to the managed Codex CLI when the stored user-owned path is stale', async () => {
    const staleCodexPath = join(storageRoot, 'missing-user-bin', 'codex')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: staleCodexPath,
      nativeVersion: '0.144.6'
    })
    const installManagedCodexImpl: NonNullable<ManagerOptions['installManagedCodexImpl']> = vi.fn(
      async ({ installId }) => ({
        result: { installId, ok: true },
        adapterPath: managedAdapterPath,
        adapterVersion: '1.6.2',
        codexPath: managedCodexPath,
        codexVersion: '0.144.6'
      })
    )
    manager = createManager({ installManagedCodexImpl })

    await manager.installCodex({ source: 'managed' }, vi.fn())

    expect(installManagedCodexImpl).toHaveBeenCalledWith(
      expect.not.objectContaining({ existingCodexPath: expect.anything() })
    )
    expect((await repository.getSettings()).codex).toMatchObject({
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
  })

  it('preserves a managed Claude runtime when the replacement cannot report a version', async () => {
    const existingPath = join(managedClaudeDir(storageRoot), 'claude')
    await mkdir(dirname(existingPath), { recursive: true })
    await writeFile(existingPath, 'WORKING-CLAUDE')
    await repository.setClaudeInfo({ resolvedPath: existingPath, version: '2.1.208' })
    const replacement = Buffer.from('BROKEN-CLAUDE')
    const tgz = buildManagedClaudeTgz(replacement)
    const detectDeps = createClaudeDeps(inventory)
    detectDeps.getVersion = async (path) =>
      (await readFile(path, 'utf8')) === 'WORKING-CLAUDE' ? '2.1.208' : undefined
    manager = createManager({
      detectDeps,
      installManagedClaudeImpl: (options) =>
        installManagedClaude({
          ...options,
          registries: ['https://reg'],
          platform: {
            key: 'linux-x64',
            pkg: '@anthropic-ai/claude-code-linux-x64',
            binName: 'claude'
          },
          fetchJson: async (url) =>
            url.endsWith('claude-code-linux-x64/2.1.209')
              ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
              : { 'dist-tags': { latest: '2.1.209' } },
          fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length })
        })
    })

    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    await expect(manager.installClaude({ source: 'managed' }, onEvent)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('could not report its version')
    })
    expect(await readFile(existingPath, 'utf8')).toBe('WORKING-CLAUDE')
    expect((await repository.getSettings()).claude).toEqual({
      resolvedPath: existingPath,
      version: '2.1.208'
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'log',
        stream: 'system',
        chunk: expect.stringContaining('could not report its version')
      })
    )
  })

  it('guards unmanaged uninstall and selects the first actually runnable fallback', async () => {
    const unmanagedClaude = join(storageRoot, 'external', 'claude')
    await repository.setClaudeInfo({ resolvedPath: unmanagedClaude, version: '2.1.0' })

    await expect(manager.uninstallClaude()).resolves.toEqual({ activeBackendAffected: false })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(unmanagedClaude)

    const opencodePath = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '#!/bin/sh\n')
    await chmod(opencodePath, 0o755)
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.6.2',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    // The stored Claude path exists as a candidate but cannot report a version, so it is not ready.
    inventory.claude.set(unmanagedClaude, undefined)

    await expect(manager.uninstallOpencode()).resolves.toEqual({ activeBackendAffected: true })

    expect(await repository.getSettings()).toMatchObject({
      agentFrameworkId: 'codex',
      claude: { resolvedPath: unmanagedClaude },
      codex: { resolvedPath: managedAdapterPath }
    })
    expect((await repository.getSettings()).opencodePath).toBeUndefined()
  })

  it('does not select an unsupported Codex adapter after uninstalling the active runtime', async () => {
    const opencodePath = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '#!/bin/sh\n')
    await chmod(opencodePath, 0o755)
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')

    await manager.uninstallOpencode()

    expect((await repository.getSettings()).agentFrameworkId).toBe('opencode')
  })

  it('does not select Codex after uninstalling the active runtime when its native CLI is unusable', async () => {
    const opencodePath = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '#!/bin/sh\n')
    await chmod(opencodePath, 0o755)
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.6.2',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.6.2')

    await manager.uninstallOpencode()

    expect((await repository.getSettings()).agentFrameworkId).toBe('opencode')
  })

  it('mounts the Skill projection for shared, isolated, and custom Claude probes', async () => {
    const executeClaudeProbe = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ executeClaudeProbe })
    const executablePath = join(storageRoot, 'bin', 'claude')
    await repository.setClaudeInfo({ resolvedPath: executablePath, version: '2.1.0' })
    const settings = await repository.getSettings()
    const configDir = getAppClaudeConfigDir(storageRoot)
    const projectionRoot = join(
      storageRoot,
      'runtime-support',
      'agent-skills',
      'claude',
      'v1',
      'revision-1'
    )
    const provisionRuntime = vi.spyOn(manager, 'provisionClaudeRuntimeConfig').mockResolvedValue({
      privateProfileDir: configDir,
      settingsPath: join(configDir, 'settings.json'),
      privateSettings: {},
      skillProjection: { root: projectionRoot, revision: 'revision-1' }
    })

    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-shared', model: 'claude-sonnet' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })
    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-isolated', model: 'claude-sonnet', key: 'setup-token' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })
    await expect(
      manager.runClaudeSubscriptionProbe(
        {
          type: 'custom',
          model: 'custom-model',
          baseUrl: 'https://gateway.example/v1',
          key: 'api-key'
        },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })

    expect(provisionRuntime).toHaveBeenCalledTimes(3)
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      1,
      executablePath,
      expect.objectContaining({ CLAUDE_CONFIG_DIR: join(storageRoot, 'user-claude') }),
      ['--settings', join(configDir, 'settings.json'), '--add-dir', projectionRoot]
    )
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      2,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token'
      }),
      ['--add-dir', projectionRoot]
    )
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      3,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        ANTHROPIC_AUTH_TOKEN: 'api-key'
      }),
      ['--add-dir', projectionRoot]
    )
  })

  it('synchronizes provisioned custom Connector docs into isolated agent Skill roots', async () => {
    const customSkillName = 'mcp-xt'
    const sourceDir = join(connectorSkillSourceDir(storageRoot), customSkillName)
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n',
      'utf8'
    )
    let materialized = [customSkillName]
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn(() => materialized)
    } as unknown as ConnectorSettingsModule
    manager = createManager({ connectors })
    const agentRoot = join(storageRoot, 'isolated-agent')
    const targetFile = join(agentRoot, 'skills', customSkillName, 'SKILL.md')

    await expect(
      manager.materializeAgentSkills(await repository.getSettings(), agentRoot, new Set())
    ).resolves.toEqual([customSkillName])
    await expect(readFile(targetFile, 'utf8')).resolves.toContain('Use XT records.')

    materialized = []
    await expect(
      manager.materializeAgentSkills(await repository.getSettings(), agentRoot, new Set())
    ).resolves.toEqual([])
    await expect(readFile(targetFile, 'utf8')).rejects.toThrow()
  })

  it.each([
    {
      name: 'timeout',
      error: Object.assign(new Error('timed out'), { killed: true }),
      result: {
        ok: false,
        category: 'timeout',
        message: 'Claude token validation timed out. Try again.'
      }
    },
    {
      name: 'authentication rejection',
      error: Object.assign(new Error('request failed'), { stderr: 'HTTP 401 unauthorized' }),
      result: {
        ok: false,
        category: 'auth',
        message:
          'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.'
      }
    },
    {
      name: 'network failure',
      error: Object.assign(new Error('fetch failed'), { code: 'ENETUNREACH' }),
      result: {
        ok: false,
        category: 'network',
        message:
          'Claude could not reach Anthropic while validating the token. Check your network and try again.'
      }
    }
  ])(
    'classifies an isolated Claude $name without mutating provider state',
    async ({ error, result }) => {
      manager = createManager({ executeClaudeProbe: vi.fn().mockRejectedValue(error) })
      const configDir = getAppClaudeConfigDir(storageRoot)
      vi.spyOn(manager, 'provisionClaudeRuntimeConfig').mockResolvedValue({
        privateProfileDir: configDir,
        settingsPath: join(configDir, 'settings.json'),
        privateSettings: {},
        skillProjection: {
          root: join(storageRoot, 'runtime-support', 'agent-skills', 'claude', 'v1', 'revision-1'),
          revision: 'revision-1'
        }
      })
      await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

      await expect(
        manager.runClaudeSubscriptionProbe(
          { type: 'claude-isolated', key: 'setup-token' },
          await repository.getSettings()
        )
      ).resolves.toEqual(result)
      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('uses the managed Claude directory shape expected by the uninstall ownership guard', () => {
    expect(
      manager.isManagedRuntimePath('claude-code', join(managedClaudeDir(storageRoot), 'claude'))
    ).toBe(true)
    expect(
      manager.isManagedRuntimePath('claude-code', join(storageRoot, 'external', 'claude'))
    ).toBe(false)
  })

  it('uses the managed CodeBuddy directory shape expected by the uninstall ownership guard', () => {
    expect(
      manager.isManagedRuntimePath('codebuddy', join(managedCodeBuddyDir(storageRoot), 'codebuddy'))
    ).toBe(true)
    expect(
      manager.isManagedRuntimePath('codebuddy', join(storageRoot, 'external', 'codebuddy'))
    ).toBe(false)
  })

  it('owns materialization of framework-generated runtime config files', async () => {
    const configPath = join(storageRoot, 'runtime-config', 'agent.json')

    await manager.materializeAgentConfigFiles([
      { path: configPath, content: '{"runtime":"managed"}\n' }
    ])

    await expect(readFile(configPath, 'utf8')).resolves.toBe('{"runtime":"managed"}\n')
  })
})
