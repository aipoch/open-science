import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadModuleImpactManifest,
  loadModuleImpactManifestAtRevision,
  moduleImpactRegistrationPath,
  type ModuleImpactManifest
} from './load-module-impact.mjs'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

const sample = (): ModuleImpactManifest => ({
  schemaVersion: 1,
  modules: {
    sample: {
      ownerPaths: ['src/sample.ts', 'src/sample.test.ts'],
      interfacePaths: ['src/sample.ts'],
      testFiles: { owner: ['src/sample.test.ts'], contract: [], consumer: [] },
      consumerModules: [],
      capabilityOverlays: [],
      fallbackCapability: 'main_runtime'
    }
  }
})

describe('module registration layouts', () => {
  let root: string
  const put = (path: string, contents: unknown): void => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(contents))
  }
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = (): string => {
    git('add', '.')
    git('commit', '--quiet', '--allow-empty', '-m', 'ci(test): record fixture')
    return git('rev-parse', 'HEAD')
  }
  const split = (manifest: ModuleImpactManifest): void => {
    put(moduleImpactRegistrationPath, { schemaVersion: manifest.schemaVersion })
    for (const [id, module] of Object.entries(manifest.modules)) {
      put(`scripts/ci/module-impact/${id}.json`, module)
    }
  }
  const local = (): ModuleImpactManifest =>
    loadModuleImpactManifest(pathToFileURL(join(root, moduleImpactRegistrationPath)))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'module-impact layout '))
    git('init', '--quiet')
    git('config', 'user.email', 'ci@example.com')
    git('config', 'user.name', 'CI Test')
    put(moduleImpactRegistrationPath, sample())
    put('src/sample.ts', 'candidate source must not execute')
    put('src/sample.test.ts', 'candidate test must not execute')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('preserves every repository record and representative selection after splitting', () => {
    const original = loadModuleImpactManifest()
    split(original)
    const sharded = local()
    expect(sharded).toEqual(original)
    expect(Object.keys(sharded.modules)).toEqual(Object.keys(original.modules).sort())
    expect(validateModuleImpactManifest(sharded)).toBe(sharded)
    for (const path of [
      'src/main/artifacts/repository.ts',
      'src/main/artifacts/repository.test.ts',
      'src/shared/session.ts',
      'src/shared/i18n/locales/fr.json',
      'scripts/ci/module-impact/sample.json'
    ]) {
      const changes = [{ path, status: 'modified' }]
      const graph = { status: 'not-used', testFiles: [] }
      const before = createAffectedTestPlan(changes, graph, original)
      const after = createAffectedTestPlan(changes, graph, sharded)
      expect({ ...after, modules: [...after.modules].sort() }).toEqual({
        ...before,
        modules: [...before.modules].sort()
      })
    }
  })

  it('reads old Git history and admits an equivalent split without executing candidate code', () => {
    const base = commit()
    expect(loadModuleImpactManifestAtRevision(base, { cwd: root })).toEqual(sample())
    split(sample())
    put('scripts/ci/load-module-impact.mjs', 'throw new Error("untrusted reader")')
    const head = commit()
    expect(local()).toEqual(sample())
    expect(loadModuleImpactManifestAtRevision(head, { cwd: root })).toEqual(sample())
    expect(moduleOwnershipFromRevisions(base, head, { cwd: root }).ok).toBe(true)
    // Working-tree data cannot contaminate inspection of a committed revision.
    put('scripts/ci/module-impact/sample.json', null)
    expect(loadModuleImpactManifestAtRevision(head, { cwd: root })).toEqual(sample())
    expect(loadModuleImpactManifestAtRevision(base, { cwd: root })).toEqual(sample())
  })

  it('enforces coverage preservation for sharded-to-sharded revisions', () => {
    split(sample())
    const base = commit()
    const changed = sample()
    changed.modules.sample.ownerPaths.push('src/new.ts')
    put('src/new.ts', 'candidate source')
    split(changed)
    expect(moduleOwnershipFromRevisions(base, commit(), { cwd: root }).ok).toBe(true)
    changed.modules.sample.ownerPaths = ['src/sample.test.ts', 'src/new.ts']
    split(changed)
    const reduced = moduleOwnershipFromRevisions(base, commit(), { cwd: root })
    expect(reduced.ok).toBe(false)
    expect(reduced.violations).toContainEqual(
      expect.objectContaining({
        path: 'src/sample.ts',
        rule: 'module-ownership-regression'
      })
    )
  })

  it.each([
    ['empty', { schemaVersion: 1 }],
    ['invalid inline modules', { schemaVersion: 1, modules: [] }],
    ['unknown version', { schemaVersion: 2, modules: {} }],
    ['unknown policy', { ...sample(), skipTests: true }]
  ])('rejects %s in both working-tree and Git readers', (_, metadata) => {
    put(moduleImpactRegistrationPath, metadata)
    const revision = commit()
    expect(local).toThrow()
    expect(() => loadModuleImpactManifestAtRevision(revision, { cwd: root })).toThrow()
  })

  it.each(['sample-name.json', 'Sample.json', 'nested/sample.json', 'sample.mjs'])(
    'rejects unsupported shard path %s in both readers',
    (name) => {
      put(moduleImpactRegistrationPath, { schemaVersion: 1 })
      put(`scripts/ci/module-impact/${name}`, sample().modules.sample)
      const revision = commit()
      expect(local).toThrow()
      expect(() => loadModuleImpactManifestAtRevision(revision, { cwd: root })).toThrow()
    }
  )

  it.each([null, [], 'script'])('rejects a non-object module record: %s', (record) => {
    put(moduleImpactRegistrationPath, { schemaVersion: 1 })
    put('scripts/ci/module-impact/sample.json', record)
    expect(local).toThrow('one module object')
    expect(() => loadModuleImpactManifestAtRevision(commit(), { cwd: root })).toThrow(
      'one module object'
    )
  })

  it('rejects malformed JSON and simultaneous inline and sharded registrations', () => {
    put('scripts/ci/module-impact/sample.json', sample().modules.sample)
    expect(local).toThrow('mixes inline modules and shards')
    expect(() => loadModuleImpactManifestAtRevision(commit(), { cwd: root })).toThrow(
      'mixes inline modules and shards'
    )
    put(moduleImpactRegistrationPath, { schemaVersion: 1 })
    writeFileSync(join(root, 'scripts/ci/module-impact/sample.json'), '{')
    expect(local).toThrow()
    expect(() => loadModuleImpactManifestAtRevision(commit(), { cwd: root })).toThrow()
  })

  it.each([
    moduleImpactRegistrationPath,
    'scripts/ci/module-impact/sample.json',
    'scripts/ci/module-impact'
  ])('rejects Git symlinks without following them: %s', (path) => {
    commit()
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      input: '../../outside.json',
      encoding: 'utf8'
    }).trim()
    git('update-index', '--add', '--cacheinfo', `120000,${oid},${path}`)
    git('commit', '--quiet', '-m', 'ci(test): add symlink')
    expect(() =>
      loadModuleImpactManifestAtRevision(git('rev-parse', 'HEAD'), { cwd: root })
    ).toThrow('regular file')
  })

  it('does not silently bootstrap a shard-only revision without its metadata', () => {
    const base = commit()
    split(sample())
    rmSync(join(root, moduleImpactRegistrationPath))
    expect(() => moduleOwnershipFromRevisions(base, commit(), { cwd: root })).toThrow(
      'Missing module-impact manifest'
    )
  })

  it('rejects a Git filename whose trailing newline could alias another module', () => {
    split(sample())
    commit()
    const oid = git('rev-parse', 'HEAD:scripts/ci/module-impact/sample.json')
    // Windows rejects control characters in index paths. Build the hostile tree as
    // Git data so every platform reaches the reader without checking out that path.
    const tree = (input: string): string =>
      execFileSync('git', ['mktree', '-z'], { cwd: root, input, encoding: 'utf8' }).trim()
    const shards = tree(`100644 blob ${oid}\tsample.json\0` + `100644 blob ${oid}\tsample.json\n\0`)
    const metadata = git('rev-parse', 'HEAD:scripts/ci/module-impact.json')
    const ci = tree(
      `040000 tree ${shards}\tmodule-impact\0` + `100644 blob ${metadata}\tmodule-impact.json\0`
    )
    const scripts = tree(`040000 tree ${ci}\tci\0`)
    const revision = git('commit-tree', tree(`040000 tree ${scripts}\tscripts\0`), '-m', 'fixture')
    expect(() => loadModuleImpactManifestAtRevision(revision, { cwd: root })).toThrow(
      'Invalid module-impact shard path'
    )
  })

  it('keeps the checked-in registration inline during the reader rollout', () => {
    expect(JSON.parse(readFileSync(moduleImpactRegistrationPath, 'utf8')).modules).toBeDefined()
  })
})
