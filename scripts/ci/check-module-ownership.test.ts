import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkModuleOwnership, moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const source = 'src/main/owned.ts'
const test = 'src/main/owned.test.ts'
const fresh = 'src/main/new.ts'
const manifestPath = 'scripts/ci/module-impact.json'
type Manifest = {
  schemaVersion: number
  modules: Record<
    string,
    {
      fullTestReason?: string
      ownerPaths: string[]
      interfacePaths: string[]
      consumerModules: string[]
      testFiles: { owner: string[]; contract: string[]; consumer: string[] }
      capabilityOverlays: string[]
      fallbackCapability: string
    }
  >
}
const manifest = (): Manifest => ({
  schemaVersion: 1,
  modules: {
    sample: {
      ownerPaths: [source, test],
      interfacePaths: [source],
      consumerModules: [],
      testFiles: { owner: [test], contract: [], consumer: [] },
      capabilityOverlays: [],
      fallbackCapability: 'main_runtime'
    }
  }
})
const files = [source, test, manifestPath]
const check = (overrides: Record<string, unknown> = {}): ReturnType<typeof checkModuleOwnership> =>
  checkModuleOwnership({
    baseManifest: manifest(),
    headManifest: manifest(),
    baseFiles: files,
    headFiles: files,
    changes: [],
    ...overrides
  })

describe('module ownership admission', () => {
  it('accepts explicit ownership with intentional full validation', () => {
    const headManifest = manifest()
    headManifest.modules.sample.fullTestReason = 'Dynamic consumers require full validation'
    headManifest.modules.sample.ownerPaths.push(fresh)
    expect(
      check({
        headManifest,
        headFiles: [...files, fresh],
        changes: [{ path: fresh, status: 'added' }]
      }).ok
    ).toBe(true)
  })

  it.each([
    fresh,
    'src/main/new.test.ts',
    'src/renderer/src/new.tsx',
    'packages/example/new.ts',
    'packages/native/src/new.cc',
    'packages/native/src/new.rs',
    'src/main/notebook/fixture.py',
    'src/main/notebook/fixture.R'
  ])('blocks an unregistered new code file: %s', (path) => {
    expect(
      check({ headFiles: [...files, path], changes: [{ path, status: 'added' }] })
    ).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ path, rule: 'module-ownership-new' })]
    })
  })
  it('accepts registration in the same PR using manifest data', () => {
    const headManifest = manifest()
    headManifest.modules.sample.ownerPaths.push(fresh)
    expect(
      check({
        headManifest,
        headFiles: [...files, fresh],
        changes: [{ path: fresh, status: 'added' }]
      }).ok
    ).toBe(true)
  })
  it('reports existing gaps without blocking changes to them', () => {
    expect(
      check({
        baseFiles: [...files, fresh],
        headFiles: [...files, fresh],
        changes: [{ path: fresh, status: 'modified' }]
      })
    ).toMatchObject({ ok: true, legacyGaps: [fresh] })
  })
  it('does not let interface or consumer membership hide a removed exact owner', () => {
    const headManifest = manifest()
    headManifest.modules.sample.ownerPaths = [test]
    expect(
      check({ headManifest, changes: [{ path: manifestPath, status: 'modified' }] })
    ).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ path: source, rule: 'module-ownership-regression' })
      ])
    })
  })

  it('catches a manifest-only removal even when source files are untouched', () => {
    const headManifest = manifest()
    headManifest.modules.sample.ownerPaths = [fresh]
    headManifest.modules.sample.interfacePaths = [fresh]
    headManifest.modules.sample.testFiles.owner = ['src/main/new.test.ts']
    const all = [...files, fresh, 'src/main/new.test.ts']
    const result = check({
      headManifest,
      baseFiles: all,
      headFiles: all,
      changes: [{ path: manifestPath, status: 'modified' }]
    })
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: source, rule: 'module-ownership-regression' })
      ])
    )
  })
  it('requires a renamed legacy file to acquire ownership', () => {
    const old = 'src/main/legacy.ts'
    expect(
      check({
        baseFiles: [...files, old],
        headFiles: [...files, fresh],
        changes: [{ path: fresh, previousPath: old, status: 'renamed' }]
      }).ok
    ).toBe(false)
  })
  it('allows deletion of historical gaps and ignores non-code/global config inputs', () => {
    expect(
      check({
        baseFiles: [...files, fresh],
        headFiles: [...files, 'package.json', 'README.md'],
        changes: [
          { path: fresh, status: 'deleted' },
          { path: 'package.json', status: 'modified' }
        ]
      }).ok
    ).toBe(true)
  })
  it('accepts a registered rename without retaining a deleted source path', () => {
    const headManifest = manifest()
    headManifest.modules.sample.ownerPaths = [fresh, test]
    headManifest.modules.sample.interfacePaths = [fresh]
    expect(
      check({
        headManifest,
        headFiles: [...files.filter((path) => path !== source), fresh],
        changes: [
          { path: fresh, previousPath: source, status: 'renamed' },
          { path: manifestPath, status: 'modified' }
        ]
      }).ok
    ).toBe(true)
  })

  it('accepts a new module with additional tests and consumer evidence', () => {
    const headManifest = manifest()
    headManifest.modules.feature = {
      ...structuredClone(headManifest.modules.sample),
      ownerPaths: [fresh, 'src/main/new.test.ts'],
      interfacePaths: [fresh],
      testFiles: { owner: ['src/main/new.test.ts'], contract: [], consumer: [] },
      consumerModules: ['sample']
    }
    expect(
      check({
        headManifest,
        headFiles: [...files, fresh, 'src/main/new.test.ts'],
        changes: [
          { path: manifestPath, status: 'modified' },
          { path: fresh, status: 'added' }
        ]
      }).ok
    ).toBe(true)
  })

  it.each(['ownerPaths', 'interfacePaths', 'capabilityOverlays', 'consumerModules'] as const)(
    'rejects removing existing %s even if the module still has tests',
    (field) => {
      const baseManifest = manifest()
      const extra =
        field === 'capabilityOverlays'
          ? 'windows_sensitive'
          : field === 'consumerModules'
            ? 'feature'
            : fresh
      baseManifest.modules.sample[field].push(extra)
      if (field === 'consumerModules') {
        baseManifest.modules.feature = {
          ...structuredClone(baseManifest.modules.sample),
          ownerPaths: [fresh],
          interfacePaths: [fresh],
          consumerModules: []
        }
      }
      const headManifest = structuredClone(baseManifest)
      headManifest.modules.sample[field].pop()
      expect(
        check({
          baseManifest,
          headManifest,
          baseFiles: [...files, fresh],
          headFiles: [...files, fresh]
        }).violations
      ).toContainEqual(
        expect.objectContaining({
          rule: 'module-registration-regression',
          message: expect.stringContaining(field)
        })
      )
    }
  )

  it.each(['owner', 'contract', 'consumer'] as const)(
    'rejects removing a surviving %s test while other tests remain',
    (kind) => {
      const extra = 'src/main/contract.test.ts'
      const baseManifest = manifest()
      baseManifest.modules.sample.testFiles[kind].push(extra)
      const headManifest = structuredClone(baseManifest)
      headManifest.modules.sample.testFiles[kind].pop()
      expect(
        check({
          baseManifest,
          headManifest,
          baseFiles: [...files, extra],
          headFiles: [...files, extra]
        }).ok
      ).toBe(false)
    }
  )

  it('allows removing a test only when it was actually deleted', () => {
    const extra = 'src/main/contract.test.ts'
    const baseManifest = manifest()
    baseManifest.modules.sample.testFiles.contract.push(extra)
    expect(check({ baseManifest, baseFiles: [...files, extra] }).ok).toBe(true)
  })

  it('rejects fallback, full-validation marker and policy metadata changes', () => {
    const headManifest = manifest()
    headManifest.modules.sample.fallbackCapability = 'renderer_view'
    expect(check({ headManifest }).ok).toBe(false)
    const baseManifest = manifest()
    Object.assign(baseManifest.modules.sample, { fullTestReason: 'Shared contract' })
    expect(check({ baseManifest }).ok).toBe(false)
    expect(check({ headManifest: { ...manifest(), untrustedPolicy: true } }).ok).toBe(false)
    const unknown = manifest()
    Object.assign(unknown.modules.sample, { skipTests: true })
    expect(check({ headManifest: unknown }).ok).toBe(false)
  })

  it('rejects newly explicit ownership that hides a colocated owner-test mapping', () => {
    const inferred = 'src/main/inferred.ts'
    const inferredTest = 'src/main/inferred.test.ts'
    const baseManifest = manifest()
    baseManifest.modules.sample.testFiles.owner.push(inferredTest)
    const headManifest = structuredClone(baseManifest)
    headManifest.modules.feature = {
      ...structuredClone(manifest().modules.sample),
      ownerPaths: [inferred],
      interfacePaths: [inferred],
      testFiles: { owner: ['src/main/new.test.ts'], contract: [], consumer: [] }
    }
    const all = [...files, inferred, inferredTest, 'src/main/new.test.ts']
    expect(
      check({ baseManifest, headManifest, baseFiles: all, headFiles: all }).violations
    ).toContainEqual(
      expect.objectContaining({
        rule: 'module-registration-regression',
        message: expect.stringContaining('inferred owner tests')
      })
    )
    headManifest.modules.feature.consumerModules = ['sample']
    expect(check({ baseManifest, headManifest, baseFiles: all, headFiles: all }).ok).toBe(true)
  })

  it('rejects dangling evidence paths and malformed manifests', () => {
    expect(() => check({ headFiles: files.filter((path) => path !== test) })).toThrow(
      'does not exist'
    )
    expect(() => check({ headManifest: {} })).toThrow('schemaVersion')
  })
})

it('reads candidate JSON only and blocks additions through the actual CI Integrity CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'module-ownership-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const put = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  try {
    git('init', '--quiet')
    git('config', 'user.email', 'ci@example.com')
    git('config', 'user.name', 'CI Test')
    for (const path of [source, test]) put(path, 'export {}\n')
    put(manifestPath, JSON.stringify(manifest()))
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    put(fresh, 'throw new Error("candidate code must not execute")\n')
    put(
      'scripts/ci/check-module-ownership.mjs',
      'throw new Error("candidate checker must not execute")\n'
    )
    git('add', '.')
    git('commit', '--quiet', '-m', 'new source')
    const head = git('rev-parse', 'HEAD')
    expect(moduleOwnershipFromRevisions(base, head, { cwd: root }).ok).toBe(false)
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/ci/check-ci-integrity.mjs'), '--base', base, '--head', head],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
    )
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('module-ownership-new')
    expect(result.stderr).not.toContain('candidate checker must not execute')
    const updated = manifest()
    updated.modules.sample.ownerPaths.push(fresh)
    put(manifestPath, JSON.stringify(updated))
    git('add', '.')
    git('commit', '--quiet', '-m', 'register source')
    expect(moduleOwnershipFromRevisions(base, git('rev-parse', 'HEAD'), { cwd: root }).ok).toBe(
      true
    )
    // An attacker cannot disable the new invariant by editing the candidate checker.
    updated.modules.sample.fallbackCapability = 'renderer_view'
    put(manifestPath, JSON.stringify(updated))
    git('add', '.')
    git('commit', '--quiet', '-m', 'weaken fallback')
    const weakened = git('rev-parse', 'HEAD')
    const denied = spawnSync(
      process.execPath,
      [resolve('scripts/ci/check-ci-integrity.mjs'), '--base', base, '--head', weakened],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
    )
    expect(denied.status).toBe(1)
    expect(denied.stdout).toContain('module-registration-regression')
    expect(denied.stderr).not.toContain('candidate checker must not execute')
    // A merge-group commit is evaluated by the same trusted entry point.
    git('checkout', '--quiet', '-b', 'queue', base)
    git('merge', '--quiet', '--no-ff', weakened, '-m', 'queue')
    expect(moduleOwnershipFromRevisions(base, git('rev-parse', 'HEAD'), { cwd: root }).ok).toBe(
      false
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
