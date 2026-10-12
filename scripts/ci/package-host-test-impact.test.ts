/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { auditPackageConsumers } from './audit-package-consumers.mjs'
import { refinePackageHostTests } from './package-host-test-impact.mjs'
import { executeModuleTestPlan, runModuleTestCli } from './module-test-impact.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const owner = 'packages/example/src/index.ts'
const unrelated = 'src/unrelated.test.ts'
const declared = 'src/declared.test.ts'
const contract = 'src/contract.test.ts'
const related = 'src/related.test.ts'
const downstream = 'packages/downstream/test/unit.test.ts'

function fixture(source = 'export {}', runtime: Record<string, string[]> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'package-host-impact-'))
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
      example: module([owner], []),
      host: module([unrelated, declared, contract, related], [unrelated, related]),
      downstream: module(['packages/downstream/src/index.ts', downstream], [downstream])
    }
  }
  manifest.modules.example.consumerModules = ['host', 'downstream']
  manifest.modules.example.testFiles.consumer = [declared, related]
  manifest.modules.host.testFiles.contract = [contract]
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  put(
    'scripts/ci/package-test-boundaries.json',
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        { root: 'packages/example', dependencies: [] },
        { root: 'packages/downstream', dependencies: ['packages/example'] }
      ]
    })
  )
  for (const name of ['example', 'downstream']) {
    put(
      `packages/${name}/package.json`,
      JSON.stringify({
        name: `@example/${name}`,
        exports: { '.': './dist/index.js' },
        scripts: { test: 'vitest run' }
      })
    )
    put(`packages/${name}/src/index.ts`, 'export const value = 1')
  }
  put('scripts/ci/module-runtime-consumers.json', JSON.stringify(runtime))
  for (const test of [unrelated, declared, contract, related, downstream]) put(test, 'export {}')
  put(unrelated, source)
  put(related, "import '@example/example'")
  const base = commit()
  put(owner, 'export const value = 2')
  const head = commit()
  const plan = {
    mode: 'selective',
    modules: ['example', 'host', 'downstream'],
    testFiles: [unrelated, declared, contract, related, downstream],
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapabilities: ['main_runtime'],
    reasonChains: ['example -> host', 'example -> downstream']
  }
  const changes = [{ path: owner, status: 'modified' }]
  const refine = (options = {}) =>
    refinePackageHostTests(plan, changes, manifest, { cwd, base, head, ...options })
  return { cwd, git, put, commit, base, head, plan, changes, manifest, refine }
}

it('omits only proven unrelated expansion tests, preserving all declared boundary evidence and capabilities', () => {
  const state = fixture()
  const result = state.refine()
  expect(result.testFiles).toEqual([declared, contract, related, downstream])
  expect(result.capabilityOverlays).toEqual(state.plan.capabilityOverlays)
  expect(result.fallbackCapabilities).toEqual(state.plan.fallbackCapabilities)
  expect(result.modules).toEqual(state.plan.modules)
  expect(result.reasonChains.join('\n')).toContain(
    'complete base/head/checkout dependency evidence'
  )
  expect(state.plan.testFiles).toContain(unrelated)
})

it.each(['queue', 'pr'])(
  'uses the %s tier in both CLI explanation and test execution',
  async (tier) => {
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
      expect(output.mock.calls.flat().join('')).toContain(
        tier === 'pr' ? 'blocking merge queue' : 'expansion-only host test'
      )
      expect(await runModuleTestCli(args, options)).toBe(0)
      expect(spawn.mock.calls[0]?.[1]).not.toContain(unrelated)
      expect(spawn.mock.calls[0]?.[1]).toContain(related)
      if (tier === 'queue') expect(spawn.mock.calls[0]?.[1]).toContain(downstream)
      else expect(spawn.mock.calls[0]?.[1]).not.toContain(downstream)
    } finally {
      output.mockRestore()
    }
  }
)

it.each([
  "import './missing'",
  'import(name)',
  "import { readFileSync } from 'node:fs'; readFileSync('packages/example/resource.txt')",
  "import { spawn } from 'node:child_process'; spawn('node')",
  "window.api.invoke('pdf:extract')",
  "globalThis.fetch('/api/pdf')",
  "import 'an-opaque-runtime'",
  "import '@example/example'",
  "export { value } from '@example/example'",
  "vi.mock('@example/example', () => ({}))"
])('retains uncertain or related host evidence: %s', (source) => {
  expect(fixture(source).refine().testFiles).toContain(unrelated)
})

it('retains both historical and newly declared runtime edges', () => {
  const state = fixture('export {}', { [owner]: [unrelated] })
  state.put('scripts/ci/module-runtime-consumers.json', '{}')
  expect(state.refine({ head: state.commit() }).testFiles).toContain(unrelated)
  const added = fixture()
  added.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [unrelated] }))
  expect(added.refine({ head: added.commit() }).testFiles).toContain(unrelated)
})

it('retains old dependencies removed at head and dependencies introduced in the merge checkout', () => {
  const old = fixture("import '@example/example'")
  old.put(unrelated, 'export {}')
  expect(old.refine({ head: old.commit() }).testFiles).toContain(unrelated)
  const merged = fixture()
  merged.put(unrelated, "import '@example/example'")
  merged.commit()
  expect(merged.refine().testFiles).toContain(unrelated)
})

it('retains graph-selected tests and refuses missing snapshots or uncommitted evidence', () => {
  const state = fixture()
  expect(state.refine({ graphTests: [unrelated] }).testFiles).toContain(unrelated)
  expect(state.refine({ base: '0'.repeat(40) }).testFiles).toEqual(state.plan.testFiles)
  state.put(unrelated, "import '@example/example'")
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
})

it.each([
  { path: 'src/host.ts', status: 'modified' },
  { path: 'packages/unknown/src/index.ts', status: 'modified' },
  { path: owner, status: 'deleted' },
  { path: owner, status: 'renamed', previousPath: 'src/host.ts' }
])('does not narrow mixed, unknown or destructive changes: %j', (extra) => {
  const state = fixture()
  expect(
    refinePackageHostTests(state.plan, [...state.changes, extra], state.manifest, state).testFiles
  ).toEqual(state.plan.testFiles)
})

it('keeps full plans and downstream full-marker obligations separate', () => {
  const state = fixture()
  const full = { ...state.plan, mode: 'full' }
  expect(refinePackageHostTests(full, state.changes, state.manifest, state)).toBe(full)
  Object.assign(state.manifest.modules.example, { fullTestReason: 'Shared runtime' })
  expect(state.refine().testFiles).toEqual(state.plan.testFiles)
})

it('defers distant host consumers in PR but retains contracts, package tests and queue evidence', () => {
  const state = fixture()
  const pr = state.refine({ tier: 'pr' })
  expect(pr.testFiles).toEqual([contract, related])
  expect(pr.deferredTestFiles).toEqual([unrelated, declared, downstream])
  expect(pr.deferredPackageRoots).toEqual(['packages/downstream'])
  expect(pr.modules).toEqual(state.plan.modules)
  expect(pr.capabilityOverlays).toEqual(state.plan.capabilityOverlays)
  expect(pr.reasonChains.join('\n')).toContain('blocking merge queue')
  expect(state.refine({ tier: 'queue' }).testFiles).toContain(declared)
  // The original expansion-only test remains provably unrelated in queue; declared evidence does not.
  expect(state.plan.testFiles).toContain(unrelated)
})

it.each([
  "import '@example/example'",
  "export * from '@example/example'",
  "vi.mock('@example/example', () => ({}))",
  "import 'an-opaque-runtime'",
  "import { readFileSync } from 'node:fs'",
  "import('./missing')",
  'import(name)'
])('retains direct or unresolved PR integration: %s', (source) => {
  expect(fixture(source).refine({ tier: 'pr' }).testFiles).toContain(unrelated)
})

it('retains a host adapter with an unresolved external runtime dependency in PR', () => {
  const state = fixture("import './adapter'")
  state.put('src/adapter.ts', "import 'an-opaque-runtime'")
  const revision = state.commit()
  expect(state.refine({ base: revision, head: revision, tier: 'pr' }).testFiles).toContain(
    unrelated
  )
})

it('keeps a host adapter contract, including dependency changes in the actual merge checkout', () => {
  const state = fixture("import './adapter'")
  state.put('src/adapter.ts', "import '@example/example'")
  const head = state.commit()
  expect(state.refine({ head, tier: 'pr' }).testFiles).toContain(unrelated)
  const merged = fixture("import './adapter'")
  merged.put('src/adapter.ts', 'export {}')
  const before = merged.commit()
  merged.put('src/adapter.ts', "import '@example/example'")
  merged.commit()
  expect(merged.refine({ base: before, head: before, tier: 'pr' }).testFiles).toContain(unrelated)
})

it('keeps unioned dynamic resource adapter contracts in PR', () => {
  const state = fixture("import './adapter'", { [owner]: ['src/adapter.ts'] })
  state.put('src/adapter.ts', 'export {}')
  expect(state.refine({ head: state.commit(), tier: 'pr' }).testFiles).toContain(unrelated)
})

it('defers a runtime consumer beyond the host adapter to the blocking queue', () => {
  const state = fixture("import './service'")
  state.put('src/service.ts', "import './adapter'")
  state.put('src/adapter.ts', "import '@example/example'")
  const revision = state.commit()
  const pr = state.refine({ base: revision, head: revision, tier: 'pr' })
  expect(pr.testFiles).not.toContain(unrelated)
  expect(pr.deferredTestFiles).toContain(unrelated)
  expect(state.refine({ base: revision, head: revision, tier: 'queue' }).testFiles).toContain(
    unrelated
  )
})

it('rejects unsupported phases and keeps mixed changes conservative in PR', () => {
  const state = fixture()
  expect(() => state.refine({ tier: 'nightly' })).toThrow('Unknown test tier')
  expect(
    refinePackageHostTests(
      state.plan,
      [...state.changes, { path: 'src/host.ts', status: 'modified' }],
      state.manifest,
      { ...state, tier: 'pr' }
    ).testFiles
  ).toEqual(state.plan.testFiles)
})

it('does not let CI-selected downstream roots re-expand PR package discovery', () => {
  const state = fixture()
  const spawn = vi.fn(() => ({ status: 0 }))
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    executeModuleTestPlan(state.refine({ tier: 'pr' }), {
      cwd: state.cwd,
      spawn,
      environment: {
        ...process.env,
        VITEST_PORTABLE_CI: '1',
        OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '["packages/example","packages/downstream"]'
      }
    })
    const args = spawn.mock.calls[0]?.[1]
    expect(args).toContain('packages/example')
    expect(args).not.toContain('packages/downstream')
    expect(args).not.toContain(downstream)
    expect(args).toContain('--exclude=packages/downstream/**')
    expect(args).toContain(related)
  } finally {
    output.mockRestore()
  }
})

it('keeps explicitly registered downstream package contracts in PR', () => {
  const state = fixture()
  state.manifest.modules.downstream.testFiles = { owner: [], contract: [downstream], consumer: [] }
  state.put('scripts/ci/module-impact.json', JSON.stringify(state.manifest))
  const pr = state.refine({ head: state.commit(), tier: 'pr' })
  expect(pr.testFiles).toContain(downstream)
  expect(pr.deferredPackageRoots).toEqual([])
})

it('audits a committed package and distinguishes runtime consumers from deferred declared evidence', () => {
  const state = fixture()
  const audit = auditPackageConsumers(state.head, state.cwd)
  expect(audit.revision).toBe(state.head)
  const example = audit.packages.find(({ root }: { root: string }) => root === 'packages/example')!
  expect(example.mode).toBe('selective')
  expect(example.evidence).toContainEqual({ test: related, evidence: 'runtime-path', pr: true })
  expect(example.evidence).toContainEqual({ test: declared, evidence: 'no-static-path', pr: false })
  expect(example.hostTestFiles).toBe(example.prHostTestFiles! + example.queueHostTestFiles!)
  expect(() => auditPackageConsumers('--all', state.cwd)).toThrow()
})

it('keeps PR consumers when trusted package selection falls back to all packages', async () => {
  const state = fixture()
  const spawn = vi.fn(() => ({ status: 0 }))
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(
      await runModuleTestCli(
        ['affected', '--base', state.base, '--head', state.head, '--tier', 'pr'],
        {
          cwd: state.cwd,
          manifest: state.manifest,
          execute: (command: string, args: string[]) => {
            if (command === 'codegraph') throw Error('Graph unavailable')
            return execFileSync(command, args, { cwd: state.cwd, encoding: 'utf8' })
          },
          spawn,
          environment: {
            ...process.env,
            VITEST_PORTABLE_CI: '1',
            OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '["packages"]'
          }
        }
      )
    ).toBe(0)
    expect(spawn.mock.calls[0]?.[1]).toContain(unrelated)
    expect(spawn.mock.calls[0]?.[1]).toContain(downstream)
  } finally {
    output.mockRestore()
  }
})

it.each([['--tier'], ['--tier', 'nightly']])(
  'rejects invalid tier arguments before selection: %j',
  async (...tier) => {
    await expect(
      runModuleTestCli(['affected', '--base', 'base', '--head', 'head', ...tier])
    ).rejects.toThrow('--tier must be pr or queue')
  }
)
