/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { refinePackageHostTests } from './package-host-test-impact.mjs'
import { runModuleTestCli } from './module-test-impact.mjs'

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

it('uses the refined plan in both CLI explanation and test execution', async () => {
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
  const args = ['affected', '--base', state.base, '--head', state.head]
  try {
    expect(await runModuleTestCli([...args, '--explain'], options)).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
    expect(output.mock.calls.flat().join('')).toContain('expansion-only host test')
    expect(await runModuleTestCli(args, options)).toBe(0)
    expect(spawn.mock.calls[0]?.[1]).not.toContain(unrelated)
    expect(spawn.mock.calls[0]?.[1]).toContain(related)
    expect(spawn.mock.calls[0]?.[1]).toContain(downstream)
  } finally {
    output.mockRestore()
  }
})

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
