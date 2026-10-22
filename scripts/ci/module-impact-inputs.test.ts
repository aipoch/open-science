import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { additiveModuleImpact, resolveModuleImpactInputs } from './module-impact-inputs.mjs'
import { type ModuleImpactManifest } from './load-module-impact.mjs'
import { classifyChanges, platformExecutionPlan } from './classify-pr-changes.mjs'
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
        'package-test-impact.mjs',
        'package-test-boundaries.json',
        'module-impact-inputs.mjs',
        'module-test-impact.mjs',
        'module-graph/policy.mjs',
        'module-graph/boundaries.mjs',
        'module-graph/derived-index.mjs',
        'module-graph/layers.mjs',
        'module-boundaries.json',
        'module-derived-consumers.json',
        'module-ownership-paths.mjs',
        'module-impact-authority.mjs',
        'windows-core-plan.mjs',
        'windows-core-checks.json',
        'module-impact-shadow.mjs',
        'validate-module-impact.mjs'
      ])
        put(`scripts/ci/${file}`, readFileSync(`scripts/ci/${file}`, 'utf8'))
      put('scripts/ci/module-impact.json', '{"schemaVersion":1}')
      const manifest = sample()
      manifest.modules.other = {
        ...structuredClone(manifest.modules.sample),
        ownerPaths: ['src/main/derived.test.ts'],
        interfacePaths: ['src/main/derived.test.ts'],
        testFiles: { owner: ['src/main/derived.test.ts'], contract: [], consumer: [] }
      }
      put('scripts/ci/module-impact/other.json', JSON.stringify(manifest.modules.other))
      put(
        'scripts/ci/module-derived-consumers.json',
        JSON.stringify({
          schemaVersion: 1,
          modules: { sample: ['src/main/derived.test.ts'] }
        })
      )
      put(record, JSON.stringify(manifest.modules.sample))
      for (const path of paths(manifest)) put(path, '// must not execute candidate source')
      const base = commit()
      const candidate = structuredClone(manifest)
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
      put('scripts/ci/module-derived-consumers.json', '{"schemaVersion":1,"modules":{}}')
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
        'src/main/derived.test.ts',
        'src/main/new.test.ts',
        'src/main/newer-main.test.ts',
        'src/main/sample.test.ts'
      ])
      const explain = run('module-test-impact.mjs', ['affected', ...args, '--explain'])
      expect(explain).toContain('Mode: selective')
      expect(explain).toContain('sample -> derived dependency evidence -> src/main/derived.test.ts')
      for (const path of shadow.shadow.testFiles) expect(explain).toContain(path)
    }
  )

  it.each(['pull_request', 'merge_group'])(
    'bounds a registration-only split in %s while rejecting mixed, malformed and nonregular inputs',
    (event) => {
      const cwd = mkdtempSync(join(tmpdir(), 'registration only '))
      roots.push(cwd)
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      const put = (path: string, text: string): void => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), text)
      }
      const commit = (): string => {
        git('add', '.')
        git('commit', '-qm', 'ci(test): record data')
        return git('rev-parse', 'HEAD')
      }
      git('init', '-q')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.test')
      const manifest = sample()
      put('scripts/ci/module-impact.json', '{"schemaVersion":1}')
      const record = 'scripts/ci/module-impact/sample.json'
      put(record, JSON.stringify(manifest.modules.sample))
      for (const path of paths(manifest)) put(path, '// unchanged source')
      const base = commit()
      const split = structuredClone(manifest.modules.sample)
      split.ownerPaths = ['src/main/sample.test.ts']
      split.interfacePaths = ['src/main/sample.test.ts']
      put('scripts/ci/module-impact/child.json', JSON.stringify(split))
      const parent = structuredClone(manifest.modules.sample)
      parent.ownerPaths = ['resources/sample/worker.mjs']
      put(record, JSON.stringify(parent))
      let head = commit()
      const changes = [
        { path: record, status: 'modified' },
        { path: 'scripts/ci/module-impact/child.json', status: 'added' }
      ]
      const resolve = (): ReturnType<typeof resolveModuleImpactInputs> =>
        resolveModuleImpactInputs(changes, { base, head, cwd, manifest })
      const input = resolve()
      expect(input.registrationOnly).toBe(true)
      expect(input.manifest).toEqual(manifest)
      const plan = classifyChanges(changes, undefined, { moduleManifest: input.manifest, ...input })
      expect(platformExecutionPlan(plan, changes, event).bundles).toEqual(['policy', 'static'])
      expect(plan.roots).toEqual(['module_registration'])
      expect(
        createAffectedTestPlan(
          changes,
          graph,
          input.manifest,
          input.registrationModules,
          input.registrationOnly
        ).testFiles
      ).toEqual([])
      // Omitted caller paths cannot disguise a source edit in the actual Git diff.
      put('src/main/sample.test.ts', '// changed test')
      head = commit()
      expect(resolve().registrationOnly).not.toBe(true)
      git('reset', '--hard', base)
      put(record, '{invalid JSON')
      head = commit()
      expect(resolve().registrationOnly).not.toBe(true)
      git('reset', '--hard', base)
      put(record, JSON.stringify({ ...parent, capabilityOverlays: ['unknown-overlay'] }))
      head = commit()
      expect(resolve().registrationOnly).not.toBe(true)
      git('reset', '--hard', base)
      const link = git('hash-object', '-w', '--stdin')
      git('update-index', '--cacheinfo', `120000,${link},${record}`)
      git('commit', '-qm', 'ci(test): nonregular record')
      head = git('rev-parse', 'HEAD')
      expect(resolve().registrationOnly).not.toBe(true)
    }
  )

  describe('regenerated derived consumer index', () => {
    const index = 'scripts/ci/module-derived-consumers.json'
    const source = 'resources/sample/worker.mjs'
    const derivedTest = 'src/main/derived.test.ts'
    const fixture = (): {
      cwd: string
      base: string
      write: (value: unknown) => string
      put: (path: string, value: unknown) => void
    } => {
      const cwd = mkdtempSync(join(tmpdir(), 'derived index '))
      roots.push(cwd)
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      const put = (path: string, value: unknown): void => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value))
      }
      git('init', '--quiet')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      put('scripts/ci/module-impact.json', { schemaVersion: 1 })
      put('scripts/ci/module-impact/sample.json', sample().modules.sample)
      for (const path of paths(sample())) put(path, 'not executable')
      put(derivedTest, 'export {}')
      put(index, { schemaVersion: 1, modules: {} })
      const write = (value: unknown): string => {
        put(index, value)
        put(source, `export const revision = ${Math.random()}`)
        git('add', '.')
        git('commit', '--quiet', '-m', 'ci(test): derived evidence')
        return git('rev-parse', 'HEAD')
      }
      git('add', '.')
      git('commit', '--quiet', '-m', 'ci(test): base')
      return { cwd, base: git('rev-parse', 'HEAD'), write, put }
    }
    const changes = [
      { path: source, status: 'modified' },
      { path: index, status: 'modified' }
    ]
    const resolveAt = (
      f: ReturnType<typeof fixture>,
      head: string,
      trusted = { schemaVersion: 1, modules: { sample: ['src/main/sample.test.ts'] } },
      candidateChanges = changes
    ): ReturnType<typeof resolveModuleImpactInputs> =>
      resolveModuleImpactInputs(candidateChanges, {
        base: f.base,
        head,
        cwd: f.cwd,
        manifest: sample(),
        derivedConsumers: trusted
      })

    it('routes a valid index as additive evidence instead of a global input', () => {
      const f = fixture()
      const inputs = resolveAt(f, f.write({ schemaVersion: 1, modules: { sample: [derivedTest] } }))
      expect(inputs.derivedIndexAccepted).toBe(true)
      expect(inputs.changes).toEqual([changes[0]])
      expect(classifyChanges(changes).mode).toBe('full')
      expect(
        classifyChanges(inputs.changes, undefined, { moduleManifest: inputs.manifest }).mode
      ).toBe('selective')
      const plan = createAffectedTestPlan(inputs.changes, graph, inputs.manifest)
      expect(plan.mode).toBe('selective')
      // Trusted and candidate evidence are both selected; neither replaces the other.
      expect(plan.testFiles).toEqual(
        expect.arrayContaining(['src/main/sample.test.ts', derivedTest])
      )
    })

    it('never lets a candidate index remove trusted evidence', () => {
      const f = fixture()
      const inputs = resolveAt(f, f.write({ schemaVersion: 1, modules: {} }))
      expect(inputs.derivedIndexAccepted).toBe(true)
      expect(createAffectedTestPlan(inputs.changes, graph, inputs.manifest).testFiles).toContain(
        'src/main/sample.test.ts'
      )
    })

    it('drops trusted evidence for a test the head revision deleted', () => {
      const f = fixture()
      const head = f.write({ schemaVersion: 1, modules: {} })
      const inputs = resolveAt(f, head, { schemaVersion: 1, modules: { sample: [derivedTest] } })
      expect(inputs.derivedIndexAccepted).toBe(true)
      expect(createAffectedTestPlan(inputs.changes, graph, inputs.manifest).testFiles).toContain(
        derivedTest
      )

      const deleted = fixture()
      rmSync(join(deleted.cwd, derivedTest))
      const removed = deleted.write({ schemaVersion: 1, modules: {} })
      const pruned = resolveAt(deleted, removed, {
        schemaVersion: 1,
        modules: { sample: [derivedTest] }
      })
      expect(pruned.derivedIndexAccepted).toBe(true)
      expect(
        createAffectedTestPlan(pruned.changes, graph, pruned.manifest).testFiles
      ).not.toContain(derivedTest)
    })

    it.each([
      ['malformed JSON', '{"schemaVersion":1,'],
      ['an unknown module', { schemaVersion: 1, modules: { other: [derivedTest] } }],
      ['an unsafe path', { schemaVersion: 1, modules: { sample: ['../outside.test.ts'] } }],
      ['a non-test path', { schemaVersion: 1, modules: { sample: ['src/main/derived.ts'] } }],
      ['an unexpected key', { schemaVersion: 1, modules: {}, policy: true }]
    ])('keeps global routing for %s', (_, value) => {
      const f = fixture()
      const inputs = resolveAt(f, f.write(value))
      expect(inputs.derivedIndexAccepted).toBeUndefined()
      expect(inputs.changes).toEqual(changes)
      expect(
        classifyChanges(inputs.changes, undefined, { moduleManifest: inputs.manifest }).mode
      ).toBe('full')
    })

    it.each(['added', 'deleted', 'renamed', 'type-changed'])(
      'keeps global routing when the index is %s',
      (status) => {
        const f = fixture()
        const head = f.write({ schemaVersion: 1, modules: { sample: [derivedTest] } })
        const candidate = [changes[0], { path: index, status }]
        expect(resolveAt(f, head, undefined, candidate).changes).toEqual(candidate)
      }
    )

    it('keeps other CI inputs global beside an accepted index', () => {
      const f = fixture()
      const head = f.write({ schemaVersion: 1, modules: { sample: [derivedTest] } })
      const candidate = [...changes, { path: 'scripts/ci/other.mjs', status: 'modified' }]
      const inputs = resolveAt(f, head, undefined, candidate)
      expect(createAffectedTestPlan(inputs.changes, graph, inputs.manifest).mode).toBe('full')
    })

    it('ignores candidate tests that do not exist at head', () => {
      const f = fixture()
      const inputs = resolveAt(
        f,
        f.write({ schemaVersion: 1, modules: { sample: ['src/main/missing.test.ts'] } })
      )
      expect(
        createAffectedTestPlan(inputs.changes, graph, inputs.manifest).testFiles
      ).not.toContain('src/main/missing.test.ts')
    })
  })

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
