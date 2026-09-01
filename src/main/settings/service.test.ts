import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { execPath } from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultVendorModel } from '../../shared/provider-registry'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type ClaudeDetectResult
} from '../../shared/settings'
import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type {
  ClaudeIsolatedAuthControllerPort,
  ClaudeIsolatedAuthStatus
} from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort } from './claude-shared-auth'
import type { UserSkillRepository as UserSkillRepositoryType } from '../skills/user-skill-repository'
import type { SystemProxyEnvironment } from './system-proxy'
import type { AgentBackendResolutionContext } from './backend-resolver'
import type { Logger } from '../logger'

// Reversible fake safeStorage so provider keys can be encrypted/decrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const decoded = buffer.toString('utf8')

      if (!decoded.startsWith('cipher:')) throw new Error('bad ciphertext')

      return decoded.slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false },
  // The provider-validation probe fetches over net.fetch (proxy-aware in production). Delegate to the
  // global fetch each test stubs, so the existing vi.stubGlobal('fetch', …) probe expectations hold.
  net: { fetch: vi.fn((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) }
}))

const { SettingsService } = await import('./service')
const { ResponsesBridge: ResponsesBridgeClass } = await import('./responses-bridge')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { getClaudeSkillRuntimeRoot } = await import('./claude-runtime-provisioner')
const { connectorSkillSourceDir } = await import('../connectors/provision')
const { SkillRegistry } = await import('../skills/registry')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { netFetch } = await import('../skills/net-fetch')
const { UserSkillRepository } = await import('../skills/user-skill-repository')
const { UserSkillSpecialistPackageAdapter } = await import('../skills/specialist-package-adapter')
const { opencodeConfigDir, opencodeTransportProviderId } =
  await import('../agent-framework/opencode')
const { net: mockedNet } = (await import('electron')) as unknown as {
  net: { fetch: ReturnType<typeof vi.fn> }
}

// Production captures the non-secret framework selection at generation construction, then resolves
// current credentials and provider configuration at spawn. Integration tests use that same public seam.
const resolveActiveBackend = async (
  service: InstanceType<typeof SettingsService>,
  context: AgentBackendResolutionContext = {}
): ReturnType<InstanceType<typeof SettingsService>['resolveAgentBackend']> =>
  service.resolveAgentBackend(await service.captureActiveAgentBackendSelection(), context)

const claudeSkillProjectionRoot = (backend: {
  sessionOptions?: Record<string, unknown>
}): string => {
  const directories = backend.sessionOptions?.additionalDirectories as unknown[] | undefined
  const path = directories?.[0]
  if (typeof path !== 'string') throw new Error('Claude backend has no Skill projection path')
  return path
}

let storageRoot: string
let repository: InstanceType<typeof SettingsRepository>
const CODEX_SHARED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID
const CODEX_ISOLATED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID
const MANAGED_CODEX_ADAPTER_FIXTURE = [
  'function startCodexConnection(codexPath, env) {',
  '  const spawnEnv = env ?? process.env;',
  '  let codex;',
  '  if (codexPath) {',
  '    codex = process.platform === "win32" ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv }) : spawn(codexPath, ["app-server"], { env: spawnEnv });',
  '  } else {',
  '    const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");',
  '    codex = spawn(process.execPath, [bundledCodexPath, "app-server"], { env: spawnEnv });',
  '  }',
  '}',
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

const validAnthropicResponse = (): Response =>
  new Response(
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'o' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const validBridgeToolCallResponse = (): Response =>
  new Response(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open_science_bridge_probe","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )

const validNativeCompatibilityToolCallResponse = (): Response =>
  new Response(
    'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"open_science__bridge_probe","arguments":"{}"}}\n\ndata: {"type":"response.completed","response":{"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"open_science__bridge_probe","arguments":"{}"}]}}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )

type ManagedInstallImpl = (options: {
  installId: string
  onEvent: (event: { kind: string; installId: string }) => void
  dataRoot: string
  registries?: string[]
}) => Promise<{
  result: { installId: string; ok: boolean; error?: string }
  resolvedPath?: string
  version?: string
}>

type ManagedCodexInstallImpl = (options: {
  installId: string
  onEvent: (event: { kind: string; installId: string }) => void
  dataRoot: string
}) => Promise<{
  result: { installId: string; ok: boolean; error?: string }
  adapterPath?: string
  adapterVersion?: string
  codexPath?: string
  codexVersion?: string
}>

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const createService = (
  detectResult: ClaudeDetectResult = { found: true, path: '/bin/claude', version: '2.1.0' },
  options: {
    installManagedClaudeImpl?: ManagedInstallImpl
    installManagedOpencodeImpl?: ManagedInstallImpl
    installManagedCodexImpl?: ManagedCodexInstallImpl
    // When set, opencode detection resolves this path/version; otherwise it finds nothing.
    opencodeDetected?: { path: string; version: string }
    // When set, CodeBuddy detection resolves this path/version; otherwise it finds nothing.
    codebuddyDetected?: { path: string; version: string }
    allocateOpenCodeUsagePort?: () => Promise<number>
    codexDetected?: { path: string; version: string; nativePath?: string; nativeVersion?: string }
    managedCodexAdapterPath?: string
    managedCodexNativePath?: string
    // Simulates an external native Codex CLI reachable only via the augmented PATH (e.g. Homebrew),
    // so getCodexVersion resolves for this path even though it's not the managed nativePath.
    codexExternalNative?: { path: string; version: string }
    // When false, the ACP smoke test fails (adapter present but can't initialize).
    codexSmokeOk?: boolean
    codexAuth?: CodexAuthControllerPort
    resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
    claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
    claudeSharedAuth?: ClaudeSharedAuthControllerPort
    executeClaudeProbe?: (
      executablePath: string,
      env: NodeJS.ProcessEnv,
      runtimeArgs?: string[]
    ) => Promise<void>
    userClaudeDir?: string
    userCodexDir?: string
    userAgentsDir?: string
    userSkills?: UserSkillRepositoryType
    log?: Logger
  } = {}
): InstanceType<typeof SettingsService> =>
  new SettingsService({
    repository,
    log: options.log ?? silentLog,
    storageRoot,
    // Point at a non-existent user Claude dir so tests never read the real ~/.claude. The same
    // path is now used by claude-isolated skill-scanning; claude-default is gone.
    userClaudeDir: options.userClaudeDir ?? join(storageRoot, 'no-user-claude'),
    userCodexDir: options.userCodexDir ?? join(storageRoot, 'no-user-codex'),
    userAgentsDir: options.userAgentsDir ?? join(storageRoot, 'no-user-agents'),
    userSkills: options.userSkills,
    executeClaudeProbe: options.executeClaudeProbe,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedClaudeImpl: options.installManagedClaudeImpl as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedOpencodeImpl: options.installManagedOpencodeImpl as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedCodexImpl: options.installManagedCodexImpl as any,
    detectDeps: {
      env: {},
      homePath: '/home',
      platform: 'linux',
      isExecutable: () => Promise.resolve(true),
      getVersion: () => Promise.resolve(detectResult.version),
      resolveNpmBinDirs: () => Promise.resolve([])
    },
    // Isolated so opencode detection never probes the real host during tests. Finds nothing unless the
    // caller declares an installed path (isExecutable/getVersion then answer for exactly that path).
    opencodeDetectDeps: {
      env: options.opencodeDetected ? { PATH: dirname(options.opencodeDetected.path) } : {},
      homePath: '/home',
      platform: 'linux',
      isExecutable: (path) => Promise.resolve(path === options.opencodeDetected?.path),
      getVersion: (path) =>
        Promise.resolve(
          path === options.opencodeDetected?.path ? options.opencodeDetected.version : undefined
        ),
      resolveNpmBinDirs: () => Promise.resolve([])
    },
    codebuddyDetectDeps: {
      env: options.codebuddyDetected ? { PATH: dirname(options.codebuddyDetected.path) } : {},
      homePath: '/home',
      platform: 'linux',
      isExecutable: (path) => Promise.resolve(path === options.codebuddyDetected?.path),
      getVersion: (path) =>
        Promise.resolve(
          path === options.codebuddyDetected?.path ? options.codebuddyDetected.version : undefined
        ),
      resolveNpmBinDirs: () => Promise.resolve([])
    },
    allocateOpenCodeUsagePort: options.allocateOpenCodeUsagePort ?? (() => Promise.resolve(42_424)),
    codexDetectDeps: {
      env: options.codexDetected ? { PATH: dirname(options.codexDetected.path) } : {},
      homePath: '/home',
      platform: 'linux',
      isRunnable: (path) =>
        Promise.resolve(
          path === options.codexDetected?.path || path === options.managedCodexAdapterPath
        ),
      getAdapterVersion: (path) =>
        Promise.resolve(
          path === options.codexDetected?.path || path === options.managedCodexAdapterPath
            ? (options.codexDetected?.version ?? 'codex-acp 1.6.2')
            : undefined
        ),
      getCodexVersion: (path) =>
        Promise.resolve(
          path === options.codexDetected?.nativePath
            ? options.codexDetected.nativeVersion
            : path === options.managedCodexNativePath
              ? 'codex-cli 0.144.6'
              : path === options.codexExternalNative?.path
                ? options.codexExternalNative.version
                : undefined
        ),
      smokeInitialize: () => Promise.resolve(options.codexSmokeOk ?? true),
      resolveNpmBinDirs: () => Promise.resolve([]),
      managedAdapterPath: options.managedCodexAdapterPath ?? options.codexDetected?.path,
      managedCodexPath: options.managedCodexNativePath ?? options.codexDetected?.nativePath
    },
    codexAuth: options.codexAuth,
    resolveCodexProxyEnvironment:
      options.resolveCodexProxyEnvironment ?? (() => Promise.resolve({})),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claudeIsolatedAuth: options.claudeIsolatedAuth as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claudeSharedAuth: options.claudeSharedAuth as any
  })

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-service-'))
  repository = new SettingsRepository(storageRoot)
  const userCodexDir = join(storageRoot, 'no-user-codex')
  await mkdir(userCodexDir, { recursive: true })
  await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"test"}}')
})

const makeTreeWritable = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await chmod(root, 0o755).catch(() => undefined)
  await Promise.all(
    entries.map((entry) =>
      entry.isSymbolicLink()
        ? Promise.resolve()
        : entry.isDirectory()
          ? makeTreeWritable(join(root, entry.name))
          : chmod(join(root, entry.name), 0o644).catch(() => undefined)
    )
  )
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await makeTreeWritable(storageRoot)
  await rm(storageRoot, { recursive: true, force: true })
})

describe('SettingsService: load diagnostics', () => {
  it('records the renderer-safe settings load phases and duration', async () => {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } satisfies Logger
    const service = createService(undefined, { log })

    await service.getSettingsView()

    expect(
      log.info.mock.calls
        .filter(([message]) => message === 'operation phase')
        .map(([, fields]) => (fields as { phase: string }).phase)
    ).toEqual(['read-authority', 'migrate-legacy-key-refs', 'build-renderer-view'])
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'settings-load',
        outcome: 'completed',
        providerCount: expect.any(Number),
        durationMs: expect.any(Number)
      })
    )
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(storageRoot)
  })
})

describe('SettingsService: custom MCP OAuth', () => {
  it('delegates authentication and returns the refreshed connector snapshot', async () => {
    const service = createService()
    const credential = await service.createDeviceCredential({
      displayName: 'OAuth MCP',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test',
      transport: 'streamable_http',
      oauth: { scopes: ['openid'] }
    })
    const added = await service.addCustomServer({
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauthCredentialId: credential.createdCredential.id
    })
    const id = added.customServers[0].id
    const authenticator = vi.fn(async (serverId: string) => {
      await service.saveCustomServerOAuthState(serverId, {
        tokens: { access_token: 'access', token_type: 'Bearer' }
      })
    })
    const cancel = vi.fn(async () => undefined)
    service.setCustomServerAuthenticator(authenticator, cancel)

    const snapshot = await service.authenticateCustomServer(id)

    expect(authenticator).toHaveBeenCalledWith(id)
    expect(snapshot.customServers[0].oauth).toMatchObject({ hasTokens: true })
    expect(snapshot.customServers[0].availability).toBeUndefined()
    expect(snapshot.customServers[0].enabled).toBe(true)

    await service.cancelCustomServerAuthentication(id)
    expect(cancel).toHaveBeenCalledWith(id)
  })

  it('disconnects locally by closing runtime access and removing stored OAuth tokens', async () => {
    const service = createService()
    const credential = await service.createDeviceCredential({
      displayName: 'OAuth MCP',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test',
      transport: 'streamable_http',
      oauth: { scopes: ['openid'] }
    })
    const added = await service.addCustomServer({
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauthCredentialId: credential.createdCredential.id
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'access', token_type: 'Bearer' }
    })
    const disconnectRuntime = vi.fn(async () => undefined)
    service.setDeviceCredentialAuthenticator(vi.fn(), vi.fn(), disconnectRuntime)

    const snapshot = await service.disconnectCustomServer(id)

    expect(disconnectRuntime).toHaveBeenCalledWith(credential.createdCredential.id)
    expect(snapshot.customServers[0]).toMatchObject({ enabled: false, oauth: { hasTokens: false } })
    expect((await repository.getSettings()).connectors?.customMcpServers?.[0].oauthRef).toBe(
      `credential:${credential.createdCredential.id}`
    )
  })
})

describe('SettingsService: providers', () => {
  it('imports existing Codex authentication and its safe active provider route', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(join(userCodexDir, 'skills', 'private'), { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "subscription-route"',
        'model = "private"',
        '',
        '[mcp_servers.private]',
        'command = "private-command"',
        '',
        '[model_providers.subscription-route]',
        'name = "OpenAI"',
        'requires_openai_auth = true',
        'supports_websockets = false',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:1087/v1"',
        ''
      ].join('\n')
    )
    await writeFile(join(userCodexDir, 'skills', 'private', 'SKILL.md'), '# Private')
    const service = createService(undefined, { userCodexDir })

    const snapshot = await service.upsertProvider({ type: 'codex-shared' })

    expect(snapshot.providers[0]).toMatchObject({
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      type: 'codex-isolated',
      codexAuthMode: 'imported'
    })
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      type: 'codex-isolated',
      codexAuthMode: 'imported'
    })
    expect(await readFile(join(storageRoot, 'codex-subscription', 'auth.json'), 'utf8')).toBe(
      '{"tokens":{"access_token":"secret"}}'
    )
    expect(await readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')).toBe(
      [
        'cli_auth_credentials_store = "file"',
        '# Open Science: begin imported Codex route selection',
        'model_provider = "subscription-route"',
        '# Open Science: end imported Codex route selection',
        '# Open Science: begin imported Codex provider',
        '[model_providers."subscription-route"]',
        'name = "OpenAI"',
        'base_url = "http://127.0.0.1:1087/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'supports_websockets = false',
        '# Open Science: end imported Codex provider',
        ''
      ].join('\n')
    )
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'skills', 'private', 'SKILL.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an imported Codex route on resave and clears it on an explicit mode switch', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "subscription-route"',
        '',
        '[model_providers.subscription-route]',
        'name = "OpenAI"',
        'requires_openai_auth = true',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:1087/v1"',
        ''
      ].join('\n')
    )
    const service = createService(undefined, { userCodexDir })

    const imported = await service.upsertProvider({ type: 'codex-shared' })
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.toContain('model_provider = "subscription-route"')

    const verifiedImportedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...verifiedImportedProvider, lastValidatedAt: 123 })
    await rm(userCodexDir, { recursive: true, force: true })

    const resaved = await service.upsertProvider({
      id: imported.providers[0].id,
      type: imported.providers[0].codexAuthMode === 'imported' ? 'codex-shared' : 'codex-isolated'
    })
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.toContain('model_provider = "subscription-route"')
    expect(resaved.providers[0].lastValidatedAt).toBe(123)

    const isolated = await service.upsertProvider({
      id: imported.providers[0].id,
      type: 'codex-isolated'
    })

    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.toContain('cli_auth_credentials_store = "file"')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.not.toContain('open-science-chatgpt-')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.not.toContain('model_provider = "subscription-route"')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(isolated.providers[0]).toMatchObject({
      type: 'codex-isolated',
      codexAuthMode: 'isolated'
    })
    expect(isolated.providers[0].lastValidatedAt).toBeUndefined()
  })

  it('clears an imported Codex route when isolated setup is recreated after deletion', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "subscription-route"',
        '',
        '[model_providers.subscription-route]',
        'name = "OpenAI"',
        'requires_openai_auth = true',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:1087/v1"',
        ''
      ].join('\n')
    )
    const service = createService(undefined, { userCodexDir })

    await service.upsertProvider({ type: 'codex-shared' })
    await service.deleteProvider(CODEX_SUBSCRIPTION_PROVIDER_ID)
    expect((await repository.getSettings()).providers).toEqual([])

    const isolated = await service.upsertProvider({ type: 'codex-isolated' })

    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.toContain('cli_auth_credentials_store = "file"')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.not.toContain('open-science-chatgpt-')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.not.toContain('model_provider = "subscription-route"')
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(isolated.providers[0]).toMatchObject({
      type: 'codex-isolated',
      codexAuthMode: 'isolated'
    })
  })

  it('deleting a Codex subscription removes only its app-owned authentication and route', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"global"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "subscription-route"',
        '',
        '[model_providers.subscription-route]',
        'name = "OpenAI"',
        'requires_openai_auth = true',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:1087/v1"',
        ''
      ].join('\n')
    )
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth, userCodexDir })
    await service.upsertProvider({ type: 'codex-shared' })
    vi.mocked(codexAuth.cancelLogin).mockClear()

    await service.deleteProvider(CODEX_SUBSCRIPTION_PROVIDER_ID)

    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.not.toContain('Open Science:')
    await expect(readFile(join(userCodexDir, 'auth.json'), 'utf8')).resolves.toContain('global')
  })

  it('refreshes an imported Codex profile only when re-import is explicitly requested', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"old"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "old-route"',
        '',
        '[model_providers.old-route]',
        'name = "Old route"',
        'requires_openai_auth = true',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:1087/v1"',
        ''
      ].join('\n')
    )
    const service = createService(undefined, { userCodexDir })
    const imported = await service.upsertProvider({ type: 'codex-shared' })
    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...stored, lastValidatedAt: 123 })

    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"new"}}')
    await writeFile(
      join(userCodexDir, 'config.toml'),
      [
        'model_provider = "new-route"',
        '',
        '[model_providers.new-route]',
        'name = "New route"',
        'requires_openai_auth = true',
        'wire_api = "responses"',
        'base_url = "http://127.0.0.1:2087/v1"',
        ''
      ].join('\n')
    )

    const refreshed = await service.upsertProvider({
      id: imported.providers[0].id,
      type: 'codex-shared',
      reimportCodexAuthentication: true
    })

    expect(await readFile(join(storageRoot, 'codex-subscription', 'auth.json'), 'utf8')).toBe(
      '{"tokens":{"access_token":"new"}}'
    )
    await expect(
      readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')
    ).resolves.toContain('base_url = "http://127.0.0.1:2087/v1"')
    expect(refreshed.providers[0].lastValidatedAt).toBeUndefined()
  })

  it('discards an in-flight Codex validation when imported authentication is refreshed', async () => {
    let resolveStatus!: (status: CodexAuthStatus) => void
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(
        () =>
          new Promise<CodexAuthStatus>((resolve) => {
            resolveStatus = resolve
          })
      ),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    const imported = await service.upsertProvider({ type: 'codex-shared' })

    const pendingValidation = service.validateProvider({
      providerId: imported.providers[0].id
    })
    await writeFile(
      join(storageRoot, 'no-user-codex', 'auth.json'),
      '{"tokens":{"access_token":"refreshed"}}'
    )
    await service.upsertProvider({
      id: imported.providers[0].id,
      type: 'codex-shared',
      reimportCodexAuthentication: true
    })
    resolveStatus({ mode: 'shared', supported: true, authenticated: true })

    await expect(pendingValidation).resolves.toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeUndefined()
  })

  it.each([
    ['codex-shared', CODEX_SHARED_PROVIDER_ID, 'Codex subscription'],
    ['codex-isolated', CODEX_ISOLATED_PROVIDER_ID, 'Codex subscription']
  ] as const)('persists %s as one fixed built-in provider', async (type, id, name) => {
    const service = createService()

    await service.upsertProvider({ type, name: 'ignored', key: 'ignored', model: 'ignored' })
    const snapshot = await service.upsertProvider({ type, name: 'duplicate attempt' })

    expect(snapshot.providers.filter((provider) => provider.id === id)).toEqual([
      expect.objectContaining({
        id,
        type: 'codex-isolated',
        name,
        apiEndpoints: ['responses'],
        models: [
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini'
        ],
        hasKey: false
      })
    ])
    expect((await repository.getSettings()).providers).toEqual([
      expect.objectContaining({ id, type: 'codex-isolated', name, apiEndpoints: ['responses'] })
    ])
  })

  it.each([
    ['codex-shared', CODEX_SHARED_PROVIDER_ID],
    ['codex-isolated', CODEX_ISOLATED_PROVIDER_ID]
  ] as const)('deletes an added %s provider', async (type, id) => {
    const service = createService()
    await service.upsertProvider({ type })

    await expect(service.deleteProvider(id)).resolves.toMatchObject({ providers: [] })
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it.each([
    [CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID, 'claude-isolated-model'],
    [CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID, 'claude-shared-model']
  ] as const)(
    'deleting %s through the collapsed card also removes its active sibling',
    async (deletedId, activeId, activeModel) => {
      const service = createService()
      await service.upsertProvider({ type: 'claude-shared', model: 'claude-shared-model' })
      await service.upsertProvider({ type: 'claude-isolated', model: 'claude-isolated-model' })
      await service.setActiveProvider(activeId, activeModel)

      const snapshot = await service.deleteProvider(deletedId)

      expect(snapshot.providers).toEqual([])
      expect(snapshot.claudeSubscriptionProviderId).toBeUndefined()
      expect(snapshot.activeProviderId).toBeUndefined()
      expect(snapshot.activeModel).toBeUndefined()
      const stored = await repository.getSettings()
      expect(stored.providers).toEqual([])
      expect(stored.activeProviderId).toBeUndefined()
      expect(stored.activeModel).toBeUndefined()
      expect(stored.claudeSubscriptionProviderId).toBeUndefined()
    }
  )

  it.each([CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID])(
    'cancels both Claude login controllers before deleting the collapsed provider through %s',
    async (providerId) => {
      const claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort = {
        getStatus: vi.fn(),
        loginIsolatedBrowser: vi.fn(),
        loginIsolated: vi.fn(),
        cancelLogin: vi.fn(),
        logoutIsolated: vi.fn()
      }
      const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
        getStatus: vi.fn(),
        loginShared: vi.fn(),
        cancelLogin: vi.fn()
      }
      const service = createService(undefined, { claudeIsolatedAuth, claudeSharedAuth })
      await service.upsertProvider({ type: 'claude-shared' })
      await service.upsertProvider({ type: 'claude-isolated' })

      await service.deleteProvider(providerId)

      expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
      expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('discards a browser login token that arrives after the Claude provider is deleted', async () => {
    let finishBrowserLogin: (() => Promise<void>) | undefined
    const claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(
        () =>
          new Promise<ClaudeIsolatedAuthStatus>((resolve) => {
            finishBrowserLogin = async () => {
              const applied = await repository.updateClaudeIsolatedCredentialsIfExists({
                keyRef: 'enc:late-browser-token',
                keyMask: 'sk-ant-…late'
              })
              resolve({
                supported: true,
                authenticated: applied,
                message: applied
                  ? undefined
                  : 'The Claude provider was removed before sign-in completed.'
              })
            }
          })
      ),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { claudeIsolatedAuth })
    await service.upsertProvider({ type: 'claude-isolated' })

    const login = service.loginIsolatedClaudeBrowser()
    await vi.waitFor(() => expect(claudeIsolatedAuth.loginIsolatedBrowser).toHaveBeenCalledOnce())
    await service.deleteProvider(CLAUDE_ISOLATED_PROVIDER_ID)
    await finishBrowserLogin?.()

    expect(await login).toMatchObject({ ok: false, applied: false })
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not recreate a deleted Claude provider when a late token save completes', async () => {
    const service = createService(undefined, {
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await service.upsertProvider({ type: 'claude-isolated' })
    await service.deleteProvider(CLAUDE_ISOLATED_PROVIDER_ID)

    const result = await service.loginIsolatedClaude('sk-ant-late')

    expect(result).toMatchObject({ ok: false, applied: false })
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('validates imported and in-app subscription setup through their matching status checks', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn((mode) =>
        Promise.resolve({
          mode,
          supported: true,
          authenticated: true
        })
      ),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-shared' })

    await expect(
      service.validateProvider({ providerId: CODEX_SHARED_PROVIDER_ID })
    ).resolves.toMatchObject({ ok: true })
    expect(codexAuth.getStatus).toHaveBeenNthCalledWith(1, 'shared')
    await service.upsertProvider({ type: 'codex-isolated' })
    await expect(
      service.validateProvider({ providerId: CODEX_ISOLATED_PROVIDER_ID })
    ).resolves.toMatchObject({ ok: true })
    expect(codexAuth.getStatus).toHaveBeenNthCalledWith(2, 'isolated')
    // Validation never opens the browser login; that is the explicit sign-in action's job.
    expect(codexAuth.loginIsolated).not.toHaveBeenCalled()

    const stored = await repository.getSettings()
    expect(stored.providers.every((provider) => provider.lastValidatedAt !== undefined)).toBe(true)
  })

  it('reports imported login guidance when imported subscription auth is unavailable', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn((mode) =>
        Promise.resolve({
          mode,
          supported: true,
          authenticated: false
        })
      ),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-shared' })

    await expect(
      service.validateProvider({ providerId: CODEX_SHARED_PROVIDER_ID })
    ).resolves.toMatchObject({
      ok: false,
      category: 'auth',
      message:
        'No existing Codex login was found. Run `codex login` or use the isolated Open Science login.'
    })
    expect(codexAuth.getStatus).toHaveBeenCalledWith('shared')
  })

  it('does not apply a pending Codex validation after the subscription auth mode changes', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
    let finishStatus!: () => void
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(
        () =>
          new Promise<CodexAuthStatus>((resolve) => {
            finishStatus = () => resolve({ mode: 'isolated', supported: true, authenticated: true })
          })
      ),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth, userCodexDir })
    await service.upsertProvider({ type: 'codex-shared' })

    const validation = service.validateProvider({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID })
    await vi.waitFor(() => expect(codexAuth.getStatus).toHaveBeenCalledOnce())
    await service.upsertProvider({ type: 'codex-isolated' })
    finishStatus()

    await expect(validation).resolves.toMatchObject({ ok: true, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.codexAuthMode).toBe('isolated')
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('reports an unauthenticated isolated status without triggering sign-in', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      }),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    const result = await service.validateProvider({ providerId: CODEX_ISOLATED_PROVIDER_ID })

    expect(result).toMatchObject({
      ok: false,
      category: 'auth',
      message: 'Not signed in. Use Sign in to connect your ChatGPT account.'
    })
    expect(codexAuth.loginIsolated).not.toHaveBeenCalled()
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toMatchObject({
      category: 'auth'
    })
  })

  it('records the explicit isolated sign-in outcome on the provider', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    await expect(service.loginIsolatedCodex()).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeDefined()

    // A failed attempt (e.g. the user dismisses the browser flow) clears the verified stamp and
    // records the reason, so the card flags the provider as unverified until a retry succeeds.
    codexAuth.loginIsolated = vi.fn().mockResolvedValue({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    await expect(service.loginIsolatedCodex()).resolves.toMatchObject({
      ok: false,
      category: 'auth',
      message: 'Codex sign-in was cancelled.'
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({
      category: 'auth',
      message: 'Codex sign-in was cancelled.'
    })
  })

  it('discards a late isolated sign-in failure after authentication is imported mid-flow', async () => {
    let resolveLogin!: (status: CodexAuthStatus) => void
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn(
        () =>
          new Promise<CodexAuthStatus>((resolve) => {
            resolveLogin = resolve
          })
      ),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    const pending = service.loginIsolatedCodex()
    await service.upsertProvider({ type: 'codex-shared' })
    const imported = (await repository.getSettings()).providers[0]
    expect(imported.codexAuthMode).toBe('imported')
    await repository.upsertProvider({ ...imported, lastValidatedAt: 123 })
    resolveLogin({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in timed out.'
    })

    await expect(pending).resolves.toMatchObject({ ok: false, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.type).toBe('codex-isolated')
    expect(stored.codexAuthMode).toBe('imported')
    expect(stored.lastValidatedAt).toBe(123)
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('waits for isolated sign-in cancellation before importing authentication', async () => {
    const userCodexDir = join(storageRoot, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), '{"tokens":{"access_token":"imported"}}')
    let finishCancellation!: () => void
    const cancellationGate = new Promise<void>((resolve) => {
      finishCancellation = resolve
    })
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(() => cancellationGate),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth, userCodexDir })
    await service.upsertProvider({ type: 'codex-isolated' })
    const appAuthPath = join(storageRoot, 'codex-subscription', 'auth.json')
    await writeFile(appAuthPath, '{"tokens":{"access_token":"isolated"}}')

    const switching = service.upsertProvider({ type: 'codex-shared' })
    await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledOnce())
    await expect(readFile(appAuthPath, 'utf8')).resolves.toContain('isolated')

    finishCancellation()
    await switching
    await expect(readFile(appAuthPath, 'utf8')).resolves.toContain('imported')
  })

  it('keeps the Codex account default when a subscription is activated without a model', async () => {
    const service = createService()
    const provider = (await service.upsertProvider({ type: 'codex-shared' })).providers[0]

    const snapshot = await service.setActiveProvider(provider.id)

    expect(snapshot.activeModel).toBeUndefined()
  })

  it('requires fresh validation after importing existing Codex authentication', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        mode: 'shared',
        supported: true,
        authenticated: true
      }),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.validateProvider({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID })
    expect((await service.getSettingsView()).providers[0].lastValidatedAt).toBeDefined()

    const snapshot = await service.upsertProvider({ type: 'codex-shared' })

    expect(snapshot.providers[0].type).toBe('codex-isolated')
    expect(snapshot.providers[0].lastValidatedAt).toBeUndefined()
  })

  it('cancels isolated login and removes only the app-owned credential on logout', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.loginIsolatedCodex()
    const appAuthPath = join(storageRoot, 'codex-subscription', 'auth.json')
    await writeFile(appAuthPath, '{"tokens":{"access_token":"isolated"}}')

    service.cancelCodexLogin()
    await service.logoutIsolatedCodex()

    expect(codexAuth.cancelLogin).toHaveBeenCalledTimes(2)
    expect(codexAuth.logoutIsolated).not.toHaveBeenCalled()
    await expect(readFile(appAuthPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('rejects isolated logout for imported authentication without deleting its copy', async () => {
    const codexAuth = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-shared' })
    codexAuth.cancelLogin.mockClear()
    const appAuthPath = join(storageRoot, 'codex-subscription', 'auth.json')

    const result = await service.logoutIsolatedCodex()

    expect(result).toEqual({
      ok: false,
      category: 'unknown',
      message: 'No isolated Open Science Codex login is configured.'
    })
    expect(codexAuth.cancelLogin).not.toHaveBeenCalled()
    expect(codexAuth.logoutIsolated).not.toHaveBeenCalled()
    await expect(readFile(appAuthPath, 'utf8')).resolves.toContain('access_token')
  })

  it('returns success when the app-owned isolated credential is already absent', async () => {
    const codexAuth = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.loginIsolatedCodex()
    const appConfigPath = join(storageRoot, 'codex-subscription', 'config.toml')
    await writeFile(appConfigPath, 'cli_auth_credentials_store = "auto"\n')

    const result = await service.logoutIsolatedCodex()

    expect(result).toEqual({ ok: true, category: 'ok' })
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(codexAuth.logoutIsolated).not.toHaveBeenCalled()
    await expect(readFile(appConfigPath, 'utf8')).resolves.toBe(
      'cli_auth_credentials_store = "file"\n'
    )
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('encrypts the key on upsert and never exposes plaintext in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      key: 'sk-super-secret'
    })

    const view = snapshot.providers[0]
    expect(view.hasKey).toBe(true)
    expect(view.maskedKey).toBe('••••cret')
    expect(JSON.stringify(view)).not.toContain('sk-super-secret')

    // The stored record holds ciphertext, not the plaintext key.
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-super-secret')
  })

  it('persists and exposes custom model reasoning effort settings', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      reasoningEffortPreset: 'none-high',
      reasoningEffortTransport: 'deepseek',
      key: 'sk-super-secret'
    })

    expect(snapshot.providers[0].reasoningEffortPreset).toBe('none-high')
    expect(snapshot.providers[0].reasoningEffortTransport).toBe('deepseek')
    expect((await repository.getSettings()).providers[0].reasoningEffortPreset).toBe('none-high')
    expect((await repository.getSettings()).providers[0].reasoningEffortTransport).toBe('deepseek')
  })

  it('persists custom model limits and carries them into OpenCode model metadata', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g',
      model: 'm',
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      key: 'k'
    })
    const view = snapshot.providers[0]
    expect(view.contextWindow).toBe(400_000)
    expect(view.maxInputTokens).toBe(272_000)
    expect(view.maxOutputTokens).toBe(128_000)
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000
    })

    await repository.upsertProvider({
      ...(await repository.getSettings()).providers[0],
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(view.id)
    const backend = await resolveActiveBackend(service)
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const materialized = JSON.parse(
      await readFile(join(opencodeConfigDir(storageRoot), 'opencode.json'), 'utf8')
    )
    const agentProviderId = opencodeTransportProviderId(view.id, 'm')
    const expectedLimit = {
      context: 400_000,
      input: 272_000,
      output: 128_000
    }
    expect(content.provider[agentProviderId].models.m.limit).toEqual(expectedLimit)
    expect(materialized.provider[agentProviderId].models.m.limit).toEqual(expectedLimit)
  })

  it('uses a 200k context default and keeps the OpenCode output reserve adapter-only', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })
    const view = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    expect(view.contextWindow).toBeUndefined()
    expect(view.maxInputTokens).toBeUndefined()
    expect(view.maxOutputTokens).toBeUndefined()

    await repository.upsertProvider({
      ...(await repository.getSettings()).providers[0],
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(view.id)
    const backend = await resolveActiveBackend(service)
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const materialized = JSON.parse(
      await readFile(join(opencodeConfigDir(storageRoot), 'opencode.json'), 'utf8')
    )
    const agentProviderId = opencodeTransportProviderId(view.id, 'm')
    expect(content.provider[agentProviderId].models.m.limit.context).toBe(200_000)
    expect(content.provider[agentProviderId].models.m.limit).not.toHaveProperty('input')
    expect(content.provider[agentProviderId].models.m.limit.output).toBe(32_000)
    expect(materialized.provider[agentProviderId].models.m.limit).toEqual({
      context: 200_000,
      output: 32_000
    })
  })

  it('keeps OpenCode connector details in on-demand skills instead of baseline context', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const customSkillName = 'mcp-xt'
    const customSkillSource = join(connectorSkillSourceDir(storageRoot), customSkillName)
    await mkdir(customSkillSource, { recursive: true })
    await writeFile(
      join(customSkillSource, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: "Use XT records."\nsource: connector\n---\n\n# XT\n',
      'utf8'
    )
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [customSkillName],
      availability: () => undefined,
      isRefreshing: () => false
    })

    const backend = await resolveActiveBackend(service, {
      systemPromptAppends: ['Stable Open Science app guidance.']
    })

    expect(backend.persistentSystemPrompt).toContain('Stable Open Science app guidance.')
    const appInstructions = await readFile(
      join(storageRoot, 'opencode', 'config', 'opencode', 'instructions', 'open-science.md'),
      'utf8'
    )
    expect(appInstructions).toContain('Stable Open Science app guidance.')
    expect(appInstructions).toContain(join(storageRoot, 'skills', 'personal'))
    expect(appInstructions).toContain(join(storageRoot, 'skills', 'imported'))

    const baseline = await readFile(
      join(storageRoot, 'opencode', 'config', 'opencode', 'instructions', 'connectors.md'),
      'utf8'
    )
    expect(baseline).toContain('host.mcp')
    expect(baseline).toContain('mcp-*')
    expect(baseline).toContain('Load the matching `mcp-*` skill before the first `host.mcp` call')
    expect(baseline).toContain('Never guess a connector server or method name')
    expect(baseline).toContain('`mcp-xt`')
    expect(baseline).not.toContain('Use XT records.')
    expect(baseline).not.toContain('host.mcp("xt"')
    expect(baseline).not.toContain('pubchem_get_compounds')
    expect(baseline).not.toContain('search_articles')
    expect(baseline).not.toContain('```json')
    expect(baseline.length).toBeLessThan(2_500)

    const chemistrySkill = await readFile(
      join(storageRoot, 'opencode', 'config', 'opencode', 'skills', 'mcp-chemistry', 'SKILL.md'),
      'utf8'
    )
    expect(chemistrySkill).toContain('pubchem_get_compounds')
    expect(chemistrySkill).toContain('**Input:**')
    expect(chemistrySkill).not.toContain('```json')
    await expect(
      readFile(
        join(storageRoot, 'opencode', 'config', 'opencode', 'skills', customSkillName, 'SKILL.md'),
        'utf8'
      )
    ).resolves.toContain('Use XT records.')
  })

  it('rejects invalid custom model limits when IPC bypasses the form', async () => {
    const service = createService()
    const base = {
      type: 'custom' as const,
      name: 'Gateway',
      baseUrl: 'https://g',
      model: 'm',
      key: 'k'
    }

    for (const field of ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const) {
      await expect(service.upsertProvider({ ...base, [field]: 0 })).rejects.toThrow(
        /positive whole number/i
      )
      await expect(service.upsertProvider({ ...base, [field]: 1.5 })).rejects.toThrow(
        /positive whole number/i
      )
    }
  })

  it('keeps the stored key when an edit omits a new key', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k1'
      })
    ).providers[0]

    await service.upsertProvider({ id: created.id, type: 'custom', name: 'Renamed' })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.name).toBe('Renamed')
    expect(stored.keyRef).toBeDefined()
  })

  it('rejects an incomplete custom provider and never persists it', async () => {
    const service = createService()

    // Missing base URL / model / key each block the save with a clear error.
    await expect(
      service.upsertProvider({ type: 'custom', name: 'No base URL', model: 'm', key: 'k' })
    ).rejects.toThrow(/base url is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No model',
        baseUrl: 'https://g/v1',
        key: 'k'
      })
    ).rejects.toThrow(/model is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No key',
        baseUrl: 'https://g/v1',
        model: 'm'
      })
    ).rejects.toThrow(/api key is required/i)

    // None of the rejected drafts reached disk.
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('accepts a custom Responses-compatible gateway', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Responses gateway',
      apiEndpoints: ['responses'],
      baseUrl: 'https://gateway.example/v1',
      model: 'codex-model',
      key: 'k'
    })

    expect(snapshot.providers[0]).toMatchObject({
      apiEndpoints: ['responses'],
      baseUrl: 'https://gateway.example/v1'
    })
  })
})

describe('SettingsService: validation', () => {
  it('records lastValidatedAt for a saved provider on success', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it('validates a saved official provider with its pending model before activation', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(validAnthropicResponse())
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'OpenCode Zen',
        vendorId: 'opencode',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({
      providerId: created.id,
      model: 'claude-fable-5'
    })

    expect(result).toMatchObject({ ok: true, category: 'ok', applied: true })
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/messages')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: 'claude-fable-5'
    })

    const settings = await repository.getSettings()
    expect(settings.activeModel).toBeUndefined()
    expect(settings.providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it('probes over the proxy-aware net.fetch, not Node global fetch directly', async () => {
    const service = createService()
    // A direct undici fetch ignores the system proxy, so an official vendor reachable only through a
    // proxy fails as a false network error. The probe must go through net.fetch (Chromium stack).
    mockedNet.fetch.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })

    expect(mockedNet.fetch).toHaveBeenCalledTimes(1)
    expect(mockedNet.fetch.mock.calls[0][0]).toContain('https://g')
  })

  it('records the failure (not lastValidatedAt) for a saved provider on failure', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: false, category: 'auth' })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth' })
    expect(stored.lastValidationFailure?.at).toBeGreaterThan(0)
  })

  it('reports incompatible (no network probe) when the provider cannot drive the active framework', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // Default framework is Claude Code (Anthropic /v1/messages only); an OpenAI-only gateway can't drive
    // it, so testing must fail with the pairing reason rather than firing a misleading /v1/messages probe.
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['openai']
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: false, category: 'incompatible', applied: true })
    expect(result.message).toContain('/v1/chat/completions')
    expect(fetchMock).not.toHaveBeenCalled()

    const stored = (await repository.getSettings()).providers.find((p) => p.id === created.id)
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toMatchObject({ category: 'incompatible' })
  })

  it('probes normally once the active framework can drive the provider', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['openai']
      })
    ).providers[0]

    // OpenCode accepts /v1/chat/completions, so the same provider now validates over the network.
    await service.setAgentFramework('opencode')
    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/chat/completions')
  })

  it('probes the route the active framework drives for a multi-route provider', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // A provider that speaks both routes. preferredEndpoint would pick OpenAI globally, but Claude Code
    // runs /v1/messages — so the probe must hit that, or a passing test wouldn't prove the real route.
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['anthropic', 'openai']
      })
    ).providers[0]

    // Default framework is Claude Code (Anthropic only).
    await service.validateProvider({ providerId: created.id })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/messages')

    // The same provider under OpenCode should instead be probed on the OpenAI route it will run.
    await service.setAgentFramework('opencode')
    await service.validateProvider({ providerId: created.id })
    expect(fetchMock.mock.calls[1][0]).toContain('/v1/chat/completions')
  })

  it('clears a recorded failure once a later validation succeeds', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 })
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    fetchMock.mockResolvedValue(validAnthropicResponse())
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidationFailure).toBeUndefined()
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
  })

  it('invalidates an earlier success when the latest validation fails', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(validAnthropicResponse())
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    fetchMock.mockResolvedValue({ status: 401 })
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth' })
  })

  it('marks a superseded validation as not applied and leaves the newer stamp intact', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // A slow probe lets a second, faster validation start and bump the generation before the first
    // resolves. The first is stale: it must report applied:false and never write over the newer run.
    let releaseSlow!: () => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSlow = () => resolve({ status: 401 } as Response)
          })
      )
      .mockResolvedValue(validAnthropicResponse())
    vi.stubGlobal('fetch', fetchMock)

    const slow = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const fast = await service.validateProvider({ providerId: created.id })
    expect(fast).toMatchObject({ ok: true, applied: true })

    releaseSlow()
    await expect(slow).resolves.toMatchObject({ ok: false, applied: false })

    // The newer success stands: the superseded failure must not have cleared it.
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it.each([
    ['base URL', { baseUrl: 'https://other.example/v1' }],
    ['model', { model: 'm2' }],
    ['API format', { apiEndpoints: ['responses' as const] }]
  ])('invalidates prior validation when the custom provider %s changes', async (_label, change) => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        apiEndpoints: ['anthropic'],
        key: 'k'
      })
    ).providers[0]
    await service.validateProvider({ providerId: created.id })

    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', ...change })

    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeUndefined()
  })

  it('drops a recorded failure when credentials change on edit', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    // Editing with a new key changes credentials, so the stale failure is dropped (re-test needed).
    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', key: 'k2' })

    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeUndefined()
  })

  it('does not let a late validation overwrite a provider edited while the request was in flight', async () => {
    const service = createService()
    let resolveFetch!: (response: { status: number }) => void
    const fetchMock = vi.fn(
      () => new Promise<{ status: number }>((resolve) => (resolveFetch = resolve))
    )
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm1',
        key: 'k'
      })
    ).providers[0]

    const validation = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', model: 'm2' })
    resolveFetch({ status: 200 })
    await validation

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.model).toBe('m2')
    expect(stored.lastValidatedAt).toBeUndefined()
  })

  it('does not let a late validation recreate a deleted provider', async () => {
    const service = createService()
    let resolveFetch!: (response: { status: number }) => void
    const fetchMock = vi.fn(
      () => new Promise<{ status: number }>((resolve) => (resolveFetch = resolve))
    )
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const validation = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await service.deleteProvider(created.id)
    resolveFetch({ status: 200 })
    await validation

    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('ignores an older validation result that finishes after a newer success', async () => {
    const service = createService()
    const resolvers: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)))
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const older = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const newer = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    resolvers[1](validAnthropicResponse())
    await newer
    resolvers[0](new Response(null, { status: 401 }))
    await older

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('requires the streaming tool-call contract for a provider Codex reaches through the bridge', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(validBridgeToolCallResponse())
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Chat Gateway',
        apiEndpoints: ['openai'],
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // Codex will translate Responses requests through this provider's Chat Completions endpoint, so
    // validation must exercise the same streaming function-call contract before recording success.
    await repository.setAgentFramework('codex')
    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidationFailure).toBeUndefined()

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(fetchMock.mock.calls[0][0]).toBe('https://g/v1/chat/completions')
    expect(body).toMatchObject({
      stream: true,
      tools: [{ type: 'function', function: { name: 'open_science_bridge_probe' } }]
    })
  })
})

describe('SettingsService: preflight & spawn config', () => {
  it('gates on a detected claude and a validated active provider', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))

    // Seed an existing executable path so the launch re-check passes.
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // Before validation/activation the provider gate is closed.
    expect(await service.getPreflight()).toMatchObject({
      claudeReady: true,
      activeProviderReady: false
    })

    await service.validateProvider({ providerId: created.id })
    await service.setActiveProvider(created.id)

    expect(await service.getPreflight()).toEqual({
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      codebuddyReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: true
    })
  })

  it('closes the provider gate when the active shared Claude session is signed out', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: false
      }),
      loginShared: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.loginClaudeShared()
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({
      claudeReady: true,
      activeProviderReady: false
    })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('briefly caches shared Claude auth status and rechecks it after the cache expires', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
        getStatus: vi.fn().mockResolvedValue({
          supported: true,
          authenticated: true
        }),
        loginShared: vi.fn(),
        cancelLogin: vi.fn()
      }
      const service = createService(undefined, { claudeSharedAuth })
      await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
      await repository.upsertProvider({
        id: CLAUDE_SHARED_PROVIDER_ID,
        type: 'claude-shared',
        name: 'Claude subscription',
        lastValidatedAt: 1
      })
      await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

      await service.getPreflight()
      await service.getPreflight()

      expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

      now += 5_001
      await service.getPreflight()

      expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('shares one in-flight shared Claude status check across concurrent preflights', async () => {
    let resolveStatus:
      ((status: { supported: boolean; authenticated: boolean }) => void) | undefined
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn(
        () =>
          new Promise<{ supported: boolean; authenticated: boolean }>((resolve) => {
            resolveStatus = resolve
          })
      ),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const first = service.getPreflight()
    const second = service.getPreflight()
    await vi.waitFor(() => expect(claudeSharedAuth.getStatus).toHaveBeenCalled())

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
    resolveStatus?.({ supported: true, authenticated: true })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ activeProviderReady: true }),
      expect.objectContaining({ activeProviderReady: true })
    ])
  })

  it('does not cache a shared Claude status that resolves after login invalidation', async () => {
    let resolveStaleStatus:
      ((status: { supported: boolean; authenticated: boolean }) => void) | undefined
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ supported: boolean; authenticated: boolean }>((resolve) => {
              resolveStaleStatus = resolve
            })
        )
        .mockResolvedValueOnce({ supported: true, authenticated: true }),
      loginShared: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const stalePreflight = service.getPreflight()
    await vi.waitFor(() => expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce())
    await service.loginClaudeShared()
    resolveStaleStatus?.({ supported: true, authenticated: false })
    await expect(stalePreflight).resolves.toMatchObject({ activeProviderReady: false })

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('invalidates a stale shared Claude status after browser login', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ supported: true, authenticated: false })
        .mockResolvedValueOnce({ supported: true, authenticated: true }),
      loginShared: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: false })
    await service.loginClaudeShared()
    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('reuses an explicit shared Claude status check in the next preflight', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(
      service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })
    ).resolves.toMatchObject({ ok: true })
    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('does not reuse an authenticated shared Claude cache after app disconnect', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ supported: true, authenticated: true })
        .mockResolvedValueOnce({ supported: true, authenticated: false }),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, { claudeSharedAuth })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })
    await service.logoutClaudeShared()
    const disconnectedProvider = (await repository.getSettings()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (!disconnectedProvider) throw new Error('shared Claude provider not found')
    await repository.upsertProvider({ ...disconnectedProvider, lastValidatedAt: 2 })

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: false })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('does not report claude ready when the recorded binary exists but fails --version', async () => {
    // Executable-but-corrupt runtime: execPath is a real file (X_OK passes) yet `--version` fails.
    // Preflight must validate via --version like the env check, so this must NOT pass as ready.
    const service = createService({ found: false })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    const preflight = await service.getPreflight()

    expect(preflight.claudeReady).toBe(false)
    expect(preflight.agentReady).toBe(false)
  })

  it('does not report opencode ready when the recorded binary exists but fails --version', async () => {
    // Same for OpenCode: the recorded path is a real executable, but its --version probe fails
    // (no opencodeDetected declared, so the injected getVersion returns undefined for it).
    const service = createService({ found: true, path: '/bin/claude', version: '2.1.0' })
    await repository.setOpencodeInfo(execPath, '1.18.3')

    const preflight = await service.getPreflight()

    expect(preflight.opencodeReady).toBe(false)
  })

  it('detects Codex and exposes readiness for its selected adapter', async () => {
    const adapterPath = '/data/codex-managed/adapter/dist/index.js'
    const nativePath = '/data/codex-managed/codex/vendor/target/bin/codex'
    const service = createService(undefined, {
      codexDetected: {
        path: adapterPath,
        version: 'codex-acp 1.6.2',
        nativePath,
        nativeVersion: 'codex-cli 0.144.6'
      }
    })

    await repository.setAgentFramework('codex')
    const snapshot = await service.detectCodex()

    expect(snapshot.codex).toEqual({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativeVersion: '0.144.6'
    })
    expect(await service.getPreflight()).toMatchObject({ codexReady: true, agentReady: true })
  })

  it('reports both Codex components ready for an external adapter whose native CLI is on the augmented PATH', async () => {
    // Regression (spec P1): an external adapter pairs successfully via the augmented PATH, but the
    // independent native-CLI probe must search the SAME dirs (/usr/local/bin here) so it agrees with
    // the smoke test. Otherwise native CLI would show missing and block Continue.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.6.2' },
      codexExternalNative: { path: '/usr/local/bin/codex', version: 'codex-cli 0.144.6' }
    })

    const result = await service.checkEnvironment()
    const agentRows = result.checks.filter((check) => check.id === 'agent')
    const codexRows = agentRows.filter((row) => row.label.startsWith('Codex'))

    expect(codexRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Codex native CLI:passed',
      'Codex ACP adapter:passed'
    ])
    const nativeRow = codexRows.find((row) => row.label === 'Codex native CLI')
    expect(nativeRow?.detail).toBe('/usr/local/bin/codex')
    expect(result.ready).toBe(true)
  })

  it('replaces a cached global adapter with the app-managed adapter while retaining global native Codex', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const managedAdapterPath = managedCodexAdapterEntry(storageRoot)
    const globalAdapterPath = '/opt/tools/codex-acp'
    const globalNativePath = '/usr/local/bin/codex'
    const service = createService(undefined, {
      codexDetected: { path: globalAdapterPath, version: 'codex-acp 1.6.2' },
      codexExternalNative: { path: globalNativePath, version: 'codex-cli 0.144.6' },
      managedCodexAdapterPath: managedAdapterPath
    })
    await repository.setAgentFramework('codex')
    await repository.setCodexInfo({
      resolvedPath: globalAdapterPath,
      version: '1.6.2',
      nativePath: globalNativePath,
      nativeVersion: '0.144.6'
    })

    const result = await service.checkEnvironment()

    expect(result.ready).toBe(true)
    expect((await repository.getSettings()).codex).toEqual({
      resolvedPath: managedAdapterPath,
      version: '1.6.2',
      nativePath: globalNativePath,
      nativeVersion: '0.144.6'
    })
  })

  it('requires an explicit native Codex path for the app-managed adapter pairing', async () => {
    // The adapter must receive a pinned CODEX_PATH. A smoke result without a discoverable native
    // executable is not sufficient because runtime must not fall back to ambient profile discovery.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.6.2' }
      // No codexExternalNative: probe finds nothing, but smoke test passed.
    })

    const result = await service.checkEnvironment()
    const codexRows = result.checks
      .filter((check) => check.id === 'agent')
      .filter((row) => row.label.startsWith('Codex'))

    expect(codexRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Codex native CLI:failed',
      'Codex ACP adapter:passed'
    ])
    expect(result.ready).toBe(false)
  })

  it('marks the Codex adapter row failed when it is present but fails the ACP handshake', async () => {
    // Regression (spec P1): an adapter whose --version succeeds but whose ACP initialize fails must
    // surface as failed, not "ready". Full detection returns nothing, so component-level detection
    // records adapterFound=true with a smoke-test-failed reason that the UI must honor.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.6.2' },
      codexSmokeOk: false
    })

    const result = await service.checkEnvironment()
    const adapterRow = result.checks.find(
      (check) => check.id === 'agent' && check.label === 'Codex ACP adapter'
    )

    expect(adapterRow?.status).toBe('failed')
    expect(adapterRow?.summary).toContain('failed to initialize')
    expect(result.ready).toBe(false)
  })

  it('does not mark an app-managed Codex pair ready when its native binary is broken', async () => {
    const { managedCodexAdapterEntry, managedCodexBinary } = await import('./managed-codex')
    const service = createService(undefined, {
      codexDetected: {
        path: managedCodexAdapterEntry(storageRoot),
        version: 'codex-acp 1.6.2',
        nativePath: managedCodexBinary(storageRoot)
      }
    })
    await repository.setAgentFramework('codex')
    await service.detectCodex()

    expect(await service.getPreflight()).toMatchObject({ codexReady: false, agentReady: false })
  })

  it('resolves a forced Codex backend only for a Responses provider', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await service.detectCodex()
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'OpenAI Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    const backend = await resolveActiveBackend(service, {
      systemPromptAppends: ['Stable Open Science developer guidance.']
    })
    const selection = await service.captureActiveAgentBackendSelection()

    expect(backend.framework.id).toBe('codex')
    expect(backend.executablePath).toBe(adapterPath)
    // Native Responses keeps the provider model while the compatibility loopback owns retry policy.
    expect(backend.sessionModel).toBe('gpt-5-codex')
    expect(backend.env).toMatchObject({
      CODEX_HOME: join(storageRoot, 'codex'),
      CODEX_PATH: '/data/codex-managed/native/codex',
      NO_BROWSER: '1'
    })
    expect(backend.env.CODEX_API_KEY).toBeUndefined()
    const developerInstructions = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
      .developer_instructions as string
    expect(developerInstructions).toContain('Stable Open Science developer guidance.')
    expect(developerInstructions).toContain(
      'Load the matching `mcp-*` skill before the first `host.mcp` call'
    )
    expect(developerInstructions).not.toContain('search_articles')
    expect(backend.persistentSystemPrompt).toBe(developerInstructions)
    expect(backend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: expect.stringMatching(/^[a-f0-9]+$/) } }
    })
    expect(JSON.stringify(backend)).not.toContain('test-key')
    // Stable guidance only tells Codex to load the matching Skill; exact connector methods remain
    // progressive content and must not be copied into the baseline.
    expect(backend.systemPromptAppends).toBeUndefined()

    expect(selection).toEqual({ frameworkId: 'codex' })
    expect(selection).not.toHaveProperty('key')

    // The generation stays on Codex after global framework settings move elsewhere; credentials are
    // decrypted again from the active provider only when another spawn is actually needed.
    await repository.setAgentFramework('claude-code')
    const pinnedBackend = await service.resolveAgentBackend(selection)
    expect(pinnedBackend.framework.id).toBe('codex')
    expect(pinnedBackend.backendId).toBe(`codex:${provider.id}`)
    expect(pinnedBackend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: expect.stringMatching(/^[a-f0-9]+$/) } }
    })
    expect(JSON.stringify(pinnedBackend)).not.toContain('test-key')
  })

  it('trusts bundled model metadata only after a live native version probe', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    const nativePath = join(storageRoot, 'bin', 'codex')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await writeFile(nativePath, '#!/usr/bin/env node\n', 'utf8')
    await chmod(adapterPath, 0o755)
    await chmod(nativePath, 0o755)
    const service = createService(undefined, {
      codexDetected: {
        path: adapterPath,
        version: 'codex-acp 1.6.2',
        nativePath,
        nativeVersion: 'codex-cli 0.144.6'
      }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'OpenAI',
        vendorId: 'openai',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'gpt-5.4')
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    const backend = await resolveActiveBackend(service)

    expect(JSON.parse(backend.env.CODEX_CONFIG ?? '{}')).not.toHaveProperty('model_catalog_json')
  })

  it('ignores a stale trusted native version when the live probe is unrecognized', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    const nativePath = join(storageRoot, 'bin', 'codex')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await writeFile(nativePath, '#!/usr/bin/env node\n', 'utf8')
    await chmod(adapterPath, 0o755)
    await chmod(nativePath, 0o755)
    const service = createService(undefined, {
      codexDetected: {
        path: adapterPath,
        version: 'codex-acp 1.6.2',
        nativePath,
        nativeVersion: 'codex-cli 0.144.2'
      }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath,
      nativeVersion: '0.144.6'
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'OpenAI',
        vendorId: 'openai',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'gpt-5.4')
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    const backend = await resolveActiveBackend(service)

    expect(JSON.parse(backend.env.CODEX_CONFIG ?? '{}')).toHaveProperty('model_catalog_json')
  })

  it('patches an existing app-managed Codex adapter before returning the backend', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const adapterPath = managedCodexAdapterEntry(storageRoot)
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(
      adapterPath,
      [
        '  createUsageUpdate(params) {',
        '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
        '  }',
        MANAGED_CODEX_ADAPTER_FIXTURE
      ].join('\n')
    )
    await chmod(adapterPath, 0o755)
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const service = createService(undefined, { managedCodexAdapterPath: adapterPath })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Managed Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const backend = await resolveActiveBackend(service)

    expect(backend.executablePath).toBe(adapterPath)
    expect(await readFile(adapterPath, 'utf8')).toContain(
      'contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0)'
    )
  })

  it('spawns the app-managed adapter while using a detected global native Codex executable', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const managedAdapterPath = managedCodexAdapterEntry(storageRoot)
    const globalAdapterPath = join(storageRoot, 'global', 'codex-acp')
    const globalNativePath = join(storageRoot, 'global', 'codex')
    await mkdir(dirname(managedAdapterPath), { recursive: true })
    await mkdir(dirname(globalAdapterPath), { recursive: true })
    await writeFile(managedAdapterPath, `#!/usr/bin/env node\n${MANAGED_CODEX_ADAPTER_FIXTURE}`)
    await writeFile(globalAdapterPath, '#!/usr/bin/env node\n')
    await writeFile(globalNativePath, '#!/usr/bin/env node\n')
    await chmod(managedAdapterPath, 0o755)
    await chmod(globalAdapterPath, 0o755)
    await chmod(globalNativePath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: globalAdapterPath, version: 'codex-acp 1.6.2' },
      codexExternalNative: { path: globalNativePath, version: 'codex-cli 0.144.6' },
      managedCodexAdapterPath: managedAdapterPath
    })
    await repository.setCodexInfo({
      resolvedPath: globalAdapterPath,
      version: '1.6.2',
      nativePath: globalNativePath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Managed Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const backend = await resolveActiveBackend(service)

    expect(backend.executablePath).toBe(managedAdapterPath)
    expect(backend.env.CODEX_PATH).toBe(globalNativePath)
    expect(backend.env.CODEX_HOME).toBe(join(storageRoot, 'codex'))
  })

  it('fails closed instead of spawning a detected global Codex ACP adapter', async () => {
    const globalAdapterPath = join(storageRoot, 'global', 'codex-acp')
    const globalNativePath = join(storageRoot, 'global', 'codex')
    await mkdir(dirname(globalAdapterPath), { recursive: true })
    await writeFile(globalAdapterPath, '#!/usr/bin/env node\n')
    await writeFile(globalNativePath, '#!/usr/bin/env node\n')
    await chmod(globalAdapterPath, 0o755)
    await chmod(globalNativePath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: globalAdapterPath, version: 'codex-acp 1.6.2' },
      codexExternalNative: { path: globalNativePath, version: 'codex-cli 0.144.6' },
      managedCodexAdapterPath: join(storageRoot, 'missing-managed-adapter', 'index.js')
    })
    await repository.setCodexInfo({
      resolvedPath: globalAdapterPath,
      version: '1.6.2',
      nativePath: globalNativePath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Managed Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    await expect(resolveActiveBackend(service)).rejects.toThrow(
      'Open Science Codex ACP adapter not found. Install Codex in settings.'
    )
  })

  it('fails closed when the controlled adapter has no explicit native Codex path', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const managedAdapterPath = managedCodexAdapterEntry(storageRoot)
    await mkdir(dirname(managedAdapterPath), { recursive: true })
    await writeFile(managedAdapterPath, '#!/usr/bin/env node\n')
    await chmod(managedAdapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: managedAdapterPath, version: 'codex-acp 1.6.2' },
      managedCodexAdapterPath: managedAdapterPath
    })
    await repository.setCodexInfo({ resolvedPath: managedAdapterPath, version: '1.6.2' })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Managed Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    await expect(resolveActiveBackend(service)).rejects.toThrow(
      'Codex native executable not found. Re-detect or install Codex in settings.'
    )
  })

  it('requires a fresh sign-in after migrating a validated codex-shared subscription', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: CODEX_SHARED_PROVIDER_ID,
      type: 'codex-shared',
      name: 'codex-shared',
      apiEndpoints: ['responses'],
      lastValidatedAt: 100
    })
    await service.setActiveProvider(CODEX_SHARED_PROVIDER_ID, 'gpt-5.6-terra')

    expect(await service.getPreflight()).toMatchObject({ activeProviderReady: false })
    const migratedProviders = (await repository.getSettings()).providers

    expect(migratedProviders).toEqual([
      expect.objectContaining({
        id: CODEX_ISOLATED_PROVIDER_ID,
        type: 'codex-isolated'
      })
    ])
    expect(migratedProviders[0].lastValidatedAt).toBeUndefined()
  })

  it('resolves a validated codex-isolated subscription without API routing', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' },
      resolveCodexProxyEnvironment: () =>
        Promise.resolve({
          HTTP_PROXY: 'http://proxy.example.test:3128',
          HTTPS_PROXY: 'http://proxy.example.test:3128',
          http_proxy: 'http://proxy.example.test:3128',
          https_proxy: 'http://proxy.example.test:3128',
          NO_PROXY: 'localhost,127.0.0.1,::1',
          no_proxy: 'localhost,127.0.0.1,::1'
        })
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: CODEX_ISOLATED_PROVIDER_ID,
      type: 'codex-isolated',
      name: 'codex-isolated',
      apiEndpoints: ['responses'],
      lastValidatedAt: 100
    })
    await service.setActiveProvider(CODEX_ISOLATED_PROVIDER_ID, 'gpt-5.6-terra')
    const configPath = join(storageRoot, 'codex', 'config.toml')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      'model = "account-default"\ncli_auth_credentials_store = "ephemeral"\n',
      'utf8'
    )

    expect(await service.getPreflight()).toMatchObject({ activeProviderReady: true })
    const backend = await resolveActiveBackend(service)

    expect(backend.providerId).toBe(CODEX_SUBSCRIPTION_PROVIDER_ID)
    expect(backend.backendId).toBe('codex:builtin-codex-isolated')
    expect(backend.sessionModel).toBe('gpt-5.6-terra')
    expect(backend.sessionModelRequired).toBe(true)
    expect(backend.authentication).toBeUndefined()
    expect(backend.providerConfiguration).toBeUndefined()
    expect(backend.env.CODEX_API_KEY).toBeUndefined()
    const codexConfig = JSON.parse(backend.env.CODEX_CONFIG ?? '{}') as {
      model?: string
      developer_instructions?: string
    }
    expect(codexConfig.model).toBe('gpt-5.6-terra')
    expect(codexConfig.developer_instructions).toContain(
      'Load the matching `mcp-*` skill before the first `host.mcp` call'
    )
    expect(codexConfig.developer_instructions).not.toContain('search_articles')
    expect(backend.env.MODEL_PROVIDER).toBeUndefined()
    expect(backend.env.NO_BROWSER).toBeUndefined()
    expect(backend.env.CODEX_PATH).toBe('/data/codex-managed/native/codex')
    expect(backend.env.CODEX_HOME).toBe(join(storageRoot, 'codex-subscription'))
    expect(backend.env.HTTPS_PROXY).toBe('http://proxy.example.test:3128')
    expect(backend.env.NO_PROXY).toContain('127.0.0.1')
    expect(backend.proxyEnvironmentMode).toBe('replace')
    expect(await readFile(join(storageRoot, 'codex-subscription', 'config.toml'), 'utf8')).toBe(
      'cli_auth_credentials_store = "file"\n'
    )
    expect(await readFile(join(storageRoot, 'codex', 'config.toml'), 'utf8')).toBe(
      'model = "account-default"\ncli_auth_credentials_store = "ephemeral"\n'
    )

    await service.setSubagentModel({ mode: 'inherit' })
    await expect(
      service.resolveSubagentExecutionModel('codex', {
        providerId: backend.providerId,
        backendId: backend.backendId,
        modelRoute: backend.modelRoute,
        model: backend.sessionModel,
        reasoningEffort: backend.sessionEffort
      })
    ).resolves.toMatchObject({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      backendId: 'codex:builtin-codex-isolated'
    })

    const fallbackService = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' },
      resolveCodexProxyEnvironment: () => Promise.resolve(undefined)
    })
    const fallbackBackend = await resolveActiveBackend(fallbackService)

    expect(fallbackBackend.proxyEnvironmentMode).toBe('inherit')
    expect(fallbackBackend.env).not.toHaveProperty('HTTP_PROXY')
    expect(fallbackBackend.env).not.toHaveProperty('HTTPS_PROXY')
  })

  it('resolves an unpinned subscription backend to the Codex account default', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: CODEX_SHARED_PROVIDER_ID,
      type: 'codex-shared',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      lastValidatedAt: 100
    })
    await service.setActiveProvider(CODEX_SHARED_PROVIDER_ID)

    const backend = await resolveActiveBackend(service)

    expect(backend.sessionModel).toBeUndefined()
    expect(backend.sessionModelRequired).toBeUndefined()
  })

  it('declares the model image capability in the resolved OpenCode backend config', async () => {
    // AgentBackendResolver honors this forced-framework env above stored settings; set it
    // explicitly (a prior Codex test leaves it stubbed to 'codex') so this resolves OpenCode.
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({ type: 'official', name: 'Kimi', vendorId: 'kimi', key: 'k' })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const backend = await resolveActiveBackend(service)

    // End-to-end guard for the whole capability chain: resolveProvider must carry supportsImageInput
    // for the multimodal default (kimi-k3) and prepareModelConfig must surface it, so OpenCode receives
    // the model as image-capable instead of a bare entry whose image parts it would strip. Deleting the
    // wiring in resolveProvider or buildModelCapabilities makes this fail.
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const agentProviderId = opencodeTransportProviderId(provider.id, 'kimi-k3')
    expect(content.provider[agentProviderId].models['kimi-k3']).toEqual({
      attachment: true,
      modalities: { input: ['text', 'image'] },
      limit: { context: 1_000_000, output: 32_000 }
    })
    expect(backend.args).toEqual(['--port', '42424', '--hostname', '127.0.0.1'])
    expect(backend.opencodeUsageApi).toEqual({
      baseUrl: 'http://127.0.0.1:42424',
      authorization: `Basic ${Buffer.from(`opencode:${backend.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
    })
  })

  it('injects the selected official model context window into OpenCode', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    await service.setActiveProvider(provider.id, 'glm-5.1')
    const smallBackend = await resolveActiveBackend(service)
    const smallConfig = JSON.parse(smallBackend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(smallBackend.contextWindow).toBe(200_000)
    const smallAgentProviderId = opencodeTransportProviderId(provider.id, 'glm-5.1')
    expect(smallConfig.provider[smallAgentProviderId].models['glm-5.1'].limit.context).toBe(200_000)

    await service.setActiveProvider(provider.id, 'glm-5.2')
    const largeBackend = await resolveActiveBackend(service)
    const largeConfig = JSON.parse(largeBackend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(largeBackend.contextWindow).toBe(1_000_000)
    const largeAgentProviderId = opencodeTransportProviderId(provider.id, 'glm-5.2')
    expect(largeConfig.provider[largeAgentProviderId].models['glm-5.2'].limit.context).toBe(
      1_000_000
    )
  })

  it('resolves a Chat Completions provider through the Codex Responses bridge', async () => {
    const localFetch = globalThis.fetch
    let upstreamRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-service-bridge',
                model: 'deepseek-v4-flash',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Chat Gateway',
        apiEndpoints: ['openai'],
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        reasoningEffortPreset: 'none-high',
        reasoningEffortTransport: 'deepseek',
        key: 'test-key'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...storedProvider,
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(provider.id)
    await repository.setReasoningEffort('low')

    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await resolveActiveBackend(service)

    // Chat Completions provider ⇒ bridge ⇒ Codex runs the classic-tool-mode catalog model so it
    // advertises the shell_command function tool the bridge can forward (CODEX_BRIDGE_MODEL).
    expect(backend.sessionModel).toBe('gpt-5.4')
    expect(backend.sessionEffort).toBe('none')
    expect(backend.contextWindow).toBe(1_000_000)
    expect(backend.providerConfiguration).toEqual({
      providerId: 'openai',
      apiType: 'openai',
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
      headers: { authorization: expect.stringMatching(/^Bearer [a-f0-9]+$/) }
    })
    expect(backend.env.CODEX_CONFIG).toContain('"wire_api":"responses"')
    expect(backend.env.CODEX_CONFIG).not.toContain('test-key')
    const developerInstructions = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
      .developer_instructions as string
    expect(developerInstructions).toContain(
      'Load the matching `mcp-*` skill before the first `host.mcp` call'
    )
    expect(developerInstructions).toContain('Never guess a connector server or method name')
    expect(developerInstructions).not.toContain('search_articles')
    expect(backend.persistentSystemPrompt).toBe(developerInstructions)

    const bridgeResponse = await localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: backend.providerConfiguration?.headers.authorization ?? '',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'Use PubMed to find cancer papers',
        stream: true
      })
    })
    await bridgeResponse.text()
    expect(upstreamRequest).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_notebook__ask_user_question'
          })
        }),
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_notebook__notebook_execute',
            description: expect.stringContaining('MUST call host.mcp')
          })
        }),
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_artifacts__write_artifact_file'
          })
        }),
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_skills__request_skill_import'
          })
        })
      ])
    })
    expect(JSON.stringify(upstreamRequest?.tools)).not.toContain(
      'mcp__open_science_activity__begin_activity_group'
    )
    const upstreamMessages = JSON.stringify(upstreamRequest?.messages)
    expect(upstreamRequest).toMatchObject({ thinking: { type: 'disabled' } })
    expect(upstreamRequest).not.toHaveProperty('reasoning_effort')
    expect(upstreamMessages).not.toContain('<open_science_connector_instructions>')
    expect(upstreamMessages).not.toContain('host.mcp("pubmed", "search_articles"')

    // Connector skill docs (host.mcp guidance) must be materialized into Codex's own home, not only
    // the Claude config dir, or bridged Codex never learns to reach connectors via the notebook.
    const pubmedSkill = await readFile(
      join(storageRoot, 'codex', 'skills', 'mcp-pubmed', 'SKILL.md'),
      'utf8'
    )
    expect(pubmedSkill).toContain('host.mcp')

    await backend.responsesBridgeLease?.release()
    await repository.setConversationSkillImportEnabled(false)
    upstreamRequest = undefined
    const disabledBackend = await resolveActiveBackend(service)
    const disabledBridgeResponse = await localFetch(
      `${disabledBackend.providerConfiguration?.baseUrl}/responses`,
      {
        method: 'POST',
        headers: {
          authorization: disabledBackend.providerConfiguration?.headers.authorization ?? '',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'Inspect this package', stream: true })
      }
    )
    await disabledBridgeResponse.text()
    const capturedDisabledRequest = upstreamRequest as unknown as
      Record<string, unknown> | undefined
    const disabledToolNames = (
      (capturedDisabledRequest?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
    ).map((tool) => tool.function?.name)
    expect(disabledToolNames).toContain('mcp__open_science_notebook__notebook_execute')
    expect(disabledToolNames).not.toContain('mcp__open_science_skills__request_skill_import')
    await disabledBackend.responsesBridgeLease?.release()
  })

  it('keeps bridged Codex backends pinned to the provider target they were created for', async () => {
    const localFetch = globalThis.fetch
    const upstreamRequests: Array<{ url: string; authorization: string; model: unknown }> = []
    const upstreamToolNames: string[][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const tools = Array.isArray(body.tools) ? body.tools : []
        upstreamToolNames.push(
          tools.map((tool) =>
            String((tool as { function?: { name?: unknown } }).function?.name ?? '')
          )
        )
        upstreamRequests.push({
          url: String(url),
          authorization: String((init?.headers as Record<string, string>)?.authorization ?? ''),
          model: body.model
        })
        return new Response(
          [
            `data: ${JSON.stringify({
              id: `chat-${upstreamRequests.length}`,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}`,
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const first = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Provider One',
        apiEndpoints: ['openai'],
        baseUrl: 'https://one.example/v1',
        model: 'model-one',
        key: 'key-one'
      })
    ).providers[0]
    const second = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Provider Two',
        apiEndpoints: ['openai'],
        baseUrl: 'https://two.example/v1',
        model: 'model-two',
        key: 'key-two'
      })
    ).providers.find((provider) => provider.name === 'Provider Two')!
    for (const provider of (await repository.getSettings()).providers) {
      await repository.upsertProvider({ ...provider, lastValidatedAt: Date.now() })
    }
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    await service.setActiveProvider(first.id)
    const firstBackend = await resolveActiveBackend(service)
    await service.setActiveProvider(second.id)
    const secondBackend = await resolveActiveBackend(service)

    expect(firstBackend.providerConfiguration?.baseUrl).not.toBe(
      secondBackend.providerConfiguration?.baseUrl
    )

    firstBackend.responsesBridgeLease?.registerReviewerSession('reviewer-one')
    secondBackend.responsesBridgeLease?.registerReviewerSession('reviewer-two')

    const send = async (backend: typeof firstBackend, promptCacheKey: string): Promise<void> => {
      const response = await localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: backend.providerConfiguration?.headers.authorization ?? '',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hello',
          prompt_cache_key: promptCacheKey,
          stream: true,
          tools: [{ type: 'tool_search' }]
        })
      })
      await response.text()
    }
    await send(firstBackend, 'reviewer-one')
    await send(secondBackend, 'reviewer-two')

    expect(upstreamRequests).toEqual([
      {
        url: 'https://one.example/v1/chat/completions',
        authorization: 'Bearer key-one',
        model: 'model-one'
      },
      {
        url: 'https://two.example/v1/chat/completions',
        authorization: 'Bearer key-two',
        model: 'model-two'
      }
    ])
    expect(upstreamToolNames).toEqual([
      expect.arrayContaining(['mcp__open_science_reviewer__submit_findings']),
      expect.arrayContaining(['mcp__open_science_reviewer__submit_findings'])
    ])

    await firstBackend.responsesBridgeLease?.release()
    await secondBackend.responsesBridgeLease?.release()
  })

  it('closes and evicts a responses bridge whose start fails', async () => {
    const startError = new Error('bridge start failed')
    const startSpy = vi.spyOn(ResponsesBridgeClass.prototype, 'start').mockRejectedValue(startError)
    const closeSpy = vi.spyOn(ResponsesBridgeClass.prototype, 'close').mockResolvedValue(undefined)
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Broken bridge provider',
        apiEndpoints: ['openai'],
        baseUrl: 'https://broken.example/v1',
        model: 'model-one',
        key: 'key-one'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...storedProvider, lastValidatedAt: Date.now() })
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    try {
      await expect(resolveActiveBackend(service)).rejects.toBe(startError)
      expect(closeSpy).toHaveBeenCalledOnce()
    } finally {
      startSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  it('routes a native-Responses vendor through the protocol-preserving compatibility proxy', async () => {
    // MiniMax advertises anthropic + openai + responses. It must stay on native Responses while the
    // local proxy flattens Codex namespace tools and restores their namespace on returned calls.
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'MiniMax',
        vendorId: 'minimax',
        region: 'global',
        key: 'mm-secret'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...storedProvider, lastValidatedAt: Date.now() })
    await service.setActiveProvider(provider.id)

    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await resolveActiveBackend(service)

    expect(backend.providerConfiguration).toEqual({
      providerId: 'openai',
      apiType: 'openai',
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
      headers: { authorization: expect.stringMatching(/^Bearer [a-f0-9]+$/) }
    })
    // This is not the Chat Completions bridge: preserve the provider model and native catalog.
    expect(backend.sessionModel).toBe('MiniMax-M3')
    const codexConfig = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
    expect(codexConfig.model_catalog_json).toMatch(
      new RegExp(
        `^${join(storageRoot, 'codex', 'model-catalog-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9]{64}\\.json$`
      )
    )
    expect(codexConfig.model_providers['open-science']).toMatchObject({
      base_url: backend.providerConfiguration?.baseUrl,
      wire_api: 'responses'
    })
    expect(codexConfig.model_providers['open-science']).not.toHaveProperty('requires_openai_auth')
    const modelCatalog = JSON.parse(await readFile(codexConfig.model_catalog_json, 'utf8'))
    expect(modelCatalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'MiniMax-M3',
          context_window: 1_000_000,
          max_context_window: 1_000_000,
          supported_in_api: true,
          default_reasoning_level: null,
          supported_reasoning_levels: [
            { effort: 'none', description: 'None reasoning effort' },
            { effort: 'high', description: 'High reasoning effort' }
          ]
        })
      ])
    )
    expect(backend.authentication).toBeUndefined()
    expect(backend.env.CODEX_CONFIG).not.toContain('mm-secret')

    await backend.responsesBridgeLease?.release()
  })

  it('builds spawn env from the active provider with the decrypted key', async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'm',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(created.id)

    const config = await resolveActiveBackend(service)

    expect(config.executablePath).toBe(execPath)
    expect(config.env).toMatchObject({
      ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      ANTHROPIC_AUTH_TOKEN: expect.stringMatching(/^[a-f0-9]+$/),
      ANTHROPIC_MODEL: 'm',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot)
    })
    expect(JSON.stringify(config)).not.toContain('test-key')
    expect(config.sessionOptions).toMatchObject({
      settings: {
        skipWebFetchPreflight: true,
        permissions: { ask: ['WebFetch'] }
      }
    })
    expect(claudeSkillProjectionRoot(config)).toContain(getClaudeSkillRuntimeRoot(storageRoot))
    // Both Claude credential variables carry only the app-owned loopback token.
    expect(config.env.ANTHROPIC_API_KEY).toBe(config.env.ANTHROPIC_AUTH_TOKEN)
  })

  it('does not inject WebFetch preflight settings into isolated Claude sessions', async () => {
    const service = createService()
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-isolated'),
      keyMask: maskKey('sk-ant-isolated')
    })
    await service.setActiveProvider(CLAUDE_ISOLATED_PROVIDER_ID)

    const config = await resolveActiveBackend(service)

    expect(config.sessionOptions).not.toHaveProperty('settings')
    expect(claudeSkillProjectionRoot(config)).toContain(getClaudeSkillRuntimeRoot(storageRoot))
  })

  it('throws a clear error when no active provider is configured', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    await expect(resolveActiveBackend(service)).rejects.toThrow(/active model provider/i)
  })
})

describe('SettingsService: official vendors', () => {
  it('stores vendor/region + key and exposes the vendor catalog in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'official',
      name: 'MiniMax',
      vendorId: 'minimax',
      region: 'china',
      key: 'sk-mm'
    })

    const view = snapshot.providers[0]
    expect(view).toMatchObject({
      type: 'official',
      vendorId: 'minimax',
      region: 'china',
      hasKey: true
    })
    // Catalog comes from the registry, not the user; base URL is not stored on the record.
    expect(view.models).toContain('MiniMax-M3[1m]')
    expect(view.baseUrl).toBeUndefined()

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-mm')
  })

  it('rejects an official provider with no vendor or no key', async () => {
    const service = createService()

    await expect(
      service.upsertProvider({ type: 'official', name: 'No vendor', key: 'k' })
    ).rejects.toThrow(/vendor is required/i)
    await expect(
      service.upsertProvider({ type: 'official', name: 'No key', vendorId: 'deepseek' })
    ).rejects.toThrow(/api key is required/i)

    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not store a per-official model; the catalog + global selection cover it', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // No model is persisted on the provider; the composer/selector picks from the registry catalog.
    expect(created.model).toBeUndefined()
    expect(created.models).toContain('glm-5.2')
  })

  it('activates a chosen catalog model, falling back to the default for an unknown one', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    const catalogDefault = defaultVendorModel('zhipu')
    expect(catalogDefault).toBe('glm-5.3')

    // A model in the catalog is honored.
    let snapshot = await service.setActiveProvider(created.id, 'glm-5.2')
    expect(snapshot.activeModel).toBe('glm-5.2')

    // An unknown model falls back to the vendor's first catalog entry.
    snapshot = await service.setActiveProvider(created.id, 'not-a-model')
    expect(snapshot.activeModel).toBe(catalogDefault)

    // No model given also defaults to the first catalog entry.
    snapshot = await service.setActiveProvider(created.id)
    expect(snapshot.activeModel).toBe(catalogDefault)
  })

  it('builds spawn env from the registry base URL and the active model', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'sk-ds'
      })
    ).providers[0]
    await service.setActiveProvider(created.id, 'deepseek-v4-flash')

    const config = await resolveActiveBackend(service)

    expect(config.env).toMatchObject({
      ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      ANTHROPIC_AUTH_TOKEN: expect.stringMatching(/^[a-f0-9]+$/),
      ANTHROPIC_MODEL: 'deepseek-v4-flash'
    })
    expect(JSON.stringify(config)).not.toContain('sk-ds')
    expect(config.sessionOptions).toMatchObject({
      settings: {
        skipWebFetchPreflight: true,
        permissions: { ask: ['WebFetch'] },
        availableModels: [
          'deepseek-v4-flash',
          'deepseek-v4-pro',
          'deepseek-v4-pro[1m]',
          'deepseek-v4-flash-vision-exp'
        ],
        modelOverrides: {
          'deepseek-v4-flash': 'deepseek-v4-flash',
          'deepseek-v4-pro': 'deepseek-v4-pro',
          'deepseek-v4-pro[1m]': 'deepseek-v4-pro[1m]',
          'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp'
        }
      }
    })
    expect(claudeSkillProjectionRoot(config)).toContain(getClaudeSkillRuntimeRoot(storageRoot))
    await expect(
      readFile(join(getAppClaudeConfigDir(storageRoot), 'settings.json'), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({
      availableModels: [
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'deepseek-v4-pro[1m]',
        'deepseek-v4-flash-vision-exp'
      ],
      modelOverrides: {
        'deepseek-v4-flash': 'deepseek-v4-flash',
        'deepseek-v4-pro': 'deepseek-v4-pro',
        'deepseek-v4-pro[1m]': 'deepseek-v4-pro[1m]',
        'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp'
      }
    })
    expect(config.contextWindow).toBe(1_000_000)
  })

  it('carries the upstream model through the Claude backend for context tokenization', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.setAgentFramework('claude-code')
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'sk-ds'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'deepseek-v4-flash')

    const backend = await resolveActiveBackend(service)

    expect(backend.contextUsageModel).toBe('deepseek-v4-flash')
  })

  it('refreshes models from the vendor and persists them over the bundled catalog', async () => {
    const service = createService()
    mockedNet.fetch.mockClear()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: 'deepseek-v5' }, { id: 'deepseek-v4-pro' }] }))
        )
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    // Before refresh the view exposes the bundled catalog.
    expect(created.models).toContain('deepseek-v4-pro')
    expect(created.models).not.toContain('deepseek-v5')

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: true, models: ['deepseek-v5', 'deepseek-v4-pro'] })
    expect(mockedNet.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/models$/),
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) })
    )

    // The fetched list now backs the provider view (and persists).
    const view = (await service.getSettingsView()).providers[0]
    expect(view.models).toEqual(['deepseek-v5', 'deepseek-v4-pro'])
  })

  it('reports a refresh failure without changing the bundled catalog', async () => {
    const service = createService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401, json: () => Promise.resolve({}) })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: false, category: 'auth' })

    // Catalog unchanged.
    expect((await service.getSettingsView()).providers[0].models).toContain('deepseek-v4-pro')
  })

  it('hides refresh for a vendor without a model-list endpoint', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no model-list endpoint/i)
  })

  it('uses a basic Chat Completions probe outside Codex', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // OpenCode drives DeepSeek's OpenAI route, so the probe hits /v1/chat/completions — but as a plain
    // non-streaming ping (the bridge streaming function-tool probe is Codex-only).
    await service.setAgentFramework('opencode')
    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds' }
    })

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      stream: false,
      max_tokens: 1
    })
  })

  it('probes DeepSeek Pro through the native Responses route under Codex', async () => {
    const service = createService()
    await repository.setAgentFramework('codex')
    const fetchMock = vi.fn().mockResolvedValue(validNativeCompatibilityToolCallResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds' }
    })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: true,
      tools: [{ type: 'function', name: 'open_science__bridge_probe' }]
    })
  })

  it('probes DeepSeek flash through the native Responses route under Codex', async () => {
    const service = createService()
    await repository.setAgentFramework('codex')
    const fetchMock = vi.fn().mockResolvedValue(validNativeCompatibilityToolCallResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds', model: 'deepseek-v4-flash' }
    })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    // deepseek-v4-flash supports the native Responses API, so the probe must hit /v1/responses with
    // the namespace compatibility contract instead of the Chat Completions bridge.
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      tools: [{ type: 'function', name: 'open_science__bridge_probe' }]
    })
  })

  it('probes native Responses vendors through the Codex namespace compatibility contract', async () => {
    const service = createService()
    await repository.setAgentFramework('codex')
    const fetchMock = vi.fn().mockResolvedValue(validNativeCompatibilityToolCallResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'xai', key: 'sk-xai' }
    })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      stream: true,
      tools: [{ type: 'function', name: 'open_science__bridge_probe' }]
    })
  })

  it('validates an anthropic-only official draft against its /v1/messages route', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // Claude (anthropic-only) keeps the Anthropic Messages probe.
    await service.validateProvider({
      draft: { type: 'official', vendorId: 'anthropic', key: 'sk-a' }
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })
})

// The provider view's supportsImageInput drives whether the composer accepts image attachments.
// These cover every branch of SettingsService.providerSupportsImageInput end to end across all
// provider types: the type branches, the official default-model fallback, active-model switching,
// and live-fetched models.
describe('SettingsService: image-input capability', () => {
  it('reflects the custom provider flag (true only when explicitly enabled)', async () => {
    const service = createService()

    const withImagesSnapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Vision gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      key: 'k',
      supportsImageInput: true
    })
    const withImages = withImagesSnapshot.providers.at(-1)
    expect(withImages?.supportsImageInput).toBe(true)

    const textOnlySnapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Text gateway',
      baseUrl: 'https://t/v1',
      model: 'm',
      key: 'k'
    })
    const textOnly = textOnlySnapshot.providers.find((p) => p.name === 'Text gateway')
    expect(textOnly?.supportsImageInput).toBe(false)
  })

  it('uses the vendor default model when the provider is not the active one', async () => {
    const service = createService()

    // Claude's whole catalog is vision-capable, so its default model reports true.
    const claudeSnapshot = await service.upsertProvider({
      type: 'official',
      name: 'Claude',
      vendorId: 'anthropic',
      key: 'k'
    })
    const claude = claudeSnapshot.providers.find((p) => p.vendorId === 'anthropic')
    expect(claude?.supportsImageInput).toBe(true)

    // MiniMax defaults to the natively multimodal M3 model.
    const minimaxSnapshot = await service.upsertProvider({
      type: 'official',
      name: 'MiniMax',
      vendorId: 'minimax',
      key: 'k'
    })
    const minimax = minimaxSnapshot.providers.find((p) => p.vendorId === 'minimax')
    expect(minimax?.supportsImageInput).toBe(true)

    // DeepSeek's default model is text-only.
    const deepseekSnapshot = await service.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'k'
    })
    const deepseek = deepseekSnapshot.providers.find((p) => p.vendorId === 'deepseek')
    expect(deepseek?.supportsImageInput).toBe(false)
  })

  it('tracks the active model for a vendor with mixed vision support (DeepSeek)', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]

    let view = (
      await service.setActiveProvider(created.id, 'deepseek-v4-flash-vision-exp')
    ).providers.find((provider) => provider.id === created.id)
    expect(view?.supportsImageInput).toBe(true)

    view = (await service.setActiveProvider(created.id, 'deepseek-v4-flash')).providers.find(
      (provider) => provider.id === created.id
    )
    expect(view?.supportsImageInput).toBe(false)
  })

  it('tracks the active model for a vendor with mixed vision support (GLM)', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // The vision variant flips the active provider's view to true.
    let view = (await service.setActiveProvider(created.id, 'glm-5v-turbo')).providers.find(
      (provider) => provider.id === created.id
    )
    expect(view?.supportsImageInput).toBe(true)

    // Switching to a text-only model flips it back to false.
    view = (await service.setActiveProvider(created.id, 'glm-5.2')).providers.find(
      (provider) => provider.id === created.id
    )
    expect(view?.supportsImageInput).toBe(false)
  })

  it('honors live-fetched Claude models the bundled catalog does not list', async () => {
    const service = createService()
    // A refresh surfaces a Claude id not shipped in the registry; it must still count as vision.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-unreleased' }] }))
        )
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'Claude',
        vendorId: 'anthropic',
        key: 'k'
      })
    ).providers[0]

    await service.refreshProviderModels({ providerId: created.id })
    // Activate the fetched model, then read the active provider's view.
    const view = (
      await service.setActiveProvider(created.id, 'claude-opus-5-unreleased')
    ).providers.find((provider) => provider.id === created.id)

    expect(view?.models).toEqual(['claude-opus-5-unreleased'])
    expect(view?.supportsImageInput).toBe(true)
  })

  it('uses the vendor default model, not the refreshed catalog head, for the capability fallback', async () => {
    const service = createService()
    // A refresh reorders Kimi's catalog so a text-only id leads, while the spawned default stays kimi-k3.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: 'kimi-k2.7-code' }, { id: 'kimi-k3' }] }))
        )
    )
    const created = (
      await service.upsertProvider({ type: 'official', name: 'Kimi', vendorId: 'kimi', key: 'k' })
    ).providers[0]
    await service.refreshProviderModels({ providerId: created.id })

    // With no active model, the capability must match the model resolveProvider actually spawns — the
    // vendor default kimi-k3 (multimodal) — not the refreshed list head kimi-k2.7-code (text-only), or
    // OpenCode would keep stripping images from a default that supports them.
    const view = (await service.getSettingsView()).providers.find((p) => p.id === created.id)
    expect(view?.models[0]).toBe('kimi-k2.7-code')
    expect(view?.supportsImageInput).toBe(true)
  })
})

describe('SettingsService: onboarding', () => {
  it('marks onboarding complete and surfaces it in the snapshot', async () => {
    const service = createService()

    const snapshot = await service.markOnboardingComplete()
    expect(snapshot.onboardingCompletedAt).toBeTypeOf('number')

    // The persisted value is visible on a fresh read too.
    const view = await service.getSettingsView()
    expect(view.onboardingCompletedAt).toBe(snapshot.onboardingCompletedAt)
  })

  it('marks legacy paths normalized and persists it across a fresh read', async () => {
    const service = createService()

    await service.markPathsNormalized()

    const settings = await service.getStoredSettings()
    expect(settings.pathsNormalizedAt).toBeTypeOf('number')
  })

  it('persists a new dataRoot with onboarding completion across a fresh read', async () => {
    const service = createService()

    // The repository canonicalizes dataRoot to the host separator on read (for samePath comparisons),
    // so build the fixture the same way — a bare POSIX literal comes back with backslashes on Windows
    // and would fail the round-trip.
    const dataRoot = normalize('/mnt/new-data')
    await service.setDataRoot(dataRoot, { completeOnboarding: true })

    const settings = await service.getStoredSettings()
    expect(settings.dataRoot).toBe(dataRoot)
    expect(settings.onboardingCompletedAt).toBeTypeOf('number')
  })
})

describe('SettingsService: skills', () => {
  // Seeds a bundled-skills root with one "demo" skill + manifest for an injectable registry.
  const seedBundle = async (): Promise<string> => {
    const bundle = await mkdtemp(join(tmpdir(), 'os-skills-bundle-'))
    await mkdir(join(bundle, 'demo'), { recursive: true })
    await writeFile(
      join(bundle, 'demo', 'SKILL.md'),
      ['---', 'name: demo', 'description: A demo skill.', '---', '', 'demo body'].join('\n'),
      'utf8'
    )
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
        ]
      }),
      'utf8'
    )
    return bundle
  }

  const createSkillService = async (): Promise<InstanceType<typeof SettingsService>> =>
    new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle())
    })

  it('lists skills with enabled reflecting disabledSkillIds and returns detail body', async () => {
    const service = await createSkillService()

    let skills = await service.listSkills()
    expect(skills).toEqual([
      expect.objectContaining({
        id: 'demo',
        name: 'demo',
        displayName: 'Demo',
        description: 'A demo skill.',
        enabled: true
      })
    ])

    skills = await service.setSkillEnabled({ id: 'demo', enabled: false })
    expect(skills[0].enabled).toBe(false)

    const detail = await service.getSkillDetail('demo')
    expect(detail.body).toContain('demo body')
  })

  it('keeps a Main-disabled installed Skill in the Specialist catalog', async () => {
    const service = await createSkillService()
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    expect(await service.listSkills()).toEqual([
      expect.objectContaining({ id: 'demo', enabled: false })
    ])
    expect(await service.listSpecialistSkillCatalog()).toEqual([
      expect.objectContaining({ id: 'demo', frameworkName: 'demo' })
    ])
  })

  it('creates, edits, and deletes a personal skill alongside featured skills', async () => {
    const service = await createSkillService()

    let skills = await service.createSkill({
      name: 'my-skill',
      description: 'Mine.',
      body: '# Mine',
      metadata: { author: 'Ada', license: 'MIT', category: 'research' }
    })
    // Featured (demo) + the new personal skill, both enabled by default.
    expect(skills.map((skill) => skill.id).sort()).toEqual(['demo', 'personal-my-skill'])
    const personal = skills.find((skill) => skill.id === 'personal-my-skill')
    expect(personal).toMatchObject({ source: 'personal', enabled: true })

    const detail = await service.getSkillDetail('personal-my-skill')
    expect(detail.body).toContain('# Mine')
    expect(detail.metadata).toEqual({ author: 'Ada', license: 'MIT', category: 'research' })

    skills = await service.updateSkill({
      id: 'personal-my-skill',
      description: 'Edited.',
      body: '# Edited',
      metadata: detail.metadata
    })
    expect(skills.find((skill) => skill.id === 'personal-my-skill')?.description).toBe('Edited.')
    await expect(service.getSkillDetail('personal-my-skill')).resolves.toMatchObject({
      metadata: { author: 'Ada', license: 'MIT', category: 'research' }
    })

    skills = await service.deleteSkill({ id: 'personal-my-skill' })
    expect(skills.map((skill) => skill.id)).toEqual(['demo'])
  })

  it('runs the shared live-reference guard before direct Skill deletion', async () => {
    const service = await createSkillService()
    await service.createSkill({ name: 'my-skill', description: 'Mine.', body: '# Mine' })
    const guard = vi.fn().mockRejectedValue(
      Object.assign(new Error('Skill is referenced by specialist-1.'), {
        code: 'protected-skill'
      })
    )
    service.setSkillDeletionGuard(guard)

    await expect(service.deleteSkill({ id: 'personal-my-skill' })).rejects.toMatchObject({
      code: 'protected-skill'
    })
    expect(guard).toHaveBeenCalledWith('personal-my-skill')
    await expect(service.getSkillDetail('personal-my-skill')).resolves.toBeDefined()
  })

  it('checks live Specialist references atomically with direct Skill deletion', async () => {
    const service = await createSkillService()
    await service.createSkill({ name: 'my-skill', description: 'Mine.', body: '# Mine' })
    const packageSkills = new UserSkillSpecialistPackageAdapter(storageRoot)
    await packageSkills.beginMutation('tx-delete-race', 'research-synth', [])

    let referenced = false
    const guard = vi.fn(async () => {
      if (referenced) {
        throw Object.assign(new Error('Skill is referenced by research-synth.'), {
          code: 'protected-skill'
        })
      }
    })
    service.setSkillDeletionGuard(guard)
    const deletion = service.deleteSkill({ id: 'personal-my-skill' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(guard).not.toHaveBeenCalled()

    referenced = true
    await packageSkills.endMutation('tx-delete-race')

    await expect(deletion).rejects.toMatchObject({ code: 'protected-skill' })
    await expect(service.getSkillDetail('personal-my-skill')).resolves.toBeDefined()
  })

  it('uses the immutable name and reconciles references reported by the detail view', async () => {
    const service = await createSkillService()
    const b64 = (text: string): string => Buffer.from(text).toString('base64')

    await service.createSkill({
      name: 'ref-skill-id',
      description: 'd',
      body: '# body',
      references: [
        { path: 'keep.py', dataBase64: b64('keep') },
        { path: 'drop.py', dataBase64: b64('drop') }
      ]
    })

    let detail = await service.getSkillDetail('personal-ref-skill-id')
    expect(detail.references).toEqual([
      { path: 'drop.py', sizeBytes: 4 },
      { path: 'keep.py', sizeBytes: 4 }
    ])

    // Editing keeps one file, drops one, and adds one.
    await service.updateSkill({
      id: 'personal-ref-skill-id',
      description: 'd',
      body: '# body',
      references: [{ path: 'keep.py' }, { path: 'new.py', dataBase64: b64('new') }]
    })

    detail = await service.getSkillDetail('personal-ref-skill-id')
    expect(detail.references).toEqual([
      { path: 'keep.py', sizeBytes: 4 },
      { path: 'new.py', sizeBytes: 3 }
    ])
  })

  it('force-loads a disabled picked skill for the turn without mutating stored settings', async () => {
    const service = await createSkillService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Local',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(created.id)
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    const exists = async (path: string): Promise<boolean> =>
      readFile(join(path, 'SKILL.md'), 'utf8').then(
        () => true,
        () => false
      )

    // Disabled: the skill is not materialized on a normal spawn.
    const disabledBackend = await resolveActiveBackend(service)
    expect(
      await exists(join(claudeSkillProjectionRoot(disabledBackend), '.claude', 'skills', 'demo'))
    ).toBe(false)

    // Turn-forced: the disabled skill is materialized for this spawn only.
    const forcedBackend = await resolveActiveBackend(service, { forcedSkillIds: ['demo'] })
    expect(
      await exists(join(claudeSkillProjectionRoot(forcedBackend), '.claude', 'skills', 'demo'))
    ).toBe(true)

    // The stored disabled set is untouched, so the skill still lists as disabled.
    const skills = await service.listSkills()
    expect(skills.find((skill) => skill.id === 'demo')?.enabled).toBe(false)

    // Clearing the force set removes it again on the next spawn.
    const clearedBackend = await resolveActiveBackend(service)
    expect(
      await exists(join(claudeSkillProjectionRoot(clearedBackend), '.claude', 'skills', 'demo'))
    ).toBe(false)
  })

  it('keeps the shared Claude profile private while exposing only canonical Skill identities', async () => {
    const userClaudeDir = join(storageRoot, 'shared-claude')
    const userSkillDir = join(userClaudeDir, 'skills', 'os-user-owned')
    const userConnectorDir = join(userClaudeDir, 'skills', 'mcp-pubmed')
    const appClaudeDir = getAppClaudeConfigDir(storageRoot)
    const customConnectorDir = join(connectorSkillSourceDir(storageRoot), 'mcp-custom-server')
    await mkdir(userSkillDir, { recursive: true })
    await mkdir(userConnectorDir, { recursive: true })
    await mkdir(customConnectorDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# User skill', 'utf8')
    await writeFile(join(userConnectorDir, 'SKILL.md'), '# User connector skill', 'utf8')
    await writeFile(
      join(customConnectorDir, 'SKILL.md'),
      '---\nname: mcp-custom-server\ndescription: Custom connector.\nsource: connector\n---\n\n# Custom connector doc',
      'utf8'
    )
    await writeFile(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ model: 'keep-user-model' }),
      'utf8'
    )
    const skillBundle = await seedBundle()
    await mkdir(join(skillBundle, 'demo', 'references'), { recursive: true })
    await writeFile(
      join(skillBundle, 'demo', 'references', 'workflow.md'),
      'reference body',
      'utf8'
    )
    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir,
      skillRegistry: new SkillRegistry(skillBundle)
    })
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => ['mcp-custom-server'],
      availability: () => undefined,
      isRefreshing: () => false
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const config = await resolveActiveBackend(service)
    const backend = await resolveActiveBackend(service)
    const projectionRoot = claudeSkillProjectionRoot(config)
    const projectedSkills = join(projectionRoot, '.claude', 'skills')
    const managedSkillFile = join(projectedSkills, 'demo', 'SKILL.md')

    expect(config.env.CLAUDE_CONFIG_DIR).toBe(userClaudeDir)
    expect(config.sessionOptions).toMatchObject({
      settings: expect.objectContaining({ disableBundledSkills: true }),
      additionalDirectories: [projectionRoot],
      sandbox: {
        filesystem: { allowRead: [projectionRoot], denyWrite: [projectionRoot] }
      }
    })
    expect(config.sessionOptions).not.toHaveProperty('plugins')
    expect(await readdir(projectionRoot)).toEqual(['.claude'])
    expect(await readdir(projectedSkills)).not.toContain('os-demo')
    expect(await readFile(managedSkillFile, 'utf8')).toContain('demo body')
    await expect(
      readFile(join(projectedSkills, 'demo', 'references', 'workflow.md'), 'utf8')
    ).resolves.toBe('reference body')
    expect(await readFile(join(userSkillDir, 'SKILL.md'), 'utf8')).toBe('# User skill')
    expect(await readFile(join(userConnectorDir, 'SKILL.md'), 'utf8')).toBe(
      '# User connector skill'
    )
    expect(await readFile(join(projectedSkills, 'mcp-pubmed', 'SKILL.md'), 'utf8')).toContain(
      'name: mcp-pubmed'
    )
    expect(
      await readFile(join(projectedSkills, 'mcp-custom-server', 'SKILL.md'), 'utf8')
    ).toContain('# Custom connector doc')
    await expect(
      readFile(join(appClaudeDir, 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(userClaudeDir, 'settings.json'), 'utf8'))).toEqual({
      model: 'keep-user-model'
    })
    const appSettings = JSON.parse(await readFile(join(appClaudeDir, 'settings.json'), 'utf8'))
    expect(config.sessionOptions?.settings).toEqual(appSettings)
    expect(appSettings.disableBundledSkills).toBe(true)
    expect(appSettings.permissions.deny).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Read/)])
    )
    expect(JSON.stringify(appSettings.permissions.deny)).not.toContain(projectionRoot)
    expect(backend.systemPromptAppends).toEqual(
      expect.arrayContaining([
        expect.stringContaining(join(storageRoot, 'skills', 'personal')),
        expect.stringContaining('Load the matching `mcp-*` skill before the first `host.mcp` call')
      ])
    )
  })

  it('injects the selected shared Claude model context window into the spawn config', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-8' })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID, 'claude-opus-4-8')

    await expect(resolveActiveBackend(service)).resolves.toMatchObject({
      contextWindow: 1_000_000
    })
  })

  it('materializes enabled skills into the app-owned CODEX_HOME before spawn', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      codexDetectDeps: {
        env: { PATH: dirname(adapterPath) },
        homePath: '/home',
        // Detection walks PATH with the host's path rules; this test's adapterPath/PATH are real
        // on-disk host paths, so mock the host platform (a fixed 'linux' shreds a Windows drive letter
        // like C:\… when splitting PATH on ':' , so detection would never match the file it created).
        platform: process.platform,
        isRunnable: (path) => Promise.resolve(path === adapterPath),
        getAdapterVersion: () => Promise.resolve('codex-acp 1.6.2'),
        getCodexVersion: () => Promise.resolve(undefined),
        smokeInitialize: () => Promise.resolve(true),
        resolveNpmBinDirs: () => Promise.resolve([]),
        managedAdapterPath: adapterPath
      }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5-codex',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const customSkillName = 'mcp-xt'
    const customSkillSource = join(connectorSkillSourceDir(storageRoot), customSkillName)
    await mkdir(customSkillSource, { recursive: true })
    await writeFile(
      join(customSkillSource, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: "Use XT records."\nsource: connector\n---\n\n# XT\n',
      'utf8'
    )
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [customSkillName],
      availability: () => undefined,
      isRefreshing: () => false
    })

    await resolveActiveBackend(service)

    const materializedDir = join(storageRoot, 'codex', 'skills', 'os-demo')
    const materializedFile = join(materializedDir, 'SKILL.md')
    try {
      expect(await readFile(materializedFile, 'utf8')).toContain('demo body')
      await expect(
        service.codexSkillDescriptorsForIds(['demo', 'missing'], join(storageRoot, 'codex'))
      ).resolves.toEqual([{ name: 'demo', path: materializedFile }])
      await expect(
        readFile(join(storageRoot, 'codex', 'skills', customSkillName, 'SKILL.md'), 'utf8')
      ).resolves.toContain('Use XT records.')
      const selectorCatalog = await service.codexSkillCatalog(join(storageRoot, 'codex'))
      expect(selectorCatalog).toEqual(
        expect.arrayContaining([
          { name: 'demo', description: 'A demo skill.', path: materializedFile },
          {
            name: customSkillName,
            description: 'Use XT records.',
            path: join(storageRoot, 'codex', 'skills', customSkillName, 'SKILL.md'),
            source: 'connector'
          },
          expect.objectContaining({
            name: 'mcp-pubmed',
            description: expect.stringContaining('biomedical literature'),
            path: join(storageRoot, 'codex', 'skills', 'mcp-pubmed', 'SKILL.md'),
            source: 'connector'
          })
        ])
      )

      await service.setSkillEnabled({ id: 'demo', enabled: false })
      const catalogWithoutDemo = await service.codexSkillCatalog(join(storageRoot, 'codex'))
      expect(catalogWithoutDemo.some(({ name }) => name === 'demo')).toBe(false)
      expect(catalogWithoutDemo.some(({ name }) => name === 'mcp-pubmed')).toBe(true)

      await service.setConnectorEnabled({ id: 'pubmed', enabled: false })
      const catalogWithoutPubmed = await service.codexSkillCatalog(join(storageRoot, 'codex'))
      expect(catalogWithoutPubmed.some(({ name }) => name === 'mcp-pubmed')).toBe(false)
    } finally {
      // The materializer intentionally makes agent-visible skills read-only; restore permissions so
      // the test temp root can be removed on every platform.
      await chmod(materializedFile, 0o644)
      await chmod(materializedDir, 0o755)
    }
  })

  it('builds the Codex skill catalog from one settings snapshot', async () => {
    const skillsRoot = join(storageRoot, 'codex', 'skills')
    await Promise.all(
      ['os-demo', 'mcp-pubmed'].map(async (directory) => {
        const skillDir = join(skillsRoot, directory)
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), `# ${directory}`, 'utf8')
      })
    )
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle())
    })
    const empty = await repository.getSettings()
    const getSettings = vi
      .spyOn(repository, 'getSettings')
      .mockResolvedValueOnce({
        ...empty,
        connectors: {
          enabledIds: [],
          autoAllowIds: [],
          disabledConnectorIds: ['pubmed']
        }
      })
      .mockResolvedValueOnce({
        ...empty,
        disabledSkillIds: ['demo'],
        connectors: { enabledIds: [], autoAllowIds: [] }
      })

    const catalog = await service.codexSkillCatalog(join(storageRoot, 'codex'))

    expect(catalog.map(({ name }) => name)).toEqual(['demo'])
    expect(getSettings).toHaveBeenCalledTimes(1)
  })

  it('materializes ordinary and custom Connector Skills into the subscription home only', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      codexDetectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        isRunnable: (path) => Promise.resolve(path === adapterPath),
        getAdapterVersion: () => Promise.resolve('codex-acp 1.6.2'),
        getCodexVersion: () => Promise.resolve(undefined),
        smokeInitialize: () => Promise.resolve(true),
        resolveNpmBinDirs: () => Promise.resolve([]),
        managedAdapterPath: adapterPath
      }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const customSkillName = 'mcp-xt'
    const customSkillSource = join(connectorSkillSourceDir(storageRoot), customSkillName)
    await mkdir(customSkillSource, { recursive: true })
    await writeFile(
      join(customSkillSource, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n',
      'utf8'
    )
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [customSkillName],
      availability: () => undefined,
      isRefreshing: () => false
    })
    await repository.upsertProvider({
      id: CODEX_SHARED_PROVIDER_ID,
      type: 'codex-shared',
      name: 'Existing Codex profile',
      apiEndpoints: ['responses'],
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CODEX_SHARED_PROVIDER_ID)

    await resolveActiveBackend(service)

    expect(
      await readFile(
        join(storageRoot, 'codex-subscription', 'skills', 'os-demo', 'SKILL.md'),
        'utf8'
      )
    ).toContain('demo body')
    await expect(
      readFile(
        join(storageRoot, 'codex-subscription', 'skills', customSkillName, 'SKILL.md'),
        'utf8'
      )
    ).resolves.toContain('Use XT records.')
    await expect(
      readFile(join(storageRoot, 'workspace', '.agents', 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(storageRoot, 'codex', 'skills', customSkillName, 'SKILL.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await chmod(join(storageRoot, 'codex-subscription', 'skills', 'os-demo', 'SKILL.md'), 0o644)
    await chmod(join(storageRoot, 'codex-subscription', 'skills', 'os-demo'), 0o755)
  })

  it('reports disabled picks and resolves agent-readable skill nudge names', async () => {
    const service = await createSkillService()

    await service.createSkill({ name: 'my-skill', description: 'Mine.', body: '# Mine' })
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    // Only the disabled pick (demo) needs a respawn; the enabled personal skill does not.
    expect(await service.skillsNeedingForceLoad(['demo', 'personal-my-skill'])).toEqual(['demo'])
    expect(await service.skillsNeedingForceLoad(['personal-my-skill'])).toEqual([])

    // Featured ids are the agent-facing frontmatter names, but user-skill ids carry an app prefix.
    expect(await service.skillNudgeNamesForIds(['demo', 'personal-my-skill', 'nope'])).toEqual([
      'demo',
      'my-skill'
    ])
  })

  it('uses the frontmatter name when nudging an imported skill', async () => {
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      userSkills: {
        list: () =>
          Promise.resolve([
            {
              id: 'imported-data-explorer',
              name: 'Data Explorer',
              description: 'Explore imported data.',
              source: 'imported' as const,
              updatedAt: '2026-07-23T00:00:00.000Z',
              sourceDir: join(storageRoot, 'skills', 'imported', 'data-explorer')
            }
          ])
      } as unknown as UserSkillRepositoryType
    })

    expect(await service.skillNudgeNamesForIds(['imported-data-explorer'])).toEqual([
      'Data Explorer'
    ])
  })

  // GitHub scan/import must go through the proxy-aware net.fetch, not Node's global fetch (which
  // ignores the system/VPN proxy and gets a 403 in proxied environments). These lock the wiring so a
  // regression back to the default fetch is caught.
  it('imports a GitHub skill through the proxy-aware net.fetch', async () => {
    const importFromGitHub = vi.fn().mockResolvedValue({ status: 'imported', id: 'imported-x' })
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { importFromGitHub, list: () => Promise.resolve([]) } as any
    })
    const signal = new AbortController().signal

    await service.importSkill({ url: 'https://github.com/o/r/tree/main/skills/demo' }, signal)

    expect(importFromGitHub).toHaveBeenCalledWith(
      'https://github.com/o/r/tree/main/skills/demo',
      netFetch,
      ['demo'],
      { signal }
    )
  })

  it('scans a GitHub repo through the proxy-aware net.fetch', async () => {
    const scanRepo = vi.fn().mockResolvedValue([])
    const service = new SettingsService({
      repository,
      storageRoot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { scanRepo } as any
    })
    const signal = new AbortController().signal

    await service.scanRepoSkills({ repo: 'o/r' }, signal)

    expect(scanRepo).toHaveBeenCalledWith('o/r', netFetch, { signal })
  })

  it('searches GitHub repositories for keyword input without scanning a guessed repo', async () => {
    const scanRepo = vi.fn().mockResolvedValue([])
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              full_name: 'hugohe3/ppt-master',
              description: 'Presentation generation skills',
              html_url: 'https://github.com/hugohe3/ppt-master',
              stargazers_count: 42
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetch)
    const service = new SettingsService({
      repository,
      storageRoot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { scanRepo } as any
    })

    await expect(service.scanRepoSkills({ repo: 'ppt master' })).resolves.toEqual({
      skills: [],
      repositories: [
        {
          fullName: 'hugohe3/ppt-master',
          description: 'Presentation generation skills',
          url: 'https://github.com/hugohe3/ppt-master',
          stars: 42
        }
      ]
    })
    expect(scanRepo).not.toHaveBeenCalled()
  })

  it('previews a selected GitHub skill through the proxy-aware bounded repository path', async () => {
    const previewGitHubSkill = vi.fn().mockResolvedValue({
      name: 'Demo',
      description: 'Remote skill',
      metadata: { license: 'MIT' },
      body: '# Demo',
      files: ['SKILL.md']
    })
    const service = new SettingsService({
      repository,
      storageRoot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { previewGitHubSkill } as any
    })
    const url = 'https://github.com/o/r/tree/main/skills/demo'

    await expect(service.previewGitHubSkill({ url })).resolves.toMatchObject({
      sourceLabel: 'github.com/o/r@main/skills/demo',
      body: '# Demo'
    })
    expect(previewGitHubSkill).toHaveBeenCalledWith(url, netFetch, { signal: undefined })
  })
})

describe('installClaude (app-managed source)', () => {
  it('routes managed installs through the managed installer and persists the resolved path', async () => {
    const service = createService(undefined, {
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: '/data/claude-code/bin/claude',
        version: '2.1.209'
      })
    })

    const result = await service.installClaude({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    const snapshot = await service.getSettingsView()
    expect(snapshot.claude).toEqual({
      resolvedPath: '/data/claude-code/bin/claude',
      version: '2.1.209'
    })
  })

  it('does not persist claude info when the managed install fails', async () => {
    const service = createService(undefined, {
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'all registries failed' }
      })
    })

    const result = await service.installClaude({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(false)
    const snapshot = await service.getSettingsView()
    expect(snapshot.claude).toEqual({})
  })

  it('logs a version error and rejects an incompatible managed runtime', async () => {
    const logs: string[] = []
    const service = createService(
      { found: false, path: undefined, version: undefined },
      {
        installManagedClaudeImpl: async ({ installId }) => ({
          result: { installId, ok: true },
          resolvedPath: '/data/claude-code/bin/claude',
          version: '9.9.9'
        })
      }
    )

    const result = await service.installClaude({ source: 'managed' }, (event) => {
      if (event.kind === 'log') logs.push(event.chunk)
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('version') })
    expect(logs.at(-1)).toContain('incompatible or incomplete')
    expect((await service.getSettingsView()).claude).toEqual({})
  })

  it('puts an explicitly requested China-friendly mirror first', async () => {
    const installManagedClaudeImpl = vi.fn<ManagedInstallImpl>(async ({ installId }) => ({
      result: { installId, ok: false }
    }))
    const service = createService(undefined, { installManagedClaudeImpl })

    await service.installClaude(
      { source: 'managed', managedRegistry: 'npmmirror' },
      () => undefined
    )

    expect(installManagedClaudeImpl.mock.calls[0]?.[0].registries).toEqual([
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org'
    ])
  })
})

describe('installOpencode', () => {
  it('routes a managed install through the managed installer and persists path + version', async () => {
    const service = createService(undefined, {
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: '/data/opencode-managed/bin/opencode',
        version: '1.18.3'
      })
    })

    const result = await service.installOpencode({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    expect((await service.getSettingsView()).opencode).toEqual({
      resolvedPath: '/data/opencode-managed/bin/opencode',
      version: '1.18.3'
    })
  })

  it('does not persist opencode info when the managed install fails', async () => {
    const service = createService(undefined, {
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'all registries failed' }
      })
    })

    const result = await service.installOpencode({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(false)
    expect((await service.getSettingsView()).opencode).toEqual({})
  })
})

describe('installCodex', () => {
  it('persists the managed adapter and native Codex pair', async () => {
    const service = createService(undefined, {
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        adapterPath: '/data/codex-managed/adapter/dist/index.js',
        adapterVersion: '1.6.2',
        codexPath: '/data/codex-managed/codex/vendor/target/bin/codex',
        codexVersion: '0.144.6'
      })
    })

    const result = await service.installCodex({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).codex).toEqual({
      resolvedPath: '/data/codex-managed/adapter/dist/index.js',
      version: '1.6.2',
      nativePath: '/data/codex-managed/codex/vendor/target/bin/codex',
      nativeVersion: '0.144.6'
    })
  })
})

describe('detectOpencode', () => {
  it('clears a stale record when nothing runnable is found (e.g. after an uninstall)', async () => {
    // Simulate a prior install still recorded in settings.
    await repository.setOpencodeInfo('/gone/bin/opencode', '1.18.3')
    const service = createService() // default deps find nothing

    const snapshot = await service.detectOpencode()

    // The stale path/version are forgotten so the card and gates reflect the uninstall.
    expect(snapshot.opencode).toEqual({})
    expect((await repository.getSettings()).opencodePath).toBeUndefined()
  })

  it('records the detected path + version when opencode is present', async () => {
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })

    const snapshot = await service.detectOpencode()

    expect(snapshot.opencode).toEqual({
      resolvedPath: '/usr/local/bin/opencode',
      version: '1.19.0'
    })
  })

  it('keeps a still-present record when the live probe misses (GUI PATH gap, not an uninstall)', async () => {
    // A real executable the probe fails to see (e.g. narrower GUI PATH). The record must survive.
    const present = join(storageRoot, 'opencode-present')
    await writeFile(present, '', 'utf8')
    await chmod(present, 0o755)
    await repository.setOpencodeInfo(present, '1.18.3')
    const service = createService() // default deps find nothing

    const snapshot = await service.detectOpencode()

    expect(snapshot.opencode).toEqual({ resolvedPath: present, version: '1.18.3' })
  })
})

describe('detectClaude hardening', () => {
  it('forgets the recorded claude when its binary is gone from disk (uninstall)', async () => {
    await repository.setClaudeInfo({ resolvedPath: '/gone/bin/claude', version: '2.1.0' })
    // found:false + version:undefined makes the injected probe report nothing runnable.
    const service = createService({ found: false, path: undefined, version: undefined })

    await service.detectClaude()

    // The stale path is forgotten (an empty claude record sanitizes away to undefined on read).
    expect((await repository.getSettings()).claude?.resolvedPath).toBeUndefined()
  })

  it('keeps the cached claude on a transient probe miss when its binary still exists', async () => {
    const present = join(storageRoot, 'claude-present')
    await writeFile(present, '', 'utf8')
    await chmod(present, 0o755)
    await repository.setClaudeInfo({ resolvedPath: present, version: '2.1.0' })
    const service = createService({ found: false, path: undefined, version: undefined })

    await service.detectClaude()

    // A GUI PATH gap must not wipe a still-installed claude.
    expect((await repository.getSettings()).claude).toEqual({
      resolvedPath: present,
      version: '2.1.0'
    })
  })
})

describe('checkEnvironment', () => {
  it('keeps a cached executable that still runs when a GUI PATH cannot rediscover it', async () => {
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        // PATH scan finds nothing, but the cached path still reports a version.
        isExecutable: () => Promise.resolve(false),
        getVersion: (path) => Promise.resolve(path === execPath ? '2.1.0' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    expect(result.runtime).toEqual({ found: true, path: execPath, version: '2.1.0' })
    expect(result.checks.find((check) => check.id === 'agent')?.status).toBe('passed')
  })

  it('does not overwrite a healthy recorded executable with a freshly detected PATH entry', async () => {
    // Pinned platform is 'linux', so use posix literals; a host join() would splice a win32 drive
    // letter into PATH and be mis-split on ':' by the posix delimiter.
    const other = '/other-bin/claude'
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: { PATH: '/other-bin' },
        homePath: '/home',
        platform: 'linux',
        // A different claude is discoverable on PATH, but the cached one is still healthy.
        isExecutable: (path) => Promise.resolve(path === other),
        getVersion: (path) =>
          Promise.resolve(path === execPath ? '2.1.0' : path === other ? '9.9.9' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    // The recorded runtime is retained rather than being replaced by the PATH discovery.
    expect(result.runtime).toEqual({ found: true, path: execPath, version: '2.1.0' })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(execPath)
  })

  it('re-detects when the recorded executable no longer reports a version', async () => {
    // Pinned platform is 'linux', so use posix literals (see the note above about PATH splitting).
    const stale = '/stale/claude'
    const found = '/found-bin/claude'
    await repository.setClaudeInfo({ resolvedPath: stale, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: { PATH: '/found-bin' },
        homePath: '/home',
        platform: 'linux',
        isExecutable: (path) => Promise.resolve(path === found),
        // The cached path is dead (no version); detection finds a live one on PATH.
        getVersion: (path) => Promise.resolve(path === found ? '2.2.0' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    expect(result.runtime).toEqual({ found: true, path: found, version: '2.2.0' })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(found)
  })

  it('checks both framework runtimes together and gates on the selected one (OpenCode)', async () => {
    await repository.setAgentFramework('opencode')
    // Claude is detectable (default detectDeps) and OpenCode is declared installed; both rows appear,
    // but the result's runtime + gating reflect the SELECTED framework (OpenCode).
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' },
      codebuddyDetected: { path: '/usr/local/bin/codebuddy', version: '2.138.0' }
    })

    const result = await service.checkEnvironment()

    const agentRows = result.checks.filter((check) => check.id === 'agent')
    expect(agentRows.map((row) => row.label)).toEqual([
      'Claude Code runtime',
      'OpenCode runtime',
      'Codex native CLI',
      'Codex ACP adapter',
      'CodeBuddy runtime'
    ])
    expect(agentRows.map((row) => row.status)).toEqual([
      'passed',
      'passed',
      'warning',
      'warning',
      'passed'
    ])
    expect(result.agentFrameworkId).toBe('opencode')
    expect(result.runtime).toEqual({
      found: true,
      path: '/usr/local/bin/opencode',
      version: '1.19.0'
    })
  })

  it('persists a freshly detected OpenCode runtime discovered during the dual probe', async () => {
    // No recorded opencode; the parallel probe detects one on PATH and must record it so later
    // gates/cards read the same runtime without re-probing.
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })

    await service.checkEnvironment()

    const settings = await repository.getSettings()
    expect(settings.opencodePath).toBe('/usr/local/bin/opencode')
    expect(settings.opencodeVersion).toBe('1.19.0')
  })

  it('gates on the selected framework: OpenCode selected but missing blocks while Claude passes', async () => {
    await repository.setAgentFramework('opencode')
    // Claude is detectable (default detectDeps); OpenCode is declared absent (no opencodeDetected).
    const service = createService(undefined, {
      codebuddyDetected: { path: '/usr/local/bin/codebuddy', version: '2.138.0' }
    })

    const result = await service.checkEnvironment()

    const agentRows = result.checks.filter((check) => check.id === 'agent')
    expect(agentRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Claude Code runtime:passed',
      'OpenCode runtime:failed',
      'Codex native CLI:warning',
      'Codex ACP adapter:warning',
      'CodeBuddy runtime:passed'
    ])
    // Selection drives readiness: the missing selected runtime blocks Continue even though Claude runs.
    expect(result.agentFrameworkId).toBe('opencode')
    expect(result.ready).toBe(false)
    expect(result.runtime).toEqual({ found: false })
  })
})

describe('SettingsService: managed-runtime flags', () => {
  it('advertises delegated work only for certified frameworks', async () => {
    const snapshot = await createService().getSettingsView()

    expect(
      snapshot.agentFrameworks.map(({ id, supportsDelegatedWork }) => ({
        id,
        supportsDelegatedWork
      }))
    ).toEqual([
      { id: 'claude-code', supportsDelegatedWork: true },
      { id: 'opencode', supportsDelegatedWork: true },
      { id: 'codex', supportsDelegatedWork: true },
      { id: 'codebuddy', supportsDelegatedWork: true }
    ])
  })

  it('reports claudeManaged when the resolved path is the app-managed install, opencode as non-managed', async () => {
    await repository.setClaudeInfo({
      resolvedPath: join(managedClaudeDir(storageRoot), 'claude'),
      version: '2.1.0'
    })
    // A user's own PATH opencode is never treated as managed.
    await repository.setOpencodeInfo('/usr/local/bin/opencode', '1.18.3')
    const service = createService()

    const snapshot = await service.getSettingsView()

    expect(snapshot.claudeManaged).toBe(true)
    expect(snapshot.opencodeManaged).toBe(false)
  })
})

describe('SettingsService: uninstall managed runtime', () => {
  it('uninstalls app-managed Codex and falls back to ready Claude', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const adapterPath = managedCodexAdapterEntry(storageRoot)
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.6.2' })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.setAgentFramework('codex')
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallCodex()

    await expect(readFile(adapterPath)).rejects.toThrow()
    expect(snapshot.codex).toEqual({})
    expect(snapshot.agentFrameworkId).toBe('claude-code')
    expect(activeBackendAffected).toBe(true)
  })

  it('uninstallClaude is a no-op for a non-managed (PATH/npm) install', async () => {
    await repository.setClaudeInfo({ resolvedPath: '/usr/local/bin/claude', version: '2.1.0' })
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallClaude()

    // The install we did not own is left untouched, and nothing about the active backend changed.
    expect(snapshot.claude).toEqual({ resolvedPath: '/usr/local/bin/claude', version: '2.1.0' })
    expect(snapshot.claudeManaged).toBe(false)
    expect(activeBackendAffected).toBe(false)
  })

  it('uninstallOpencode removes the managed install, clears the record, and auto-switches to Claude when it was active', async () => {
    // A real managed opencode binary on disk, recorded and selected as the active backend.
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await chmod(opencodeBin, 0o755)
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    // A separate Claude still present on disk, so the active framework can fall back to it.
    const claudeBin = join(storageRoot, 'fake-claude', 'claude')
    await mkdir(dirname(claudeBin), { recursive: true })
    await writeFile(claudeBin, '', 'utf8')
    await chmod(claudeBin, 0o755)
    await repository.setClaudeInfo({ resolvedPath: claudeBin, version: '2.1.0' })
    await repository.setAgentFramework('opencode')
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallOpencode()

    // The managed tree is gone, the record is cleared, and the active backend fell back to Claude.
    await expect(readFile(opencodeBin)).rejects.toThrow()
    expect(snapshot.opencode).toEqual({})
    expect(snapshot.opencodeManaged).toBe(false)
    expect(snapshot.agentFrameworkId).toBe('claude-code')
    // OpenCode was the active backend, so the caller must reconnect.
    expect(activeBackendAffected).toBe(true)
  })

  it('does not flag the active backend when the uninstalled runtime was not active', async () => {
    // Managed OpenCode installed but Claude is the active framework.
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    await repository.setAgentFramework('claude-code')
    const service = createService()

    const { activeBackendAffected } = await service.uninstallOpencode()

    // Removing the inactive runtime leaves the live (Claude) agent untouched — no reconnect.
    expect(activeBackendAffected).toBe(false)
  })

  it('does not auto-switch to the other runtime when it exists but cannot report a version (not ready)', async () => {
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    // A Claude binary present on disk but broken — it exists yet reports no version.
    const claudeBin = join(storageRoot, 'fake-claude', 'claude')
    await mkdir(dirname(claudeBin), { recursive: true })
    await writeFile(claudeBin, '', 'utf8')
    await repository.setClaudeInfo({ resolvedPath: claudeBin, version: '2.1.0' })
    await repository.setAgentFramework('opencode')
    // getVersion resolves undefined for every path, so Claude reads as not ready (like preflight).
    const service = createService({ found: false, path: undefined, version: undefined })

    const { snapshot } = await service.uninstallOpencode()

    // A broken runtime is never auto-selected: the selection stays put and the gate will flag it.
    expect(snapshot.agentFrameworkId).toBe('opencode')
  })

  it('falls through to ready Codex when earlier fallback runtimes are unavailable', async () => {
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    const codexAdapter = join(storageRoot, 'fallback', 'codex-acp')
    const nativePath = join(storageRoot, 'fallback', 'codex')
    await mkdir(dirname(opencodeBin), { recursive: true })
    await mkdir(dirname(codexAdapter), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await writeFile(codexAdapter, '', 'utf8')
    await writeFile(nativePath, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    await repository.setCodexInfo({
      resolvedPath: codexAdapter,
      version: '1.6.2',
      nativePath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    const service = createService(
      { found: false },
      {
        codexDetected: {
          path: codexAdapter,
          version: 'codex-acp 1.6.2',
          nativePath,
          nativeVersion: 'codex-cli 0.144.6'
        }
      }
    )

    const { snapshot } = await service.uninstallOpencode()

    expect(snapshot.agentFrameworkId).toBe('codex')
  })
})

describe('SettingsService: reasoning effort', () => {
  it("projects 'default' when no reasoning effort is stored", async () => {
    const service = createService()

    expect((await service.getSettingsView()).reasoningEffort).toBe('default')
  })

  it('projects the stored level into the settings view', async () => {
    const service = createService()

    await repository.setReasoningEffort('low')

    expect((await service.getSettingsView()).reasoningEffort).toBe('low')
  })

  it('persists the level and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setReasoningEffort('max')

    expect(snapshot.reasoningEffort).toBe('max')
    expect((await repository.getSettings()).reasoningEffort).toBe('max')
  })

  it("maps a five-level intent onto DeepSeek's three supported levels", async () => {
    const service = createService()
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'deepseek-v4-pro')

    expect(await service.resolveActiveReasoningEffort('low')).toBe('none')
    expect(await service.resolveActiveReasoningEffort('max')).toBe('max')
  })

  it("maps the top intent onto StepFun's highest supported level", async () => {
    const service = createService()
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'StepFun',
        vendorId: 'stepfun',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'step-3.7-flash')

    expect(await service.resolveActiveReasoningEffort('max')).toBe('high')
  })

  it('maps a custom model intent through its stored effort preset', async () => {
    const service = createService()
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://g/v1',
        model: 'm',
        reasoningEffortPreset: 'none-high',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    expect(await service.resolveActiveReasoningEffort('low')).toBe('none')
    expect(await service.resolveActiveReasoningEffort('max')).toBe('high')
  })

  it("returns 'default' for default intent and models that do not support effort", async () => {
    const service = createService()
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://g/v1',
        model: 'm',
        reasoningEffortPreset: 'unsupported',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    expect(await service.resolveActiveReasoningEffort('max')).toBe('default')
    expect(await service.resolveActiveReasoningEffort('default')).toBe('default')
  })

  it('uses the OpenAI and Anthropic registries for subscription models', async () => {
    const service = createService()
    const codex = (await service.upsertProvider({ type: 'codex-isolated' })).providers[0]
    await service.setActiveProvider(codex.id, 'gpt-5.6-sol')

    expect(await service.resolveActiveReasoningEffort('max')).toBe('ultra')

    const claude = (
      await service.upsertProvider({
        type: 'claude-shared',
        model: 'claude-haiku-4-5-20251001'
      })
    ).providers.find((provider) => provider.type === 'claude-shared')!
    await service.setActiveProvider(claude.id, 'claude-haiku-4-5-20251001')

    expect(await service.resolveActiveReasoningEffort('max')).toBe('default')
  })

  it('does not guess an effort profile for an unpinned Codex subscription model', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      managedCodexAdapterPath: adapterPath,
      managedCodexNativePath: execPath
    })
    await repository.setAgentFramework('codex')
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: execPath,
      nativeVersion: '0.144.6'
    })
    const codex = (await service.upsertProvider({ type: 'codex-isolated' })).providers[0]
    await service.setActiveProvider(codex.id)

    expect(await service.resolveActiveReasoningEffort('max')).toBe('default')

    await repository.setReasoningEffort('max')
    expect((await resolveActiveBackend(service)).sessionEffort).toBeUndefined()
  })

  it('does not guess an effort profile for an unpinned Claude subscription model', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'claude-code')
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const claude = (await service.upsertProvider({ type: 'claude-shared' })).providers.find(
      (provider) => provider.type === 'claude-shared'
    )!
    await service.setActiveProvider(claude.id)
    await repository.setReasoningEffort('max')

    expect(await service.resolveActiveReasoningEffort('max')).toBe('default')
    const backend = await resolveActiveBackend(service)
    expect(backend.sessionEffort).toBeUndefined()
    expect(backend.env).not.toHaveProperty('ANTHROPIC_MODEL')
  })

  it('passes the model-mapped effort to both OpenCode delivery channels', async () => {
    // AgentBackendResolver honors this forced-framework env above stored settings; set it
    // explicitly (a prior test may leave it stubbed) so this resolves OpenCode.
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'deepseek-v4-pro')
    await repository.setReasoningEffort('low')

    const backend = await resolveActiveBackend(service)

    expect(backend.sessionEffort).toBe('none')
    // The official vendor identity survives provider resolution, so OpenCode receives DeepSeek's
    // native thinking switch instead of an invalid reasoningEffort: none literal.
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const agentProviderId = opencodeTransportProviderId(provider.id, 'deepseek-v4-pro')
    expect(content.provider[agentProviderId].models['deepseek-v4-pro']).toEqual(
      expect.objectContaining({ options: { thinking: { type: 'disabled' } } })
    )
  })

  it('uses one effective catalog model for both the backend and its effort profile', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'Anthropic',
        vendorId: 'anthropic',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id, 'claude-haiku-4-5-20251001')
    await repository.setReasoningEffort('max')

    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...stored, fetchedModels: ['claude-opus-5'] })

    const backend = await resolveActiveBackend(service)
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const agentProviderId = opencodeTransportProviderId(provider.id, 'claude-opus-5')

    expect(backend.sessionModel).toBe(`${agentProviderId}/claude-opus-5`)
    expect(backend.sessionEffort).toBe('max')
    expect(content.model).toBe(`${agentProviderId}/claude-opus-5`)
  })

  it('surfaces sessionEffort on the Claude backend too (the early-return path)', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'claude-code')
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        contextWindow: 64_000,
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    await repository.setReasoningEffort('low')

    const backend = await resolveActiveBackend(service)

    expect(backend.framework.id).toBe('claude-code')
    expect(backend.contextWindow).toBe(64_000)
    expect(backend.sessionEffort).toBe('low')
    expect(backend.systemPromptAppends).toEqual(
      expect.arrayContaining([
        expect.stringContaining(join(storageRoot, 'skills', 'personal')),
        expect.stringContaining('Load the matching `mcp-*` skill before the first `host.mcp` call')
      ])
    )
    expect(backend.systemPromptAppends?.join('\n')).not.toContain('search_articles')
  })

  it("leaves sessionEffort undefined when the level is 'default' or unset", async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'claude-code')
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    // Unset: nothing stored yet.
    expect((await resolveActiveBackend(service)).sessionEffort).toBeUndefined()

    // 'default' means "don't override": the agent keeps its own default effort.
    await repository.setReasoningEffort('default')
    expect((await resolveActiveBackend(service)).sessionEffort).toBeUndefined()
  })

  it('lets the owning runtime update its live bridge with a model-resolved effort', async () => {
    const localFetch = globalThis.fetch
    let upstreamRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-effort-policy',
                model: 'deepseek-v4-flash',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, MANAGED_CODEX_ADAPTER_FIXTURE, 'utf8')
    await chmod(adapterPath, 0o755)
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.6.2' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.6.2',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'DeepSeek',
        apiEndpoints: ['openai'],
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await resolveActiveBackend(service)
    const post = (): Promise<string> =>
      localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: backend.providerConfiguration?.headers.authorization ?? '',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hi',
          reasoning: { effort: 'high' },
          stream: true
        })
      }).then((response) => response.text())

    // No explicit choice yet: Codex's own default effort is stripped, as pre-feature.
    await post()
    expect(upstreamRequest).not.toHaveProperty('reasoning_effort')

    // The active runtime owns this lease, so it updates only the bridge for its own provider/model.
    backend.responsesBridgeLease?.setReasoningEffort?.('high')
    await post()
    expect(upstreamRequest).toMatchObject({ reasoning_effort: 'high' })

    // The bridge receives the concrete mapped value, not a forwarding boolean: it replaces Codex's
    // own request effort instead of letting an incompatible value leak to the selected model.
    backend.responsesBridgeLease?.setReasoningEffort?.('max')
    await post()
    expect(upstreamRequest).toMatchObject({ reasoning_effort: 'max' })

    // Back to 'default': stripping is restored so Codex's own effort can't leak upstream.
    backend.responsesBridgeLease?.setReasoningEffort?.(undefined)
    await post()
    expect(upstreamRequest).not.toHaveProperty('reasoning_effort')
  })
})

describe('SettingsService: Subagent model', () => {
  it('captures inherited identity from the originating live Session backend', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Session provider',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://session.example/v1',
      model: 'subagent-model',
      key: 'secret'
    })
    const provider = created.providers.find((candidate) => candidate.name === 'Session provider')!
    await service.setSubagentModel({ mode: 'inherit' })

    await expect(
      service.resolveSubagentExecutionModel('claude-code', {
        backendId: `claude-code:${provider.id}`,
        modelRoute: 'claude-anthropic',
        model: 'subagent-model',
        reasoningEffort: 'xhigh'
      })
    ).resolves.toEqual({
      frameworkId: 'claude-code',
      providerId: provider.id,
      backendId: `claude-code:${provider.id}`,
      modelRoute: 'claude-anthropic',
      model: 'subagent-model',
      reasoningEffort: 'xhigh'
    })
  })

  it('atomically validates and saves a fixed compound provider/model target', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Subagent gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://subagent.example/v1',
      model: 'subagent-model',
      key: 'secret'
    })
    const provider = created.providers.find((candidate) => candidate.name === 'Subagent gateway')!

    const snapshot = await service.setSubagentModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'subagent-model',
      reasoningEffort: 'high'
    })

    expect(snapshot.subagentModel).toEqual({
      mode: 'fixed',
      providerId: provider.id,
      model: 'subagent-model',
      reasoningEffort: 'high'
    })
  })

  it('keeps an admitted fixed backend available in memory after its provider is deleted', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Ephemeral admitted gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://subagent.example/v1',
      model: 'subagent-model',
      key: 'secret'
    })
    const provider = created.providers.find(
      (candidate) => candidate.name === 'Ephemeral admitted gateway'
    )!
    await service.setSubagentModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'subagent-model',
      reasoningEffort: 'high'
    })

    const admission = await service.admitSubagentExecutionModel('claude-code', {})
    await service.deleteProvider(provider.id)
    const claim = admission.backendLease!.claim()

    expect(admission.snapshot).toMatchObject({
      providerId: provider.id,
      model: 'subagent-model'
    })
    expect(claim.backend).toMatchObject({
      framework: { id: 'claude-code' },
      env: {
        ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
        ANTHROPIC_AUTH_TOKEN: expect.stringMatching(/^[a-f0-9]+$/)
      }
    })
    expect(JSON.stringify(claim.backend)).not.toContain('secret')
    await expect(service.resolveAdmittedSubagentBackend(admission.snapshot)).rejects.toThrow()
    await admission.backendLease!.release()
    await claim.release()
  })

  it('restores a deleted fixed provider by ID without rewriting the Subagent configuration', async () => {
    const service = createService()
    const draft = {
      type: 'custom' as const,
      name: 'Restorable Subagent gateway',
      apiEndpoints: ['anthropic' as const],
      baseUrl: 'https://subagent.example/v1',
      model: 'subagent-model',
      key: 'secret'
    }
    const provider = (await service.upsertProvider(draft)).providers.find(
      (candidate) => candidate.name === draft.name
    )!
    const fixed = {
      mode: 'fixed' as const,
      providerId: provider.id,
      model: 'subagent-model',
      reasoningEffort: 'high' as const
    }
    await service.setSubagentModel(fixed)

    await service.deleteProvider(provider.id)
    expect((await service.getSettingsView()).subagentModel).toEqual(fixed)
    const restored = await service.upsertProvider({ ...draft, id: provider.id })

    expect(restored.providers).toContainEqual(expect.objectContaining({ id: provider.id }))
    expect(restored.subagentModel).toEqual(fixed)
    await expect(service.resolveSubagentExecutionModel('claude-code', {})).resolves.toMatchObject({
      providerId: provider.id,
      model: 'subagent-model'
    })
  })

  it('rejects a stale unavailable fixed target and retains the committed configuration', async () => {
    const service = createService()
    await service.setSubagentModel({ mode: 'inherit' })

    await expect(
      service.setSubagentModel({
        mode: 'fixed',
        providerId: 'removed',
        model: 'removed-model',
        reasoningEffort: 'default'
      })
    ).rejects.toThrow('no longer available')
    expect((await service.getSettingsView()).subagentModel).toEqual({ mode: 'inherit' })
  })

  it('rejects a fixed provider whose latest validation failed before resolving a backend', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Failing Subagent gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://subagent.example/v1',
      model: 'subagent-model',
      key: 'secret'
    })
    const provider = created.providers[0]
    await service.setSubagentModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'subagent-model',
      reasoningEffort: 'high'
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    await service.validateProvider({ providerId: provider.id })

    await expect(service.resolveSubagentExecutionModel('claude-code', {})).rejects.toThrow(
      'validation failed'
    )
  })

  it('normalizes an unsupported fixed model effort to Default in the atomic commit', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'No-effort gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://subagent.example/v1',
      model: 'no-effort-model',
      key: 'secret',
      reasoningEffortPreset: 'unsupported'
    })

    await expect(
      service.setSubagentModel({
        mode: 'fixed',
        providerId: created.providers[0].id,
        model: 'no-effort-model',
        reasoningEffort: 'high'
      })
    ).resolves.toMatchObject({
      subagentModel: { reasoningEffort: 'default' }
    })
  })
})

describe('SettingsService: Reviewer model', () => {
  it('atomically validates and saves a fixed Reviewer target', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://reviewer.example/v1',
      model: 'reviewer-model',
      key: 'secret'
    })
    const provider = created.providers.find((candidate) => candidate.name === 'Reviewer gateway')!

    const snapshot = await service.setReviewerModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high'
    })

    expect(snapshot.reviewerModel).toEqual({
      mode: 'fixed',
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high'
    })
  })

  it('admits the configured fixed Reviewer backend for one Review chain', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Admitted Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://reviewer.example/v1',
      model: 'reviewer-model',
      key: 'secret'
    })
    const provider = created.providers.find(
      (candidate) => candidate.name === 'Admitted Reviewer gateway'
    )!
    await service.setReviewerModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high'
    })

    const admission = await service.admitReviewerExecutionModel()

    expect(admission.model).toBe('reviewer-model')
    expect(admission.fixedTarget).toEqual({
      frameworkId: 'claude-code',
      providerId: provider.id,
      model: { kind: 'required', id: 'reviewer-model' },
      reasoningEffort: 'high'
    })
  })

  it('uses the effective Agent Framework override for a fixed Reviewer target', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('claude-code')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Overridden Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://reviewer.example/v1',
      model: 'reviewer-model',
      key: 'secret'
    })
    const provider = created.providers.find(
      (candidate) => candidate.name === 'Overridden Reviewer gateway'
    )!
    await service.setReviewerModel({
      mode: 'fixed',
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high'
    })

    await expect(service.admitReviewerExecutionModel()).resolves.toMatchObject({
      model: 'reviewer-model',
      fixedTarget: {
        frameworkId: 'opencode',
        providerId: provider.id,
        model: { kind: 'required', id: 'reviewer-model' },
        reasoningEffort: 'high'
      }
    })
  })

  it('rejects a fixed Reviewer provider whose latest validation failed', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Failing Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://reviewer.example/v1',
      model: 'reviewer-model',
      key: 'secret'
    })
    const provider = created.providers.find(
      (candidate) => candidate.name === 'Failing Reviewer gateway'
    )!
    const fixed = {
      mode: 'fixed' as const,
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high' as const
    }
    await service.setReviewerModel(fixed)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    await service.validateProvider({ providerId: provider.id })

    await expect(service.admitReviewerExecutionModel()).rejects.toThrow('validation failed')
    expect((await service.getSettingsView()).reviewerModel).toEqual(fixed)
  })

  it('preserves a fixed Reviewer selection when its provider is deleted', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Restorable Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://reviewer.example/v1',
      model: 'reviewer-model',
      key: 'secret'
    })
    const provider = created.providers.find(
      (candidate) => candidate.name === 'Restorable Reviewer gateway'
    )!
    const fixed = {
      mode: 'fixed' as const,
      providerId: provider.id,
      model: 'reviewer-model',
      reasoningEffort: 'high' as const
    }
    await service.setReviewerModel(fixed)

    await service.deleteProvider(provider.id)

    expect((await service.getSettingsView()).reviewerModel).toEqual(fixed)
    await expect(service.admitReviewerExecutionModel()).resolves.toMatchObject({
      model: 'reviewer-model',
      fixedTarget: { providerId: provider.id }
    })
  })

  it('follows the Active model without admitting a second backend', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Active Reviewer gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://active.example/v1',
      model: 'active-model',
      key: 'secret'
    })
    await service.setActiveProvider(created.providers[0].id, 'active-model')
    await service.setReviewerModel({ mode: 'inherit' })

    const admission = await service.admitReviewerExecutionModel()

    expect(admission).toMatchObject({ model: 'active-model' })
    expect(admission.fixedTarget).toBeUndefined()
  })
})

describe('SettingsService: Vision model', () => {
  it('persists and admits an image-capable Codex subscription model', async () => {
    const service = createService()
    const codex = (await service.upsertProvider({ type: 'codex-isolated' })).providers[0]
    await repository.setAgentFramework('codex')
    const configuration = {
      providerId: codex.id,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high' as const
    }

    await expect(service.setVisionModel(configuration)).resolves.toMatchObject({
      visionModel: configuration
    })
    await expect(service.admitVisionModel()).resolves.toMatchObject({
      frameworkId: 'codex',
      providerId: configuration.providerId,
      model: { kind: 'required', id: 'gpt-5.6-sol' },
      reasoningEffort: 'high'
    })
  })

  it('persists and admits one image-capable fixed target', async () => {
    const service = createService()
    const created = await service.upsertProvider({
      type: 'custom',
      name: 'Vision gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://vision.example/v1',
      model: 'vision-model',
      key: 'secret',
      supportsImageInput: true
    })
    const configuration = {
      providerId: created.providers[0].id,
      model: 'vision-model',
      reasoningEffort: 'high' as const
    }

    await expect(service.setVisionModel(configuration)).resolves.toMatchObject({
      visionModel: configuration
    })
    await expect(service.admitVisionModel()).resolves.toEqual({
      frameworkId: 'claude-code',
      providerId: configuration.providerId,
      model: { kind: 'required', id: 'vision-model' },
      reasoningEffort: 'high',
      configurationFingerprint: expect.any(String)
    })
  })

  it('rejects a target that cannot receive images and preserves the prior configuration', async () => {
    const service = createService()
    const visual = await service.upsertProvider({
      type: 'custom',
      name: 'Visual gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://vision.example/v1',
      model: 'vision-model',
      key: 'secret',
      supportsImageInput: true
    })
    const configuration = {
      providerId: visual.providers[0].id,
      model: 'vision-model',
      reasoningEffort: 'default' as const
    }
    await service.setVisionModel(configuration)
    const textOnly = await service.upsertProvider({
      type: 'custom',
      name: 'Text gateway',
      apiEndpoints: ['anthropic'],
      baseUrl: 'https://text.example/v1',
      model: 'text-model',
      key: 'secret',
      supportsImageInput: false
    })

    await expect(
      service.setVisionModel({
        providerId: textOnly.providers.find((provider) => provider.name === 'Text gateway')!.id,
        model: 'text-model',
        reasoningEffort: 'default'
      })
    ).rejects.toThrow('does not support image input')
    expect((await service.getSettingsView()).visionModel).toEqual(configuration)
  })
})

describe('SettingsService: notifications preference', () => {
  it('projects enabled when no preference is stored', async () => {
    const service = createService()

    expect((await service.getSettingsView()).notificationsEnabled).toBe(true)
    expect(await service.getNotificationsEnabled()).toBe(true)
  })

  it('projects the stored preference into the settings view', async () => {
    const service = createService()

    await repository.setNotificationsEnabled(false)

    expect((await service.getSettingsView()).notificationsEnabled).toBe(false)
    expect(await service.getNotificationsEnabled()).toBe(false)
  })

  it('persists the preference and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setNotificationsEnabled(false)

    expect(snapshot.notificationsEnabled).toBe(false)
    expect((await repository.getSettings()).notificationsEnabled).toBe(false)
  })

  it('defaults native notification content to hidden and persists an explicit opt-in', async () => {
    const service = createService()

    expect((await service.getSettingsView()).showNotificationContent).toBe(false)
    expect(await service.getShowNotificationContent()).toBe(false)

    const snapshot = await service.setShowNotificationContent(true)

    expect(snapshot.showNotificationContent).toBe(true)
    expect((await repository.getSettings()).showNotificationContent).toBe(true)
  })
})

describe('SettingsService: conversation Skill import preference', () => {
  it('defaults to enabled when no preference is stored', async () => {
    const service = createService()

    expect((await service.getSettingsView()).conversationSkillImportEnabled).toBe(true)
    expect(await service.getConversationSkillImportEnabled()).toBe(true)
  })

  it('projects and persists the disabled preference', async () => {
    const service = createService()

    const snapshot = await service.setConversationSkillImportEnabled(false)

    expect(snapshot.conversationSkillImportEnabled).toBe(false)
    expect(await service.getConversationSkillImportEnabled()).toBe(false)
    expect((await repository.getSettings()).conversationSkillImportEnabled).toBe(false)
  })
})

describe('SettingsService: close preference', () => {
  it('projects, persists, and resets the Windows titlebar-close behavior', async () => {
    const service = createService()

    expect(await service.getClosePreference()).toBeUndefined()

    const saved = await service.setClosePreference('quit')
    expect(saved.closePreference).toBe('quit')
    expect(await service.getClosePreference()).toBe('quit')

    const reset = await service.setClosePreference(undefined)
    expect(reset.closePreference).toBeUndefined()
  })
})

describe('SettingsService: project files filter preference', () => {
  it('projects, persists, and resets the Files-tab source filter', async () => {
    const service = createService()

    expect((await service.getSettingsView()).projectFilesFilter).toBeUndefined()

    const saved = await service.setProjectFilesFilter({ sourceMode: 'local', localRootId: 'r1' })
    expect(saved.projectFilesFilter).toEqual({ sourceMode: 'local', localRootId: 'r1' })
    expect((await service.getSettingsView()).projectFilesFilter).toEqual({
      sourceMode: 'local',
      localRootId: 'r1'
    })

    const reset = await service.setProjectFilesFilter(undefined)
    expect(reset.projectFilesFilter).toBeUndefined()
  })
})

describe('SettingsService: app icon variant', () => {
  it('projects the default light variant when none is stored', async () => {
    const service = createService()

    expect((await service.getSettingsView()).appIconVariant).toBe('light')
    expect(await service.getAppIconVariant()).toBe('light')
  })

  it('persists the variant and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setAppIconVariant('dark')

    expect(snapshot.appIconVariant).toBe('dark')
    expect(await service.getAppIconVariant()).toBe('dark')
    expect((await repository.getSettings()).appIconVariant).toBe('dark')
  })
})

describe('SettingsService: default permission profile', () => {
  it('projects ask when no profile is stored', async () => {
    const service = createService()

    expect((await service.getSettingsView()).defaultPermissionProfile).toBe('ask')
  })

  it('projects a valid profile from settings.json', async () => {
    await writeFile(
      join(storageRoot, 'settings.json'),
      JSON.stringify({ version: 2, defaultPermissionProfile: 'auto' }),
      'utf8'
    )
    const service = createService()

    expect((await service.getSettingsView()).defaultPermissionProfile).toBe('auto')
  })

  it('persists a profile and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setDefaultPermissionProfile('full')

    expect(snapshot.defaultPermissionProfile).toBe('full')
    expect((await repository.getSettings()).defaultPermissionProfile).toBe('full')
  })
})

describe('SettingsService: listAgentHomeSkills framework routing', () => {
  // The shared ~/.agents/skills directory is always scanned. The active framework contributes one
  // additional source: ~/.claude/skills for Claude Code or ~/.codex/skills for Codex.

  // Seeds a fake skill at <agentHome>/skills/<slug>/SKILL.md so the scanner picks it up.
  const seedSkill = async (agentHome: string, slug: string): Promise<void> => {
    const skillDir = join(agentHome, 'skills', slug)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Test skill ${slug}\n---\nBody of ${slug}.\n`
    )
  }

  it('scans shared and Claude homes when the active framework is claude-code', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-'))
    await seedSkill(userClaudeDir, 'alpha')
    await seedSkill(userCodexDir, 'codex-only')
    await seedSkill(userAgentsDir, 'shared')
    const service = createService(undefined, { userClaudeDir, userCodexDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const items = await service.listAgentHomeSkills()

    expect(items.map(({ source, slug }) => ({ source, slug }))).toEqual([
      { source: 'agents', slug: 'shared' },
      { source: 'claude', slug: 'alpha' }
    ])
    expect(items.every((item) => !('path' in item))).toBe(true)
  })

  it('keeps framework-specific results when the shared source cannot be scanned', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-readable-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-unreadable-'))
    await seedSkill(userClaudeDir, 'alpha')
    await writeFile(join(userAgentsDir, 'skills'), 'not a directory')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const items = await service.listAgentHomeSkills()

    expect(items.map(({ source, slug }) => ({ source, slug }))).toEqual([
      { source: 'claude', slug: 'alpha' }
    ])
  })

  it('rejects when a missing shared source would mask an active-source failure', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-unreadable-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-missing-'))
    await writeFile(join(userClaudeDir, 'skills'), 'not a directory')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    await expect(service.listAgentHomeSkills()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('surfaces a source failure when the remaining installed-skill sources are empty', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-empty-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-unreadable-'))
    await mkdir(join(userClaudeDir, 'skills'))
    await writeFile(join(userAgentsDir, 'skills'), 'not a directory')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    await expect(service.listAgentHomeSkills()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('rejects the scan when every configured source fails', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-unreadable-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-unreadable-'))
    await writeFile(join(userClaudeDir, 'skills'), 'not a directory')
    await writeFile(join(userAgentsDir, 'skills'), 'not a directory')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    await expect(service.listAgentHomeSkills()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('previews an installed candidate through its trusted source and slug without exposing host paths', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-preview-agent-claude-'))
    await seedSkill(userClaudeDir, 'alpha')
    await writeFile(
      join(userClaudeDir, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: Alpha\ndescription: Preview me\nauthor: Ada\n---\n# Safe body\n'
    )
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    const preview = await service.previewAgentHomeSkill({ source: 'claude', slug: 'alpha' })

    expect(preview).toEqual({
      name: 'Alpha',
      description: 'Preview me',
      sourceLabel: '~/.claude/skills/alpha',
      metadata: { author: 'Ada' },
      body: '# Safe body\n',
      files: ['SKILL.md']
    })
    expect(JSON.stringify(preview)).not.toContain(userClaudeDir)
  })

  it('redacts the installed skill host path from preview errors', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-preview-agent-error-'))
    await seedSkill(userClaudeDir, 'alpha')
    const hostSkillPath = join(userClaudeDir, 'skills', 'alpha')
    const previewAgentHomeSkill = vi
      .fn()
      .mockRejectedValue(new Error(`EACCES: ${join(hostSkillPath, 'SKILL.md')}`))
    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { previewAgentHomeSkill } as any
    })
    await repository.setAgentFramework('claude-code')

    const error = await service
      .previewAgentHomeSkill({ source: 'claude', slug: 'alpha' })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(userClaudeDir)
    expect((error as Error).message).toContain('~/.claude/skills/alpha/SKILL.md')
  })

  it('scans shared and Codex homes when the active framework is codex', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-'))
    await seedSkill(userCodexDir, 'beta')
    await seedSkill(userClaudeDir, 'claude-only')
    await seedSkill(userAgentsDir, 'shared')
    const service = createService(undefined, { userClaudeDir, userCodexDir, userAgentsDir })
    await repository.setAgentFramework('codex')

    const items = await service.listAgentHomeSkills()

    expect(items.map(({ source, slug }) => ({ source, slug }))).toEqual([
      { source: 'agents', slug: 'shared' },
      { source: 'codex', slug: 'beta' }
    ])
  })

  it('scans only the shared home when the active framework is OpenCode', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-agent-shared-'))
    await seedSkill(userClaudeDir, 'hidden-claude')
    await seedSkill(userCodexDir, 'hidden-codex')
    await seedSkill(userAgentsDir, 'visible-shared')
    const service = createService(undefined, { userClaudeDir, userCodexDir, userAgentsDir })
    await repository.setAgentFramework('opencode')

    expect(
      (await service.listAgentHomeSkills()).map(({ source, slug }) => ({ source, slug }))
    ).toEqual([{ source: 'agents', slug: 'visible-shared' }])
  })
})

describe('SettingsService: claude-isolated edit preserves the stored token', () => {
  // P1 from the Codex correctness review: editing the provider must carry the encrypted token
  // through. Before the fix, the claude-isolated branch of upsertProvider did not propagate
  // existing.keyRef / existing.keyMask, so a model edit silently invalidated the stored credential
  // while the verified-marker stayed.

  it('keeps keyRef + keyMask on a model edit', async () => {
    const service = createService()
    // Seed the encrypted token directly via the repository — the only path that writes keyRef
    // onto the fixed builtin record, and it sidesteps the controller contract so the test stays
    // focused on the upsert branch under test.
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-xyz'),
      keyMask: maskKey('test-token-xyz')
    })

    const before = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(before?.keyRef).toBeTruthy()
    expect(before?.keyMask).toBeTruthy()

    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })

    const after = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(after?.keyRef).toBe(before?.keyRef)
    expect(after?.keyMask).toBe(before?.keyMask)
    expect(after?.model).toBe('claude-sonnet-4-5')
  })
})

describe('SettingsService: logoutIsolatedClaude error propagation', () => {
  // P1 from the Codex correctness review: a controller-level error must surface as a failed
  // result regardless of `authenticated`. Before the fix the `status.message` branch was gated on
  // `authenticated !== false`, so a failed logout that left the token in storage still
  // returned `{ ok: true }` and the UI reconnected as if sign-out had succeeded.

  it('surfaces the controller message even when authenticated stays false', async () => {
    const claudeIsolatedAuth = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-out timed out.'
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth })

    const result = await service.logoutIsolatedClaude()

    expect(result).toMatchObject({ ok: false, message: 'Codex sign-out timed out.' })
  })

  it('clears credential metadata when the controller signs out successfully', async () => {
    const claudeIsolatedAuth = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      expiresAt: Date.now() + 1_000,
      lastValidatedAt: Date.now()
    })

    const result = await service.logoutIsolatedClaude()
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )

    expect(result).toEqual({ ok: true, category: 'ok' })
    expect(stored?.expiresAt).toBeUndefined()
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toBeUndefined()
  })
})

describe('SettingsService: importAgentHomeSkills', () => {
  // Path authority lives in main. The renderer supplies a source id plus slug; the service resolves
  // both against the currently available global sources and returns one result per selected skill.

  const seedSkill = async (agentHome: string, slug: string): Promise<string> => {
    const skillDir = join(agentHome, 'skills', slug)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Test\n---\nBody.\n`
    )
    return skillDir
  }

  it('batch-imports selected shared and framework-specific skills', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-ok-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-shared-'))
    await seedSkill(userClaudeDir, 'alpha')
    await seedSkill(userAgentsDir, 'shared')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkills({
      skills: [
        { source: 'agents', slug: 'shared' },
        { source: 'claude', slug: 'alpha' }
      ]
    })

    expect(result.results).toEqual([
      { source: 'agents', slug: 'shared', status: 'imported', id: 'imported-shared' },
      { source: 'claude', slug: 'alpha', status: 'imported', id: 'imported-alpha' }
    ])
    expect(result.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(['imported-shared', 'imported-alpha'])
    )
  })

  it('tracks imported state independently for same-slug skills from different sources', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-duplicate-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-shared-'))
    await seedSkill(userClaudeDir, 'duplicate')
    await seedSkill(userAgentsDir, 'duplicate')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const first = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'duplicate' }]
    })

    expect(first.results[0]).toMatchObject({
      source: 'agents',
      slug: 'duplicate',
      status: 'imported',
      id: 'imported-duplicate'
    })
    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'duplicate', alreadyImported: true }),
        expect.objectContaining({ source: 'claude', slug: 'duplicate', alreadyImported: false })
      ])
    )

    const second = await service.importAgentHomeSkills({
      skills: [{ source: 'claude', slug: 'duplicate' }]
    })

    expect(second.results[0]).toMatchObject({
      source: 'claude',
      slug: 'duplicate',
      status: 'imported',
      id: 'imported-duplicate-2'
    })
  })

  it('recognizes an installed skill imported before source metadata was recorded', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-legacy-'))
    await seedSkill(userAgentsDir, 'legacy')
    const legacyDir = join(storageRoot, 'skills', 'imported', 'legacy')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: legacy\ndescription: Test\n---\nBody.\n'
    )
    const service = createService(undefined, { userAgentsDir })

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'legacy', alreadyImported: true })
      ])
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'legacy' }]
    })
    expect(result.results[0]).toEqual({
      source: 'agents',
      slug: 'legacy',
      status: 'unchanged',
      id: 'imported-legacy'
    })
  })

  it('keeps legacy slug dedup when the preparatory installed-source scan fails', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-scan-failure-'))
    await seedSkill(userAgentsDir, 'legacy')
    const legacyDir = join(storageRoot, 'skills', 'imported', 'legacy')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: legacy\ndescription: Test\n---\nBody.\n'
    )
    const service = createService(undefined, { userAgentsDir })
    vi.spyOn(service, 'listAgentHomeSkills').mockRejectedValueOnce(
      new Error('An unrelated installed source became unreadable.')
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'legacy' }]
    })

    expect(result.results[0]).toEqual({
      source: 'agents',
      slug: 'legacy',
      status: 'unchanged',
      id: 'imported-legacy'
    })
  })

  it('does not deduplicate different same-slug content when the installed-source scan fails', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-scan-failure-'))
    await seedSkill(userAgentsDir, 'legacy')
    const legacyDir = join(storageRoot, 'skills', 'imported', 'legacy')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: legacy\ndescription: Earlier import\n---\nDifferent body.\n'
    )
    const service = createService(undefined, { userAgentsDir })
    vi.spyOn(service, 'listAgentHomeSkills').mockRejectedValueOnce(
      new Error('An unrelated installed source became unreadable.')
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'legacy' }]
    })

    expect(result.results[0]).toEqual({
      source: 'agents',
      slug: 'legacy',
      status: 'imported',
      id: 'imported-legacy-2'
    })
  })

  it('keeps a different same-slug GitHub import separate from an installed skill', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-existing-'))
    await seedSkill(userAgentsDir, 'existing')
    const importedDir = join(storageRoot, 'skills', 'imported', 'existing')
    await mkdir(importedDir, { recursive: true })
    await writeFile(
      join(importedDir, 'SKILL.md'),
      '---\nname: existing\ndescription: GitHub import\n---\nBody.\n'
    )
    await writeFile(
      join(importedDir, '.source.json'),
      JSON.stringify({
        url: 'https://github.com/example/skills/tree/main/existing',
        signature: 'sig'
      })
    )
    const service = createService(undefined, { userAgentsDir })

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'existing', alreadyImported: false })
      ])
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'existing' }]
    })
    expect(result.results[0]).toMatchObject({
      status: 'imported',
      id: 'imported-existing-2'
    })
    expect(result.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(['imported-existing', 'imported-existing-2'])
    )
  })

  it('recognizes an identical same-slug GitHub import by content', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-identical-'))
    await seedSkill(userAgentsDir, 'identical')
    const importedDir = join(storageRoot, 'skills', 'imported', 'identical')
    await mkdir(importedDir, { recursive: true })
    await writeFile(
      join(importedDir, 'SKILL.md'),
      '---\nname: identical\ndescription: Test\n---\nBody.\n'
    )
    await writeFile(
      join(importedDir, '.source.json'),
      JSON.stringify({
        url: 'https://github.com/example/skills/tree/main/identical',
        signature: 'github-signature'
      })
    )
    const service = createService(undefined, { userAgentsDir })

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'identical', alreadyImported: true })
      ])
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'identical' }]
    })
    expect(result.results[0]).toMatchObject({
      status: 'unchanged',
      id: 'imported-identical'
    })
  })

  it('marks every identical same-slug source imported when legacy content matches', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-legacy-claude-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-legacy-shared-'))
    await seedSkill(userClaudeDir, 'duplicate')
    await seedSkill(userAgentsDir, 'duplicate')
    const legacyDir = join(storageRoot, 'skills', 'imported', 'duplicate')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: duplicate\ndescription: Test\n---\nBody.\n'
    )
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'duplicate', alreadyImported: true }),
        expect.objectContaining({ source: 'claude', slug: 'duplicate', alreadyImported: true })
      ])
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'duplicate' }]
    })
    expect(result.results[0]).toMatchObject({
      status: 'unchanged',
      id: 'imported-duplicate'
    })
  })

  it('reports unsafe slugs and unavailable sources without aborting other selected skills', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-escape-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-shared-'))
    await seedSkill(userAgentsDir, 'safe')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkills({
      skills: [
        { source: 'agents', slug: 'safe' },
        { source: 'claude', slug: '../../etc' },
        { source: 'codex', slug: 'not-active' }
      ]
    })

    expect(result.results[0]).toMatchObject({ status: 'imported', id: 'imported-safe' })
    expect(result.results[1]).toMatchObject({ error: expect.stringMatching(/unsafe slug/) })
    expect(result.results[2]).toMatchObject({ error: expect.stringMatching(/not available/) })
  })

  it('reports malformed batch entries without aborting valid selected skills', async () => {
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-agent-malformed-'))
    await seedSkill(userAgentsDir, 'safe')
    const service = createService(undefined, { userAgentsDir })

    const result = await service.importAgentHomeSkills({
      skills: [null, { source: 'agents', slug: 'safe' }, undefined] as never
    })

    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toMatchObject({
      error: expect.stringMatching(/valid source and slug/)
    })
    expect(result.results[1]).toMatchObject({ status: 'imported', id: 'imported-safe' })
    expect(result.results[2]).toMatchObject({
      error: expect.stringMatching(/valid source and slug/)
    })
  })
})

describe('SettingsService: claude-isolated login + status coordination', () => {
  // Round 4 of the AI review: the controller's post-save roundtrip check + the service's
  // "awaiting first Claude session" placeholder combine so the Settings card does not show a
  // green verified check for a credential Claude has not actually accepted. These tests pin that
  // contract end-to-end.

  const successAuth = {
    getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
    loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: true })),
    loginIsolated: vi.fn(async (token: string) => {
      if (token.trim() === 'sk-ant-valid') return { supported: true, authenticated: true }
      return { supported: true, authenticated: false, message: 'invalid token' }
    }),
    cancelLogin: vi.fn(),
    logoutIsolated: vi.fn().mockResolvedValue({ supported: true, authenticated: false })
  }

  it('verifies a pasted token with Claude under the app-owned config before reporting success', async () => {
    const probe =
      vi.fn<
        (executablePath: string, env: NodeJS.ProcessEnv, runtimeArgs?: string[]) => Promise<void>
      >()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: true, category: 'ok', applied: true })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledWith(
      '/bin/claude',
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot),
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-valid'
      }),
      ['--add-dir', expect.stringContaining(getClaudeSkillRuntimeRoot(storageRoot))]
    )
  })

  it('keeps a rejected setup token unverified and records an actionable auth failure', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('Command failed with exit code 1'), {
        stdout: 'Invalid API key. Please run /login.'
      })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'auth', applied: true })
    expect(result.message).toMatch(/rejected the setup token/i)
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toMatchObject({
      category: 'auth',
      message: expect.stringMatching(/rejected the setup token/i)
    })
  })

  it('does not misreport a missing Claude executable as a rejected token', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/missing/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'unknown', applied: true })
    expect(result.message).toMatch(/could not run.*re-detect Claude/i)
    expect(result.message).not.toMatch(/rejected.*token/i)
  })

  it('reports a terminated Claude credential probe as a timeout', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'timeout', applied: true })
    expect(result.message).toMatch(/validation timed out/i)
  })

  it('reports a Claude credential probe DNS failure as a network error', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('getaddrinfo EAI_AGAIN api.anthropic.com'), { code: 'EAI_AGAIN' })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'network', applied: true })
    expect(result.message).toMatch(/could not reach Anthropic.*check your network/i)
  })

  it('re-probes a previously verified token so later expiry is reported', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(new Error('token expired'))
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    if (!stored) throw new Error('claude-isolated provider not found')
    await repository.upsertProvider({
      ...stored,
      lastValidatedAt: Date.now(),
      lastValidationFailure: undefined
    })

    const result = await service.validateProvider({ providerId: CLAUDE_ISOLATED_PROVIDER_ID })

    expect(probe).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: false, category: 'auth' })
    expect(result.message).toMatch(/rejected the setup token/i)
  })

  it('does not restore a token cleared while its login probe is still running', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const service = createService(undefined, { executeClaudeProbe: probe })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription'
    })

    const login = service.loginIsolatedClaude('sk-ant-valid')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await service.logoutIsolatedClaude()
    finishProbe?.()

    const result = await login
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(result).toMatchObject({ ok: true, applied: false })
    expect(stored?.keyRef).toBeUndefined()
    expect(stored?.lastValidatedAt).toBeUndefined()
  })

  it('discards an older probe when a newer setup-token login wins', async () => {
    const finishProbes: Array<() => void> = []
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbes.push(resolve)
        })
    )
    const service = createService(undefined, { executeClaudeProbe: probe })
    const { encryptKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription'
    })

    const olderLogin = service.loginIsolatedClaude('sk-ant-older')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const newerLogin = service.loginIsolatedClaude('sk-ant-newer')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))

    finishProbes[1]?.()
    expect(await newerLogin).toMatchObject({ ok: true, applied: true })
    finishProbes[0]?.()
    expect(await olderLogin).toMatchObject({ ok: true, applied: false })

    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(stored?.keyRef).toBe(encryptKey('sk-ant-newer'))
    expect(stored?.lastValidatedAt).toBeGreaterThan(0)
  })

  it('records expiresAt and a verified timestamp after a successful token probe', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    // Seed the provider card. The loginIsolatedClaude path requires an existing record to find
    // (the early-return for a missing card is the "applied: false" branch).
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const before = Date.now()
    const result = await service.loginIsolatedClaude('sk-ant-valid')
    const after = Date.now()

    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
    const stored = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    // Estimated one-year expiry: must be within the window the service set, not "now exactly".
    expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + 364 * 24 * 60 * 60 * 1000)
    expect(stored?.expiresAt).toBeLessThanOrEqual(after + 366 * 24 * 60 * 60 * 1000)
    expect(stored?.lastValidatedAt).toBeGreaterThanOrEqual(before)
    expect(stored?.lastValidationFailure).toBeUndefined()
  })

  it('logoutIsolatedClaude on error does NOT clear the stored validation markers', async () => {
    // A failed logout must leave lastValidationFailure / lastValidatedAt alone: a transient store
    // error that flips the markers to "cleared" would lie to the next status check (the token is
    // still in storage, and any pending failure marker is the truthful state to keep).
    const failingLogout = {
      ...successAuth,
      logoutIsolated: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: false,
        message: 'keychain delete failed'
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth: failingLogout })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
    // Stamp a real failure marker on the record so we can verify it survives the failed logout.
    const originalFailureMessage = 'Claude rejected the setup token.'
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      lastValidationFailure: {
        at: Date.now(),
        category: 'auth',
        message: originalFailureMessage
      }
    })

    const result = await service.logoutIsolatedClaude()

    expect(result.ok).toBe(false)
    const stored = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    // Marker is the original — not cleared, not replaced with an "ok" record.
    expect(stored?.lastValidationFailure?.message).toBe(originalFailureMessage)
  })
})

describe('SettingsService: claude-isolated validation flow', () => {
  const successAuth = {
    getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
    loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: true })),
    loginIsolated: vi.fn(async () => ({ supported: true, authenticated: true })),
    cancelLogin: vi.fn(),
    logoutIsolated: vi.fn().mockResolvedValue({ supported: true, authenticated: false })
  }

  const seedStoredToken = async (): Promise<void> => {
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
  }

  it('validateProvider re-probes claude-isolated and records the successful result', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await seedStoredToken()

    const storedId = 'builtin-claude-isolated'
    const result = await service.validateProvider({ providerId: storedId })

    expect(result.ok).toBe(true)
    expect(probe).toHaveBeenCalledOnce()
    const after = (await repository.getSettings()).providers.find((p) => p.id === storedId)
    expect(after?.lastValidatedAt).toBeGreaterThan(0)
    expect(after?.lastValidationFailure).toBeUndefined()
  })
})

describe('SettingsService: claude-isolated edit preserves expiresAt + keyRef', () => {
  // Round 6 of the AI review: editing the provider (changing the model) must not drop the
  // credential's estimated expiry. The setup-token lifetime is one of the few signals a user has
  // that the credential is approaching its limit, so the Settings card's "Expires <date>" must
  // survive a model edit on the same stored record.

  it('keeps existing.expiresAt through an edit that only changes the model', async () => {
    const service = createService(undefined, {
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
    // Mirror the production flow: loginIsolatedClaude seeds expiresAt on a fresh paste.
    await service.loginIsolatedClaude('test-token-seed')

    const before = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(before?.expiresAt).toBeGreaterThan(0)
    const originalExpiresAt = before!.expiresAt

    // The renderer submits an edit that only changes the model — no key, no name, no type flip.
    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })

    const after = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(after?.expiresAt).toBe(originalExpiresAt)
    expect(after?.model).toBe('claude-sonnet-4-5')
  })
})

describe('SettingsService: importAgentHomeSkills realpath containment', () => {
  // Round 6 of the AI review: a symlink that points outside the agent home is a containment
  // escape even when `resolve()` (lexical) is satisfied. The realpath fallback closes the gap.
  const seedSkill = async (agentHome: string, slug: string): Promise<string> => {
    const dir = join(agentHome, 'skills', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: Test\n---\nBody.\n`)
    return dir
  }

  it('rejects a symlink inside the agent home that points outside it', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'os-import-outside-'))
    await writeFile(
      join(outside, 'SKILL.md'),
      '---\nname: outside\ndescription: Test\n---\nBody.\n'
    )
    // Create a symlink at `<home>/skills/payload -> <outside>` so the basename is a valid slug
    // and `resolve(home, slug)` would land at the symlink target.
    const linkPath = join(userClaudeDir, 'skills', 'payload')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(outside, linkPath)
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    expect((await service.listAgentHomeSkills()).map((skill) => skill.slug)).not.toContain(
      'payload'
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'claude', slug: 'payload' }]
    })

    await expect(
      service.previewAgentHomeSkill({ source: 'claude', slug: 'payload' })
    ).rejects.toThrow(/outside its source/)

    expect(result.results[0]).toMatchObject({
      error: expect.stringMatching(/outside its source/)
    })
  })

  it('rejects symlinks to an allowed skills root or a nested descendant', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-depth-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-shared-'))
    const realSkill = await seedSkill(userAgentsDir, 'real-skill')
    const nested = join(realSkill, 'references')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'notes.md'), 'Nested content.')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(join(userAgentsDir, 'skills'), join(userClaudeDir, 'skills', 'root-alias'))
    await symlink(nested, join(userClaudeDir, 'skills', 'nested-alias'))
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkills({
      skills: [
        { source: 'claude', slug: 'root-alias' },
        { source: 'claude', slug: 'nested-alias' }
      ]
    })

    expect(result.results).toEqual([
      expect.objectContaining({ error: expect.stringMatching(/top-level skill directory/) }),
      expect.objectContaining({ error: expect.stringMatching(/top-level skill directory/) })
    ])
    expect(result.skills.map((skill) => skill.id)).not.toEqual(
      expect.arrayContaining(['imported-root-alias', 'imported-nested-alias'])
    )
  })

  it('canonicalizes a framework symlink alias to the shared installed skill', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-benign-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-shared-'))
    const target = await seedSkill(userAgentsDir, 'real-skill')
    const linkDir = join(userClaudeDir, 'skills', 'linked-skill')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(target, linkDir)
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'agents', slug: 'real-skill' })])
    )
    expect(await service.listAgentHomeSkills()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'claude', slug: 'linked-skill' })])
    )

    const canonical = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'real-skill' }]
    })
    expect(canonical.results[0]).toMatchObject({
      status: 'imported',
      id: 'imported-real-skill'
    })

    const alias = await service.importAgentHomeSkills({
      skills: [{ source: 'claude', slug: 'linked-skill' }]
    })

    expect(alias.results[0]).toEqual({
      source: 'claude',
      slug: 'linked-skill',
      status: 'unchanged',
      id: 'imported-real-skill'
    })
  })

  it('matches a legacy import recorded under a symlink alias after canonicalization', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-legacy-alias-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-legacy-shared-'))
    const target = await seedSkill(userAgentsDir, 'real-skill')
    await seedSkill(userAgentsDir, 'linked-skill')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(target, join(userClaudeDir, 'skills', 'linked-skill'))

    const legacyDir = join(storageRoot, 'skills', 'imported', 'linked-skill')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: real-skill\ndescription: Test\n---\nBody.\n'
    )

    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const installed = await service.listAgentHomeSkills()
    expect(installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: true
        })
      ])
    )
    expect(installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'linked-skill',
          alreadyImported: false
        })
      ])
    )

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'real-skill' }]
    })

    expect(result.results[0]).toEqual({
      source: 'agents',
      slug: 'real-skill',
      status: 'unchanged',
      id: 'imported-linked-skill'
    })
    expect(result.skills.map((skill) => skill.id)).not.toContain('imported-real-skill')
  })

  it('updates an existing alias identity through its canonical installed-skill row', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-source-alias-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-source-shared-'))
    const target = await seedSkill(userAgentsDir, 'real-skill')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(target, join(userClaudeDir, 'skills', 'linked-skill'))

    const importedDir = join(storageRoot, 'skills', 'imported', 'linked-skill')
    await mkdir(importedDir, { recursive: true })
    await writeFile(
      join(importedDir, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: Old alias import\n---\nOld body.\n'
    )
    await writeFile(
      join(importedDir, '.source.json'),
      JSON.stringify({
        signature: 'stale-signature',
        agentHome: { source: 'claude', slug: 'linked-skill' }
      })
    )

    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkills({
      skills: [{ source: 'agents', slug: 'real-skill' }]
    })

    expect(result.results[0]).toEqual({
      source: 'agents',
      slug: 'real-skill',
      status: 'updated',
      id: 'imported-linked-skill'
    })
    expect(result.skills.map((skill) => skill.id)).not.toContain('imported-real-skill')
    await expect(
      readFile(join(importedDir, '.source.json'), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({ agentHome: { source: 'agents', slug: 'real-skill' } })
  })

  it('recognizes unchanged alias metadata after the source moves behind a symlink', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-moved-alias-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-moved-shared-'))
    const original = await seedSkill(userClaudeDir, 'linked-skill')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    expect(
      (
        await service.importAgentHomeSkills({
          skills: [{ source: 'claude', slug: 'linked-skill' }]
        })
      ).results[0]
    ).toMatchObject({ status: 'imported', id: 'imported-linked-skill' })

    const canonical = join(userAgentsDir, 'skills', 'real-skill')
    await mkdir(join(userAgentsDir, 'skills'), { recursive: true })
    await rename(original, canonical)
    await symlink(canonical, original)

    await service.migrateAgentHomeSkillIdentities()

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: true
        })
      ])
    )

    await repository.setAgentFramework('opencode')
    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: true
        })
      ])
    )
  })

  it('migrates alias metadata when the framework skills root becomes a shared-root symlink', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-root-alias-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-root-shared-'))
    const original = await seedSkill(userClaudeDir, 'real-skill')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    expect(
      (
        await service.importAgentHomeSkills({
          skills: [{ source: 'claude', slug: 'real-skill' }]
        })
      ).results[0]
    ).toMatchObject({ status: 'imported', id: 'imported-real-skill' })

    const sharedSkill = join(userAgentsDir, 'skills', 'real-skill')
    await mkdir(join(userAgentsDir, 'skills'), { recursive: true })
    await rename(original, sharedSkill)
    await rm(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(join(userAgentsDir, 'skills'), join(userClaudeDir, 'skills'))

    // Startup migration must include inactive framework roots. The old identity is Claude-owned,
    // while the selected framework exposes only the shared Agent Home root.
    await repository.setAgentFramework('opencode')
    await service.migrateAgentHomeSkillIdentities()

    expect(await service.listAgentHomeSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: true
        })
      ])
    )

    await expect(
      readFile(join(storageRoot, 'skills', 'imported', 'real-skill', '.source.json'), 'utf8').then(
        JSON.parse
      )
    ).resolves.toMatchObject({ agentHome: { source: 'agents', slug: 'real-skill' } })
  })

  it('does not rewrite imported metadata while listing Agent Home Skills', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-symlink-root-alias-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-list-symlink-root-shared-'))
    const original = await seedSkill(userClaudeDir, 'real-skill')
    const service = createService(undefined, { userClaudeDir, userAgentsDir })
    await repository.setAgentFramework('claude-code')

    expect(
      (
        await service.importAgentHomeSkills({
          skills: [{ source: 'claude', slug: 'real-skill' }]
        })
      ).results[0]
    ).toMatchObject({ status: 'imported', id: 'imported-real-skill' })

    const importedSource = join(storageRoot, 'skills', 'imported', 'real-skill', '.source.json')
    const metadataBeforeList = await readFile(importedSource, 'utf8')
    const sharedSkill = join(userAgentsDir, 'skills', 'real-skill')
    await mkdir(join(userAgentsDir, 'skills'), { recursive: true })
    await rename(original, sharedSkill)
    await rm(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(join(userAgentsDir, 'skills'), join(userClaudeDir, 'skills'))

    await expect(service.listAgentHomeSkills()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: true
        })
      ])
    )

    await expect(readFile(importedSource, 'utf8')).resolves.toBe(metadataBeforeList)
  })

  it('keeps startup available when Agent Home identity migration cannot scan its roots', async () => {
    const invalidHome = join(storageRoot, 'agent-home-file')
    await writeFile(invalidHome, 'not a directory')
    const service = createService(undefined, {
      userAgentsDir: invalidHome,
      userClaudeDir: invalidHome,
      userCodexDir: invalidHome
    })

    await expect(service.migrateAgentHomeSkillIdentities()).resolves.toBeUndefined()
  })

  it('keeps a failed Agent Home identity migration selectable for manual repair', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-migration-failure-legacy-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'os-migration-failure-shared-'))
    const original = await seedSkill(userClaudeDir, 'real-skill')
    const userSkills = new UserSkillRepository(storageRoot)
    const service = createService(undefined, { userClaudeDir, userAgentsDir, userSkills })
    await repository.setAgentFramework('claude-code')
    await service.importAgentHomeSkills({
      skills: [{ source: 'claude', slug: 'real-skill' }]
    })

    await mkdir(join(userAgentsDir, 'skills'), { recursive: true })
    await rename(original, join(userAgentsDir, 'skills', 'real-skill'))
    await rm(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(join(userAgentsDir, 'skills'), join(userClaudeDir, 'skills'))
    vi.spyOn(userSkills, 'importAgentHomeSkill').mockRejectedValueOnce(
      new Error('simulated migration write failure')
    )

    await service.migrateAgentHomeSkillIdentities()

    await expect(service.listAgentHomeSkills()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agents',
          slug: 'real-skill',
          alreadyImported: false
        })
      ])
    )

    await expect(
      service.importAgentHomeSkills({ skills: [{ source: 'agents', slug: 'real-skill' }] })
    ).resolves.toMatchObject({ results: [{ status: 'updated', id: 'imported-real-skill' }] })
    await expect(service.listAgentHomeSkills()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'agents', slug: 'real-skill', alreadyImported: true })
      ])
    )
  })
})

describe('SettingsService: claude-shared login orchestration', () => {
  const sharedAuth = (
    opts: {
      loginOk?: boolean
      loginMsg?: string
    } = {}
  ): ClaudeSharedAuthControllerPort => ({
    getStatus: vi.fn(),
    loginShared: vi.fn().mockResolvedValue({
      supported: true,
      authenticated: opts.loginOk ?? true,
      message: opts.loginMsg
    }),
    cancelLogin: vi.fn()
  })

  it('persists claude-shared with the fixed builtin-claude-shared id on upsert', async () => {
    const service = createService()
    const snap = await service.upsertProvider({ type: 'claude-shared', name: 'ignored' })
    expect(snap.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)).toBeDefined()
    expect(snap.providers.filter((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)).toHaveLength(1)
  })

  it('preserves both Claude auth records and moves the active selection between them', async () => {
    const service = createService()
    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-preserved'),
      keyMask: maskKey('sk-ant-preserved')
    })
    await service.setActiveProvider(CLAUDE_ISOLATED_PROVIDER_ID, 'claude-sonnet-4-5')

    const snapshot = await service.upsertProvider({
      type: 'claude-shared',
      model: 'claude-opus-4-6'
    })

    expect(snapshot.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID])
    )
    expect(
      snapshot.providers.find((provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID)?.hasKey
    ).toBe(true)
    expect(snapshot.activeProviderId).toBe(CLAUDE_SHARED_PROVIDER_ID)
    expect(snapshot.activeModel).toBe('claude-opus-4-6')

    const switchedBack = await service.upsertProvider({ type: 'claude-isolated' })
    expect(switchedBack.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID])
    )
    expect(
      switchedBack.providers.find((provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID)?.hasKey
    ).toBe(true)
    expect(switchedBack.activeProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    expect(switchedBack.activeModel).toBe('claude-sonnet-4-5')

    const switchedToDefault = await service.upsertProvider({
      type: 'claude-shared',
      model: ''
    })
    expect(switchedToDefault.activeProviderId).toBe(CLAUDE_SHARED_PROVIDER_ID)
    expect(switchedToDefault.activeModel).toBeUndefined()
  })

  it('loginClaudeShared records verified marker and returns applied:true', async () => {
    const auth = sharedAuth({ loginOk: true })
    const probe = vi.fn().mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({
      type: 'claude-shared',
      name: 'Claude subscription',
      model: 'claude-opus-4-6'
    })

    const result = await service.loginClaudeShared()
    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)

    const settings = await service.getSettingsView()
    const provider = settings.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)
    expect(provider?.lastValidatedAt).toBeGreaterThan(0)
    expect(probe).toHaveBeenCalledWith(
      execPath,
      expect.objectContaining({ ANTHROPIC_MODEL: 'claude-opus-4-6' }),
      [
        '--settings',
        join(getAppClaudeConfigDir(storageRoot), 'settings.json'),
        '--add-dir',
        expect.stringContaining(getClaudeSkillRuntimeRoot(storageRoot))
      ]
    )
  })

  it('records shared Claude login after an unrelated active model switch', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const service = createService(undefined, {
      claudeSharedAuth: sharedAuth({ loginOk: true }),
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })
    const gateway = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'sk-deepseek'
      })
    ).providers.find((provider) => provider.vendorId === 'deepseek')
    if (!gateway) throw new Error('DeepSeek provider not found')
    await service.setActiveProvider(gateway.id, 'deepseek-v4-pro')

    const login = service.loginClaudeShared()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await service.setActiveProvider(gateway.id, 'deepseek-v4-flash')
    finishProbe?.()

    await expect(login).resolves.toMatchObject({ ok: true, applied: true })
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.lastValidatedAt
    ).toBeGreaterThan(0)
  })

  it('discards a shared login result after the provider is edited and isolated mode is selected', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const service = createService(undefined, {
      claudeSharedAuth: sharedAuth({ loginOk: true }),
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })

    const login = service.loginClaudeShared()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())

    await service.upsertProvider({ type: 'claude-shared', model: 'claude-sonnet-4-5' })
    await service.upsertProvider({ type: 'claude-isolated' })
    await service.setActiveProvider(CLAUDE_ISOLATED_PROVIDER_ID)
    finishProbe?.()

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    const settings = await repository.getSettings()
    expect(settings.claudeSubscriptionProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    expect(settings.activeProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    const sharedProvider = settings.providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(sharedProvider?.model).toBe('claude-sonnet-4-5')
    expect(sharedProvider?.lastValidatedAt).toBeUndefined()
  })

  it('loginClaudeShared returns applied:false when no shared provider record exists', async () => {
    const auth = sharedAuth({ loginOk: true })
    const service = createService(undefined, { claudeSharedAuth: auth })
    // Do NOT create the provider first → lookup returns undefined.
    const result = await service.loginClaudeShared()
    expect(result.applied).toBe(false)
  })

  it('loginClaudeShared records failure marker on a failed login', async () => {
    const auth = sharedAuth({ loginOk: false, loginMsg: 'OAuth rejected' })
    const service = createService(undefined, { claudeSharedAuth: auth })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })

    const result = await service.loginClaudeShared()
    expect(result.ok).toBe(false)
    expect(result.applied).toBe(true)
    const settings = await service.getSettingsView()
    const provider = settings.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)
    expect(provider?.lastValidationFailure?.message).toContain('OAuth rejected')
  })

  it('clears the local disconnect after browser auth succeeds even when the probe fails', async () => {
    const service = createService(undefined, {
      claudeSharedAuth: sharedAuth({ loginOk: true }),
      executeClaudeProbe: vi.fn().mockRejectedValue(new Error('temporary network failure'))
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.logoutClaudeShared()
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeGreaterThan(0)

    await expect(service.loginClaudeShared()).resolves.toMatchObject({
      ok: false,
      applied: true
    })

    const provider = (await repository.getSettings()).providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(provider?.disconnectedAt).toBeUndefined()
    expect(provider?.lastValidationFailure?.category).toBe('network')
  })

  it('validateProvider probes the shared Claude runtime with the resolved model', async () => {
    const auth = sharedAuth()
    vi.mocked(auth.getStatus).mockResolvedValue({ supported: true, authenticated: true })
    const probe = vi.fn().mockRejectedValue(new Error('Unknown model: claude-bad-model'))
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-bad-model' })

    const result = await service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })

    expect(result).toMatchObject({ ok: false, category: 'unknown', applied: true })
    expect(probe).toHaveBeenCalledWith(
      execPath,
      expect.objectContaining({ ANTHROPIC_MODEL: 'claude-bad-model' }),
      [
        '--settings',
        join(getAppClaudeConfigDir(storageRoot), 'settings.json'),
        '--add-dir',
        expect.stringContaining(getClaudeSkillRuntimeRoot(storageRoot))
      ]
    )
    expect(
      (await service.getSettingsView()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.lastValidationFailure?.message
    ).toContain('shared-profile validation probe')
  })

  it('does not re-verify shared Claude after it is disconnected during validation', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const auth = sharedAuth()
    vi.mocked(auth.getStatus).mockResolvedValue({ supported: true, authenticated: true })
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })

    const validation = service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await service.logoutClaudeShared()
    finishProbe?.()

    await expect(validation).resolves.toMatchObject({ ok: true, applied: false })
    const provider = (await repository.getSettings()).providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(provider?.disconnectedAt).toBeGreaterThan(0)
    expect(provider?.lastValidatedAt).toBeUndefined()
    expect(provider?.lastValidationFailure?.category).toBe('auth')
  })

  it('records shared Claude validation after an unrelated active provider switch', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const auth = sharedAuth()
    vi.mocked(auth.getStatus).mockResolvedValue({ supported: true, authenticated: true })
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-sonnet-4-5' })
    const first = await service.upsertProvider({
      type: 'custom',
      name: 'First gateway',
      baseUrl: 'https://first.example.com',
      model: 'first-model',
      key: 'sk-first'
    })
    const firstId = first.providers.find((provider) => provider.name === 'First gateway')?.id
    const second = await service.upsertProvider({
      type: 'custom',
      name: 'Second gateway',
      baseUrl: 'https://second.example.com',
      model: 'second-model',
      key: 'sk-second'
    })
    const secondId = second.providers.find((provider) => provider.name === 'Second gateway')?.id
    if (!firstId || !secondId) throw new Error('custom providers not found')
    await service.setActiveProvider(firstId)

    const validation = service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await service.setActiveProvider(secondId)
    finishProbe?.()

    await expect(validation).resolves.toMatchObject({ ok: true, applied: true })
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.lastValidatedAt
    ).toBeGreaterThan(0)
  })

  it('does not replace a verified shared login with a cancellation failure', async () => {
    const auth = sharedAuth({ loginOk: true })
    const loginShared = vi.mocked(auth.loginShared)
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })
    await service.loginClaudeShared()
    const validatedAt = (await service.getSettingsView()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )?.lastValidatedAt

    loginShared.mockResolvedValueOnce({
      supported: true,
      authenticated: false,
      message: 'Sign-in cancelled.',
      cancelled: true
    })

    await expect(service.loginClaudeShared()).resolves.toMatchObject({
      ok: false,
      applied: false,
      cancelled: true
    })
    const provider = (await service.getSettingsView()).providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(provider?.lastValidatedAt).toBe(validatedAt)
    expect(provider?.lastValidationFailure).toBeUndefined()
  })

  it('logoutClaudeShared disconnects locally without logging out the global CLI profile', async () => {
    const globalLogout = vi.fn().mockResolvedValue({ supported: true, authenticated: false })
    const auth = { ...sharedAuth(), logoutShared: globalLogout }
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })
    await service.loginClaudeShared()
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const beforeDisconnect = await service.getSettingsView()
    expect(
      beforeDisconnect.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)?.lastValidatedAt
    ).toBeGreaterThan(0)

    const result = await service.logoutClaudeShared()
    expect(result.ok).toBe(true)
    expect(globalLogout).not.toHaveBeenCalled()
    const afterDisconnect = await service.getSettingsView()
    expect(
      afterDisconnect.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)?.lastValidatedAt
    ).toBeUndefined()
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeGreaterThan(0)
    await expect(
      service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })
    ).resolves.toMatchObject({
      ok: false,
      category: 'auth',
      message: expect.stringContaining('disconnected from Open Science')
    })
    await expect(resolveActiveBackend(service)).rejects.toThrow(/disconnected from Open Science/)

    await expect(service.loginClaudeShared()).resolves.toMatchObject({ ok: true, applied: true })
    await expect(resolveActiveBackend(service)).resolves.toMatchObject({
      env: expect.objectContaining({
        CLAUDE_CONFIG_DIR: join(storageRoot, 'no-user-claude')
      })
    })
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeUndefined()
  })

  it('keeps a disconnected shared Claude provider unavailable after a model edit', async () => {
    const service = createService()
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })
    await service.logoutClaudeShared()

    const snapshot = await service.upsertProvider({
      type: 'claude-shared',
      model: 'claude-sonnet-4-5'
    })

    expect(
      snapshot.providers.find((provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID)
    ).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-4-5',
        lastValidationFailure: expect.objectContaining({ category: 'auth' })
      })
    )
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )
    ).toEqual(
      expect.objectContaining({
        disconnectedAt: expect.any(Number),
        lastValidationFailure: expect.objectContaining({ category: 'auth' })
      })
    )
  })

  it('invalidates shared Claude verification when its model override changes or is cleared', async () => {
    const service = createService()
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (!stored) throw new Error('shared Claude provider not found')
    await repository.upsertProvider({ ...stored, lastValidatedAt: 1 })

    const changed = await service.upsertProvider({
      type: 'claude-shared',
      model: 'claude-sonnet-4-5'
    })
    expect(changed.providers.find((provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID)).toEqual(
      expect.objectContaining({ model: 'claude-sonnet-4-5', lastValidatedAt: undefined })
    )
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID, 'claude-sonnet-4-5')

    const cleared = await service.upsertProvider({ type: 'claude-shared', model: '' })
    expect(
      cleared.providers.find((provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID)?.model
    ).toBeUndefined()
    expect(cleared.activeModel).toBeUndefined()
  })

  it('cancelClaudeLogin delegates to the shared auth controller', () => {
    const auth = sharedAuth()
    const service = createService(undefined, { claudeSharedAuth: auth })
    service.cancelClaudeLogin()
    expect(auth.cancelLogin).toHaveBeenCalledOnce()
  })
})
