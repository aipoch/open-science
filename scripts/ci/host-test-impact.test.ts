/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { refineHostTests } from './host-test-impact.mjs'
import { runModuleTestCli } from './module-test-impact.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const owner = 'src/main/example.ts'
const ownTest = 'src/main/example.test.ts'
const unrelated = 'src/main/unrelated.test.ts'
const declared = 'src/main/declared.test.ts'
const contract = 'src/main/contract.test.ts'
const related = 'src/main/related.test.ts'
const packageTest = 'packages/other/unit.test.ts'

function fixture(source = 'export {}', runtime: Record<string, string[]> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'host-impact-'))
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
  const module = (paths: string[], tests: string[]) => ({
    ownerPaths: paths,
    interfacePaths: [paths[0]],
    consumerModules: [] as string[],
    testFiles: { owner: tests, contract: [] as string[], consumer: [] as string[] },
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapability: 'main_runtime'
  })
  const manifest = {
    schemaVersion: 1,
    modules: {
      example: module([owner, ownTest], [ownTest]),
      composition: module([unrelated, declared, contract, related], [unrelated, related]),
      package: module([packageTest], [packageTest])
    }
  }
  manifest.modules.example.consumerModules = ['composition', 'package']
  manifest.modules.example.testFiles.consumer = [declared]
  manifest.modules.composition.testFiles.contract = [contract]
  const saveManifest = () => put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  saveManifest()
  put('scripts/ci/module-runtime-consumers.json', JSON.stringify(runtime))
  put(owner, 'export const value = 1')
  for (const test of [ownTest, unrelated, declared, contract, related, packageTest])
    put(test, 'export {}')
  put(unrelated, source)
  put(related, "import './example'")
  const base = commit()
  put(owner, 'export const value = 2')
  const head = commit()
  const plan = {
    mode: 'selective',
    modules: ['example', 'composition', 'package'],
    testFiles: [ownTest, unrelated, declared, contract, related, packageTest],
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapabilities: ['main_runtime'],
    reasonChains: ['example -> composition', 'example -> package']
  }
  const changes = [{ path: owner, status: 'modified' }]
  const refine = (options = {}) =>
    refineHostTests(plan, changes, manifest, { cwd, base, head, tier: 'pr', ...options })
  return { cwd, git, put, commit, base, head, plan, changes, manifest, saveManifest, refine }
}

it('defers only proven unrelated expansion tests from PR and leaves blocking queue intact', () => {
  const state = fixture()
  const result = state.refine()
  expect(result.testFiles).toEqual([ownTest, declared, contract, related, packageTest])
  expect(result.deferredTestFiles).toEqual([unrelated])
  expect(result.reasonChains.join('\n')).toContain('complete base/head/checkout evidence')
  expect(result.capabilityOverlays).toEqual(state.plan.capabilityOverlays)
  expect(result.fallbackCapabilities).toEqual(state.plan.fallbackCapabilities)
  expect(result.modules).toEqual(state.plan.modules)
  expect(state.refine({ tier: 'queue' })).toBe(state.plan)
  expect(refineHostTests(state.plan, state.changes, state.manifest, state)).toBe(state.plan)
  expect(state.plan.testFiles).toContain(unrelated)
})

it.each([
  "import './missing'",
  'import(name)',
  "import { readFileSync } from 'node:fs'; readFileSync('src/main/example.ts')",
  "import { spawn } from 'node:child_process'; spawn('node')",
  "window.api.invoke('example:read')",
  "globalThis.fetch('/api/example')",
  "process.emit('example')",
  "import 'opaque-runtime'",
  "import './example'",
  "import type { Value } from './example'",
  "export * from './example'",
  "vi.mock('./example', () => ({}))"
])('retains related or uncertain evidence: %s', (source) => {
  expect(fixture(source).refine().testFiles).toContain(unrelated)
})

it('requires completeness of the entire dependency cone, not just the test import', () => {
  const state = fixture("import './adapter'")
  state.put('src/main/adapter.ts', "import 'opaque-runtime'")
  const revision = state.commit()
  expect(state.refine({ base: revision, head: revision }).testFiles).toContain(unrelated)
})

it('retains tests reaching any path of the changed owner, not only the edited file', () => {
  const state = fixture("import './sibling'")
  state.put('src/main/sibling.ts', 'export {}')
  state.manifest.modules.example.ownerPaths.push('src/main/sibling.ts')
  state.saveManifest()
  const revision = state.commit()
  expect(state.refine({ base: revision, head: revision }).testFiles).toContain(unrelated)
})

it('unions runtime declarations from base, head and actual checkout', () => {
  const old = fixture('export {}', { [owner]: [unrelated] })
  old.put('scripts/ci/module-runtime-consumers.json', '{}')
  expect(old.refine({ head: old.commit() }).testFiles).toContain(unrelated)
  const added = fixture()
  added.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [unrelated] }))
  const head = added.commit()
  expect(added.refine({ head }).testFiles).toContain(unrelated)
  // The PR head can predate additional mainline dependencies present in the merge checkout.
  expect(added.refine().testFiles).toContain(unrelated)
})

it('retains dependencies removed at head or newly introduced in the merge checkout', () => {
  const old = fixture("import './example'")
  old.put(unrelated, 'export {}')
  expect(old.refine({ head: old.commit() }).testFiles).toContain(unrelated)
  const merged = fixture()
  merged.put(unrelated, "import './example'")
  merged.commit()
  expect(merged.refine().testFiles).toContain(unrelated)
})

it('retains graph tests and direct evidence from every revision', () => {
  const state = fixture()
  expect(state.refine({ graphTests: [unrelated] }).testFiles).toContain(unrelated)
  state.manifest.modules.example.testFiles.consumer.push(unrelated)
  state.saveManifest()
  const base = state.commit()
  state.manifest.modules.example.testFiles.consumer.pop()
  state.saveManifest()
  const head = state.commit()
  expect(state.refine({ base, head }).testFiles).toContain(unrelated)
  state.manifest.modules.composition.testFiles.contract.push(unrelated)
  state.saveManifest()
  state.commit()
  expect(state.refine({ base: state.base, head: state.head }).testFiles).toContain(unrelated)
})

it('retains full-owner evidence and rejects uncertain ownership', () => {
  const state = fixture()
  Object.assign(state.manifest.modules.composition, { fullTestReason: 'Shared runtime' })
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
  delete (state.manifest.modules.composition as { fullTestReason?: string }).fullTestReason
  state.manifest.modules.composition.ownerPaths.push(owner)
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
  state.manifest.modules.composition.ownerPaths.pop()
  state.manifest.modules.example.ownerPaths = [ownTest]
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
})

it('refuses dirty, missing and invalid evidence', () => {
  const state = fixture()
  expect(state.refine({ base: '0'.repeat(40) }).testFiles).toEqual(state.plan.testFiles)
  state.put('scripts/ci/module-runtime-consumers.json', '{')
  expect(state.refine({ head: state.commit() }).testFiles).toEqual(state.plan.testFiles)
  state.put('scripts/ci/module-runtime-consumers.json', '{}')
  state.commit()
  state.put(unrelated, "import './example'")
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
  state.git('add', '.')
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
  state.commit()
  state.put('src/main/untracked.ts', 'export {}')
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
})

it.each([
  { path: 'packages/example/index.ts', status: 'modified' },
  { path: 'src/shared/contracts.ts', status: 'modified' },
  { path: 'src/preload/index.ts', status: 'modified' },
  { path: 'scripts/ci/module-impact/example.json', status: 'modified' },
  { path: 'src/main/unknown.ts', status: 'modified' },
  { path: 'src/main/example.png', status: 'added' },
  { path: owner, status: 'deleted' },
  { path: owner, status: 'renamed', previousPath: 'src/main/old.ts' }
])('keeps mixed, shared, unknown and destructive changes conservative: %j', (extra) => {
  const state = fixture()
  // Make the unknown path exist so it cannot be treated as an added path absent in older revisions.
  if (extra.path === 'src/main/unknown.ts') {
    state.put(extra.path, 'export {}')
    const revision = state.commit()
    expect(
      refineHostTests(state.plan, [extra], state.manifest, {
        ...state,
        base: revision,
        head: revision,
        tier: 'pr'
      })
    ).toBe(state.plan)
  } else {
    expect(
      refineHostTests(state.plan, [...state.changes, extra], state.manifest, {
        ...state,
        tier: 'pr'
      })
    ).toBe(state.plan)
  }
})

it('keeps full and empty plans and validates the requested tier', () => {
  const state = fixture()
  const full = { ...state.plan, mode: 'full' }
  expect(refineHostTests(full, state.changes, state.manifest, { ...state, tier: 'pr' })).toBe(full)
  expect(refineHostTests(state.plan, [], state.manifest, { ...state, tier: 'pr' })).toBe(state.plan)
  expect(() => state.refine({ tier: 'nightly' })).toThrow('Unknown test tier')
  Object.assign(state.manifest.modules.example, { fullTestReason: 'Shared runtime' })
  expect(state.refine()).toBe(state.plan)
})

it.each(['pr', 'queue'])('uses the same %s selection in explain and execution', async (tier) => {
  const state = fixture()
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const spawn = vi.fn(() => ({ status: 0 }))
  const options = {
    cwd: state.cwd,
    manifest: state.manifest,
    execute: (command: string, args: string[]) => {
      if (command === 'codegraph') throw Error('Graph unavailable')
      return execFileSync(command, args, { cwd: state.cwd, encoding: 'utf8' })
    },
    spawn,
    environment: { npm_execpath: '/npm/bin/npm-cli.js' }
  }
  const args = ['affected', '--base', state.base, '--head', state.head, '--tier', tier]
  try {
    expect(await runModuleTestCli([...args, '--explain'], options)).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
    expect(output.mock.calls.flat().join('').includes('PR host boundary')).toBe(tier === 'pr')
    expect(await runModuleTestCli(args, options)).toBe(0)
    expect(spawn.mock.calls[0]?.[1].includes(unrelated)).toBe(tier === 'queue')
    expect(spawn.mock.calls[0]?.[1]).toContain(declared)
    expect(spawn.mock.calls[0]?.[1]).toContain(related)
  } finally {
    output.mockRestore()
  }
})

it('requires ownership in every snapshot where an added file exists', () => {
  const state = fixture()
  const added = 'src/main/added.ts'
  state.put(added, 'export {}')
  const head = state.commit()
  const changes = [...state.changes, { path: added, status: 'added' }]
  expect(refineHostTests(state.plan, changes, state.manifest, { ...state, head, tier: 'pr' })).toBe(
    state.plan
  )
  state.manifest.modules.example.ownerPaths.push(added)
  state.saveManifest()
  const registered = state.commit()
  expect(
    refineHostTests(state.plan, changes, state.manifest, { ...state, head: registered, tier: 'pr' })
      .deferredTestFiles
  ).toEqual([unrelated])
})

it('resolves renderer aliases before deferring expansion tests', () => {
  const state = fixture("import '@/model'")
  state.put('src/renderer/src/model.ts', "export * from '../../main/example'")
  const revision = state.commit()
  expect(state.refine({ base: revision, head: revision }).testFiles).toContain(unrelated)
})
