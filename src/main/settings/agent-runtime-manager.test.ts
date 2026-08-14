import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import type { ComputeHost } from '../../shared/compute'
import type { ConnectorSettingsModule } from './connector-settings'
import type { ClaudeDetectDeps } from './claude-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { ExecuteClaudeProbe, ProviderPreflightAccess } from './agent-runtime-manager'
import type { SkillCatalogModule } from './skill-catalog'
import { connectorSkillSourceRoot } from '../connectors/skill-source'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/no-such-app-root', isPackaged: false }
}))

const { AgentRuntimeManager } = await import('./agent-runtime-manager')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { parseFrontmatter } = await import('../skills/frontmatter')

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

const makeTreeWritable = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeTreeWritable(join(directory, entry.name))
  }
  await chmod(directory, 0o755).catch(() => undefined)
}

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
  let provisionClaudeConfig: ReturnType<typeof vi.fn>
  let manager: InstanceType<typeof AgentRuntimeManager>

  const createManager = (
    overrides: Partial<ManagerOptions> = {}
  ): InstanceType<typeof AgentRuntimeManager> => {
    provisionClaudeConfig = vi.fn().mockResolvedValue(undefined)
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig,
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([])
    } as unknown as SkillCatalogModule
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule

    return new AgentRuntimeManager({
      repository,
      storageRoot,
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
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      resolveCodexProxyEnvironment: () => Promise.resolve(undefined),
      ...overrides
    })
  }

  beforeEach(async () => {
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
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
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
        version: '1.1.4',
        nativePath: managedCodexPath,
        nativeVersion: '0.144.6'
      }
    })
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
      model: 'model-a',
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

  it('uses the shared allocator and forwards the same event sink through managed installs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const allocateSettingsIdSequence = vi
      .fn<() => number>()
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(13)
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
          adapterVersion: '1.1.4',
          codexPath: managedCodexPath,
          codexVersion: '0.144.6'
        }
      }
    )
    const claudePath = join(storageRoot, 'installed', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    manager = createManager({
      allocateSettingsIdSequence,
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    })

    const results = await Promise.all([
      manager.installClaude({ source: 'managed' }, onEvent),
      manager.installOpencode({ source: 'managed' }, onEvent),
      manager.installCodex({ source: 'managed' }, onEvent)
    ])

    expect(results.map((result) => result.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
    expect(allocateSettingsIdSequence).toHaveBeenCalledTimes(3)
    for (const installer of [
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    ]) {
      expect(installer).toHaveBeenCalledWith(expect.objectContaining({ onEvent }))
    }
    expect(onEvent.mock.calls.map(([event]) => event.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
  })

  it('fails a managed Claude install whose installed executable cannot report a version', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(321)
    const installedPath = join(storageRoot, 'installed', 'claude')
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    manager = createManager({
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: installedPath,
        version: 'claimed-version'
      })
    })

    const result = await manager.installClaude({ source: 'managed' }, onEvent)

    expect(result).toEqual({
      installId: 'install-321-1',
      ok: false,
      error:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
    })
    expect((await repository.getSettings()).claude).toBeUndefined()
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'log',
      installId: 'install-321-1',
      stream: 'system',
      chunk:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.\n'
    })
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
      version: '1.1.4',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
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

  it('validates shared and isolated Claude auth without materializing or loading legacy Skills', async () => {
    let isolatedProbeConfigDir: string | undefined
    const executeClaudeProbe = vi.fn<ExecuteClaudeProbe>(async (_executablePath, env) => {
      if (!env.CLAUDE_CODE_OAUTH_TOKEN) return
      isolatedProbeConfigDir = env.CLAUDE_CONFIG_DIR
      expect(isolatedProbeConfigDir).toBeTruthy()
      await expect(lstat(isolatedProbeConfigDir!)).resolves.toMatchObject({})
      await expect(readFile(join(isolatedProbeConfigDir!, 'settings.json'), 'utf8')).resolves.toBe(
        '{"disableBundledSkills":true}\n'
      )
      await expect(readdir(join(isolatedProbeConfigDir!, 'skills'))).resolves.toEqual([])
    })
    const syncComputeSkillDocument = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ executeClaudeProbe, syncComputeSkillDocument })
    provisionClaudeConfig.mockImplementation(async (configDir) => {
      await mkdir(join(configDir, 'skills'), { recursive: true })
      await writeFile(join(configDir, 'settings.json'), '{"disableBundledSkills":true}\n')
    })
    const executablePath = join(storageRoot, 'bin', 'claude')
    await repository.setClaudeInfo({ resolvedPath: executablePath, version: '2.1.0' })
    const settings = await repository.getSettings()
    const stableConfigDir = getAppClaudeConfigDir(storageRoot)
    const legacySkillDocument = join(stableConfigDir, 'skills', 'legacy', 'SKILL.md')
    await mkdir(dirname(legacySkillDocument), { recursive: true })
    await writeFile(legacySkillDocument, 'legacy rollback skill')

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

    expect(provisionClaudeConfig).toHaveBeenCalledTimes(2)
    expect(provisionClaudeConfig).toHaveBeenNthCalledWith(1, stableConfigDir, [], undefined, false)
    expect(provisionClaudeConfig).toHaveBeenNthCalledWith(
      2,
      isolatedProbeConfigDir,
      [],
      undefined,
      false
    )
    expect(
      isolatedProbeConfigDir?.startsWith(
        join(storageRoot, 'runtime', 'claude-probes', 'v1', 'probe-')
      )
    ).toBe(true)
    expect(isolatedProbeConfigDir).not.toBe(stableConfigDir)
    expect(syncComputeSkillDocument).not.toHaveBeenCalled()
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      1,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: join(storageRoot, 'user-claude'),
        ANTHROPIC_MODEL: 'claude-sonnet'
      }),
      ['--settings', join(stableConfigDir, 'settings.json')]
    )
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      2,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: isolatedProbeConfigDir,
        ANTHROPIC_MODEL: 'claude-sonnet',
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token'
      })
    )
    expect(executeClaudeProbe.mock.calls.flatMap(([, , args]) => args ?? [])).not.toContain(
      '--plugin-dir'
    )
    await expect(readFile(legacySkillDocument, 'utf8')).resolves.toBe('legacy rollback skill')
    await expect(lstat(isolatedProbeConfigDir!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the disposable isolated Claude probe config after validation failure', async () => {
    let isolatedProbeConfigDir: string | undefined
    const error = Object.assign(new Error('request failed'), { stderr: 'HTTP 401 unauthorized' })
    const executeClaudeProbe = vi.fn(async (_executablePath, env) => {
      isolatedProbeConfigDir = env.CLAUDE_CONFIG_DIR
      await expect(lstat(isolatedProbeConfigDir!)).resolves.toMatchObject({})
      throw error
    })
    manager = createManager({ executeClaudeProbe })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-isolated', key: 'setup-token' },
        await repository.getSettings()
      )
    ).resolves.toEqual({
      ok: false,
      category: 'auth',
      message:
        'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.'
    })

    expect(isolatedProbeConfigDir).toBeTruthy()
    expect(isolatedProbeConfigDir).not.toBe(getAppClaudeConfigDir(storageRoot))
    await expect(lstat(isolatedProbeConfigDir!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('synchronizes the Compute host projection after each Skill provisioning path', async () => {
    const syncComputeSkillDocument = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ syncComputeSkillDocument })
    const settings = await repository.getSettings()
    const agentRoot = join(storageRoot, 'codex')

    await manager.materializeAgentSkills(settings, agentRoot, new Set())
    await manager.provisionClaudeRuntimeConfig(settings)

    expect(syncComputeSkillDocument).toHaveBeenCalledWith(join(agentRoot, 'skills'))
    expect(syncComputeSkillDocument).toHaveBeenCalledWith(
      join(getAppClaudeConfigDir(storageRoot), 'skills')
    )
  })

  it('preserves the legacy Claude Skill catalog when provisioning a new runtime session', async () => {
    const syncComputeSkillDocument = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ syncComputeSkillDocument })
    const settings = await repository.getSettings()

    await manager.provisionClaudeRuntimeConfig(settings, new Set(), null, false)

    expect(provisionClaudeConfig).toHaveBeenCalledWith(
      getAppClaudeConfigDir(storageRoot),
      [],
      null,
      false
    )
    expect(syncComputeSkillDocument).not.toHaveBeenCalled()
  })

  it('enumerates only current direct-child legacy Skill documents in stable order', async () => {
    manager = createManager()
    const configRoot = join(storageRoot, 'codex')
    await mkdir(join(configRoot, 'skills', 'z-skill'), { recursive: true })
    await mkdir(join(configRoot, 'skills', 'a-skill'), { recursive: true })
    await mkdir(join(configRoot, 'skills', 'missing-document'), { recursive: true })
    await writeFile(join(configRoot, 'skills', 'z-skill', 'SKILL.md'), 'z')
    await writeFile(join(configRoot, 'skills', 'a-skill', 'SKILL.md'), 'a')

    await expect(manager.listLegacyAgentSkillDocumentPaths(configRoot)).resolves.toEqual([
      join(configRoot, 'skills', 'a-skill', 'SKILL.md'),
      join(configRoot, 'skills', 'z-skill', 'SKILL.md')
    ])
  })

  it('acquires an agent-facing runtime lease without changing the legacy Skill projection', async () => {
    const sourceRoot = join(storageRoot, 'skill-source')
    const legacyRoot = join(storageRoot, 'claude', 'skills')
    await mkdir(sourceRoot, { recursive: true })
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(
      join(sourceRoot, 'SKILL.md'),
      '---\nname: demo\ndescription: Demo Skill.\n---\n\nUse demo.\n'
    )
    const legacySentinel = join(legacyRoot, 'legacy.txt')
    await writeFile(legacySentinel, 'legacy')
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'demo',
          name: 'demo',
          displayName: 'Demo',
          description: 'Demo Skill.',
          source: 'featured',
          updatedAt: '2026-08-14T00:00:00.000Z',
          compatibility: 'sha256:demo-v1',
          sourceDir: sourceRoot
        }
      ])
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })

    const settings = await repository.getSettings()
    settings.disabledSkillIds = ['demo']
    const lease = await manager.acquireAgentSkillRuntime(settings, {
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      forcedSkillIds: ['demo']
    })

    expect(lease.skills.map((skill) => skill.name)).toEqual(['demo'])
    expect(lease.projectionRoot).toContain(join(storageRoot, 'runtime', 'agent-skills', 'v1'))
    await expect(readFile(legacySentinel, 'utf8')).resolves.toBe('legacy')
    const attemptLease = await manager.forkAgentSkillRuntime(
      lease,
      {
        sessionId: 'session-1',
        agentFrameId: 'child-frame',
        runtimeSegmentId: 'child-segment'
      },
      { kind: 'subagent' }
    )
    expect(attemptLease.projectionRoot).not.toBe(lease.projectionRoot)
    expect(attemptLease.catalogRevision).toBe(lease.catalogRevision)
    await expect(readFile(attemptLease.skills[0]!.skillDocumentPath, 'utf8')).resolves.toContain(
      'Use demo.'
    )
    expect(attemptLease.env).not.toEqual(lease.env)
    await Promise.all([lease.release(), attemptLease.release()])
  })

  it('takes a fresh catalog snapshot when a later runtime segment discovers a new Skill', async () => {
    const firstSource = join(storageRoot, 'dynamic-first-source')
    const secondSource = join(storageRoot, 'dynamic-second-source')
    await mkdir(firstSource, { recursive: true })
    await mkdir(secondSource, { recursive: true })
    await writeFile(
      join(firstSource, 'SKILL.md'),
      '---\nname: dynamic-first\ndescription: First dynamic Skill.\n---\n'
    )
    await writeFile(
      join(secondSource, 'SKILL.md'),
      '---\nname: dynamic-second\ndescription: Second dynamic Skill.\n---\n'
    )
    const first = {
      id: 'dynamic-first',
      name: 'dynamic-first',
      description: 'First dynamic Skill.',
      source: 'personal' as const,
      updatedAt: '2026-08-14T00:00:00.000Z',
      compatibility: 'sha256:dynamic-first',
      sourceDir: firstSource
    }
    const second = {
      id: 'dynamic-second',
      name: 'dynamic-second',
      description: 'Second dynamic Skill.',
      source: 'personal' as const,
      updatedAt: '2026-08-14T00:01:00.000Z',
      compatibility: 'sha256:dynamic-second',
      sourceDir: secondSource
    }
    const runtimeProjectionCatalog = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second])
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })
    const settings = await repository.getSettings()

    const earlier = await manager.acquireAgentSkillRuntime(settings, {
      lifecycle: {
        sessionId: 'session-dynamic',
        agentFrameId: 'frame-main',
        runtimeSegmentId: 'segment-before-install'
      },
      scope: { kind: 'main' }
    })
    const later = await manager.acquireAgentSkillRuntime(settings, {
      lifecycle: {
        sessionId: 'session-dynamic',
        agentFrameId: 'frame-main',
        runtimeSegmentId: 'segment-after-install'
      },
      scope: { kind: 'main' }
    })

    expect(earlier.skills.map(({ id }) => id)).toEqual(['dynamic-first'])
    expect(later.skills.map(({ id }) => id)).toEqual(['dynamic-first', 'dynamic-second'])
    expect(later.catalogRevision).not.toBe(earlier.catalogRevision)
    await expect(readFile(earlier.skills[0]!.skillDocumentPath, 'utf8')).resolves.toContain(
      'dynamic-first'
    )
    expect(runtimeProjectionCatalog).toHaveBeenCalledTimes(2)
    await earlier.release()
    await later.release()
  })

  it('projects a disabled Skill when an exact Specialist scope authorizes it', async () => {
    const sourceRoot = join(storageRoot, 'specialist-skill-source')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(
      join(sourceRoot, 'SKILL.md'),
      '---\nname: specialist-demo\ndescription: Specialist demo.\n---\n'
    )
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'specialist-demo',
          name: 'specialist-demo',
          displayName: 'Specialist Demo',
          description: 'Specialist demo.',
          source: 'personal',
          updatedAt: '2026-08-14T00:00:00.000Z',
          compatibility: 'sha256:specialist-demo-v1',
          sourceDir: sourceRoot
        }
      ])
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })
    const settings = await repository.getSettings()
    settings.disabledSkillIds = ['specialist-demo']

    const lease = await manager.acquireAgentSkillRuntime(settings, {
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-specialist',
        runtimeSegmentId: 'segment-specialist'
      },
      scope: { kind: 'specialist' },
      allowedSkillIds: ['specialist-demo']
    })

    expect(lease.skills.map((skill) => skill.id)).toEqual(['specialist-demo'])
    await lease.release()
  })

  it('projects an exactly authorized bundled Connector from its generated Skill document', async () => {
    const packageSource = join(storageRoot, 'package-source')
    await mkdir(packageSource, { recursive: true })
    await writeFile(
      join(packageSource, 'SKILL.md'),
      '---\nname: package-demo\ndescription: Package demo.\n---\n'
    )
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'package-demo',
          name: 'package-demo',
          description: 'Package demo.',
          source: 'featured',
          updatedAt: '2026-08-14T00:00:00.000Z',
          compatibility: 'sha256:package-demo-v1',
          sourceDir: packageSource
        }
      ])
    } as unknown as SkillCatalogModule
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue(['pubmed']),
      materializedCustomSkillNames: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule
    manager = createManager({ skills, connectors })

    const lease = await manager.acquireAgentSkillRuntime(await repository.getSettings(), {
      lifecycle: {
        sessionId: 'session-connector',
        agentFrameId: 'frame-connector',
        runtimeSegmentId: 'segment-connector'
      },
      scope: { kind: 'specialist' },
      allowedSkillIds: ['mcp-pubmed']
    })

    expect(lease.skills.map((skill) => skill.id)).toEqual(['mcp-pubmed'])
    const [projected] = lease.skills
    const document = await readFile(join(projected.packageRoot, 'SKILL.md'), 'utf8')
    const { fields } = parseFrontmatter(document)
    expect(projected.description).toBe(fields.description)
    expect(projected.packageRevision).toBe(
      `sha256:${createHash('sha256').update(document).digest('hex')}`
    )
    await lease.release()
  })

  it('projects only the canonical custom Connector Skill document', async () => {
    const customSkillName = 'mcp-xt'
    const sourceDir = join(connectorSkillSourceRoot(storageRoot), customSkillName)
    const rollbackFile = join(
      getAppClaudeConfigDir(storageRoot),
      'skills',
      customSkillName,
      'SKILL.md'
    )
    const document =
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n'
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), document)
    await writeFile(join(sourceDir, 'private-config.json'), '{"secret":true}')
    await mkdir(dirname(rollbackFile), { recursive: true })
    await writeFile(
      rollbackFile,
      '---\nname: mcp-xt\ndescription: Stale rollback doc.\nsource: connector\n---\n',
      'utf8'
    )
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn().mockReturnValue([customSkillName])
    } as unknown as ConnectorSettingsModule
    manager = createManager({ connectors })

    const lease = await manager.acquireAgentSkillRuntime(await repository.getSettings(), {
      lifecycle: {
        sessionId: 'session-custom-connector',
        agentFrameId: 'frame-custom-connector',
        runtimeSegmentId: 'segment-custom-connector'
      },
      scope: { kind: 'specialist' },
      allowedSkillIds: [customSkillName]
    })

    expect(lease.skills.map((skill) => skill.id)).toEqual([customSkillName])
    expect(await readdir(lease.skills[0].packageRoot)).toEqual(['SKILL.md'])
    await expect(readFile(join(lease.skills[0].packageRoot, 'SKILL.md'), 'utf8')).resolves.toBe(
      document
    )
    await expect(readFile(rollbackFile, 'utf8')).resolves.toContain('Stale rollback doc.')
    await lease.release()
  })

  it('fails closed when a materialized custom Connector has invalid frontmatter', async () => {
    const customSkillName = 'mcp-xt'
    const sourceDir = join(connectorSkillSourceRoot(storageRoot), customSkillName)
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: user\n---\n'
    )
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn().mockReturnValue([customSkillName])
    } as unknown as ConnectorSettingsModule
    manager = createManager({ connectors })

    await expect(
      manager.acquireAgentSkillRuntime(await repository.getSettings(), {
        lifecycle: {
          sessionId: 'session-invalid-custom',
          agentFrameId: 'frame-invalid-custom',
          runtimeSegmentId: 'segment-invalid-custom'
        },
        scope: { kind: 'main' }
      })
    ).rejects.toThrow('Connector Skill document has invalid frontmatter: mcp-xt')
  })

  it('projects current Compute hosts without modifying the package source', async () => {
    const sourceRoot = join(storageRoot, 'compute-source')
    const sourceDocument = [
      '---',
      'name: remote-compute-ssh',
      'description: Discover and use SSH compute hosts.',
      '---',
      '',
      '## Registered hosts',
      '',
      '<!-- open-science:compute-hosts:start -->',
      '  (no hosts registered yet)',
      '<!-- open-science:compute-hosts:end -->',
      '',
      '## API reference'
    ].join('\n')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'SKILL.md'), sourceDocument)
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      provisionClaudeConfig: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'remote-compute-ssh',
          name: 'remote-compute-ssh',
          description: 'Discover and use SSH compute hosts.',
          source: 'featured',
          updatedAt: '2026-08-14T00:00:00.000Z',
          compatibility: 'sha256:compute-v1',
          sourceDir: sourceRoot
        }
      ])
    } as unknown as SkillCatalogModule
    const host: ComputeHost = {
      id: 'host-1',
      providerId: 'ssh:biowulf',
      displayName: 'Biowulf',
      shape: 'scheduler_cluster',
      sshAlias: 'biowulf',
      sshOverrides: undefined,
      scratchRoot: undefined,
      scratchPinned: false,
      concurrencyLimit: undefined,
      probeResult: undefined,
      detailsDoc: '',
      detailsUpdatedAt: undefined,
      detailsUpdatedBy: undefined,
      createdAt: 1,
      updatedAt: 1
    }
    manager = createManager({ skills, listComputeHosts: vi.fn().mockResolvedValue([host]) })

    const lease = await manager.acquireAgentSkillRuntime(await repository.getSettings(), {
      lifecycle: {
        sessionId: 'session-compute',
        agentFrameId: 'frame-compute',
        runtimeSegmentId: 'segment-compute'
      },
      scope: { kind: 'main' }
    })

    const projectedDocument = await readFile(join(lease.skills[0].packageRoot, 'SKILL.md'), 'utf8')
    expect(projectedDocument).toContain('Biowulf')
    expect(projectedDocument).toContain('ssh:biowulf')
    await expect(readFile(join(sourceRoot, 'SKILL.md'), 'utf8')).resolves.toBe(sourceDocument)
    await lease.release()
  })

  it('synchronizes provisioned custom Connector docs into isolated agent Skill roots', async () => {
    const customSkillName = 'mcp-xt'
    const sourceDir = join(connectorSkillSourceRoot(storageRoot), customSkillName)
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

  it('owns materialization of framework-generated runtime config files', async () => {
    const configPath = join(storageRoot, 'runtime-config', 'agent.json')

    await manager.materializeAgentConfigFiles([
      { path: configPath, content: '{"runtime":"managed"}\n' }
    ])

    await expect(readFile(configPath, 'utf8')).resolves.toBe('{"runtime":"managed"}\n')
  })
})
