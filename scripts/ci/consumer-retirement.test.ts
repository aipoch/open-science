import { dependencyConsumerBoundaries } from './module-derived-consumers.mjs'
import {
  createConsumerDependencyReader,
  dependencyBoundaryViolations,
  provablyStaleConsumerTests
} from './consumer-retirement.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
// Each case creates and commits Git snapshots; allow slow Windows/CI filesystem operations.
const owner = 'src/owner.ts'
const consumer = 'src/consumer.test.ts'
function fixture(
  options: { runtime?: boolean; full?: boolean; baseTest?: string; testPath?: string } = {}
) {
  const consumer = options.testPath ?? 'src/consumer.test.ts'
  const root = mkdtempSync(join(tmpdir(), 'consumer-retirement-'))
  roots.push(root)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const put = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const module = (paths: string[], tests: string[]) => ({
    ownerPaths: paths,
    interfacePaths: [paths[0]],
    consumerModules: [],
    testFiles: { owner: tests, contract: [] as string[], consumer: [] as string[] },
    capabilityOverlays: [],
    fallbackCapability: 'main_runtime'
  })
  const manifest = {
    schemaVersion: 1,
    modules: {
      upstream: {
        ...module([owner, 'src/owner.test.ts'], ['src/owner.test.ts']),
        ...(options.full ? { fullTestReason: 'Dynamic consumers' } : {})
      },
      downstream: module([consumer, 'src/bridge.ts', 'src/independent.ts'], [consumer])
    }
  }
  manifest.modules.upstream.testFiles.consumer.push(consumer)
  const save = (): void => put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  if (options.testPath?.startsWith('packages/'))
    put('packages/client/package.json', JSON.stringify({ name: '@example/client' }))
  put(owner, 'export const value = 1')
  put('src/owner.test.ts', "import { value } from './owner'")
  put('src/independent.ts', 'export const value = 2')
  put('src/bridge.ts', "export { value } from './owner'")
  put(consumer, options.baseTest ?? "import { value } from './bridge'")
  if (/^src\/(?:main|renderer)\//.test(consumer)) {
    const retained = 'src/main/retained.test.ts'
    put(retained, 'export {}')
    manifest.modules.downstream.ownerPaths.push(retained)
    manifest.modules.downstream.testFiles.owner.push(retained)
  }
  if (options.runtime)
    put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [consumer] }))
  save()
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const inspect = (
    testSource = "import { value } from './independent'",
    from = base,
    afterStage = () => {}
  ) => {
    put(consumer, testSource)
    manifest.modules.upstream.testFiles.consumer = []
    save()
    git('add', '.')
    afterStage()
    git('commit', '-qm', 'retire consumer')
    return moduleOwnershipFromRevisions(from, git('rev-parse', 'HEAD'), { cwd: root })
  }
  return { root, git, put, manifest, inspect }
}

it('admits a consumer retired by a real transitive dependency refactor', () => {
  expect(fixture().inspect()).toMatchObject({
    ok: true,
    retiredConsumers: [`upstream:${consumer}`]
  })
}, 30_000)

it.each([
  "import { value } from './owner'",
  "import { value } from './bridge'",
  "import type { value } from './owner'",
  "vi.mock('./owner', () => ({}))",
  "vi.doMock('./owner', () => ({}))",
  "const value = await import('./owner')",
  "const value = require('./owner')"
])(
  'retains consumer evidence for reachable dependency %s',
  (source) => {
    expect(fixture().inspect(source).ok).toBe(false)
  },
  30_000
)

it.each([
  "import './missing'",
  "import value from '@/missing'",
  "import value from '@aipoch/missing'",
  'const target = process.env.TARGET; import(target)',
  'const target = process.env.TARGET; require(target)',
  'vi.mock(process.env.TARGET)',
  "import { from './independent'"
])(
  'fails closed for incomplete candidate evidence: %s',
  (source) => {
    expect(fixture().inspect(source).ok).toBe(false)
  },
  30_000
)

it('retains base runtime/source-read edges even if the candidate deletes the declaration', () => {
  const state = fixture({ runtime: true })
  state.put('scripts/ci/module-runtime-consumers.json', '{}')
  expect(state.inspect().ok).toBe(false)
}, 30_000)

it('honors newly declared runtime consumers', () => {
  const state = fixture()
  state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [consumer] }))
  expect(state.inspect().ok).toBe(false)
}, 30_000)

it('does not retire full-validation or already-unproven historical evidence', () => {
  expect(fixture({ full: true }).inspect().ok).toBe(false)
  expect(fixture({ baseTest: 'export {}' }).inspect().ok).toBe(false)
}, 30_000)

it('reads candidate source and checker changes as data without running either', () => {
  const state = fixture()
  state.put('scripts/ci/check-module-ownership.mjs', 'throw Error("candidate checker executed")')
  const marker = join(state.root, 'executed')
  expect(
    state.inspect(
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad')`
    ).ok
  ).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, 30_000)

it.each(['@example/owner', '@/owner', '@renderer/owner'])(
  'resolves %s from Git source without installed packages',
  (specifier) => {
    const state = fixture()
    const source =
      specifier === '@example/owner' ? 'packages/example/src/index.ts' : 'src/renderer/src/owner.ts'
    state.put(source, 'export const value = 1')
    if (specifier === '@example/owner') {
      state.put(
        'packages/example/package.json',
        JSON.stringify({
          name: '@example/owner',
          exports: { '.': { default: './dist/index.js' } }
        })
      )
      state.put(
        'scripts/ci/package-test-boundaries.json',
        JSON.stringify({
          packages: [{ root: 'packages/example', dependencies: [] }]
        })
      )
      state.manifest.modules.upstream.ownerPaths.push('packages/example/package.json')
    }
    state.manifest.modules.upstream.ownerPaths.push(source)
    state.put(consumer, `import { value } from '${specifier}'`)
    state.put('scripts/ci/module-impact.json', JSON.stringify(state.manifest))
    state.git('add', '.')
    state.git('commit', '-qm', 'mapped dependency baseline')
    const base = state.git('rev-parse', 'HEAD')
    expect(state.inspect(`import { value } from '${specifier}'`, base).ok).toBe(false)
    expect(state.inspect("import { value } from './independent'", base)).toMatchObject({
      ok: true,
      retiredConsumers: [`upstream:${consumer}`]
    })
  },
  30_000
)

it('keeps public interface obligations unchanged when a consumer can retire', () => {
  const state = fixture()
  const extra = 'src/owner-extra.ts'
  state.put(extra, 'export const extra = 1')
  state.manifest.modules.upstream.ownerPaths.push(extra)
  state.manifest.modules.upstream.interfacePaths.push(extra)
  state.put('scripts/ci/module-impact.json', JSON.stringify(state.manifest))
  state.git('add', '.')
  state.git('commit', '-qm', 'interface baseline')
  const base = state.git('rev-parse', 'HEAD')
  state.manifest.modules.upstream.interfacePaths = [owner]
  const result = state.inspect(undefined, base)
  expect(result.retiredConsumers).toEqual([`upstream:${consumer}`])
  expect(result.ok).toBe(false)
  expect(result.violations).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule: 'module-registration-regression' })])
  )
}, 30_000)

it('retains consumer evidence when the candidate declares full validation', () => {
  const state = fixture()
  state.manifest.modules.upstream.fullTestReason = 'Unknown runtime dependencies'
  expect(state.inspect().ok).toBe(false)
}, 30_000)

it('does not analyze symlinks as regular source even when blob contents match', () => {
  const state = fixture()
  // The symlink content is also a valid source blob elsewhere in the snapshot.
  state.put('src/independent.ts', 'independent')
  state.put('src/linked.ts', 'independent')
  state.manifest.modules.downstream.ownerPaths.push('src/linked.ts')
  expect(
    state.inspect("import './linked'", undefined, () => {
      const oid = state.git('rev-parse', ':src/independent.ts')
      state.git('update-index', '--cacheinfo', `120000,${oid},src/linked.ts`)
    }).ok
  ).toBe(false)
}, 30_000)

it.each([
  ['disconnected imports', "import './independent'", [] as string[], true],
  ['reachable imports', "import './owner'", [] as string[], false],
  ['computed import', 'import(globalThis.target)', [] as string[], false],
  [
    'generated native addon',
    "require('./build/Release/process_tree_native.node')",
    [] as string[],
    false
  ],
  ['missing local source', "import './missing'", [] as string[], false],
  ['registered runtime edge', "import './independent'", [consumer], false]
])(
  'only rejects provably stale consumer evidence: %s',
  (_name, source, runtimeConsumers, stale) => {
    const sources = new Map([
      [owner, 'export const value = 1'],
      [consumer, source],
      ['src/independent.ts', 'export const value = 2']
    ])
    const inspect = createConsumerDependencyReader(
      { files: new Set(sources.keys()), read: (path: string) => sources.get(path) },
      [[owner, runtimeConsumers]]
    )
    expect(
      provablyStaleConsumerTests(
        { ownerPaths: [owner], testFiles: { consumer: [consumer] } },
        inspect
      )
    ).toEqual(stale ? [consumer] : [])
  }
)

it('retires a historical unrelated package consumer while keeping its owner suite', () => {
  const state = fixture({ testPath: 'packages/client/consumer.test.ts', baseTest: 'export {}' })
  expect(state.inspect('export const independent = true').ok).toBe(true)
}, 30_000)

it.each(['src/main/consumer.test.ts', 'src/renderer/src/consumer.test.ts'])(
  'retires an already-independent host consumer in a registration-only change: %s',
  (testPath) => {
    const state = fixture({ testPath, baseTest: 'export {}' })
    expect(state.inspect('export {}')).toMatchObject({
      ok: true,
      retiredConsumers: [`upstream:${testPath}`]
    })
  },
  30_000
)

it.each([
  "import './missing'",
  'import(process.env.TARGET)',
  "import type { value } from '../owner'",
  "vi.mock('../owner')",
  "import { readFileSync } from 'node:fs'; readFileSync('src/owner.ts')",
  "import { ipcRenderer } from 'electron'; ipcRenderer.invoke('owner')",
  'window.api.readOwner()',
  "fetch('/owner')",
  "import { execSync } from 'node:child_process'; execSync('read-owner')"
])(
  'retains historical host evidence with incomplete or reachable source: %s',
  (baseTest) => {
    const state = fixture({ testPath: 'src/main/consumer.test.ts', baseTest })
    expect(state.inspect(baseTest)).toMatchObject({ ok: false, retiredConsumers: [] })
  },
  30_000
)

it('retains historical host evidence with transitive opaque access', () => {
  const baseTest = "import '../independent'"
  const state = fixture({ testPath: 'src/main/consumer.test.ts', baseTest })
  state.put(
    'src/independent.ts',
    "import { readFileSync } from 'node:fs'; readFileSync('src/owner.ts')"
  )
  state.git('add', '.')
  state.git('commit', '-qm', 'opaque dependency baseline')
  expect(state.inspect(baseTest, state.git('rev-parse', 'HEAD'))).toMatchObject({
    ok: false,
    retiredConsumers: []
  })
}, 30_000)

it.each([
  "import type { Value } from '../independent'",
  "import { type Value } from '../independent'",
  "export type { Value } from '../independent'",
  "export type * from '../independent'",
  "type Value = import('../independent').Value",
  "import type Independent = require('../independent')"
])(
  'retires a host consumer with an erased reference to an unrelated opaque body: %s',
  (baseTest) => {
    const state = fixture({ testPath: 'src/main/consumer.test.ts', baseTest })
    state.put(
      'src/independent.ts',
      "import { readFileSync } from 'node:fs'; readFileSync('unrelated.json'); export type Value = number"
    )
    state.git('add', '.')
    state.git('commit', '-qm', 'erased opaque body baseline')
    expect(state.inspect(baseTest, state.git('rev-parse', 'HEAD'))).toMatchObject({
      ok: true,
      retiredConsumers: ['upstream:src/main/consumer.test.ts']
    })
  },
  30_000
)

it.each([
  ["import { value, type Value } from '../independent'", "fetch('/unrelated')"],
  ["import type { Value } from '../independent'; import '../independent'", "fetch('/unrelated')"],
  ["import {} from '../independent'", "fetch('/unrelated')"],
  ["export * from '../independent'", "fetch('/unrelated')"],
  ["import type { Value } from '../independent'", "import './owner'; export type Value = number"],
  ["import type { Value } from '../independent'", "import './missing'; export type Value = number"],
  [
    "import type { Value } from '../independent'",
    'import(process.env.TARGET); export type Value = number'
  ],
  ["import type { Value } from '../missing'", 'export type Value = number']
])(
  'retains structural and runtime uncertainty through type-related imports: %s / %s',
  (baseTest, helper) => {
    const state = fixture({ testPath: 'src/main/consumer.test.ts', baseTest })
    state.put('src/independent.ts', helper)
    state.git('add', '.')
    state.git('commit', '-qm', 'type-related dependency baseline')
    expect(state.inspect(baseTest, state.git('rev-parse', 'HEAD'))).toMatchObject({
      ok: false,
      retiredConsumers: []
    })
  },
  30_000
)

it.each([
  'test-edit',
  'source-edit',
  'runtime-edit',
  'policy-edit',
  'lost-owner-test',
  'moved-owner',
  'full-base',
  'full-head',
  'runtime-base',
  'deleted-test',
  'symlink-test',
  'contract-removal',
  'interface-removal',
  'routing-change'
])(
  'rejects historical host retirement with %s',
  (scenario) => {
    const testPath = 'src/main/consumer.test.ts'
    const state = fixture({
      testPath,
      baseTest: 'export {}',
      full: scenario === 'full-base',
      runtime: scenario === 'runtime-base'
    })
    if (scenario === 'source-edit') state.put('src/independent.ts', 'export const value = 3')
    if (scenario === 'runtime-edit') state.put('scripts/ci/module-runtime-consumers.json', '{}')
    if (scenario === 'policy-edit')
      state.put('scripts/ci/check-module-ownership.mjs', 'throw Error("must not execute")')
    if (scenario === 'lost-owner-test') {
      state.manifest.modules.downstream.testFiles.owner = []
      state.manifest.modules.downstream.testFiles.contract = [testPath]
    }
    if (scenario === 'moved-owner') {
      state.manifest.modules.downstream.ownerPaths =
        state.manifest.modules.downstream.ownerPaths.filter((path) => path !== testPath)
      state.manifest.modules.downstream.testFiles.owner = ['src/main/retained.test.ts']
      state.manifest.modules.upstream.ownerPaths.push(testPath)
      state.manifest.modules.upstream.testFiles.owner.push(testPath)
    }
    if (scenario === 'deleted-test') {
      state.manifest.modules.downstream.ownerPaths =
        state.manifest.modules.downstream.ownerPaths.filter((path) => path !== testPath)
      state.manifest.modules.downstream.interfacePaths = ['src/bridge.ts']
      state.manifest.modules.downstream.testFiles.owner = ['src/main/retained.test.ts']
    }
    if (scenario === 'full-head')
      state.manifest.modules.upstream.fullTestReason = 'Unknown runtime dependencies'
    if (scenario === 'interface-removal')
      state.manifest.modules.upstream.interfacePaths = ['src/owner.test.ts']
    if (scenario === 'routing-change')
      state.manifest.modules.upstream.fallbackCapability = 'windows_sensitive'
    let from = state.git('rev-parse', 'HEAD')
    if (scenario === 'contract-removal') {
      state.manifest.modules.upstream.testFiles.contract.push('src/main/retained.test.ts')
      state.put('scripts/ci/module-impact.json', JSON.stringify(state.manifest))
      state.git('add', '.')
      state.git('commit', '-qm', 'contract baseline')
      from = state.git('rev-parse', 'HEAD')
      state.manifest.modules.upstream.testFiles.contract = []
    }
    const result = state.inspect(
      scenario === 'test-edit' ? 'export const independent = true' : 'export {}',
      from,
      () => {
        if (scenario === 'deleted-test') state.git('rm', '-q', testPath)
        if (scenario === 'symlink-test') {
          const oid = state.git('rev-parse', `:${testPath}`)
          state.git('update-index', '--cacheinfo', `120000,${oid},${testPath}`)
        }
      }
    )
    // Deleted paths may lose registration, but must never be certified as independent survivors.
    if (scenario === 'deleted-test') expect(result.retiredConsumers).toEqual([])
    else expect(result.ok).toBe(false)
  },
  30_000
)

it.each(['incomplete-base', 'lost-owner', 'runtime-edge'])(
  'retains historical foreign-package coverage with %s evidence',
  (scenario) => {
    const testPath = 'packages/client/consumer.test.ts'
    const state = fixture({
      testPath,
      baseTest: scenario === 'incomplete-base' ? "import './missing'" : 'export {}',
      runtime: scenario === 'runtime-edge'
    })
    if (scenario === 'lost-owner') {
      state.manifest.modules.downstream.testFiles.owner = []
      state.manifest.modules.downstream.testFiles.contract = [testPath]
    }
    expect(state.inspect('export const independent = true').ok).toBe(false)
  },
  30_000
)
function packageFixture() {
  const state = fixture()
  const test = 'packages/independent/src/index.test.ts'
  const source = 'packages/independent/src/index.ts'
  const registry = {
    schemaVersion: 1,
    packages: [{ root: 'packages/independent', dependencies: [] as string[] }]
  }
  state.put(source, 'export const value = 1')
  state.put(test, "import { value } from './index'")
  state.put(
    'packages/independent/package.json',
    JSON.stringify({
      name: '@example/independent',
      scripts: { test: 'vitest run' },
      exports: { '.': { default: './dist/index.js' } }
    })
  )
  state.put('scripts/ci/package-test-boundaries.json', JSON.stringify(registry))
  Object.assign(state.manifest.modules, {
    independent: {
      ownerPaths: [source, test, 'packages/independent/package.json'],
      interfacePaths: [source],
      testFiles: { owner: [test], contract: [], consumer: [] },
      consumerModules: [],
      capabilityOverlays: [],
      fallbackCapability: 'main_runtime'
    }
  })
  state.manifest.modules.upstream.testFiles.contract.push(test)
  const save = () => state.put('scripts/ci/module-impact.json', JSON.stringify(state.manifest))
  save()
  state.git('add', '.')
  state.git('commit', '-qm', 'independent package baseline')
  const base = state.git('rev-parse', 'HEAD')
  const retire = (before = base) => {
    state.manifest.modules.upstream.testFiles.contract =
      state.manifest.modules.upstream.testFiles.contract.filter((path) => path !== test)
    save()
    state.git('add', '.')
    state.git('commit', '-qm', 'retire excluded package evidence')
    return moduleOwnershipFromRevisions(before, state.git('rev-parse', 'HEAD'), { cwd: state.root })
  }
  return { ...state, test, source, registry, base, save, retire }
}

it('retires historical contract evidence only when trusted selection already excludes its independent package', () => {
  const state = packageFixture()
  expect(state.retire()).toMatchObject({
    ok: true,
    retiredPackageTests: [`upstream:contract:${state.test}`]
  })
}, 30_000)

it.each([
  "import '../../../src/owner'",
  "import './missing'",
  'import(process.env.TARGET)',
  "vi.mock('../../../src/owner')"
])(
  'keeps package evidence for reachable or incomplete candidate %s',
  (source) => {
    const state = packageFixture()
    state.put(state.test, source)
    expect(state.retire().ok).toBe(false)
  },
  30_000
)

it('does not use candidate registry additions to authorize a retirement', () => {
  const state = packageFixture()
  state.put(
    'scripts/ci/package-test-boundaries.json',
    JSON.stringify({ schemaVersion: 1, packages: [] })
  )
  state.git('add', '.')
  state.git('commit', '-qm', 'package was not trusted')
  const base = state.git('rev-parse', 'HEAD')
  state.put('scripts/ci/package-test-boundaries.json', JSON.stringify(state.registry))
  expect(state.retire(base).ok).toBe(false)
}, 30_000)

it('retains declared runtime evidence from either snapshot', () => {
  for (const existing of [false, true]) {
    const state = packageFixture()
    state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [state.test] }))
    let base = state.base
    if (existing) {
      state.git('add', '.')
      state.git('commit', '-qm', 'base runtime relationship')
      base = state.git('rev-parse', 'HEAD')
      state.put('scripts/ci/module-runtime-consumers.json', '{}')
    }
    expect(state.retire(base).ok).toBe(false)
  }
}, 30_000)

it('retains package evidence if its own test registration is removed', () => {
  const state = packageFixture()
  const independent = (
    state.manifest.modules as Record<string, typeof state.manifest.modules.downstream>
  ).independent
  independent.testFiles.owner = []
  independent.testFiles.contract = [state.test]
  expect(state.retire().ok).toBe(false)
}, 30_000)

it('does not retire excluded package evidence from full or global owners', () => {
  const full = packageFixture()
  full.manifest.modules.upstream.fullTestReason = 'Dynamic consumers'
  expect(full.retire().ok).toBe(false)
  const global = packageFixture()
  global.put('scripts/build.mjs', 'export {}')
  global.manifest.modules.upstream.ownerPaths.push('scripts/build.mjs')
  expect(global.retire().ok).toBe(false)
}, 30_000)

it('retains evidence for selected downstream packages and missing dependency registrations', () => {
  for (const declared of [true, false]) {
    const state = packageFixture()
    const upstreamRoot = 'packages/owner'
    state.put(`${upstreamRoot}/src/index.ts`, 'export const value = 1')
    state.put(
      `${upstreamRoot}/package.json`,
      JSON.stringify({
        name: '@example/owner',
        scripts: { test: 'vitest run' },
        exports: { '.': { default: './dist/index.js' } }
      })
    )
    state.put(
      'packages/independent/package.json',
      JSON.stringify({
        name: '@example/independent',
        scripts: { test: 'vitest run' },
        dependencies: { '@example/owner': '1.0.0' },
        exports: { '.': { default: './dist/index.js' } }
      })
    )
    state.registry.packages.push({ root: upstreamRoot, dependencies: [] })
    if (declared) state.registry.packages[0].dependencies.push(upstreamRoot)
    state.put('scripts/ci/package-test-boundaries.json', JSON.stringify(state.registry))
    state.manifest.modules.upstream.ownerPaths.push(
      `${upstreamRoot}/src/index.ts`,
      `${upstreamRoot}/package.json`
    )
    state.save()
    state.git('add', '.')
    state.git('commit', '-qm', 'real package dependency')
    expect(state.retire(state.git('rev-parse', 'HEAD')).ok).toBe(false)
  }
}, 30_000)

it.each([
  ["import { builtinModules } from 'node:module'; builtinModules.includes('fs')", true],
  ["import * as moduleApi from 'node:module'; moduleApi.builtinModules.includes('fs')", true],
  ["import { isBuiltin as checkBuiltin } from 'node:module'; checkBuiltin('fs')", true],
  ["import Module = require('node:module'); Module.builtinModules.includes('fs')", true],
  ["import { createRequire } from 'node:module'", true],
  ["import { expect } from 'vitest'; expect.any(Function)", true],
  ['type Callback = Function; interface API { handler: Function }', true],
  ["const config = { module: 'commonjs' }; config.module", true],
  [
    "import { createRequire as require } from 'node:module'; const load = require(import.meta.url)",
    false
  ],
  [
    "import * as moduleApi from 'node:module'; const load = moduleApi.createRequire(import.meta.url)",
    false
  ],
  ["import { register as hook } from 'node:module'; hook('./owner', import.meta.url)", false],
  ["import Module from 'node:module'; Module._load('./owner')", false],
  ["import { Module as Loader } from 'node:module'; Loader._load('./owner')", false],
  ["import { _load as load } from 'node:module'; load('./owner')", false],
  ["import * as modules from 'node:module'; modules.Module.prototype.require('./owner')", false],
  ["import * as modules from 'node:module'; modules['_load']('./owner')", false],
  ["import Module = require('node:module'); Module._load('./owner')", false],
  ["import Module = require('module'); Module['_load']('./owner')", false],
  ["export { createRequire } from 'node:module'", false],
  ["export * from 'node:module'", false],
  ["module.constructor._load('./owner')", false],
  ["module['constructor']['_load']('./owner')", false],
  ["const loader = module; loader.constructor._load('./owner')", false],
  ["process.getBuiltinModule('module')._load('./owner')", false],
  ["process['getBuiltinModule']('module')._load('./owner')", false],
  ["const { getBuiltinModule: load } = process; load('module')._load('./owner')", false],
  ["process.mainModule.constructor._load('./owner')", false],
  [
    "import Module from 'node:module'; const api = Module; api.createRequire(import.meta.url)",
    false
  ],
  ["const load = require; load('./owner')", false],
  ['const Evaluate = Function; Evaluate(source)()', false]
])('distinguishes loader use from harmless module/type references: %s', (text, complete) => {
  const source = new Map([[consumer, text as string]])
  const inspect = createConsumerDependencyReader(
    { files: new Set(source.keys()), read: (path: string) => source.get(path) },
    []
  )
  expect(inspect(consumer, new Set()).complete).toBe(complete)
})

function dependencyFixture(
  options: { consumerSource?: string; ownerSource?: string; runtime?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-consumers-'))
  roots.push(root)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const put = (path: string, value: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  const source = 'src/shared/fuzzy-match.ts'
  const test = 'src/main/consumer.test.ts'
  const contract = 'src/shared/contract.test.ts'
  const registration = (paths: string[], tests: string[]) => ({
    ownerPaths: paths,
    interfacePaths: [paths[0]],
    consumerModules: [] as string[],
    testFiles: { owner: tests, contract: [] as string[], consumer: [] as string[] },
    capabilityOverlays: [] as string[],
    fallbackCapability: 'main_runtime',
    fullTestReason: undefined as string | undefined
  })
  const manifest = {
    schemaVersion: 1,
    modules: {
      shared_fuzzy_match: {
        ...registration([source], []),
        consumerModules: ['desktop_composition'],
        testFiles: { owner: [], contract: [contract], consumer: [test] }
      },
      desktop_composition: {
        ...registration([test, contract], [test, contract]),
        capabilityOverlays: ['windows_sensitive']
      }
    }
  }
  const save = (): void => put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  const commit = (): string => {
    save()
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  put(source, options.ownerSource ?? 'export const value = 1')
  put(test, options.consumerSource ?? 'fetch(dynamicUrl)')
  put(contract, 'export {}')
  put(
    'scripts/ci/module-runtime-consumers.json',
    JSON.stringify(options.runtime ? { [source]: [test] } : {})
  )
  const base = commit()
  const inspect = (): ReturnType<typeof moduleOwnershipFromRevisions> =>
    moduleOwnershipFromRevisions(base, commit(), { cwd: root })
  return { manifest, put, inspect, source, test, contract }
}

it('replaces opaque inherited history only for the reviewed dependency model and retains independent ownership', () => {
  const f = dependencyFixture()
  f.manifest.modules.shared_fuzzy_match.testFiles.consumer = []
  const result = f.inspect()
  expect(result).toMatchObject({
    ok: true,
    retiredConsumers: [],
    dependencyBasedRetirements: [`shared_fuzzy_match:${f.test}`]
  })
  expect(f.manifest.modules.desktop_composition.testFiles.owner).toContain(f.test)
}, 30_000)

it.each([
  "import '../shared/fuzzy-match'",
  "import type { value } from '../shared/fuzzy-match'; fetch(dynamicUrl)",
  "vi.mock('../shared/fuzzy-match'); fetch(dynamicUrl)",
  "await import('../shared/fuzzy-match'); fetch(dynamicUrl)"
])(
  'keeps known graph evidence even in an opaque consumer cone: %s',
  (consumerSource) => {
    const f = dependencyFixture({ consumerSource })
    f.manifest.modules.shared_fuzzy_match.testFiles.consumer = []
    expect(f.inspect().ok).toBe(false)
  },
  30_000
)

it('keeps explicitly registered runtime consumers under the dependency model', () => {
  const f = dependencyFixture({ runtime: true })
  f.manifest.modules.shared_fuzzy_match.testFiles.consumer = []
  expect(f.inspect().ok).toBe(false)
}, 30_000)

it.each(['source', 'contract', 'owner', 'capability', 'module-edge', 'runtime', 'policy'])(
  'rejects a dependency-model cleanup mixed with %s changes',
  (change) => {
    const f = dependencyFixture()
    const module = f.manifest.modules.shared_fuzzy_match
    module.testFiles.consumer = []
    if (change === 'source') f.put(f.source, 'export const value = 2')
    if (change === 'contract') {
      module.testFiles.contract = []
      module.testFiles.consumer = [f.contract]
    }
    if (change === 'owner') f.manifest.modules.desktop_composition.testFiles.owner = [f.contract]
    if (change === 'capability') f.manifest.modules.desktop_composition.capabilityOverlays = []
    if (change === 'module-edge') module.consumerModules = []
    if (change === 'runtime')
      f.put('scripts/ci/module-runtime-consumers.json', '{"src/shared/fuzzy-match.ts":[]}')
    if (change === 'policy')
      f.put('scripts/ci/consumer-retirement.mjs', 'export const bypass = true')
    expect(f.inspect().ok).toBe(false)
  },
  30_000
)

it.each([
  "import { readFileSync } from 'node:fs'; export const value = readFileSync(dynamicPath)",
  'export const value = fetch(dynamicUrl)',
  'export const value = import(dynamicPath)',
  "import './missing'; export const value = 1"
])(
  'requires full validation when a reviewed owner acquires opaque runtime inputs: %s',
  (ownerSource) => {
    const f = dependencyFixture()
    f.put(f.source, ownerSource)
    expect(f.inspect().violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'dependency-consumer-boundary' })])
    )
  },
  30_000
)

it('permits deliberate full-validation reclassification while preserving existing contracts', () => {
  const f = dependencyFixture()
  f.put(f.source, 'export const value = fetch(dynamicUrl)')
  f.manifest.modules.shared_fuzzy_match.fullTestReason =
    'Runtime boundary requires reclassification'
  expect(f.inspect().ok).toBe(true)
}, 30_000)

it.each(['copied-consumer', 'new-module-edge', 'expanded-owner'])(
  'rejects source-derived boundary regression: %s',
  (change) => {
    const f = dependencyFixture()
    const module = f.manifest.modules.shared_fuzzy_match
    if (change === 'copied-consumer') {
      f.put('src/main/new.test.ts', 'fetch(dynamicUrl)')
      module.testFiles.consumer.push('src/main/new.test.ts')
      f.manifest.modules.desktop_composition.ownerPaths.push('src/main/new.test.ts')
      f.manifest.modules.desktop_composition.testFiles.owner.push('src/main/new.test.ts')
    }
    if (change === 'new-module-edge') {
      module.consumerModules = ['desktop_composition', 'unreviewed']
      f.put('src/main/unreviewed.ts', 'export {}')
      Object.assign(f.manifest.modules, {
        unreviewed: {
          ...f.manifest.modules.desktop_composition,
          ownerPaths: ['src/main/unreviewed.ts']
        }
      })
    }
    if (change === 'expanded-owner') {
      f.put('src/shared/expanded.ts', 'export const value = 1')
      module.ownerPaths.push('src/shared/expanded.ts')
    }
    expect(f.inspect().violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'dependency-consumer-boundary' })])
    )
  },
  30_000
)

it('admits new consumers with registered runtime evidence', () => {
  const f = dependencyFixture()
  const added = 'src/main/new.test.ts'
  f.put(added, 'fetch(dynamicUrl)')
  f.manifest.modules.desktop_composition.ownerPaths.push(added)
  f.manifest.modules.desktop_composition.testFiles.owner.push(added)
  f.manifest.modules.shared_fuzzy_match.testFiles.consumer.push(added)
  f.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [f.source]: [added] }))
  expect(f.inspect().ok).toBe(true)
}, 30_000)

it.each([
  ['reviewed transport', "import WebSocket from 'ws'", true],
  ['pinned consumer', "import WebSocket from 'ws'", true],
  ['computed loader', 'import(target)', false],
  ['new external effect', "import {readFileSync} from 'node:fs'", false],
  ['reverse type import', "import type {Value} from './settings/backend-resolver'", false],
  ['missing contract', "import WebSocket from 'ws'", false],
  ['missing contract file', "import WebSocket from 'ws'", false]
])('validates stateful boundaries with layers and contracts: %s', (scenario, text, valid) => {
  const id = 'host_websocket_transport'
  const boundary = dependencyConsumerBoundaries[id]
  const contents = new Map([
    ...boundary.sources.map((path: string) => [path, text] as [string, string]),
    ...boundary.requiredTests.map((path: string) => [path, 'export {}'] as [string, string]),
    ['src/main/settings/backend-resolver.ts', 'export type Value = string']
  ])
  const module = {
    ownerPaths: boundary.sources,
    consumerModules: boundary.consumerModules,
    testFiles: { owner: [], contract: [...boundary.requiredTests], consumer: [] as string[] }
  }
  if (scenario === 'pinned consumer')
    module.testFiles.consumer.push(module.testFiles.contract.pop()!)
  if (scenario === 'missing contract') module.testFiles.contract.pop()
  if (scenario === 'missing contract file') contents.delete(boundary.requiredTests[0])
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  expect(dependencyBoundaryViolations(source, { modules: { [id]: module } }).length === 0).toBe(
    valid
  )
})

it.each([
  ["const load = createRequire(import.meta.url); load('./owner')", true],
  ["const require = createRequire(import.meta.url); require('./owner')", true],
  ['const require = createRequire(import.meta.url); require(target)', false],
  ['const require = createRequire(import.meta.url); consume(require)', false],
  ["createRequire(import.meta.url)('./owner')", true],
  ["const load = createRequire(import.meta.url); load.resolve('./owner')", true],
  ["process.getBuiltinModule('node:sqlite')", true],
  ['const load = createRequire(import.meta.url); load(target)', false],
  [
    "const load = createRequire(import.meta.url); load.resolve('./owner', {paths: [directory]})",
    false
  ],
  ['const load = createRequire(import.meta.url); consume(load)', false],
  ["const load = createRequire(import.meta.url); load('./owner', load)", false],
  ['export const load = createRequire(import.meta.url)', false],
  [
    "export const load = createRequire(import.meta.url); function local() {const load = createRequire(import.meta.url); return load('./owner')}",
    false
  ],
  ["[process] = injected; process.getBuiltinModule('node:sqlite')", false],
  ["process['get'+'BuiltinModule'] = injected; process.getBuiltinModule('node:sqlite')", false],
  ['const load = createRequire(import.meta.url); export {load}', false],
  ['const load = createRequire(import.meta.url); function nested(load) { load(target) }', false],
  ["function nested(process) { return process.getBuiltinModule('node:sqlite') }", false],
  ["import process from './owner'; process.getBuiltinModule('node:sqlite')", false],
  ["import * as process from './owner'; process.getBuiltinModule('node:sqlite')", false],
  ["const {process} = injected; process.getBuiltinModule('node:sqlite')", false],
  ["process = injected; process.getBuiltinModule('node:sqlite')", false],
  ["process.getBuiltinModule('node:module')._load(target)", false],
  ["createRequire(otherUrl)('./owner')", false]
])('keeps reviewed literal loaders bounded: %s', (body, complete) => {
  const contents = new Map([
    ['src/consumer.ts', `import {createRequire} from 'node:module'; ${body}`],
    ['src/owner.ts', 'export const value = 1']
  ])
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  const inspect = createConsumerDependencyReader(source, [], {
    runtimeOnly: true,
    literalLoaders: true,
    externalImports: ['node:module', 'node:sqlite']
  })
  expect(inspect.dependencies('src/consumer.ts').complete).toBe(complete)
  if (complete && body.includes("'./owner'"))
    expect(inspect.dependencies('src/consumer.ts').paths.has('src/owner.ts')).toBe(true)
  // Opt-in completeness must never leak into the default retirement proof.
  expect(createConsumerDependencyReader(source, []).dependencies('src/consumer.ts').complete).toBe(
    false
  )
})

it.each(['node:fs/promises', 'node:child_process', 'react'])(
  'rejects high-layer external imports in mixed-owner policy files: %s',
  (specifier) => {
    const boundary = dependencyConsumerBoundaries.main_connectors
    const contents = new Map([
      ...boundary.sources.map((path: string) => [path, 'export {}'] as [string, string]),
      ...boundary.requiredTests.map((path: string) => [path, 'export {}'] as [string, string])
    ])
    contents.set(
      'src/main/connectors/catalog.ts',
      `import * as dependency from '${specifier}'; export {dependency}`
    )
    const module = {
      ownerPaths: boundary.sources,
      interfacePaths: boundary.sources,
      consumerModules: boundary.consumerModules,
      testFiles: { owner: [], contract: boundary.requiredTests, consumer: [] }
    }
    const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
    expect(dependencyBoundaryViolations(source, { modules: { main_connectors: module } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'dependency-consumer-boundary' })])
    )
  }
)

it.each([
  ['function view(document: {title: string}) { return document.title }', true],
  ['function view(document) { return {document} }', true],
  ['function view() { return {document} }', false],
  ['function view(input) { const [module] = input; return module.value }', true],
  ['function view(input) { const document = input; return document.title }', true],
  ['function view(input) { for (const document of input) return document.title }', true],
  ['function view(input) { return input.document }', true],
  ['function view() { return document.title }', false],
  ['export class View { [document.title](document: string) { return document } }', false],
  ['function view(document) { return globalThis.document.title }', false],
  ['export const run = () => global.fetch(url)', false],
  ['export const run = () => global.process.exit(1)', false],
  ['export const run = () => global.document.title', false],
  ['export const run = () => top.fetch(url)', false],
  ["export const run = () => top.document.createElement('iframe')", false],
  ['export const run = () => parent.document.cookie', false],
  ['export const run = () => frames.document', false],
  ['function view(document = globalThis.document) { return document.title }', false],
  ['function view(module) { return module.value }', true],
  ['function view(module) { return module.require(target) }', false],
  ['function view() { return module.require(target) }', false],
  ['class Loader { load(target) { return this.require(target) } }', false],
  ['function view() { return import(target) }', false]
])('uses lexical evidence only in reviewed selection: %s', (text, complete) => {
  const contents = new Map([['src/consumer.ts', text]])
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  const options = { staticOnly: true, runtimeOnly: true }
  expect(
    createConsumerDependencyReader(source, [], {
      ...options,
      reviewedSyntax: true
    }).dependencies('src/consumer.ts').complete
  ).toBe(complete)
  // The stronger independent-history proof does not acquire these opt-ins.
  expect(
    createConsumerDependencyReader(source, [], options).dependencies('src/consumer.ts').complete
  ).toBe(false)
})

it.each(['css', 'md?raw', 'html?raw'])(
  'keeps reviewed %s edges while independent-history evidence stays opaque',
  (suffix) => {
    const asset = `src/view.${suffix.split('?')[0]}`
    const contents = new Map([
      ['src/view.ts', `import './view.${suffix}'`],
      [asset, '@import "unknown.css"']
    ])
    const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
    const reviewed = createConsumerDependencyReader(source, [], {
      runtimeOnly: true,
      resourceImports: [asset]
    }).dependencies('src/view.ts')
    expect(reviewed.complete).toBe(true)
    expect([...reviewed.paths]).toEqual([asset])
    expect(createConsumerDependencyReader(source, []).dependencies('src/view.ts').complete).toBe(
      false
    )
    expect(
      createConsumerDependencyReader(source, [], {
        runtimeOnly: true,
        resourceImports: ['src/other.css']
      }).dependencies('src/view.ts').complete
    ).toBe(false)
  }
)

it.each([
  'complete',
  'missing-test',
  'missing-resource',
  'new-resource',
  'executable-resource',
  'unreviewed-import'
])('requires exact resource ownership and pinned behavior coverage: %s', (scenario) => {
  const id = 'reviewed_resource_fixture'
  const boundary = {
    sources: ['src/renderer/view.ts'],
    resourcePaths: ['src/renderer/view.css'],
    resourceImports: ['src/renderer/view.css'],
    resourceTests: ['src/renderer/view.test.ts'],
    requiredTests: ['src/renderer/view.test.ts'],
    layer: 'presentation-adapter',
    consumerModules: [],
    externalImports: []
  }
  const contents = new Map([
    ['src/renderer/view.ts', "import './view.css'"],
    ['src/renderer/view.css', 'body {}'],
    ['src/renderer/view.test.ts', 'export {}'],
    ['src/renderer/new.css', 'body {}'],
    ['src/renderer/hidden.ts', 'import(target)']
  ])
  const module = {
    ownerPaths: [...boundary.sources, ...boundary.resourcePaths],
    interfacePaths: boundary.sources,
    consumerModules: [],
    testFiles: { owner: [...boundary.requiredTests], contract: [], consumer: [] }
  }
  if (scenario === 'missing-test') module.testFiles.owner = []
  if (scenario === 'missing-resource') contents.delete('src/renderer/view.css')
  if (scenario === 'new-resource') module.ownerPaths.push('src/renderer/new.css')
  if (scenario === 'executable-resource') {
    module.ownerPaths.push('src/renderer/hidden.ts')
    boundary.resourcePaths.push('src/renderer/hidden.ts')
  }
  if (scenario === 'unreviewed-import') contents.set('src/renderer/view.ts', "import './new.css'")
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  dependencyConsumerBoundaries[id] = boundary
  try {
    expect(dependencyBoundaryViolations(source, { modules: { [id]: module } }).length === 0).toBe(
      scenario === 'complete'
    )
  } finally {
    delete dependencyConsumerBoundaries[id]
  }
})
