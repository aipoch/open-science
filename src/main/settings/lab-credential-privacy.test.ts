import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => loggerMock
}))
vi.mock('./crypto', () => ({
  encryptKey: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString('utf8') : undefined,
  hardenKeyMask: (value?: string) => value,
  maskKey: (value: string) => value
}))

import { LabAccountOwner } from './lab-account-owner'
import { LabApi, LabApiError } from './lab-api'
import { LabCredentialStore } from './lab-credential-store'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import { SettingsRepository } from './repository'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('Lab credential privacy', () => {
  it('never exposes a token through the status view, provider view or diagnostics log', async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-lab-privacy-'))
    const repository = new SettingsRepository(root)
    const credentials = new LabCredentialStore(root)
    const api = {
      refreshToken: vi.fn(async () => {
        throw new LabApiError('unauthorized', 'refresh rejected')
      }),
      bootstrap: vi.fn(),
      logout: vi.fn(),
      exchangeCode: vi.fn(),
      registerLoginAttempt: vi.fn()
    }
    await credentials.ensureInstallationId()
    await credentials.saveServerUrl('https://lab.example.com')
    await credentials.saveSession({
      accessToken: 'at_secret_value',
      refreshToken: 'rt_secret_value',
      tokenExpiresAt: Date.now() - 1_000
    })

    const owner = new LabAccountOwner({
      configRoot: root,
      repository,
      credentials,
      api: api as unknown as LabApi
    })
    await owner.getAccessToken().catch(() => undefined)

    const serialized = JSON.stringify(owner.getView())
    expect(serialized).not.toContain('at_secret_value')
    expect(serialized).not.toContain('rt_secret_value')
    expect(serialized).not.toContain('enc:')
    expect(serialized).not.toContain('Bearer')

    const providerView = new ProviderRuntimeProjectionOwner().toProviderView({
      id: 'builtin-lab',
      type: 'lab',
      name: 'Lab',
      baseUrl: 'https://lab.example.com/v1',
      apiEndpoints: ['chat-completions'],
      fetchedModels: ['lab:research-default']
    })
    const providerJson = JSON.stringify(providerView)
    expect(providerJson).not.toContain('at_secret_value')
    expect(providerJson).not.toContain('rt_secret_value')
    expect(providerJson).not.toContain('key')

    const logged = JSON.stringify([
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.debug.mock.calls
    ])
    expect(logged).not.toContain('at_secret_value')
    expect(logged).not.toContain('rt_secret_value')
  })
})
