/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { refineHostTests } from './package-host-test-impact.mjs'
import { runModuleTestCli } from './module-test-impact.mjs'
import { moduleRelationships } from './module-relationships.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const owner = 'src/main/owner.ts'
const own = 'src/main/owner.test.ts'
const direct = 'src/main/direct.test.ts'
const adapter = 'src/main/adapter.test.ts'
const distant = 'src/main/distant.test.ts'
const historic = 'src/main/historic.test.ts'
const opaque = 'src/main/opaque.test.ts'
const contract = 'src/main/contract.test.ts'
const unrelated = 'src/main/unrelated.test.ts'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'host-test-impact-'))
  roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'ci(test): record fixture')
    return git('rev-parse', 'HEAD')
  }
  const module = (ownerPaths: string[], tests: string[]) => ({
    ownerPaths,
    interfacePaths: [ownerPaths[0]],
    consumerModules: [] as string[],
    testFiles: { owner: tests, consumer: [] as string[], contract: [] as string[] },
    fallbackCapability: 'main_runtime',
    capabilityOverlays: ['windows_sensitive']
  })
  const manifest = {
    schemaVersion: 1,
    modules: {
      owner: module([owner, own], [own]),
      downstream: module(
        [
          direct,
          adapter,
          distant,
          historic,
          opaque,
          contract,
          unrelated,
          'src/main/adapter.ts',
          'src/main/far.ts'
        ],
        [direct, adapter, distant, historic, opaque, unrelated]
      )
    }
  }
  manifest.modules.owner.consumerModules.push('downstream')
  manifest.modules.owner.testFiles.consumer.push(distant, historic, opaque)
  manifest.modules.downstream.testFiles.contract.push(contract)
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  put('scripts/ci/module-impact.json', JSON.stringify(manifest))
  put('scripts/ci/module-runtime-consumers.json', '{}')
  for (const path of Object.values(manifest.modules).flatMap((m) => m.ownerPaths))
    put(path, 'export {}')
  put(direct, "import './owner'")
  put(adapter, "import './adapter'")
  put('src/main/adapter.ts', "import './owner'")
  put('src/main/far.ts', "import './adapter'")
  put(distant, "import './far'")
  put(opaque, 'import(process.env.OWNER)')
  const base = commit()
  put(owner, 'export const value = 2')
  const head = commit()
  const changes = [{ path: owner, status: 'modified' }]
  const plan = {
    mode: 'selective',
    modules: ['owner', 'downstream'],
    testFiles: [own, direct, adapter, distant, historic, opaque, contract, unrelated],
    capabilityOverlays: ['windows_sensitive'],
    fallbackCapabilities: ['main_runtime'],
    reasonChains: []
  }
  const refine = (options = {}) =>
    refineHostTests(plan, changes, manifest, { cwd, base, head, tier: 'pr', ...options })
  return { cwd, git, put, commit, manifest, base, head, changes, plan, refine }
}

it('defers only distant evidence in PR while retaining the complete queue plan and capability scope', () => {
  const f = fixture()
  const result = f.refine()
  expect(result.deferredTestFiles).toEqual([distant])
  expect(result.testFiles).toEqual([own, direct, adapter, historic, opaque, contract])
  expect(result.capabilityOverlays).toEqual(f.plan.capabilityOverlays)
  expect(result.modules).toEqual(f.plan.modules)
  expect(f.refine({ tier: 'queue' }).testFiles).toEqual(
    f.plan.testFiles.filter((test) => test !== unrelated)
  )
  expect(f.refine({ tier: 'queue' }).testFiles).toContain(distant)
})

it('protects CodeGraph and unioned explicit runtime dependencies', () => {
  const f = fixture()
  f.put('scripts/ci/module-runtime-consumers.json', JSON.stringify({ [owner]: [unrelated] }))
  const head = f.commit()
  expect(f.refine({ head, graphTests: [distant] }).deferredTestFiles).toEqual([])
  f.put('scripts/ci/module-runtime-consumers.json', '{}')
  const next = f.commit()
  expect(f.refine({ base: head, head: next }).testFiles).toContain(unrelated)
})

it.each(['base', 'head', 'checkout'])(
  'retains dependencies found in the %s revision',
  (revision) => {
    const f = fixture()
    f.put(unrelated, "import './owner'")
    const changed = f.commit()
    if (revision === 'checkout') {
      expect(f.refine().testFiles).toContain(unrelated)
    } else if (revision === 'head') {
      expect(f.refine({ head: changed }).testFiles).toContain(unrelated)
    } else {
      f.put(unrelated, 'export {}')
      expect(f.refine({ base: changed, head: f.commit() }).testFiles).toContain(unrelated)
    }
  }
)

it.each(['dirty', 'untracked', 'deleted', 'mixed', 'full', 'missing'])(
  'keeps the broad plan for %s evidence',
  (kind) => {
    const f = fixture()
    if (kind === 'dirty') f.put(owner, 'export const value = 3')
    if (kind === 'untracked') f.put('src/main/new.ts', 'export {}')
    if (kind === 'deleted') f.changes[0].status = 'deleted'
    if (kind === 'mixed')
      f.changes.push({ path: 'packages/example/src/index.ts', status: 'modified' })
    if (kind === 'full')
      Object.assign(f.manifest.modules.owner, { fullTestReason: 'dynamic owner' })
    const result = f.refine(kind === 'missing' ? { head: 'not-a-revision' } : {})
    expect(result.testFiles).toEqual(f.plan.testFiles)
  }
)

it.each(['pr', 'queue'])(
  'applies host tier %s consistently in CLI explanation and execution',
  async (tier) => {
    const f = fixture()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const spawn = vi.fn(() => ({ status: 0 }))
    const options = {
      cwd: f.cwd,
      manifest: f.manifest,
      spawn,
      execute: (command: string, args: string[]) => {
        if (command === 'codegraph') throw Error('No graph')
        return execFileSync(command, args, { cwd: f.cwd, encoding: 'utf8' })
      },
      environment: { npm_execpath: '/npm/bin/npm-cli.js' }
    }
    try {
      const args = ['affected', '--base', f.base, '--head', f.head, '--tier', tier]
      expect(await runModuleTestCli([...args, '--explain'], options)).toBe(0)
      expect(spawn).not.toHaveBeenCalled()
      expect(await runModuleTestCli(args, options)).toBe(0)
      expect(spawn.mock.calls[0]?.[1]).toContain(direct)
      if (tier === 'pr') expect(spawn.mock.calls[0]?.[1]).not.toContain(distant)
      else expect(spawn.mock.calls[0]?.[1]).toContain(distant)
    } finally {
      write.mockRestore()
    }
  }
)

it('does not reseed a composed sibling and retains real multi-hop consumers in queue', () => {
  const f = fixture()
  f.put('src/main/sibling.ts', 'export const value = 1')
  f.put(unrelated, "import './sibling'")
  f.put('src/main/adapter.ts', "import './owner'; import './sibling'")
  const head = f.commit()
  const queue = f.refine({ head, tier: 'queue' })
  expect(queue.testFiles).not.toContain(unrelated)
  expect(queue.testFiles).toContain(adapter)
  expect(queue.testFiles).toContain(distant)
  // Reversing the relation creates a real path, which both tiers must preserve.
  f.put('src/main/sibling.ts', "export * from './owner'")
  expect(f.refine({ head: f.commit(), tier: 'queue' }).testFiles).toContain(unrelated)
})

it('keeps dynamic and opaque expansion evidence in the queue', () => {
  const f = fixture()
  f.put(unrelated, "window.api.invoke('identity:read')")
  expect(f.refine({ head: f.commit(), tier: 'queue' }).testFiles).toContain(unrelated)
})

it.each(['pr', 'queue'])('documentation does not widen the %s CLI boundary', async (tier) => {
  const f = fixture()
  f.put(owner, 'export const value = 3')
  f.put('docs/example.md', 'Updated documentation')
  const head = f.commit()
  const spawn = vi.fn(() => ({ status: 0 }))
  const options = {
    cwd: f.cwd,
    manifest: f.manifest,
    spawn,
    execute: (command: string, args: string[]) => {
      if (command === 'codegraph') throw Error('No graph')
      return execFileSync(command, args, { cwd: f.cwd, encoding: 'utf8' })
    },
    environment: { npm_execpath: '/npm/bin/npm-cli.js' }
  }
  await runModuleTestCli(['affected', '--base', f.base, '--head', head, '--tier', tier], options)
  expect(spawn.mock.calls[0]?.[1]).not.toContain(unrelated)
  expect(spawn.mock.calls[0]?.[1]).toContain(direct)
  if (tier === 'pr') expect(spawn.mock.calls[0]?.[1]).not.toContain(distant)
  else expect(spawn.mock.calls[0]?.[1]).toContain(distant)
})

it.each(['pr', 'queue'])(
  'protects additive registration evidence beside source changes in %s',
  async (tier) => {
    const f = fixture()
    f.put('scripts/ci/module-impact.json', JSON.stringify({ schemaVersion: 1 }))
    for (const [id, module] of Object.entries(f.manifest.modules))
      f.put(`scripts/ci/module-impact/${id}.json`, JSON.stringify(module))
    const base = f.commit()
    const trusted = structuredClone(f.manifest)
    f.put(owner, 'export const value = 3')
    f.manifest.modules.owner.testFiles.consumer.push(unrelated)
    f.put('scripts/ci/module-impact/owner.json', JSON.stringify(f.manifest.modules.owner))
    const head = f.commit()
    const spawn = vi.fn(() => ({ status: 0 }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await runModuleTestCli(['affected', '--base', base, '--head', head, '--tier', tier], {
        cwd: f.cwd,
        manifest: trusted,
        spawn,
        execute: (command: string, args: string[]) => {
          if (command === 'codegraph') throw Error('No graph')
          return execFileSync(command, args, { cwd: f.cwd, encoding: 'utf8' })
        },
        environment: { npm_execpath: '/npm/bin/npm-cli.js' }
      })
      expect(spawn.mock.calls[0]?.[1]).toContain(unrelated)
      expect(spawn.mock.calls[0]?.[1]).toContain(direct)
      if (tier === 'pr') expect(spawn.mock.calls[0]?.[1]).not.toContain(distant)
      else expect(spawn.mock.calls[0]?.[1]).toContain(distant)
      expect(write.mock.calls.map(([text]) => text).join('')).toContain('Mode: selective')
    } finally {
      write.mockRestore()
    }
  }
)

it('exports immutable, separately directed dependency and test-routing evidence', () => {
  const f = fixture()
  const before = moduleRelationships(f.head, f.cwd)
  expect(before.relations).toContainEqual(
    expect.objectContaining({ kind: 'runtime-import', from: 'downstream', to: 'owner' })
  )
  expect(before.relations).toContainEqual(
    expect.objectContaining({ kind: 'test-routing', from: 'owner', to: 'downstream' })
  )
  f.put('src/main/adapter.ts', "import type { Value } from './owner'")
  f.put(
    'scripts/ci/module-runtime-consumers.json',
    JSON.stringify({ [owner]: ['src/main/far.ts'] })
  )
  const after = moduleRelationships(f.commit(), f.cwd)
  expect(after.relations).toContainEqual(
    expect.objectContaining({
      kind: 'type-import',
      from: 'downstream',
      to: 'owner',
      paths: [['src/main/adapter.ts', owner]]
    })
  )
  expect(after.relations).toContainEqual(
    expect.objectContaining({ kind: 'dynamic-contract', from: 'downstream', to: 'owner' })
  )
  expect(after.relations.some(({ kind }: { kind: string }) => kind === 'runtime-import')).toBe(
    false
  )
  expect(moduleRelationships(f.head, f.cwd)).toEqual(before)
})
