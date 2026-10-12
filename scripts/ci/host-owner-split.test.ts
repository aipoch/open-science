/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const leaf = 'src/main/leaf.ts'
const leafTest = 'src/main/leaf.test.ts'
const app = 'src/main/app.ts'
const appTest = 'src/main/app.test.ts'
const contract = 'src/main/contract.test.ts'
const consumer = 'src/main/consumer.test.ts'
const uncertain = 'src/main/uncertain.test.ts'
const unrelated = 'src/main/unrelated.test.ts'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'host-owner-split-'))
  roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const module = (ownerPaths: string[], ownerTests: string[]) => ({
    ownerPaths,
    interfacePaths: [ownerPaths[0]],
    testFiles: { owner: ownerTests, contract: [] as string[], consumer: [] as string[] },
    consumerModules: [] as string[],
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapability: 'main_runtime'
  })
  const manifest = {
    schemaVersion: 1,
    modules: {
      host: module([leaf, leafTest, app, appTest, contract], [leafTest, appTest]),
      consumers: module([consumer, uncertain, unrelated], [consumer, uncertain, unrelated])
    } as Record<string, ReturnType<typeof module> & { fullTestReason?: string }>
  }
  manifest.modules.host.testFiles.contract = [contract]
  manifest.modules.host.consumerModules = ['consumers']
  const save = () => put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  put(leaf, 'export const value = 1')
  put(app, "export { value } from './leaf'")
  put(leafTest, "import './leaf'")
  put(appTest, "import './app'")
  put(contract, 'export {}')
  put(consumer, "import './leaf'")
  put(uncertain, "import { readFileSync } from 'node:fs'; readFileSync('runtime-input')")
  put(unrelated, 'export {}')
  put('scripts/ci/module-runtime-consumers.json', '{}')
  save()
  const base = commit()
  const split = () => {
    manifest.modules.foundation = module([leaf, leafTest], [leafTest])
    manifest.modules.foundation.consumerModules = ['consumers']
    manifest.modules.foundation.testFiles.contract = [contract]
    manifest.modules.foundation.testFiles.consumer = [appTest, consumer, uncertain]
    manifest.modules.host.ownerPaths = [app, appTest, contract]
    manifest.modules.host.interfacePaths = [app]
    manifest.modules.host.testFiles.owner = [appTest]
    save()
  }
  const check = (revision = base) => {
    save()
    return moduleOwnershipFromRevisions(revision, commit(), { cwd })
  }
  return { cwd, git, put, commit, manifest, save, base, split, check }
}

it('permits unchanged host owners to split while preserving reachable, uncertain and explicit evidence', () => {
  const state = fixture()
  state.split()
  const result = state.check()
  expect(result.ok).toBe(true)
  expect(result.boundedOwnerSplits).toEqual([`host:${leaf}`, `host:${leafTest}`])
  expect(state.manifest.modules.foundation.testFiles.consumer).not.toContain(unrelated)
})

it.each(['source', 'runtime', 'policy', 'rename', 'test'])(
  'rejects a split combined with %s changes',
  (kind) => {
    const state = fixture()
    state.split()
    if (kind === 'source') state.put(leaf, 'export const value = 2')
    if (kind === 'runtime')
      state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [leaf]: [unrelated] }))
    if (kind === 'policy')
      state.put('scripts/ci/host-owner-split.mjs', 'throw Error("candidate execution")')
    if (kind === 'rename') {
      state.git('mv', leaf, 'src/main/renamed.ts')
      state.manifest.modules.foundation.ownerPaths = ['src/main/renamed.ts', leafTest]
      state.manifest.modules.foundation.interfacePaths = ['src/main/renamed.ts']
    }
    if (kind === 'test') state.put(consumer, 'export {}')
    const result = state.check()
    expect(result.ok).toBe(false)
    expect(result.boundedOwnerSplits).toEqual([])
  }
)

it.each([
  'reachable',
  'uncertain',
  'contract',
  'owner',
  'overlay',
  'fallback',
  'consumers',
  'interface'
])('rejects lost %s evidence on the extracted owner', (kind) => {
  const state = fixture()
  state.split()
  const target = state.manifest.modules.foundation
  if (kind === 'reachable') target.testFiles.consumer = [appTest, uncertain]
  if (kind === 'uncertain') target.testFiles.consumer = [appTest, consumer]
  if (kind === 'contract') target.testFiles.contract = []
  if (kind === 'owner') {
    target.testFiles.owner = []
    target.testFiles.consumer.push(leafTest)
  }
  if (kind === 'overlay') target.capabilityOverlays = []
  if (kind === 'fallback') target.fallbackCapability = 'windows_sensitive'
  if (kind === 'consumers') target.consumerModules = []
  if (kind === 'interface') target.interfacePaths = [leafTest]
  const result = state.check()
  expect(result.ok).toBe(false)
  expect(result.boundedOwnerSplits).toEqual([])
})

it('retains the old owner contracts and unrelated evidence through ordinary registration checks', () => {
  const state = fixture()
  state.split()
  state.manifest.modules.host.testFiles.contract = []
  expect(state.check().ok).toBe(false)
})

it('requires moved owner tests that still reach the old owner to remain as evidence there', () => {
  const state = fixture()
  state.put(leafTest, "import './leaf'; import './app'")
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.host.testFiles.consumer = [leafTest]
  expect(state.check(base).ok).toBe(true)
})

it('retains non-host contracts even when static imports cannot explain them', () => {
  const state = fixture()
  const test = 'packages/example/contract.test.ts'
  state.put(test, 'export {}')
  state.manifest.modules.external = {
    ...state.manifest.modules.consumers,
    ownerPaths: [test],
    interfacePaths: [test],
    testFiles: { owner: [test], contract: [], consumer: [] }
  }
  state.manifest.modules.host.testFiles.consumer.push(test)
  state.save()
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(test)
  expect(state.check(base).ok).toBe(true)
})

it('preserves declared runtime and type-only consumers', () => {
  const state = fixture()
  state.put(consumer, "import type { Value } from './leaf'")
  state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [leaf]: [unrelated] }))
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(unrelated)
  expect(state.check(base).ok).toBe(true)
  state.manifest.modules.foundation.testFiles.consumer = [appTest, uncertain, unrelated]
  expect(state.check(base).ok).toBe(false)
})

it('does not authorize shared/full owners or transfers to an existing module', () => {
  const state = fixture()
  state.manifest.modules.host.fullTestReason = 'Cross-process runtime'
  state.save()
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  const existing = fixture()
  existing.manifest.modules.foundation = {
    ...existing.manifest.modules.consumers,
    ownerPaths: ['src/main/other.ts'],
    interfacePaths: ['src/main/other.ts']
  }
  existing.put('src/main/other.ts', 'export {}')
  existing.save()
  const old = existing.commit()
  existing.split()
  expect(existing.check(old).ok).toBe(false)
})

it('preserves explicitly registered host consumers with no static source path', () => {
  const state = fixture()
  state.manifest.modules.host.testFiles.consumer = [unrelated]
  state.save()
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(unrelated)
  expect(state.check(base).ok).toBe(true)
})

it('rejects a target assembled from multiple original owners', () => {
  const state = fixture()
  state.split()
  state.manifest.modules.foundation.ownerPaths.push(unrelated)
  state.manifest.modules.foundation.testFiles.owner.push(unrelated)
  state.manifest.modules.consumers.ownerPaths = [consumer, uncertain]
  state.manifest.modules.consumers.testFiles.owner = [consumer, uncertain]
  expect(state.check().ok).toBe(false)
})

it('rejects shared source extraction even when its original owner has no full marker', () => {
  const state = fixture()
  const shared = 'src/shared/leaf.ts'
  mkdirSync(join(state.cwd, 'src/shared'), { recursive: true })
  state.git('mv', leaf, shared)
  state.manifest.modules.host.ownerPaths = state.manifest.modules.host.ownerPaths.map((path) =>
    path === leaf ? shared : path
  )
  state.manifest.modules.host.interfacePaths = [shared]
  state.put(leafTest, "import '../shared/leaf'")
  state.put(app, "export { value } from '../shared/leaf'")
  state.put(consumer, "import '../shared/leaf'")
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.ownerPaths = [shared, leafTest]
  state.manifest.modules.foundation.interfacePaths = [shared]
  expect(state.check(base).ok).toBe(false)
})

it('allows a consumer to follow a verified extraction while retaining its test coverage', () => {
  const state = fixture()
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.host.testFiles.consumer = []
  const result = state.check(base)
  expect(result.ok).toBe(true)
  expect(result.retiredConsumers).toContain(`host:${consumer}`)
  expect(state.manifest.modules.foundation.testFiles.consumer).toContain(consumer)
})

it.each(['remaining', 'uncertain', 'manual'])(
  'retains %s consumers on the original owner',
  (kind) => {
    const state = fixture()
    if (kind === 'remaining') state.put(consumer, "import './app'")
    if (kind === 'uncertain') state.put(consumer, "process.emit('runtime-input')")
    if (kind === 'manual') state.put(consumer, 'export {}')
    state.manifest.modules.host.testFiles.consumer = [consumer]
    state.save()
    const base = state.commit()
    state.split()
    state.manifest.modules.host.testFiles.consumer = []
    const result = state.check(base)
    expect(result.ok).toBe(false)
    expect(result.retiredConsumers).not.toContain(`host:${consumer}`)
  }
)

it('preserves owner evidence that has no provable source dependency', () => {
  const state = fixture()
  state.put(appTest, 'export {}')
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(appTest)
  expect(state.check(base).ok).toBe(true)
})

it('keeps an unproven moved owner test registered on the remaining owner as well', () => {
  const state = fixture()
  state.put(leafTest, 'export {}')
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.host.testFiles.consumer.push(leafTest)
  expect(state.check(base).ok).toBe(true)
})
