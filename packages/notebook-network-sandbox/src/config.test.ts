import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRuntimeConfig, normalizePolicy } from './config.js'
import type { NotebookNetworkSandboxOptions } from './types.js'
import {
  buildNotebookNetworkPolicy,
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS
} from '../../../src/shared/notebook-network.js'

const createOptions = (
  overrides: Partial<NotebookNetworkSandboxOptions> = {}
): NotebookNetworkSandboxOptions => ({
  policy: {
    allowedDomains: ['OpenAlex.org', '*.NPMJS.org:443'],
    deniedDomains: ['example.com:22'],
    deniedDomainReasons: { 'EXAMPLE.COM:22': 'SSH is blocked.' }
  },
  resources: { root: '/app/resources/notebook-network-sandbox' },
  ...overrides
})

describe('Notebook network sandbox configuration', () => {
  it('accepts the real application default policy including label wildcards', () => {
    expect(() =>
      createRuntimeConfig(
        createOptions({ policy: buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS) })
      )
    ).not.toThrow()
  })

  it('normalizes domain policy without changing wildcard or port semantics', () => {
    expect(
      normalizePolicy({
        allowedDomains: [' OpenAlex.org ', 'openalex.org', '', '*.NPMJS.org:443'],
        deniedDomains: [' EXAMPLE.COM:22 ', 'example.com:22'],
        deniedDomainReasons: { ' EXAMPLE.COM:22 ': 'SSH is blocked.' }
      })
    ).toEqual({
      allowedDomains: ['openalex.org', '*.npmjs.org:443'],
      deniedDomains: ['example.com:22'],
      deniedDomainReasons: { 'example.com:22': 'SSH is blocked.' }
    })
  })

  it('builds a fail-closed runtime config with platform resources', () => {
    const config = createRuntimeConfig(createOptions(), 'arm64')

    expect(config).toMatchObject({
      allowedDomains: ['openalex.org', '*.npmjs.org:443'],
      deniedDomains: ['example.com:22']
    })
    expect(config.windowsHostPath).toBe(
      join(
        '/app/resources/notebook-network-sandbox',
        'windows',
        'arm64',
        'notebook-appcontainer-host.exe'
      )
    )
    expect(config.installationId).toBe('0f3cd2a44c3d4e4e9f1e2a5b')
    expect(config.windowsOwnershipRoot.replaceAll('\\', '/')).toContain(
      `Aipoch/OpenScience/notebook-sandbox/${config.installationId}`
    )
  })

  it('keeps Windows resource ownership stable when the application moves', () => {
    const original = createRuntimeConfig(createOptions(), 'x64')
    const moved = createRuntimeConfig(
      createOptions({ resources: { root: 'D:\\Portable\\OpenScience\\resources' } }),
      'x64'
    )

    expect(moved.installationId).toBe(original.installationId)
    expect(moved.windowsOwnershipRoot).toBe(original.windowsOwnershipRoot)
  })

  it('projects validated trust certificates to the parent-proxy runtime', () => {
    const config = createRuntimeConfig(
      createOptions({
        trustBundle: { path: '/certs/complete.pem', certificates: ['certificate-one'] }
      }),
      'x64'
    )

    expect(config.trustedCaCertificates).toEqual(['certificate-one'])
  })

  it('rejects invalid policy and unsupported architectures before initialization', () => {
    expect(() =>
      createRuntimeConfig(
        createOptions({ policy: { allowedDomains: ['https://openalex.org'], deniedDomains: [] } }),
        'x64'
      )
    ).toThrow()
    expect(() => createRuntimeConfig(createOptions(), 'ia32')).toThrow(
      'Notebook network sandbox does not support architecture: ia32'
    )
  })

  it.each(['127.0.0.1', 'localhost', '*.com', 'example.com:0', 'example.com:65536'])(
    'rejects unsafe or overly broad allowed-domain pattern %s',
    (domain) => {
      expect(() =>
        createRuntimeConfig(
          createOptions({ policy: { allowedDomains: [domain], deniedDomains: [] } }),
          'x64'
        )
      ).toThrow()
    }
  )
})
