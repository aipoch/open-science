import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { additiveModuleImpact, resolveModuleImpactInputs } from './module-impact-inputs.mjs'
import { type ModuleImpactManifest } from './load-module-impact.mjs'
import { classifyChanges } from './classify-pr-changes.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

const sample = (): ModuleImpactManifest => ({
  schemaVersion: 1,
  modules: {
    sample: {
      ownerPaths: ['resources/sample/worker.mjs', 'src/main/sample.test.ts'],
      interfacePaths: ['resources/sample/worker.mjs'],
      testFiles: { owner: ['src/main/sample.test.ts'], contract: [], consumer: [] },
      consumerModules: [],
      capabilityOverlays: ['windows_sensitive'],
      fallbackCapability: 'main_runtime'
    }
  }
})
const graph = { status: 'manifest-only', testFiles: [] }
const paths = (manifest: ModuleImpactManifest): Set<string> =>
  new Set(
    Object.values(manifest.modules).flatMap((m) => [
      ...m.ownerPaths,
      ...m.interfacePaths,
      ...Object.values(m.testFiles).flat()
    ])
  )

describe('trusted additive module registrations', () => {
  it.each([
    'package-lock.json',
    'patches/library.patch',
    'test/config/runtime.test.ts',
    'scripts/ci/other.mjs',
    'scripts/ci/module-impact.json',
    'resources/unregistered.bin'
  ])('retains full validation for %s beside an approved additive record', (path) => {
    const changes = [
      { path, status: 'modified' },
      { path: 'scripts/ci/module-impact/sample.json', status: 'modified' }
    ]
    expect(createAffectedTestPlan(changes, graph, sample(), ['sample']).mode).toBe('full')
  })

  it('preserves destructive routing for registered runtime documentation', () => {
    const manifest = sample()
    manifest.modules.sample.ownerPaths.push('resources/sample/SKILL.md')
    expect(
      classifyChanges([{ path: 'resources/sample/SKILL.md', status: 'deleted' }], undefined, {
        moduleManifest: manifest
      }).mode
    ).toBe('full')
  })

  it('uses portable owner evidence for native tests that require another runner', () => {
    const plan = createAffectedTestPlan(
      [
        {
          path: 'packages/credential-identity-probe-native/test/probe.test.cjs',
          status: 'modified'
        }
      ],
      graph
    )
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).not.toContain(
      'packages/credential-identity-probe-native/test/probe.test.cjs'
    )
    expect(plan.testFiles).toContain('src/main/credential-identity/probe.test.ts')
    expect(plan.capabilityOverlays).toContain('windows_sensitive')
  })

  it('unions new evidence with newer trusted-main evidence without mutating inputs', () => {
    const base = sample()
    const head = sample()
    head.modules.sample.ownerPaths.push('resources/sample/helper.mjs', 'src/main/new.test.ts')
    head.modules.sample.testFiles.owner.push('src/main/new.test.ts')
    const trusted = sample()
    trusted.modules.sample.testFiles.consumer.push('src/main/newer-main.test.ts')
    const resolved = additiveModuleImpact(base, head, trusted, paths(base), paths(head))!
    expect(resolved.modules.sample.testFiles).toEqual({
      owner: ['src/main/sample.test.ts', 'src/main/new.test.ts'],
      contract: [],
      consumer: ['src/main/newer-main.test.ts']
    })
    expect(trusted.modules.sample.ownerPaths).toEqual(base.modules.sample.ownerPaths)
    const changes = [
      { path: 'resources/sample/helper.mjs', status: 'added' },
      { path: 'scripts/ci/module-impact/sample.json', status: 'modified' }
    ]
    const plan = createAffectedTestPlan(changes, graph, resolved, ['sample'])
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toContain('src/main/new.test.ts')
    expect(plan.testFiles).toContain('src/main/newer-main.test.ts')
    expect(plan.capabilityOverlays).toContain('windows_sensitive')
    expect(
      classifyChanges(changes, undefined, {
        moduleManifest: resolved,
        registrationModules: ['sample']
      }).mode
    ).toBe('selective')
  })

  it('preserves newer trusted policy when a stale candidate only adds evidence', () => {
    const base = sample()
    const head = sample()
    head.modules.sample.testFiles.consumer.push('src/main/added.test.ts')
    const trusted = sample()
    trusted.modules.sample.capabilityOverlays.push('notebook_network_sandbox')
    const changes = [{ path: 'scripts/ci/module-impact/sample.json', status: 'modified' }]
    const resolved = additiveModuleImpact(base, head, trusted, paths(base), paths(head))!
    expect(
      classifyChanges(changes, undefined, {
        moduleManifest: resolved,
        registrationModules: ['sample']
      }).lanes
    ).toContain('linux_runtime')
    trusted.modules.sample.fullTestReason = 'Newly discovered dynamic consumers'
    const stricter = additiveModuleImpact(base, head, trusted, paths(base), paths(head))!
    const plan = createAffectedTestPlan(changes, graph, stricter, ['sample'])
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains.join('\n')).toContain('Newly discovered dynamic consumers')
  })

  it.each([
    ['owner removal', (m: ModuleImpactManifest) => m.modules.sample.ownerPaths.pop()],
    [
      'interface removal',
      (m: ModuleImpactManifest) => {
        m.modules.sample.interfacePaths = ['src/main/replacement.ts']
      }
    ],
    [
      'test removal',
      (m: ModuleImpactManifest) => {
        m.modules.sample.testFiles.owner = ['src/main/replacement.test.ts']
      }
    ],
    ['overlay removal', (m: ModuleImpactManifest) => m.modules.sample.capabilityOverlays.pop()],
    [
      'fallback change',
      (m: ModuleImpactManifest) => {
        m.modules.sample.fallbackCapability = 'documentation'
      }
    ],
    [
      'full marker',
      (m: ModuleImpactManifest) => {
        m.modules.sample.fullTestReason = 'new policy'
      }
    ],
    [
      'unknown policy',
      (m: ModuleImpactManifest) => Object.assign(m.modules.sample, { skipTests: true })
    ],
    [
      'new module',
      (m: ModuleImpactManifest) => {
        m.modules.other = { ...structuredClone(m.modules.sample), ownerPaths: ['src/other.ts'] }
      }
    ]
  ])('does not authorize %s through the data exception', (_, mutate) => {
    const base = sample()
    const head = sample()
    mutate(head)
    expect(additiveModuleImpact(base, head, base, paths(base), paths(head))).toBeNull()
  })

  it('rejects reassigning an existing inferred path or dropping a full marker', () => {
    const base = sample()
    const head = sample()
    head.modules.sample.ownerPaths.push('src/main/existing.ts')
    expect(
      additiveModuleImpact(
        base,
        head,
        base,
        new Set([...paths(base), 'src/main/existing.ts']),
        paths(head)
      )
    ).toBeNull()
    base.modules.sample.fullTestReason = 'Dynamic contract'
    expect(additiveModuleImpact(base, sample(), base, paths(base), paths(base))).toBeNull()
  })

  it('keeps shared-contract edits full but does not inherit the marker just by selecting consumer evidence', () => {
    const manifest = sample()
    manifest.modules.shared = {
      ...sample().modules.sample,
      ownerPaths: ['src/shared/contract.ts'],
      interfacePaths: ['src/shared/contract.ts'],
      testFiles: { owner: ['src/shared/contract.test.ts'], contract: [], consumer: [] },
      fullTestReason: 'Cross-process contract'
    }
    manifest.modules.sample.consumerModules = ['shared']
    const plan = createAffectedTestPlan(
      [{ path: 'resources/sample/worker.mjs', status: 'modified' }],
      graph,
      manifest
    )
    expect(plan.mode).toBe('selective')
    expect(plan.modules).toContain('shared')
    expect(plan.testFiles).toContain('src/shared/contract.test.ts')
    expect(
      createAffectedTestPlan(
        [{ path: 'src/shared/contract.ts', status: 'modified' }],
        graph,
        manifest
      ).mode
    ).toBe('full')
  })

  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
  it.each(['pull_request', 'merge_group'])(
    'uses real trusted extraction and the same additive plan for %s authority and execution',
    (event) => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'module authority ')))
      roots.push(cwd)
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      const put = (path: string, value: string): void => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), value)
      }
      const commit = (): string => {
        git('add', '.')
        git('commit', '--quiet', '-m', 'ci(test): record data')
        return git('rev-parse', 'HEAD')
      }
      const record = 'scripts/ci/module-impact/sample.json'
      git('init', '--quiet')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      for (const file of [
        'classify-pr-changes.mjs',
        'change-impact.json',
        'load-module-impact.mjs',
        'module-impact-inputs.mjs',
        'module-test-impact.mjs',
        'module-impact-authority.mjs',
        'module-impact-shadow.mjs',
        'validate-module-impact.mjs'
      ])
        put(`scripts/ci/${file}`, readFileSync(`scripts/ci/${file}`, 'utf8'))
      put('scripts/ci/module-impact.json', '{"schemaVersion":1}')
      const manifest = sample()
      put(record, JSON.stringify(manifest.modules.sample))
      for (const path of paths(manifest)) put(path, '// must not execute candidate source')
      const base = commit()
      const candidate = sample()
      candidate.modules.sample.ownerPaths.push('resources/sample/new.mjs', 'src/main/new.test.ts')
      candidate.modules.sample.testFiles.owner.push('src/main/new.test.ts')
      put(record, JSON.stringify(candidate.modules.sample))
      for (const path of paths(candidate)) put(path, '// must not execute candidate source')
      const head = commit()
      git('checkout', '--quiet', '-b', 'newer-main', base)
      manifest.modules.sample.ownerPaths.push('src/main/newer-main.test.ts')
      manifest.modules.sample.testFiles.consumer.push('src/main/newer-main.test.ts')
      put(record, JSON.stringify(manifest.modules.sample))
      put('src/main/newer-main.test.ts', '// newer trusted-main evidence')
      const trusted = commit()
      // The extractor must read Git blobs, not a potentially modified checkout.
      put('scripts/ci/module-impact-inputs.mjs', 'throw new Error("untrusted checkout")')
      const workflow = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
        jobs: { preflight: { steps: Array<{ id?: string; run?: string }> } }
      }
      const prepare = workflow.jobs.preflight.steps.find(
        (step) => step.id === 'trusted_classifier'
      )!
      const env = {
        ...process.env,
        BASE_SHA: trusted,
        RUNNER_TEMP: cwd,
        GITHUB_OUTPUT: join(cwd, 'outputs')
      }
      const prepared = spawnSync('bash', ['-c', prepare.run!], { cwd, env, encoding: 'utf8' })
      expect(prepared.status, prepared.stderr).toBe(0)
      const run = (file: string, args: string[]): string =>
        execFileSync(process.execPath, [join(cwd, 'pr-gate-trusted-classifier', file), ...args], {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, EVENT_NAME: event, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' }
        })
      const args = ['--base', base, '--head', head]
      const plan = JSON.parse(run('module-impact-authority.mjs', args))
      expect(plan.mode).toBe('selective')
      expect(plan.roots).toContain('module:sample')
      expect(plan.lanes).toContain('windows_runtime')
      const shadow = JSON.parse(
        run('module-impact-shadow.mjs', [...args, '--authoritative-plan', JSON.stringify(plan)])
      )
      expect(shadow.shadow.testFiles).toEqual([
        'src/main/new.test.ts',
        'src/main/newer-main.test.ts',
        'src/main/sample.test.ts'
      ])
      const explain = run('module-test-impact.mjs', ['affected', ...args, '--explain'])
      expect(explain).toContain('Mode: selective')
      for (const path of shadow.shadow.testFiles) expect(explain).toContain(path)
    }
  )

  it('reads committed blobs and fails closed on unsafe revisions without executing candidate code', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'module input '))
    roots.push(cwd)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const put = (path: string, value: unknown): void => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true })
      writeFileSync(join(cwd, path), JSON.stringify(value))
    }
    const commit = (): string => {
      git('add', '.')
      git('commit', '--quiet', '-m', 'ci(test): record data')
      return git('rev-parse', 'HEAD')
    }
    git('init', '--quiet')
    git('config', 'user.email', 'ci@example.com')
    git('config', 'user.name', 'CI Test')
    const manifest = sample()
    put('scripts/ci/module-impact.json', { schemaVersion: 1 })
    put('scripts/ci/module-impact/sample.json', manifest.modules.sample)
    for (const path of paths(manifest)) put(path, 'not executable')
    const base = commit()
    const headManifest = sample()
    headManifest.modules.sample.ownerPaths.push('resources/sample/new.mjs', 'src/main/new.test.ts')
    headManifest.modules.sample.testFiles.owner.push('src/main/new.test.ts')
    for (const path of paths(headManifest)) put(path, 'not executable')
    put('scripts/ci/module-impact/sample.json', headManifest.modules.sample)
    const head = commit()
    // Working-tree/candidate JavaScript must not participate in trusted selection.
    put('scripts/ci/module-impact/sample.json', null)
    put('scripts/ci/load-module-impact.mjs', 'throw new Error("untrusted")')
    const changes = [{ path: 'scripts/ci/module-impact/sample.json', status: 'modified' }]
    const inputs = resolveModuleImpactInputs(changes, { base, head, cwd, manifest })
    expect(inputs.registrationModules).toEqual(['sample'])
    expect(inputs.manifest).toEqual(headManifest)
    expect(
      createAffectedTestPlan(changes, graph, inputs.manifest, inputs.registrationModules).testFiles
    ).toContain('src/main/new.test.ts')
    expect(
      resolveModuleImpactInputs(changes, { base, head: commit(), cwd, manifest })
        .registrationModules
    ).toEqual([])
    for (const status of ['added', 'deleted', 'renamed', 'type-changed']) {
      expect(
        resolveModuleImpactInputs([{ ...changes[0], status }], { base, head, cwd, manifest })
          .registrationModules
      ).toEqual([])
    }
  })
})
