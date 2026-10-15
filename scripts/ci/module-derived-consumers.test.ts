/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ModuleImpactManifest } from './load-module-impact.mjs'
import {
  derivedConsumersPath,
  loadDerivedConsumers,
  validateDerivedConsumers,
  withDerivedConsumers
} from './module-derived-consumers.mjs'
import {
  consumerDependencyGraph,
  generateDerivedConsumers,
  checkDerivedConsumers,
  checkDerivedConsumerRevisions,
  runDerivedConsumersCli
} from './generate-module-derived-consumers.mjs'
import { createModuleTestPlan, createAffectedTestPlan } from './module-test-impact.mjs'
import { additiveModuleImpact } from './module-impact-inputs.mjs'

const owner = 'src/main/owner.ts'
const ownerTest = 'src/main/owner.test.ts'
const consumer = 'src/main/consumer.test.ts'
const manifest = (): ModuleImpactManifest => ({
  schemaVersion: 1,
  modules: {
    owner: {
      ownerPaths: [owner, ownerTest],
      interfacePaths: [owner],
      testFiles: { owner: [ownerTest], contract: [], consumer: [] },
      consumerModules: [],
      capabilityOverlays: ['windows_sensitive'],
      fallbackCapability: 'main_runtime'
    },
    consumer: {
      ownerPaths: [consumer],
      interfacePaths: [consumer],
      testFiles: { owner: [consumer], contract: [], consumer: [] },
      consumerModules: [],
      capabilityOverlays: [],
      fallbackCapability: 'main_runtime'
    }
  }
})
const expected = { schemaVersion: 1, modules: { owner: [consumer] } }
const source = (extra: Record<string, string> = {}) => {
  const contents: Record<string, string> = {
    [owner]: 'export const value = 1',
    [ownerTest]: "import './owner'",
    [consumer]: "import './bridge'",
    'src/main/bridge.ts': "export * from './owner'",
    'scripts/ci/module-runtime-consumers.json': '{}',
    [derivedConsumersPath]: JSON.stringify(expected),
    ...extra
  }
  return { files: new Set(Object.keys(contents)), read: (p: string) => contents[p] }
}

it.each([
  "import './owner'",
  "import type { Value } from './owner'",
  "export * from './owner'",
  "void import('./owner')",
  "vi.mock('./owner', () => ({}))",
  "vi.doMock('./owner')",
  "vi.importActual('./owner')",
  "jest.mock('./owner')",
  "require('./owner')"
])('retains structurally reachable consumers through %s', (text) => {
  const graph = consumerDependencyGraph(source({ [consumer]: text }), [])
  expect(generateDerivedConsumers(manifest(), graph.reverse)).toEqual(expected)
})

it('handles renderer aliases, cycles, runtime declarations and excludes E2E tests', () => {
  const input = source({
    'src/renderer/src/bridge.ts': "export * from '../../main/owner'",
    [consumer]: "import '@/bridge'; import('./consumer.test')",
    'e2e/owner.spec.ts': "import '../src/main/owner'"
  })
  expect(generateDerivedConsumers(manifest(), consumerDependencyGraph(input, []).reverse)).toEqual(
    expected
  )
  expect(
    generateDerivedConsumers(
      manifest(),
      consumerDependencyGraph(source({ [consumer]: 'loadComputed(name)' }), [[owner, [consumer]]])
        .reverse
    )
  ).toEqual(expected)
  expect(() => consumerDependencyGraph(input, [[owner, ['missing.ts']]])).toThrow(
    'runtime consumer'
  )
})

it('keeps known edges in opaque cones without claiming coverage of computed imports', () => {
  const graph = consumerDependencyGraph(
    source({ [consumer]: "import('./owner'); import(name)" }),
    []
  )
  expect(graph.inspect.dependencies(consumer).complete).toBe(false)
  expect(generateDerivedConsumers(manifest(), graph.reverse)).toEqual(expected)
})

it('requires shared test helpers to be interfaces before propagating their consumers', () => {
  const input = source({
    [consumer]: "import './owner.test'",
    [ownerTest]: 'export const fixture = 1'
  })
  const reverse = consumerDependencyGraph(input, []).reverse
  expect(generateDerivedConsumers(manifest(), reverse).modules).toEqual({})
  const explicit = manifest()
  explicit.modules.owner.interfacePaths.push(ownerTest)
  expect(generateDerivedConsumers(explicit, reverse)).toEqual(expected)
})

it('stores only additional evidence, preserves explicit contracts and never mutates inputs', () => {
  const explicit = manifest()
  explicit.modules.owner.testFiles.contract.push('src/main/event.test.ts')
  const index = {
    schemaVersion: 1,
    modules: { owner: [consumer, ownerTest, 'src/main/event.test.ts'] }
  }
  const effective = withDerivedConsumers(explicit, index)
  expect(effective.modules.owner.testFiles.consumer).toEqual([consumer])
  expect(effective.modules.owner.testFiles.contract).toEqual(['src/main/event.test.ts'])
  expect(explicit.modules.owner.testFiles.consumer).toEqual([])
  expect(effective.modules.owner.derivedConsumerTests).toEqual([consumer])
  explicit.modules.owner.testFiles.consumer.push(consumer)
  expect(
    generateDerivedConsumers(explicit, consumerDependencyGraph(source(), []).reverse).modules
  ).toEqual({})
  const removed = manifest()
  expect(
    additiveModuleImpact(
      explicit,
      removed,
      explicit,
      new Set(),
      new Set([owner, ownerTest, consumer])
    )
  ).toBeNull()
})

it('selects and explains derived tests without changing capabilities or full markers', () => {
  const explicit = manifest()
  const effective = withDerivedConsumers(explicit, expected)
  const modulePlan = createModuleTestPlan('owner', effective)
  expect(modulePlan.testFiles).toEqual([consumer, ownerTest].sort())
  expect(modulePlan.reasonChains).toContain(`owner -> derived dependency evidence -> ${consumer}`)
  const affected = createAffectedTestPlan(
    [{ path: owner, status: 'modified' }],
    { status: 'current', testFiles: [] },
    effective
  )
  expect(affected.testFiles).toEqual(modulePlan.testFiles)
  expect(affected.capabilityOverlays).toEqual(['windows_sensitive'])
  const direct = createAffectedTestPlan(
    [{ path: consumer, status: 'modified' }],
    { status: 'current', testFiles: [] },
    effective
  )
  expect(direct.testFiles).toEqual([consumer])
  const ownerOnly = createAffectedTestPlan(
    [{ path: ownerTest, status: 'modified' }],
    { status: 'current', testFiles: [] },
    effective
  )
  expect(ownerOnly.reasonChains.join('\n')).not.toContain(
    `derived dependency evidence -> ${consumer}`
  )
  effective.modules.owner.fullTestReason = 'Dynamic global boundary'
  expect(createModuleTestPlan('owner', effective).mode).toBe('full')
  expect(
    createAffectedTestPlan(
      [{ path: derivedConsumersPath, status: 'modified' }],
      { status: 'current', testFiles: [] },
      effective
    ).mode
  ).toBe('full')
})

it.each([
  '/absolute.test.ts',
  '../escape.test.ts',
  'C:/drive.test.ts',
  'src\\win.test.ts',
  'src//gap.test.ts',
  'e2e/flow.spec.ts',
  'src/not-a-test.ts'
])('rejects unsafe or unsupported path %s', (path) => {
  expect(() =>
    validateDerivedConsumers({ schemaVersion: 1, modules: { owner: [path] } }, manifest())
  ).toThrow()
})
it.each([
  null,
  { schemaVersion: 2, modules: {} },
  { schemaVersion: 1, modules: [], extra: true },
  { schemaVersion: 1, modules: { missing: [] } },
  { schemaVersion: 1, modules: { owner: [consumer, consumer] } }
])('rejects malformed index %j', (index) => {
  expect(() => validateDerivedConsumers(index, manifest())).toThrow()
})

it('rejects missing, forged, stale and redundant evidence', () => {
  expect(() => checkDerivedConsumers(source(), manifest())).not.toThrow()
  for (const index of [
    { schemaVersion: 1, modules: {} },
    { schemaVersion: 1, modules: { owner: ['src/main/unknown.test.ts'] } }
  ])
    expect(() =>
      checkDerivedConsumers(source({ [derivedConsumersPath]: JSON.stringify(index) }), manifest())
    ).toThrow('Stale')
  const missing = source()
  missing.files.delete(derivedConsumersPath)
  expect(() =>
    checkDerivedConsumers(
      { ...missing, read: (p: string) => (missing.files.has(p) ? missing.read(p) : undefined) },
      manifest()
    )
  ).toThrow('Missing')
  const changed = source({ [consumer]: 'export const independent = true' })
  expect(() => checkDerivedConsumers(changed, manifest())).toThrow('Stale')
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'derived-consumers-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  const input = source()
  for (const path of input.files) if (path !== derivedConsumersPath) put(path, input.read(path))
  put('scripts/ci/module-impact.json', JSON.stringify(manifest()))
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'ci(test): record fixture')
    return git('rev-parse', 'HEAD')
  }
  return { root, git, put, commit }
}

it('generates deterministically and validates immutable candidate blobs without executing them', () => {
  const f = repository()
  const legacy = f.commit()
  expect(() => checkDerivedConsumerRevisions(legacy, legacy, f.root)).not.toThrow()
  f.put(consumer, "throw new Error('candidate code must never run'); import('./bridge')")
  runDerivedConsumersCli(['--write'], f.root)
  const text = readFileSync(join(f.root, derivedConsumersPath), 'utf8')
  expect(loadDerivedConsumers(join(f.root, derivedConsumersPath))).toEqual(expected)
  runDerivedConsumersCli(['--write'], f.root)
  expect(readFileSync(join(f.root, derivedConsumersPath), 'utf8')).toBe(text)
  runDerivedConsumersCli(['--check'], f.root)
  const added = f.commit()
  expect(() => checkDerivedConsumerRevisions(legacy, added, f.root)).not.toThrow()
  // Forged candidate policy is data too, never imported by the trusted checker.
  f.put('scripts/ci/generate-module-derived-consumers.mjs', "throw Error('untrusted checker')")
  f.put(derivedConsumersPath, JSON.stringify({ schemaVersion: 1, modules: {} }))
  const forged = f.commit()
  expect(() => checkDerivedConsumerRevisions(added, forged, f.root)).toThrow('Stale')
  const integrity = spawnSync(
    process.execPath,
    [resolve('scripts/ci/check-ci-integrity.mjs'), '--base', added, '--head', forged],
    {
      cwd: f.root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
    }
  )
  expect(integrity.status, integrity.stderr).toBe(1)
  expect(integrity.stdout).toContain('derived-consumer-evidence')
  rmSync(join(f.root, derivedConsumersPath))
  const deleted = f.commit()
  expect(() => checkDerivedConsumerRevisions(added, deleted, f.root)).toThrow('Missing')
}, 30_000)

it('rejects Git symlinks without following them on any platform', () => {
  const f = repository()
  const base = f.commit()
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: f.root,
    input: 'outside.json',
    encoding: 'utf8'
  }).trim()
  f.git('update-index', '--add', '--cacheinfo', '120000', blob, derivedConsumersPath)
  f.git('commit', '-qm', 'ci(test): add symlink')
  expect(() => checkDerivedConsumerRevisions(base, f.git('rev-parse', 'HEAD'), f.root)).toThrow(
    'Missing'
  )
}, 30_000)

it('follows explicit native intermediates and source package exports', () => {
  const native = source({ [consumer]: 'loadNative()', 'native/addon.node': '' })
  const graph = consumerDependencyGraph(native, [
    [owner, ['native/addon.node']],
    ['native/addon.node', [consumer]]
  ])
  expect(generateDerivedConsumers(manifest(), graph.reverse)).toEqual(expected)
  const input = source({
    'scripts/ci/package-test-boundaries.json': JSON.stringify({
      packages: [{ root: 'packages/lib' }]
    }),
    'packages/lib/package.json': JSON.stringify({
      name: '@example/lib',
      exports: { '.': './dist/index.js' }
    }),
    'packages/lib/src/index.ts': "export * from '../../../src/main/owner'",
    [consumer]: "import '@example/lib'"
  })
  expect(generateDerivedConsumers(manifest(), consumerDependencyGraph(input, []).reverse)).toEqual(
    expected
  )
})

it('does not treat target-branch introduction as a deletion by an older candidate', () => {
  const f = repository()
  const ancestor = f.commit()
  runDerivedConsumersCli(['--write'], f.root)
  const newerBase = f.commit()
  f.git('checkout', '--quiet', '-b', 'older-candidate', ancestor)
  f.put('README.md', 'unrelated legacy change')
  const head = f.commit()
  expect(() => checkDerivedConsumerRevisions(newerBase, head, f.root)).not.toThrow()
}, 30_000)
