import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./crypto', () => ({
  encryptKey: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString('utf8') : undefined,
  hardenKeyMask: (value?: string) => value,
  maskKey: (value: string) => value
}))

import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'
import { LAB_PROVIDER_ID } from '../../shared/lab'
import { LabAccountOwner } from './lab-account-owner'
import type { LabApi } from './lab-api'
import { LabCredentialStore } from './lab-credential-store'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import { ProviderTransportOwner } from './provider-transport-owner'
import { ProtocolForwardingBridge } from './protocol-forwarding-bridge'
import { SettingsRepository } from './repository'

let root: string | undefined
const servers: Server[] = []

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe('Lab end-to-end model routing', () => {
  it('goes from bootstrap catalog to the gateway with the public model id and live credential', async () => {
    let received: { authorization?: string; model?: string } = {}
    const gateway = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += String(chunk)))
      request.on('end', () => {
        received = {
          authorization: request.headers.authorization,
          model: (JSON.parse(body) as { model?: string }).model
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [] }))
      })
    })
    servers.push(gateway)
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()))
    const address = gateway.address()
    if (!address || typeof address === 'string') throw new Error('no gateway address')
    const labServerUrl = `http://127.0.0.1:${address.port}`

    root = await mkdtemp(join(tmpdir(), 'open-science-lab-e2e-'))
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'p1',
            type: 'custom',
            name: 'Gateway',
            baseUrl: 'https://api.example.com',
            model: 'personal-model',
            keyRef: 'enc:key'
          }
        ],
        activeProviderId: 'p1',
        activeModel: 'personal-model'
      })
    )
    const repository = new SettingsRepository(root)
    const credentials = new LabCredentialStore(root)
    await credentials.ensureInstallationId()
    await credentials.saveServerUrl(labServerUrl)
    await credentials.saveSession({
      accessToken: 'at_bootstrap',
      refreshToken: 'rt_1',
      tokenExpiresAt: Date.now() + 3_600_000
    })
    const api = {
      bootstrap: vi.fn(async () => ({
        user: { id: 'usr_1', display_name: 'Researcher', org_id: 'org_1' },
        device: { id: 'dev_1', name: 'Workstation' },
        models: [
          {
            id: 'research-default',
            name: 'Research Assistant',
            protocol: 'openai',
            protocols: ['openai'],
            streaming: true,
            enabled: true,
            available: true
          },
          { id: 'lab:research-default', name: 'Prefixed Research', protocol: 'openai' }
        ],
        default_model_id: 'lab:research-default',
        model_base_url: '/v1'
      })),
      refreshToken: vi.fn(),
      logout: vi.fn(),
      clientBootstrap: vi.fn(),
      exchangeCode: vi.fn(),
      registerLoginAttempt: vi.fn()
    }
    const owner = new LabAccountOwner({
      configRoot: root,
      repository,
      credentials,
      api: api as unknown as LabApi
    })
    expect((await owner.check()).state).toBe('authenticated')

    const projection = new ProviderRuntimeProjectionOwner()
    const labRecord = (await repository.getSettings()).providers.find(
      (provider) => provider.id === LAB_PROVIDER_ID
    )!
    const catalog = buildConfiguredModelCatalog({
      providers: [projection.toProviderView(labRecord)],
      frameworkId: 'open-science-agent',
      frameworkEndpoints: ['responses', 'messages', 'chat-completions']
    })
    expect(catalog).toEqual([
      expect.objectContaining({
        model: 'lab:research-default',
        label: 'research-default',
        selectable: true
      }),
      expect.objectContaining({
        model: 'lab:lab:research-default',
        label: 'lab:research-default',
        selectable: true
      })
    ])

    const framework = {
      id: 'open-science-agent',
      supportedApiTypes: ['responses', 'messages', 'chat-completions']
    } as const
    const defaultTarget = projection.resolveRuntimeTarget(
      labRecord,
      { kind: 'configured' },
      framework
    )
    expect(defaultTarget.effectiveModel).toBe('lab:lab:research-default')
    const explicitTarget = projection.resolveRuntimeTarget(
      labRecord,
      { kind: 'required', model: 'lab:research-default' },
      framework
    )
    const transports = new ProviderTransportOwner({
      getLabAccessToken: async () => 'at_live',
      createProtocolForwardingBridge: (targets, targetId, options) =>
        new ProtocolForwardingBridge(targets, targetId, fetch, options)
    })
    for (const [target, expectedId] of [
      [defaultTarget, 'lab:research-default'],
      [explicitTarget, 'research-default'],
      [{ ...defaultTarget, effectiveModel: undefined }, 'lab:research-default']
    ] as const) {
      const lease = await transports.acquireHarness(target, new AbortController().signal)
      try {
        const response = await fetch(`${lease.connection.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${lease.connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: target.effectiveModel ?? target.provider.model,
            stream: false,
            messages: [{ role: 'user', content: 'hello' }]
          })
        })
        expect(response.status).toBe(200)
        expect(received.authorization).toBe('Bearer at_live')
        expect(received.model).toBe(expectedId)
      } finally {
        await lease.release()
      }
    }
  })
})
