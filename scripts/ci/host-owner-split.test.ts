/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { checkDerivedConsumerRevisions } from './generate-module-derived-consumers.mjs'
import { withDerivedConsumers } from './module-derived-consumers.mjs'

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
const other = 'src/main/other.ts'
const otherTest = 'src/main/other.test.ts'
const otherContract = 'src/main/other-contract.test.ts'

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
  put(uncertain, 'const target = process.env.RUNTIME_MODULE; import(target)')
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

function existingOwnerFixture(prepare?: (state: ReturnType<typeof fixture>) => void) {
  const state = fixture()
  const host = state.manifest.modules.host
  host.interfacePaths.push(app)
  host.testFiles.consumer.push(consumer)
  state.put(other, 'export const other = 1')
  state.put(otherTest, "import './other'")
  state.put(otherContract, 'export {}')
  state.manifest.modules.foundation = {
    ownerPaths: [other, otherTest, otherContract],
    interfacePaths: [other],
    testFiles: { owner: [otherTest], contract: [otherContract], consumer: [leafTest] },
    consumerModules: [],
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapability: 'main_runtime'
  }
  prepare?.(state)
  state.save()
  const baseline = structuredClone(state.manifest)
  const base = state.commit()
  const target = state.manifest.modules.foundation
  host.ownerPaths = host.ownerPaths.filter((path) => ![leaf, leafTest].includes(path))
  target.ownerPaths.push(leaf, leafTest)
  target.interfacePaths.push(leaf)
  target.consumerModules = host.consumerModules.filter((id) => id !== 'foundation')
  // Keep the target's historical consumer classification for leafTest.
  const evidence = new Set(Object.values(target.testFiles).flat())
  target.testFiles.consumer.push(
    ...Object.values(host.testFiles)
      .flat()
      .filter((test) => !evidence.has(test))
  )
  return { ...state, base, baseline, check: () => state.check(base) }
}

it('transfers unchanged paths between existing owners without copying unrelated interfaces or retiring history', () => {
  const state = existingOwnerFixture()
  const result = state.check()
  expect(result.ok).toBe(true)
  expect(result.boundedOwnerSplits).toEqual([`host:${leaf}`, `host:${leafTest}`])
  expect(result.retiredConsumers).toEqual([])
  expect(result.retiredPackageTests).toEqual([])
  const { host, foundation } = state.manifest.modules
  expect(host.interfacePaths).toEqual([leaf, app])
  expect(foundation.interfacePaths).toEqual([other, leaf])
  expect(foundation.testFiles.consumer).toContain(leafTest)
  expect(host.testFiles).toEqual(state.baseline.modules.host.testFiles)
  for (const path of [leaf, leafTest, app, appTest, other, otherTest]) {
    const plan = (manifest: typeof state.manifest) =>
      createAffectedTestPlan(
        [{ path, status: 'modified' }],
        { status: 'not-used', testFiles: [] },
        manifest
      )
    const before = plan(state.baseline)
    const after = plan(state.manifest)
    expect(after.mode).toBe('selective')
    for (const field of ['testFiles', 'capabilityOverlays', 'fallbackCapabilities']) {
      expect(after[field]).toEqual(expect.arrayContaining(before[field]))
    }
  }
})

it.each(['host', 'foundation'])(
  'retains every historical %s test bucket during an existing-owner transfer',
  (id) => {
    for (const kind of ['owner', 'contract', 'consumer'] as const) {
      const state = existingOwnerFixture()
      const tests = state.manifest.modules[id].testFiles
      const removed = tests[kind].shift()!
      // Even retaining the same test in another bucket cannot erase its historical role.
      tests[kind === 'consumer' ? 'owner' : 'consumer'].push(removed)
      const result = state.check()
      expect(result.ok).toBe(false)
      expect(result.boundedOwnerSplits).toEqual([])
    }
  }
)

it('preserves routing when the original owner already consumes the destination', () => {
  const state = existingOwnerFixture((state) => {
    state.manifest.modules.host.consumerModules.push('foundation')
  })
  expect(state.check().ok).toBe(true)
  expect(state.manifest.modules.host.consumerModules).toContain('foundation')
  expect(state.manifest.modules.foundation.consumerModules).not.toContain('foundation')
})

it('verifies existing-owner transfers from sharded registration snapshots', () => {
  const state = existingOwnerFixture()
  const save = (manifest: typeof state.manifest) => {
    state.put('scripts/ci/module-impact.json', JSON.stringify({ schemaVersion: 1 }))
    for (const [id, module] of Object.entries(manifest.modules)) {
      state.put(`scripts/ci/module-impact/${id}.json`, JSON.stringify(module))
    }
  }
  save(state.baseline)
  const base = state.commit()
  save(state.manifest)
  expect(moduleOwnershipFromRevisions(base, state.commit(), { cwd: state.cwd }).ok).toBe(true)
})

it('rejects incompatible pre-existing owner fallbacks', () => {
  const state = existingOwnerFixture((state) => {
    state.manifest.modules.foundation.fallbackCapability = 'windows_sensitive'
  })
  expect(state.check().ok).toBe(false)
})

it('allows unchanged renderer ownership to follow the same preservation proof', () => {
  const state = existingOwnerFixture((state) => {
    for (const module of Object.values(state.manifest.modules)) {
      for (const field of ['ownerPaths', 'interfacePaths'] as const) {
        module[field] = module[field].map((path) => path.replace('/main/', '/renderer/'))
      }
      for (const kind of ['owner', 'contract', 'consumer'] as const) {
        module.testFiles[kind] = module.testFiles[kind].map((path) =>
          path.replace('/main/', '/renderer/')
        )
      }
    }
    state.git('mv', 'src/main', 'src/renderer')
  })
  // The generic fixture transfers the main paths; replace that candidate with the renderer move.
  const { host, foundation } = state.manifest.modules
  host.ownerPaths = host.ownerPaths.filter(
    (path) => ![leaf, leafTest].map((path) => path.replace('/main/', '/renderer/')).includes(path)
  )
  foundation.ownerPaths = foundation.ownerPaths.map((path) => path.replace('/main/', '/renderer/'))
  foundation.interfacePaths = foundation.interfacePaths.map((path) =>
    path.replace('/main/', '/renderer/')
  )
  expect(state.check().ok).toBe(true)
})

it.each(['host', 'foundation'])(
  'retains %s interfaces, capabilities and fallback during an existing-owner transfer',
  (id) => {
    for (const field of ['interface', 'overlay', 'fallback', 'full']) {
      const state = existingOwnerFixture()
      const module = state.manifest.modules[id]
      if (field === 'interface') module.interfacePaths.shift()
      if (field === 'overlay') module.capabilityOverlays = []
      if (field === 'fallback') module.fallbackCapability = 'windows_sensitive'
      if (field === 'full') module.fullTestReason = 'Requires full validation'
      const result = state.check()
      expect(result.ok).toBe(false)
      expect(result.boundedOwnerSplits).toEqual([])
    }
  }
)

it.each(['owner', 'contract', 'consumer'] as const)(
  'requires the destination to inherit all source %s evidence',
  (kind) => {
    const state = existingOwnerFixture()
    const missing = state.baseline.modules.host.testFiles[kind][0]
    const target = state.manifest.modules.foundation
    for (const bucket of ['owner', 'contract', 'consumer'] as const) {
      target.testFiles[bucket] = target.testFiles[bucket].filter((test) => test !== missing)
    }
    const result = state.check()
    expect(result.ok).toBe(false)
    expect(result.boundedOwnerSplits).toEqual([])
  }
)

it.each(['source', 'destination'])('retains %s consumer routing', (side) => {
  const state = existingOwnerFixture()
  state.manifest.modules[side === 'source' ? 'host' : 'foundation'].consumerModules = []
  expect(state.check().ok).toBe(false)
})

it('retains pre-existing destination consumers even when source consumers are inherited', () => {
  const state = existingOwnerFixture((state) => {
    state.manifest.modules.foundation.consumerModules = ['consumers']
    state.manifest.modules.host.consumerModules = []
  })
  expect(state.check().ok).toBe(false)
})

it('requires the moved public interface and preserves pre-existing destination ownership', () => {
  const missingInterface = existingOwnerFixture()
  missingInterface.manifest.modules.foundation.interfacePaths = [other]
  expect(missingInterface.check().ok).toBe(false)
  const missingOwner = existingOwnerFixture()
  missingOwner.manifest.modules.foundation.ownerPaths =
    missingOwner.manifest.modules.foundation.ownerPaths.filter((path) => path !== other)
  expect(missingOwner.check().ok).toBe(false)
})

it.each(['runtime', 'policy', 'workflow', 'source', 'test', 'delete', 'rename'])(
  'does not use the existing-owner registration proof alongside %s changes',
  (kind) => {
    const state = existingOwnerFixture()
    if (kind === 'runtime') state.put('scripts/ci/module-runtime-consumers.json', '{"extra":[]}')
    if (kind === 'policy')
      state.put('scripts/ci/host-owner-split.mjs', 'throw Error("candidate policy")')
    if (kind === 'workflow') state.put('.github/workflows/ci.yml', 'name: candidate')
    if (kind === 'source') state.put(leaf, 'export const value = 2')
    if (kind === 'test') state.put(leafTest, 'export {}')
    if (kind === 'delete') state.git('rm', unrelated)
    if (kind === 'rename') state.git('mv', unrelated, 'src/main/renamed.test.ts')
    if (kind === 'delete' || kind === 'rename') {
      const module = state.manifest.modules.consumers
      module.ownerPaths = module.ownerPaths.filter((path) => path !== unrelated)
      module.testFiles.owner = module.testFiles.owner.filter((path) => path !== unrelated)
    }
    const result = state.check()
    expect(result.ok).toBe(false)
    expect(result.boundedOwnerSplits).toEqual([])
  }
)

it.each(['host', 'foundation'])('rejects protected %s owners', (id) => {
  for (const path of [
    'src/shared/protected.ts',
    'src/preload/protected.ts',
    'packages/lib/protected.ts'
  ]) {
    const state = existingOwnerFixture((state) => {
      state.put(path, 'export {}')
      state.manifest.modules[id].ownerPaths.push(path)
    })
    expect(state.check().ok).toBe(false)
  }
  const full = existingOwnerFixture((state) => {
    state.manifest.modules[id].fullTestReason = 'Requires full validation'
  })
  expect(full.check().ok).toBe(false)
})

it('rejects duplicate owners and candidate transfer flags before granting exceptions', () => {
  const duplicate = existingOwnerFixture()
  duplicate.manifest.modules.consumers.ownerPaths.push(leaf)
  expect(() => duplicate.check()).toThrow('is shared')
  const flag = existingOwnerFixture()
  Object.assign(flag.manifest.modules.foundation, { allowTransfer: true })
  expect(flag.check().ok).toBe(false)
})

it('rejects a lost transitive test even when the replacement plan has as many tests', () => {
  const state = existingOwnerFixture()
  // Foundation retains host's direct evidence and consumer edge, but the transitive
  // consumer loses one historical test and replaces it with a different one.
  state.manifest.modules.consumers.testFiles.owner =
    state.manifest.modules.consumers.testFiles.owner.filter((path) => path !== unrelated)
  state.manifest.modules.consumers.testFiles.consumer.push(otherTest)
  const plan = (manifest: typeof state.manifest) =>
    createAffectedTestPlan(
      [{ path: leaf, status: 'modified' }],
      { status: 'not-used', testFiles: [] },
      manifest
    )
  expect(plan(state.manifest).testFiles.length).toBeGreaterThanOrEqual(
    plan(state.baseline).testFiles.length
  )
  const result = state.check()
  expect(result.ok).toBe(false)
  expect(result.boundedOwnerSplits).toEqual([])
})

it('preserves effective coverage when an unchanged valid derived index leaves evidence on the original owner', () => {
  const derivedTest = 'src/main/derived.test.ts'
  const index = { schemaVersion: 1, modules: { host: [derivedTest] } }
  const state = existingOwnerFixture((state) => {
    state.put(derivedTest, "import './app'")
    state.put('scripts/ci/module-derived-consumers.json', JSON.stringify(index))
    // Remove unrelated dependency edges so this is the complete generated index.
    state.put(app, 'export const app = 1')
    state.put(consumer, 'export {}')
    state.manifest.modules.host.consumerModules = []
  })
  // Retain leafTest ownership so this reproduces a production-source-only transfer.
  state.manifest.modules.host.ownerPaths.push(leafTest)
  state.manifest.modules.foundation.ownerPaths =
    state.manifest.modules.foundation.ownerPaths.filter((path) => path !== leafTest)
  const plan = (manifest: typeof state.manifest) =>
    createAffectedTestPlan(
      [{ path: leaf, status: 'modified' }],
      { status: 'not-used', testFiles: [] },
      withDerivedConsumers(manifest, index)
    )
  const before = plan(state.baseline)
  const after = plan(state.manifest)
  expect(before.testFiles).toContain(derivedTest)
  expect(after.testFiles).not.toContain(derivedTest)
  expect(after.testFiles.length).toBeGreaterThanOrEqual(before.testFiles.length)
  const rejected = state.check()
  // Regeneration alone does not fix it: the derived test still imports the remaining app.
  expect(() => checkDerivedConsumerRevisions(state.base, 'HEAD', state.cwd)).not.toThrow()
  expect(rejected.ok).toBe(false)
  expect(rejected.boundedOwnerSplits).toEqual([])
  state.manifest.modules.foundation.testFiles.consumer.push(derivedTest)
  expect(state.check().ok).toBe(true)
  expect(plan(state.manifest).testFiles).toEqual(expect.arrayContaining(before.testFiles))
})

it('permits unchanged host owners to split while preserving reachable, uncertain and explicit evidence', () => {
  const state = fixture()
  state.split()
  const result = state.check()
  expect(result.ok).toBe(true)
  expect(result.boundedOwnerSplits).toEqual([`host:${leaf}`, `host:${leafTest}`])
  expect(state.manifest.modules.foundation.testFiles.consumer).not.toContain(unrelated)
})

it.each(['runtime', 'policy', 'rename', 'test'])(
  'rejects a split combined with %s changes',
  (kind) => {
    const state = fixture()
    state.split()
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

it.each(['src/shared/contract.ts', 'src/preload/bridge.ts', 'packages/example/src/index.ts'])(
  'rejects original owners mixing host and protected source: %s',
  (path) => {
    const state = fixture()
    state.put(path, 'export {}')
    state.manifest.modules.host.ownerPaths.push(path)
    state.save()
    const base = state.commit()
    state.split()
    state.manifest.modules.host.ownerPaths.push(path)
    expect(state.check(base).ok).toBe(false)
  }
)

it('permits host build and test harness paths to remain on the original owner', () => {
  const state = fixture()
  const paths = ['scripts/build-host.mjs', 'test/runtime-host.ts', 'build/runtime.json']
  for (const path of paths) state.put(path, path.endsWith('.json') ? '{}' : 'export {}')
  state.manifest.modules.host.ownerPaths.push(...paths)
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.host.ownerPaths.push(...paths)
  expect(state.check(base).ok).toBe(true)
})

it('rejects a split that adds a full marker to the remaining owner', () => {
  const state = fixture()
  state.split()
  state.manifest.modules.host.fullTestReason = 'New full owner'
  expect(state.check().ok).toBe(false)
})

it('validates malformed new modules before invoking ownership exception helpers', () => {
  const state = fixture()
  state.manifest.modules.foundation = {} as typeof state.manifest.modules.host
  expect(() => state.check()).toThrow('foundation.ownerPaths must be an array of strings')
})

it('rejects a remaining owner that acquires shared source during the split', () => {
  const state = fixture()
  const shared = 'src/shared/existing.ts'
  state.put(shared, 'export {}')
  const base = state.commit()
  state.split()
  state.manifest.modules.host.ownerPaths.push(shared)
  expect(state.check(base).ok).toBe(false)
})

it.each([
  'process.env.HOST_TEST',
  'window.api.readState()',
  "import { readFileSync } from 'node:fs'; readFileSync('runtime-input')",
  "import logger from 'external-logger'; logger.info('host')",
  "import { expect } from 'vitest'; expect.any(Function)",
  'type Callback = Function; const value = {} as Function',
  "import { builtinModules } from 'node:module'; builtinModules.includes('fs')",
  "import * as modules from 'node:module'; modules.builtinModules.includes('fs')",
  "import { createRequire } from 'node:module'"
])('does not treat host facilities as unknown import edges: %s', (facility) => {
  const state = fixture()
  state.put(app, 'export const value = 2')
  state.put(appTest, `import './app'; ${facility}`)
  state.put(consumer, `import './leaf'; ${facility}`)
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
  const result = state.check(base)
  expect(result.ok).toBe(true)
  expect(result.retiredConsumers).not.toContain(`host:${consumer}`)
  expect(state.manifest.modules.host.testFiles.consumer).toContain(consumer)
  expect(state.manifest.modules.host.testFiles.owner).toContain(appTest)
})

it.each([
  "import './missing-local'",
  'const target = process.env.RUNTIME_MODULE; import(target)',
  'require(process.env.RUNTIME_MODULE)',
  "import '@aipoch/missing-package'",
  "const load = require; load('./app')",
  "const load = globalThis.require; load('./app')",
  "const load = globalThis['require']; load('./app')",
  "const key = process.env.LOADER; globalThis[key]('./app')",
  "import { createRequire as factory } from 'node:module'; const load = factory(import.meta.url); load('./app')",
  'eval("require(\'./app\')")',
  'new Function("return import(\'./app\')")()'
])('retains opaque dependency evidence even with a known source import: %s', (opaque) => {
  const state = fixture()
  state.put(consumer, `import './leaf'; ${opaque}`)
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.host.testFiles.consumer = []
  const result = state.check(base)
  expect(result.ok).toBe(false)
  expect(result.retiredConsumers).not.toContain(`host:${consumer}`)
})

it('retains filesystem and IPC contracts without a provable old source import', () => {
  const state = fixture()
  state.put(
    consumer,
    "import { readFileSync } from 'node:fs'; readFileSync('src/main/leaf.ts'); window.api.readState()"
  )
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.testFiles.consumer = [appTest, uncertain]
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(consumer)
  state.manifest.modules.host.testFiles.consumer = []
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.host.testFiles.consumer = [consumer]
  expect(state.check(base).ok).toBe(true)
})

it('requires declared runtime consumers even when their imports reach a different owner', () => {
  const state = fixture()
  state.put(app, 'export const value = 2')
  state.put(consumer, "import './app'; window.api.readState()")
  state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [leaf]: [consumer] }))
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.testFiles.consumer = [uncertain]
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(consumer)
  expect(state.check(base).ok).toBe(true)
})

it.each([
  "const load = require; load('./leaf')",
  "import Module from 'node:module'; Module._load('./leaf')",
  "import { Module as Loader } from 'node:module'; Loader._load('./leaf')",
  "import * as modules from 'node:module'; modules.Module.prototype.require('./leaf')",
  "import * as modules from 'node:module'; modules['_load']('./leaf')",
  "import Module = require('node:module'); Module._load('./leaf')",
  "import Module = require('module'); Module['_load']('./leaf')",
  "export { createRequire } from 'node:module'",
  "export * from 'node:module'",
  "module.constructor._load('./leaf')",
  "module['constructor']['_load']('./leaf')",
  "const loader = module; loader.constructor._load('./leaf')",
  "process.getBuiltinModule('module')._load('./leaf')",
  "process['getBuiltinModule']('module')._load('./leaf')",
  "const { getBuiltinModule: load } = process; load('module')._load('./leaf')",
  "process.mainModule.constructor._load('./leaf')"
])('retains indirect loading when selecting the extracted owner evidence: %s', (loader) => {
  const state = fixture()
  state.put(app, 'export const value = 2')
  state.put(consumer, `import './app'; ${loader}`)
  const base = state.commit()
  state.split()
  state.manifest.modules.foundation.testFiles.consumer = [uncertain]
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(consumer)
  expect(state.check(base).ok).toBe(true)
})

it.each([
  'window.api.readState()',
  "process.emit('host-event')",
  "import { readFileSync } from 'node:fs'; readFileSync('runtime-input')",
  "new Worker('runtime-worker')"
])('keeps old-owner evidence for unresolved host-facility relationships: %s', (facility) => {
  const state = fixture()
  state.put(consumer, `import './leaf'; ${facility}`)
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.manifest.modules.host.testFiles.consumer = []
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.host.testFiles.consumer = [consumer]
  expect(state.check(base).ok).toBe(true)
})

it('keeps a moved owner test on the old owner when it exercises host facilities', () => {
  const state = fixture()
  state.put(leafTest, "import './leaf'; window.api.readState()")
  const base = state.commit()
  state.split()
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.host.testFiles.consumer.push(leafTest)
  expect(state.check(base).ok).toBe(true)
})

function sourceSplit() {
  const state = fixture()
  state.split()
  state.put(leaf, 'export const value = 2')
  return state
}

it('permits source changes with a host split using old and new dependency evidence', () => {
  const state = sourceSplit()
  expect(state.check().ok).toBe(true)
})

it('allows an extracted contract alongside surviving moved paths', () => {
  const state = sourceSplit()
  const extracted = 'src/main/value-contract.ts'
  state.put(extracted, 'export const value = 2')
  state.put(leaf, "export { value } from './value-contract'")
  state.manifest.modules.foundation.ownerPaths.push(extracted)
  expect(state.check().ok).toBe(true)
})

it('requires baseline consumers after source rewiring removes their import path', () => {
  const state = sourceSplit()
  state.put(app, 'export const value = 2')
  state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
  expect(state.check().ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(appTest)
  expect(state.check().ok).toBe(true)
})

it('requires consumers newly reaching an added target source', () => {
  const state = fixture()
  state.put(app, 'export const value = 1')
  const base = state.commit()
  state.split()
  const extracted = 'src/main/value-contract.ts'
  state.put(extracted, 'export const value = 2')
  state.put(app, "export { value } from './value-contract'")
  state.manifest.modules.foundation.ownerPaths.push(extracted)
  state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(appTest)
  expect(state.check(base).ok).toBe(true)
})

it.each(['before', 'after'])(
  'uses explicit dependencies for host facilities in the %s source graph',
  (revision) => {
    const state = fixture()
    state.put(app, revision === 'before' ? 'window.api.readState()' : 'export const value = 1')
    const base = state.commit()
    state.split()
    state.put(app, revision === 'after' ? 'window.api.readState()' : 'export const value = 2')
    state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
    expect(state.check(base).ok).toBe(true)
    state.manifest.modules.foundation.testFiles.consumer.push(appTest)
    expect(state.check(base).ok).toBe(true)
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
])('preserves %s obligations during source-changing transfers', (kind) => {
  const state = sourceSplit()
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
  expect(state.check().ok).toBe(false)
})

it.each([
  'scripts/ci/host-owner-split.mjs',
  'scripts/ci/module-runtime-consumers.json',
  'packages/example/src/index.ts',
  'src/preload/index.ts',
  'tsconfig.node.json',
  'e2e/browser/fixture/host.ts',
  consumer,
  leafTest
])('rejects source-changing transfers mixed with changes to %s', (path) => {
  const state = sourceSplit()
  state.put(path, path.endsWith('.json') ? '{}' : 'export {}')
  // The runtime registry must actually differ from its original empty value.
  if (path.endsWith('module-runtime-consumers.json')) state.put(path, '{"src/main/leaf.ts":[]}')
  expect(state.check().ok).toBe(false)
})

it('rejects source deletion even when the surviving target is registered', () => {
  const state = sourceSplit()
  state.git('rm', app)
  state.manifest.modules.host.ownerPaths = [appTest, contract]
  state.manifest.modules.host.interfacePaths = [appTest]
  expect(state.check().ok).toBe(false)
})

it('permits transfers into an existing host owner without replacing its obligations', () => {
  const state = fixture()
  const other = 'src/main/other.ts'
  const otherTest = 'src/main/other.test.ts'
  state.put(other, 'export const other = 1')
  state.put(otherTest, "import './other'")
  state.manifest.modules.foundation = {
    ...state.manifest.modules.consumers,
    ownerPaths: [other, otherTest],
    interfacePaths: [other],
    testFiles: { owner: [otherTest], contract: [], consumer: [] }
  }
  state.manifest.modules.host.consumerModules.push('foundation')
  state.save()
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  const target = state.manifest.modules.foundation
  target.ownerPaths.push(other, otherTest)
  target.interfacePaths.push(other)
  target.testFiles.owner.push(otherTest)
  expect(state.check(base).ok).toBe(true)
  target.testFiles.owner = [leafTest]
  expect(state.check(base).ok).toBe(false)
})

it('verifies every origin when a host target combines paths from multiple owners', () => {
  const state = fixture()
  const other = 'src/main/other.ts'
  const otherTest = 'src/main/other.test.ts'
  state.put(other, 'export const other = 1')
  state.put(otherTest, "import './other'")
  state.manifest.modules.consumers.ownerPaths.push(other, otherTest)
  state.manifest.modules.consumers.testFiles.owner.push(otherTest)
  state.save()
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  state.manifest.modules.consumers.ownerPaths = [consumer, uncertain, unrelated]
  state.manifest.modules.consumers.testFiles.owner = [consumer, uncertain, unrelated]
  const target = state.manifest.modules.foundation
  target.ownerPaths.push(other, otherTest)
  target.testFiles.owner.push(otherTest)
  // Historical tests without an old source path are still explicit obligations.
  target.testFiles.consumer.push(unrelated)
  expect(state.check(base).ok).toBe(true)
  target.testFiles.owner = [leafTest]
  expect(state.check(base).ok).toBe(false)
})

it('retains historical evidence with no demonstrable baseline source dependency', () => {
  const state = fixture()
  state.manifest.modules.host.testFiles.consumer = [unrelated]
  state.save()
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(unrelated)
  expect(state.check(base).ok).toBe(true)
  state.manifest.modules.host.testFiles.consumer = []
  expect(state.check(base).ok).toBe(false)
})

it('retires old consumer registration only after all moved paths have verified coverage', () => {
  const state = fixture()
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  state.manifest.modules.host.testFiles.consumer = []
  expect(state.check(base).retiredConsumers).toContain(`host:${consumer}`)
  state.manifest.modules.foundation.testFiles.consumer = [appTest, uncertain]
  const result = state.check(base)
  expect(result.ok).toBe(false)
  expect(result.retiredConsumers).not.toContain(`host:${consumer}`)
})

it.each(['remaining', 'opaque', 'historical'])(
  'retains %s moved owner tests on the original owner',
  (kind) => {
    const state = fixture()
    state.put(
      leafTest,
      kind === 'remaining'
        ? "import './app'"
        : kind === 'opaque'
          ? "import './leaf'; window.api.readState()"
          : 'export {}'
    )
    const base = state.commit()
    state.split()
    state.put(leaf, 'export const value = 2')
    expect(state.check(base).ok).toBe(false)
    state.manifest.modules.host.testFiles.consumer.push(leafTest)
    expect(state.check(base).ok).toBe(true)
  }
)

it('requires declared dynamic consumers when transferring changed source', () => {
  const state = fixture()
  state.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [leaf]: [unrelated] }))
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  expect(state.check(base).ok).toBe(false)
  state.manifest.modules.foundation.testFiles.consumer.push(unrelated)
  expect(state.check(base).ok).toBe(true)
})

it.each(['full', 'shared', 'package', 'preload'])(
  'does not waive %s owner protection during source changes',
  (kind) => {
    const state = fixture()
    if (kind === 'full') state.manifest.modules.host.fullTestReason = 'Cross-process contract'
    else {
      const path = kind === 'package' ? 'packages/example/index.ts' : `src/${kind}/index.ts`
      state.put(path, 'export {}')
      state.manifest.modules.host.ownerPaths.push(path)
    }
    state.save()
    const base = state.commit()
    state.split()
    state.put(leaf, 'export const value = 2')
    expect(state.check(base).ok).toBe(false)
  }
)

it.each(['before', 'after'])(
  'retains unresolved dependency evidence in the %s source graph',
  (revision) => {
    const state = fixture()
    const opaque = 'const target = process.env.RUNTIME_MODULE; import(target)'
    state.put(app, revision === 'before' ? opaque : 'export const value = 1')
    const base = state.commit()
    state.split()
    state.put(app, revision === 'after' ? opaque : 'export const value = 2')
    state.manifest.modules.foundation.testFiles.consumer = [consumer, uncertain]
    expect(state.check(base).ok).toBe(false)
    state.manifest.modules.foundation.testFiles.consumer.push(appTest)
    expect(state.check(base).ok).toBe(true)
  }
)

it('does not partially authorize an original owner with one unverified destination', () => {
  const state = sourceSplit()
  state.manifest.modules.application = {
    ...state.manifest.modules.foundation,
    ownerPaths: [app, appTest],
    interfacePaths: [app],
    testFiles: { owner: [appTest], contract: [contract], consumer: [uncertain] }
  }
  state.manifest.modules.host.ownerPaths = [contract]
  state.manifest.modules.host.interfacePaths = [contract]
  state.manifest.modules.host.testFiles.owner = []
  expect(state.check().ok).toBe(true)
  state.manifest.modules.application.testFiles.contract = []
  const result = state.check()
  expect(result.ok).toBe(false)
  expect(result.boundedOwnerSplits).toEqual([])
})

it('retains strict consumer retirement when source changes accompany the transfer', () => {
  const state = fixture()
  state.put(consumer, "import './leaf'; window.api.readState()")
  state.manifest.modules.host.testFiles.consumer = [consumer]
  state.save()
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  state.manifest.modules.host.testFiles.consumer = []
  const result = state.check(base)
  expect(result.ok).toBe(false)
  expect(result.retiredConsumers).not.toContain(`host:${consumer}`)
  state.manifest.modules.host.testFiles.consumer.push(consumer)
  expect(state.check(base).ok).toBe(true)
})

it('rejects high-similarity source renames that name-only diffs hide as additions', () => {
  const state = fixture()
  const previous = 'src/main/helper.ts'
  const renamed = 'src/main/renamed-helper.ts'
  state.put(previous, 'export const helper = 1')
  const base = state.commit()
  state.split()
  state.put(leaf, 'export const value = 2')
  state.git('mv', previous, renamed)
  state.manifest.modules.host.ownerPaths.push(renamed)
  const result = state.check(base)
  expect(state.git('diff', '--name-status', '-M', base, 'HEAD')).toContain(
    `R100\t${previous}\t${renamed}`
  )
  expect(result.ok).toBe(false)
  expect(result.boundedOwnerSplits).toEqual([])
})
