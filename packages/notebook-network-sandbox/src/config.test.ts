import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
    const config = createRuntimeConfig(createOptions(), 'arm64', {})

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
      `Aipoch/Open-Science/notebook-sandbox/${config.installationId}`
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

const temporaryRoots: string[] = []
afterEach(() =>
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
)
it('keeps existing Windows ownership receipts but creates fresh resource state with the new brand', () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-sandbox-'))
  temporaryRoots.push(root)
  const fresh = createRuntimeConfig(createOptions(), 'x64', { LOCALAPPDATA: root })
  expect(fresh.windowsOwnershipRoot).toBe(
    join(root, 'Aipoch', 'Open-Science', 'notebook-sandbox', fresh.installationId!)
  )
  const legacy = join(root, 'Aipoch', 'OpenScience', 'notebook-sandbox', fresh.installationId!)
  mkdirSync(legacy, { recursive: true })
  expect(
    createRuntimeConfig(createOptions(), 'x64', { LOCALAPPDATA: root }).windowsOwnershipRoot
  ).toBe(fresh.windowsOwnershipRoot)
  writeFileSync(join(legacy, 'receipt.json'), '{"owned":"retained"}')
  expect(
    createRuntimeConfig(createOptions(), 'x64', { LOCALAPPDATA: root }).windowsOwnershipRoot
  ).toBe(legacy)
  const isolated = createRuntimeConfig(createOptions(), 'x64', {
    LOCALAPPDATA: root,
    OPEN_SCIENCE_CONFIG_ROOT: join(root, 'task')
  })
  expect(isolated.windowsOwnershipRoot).toBe(
    join(root, 'task', 'notebook-sandbox', fresh.installationId!)
  )
})

it('rejects conflicting Windows ownership records instead of choosing a second resource set', () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-sandbox-'))
  temporaryRoots.push(root)
  const config = createRuntimeConfig(createOptions(), 'x64', { LOCALAPPDATA: root })
  for (const brand of ['Open-Science', 'OpenScience']) {
    const ownership = join(root, 'Aipoch', brand, 'notebook-sandbox', config.installationId!)
    mkdirSync(ownership, { recursive: true })
    writeFileSync(join(ownership, 'receipt.json'), '{}')
  }
  expect(() => createRuntimeConfig(createOptions(), 'x64', { LOCALAPPDATA: root })).toThrow(
    'ambiguous'
  )
})

it('uses the real E2E storage override before config without touching shared ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-sandbox-'))
  temporaryRoots.push(root)
  const environment = {
    LOCALAPPDATA: join(root, 'shared'),
    OPEN_SCIENCE_E2E_STORAGE_ROOT: join(root, 'e2e'),
    OPEN_SCIENCE_CONFIG_ROOT: join(root, 'config')
  }
  const config = createRuntimeConfig(createOptions(), 'x64', environment)
  expect(config.windowsOwnershipRoot).toBe(
    join(root, 'e2e', 'notebook-sandbox', config.installationId!)
  )
  expect(
    createRuntimeConfig(createOptions(), 'x64', {
      ...environment,
      OPEN_SCIENCE_CONFIG_ROOT: undefined
    }).windowsOwnershipRoot
  ).toBe(config.windowsOwnershipRoot)
})

it.each([true, false])(
  'uses normalized shared override priority in mode packaged=%s',
  (packaged) => {
    const root = mkdtempSync(join(tmpdir(), 'brand-config-priority-'))
    temporaryRoots.push(root)
    const env = {
      HOME: root,
      LOCALAPPDATA: join(root, 'local'),
      OPEN_SCIENCE_E2E_STORAGE_ROOT: ` ${root}/unused/../e2e `,
      OPEN_SCIENCE_CONFIG_ROOT: ` ${root}/config `,
      OPEN_SCIENCE_STORAGE_ROOT: ` ${root}/storage `
    }
    expect(createRuntimeConfig(createOptions({ packaged }), 'x64', env).windowsOwnershipRoot).toBe(
      join(root, 'e2e', 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    )
    env.OPEN_SCIENCE_E2E_STORAGE_ROOT = '   '
    expect(createRuntimeConfig(createOptions({ packaged }), 'x64', env).windowsOwnershipRoot).toBe(
      join(root, 'config', 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    )
  }
)

it.each(['OPEN_SCIENCE_E2E_STORAGE_ROOT', 'OPEN_SCIENCE_CONFIG_ROOT', 'OPEN_SCIENCE_STORAGE_ROOT'])(
  'rejects a relative %s before initializing ownership',
  (key) => {
    expect(() =>
      createRuntimeConfig(createOptions({ packaged: false }), 'x64', { [key]: ' relative-path ' })
    ).toThrow(`${key} must be an absolute path.`)
  }
)
