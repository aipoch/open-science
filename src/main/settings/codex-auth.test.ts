import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import {
  CodexAuthController,
  createCodexAuthEnvironment,
  ensureCodexAuthHome,
  importCodexAuthentication,
  projectSafeCodexProviderRoute,
  resolveEffectiveCodexSubscriptionTransport,
  type CodexAuthSession
} from './codex-auth'

const session = (overrides: Partial<CodexAuthSession> = {}): CodexAuthSession => ({
  initialize: vi.fn().mockResolvedValue({
    authMethods: [{ id: 'api-key' }, { id: 'chat-gpt' }]
  }),
  status: vi.fn().mockResolvedValue({
    type: 'chat-gpt',
    email: 'private@example.test'
  }),
  authenticateChatGpt: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const autoTransportConfig = (prefix: string[] = []): string =>
  [...prefix, 'cli_auth_credentials_store = "file"', ''].join('\n')

describe('resolveEffectiveCodexSubscriptionTransport', () => {
  it('retains learned HTTPS only while the preference is Auto', () => {
    expect(
      resolveEffectiveCodexSubscriptionTransport({
        codexTransport: 'auto',
        codexAutoUseHttps: true
      })
    ).toBe('https')
    expect(
      resolveEffectiveCodexSubscriptionTransport({
        codexTransport: 'websocket',
        codexAutoUseHttps: true
      })
    ).toBe('websocket')
    expect(resolveEffectiveCodexSubscriptionTransport({})).toBe('auto')
  })
})

describe('ensureCodexAuthHome', () => {
  it('projects Auto, HTTPS, and WebSocket as distinct public profile configurations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-transports-'))
    const configPath = join(codexSubscriptionStorageDir(root), 'config.toml')
    try {
      await ensureCodexAuthHome('isolated', root, 'auto')
      expect(await readFile(configPath, 'utf8')).toBe('cli_auth_credentials_store = "file"\n')

      await ensureCodexAuthHome('isolated', root, 'https')
      let configToml = await readFile(configPath, 'utf8')
      expect(configToml).toContain('model_provider = "open-science-chatgpt-https"')
      expect(configToml).toContain('supports_websockets = false')

      await ensureCodexAuthHome('isolated', root, 'websocket')
      configToml = await readFile(configPath, 'utf8')
      expect(configToml).toContain('model_provider = "open-science-chatgpt-websocket"')
      expect(configToml).toContain('supports_websockets = true')
      expect(configToml).not.toContain('open-science-chatgpt-https')

      await ensureCodexAuthHome('isolated', root, 'auto')
      expect(await readFile(configPath, 'utf8')).toBe('cli_auth_credentials_store = "file"\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates the same app-owned home with file-only credentials and Auto transport for both auth modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-home-'))
    const expectedConfig = autoTransportConfig()
    try {
      await ensureCodexAuthHome('shared', root)
      expect(existsSync(codexSubscriptionStorageDir(root))).toBe(true)
      expect(await readFile(join(codexSubscriptionStorageDir(root), 'config.toml'), 'utf8')).toBe(
        expectedConfig
      )

      await rm(codexSubscriptionStorageDir(root), { recursive: true, force: true })
      await ensureCodexAuthHome('isolated', root)
      expect(existsSync(codexSubscriptionStorageDir(root))).toBe(true)
      expect(await readFile(join(codexSubscriptionStorageDir(root), 'config.toml'), 'utf8')).toBe(
        expectedConfig
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces a global-capable credential store and preserves other profile config idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-home-'))
    const home = codexSubscriptionStorageDir(root)
    try {
      await mkdir(home, { recursive: true })
      await writeFile(
        join(home, 'config.toml'),
        [
          'model = "account-default"',
          'cli_auth_credentials_store = "auto"',
          '',
          '[model_providers.local]',
          'base_url = "http://127.0.0.1:1087/v1"',
          ''
        ].join('\n')
      )

      await ensureCodexAuthHome('isolated', root)
      await ensureCodexAuthHome('isolated', root)

      const configToml = await readFile(join(home, 'config.toml'), 'utf8')
      expect(configToml).toContain('cli_auth_credentials_store = "file"')
      expect(configToml).not.toContain('open-science-chatgpt-')
      expect(configToml).toContain('[model_providers.local]\nbase_url = "http://127.0.0.1:1087/v1"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('createCodexAuthEnvironment', () => {
  it('isolates both legacy shared and app sign-in auth sessions', () => {
    const source = {
      PATH: 'bin',
      CODEX_HOME: 'wrong',
      CODEX_PATH: 'wrong',
      CODEX_CONFIG: '{}',
      MODEL_PROVIDER: 'wrong',
      NO_BROWSER: '1',
      OPENAI_API_KEY: 'secret'
    }

    const shared = createCodexAuthEnvironment('shared', '/data', source)
    expect(shared).toMatchObject({
      PATH: expect.stringContaining('bin'),
      CODEX_HOME: expect.stringMatching(/[\\/]data[\\/]codex-subscription$/)
    })
    expect(shared).not.toHaveProperty('CODEX_PATH')
    expect(shared).not.toHaveProperty('CODEX_CONFIG')
    expect(shared).not.toHaveProperty('MODEL_PROVIDER')
    expect(shared).not.toHaveProperty('NO_BROWSER')
    expect(shared).not.toHaveProperty('OPENAI_API_KEY')

    expect(createCodexAuthEnvironment('isolated', '/data', source)).toMatchObject({
      PATH: expect.stringContaining('bin'),
      CODEX_HOME: expect.stringMatching(/[\\/]data[\\/]codex-subscription$/)
    })
  })

  it('applies the resolved system proxy to authentication sessions', () => {
    const env = createCodexAuthEnvironment(
      'isolated',
      '/data',
      {
        PATH: 'bin',
        ALL_PROXY: 'socks5://stale-proxy.example.test:9050',
        NO_PROXY: 'stale-bypass.example.test'
      },
      {
        HTTP_PROXY: 'http://proxy.example.test:3128',
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        http_proxy: 'http://proxy.example.test:3128',
        https_proxy: 'http://proxy.example.test:3128',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1'
      }
    )

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://proxy.example.test:3128',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
      http_proxy: 'http://proxy.example.test:3128',
      https_proxy: 'http://proxy.example.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1'
    })
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.NO_PROXY).not.toContain('stale-bypass.example.test')
  })

  it('preserves inherited proxies when system proxy resolution fails', () => {
    const env = createCodexAuthEnvironment('isolated', '/data', {
      PATH: 'bin',
      HTTPS_PROXY: 'http://inherited-proxy.example.test:3128',
      NO_PROXY: 'inherited-bypass.example.test'
    })

    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://inherited-proxy.example.test:3128',
      NO_PROXY: 'inherited-bypass.example.test'
    })
  })
})

describe('importCodexAuthentication', () => {
  it('keeps an explicitly imported safe route ahead of the transport preference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-import-priority-'))
    const source = join(root, 'source')
    const destination = codexSubscriptionStorageDir(root)
    try {
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(
        join(source, 'config.toml'),
        [
          'model_provider = "subscription-route"',
          '[model_providers.subscription-route]',
          'base_url = "http://127.0.0.1:1087/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = true',
          ''
        ].join('\n')
      )

      await importCodexAuthentication(source, destination)
      await ensureCodexAuthHome('shared', root, 'websocket')

      const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
      expect(configToml).toContain('model_provider = "subscription-route"')
      expect(configToml).toContain('base_url = "http://127.0.0.1:1087/v1"')
      expect(configToml).not.toContain('open-science-chatgpt-websocket')
      expect(configToml).not.toContain('open-science-chatgpt-https')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects only a validated provider route from app-owned configuration', () => {
    expect(
      projectSafeCodexProviderRoute(
        [
          'cli_auth_credentials_store = "file"',
          'model_provider = "subscription-route"',
          '',
          '[model_providers.subscription-route]',
          'name = "OpenAI"',
          'base_url = "http://127.0.0.1:1087/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = true',
          '',
          '[mcp_servers.private]',
          'command = "private-command"',
          ''
        ].join('\n')
      )
    ).toBe(
      [
        'model_provider = "subscription-route"',
        '',
        '[model_providers."subscription-route"]',
        'name = "OpenAI"',
        'base_url = "http://127.0.0.1:1087/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        ''
      ].join('\n')
    )
  })

  it('copies auth.json without unrelated Codex config or private runtime data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-import-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(join(source, 'skills', 'private-skill'), { recursive: true })
      await mkdir(join(source, 'sessions'), { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(join(source, 'config.toml'), 'model = "private"\n')
      await writeFile(join(source, 'skills', 'private-skill', 'SKILL.md'), '# Private')
      await writeFile(join(source, 'sessions', 'session.jsonl'), 'private session')
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'config.toml'), 'model = "app-default"\n')

      await importCodexAuthentication(source, destination)

      expect(await readFile(join(destination, 'auth.json'), 'utf8')).toBe(
        '{"tokens":{"access_token":"secret"}}'
      )
      if (process.platform !== 'win32') {
        expect((await stat(join(destination, 'auth.json'))).mode & 0o777).toBe(0o600)
      }
      expect(await readFile(join(destination, 'config.toml'), 'utf8')).toBe(
        autoTransportConfig(['model = "app-default"'])
      )
      expect(existsSync(join(destination, 'skills'))).toBe(false)
      expect(existsSync(join(destination, 'sessions'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates the Auto transport default when importing auth without a provider route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-import-default-route-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')

      await importCodexAuthentication(source, destination)

      expect(await readFile(join(destination, 'config.toml'), 'utf8')).toBe(autoTransportConfig())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports only the active ChatGPT-authenticated model-provider route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-route-import-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(source, { recursive: true })
      await mkdir(destination, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(join(destination, 'config.toml'), 'model = "app-default"\n')
      await writeFile(
        join(source, 'config.toml'),
        [
          '"model_provider" = "subscription-route"',
          'model = "private-model"',
          '',
          '[mcp_servers.private]',
          'command = "private-command"',
          '',
          '[model_providers.subscription-route]',
          '"name" = "OpenAI"',
          '"requires_openai_auth" = true',
          "'supports_websockets' = false",
          '"wire_api" = "responses"',
          '"base_url" = "http://127.0.0.1:1087/v1"',
          ''
        ].join('\n')
      )

      await importCodexAuthentication(source, destination)

      expect(await readFile(join(destination, 'config.toml'), 'utf8')).toBe(
        [
          'model = "app-default"',
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
      if (process.platform !== 'win32') {
        expect((await stat(join(destination, 'config.toml'))).mode & 0o777).toBe(0o600)
      }

      await writeFile(join(source, 'config.toml'), 'model = "private-model"\n')
      await importCodexAuthentication(source, destination)

      expect(await readFile(join(destination, 'config.toml'), 'utf8')).toBe(
        autoTransportConfig(['model = "app-default"'])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['inline bearer token', 'experimental_bearer_token = "private-token"'],
    ['API-key environment variable', 'env_key = "PRIVATE_TOKEN"'],
    ['literal HTTP headers', 'http_headers = { Authorization = "private-token" }'],
    ['dotted HTTP headers', 'http_headers.Authorization = "private-token"'],
    ['environment HTTP headers', 'env_http_headers = { Authorization = "PRIVATE_TOKEN" }'],
    ['query parameters', 'query_params = { api_key = "private-token" }'],
    [
      'nested HTTP headers',
      '[model_providers.subscription-route.http_headers]\nAuthorization = "private-token"'
    ]
  ])('does not import a loopback route that depends on %s', async (_label, credentialLine) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-route-secret-reject-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(
        join(source, 'config.toml'),
        [
          'model_provider = "subscription-route"',
          '',
          '[model_providers.subscription-route]',
          'name = "OpenAI"',
          'requires_openai_auth = true',
          'wire_api = "responses"',
          'base_url = "http://127.0.0.1:1087/v1"',
          credentialLine,
          ''
        ].join('\n')
      )

      await importCodexAuthentication(source, destination)

      const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
      expect(configToml).toContain('cli_auth_credentials_store = "file"')
      expect(configToml).not.toContain('open-science-chatgpt-')
      expect(configToml).not.toContain('subscription-route')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces conflicting app-owned provider config without creating duplicate TOML keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-route-conflict-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(source, { recursive: true })
      await mkdir(destination, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(
        join(source, 'config.toml'),
        [
          'model_provider = "subscription-route"',
          '',
          '[model_providers.subscription-route]',
          'name = "Imported"',
          'requires_openai_auth = true',
          'wire_api = "responses"',
          'base_url = "http://127.0.0.1:1087/v1"',
          ''
        ].join('\n')
      )
      await writeFile(
        join(destination, 'config.toml'),
        [
          '"model_provider" = "app-default-route"',
          'model = "app-default"',
          '',
          '[model_providers.subscription-route]',
          'name = "Stale"',
          'base_url = "http://127.0.0.1:9999/v1"',
          '',
          '[model_providers.app-default-route]',
          'name = "App default"',
          'base_url = "https://app.example/v1"',
          '',
          '[mcp_servers.app]',
          'command = "app-command"',
          ''
        ].join('\n')
      )

      await importCodexAuthentication(source, destination)

      const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
      const activeConfigToml = configToml
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
      expect(
        activeConfigToml.match(/^(?:model_provider|"model_provider"|'model_provider')\s*=/gm)
      ).toHaveLength(1)
      expect(activeConfigToml.match(/^\[model_providers\."subscription-route"\]$/gm)).toHaveLength(
        1
      )
      expect(activeConfigToml).not.toContain('http://127.0.0.1:9999/v1')
      expect(configToml).toContain('[model_providers.app-default-route]')
      expect(configToml).toContain('base_url = "https://app.example/v1"')
      expect(configToml).toContain('[mcp_servers.app]')
      expect(configToml).toContain('command = "app-command"')

      await writeFile(join(source, 'config.toml'), 'model = "private-model"\n')
      await importCodexAuthentication(source, destination)

      const restoredConfigToml = await readFile(join(destination, 'config.toml'), 'utf8')
      expect(restoredConfigToml).toContain('"model_provider" = "app-default-route"')
      expect(restoredConfigToml).toContain('[model_providers.subscription-route]')
      expect(restoredConfigToml).toContain('base_url = "http://127.0.0.1:9999/v1"')
      expect(restoredConfigToml).toContain('[model_providers.app-default-route]')
      expect(restoredConfigToml).toContain('[mcp_servers.app]')
      expect(restoredConfigToml).not.toContain('Open Science:')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not import a model-provider route backed by separate credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-route-reject-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
      await writeFile(
        join(source, 'config.toml'),
        [
          'model_provider = "private-gateway"',
          '',
          '[model_providers.private-gateway]',
          'name = "Private"',
          'requires_openai_auth = false',
          'wire_api = "responses"',
          'base_url = "https://private.example/v1"',
          ''
        ].join('\n')
      )

      await importCodexAuthentication(source, destination)

      const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
      expect(configToml).toContain('cli_auth_credentials_store = "file"')
      expect(configToml).not.toContain('open-science-chatgpt-')
      expect(configToml).not.toContain('private-gateway')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['https://proxy.example/v1', 'http://192.0.2.1/v1'])(
    'does not send shared authentication to a non-loopback route at %s',
    async (baseUrl) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-auth-remote-route-reject-'))
      const source = join(root, 'source')
      const destination = join(root, 'destination')
      try {
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
        await writeFile(
          join(source, 'config.toml'),
          [
            'model_provider = "remote-route"',
            '',
            '[model_providers.remote-route]',
            'name = "Remote"',
            'requires_openai_auth = true',
            'wire_api = "responses"',
            `base_url = ${JSON.stringify(baseUrl)}`,
            ''
          ].join('\n')
        )

        await importCodexAuthentication(source, destination)

        const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
        expect(configToml).toContain('cli_auth_credentials_store = "file"')
        expect(configToml).not.toContain('open-science-chatgpt-')
        expect(configToml).not.toContain('remote-route')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['http://localhost:1087/v1#', 'http://localhost:1087/v1?'])(
    'does not import a loopback route with an empty URL delimiter at %s',
    async (baseUrl) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-auth-empty-url-delimiter-reject-'))
      const source = join(root, 'source')
      const destination = join(root, 'destination')
      try {
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
        await writeFile(
          join(source, 'config.toml'),
          [
            'model_provider = "subscription-route"',
            '',
            '[model_providers.subscription-route]',
            'name = "OpenAI"',
            'requires_openai_auth = true',
            'wire_api = "responses"',
            `base_url = ${JSON.stringify(baseUrl)}`,
            ''
          ].join('\n')
        )

        await importCodexAuthentication(source, destination)

        const configToml = await readFile(join(destination, 'config.toml'), 'utf8')
        expect(configToml).toContain('cli_auth_credentials_store = "file"')
        expect(configToml).not.toContain('open-science-chatgpt-')
        expect(configToml).not.toContain('subscription-route')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['["model_providers"."subscription-route"]', "['model_providers'.'subscription-route']"])(
    'imports a compatible route with quoted TOML table keys: %s',
    async (tableHeader) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-auth-quoted-route-import-'))
      const source = join(root, 'source')
      const destination = join(root, 'destination')
      try {
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
        await writeFile(
          join(source, 'config.toml'),
          [
            'model_provider = "subscription-route"',
            '',
            tableHeader,
            'name = "OpenAI"',
            'requires_openai_auth = true',
            'wire_api = "responses"',
            'base_url = "http://127.0.0.1:1087/v1"',
            ''
          ].join('\n')
        )

        await importCodexAuthentication(source, destination)

        await expect(readFile(join(destination, 'config.toml'), 'utf8')).resolves.toContain(
          'base_url = "http://127.0.0.1:1087/v1"'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('CodexAuthController', () => {
  it('capability-gates subscription support and never exposes the account email', async () => {
    const supported = session()
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(supported)
    })

    await expect(controller.getStatus('shared')).resolves.toEqual({
      mode: 'shared',
      supported: true,
      authenticated: true
    })
    expect(JSON.stringify(await controller.getStatus('shared'))).not.toContain(
      'private@example.test'
    )

    // A signed-out adapter that also cannot offer ChatGPT login has nothing to connect: that is the
    // genuine capability failure. (A signed-out adapter that DOES advertise chat-gpt is merely
    // unauthenticated — covered below — not a capability failure.)
    const unsupported = session({
      initialize: vi.fn().mockResolvedValue({ authMethods: [{ id: 'api-key' }] }),
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' })
    })
    const unsupportedController = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(unsupported)
    })
    await expect(unsupportedController.getStatus('shared')).resolves.toEqual({
      mode: 'shared',
      supported: false,
      authenticated: false,
      message: 'The installed codex-acp does not advertise ChatGPT authentication.'
    })
  })

  it('reports a chat-gpt-less adapter that already holds a credential as authenticated', async () => {
    // Regression: getStatus must not gate on the chat-gpt capability before reading status. An adapter
    // advertising only api-key, already carrying an api-key/gateway credential, runs fine — reporting
    // it signed out (a capability failure) would wrongly block an otherwise working provider.
    for (const type of ['api-key', 'gateway'] as const) {
      const credentialed = session({
        initialize: vi.fn().mockResolvedValue({ authMethods: [{ id: 'api-key' }] }),
        status: vi.fn().mockResolvedValue({ type })
      })
      const controller = new CodexAuthController({
        openSession: vi.fn().mockResolvedValue(credentialed)
      })

      await expect(controller.getStatus('shared')).resolves.toEqual({
        mode: 'shared',
        supported: true,
        authenticated: true
      })
      expect(vi.mocked(credentialed.close)).toHaveBeenCalledOnce()
    }
  })

  it('treats api-key and gateway profiles as authenticated', async () => {
    for (const type of ['api-key', 'gateway'] as const) {
      const apiKeySession = session({
        status: vi.fn().mockResolvedValue({ type })
      })
      const controller = new CodexAuthController({
        openSession: vi.fn().mockResolvedValue(apiKeySession)
      })

      await expect(controller.getStatus('shared')).resolves.toEqual({
        mode: 'shared',
        supported: true,
        authenticated: true
      })

      await expect(controller.loginIsolated()).resolves.toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })
      expect(apiKeySession.authenticateChatGpt).not.toHaveBeenCalled()
    }
  })

  it('signs in and out of a chat-gpt-less isolated profile that already holds a credential', async () => {
    // Regression: loginIsolated/logoutIsolated must not gate on the chat-gpt capability before reading
    // status, mirroring getStatus. An isolated home carrying an api-key/gateway credential on a build
    // that never advertises chat-gpt must still report authenticated and stay sign-out-able.
    for (const type of ['api-key', 'gateway'] as const) {
      const credentialed = session({
        initialize: vi.fn().mockResolvedValue({ authMethods: [{ id: 'api-key' }] }),
        status: vi.fn().mockResolvedValue({ type })
      })
      const controller = new CodexAuthController({
        openSession: vi.fn().mockResolvedValue(credentialed)
      })

      await expect(controller.loginIsolated()).resolves.toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })
      // No ChatGPT browser flow: the existing credential is exactly what the runtime would use.
      expect(credentialed.authenticateChatGpt).not.toHaveBeenCalled()

      await expect(controller.logoutIsolated()).resolves.toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
      expect(vi.mocked(credentialed.logout)).toHaveBeenCalledOnce()
    }
  })

  it('still reports a capability failure for a signed-out chat-gpt-less isolated profile', async () => {
    // The gate remains for the genuine case: signed out AND no ChatGPT login means nothing to do.
    const signedOut = session({
      initialize: vi.fn().mockResolvedValue({ authMethods: [{ id: 'api-key' }] }),
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' })
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(signedOut)
    })

    await expect(controller.loginIsolated()).resolves.toEqual({
      mode: 'isolated',
      supported: false,
      authenticated: false,
      message: 'The installed codex-acp does not advertise ChatGPT authentication.'
    })
    expect(signedOut.authenticateChatGpt).not.toHaveBeenCalled()
    await expect(controller.logoutIsolated()).resolves.toMatchObject({ supported: false })
    expect(signedOut.logout).not.toHaveBeenCalled()
  })

  it('reports an unauthenticated but chat-gpt-capable profile as supported, not a capability failure', async () => {
    const signedOut = session({ status: vi.fn().mockResolvedValue({ type: 'unauthenticated' }) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(signedOut)
    })

    await expect(controller.getStatus('shared')).resolves.toEqual({
      mode: 'shared',
      supported: true,
      authenticated: false
    })
  })

  it('times out a stalled status read and closes the late session', async () => {
    vi.useFakeTimers()
    let resolveStatus!: (value: { type: 'unauthenticated' }) => void
    const stalledStatus = new Promise<{ type: 'unauthenticated' }>((resolve) => {
      resolveStatus = resolve
    })
    const stalled = session({ status: vi.fn(() => stalledStatus) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(stalled),
      statusTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['getStatus']>> | undefined
    const pending = controller.getStatus('shared').then((result) => {
      outcome = result
    })

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await pending

    try {
      expect(outcome).toEqual({
        mode: 'shared',
        supported: true,
        authenticated: false,
        message: 'Codex status check timed out.'
      })
      // The stalled read is abandoned, but the session must still be torn down, not leaked.
      expect(vi.mocked(stalled.close)).toHaveBeenCalledOnce()
    } finally {
      resolveStatus({ type: 'unauthenticated' })
      vi.useRealTimers()
    }
  })

  it('signs into the isolated profile and confirms the resulting account', async () => {
    const isolated = session({
      status: vi
        .fn()
        .mockResolvedValueOnce({ type: 'unauthenticated' })
        .mockResolvedValueOnce({ type: 'chat-gpt', email: 'hidden@example.test' })
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated)
    })

    await expect(controller.loginIsolated()).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: true
    })
    expect(isolated.authenticateChatGpt).toHaveBeenCalledOnce()
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
  })

  it('cancels a pending isolated login and reports it without leaking the account', async () => {
    const isolated = session({
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' }),
      authenticateChatGpt: vi.fn(() => new Promise<void>(() => undefined))
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })

    const pending = controller.loginIsolated()
    await vi.waitFor(() => expect(isolated.authenticateChatGpt).toHaveBeenCalledOnce())
    controller.cancelLogin()

    await expect(pending).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
  })

  it('waits for a cancelled isolated session to close completely', async () => {
    let finishClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const isolated = session({
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' }),
      authenticateChatGpt: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(() => closeGate)
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })

    const pending = controller.loginIsolated()
    await vi.waitFor(() => expect(isolated.authenticateChatGpt).toHaveBeenCalledOnce())
    let cancellationSettled = false
    const cancellation = Promise.resolve(controller.cancelLogin()).then(() => {
      cancellationSettled = true
    })
    await vi.waitFor(() => expect(isolated.close).toHaveBeenCalledOnce())
    await Promise.resolve()

    expect(cancellationSettled).toBe(false)
    finishClose()
    await cancellation
    await expect(pending).resolves.toMatchObject({ message: 'Codex sign-in was cancelled.' })
  })

  it('rejects a second concurrent sign-in without opening a second session', async () => {
    // The in-progress slot must be claimed synchronously, in the same tick as the guard, so two
    // rapid calls (no await between them) cannot both pass the guard and open two browser flows.
    const isolated = session({
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' }),
      authenticateChatGpt: vi.fn(() => new Promise<void>(() => undefined))
    })
    const openSession = vi.fn().mockResolvedValue(isolated)
    const controller = new CodexAuthController({ openSession, loginTimeoutMs: 60_000 })

    const first = controller.loginIsolated()
    const second = controller.loginIsolated()

    await expect(second).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'A Codex sign-in is already in progress.'
    })
    expect(openSession).toHaveBeenCalledOnce()

    // The first login still owns the slot and remains cancellable.
    controller.cancelLogin()
    await expect(first).resolves.toMatchObject({ message: 'Codex sign-in was cancelled.' })
  })

  it('times out while isolated login initialization is stalled', async () => {
    vi.useFakeTimers()
    let resolveInitialize!: (value: { authMethods: { id: string }[] }) => void
    const initialize = new Promise<{ authMethods: { id: string }[] }>((resolve) => {
      resolveInitialize = resolve
    })
    const isolated = session({
      initialize: vi.fn(() => initialize)
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['loginIsolated']>> | undefined
    const pending = controller.loginIsolated().then((result) => {
      outcome = result
    })

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await Promise.resolve()

    try {
      expect(outcome).toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-in timed out after five minutes.'
      })
      expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    } finally {
      resolveInitialize({ authMethods: [{ id: 'chat-gpt' }] })
      await pending
      vi.useRealTimers()
    }
  })

  it('times out before an auth session opens and closes the late session', async () => {
    vi.useFakeTimers()
    let resolveSession!: (value: CodexAuthSession) => void
    const sessionPromise = new Promise<CodexAuthSession>((resolve) => {
      resolveSession = resolve
    })
    const isolated = session()
    const controller = new CodexAuthController({
      openSession: vi.fn(() => sessionPromise),
      loginTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['loginIsolated']>> | undefined
    const pending = controller.loginIsolated().then((result) => {
      outcome = result
    })

    await vi.advanceTimersByTimeAsync(10)
    await pending

    try {
      expect(outcome?.message).toBe('Codex sign-in timed out after five minutes.')
      resolveSession(isolated)
      await Promise.resolve()
      await Promise.resolve()
      expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels isolated login while initialization is stalled', async () => {
    let resolveInitialize!: (value: { authMethods: { id: string }[] }) => void
    const initialize = new Promise<{ authMethods: { id: string }[] }>((resolve) => {
      resolveInitialize = resolve
    })
    const isolated = session({ initialize: vi.fn(() => initialize) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })
    const pending = controller.loginIsolated()
    await Promise.resolve()

    controller.cancelLogin()

    await expect(pending).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    resolveInitialize({ authMethods: [{ id: 'chat-gpt' }] })
  })

  it('cancels isolated login while authentication status is stalled', async () => {
    let resolveStatus!: (value: { type: 'unauthenticated' }) => void
    const status = new Promise<{ type: 'unauthenticated' }>((resolve) => {
      resolveStatus = resolve
    })
    const isolated = session({ status: vi.fn(() => status) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })
    const pending = controller.loginIsolated()
    await vi.waitFor(() => expect(isolated.status).toHaveBeenCalledOnce())

    controller.cancelLogin()

    await expect(pending).resolves.toMatchObject({
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    resolveStatus({ type: 'unauthenticated' })
  })

  it('logs out only the isolated profile', async () => {
    const isolated = session()
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated)
    })

    await expect(controller.logoutIsolated()).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false
    })
    expect(vi.mocked(isolated.logout)).toHaveBeenCalledOnce()
  })

  it('times out a stalled sign-out and closes the session instead of hanging', async () => {
    // logoutIsolated is user-triggered and now issues its own status round-trip, so it must fail
    // closed on a stalled adapter like the reads do — not freeze the Settings sign-out.
    vi.useFakeTimers()
    let resolveStatus!: (value: { type: 'unauthenticated' }) => void
    const stalledStatus = new Promise<{ type: 'unauthenticated' }>((resolve) => {
      resolveStatus = resolve
    })
    const isolated = session({ status: vi.fn(() => stalledStatus) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      statusTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['logoutIsolated']>> | undefined
    const pending = controller.logoutIsolated().then((result) => {
      outcome = result
    })

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await pending

    try {
      expect(outcome).toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-out timed out.'
      })
      expect(vi.mocked(isolated.logout)).not.toHaveBeenCalled()
      expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    } finally {
      resolveStatus({ type: 'unauthenticated' })
      vi.useRealTimers()
    }
  })
})
