import {
  createConsumerDependencyReader,
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
  ["import { createRequire } from 'node:module'", true],
  ["import { expect } from 'vitest'; expect.any(Function)", true],
  ['type Callback = Function; interface API { handler: Function }', true],
  [
    "import { createRequire as require } from 'node:module'; const load = require(import.meta.url)",
    false
  ],
  [
    "import * as moduleApi from 'node:module'; const load = moduleApi.createRequire(import.meta.url)",
    false
  ],
  ["import { register as hook } from 'node:module'; hook('./owner', import.meta.url)", false],
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
