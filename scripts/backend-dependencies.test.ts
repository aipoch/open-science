import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertBackendImports,
  assertStagedBackendImports,
  isElectronPackage
} from './backend-dependencies.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('standalone dependency boundary', () => {
  it.each([
    'electron',
    'electron/main',
    'electron-updater',
    '@electron-toolkit/utils',
    '@electron/remote'
  ])('forbids %s in the package closure', (name) => {
    expect(isElectronPackage(name)).toBe(true)
  })
  it('rejects an Electron import in any reachable worker or transitive source', () => {
    expect(() =>
      assertBackendImports(
        [{ inputs: { 'deep/worker.ts': { imports: [{ path: 'electron' }] } }, outputs: {} }],
        {}
      )
    ).toThrow('deep/worker.ts')
  })
  it('rejects a development-only runtime dependency before producing an incomplete package', () => {
    expect(() =>
      assertBackendImports(
        [
          { inputs: {}, outputs: { 'index.cjs': { imports: [{ path: 'saxes', external: true }] } } }
        ],
        {}
      )
    ).toThrow('production: saxes')
    expect(() =>
      assertBackendImports(
        [
          {
            inputs: {},
            outputs: {
              'index.cjs': {
                imports: [
                  { path: 'saxes', external: true },
                  { path: 'node:sqlite', external: true }
                ]
              }
            }
          }
        ],
        { saxes: '6.0.0' }
      )
    ).not.toThrow()
  })
})

describe('staged backend dependency boundary', () => {
  const policy = '@aipoch/notebook-network-sandbox/execution-confinement'
  const metadata = [
    {
      outputs: {
        'out/backend/index.cjs': {
          imports: [
            { path: policy, external: true },
            { path: 'node:fs', external: true },
            { path: 'fs/promises', external: true }
          ]
        }
      }
    }
  ]
  async function fixture(): Promise<{ root: string; stage: string; sandbox: string }> {
    const root = await mkdtemp(join(tmpdir(), 'staged-backend-test-'))
    directories.push(root)
    const stage = join(root, 'artifact')
    await mkdir(stage)
    const sandbox = join(root, 'node_modules/@aipoch/notebook-network-sandbox')
    await cp(
      fileURLToPath(new URL('../packages/notebook-network-sandbox', import.meta.url)),
      sandbox,
      {
        recursive: true,
        filter: (path) => !path.includes('node_modules')
      }
    )
    return { root, stage, sandbox }
  }
  it('rejects a missing staged package even when the ancestor checkout supplies its export', async () => {
    const { stage } = await fixture()
    expect(() => assertStagedBackendImports(stage, metadata)).toThrow(
      `outside the staged artifact: ${policy}`
    )
  })
  it('rejects a package symlink that leaks back into the source checkout', async () => {
    const { stage, sandbox } = await fixture()
    const installed = join(stage, 'node_modules/@aipoch/notebook-network-sandbox')
    await mkdir(join(stage, 'node_modules/@aipoch'), { recursive: true })
    await symlink(sandbox, installed, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertStagedBackendImports(stage, metadata)).toThrow('outside the staged artifact')
  })
  it('loads the staged public export through CommonJS and ESM with its policy intact', async () => {
    const { stage, sandbox } = await fixture()
    const installed = join(stage, 'node_modules/@aipoch/notebook-network-sandbox')
    await cp(sandbox, installed, { recursive: true })
    expect(() => assertStagedBackendImports(stage, metadata)).not.toThrow()
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const cjs = require(${JSON.stringify(policy)})
      const esm = await import(${JSON.stringify(policy)})
      assert.equal(cjs.normalizeExecutionConfinement, esm.normalizeExecutionConfinement)
      const offline = cjs.normalizeExecutionConfinement({ mode: 'offline-demo' })
      assert.equal(cjs.executionConfinementAllowsHost(offline, 'example.com'), false)
      assert.throws(() => cjs.normalizeExecutionConfinement({ mode: 'research', allowedNetworkHosts: ['*.example.com'] }))
    `
      ],
      { cwd: stage, encoding: 'utf8' }
    )
  })
  it('checks worker imports as well as the main entry', async () => {
    const { stage } = await fixture()
    const missing = [
      {
        outputs: {
          'out/backend/worker.cjs': {
            imports: [{ path: 'missing-worker-dependency', external: true }]
          }
        }
      }
    ]
    expect(() => assertStagedBackendImports(stage, missing)).toThrow('missing-worker-dependency')
  })
})
