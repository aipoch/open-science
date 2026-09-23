import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { macosGroupsForPlan } from './classify-pr-changes.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'

type Step = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  env?: Record<string, string>
  if?: string
  name?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'runs-on'?: string
  strategy?: {
    'fail-fast'?: boolean
    matrix?: { shard?: number[] | string; group?: string[] | string }
  }
  steps?: Step[]
  'timeout-minutes'?: number
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: {
    merge_group?: { types?: string[] }
    pull_request?: { branches?: string[]; 'paths-ignore'?: string[]; types?: string[] }
    workflow_dispatch?: unknown
  }
  permissions?: Record<string, string>
}

type DependabotUpdate = {
  'commit-message'?: { prefix?: string }
  directory?: string
  groups?: Record<
    string,
    { 'applies-to'?: string; 'dependency-type'?: string; patterns?: string[] }
  >
  'open-pull-requests-limit'?: number
  'package-ecosystem'?: string
  'pull-request-branch-name'?: {
    'branch-name-case'?: string
    prefix?: string
    template?: string
  }
}

const workflowText = readFileSync(join(process.cwd(), '.github/workflows/pr-gate.yml'), 'utf8')
const workflow = load(workflowText) as Workflow
const dependabot = load(readFileSync(join(process.cwd(), '.github/dependabot.yml'), 'utf8')) as {
  updates: DependabotUpdate[]
}
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/ci/change-impact.json'), 'utf8')
) as { bundleOrder: string[]; laneBundles: Record<string, string>; laneOrder: string[] }

describe('PR Gate workflow', () => {
  it('rejects module dry-runs against changed application code while allowing CI-only fixes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'module-coverage-source-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const revisions = workflow.jobs.preflight.steps?.find(({ id }) => id === 'revisions')
    try {
      git('init', '--quiet')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      writeFileSync(join(cwd, 'app.ts'), 'export const value = 1\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'application baseline')
      const comparisonHead = git('rev-parse', 'HEAD')
      mkdirSync(join(cwd, 'scripts/ci'), { recursive: true })
      writeFileSync(join(cwd, 'scripts/ci/runner.mjs'), '// updated runner\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'CI-only fix')
      const env = {
        ...process.env,
        EVENT_NAME: 'workflow_dispatch',
        DRY_RUN_MODE: 'module-coverage',
        INPUT_COMPARISON_BASE_SHA: comparisonHead,
        INPUT_COMPARISON_HEAD_SHA: comparisonHead,
        GITHUB_OUTPUT: join(cwd, 'output')
      }
      const matching = spawnSync('bash', ['-c', revisions!.run!], { cwd, env, encoding: 'utf8' })
      expect(matching.status, matching.stderr).toBe(0)
      writeFileSync(join(cwd, 'app.ts'), 'export const value = 2\n')
      git('add', 'app.ts')
      git('commit', '--quiet', '-m', 'different application')
      const mismatched = spawnSync('bash', ['-c', revisions!.run!], { cwd, env, encoding: 'utf8' })
      expect(mismatched.status).toBe(1)
      expect(mismatched.stderr).toContain('must match comparison head outside CI files')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('replays explicit module dry-run revisions through the real revision and plan scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'module-coverage-plan-'))
    // Mirror the revisions step fallback: shallow or single-commit checkouts have no parent, so
    // compare HEAD against itself instead of failing the whole suite.
    const parent = spawnSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' })
    const base = (
      parent.status === 0
        ? parent.stdout
        : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
    ).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const revisions = workflow.jobs.preflight.steps?.find(({ id }) => id === 'revisions')
    const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
    const output = join(dir, 'output')
    const env = {
      ...process.env,
      EVENT_NAME: 'workflow_dispatch',
      DRY_RUN_MODE: 'module-coverage',
      INPUT_COMPARISON_BASE_SHA: base,
      INPUT_COMPARISON_HEAD_SHA: head,
      GITHUB_OUTPUT: output
    }
    try {
      const resolved = spawnSync('bash', ['-c', revisions!.run!], { env, encoding: 'utf8' })
      expect(resolved.status, resolved.stderr).toBe(0)
      expect(readFileSync(output, 'utf8')).toContain(`base=${base}\nhead=${head}`)
      const planned = spawnSync('bash', ['-c', classify!.run!], { env, encoding: 'utf8' })
      expect(planned.status, planned.stderr).toBe(0)
      const planLine = readFileSync(output, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('plan='))!
      expect(JSON.parse(planLine.slice(5))).toMatchObject({
        mode: 'selective',
        macosProfile: 'smoke',
        lanes: ['policy', 'unit_macos'],
        bundles: ['policy', 'unit']
      })
      const invalid = spawnSync('bash', ['-c', revisions!.run!], {
        env: { ...env, INPUT_COMPARISON_HEAD_SHA: '--bad-revision' },
        encoding: 'utf8'
      })
      expect(invalid.status).toBe(1)
      expect(invalid.stderr).toContain('Preflight revisions must be full Git commit SHAs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs affected module coverage in the existing portable shards before enforcing merged thresholds', () => {
    const shards = workflow.jobs.unit_shard
    for (const event of ['pull_request', 'merge_group']) {
      expect(shards.if).toContain(`github.event_name == '${event}'`)
    }
    const selected = shards.steps?.find(({ id }) => id === 'unit_macos_related_shard')
    expect(selected?.run).toContain('npm run test:affected')
    expect(selected?.run).toContain('--coverage-changed "$BASE_SHA" --')
    expect(selected?.run).toContain('--shard=${{ matrix.shard }}/4')
    expect(selected?.run).toContain('--reporter=dot')
    expect(selected?.run).toContain('--reporter=blob')
    expect(shards.env?.VITEST_DEFER_COVERAGE_THRESHOLDS).toBe('1')
    const merge = workflow.jobs.unit.steps?.find(({ id }) => id === 'unit_macos_related_merge')
    expect(merge?.run).toContain('--coverage-changed "$BASE_SHA" -- --merge-reports=vitest-reports')
    expect(workflow.jobs.unit.env?.VITEST_DEFER_COVERAGE_THRESHOLDS).toBeUndefined()
    const serial = workflow.jobs.unit.steps?.find(({ id }) => id === 'unit_macos_related')
    expect(serial?.if).toContain("needs.unit_shard.result == 'skipped'")
    const enforce = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Enforce selected unit checks'
    )
    const result = spawnSync('bash', ['-c', enforce!.run!], {
      env: {
        ...process.env,
        UNIT_MACOS_FULL_OUTCOME: 'skipped',
        UNIT_MACOS_RELATED_OUTCOME: 'skipped',
        UNIT_MACOS_RELATED_MERGE_OUTCOME: 'failure',
        UNIT_MACOS_SHARDS_RESULT: 'success'
      },
      encoding: 'utf8'
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unit_macos_related_merge ended with failure')
  })

  it('retains trusted legacy extraction when the base predates the optional reader', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-gate-legacy-')))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      mkdirSync(join(root, 'scripts/ci'), { recursive: true })
      for (const file of [
        'module-impact-authority.mjs',
        'module-impact-shadow.mjs',
        'module-test-impact.mjs',
        'module-impact.json',
        'validate-module-impact.mjs',
        'classify-pr-changes.mjs',
        'change-impact.json'
      ])
        writeFileSync(
          join(root, 'scripts/ci', file),
          file.endsWith('.json') ? '{}' : 'process.stdout.write("trusted legacy")\n'
        )
      git('init', '--quiet')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      git('add', '.')
      git('commit', '--quiet', '-m', 'legacy base')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(
        join(root, 'scripts/ci/load-module-impact.mjs'),
        'throw new Error("candidate reader")'
      )
      const output = join(root, 'outputs')
      const prepare = workflow.jobs.preflight.steps!.find(({ id }) => id === 'trusted_classifier')!
      const result = spawnSync('bash', ['-c', prepare.run!], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, BASE_SHA: base, RUNNER_TEMP: root, GITHUB_OUTPUT: output }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(output, 'utf8')).toContain('source=base')
      expect(existsSync(join(root, 'pr-gate-trusted-classifier/load-module-impact.mjs'))).toBe(
        false
      )
      expect(
        execFileSync(
          process.execPath,
          [join(root, 'pr-gate-trusted-classifier/module-impact-authority.mjs')],
          { encoding: 'utf8' }
        )
      ).toBe('trusted legacy')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'pull_request',
    'merge_group',
    'merge_group_stacked',
    'deleted',
    'renamed',
    'ci-edit',
    'unrelated',
    'sharded'
  ])(
    'resolves actual Git history without mixing trusted policy and PR differences: %s',
    (scenario) => {
      const queued = scenario.startsWith('merge_group')
      const event = queued ? 'merge_group' : 'pull_request'
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-gate-revisions-')))
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
      const put = (path: string, contents: string): void => {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), contents)
      }
      const source = 'src/main/connectors/descriptors/cancer-models.ts'
      const test = 'src/main/connectors/descriptors/cancer-models.test.ts'
      try {
        git('init', '--quiet', '-b', 'main')
        git('config', 'user.email', 'ci@example.com')
        git('config', 'user.name', 'CI Test')
        for (const name of [
          'module-impact-authority.mjs',
          'module-impact-shadow.mjs',
          'module-test-impact.mjs',
          'module-impact.json',
          'load-module-impact.mjs',
          'validate-module-impact.mjs',
          'classify-pr-changes.mjs',
          'change-impact.json'
        ]) {
          put(
            `scripts/ci/${name}`,
            name === 'module-impact.json'
              ? JSON.stringify(loadModuleImpactManifest())
              : readFileSync(`scripts/ci/${name}`, 'utf8')
          )
        }
        if (scenario === 'sharded') {
          const registered = loadModuleImpactManifest()
          put('scripts/ci/module-impact.json', JSON.stringify({ schemaVersion: 1 }))
          for (const [id, module] of Object.entries(registered.modules)) {
            put(`scripts/ci/module-impact/${id}.json`, JSON.stringify(module))
          }
        }
        put(source, 'export const value = 1\n')
        put(test, '// initial contract\n')
        git('add', '.')
        git('commit', '--quiet', '-m', 'common ancestor')
        const ancestor = git('rev-parse', 'HEAD')
        put('.github/workflows/pr-gate.yml', '# base-only CI update\n')
        put(
          'scripts/ci/classify-pr-changes.mjs',
          readFileSync('scripts/ci/classify-pr-changes.mjs', 'utf8') +
            '\n// current trusted policy\n'
        )
        git('add', '.')
        git('commit', '--quiet', '-m', 'advance main')
        const base = git('rev-parse', 'HEAD')
        if (scenario === 'unrelated') {
          git('checkout', '--quiet', '--orphan', 'topic')
          git('rm', '-rf', '.')
        } else {
          git('checkout', '--quiet', '-b', 'topic', ancestor)
        }
        if (scenario === 'deleted') git('rm', source)
        else if (scenario === 'renamed')
          git('mv', source, source.replace('cancer-models', 'renamed-cancer-models'))
        else if (scenario === 'ci-edit') put('.github/workflows/pr-gate.yml', '# PR CI update\n')
        else {
          put(source, 'export const value = 2\n')
          put(test, '// changed contract\n')
        }
        git('add', '.')
        git('commit', '--quiet', '-m', 'PR contribution')
        let head = git('rev-parse', 'HEAD')
        if (queued) {
          // GitHub builds the queue head on the target tip plus every entry ahead in the queue.
          git('checkout', '--quiet', '-b', 'gh-readonly-queue/main/pr-1', base)
          if (scenario === 'merge_group_stacked') {
            put('.github/workflows/pr-gate.yml', '# CI update from the entry ahead\n')
            git('add', '.')
            git('commit', '--quiet', '-m', 'entry ahead in queue')
          }
          git('merge', '--quiet', '--no-ff', '-m', 'queue merge', 'topic')
          head = git('rev-parse', 'HEAD')
          git('remote', 'add', 'origin', root)
        }
        const revisionStep = workflow.jobs.preflight.steps!.find(({ id }) => id === 'revisions')!
        const output = join(root, 'outputs')
        const result = spawnSync('bash', ['-c', revisionStep.run!], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            EVENT_NAME: event,
            PULL_BASE_SHA: base,
            PULL_HEAD_SHA: head,
            MERGE_BASE_REF: 'refs/heads/main',
            MERGE_HEAD_SHA: head,
            GITHUB_OUTPUT: output
          }
        })
        if (scenario === 'unrelated') {
          expect(result.status).not.toBe(0)
          expect(existsSync(output)).toBe(false)
          return
        }
        expect(result.status, result.stderr).toBe(0)
        const revisions = Object.fromEntries(
          readFileSync(output, 'utf8')
            .trim()
            .split('\n')
            .map((line) => line.split('='))
        )
        // Queue runs classify the whole group against the target tip, never against the entry ahead.
        expect(revisions).toEqual({
          base: queued ? base : ancestor,
          head,
          'trusted-base': base
        })
        const prepare = workflow.jobs.preflight.steps!.find(
          ({ id }) => id === 'trusted_classifier'
        )!
        expect(prepare.env!.BASE_SHA).toBe('${{ steps.revisions.outputs.trusted-base }}')
        const prepared = spawnSync('bash', ['-c', prepare.run!], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASE_SHA: revisions['trusted-base'],
            RUNNER_TEMP: root,
            GITHUB_OUTPUT: output
          }
        })
        expect(prepared.status, prepared.stderr).toBe(0)

        expect(
          readFileSync(join(root, 'pr-gate-trusted-classifier/classify-pr-changes.mjs'), 'utf8')
        ).toContain('// current trusted policy')
        expect(
          loadModuleImpactManifest(join(root, 'pr-gate-trusted-classifier/module-impact.json'))
        ).toEqual(loadModuleImpactManifest())
        const classified = spawnSync(
          process.execPath,
          [
            join(root, 'pr-gate-trusted-classifier/module-impact-authority.mjs'),
            '--base',
            revisions.base,
            '--head',
            revisions.head
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              EVENT_NAME: event,
              PR_GATE_PLATFORM_POLICY: 'risk-v1',
              GITHUB_OUTPUT: '',
              GITHUB_STEP_SUMMARY: ''
            }
          }
        )
        expect(classified.status, classified.stderr).toBe(0)
        const plan = JSON.parse(classified.stdout)
        if (['pull_request', 'merge_group', 'sharded'].includes(scenario)) {
          expect(git('diff', '--name-only', revisions.base, head).split('\n')).toEqual([
            test,
            source
          ])
          expect(plan.mode).toBe('selective')
          expect(plan.macosProfile).toBe('smoke')
        } else {
          expect(plan.mode).toBe('full')
          expect(plan.roots).toContain(
            ['ci-edit', 'merge_group_stacked'].includes(scenario)
              ? 'global_gate_input'
              : 'destructive_change'
          )
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('includes portable Session journeys in both native functional lanes', () => {
    const { scripts } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const platform of ['macos', 'windows']) {
      const command = workflow.jobs[`${platform}_e2e`].steps?.find(
        ({ id }) => id === `e2e_functional_${platform}`
      )?.run
      const script = command?.match(/^npm run (\S+)/)?.[1]
      expect(script, `${platform} functional lane must invoke a registered script`).toBeDefined()
      for (const spec of [
        'e2e/session-package.spec.ts',
        'e2e/session-package-drop.spec.ts',
        'e2e/session-fork.spec.ts'
      ])
        expect(
          scripts[script!]?.split(/\s+/),
          `${platform} must exercise Session packages`
        ).toContain(spec)
    }
  })

  it('keeps release certification and Linux E2E out of ordinary pull requests', () => {
    expect(workflow.jobs).not.toHaveProperty('linux_e2e')
    expect(manifest.bundleOrder).not.toContain('linux_e2e')
    expect(
      manifest.laneOrder.some((lane) => lane.startsWith('e2e_') && lane.endsWith('_linux'))
    ).toBe(false)
    expect(
      manifest.laneOrder.some((lane) =>
        /^e2e_(storage_migration|provider_bridge|notebook_lifecycle|remote_pairing|artifact_provenance)_/.test(
          lane
        )
      )
    ).toBe(false)

    const windowsRuns = workflow.jobs.windows_e2e.steps?.map(({ run }) => run).filter(Boolean) ?? []
    expect(windowsRuns).not.toContain('npm run test:e2e:visual')
    expect(windowsRuns).not.toContain('node scripts/ci/run-selected-release-e2e.mjs')

    const macosRuns = workflow.jobs.macos_e2e.steps?.map(({ run }) => run).filter(Boolean) ?? []
    expect(macosRuns).not.toContain('node scripts/ci/run-selected-release-e2e.mjs')
  })

  it('is the only repository-owned pull request quality workflow', () => {
    for (const legacyWorkflow of [
      'pr-check.yml',
      'windows-path-portability.yml',
      'commit-message-check.yml'
    ]) {
      expect(
        existsSync(join(process.cwd(), '.github/workflows', legacyWorkflow)),
        `${legacyWorkflow} must not duplicate PR Gate`
      ).toBe(false)
    }
  })

  it('always emits the same gate without workflow-level path exclusions', () => {
    expect(workflow.on?.pull_request).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']
    })
    expect(workflow.on?.pull_request?.['paths-ignore']).toBeUndefined()
    expect(workflow.on?.merge_group).toEqual({ types: ['checks_requested'] })
    expect(workflow.on?.workflow_dispatch).toEqual({
      inputs: {
        dry_run: {
          description: 'Focused no-side-effect validation plan',
          required: false,
          default: 'classified',
          type: 'choice',
          options: [
            'classified',
            'unit-coverage',
            'module-coverage',
            'i18n',
            'runtime-bundle',
            'windows-e2e',
            'windows-process',
            'e2e',
            'source-regressions',
            'macos-smoke'
          ]
        },
        comparison_base_sha: {
          description: 'Test-selection diff base for module-coverage (full SHA; runs dispatch ref)',
          type: 'string'
        },
        comparison_head_sha: {
          description:
            'Test-selection diff head (full SHA; only CI files may differ from dispatch ref)',
          type: 'string'
        }
      }
    })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    expect(workflow.concurrency).toEqual({
      group:
        'pr-gate-${{ github.event.pull_request.number || github.event.merge_group.head_ref || github.ref }}',
      'cancel-in-progress': true
    })
  })

  it('fans semantic lanes into the declared runner bundles', () => {
    expect(workflow.jobs.preflight.outputs).toEqual({
      base: '${{ steps.revisions.outputs.base }}',
      head: '${{ steps.revisions.outputs.head }}',
      lanes: '${{ steps.classify.outputs.lanes }}',
      plan: '${{ steps.classify.outputs.plan }}'
    })

    for (const bundle of manifest.bundleOrder) {
      expect(workflow.jobs[bundle], `missing job for ${bundle}`).toBeDefined()
      expect(
        Array.isArray(workflow.jobs[bundle].needs)
          ? workflow.jobs[bundle].needs
          : [workflow.jobs[bundle].needs]
      ).toContain('preflight')
      expect(workflow.jobs[bundle].if).toContain("needs.preflight.result == 'success'")
      expect(workflow.jobs[bundle].if).toContain(`'${bundle}'`)
    }

    for (const lane of manifest.laneOrder) {
      if (manifest.bundleOrder.includes(lane)) continue
      expect(workflow.jobs[lane], `lane ${lane} must execute through its bundle`).toBeUndefined()
    }
  })

  it('does not make the renderer layout pilot an unrelated blocking check', () => {
    const macos = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Run renderer layout pilot'
    )
    const windows = workflow.jobs.windows_e2e.steps?.find(
      ({ name }) => name === 'Run renderer layout pilot'
    )

    expect(macos?.if).toContain(
      "contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_visual_macos')"
    )
    expect(windows?.if).toContain(
      "contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_browser_windows')"
    )
    expect(windows?.if).toContain("steps.setup.outcome == 'success'")
    expect(windows?.run).toContain('--shard=${{ matrix.shard }}/3')
  })

  it('lets retries absorb flakes on PR and merge-queue business E2E while scheduled regressions stay strict', () => {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '', `${jobId}/${step.id ?? step.name}`).not.toContain(
          '--fail-on-flaky-tests'
        )
      }
    }
    for (const strict of [
      '.github/actions/source-regression/action.yml',
      '.github/workflows/source-regression.yml'
    ]) {
      expect(readFileSync(join(process.cwd(), strict), 'utf8'), strict).toContain(
        '--fail-on-flaky-tests'
      )
    }
  })

  it('requires the Windows browser suite only when its lane is selected', () => {
    const enforce = workflow.jobs.windows_e2e.steps?.find(
      ({ name }) => name === 'Enforce selected Windows E2E checks'
    )
    expect(enforce?.env).toMatchObject({
      E2E_BROWSER_SELECTED:
        "${{ contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_browser_windows') }}",
      RENDERER_LAYOUT_OUTCOME: '${{ steps.renderer_layout.outcome }}'
    })
    expect(enforce?.run).toContain('check renderer_layout "$RENDERER_LAYOUT_OUTCOME"')
    const baseline = {
      ...process.env,
      SETUP_OUTCOME: 'success',
      E2E_FUNCTIONAL_OUTCOME: 'skipped',
      E2E_WORKSPACE_OUTCOME: 'skipped'
    }
    for (const [selected, outcome, code] of [
      ['true', 'success', 0],
      ['true', 'skipped', 1],
      ['true', 'failure', 1],
      ['true', '', 1],
      ['false', 'skipped', 0],
      ['false', 'success', 0],
      ['false', 'failure', 1],
      ['false', 'cancelled', 1]
    ] as const) {
      const result = spawnSync('bash', ['-c', enforce!.run!], {
        env: { ...baseline, E2E_BROWSER_SELECTED: selected, RENDERER_LAYOUT_OUTCOME: outcome },
        encoding: 'utf8'
      })
      expect(result.status, `selected=${selected} outcome=${outcome}`).toBe(code)
    }
  })

  it('plans with the trusted base classifier and fails closed during bootstrap', () => {
    const prepare = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Prepare trusted classifier'
    )
    const classify = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Classify change impact'
    )

    expect(prepare?.run).toContain('git show "${BASE_SHA}:${file}"')
    expect(prepare?.run).toContain('source=bootstrap')
    expect(classify?.env).toMatchObject({
      DRY_RUN_MODE: "${{ inputs.dry_run || 'classified' }}",
      EVENT_NAME: '${{ github.event_name }}',
      TRUSTED_CLASSIFIER_DIR: '${{ steps.trusted_classifier.outputs.dir }}',
      TRUSTED_CLASSIFIER_SOURCE: '${{ steps.trusted_classifier.outputs.source }}'
    })
    expect(classify?.run).toContain(
      '[[ "$EVENT_NAME" == "workflow_dispatch" && "$DRY_RUN_MODE" == "unit-coverage" ]]'
    )
    expect(classify?.run).toContain(
      '[[ "$EVENT_NAME" == "workflow_dispatch" && "$DRY_RUN_MODE" == "i18n" ]]'
    )
    expect(classify?.run).toContain(
      '[[ "$EVENT_NAME" == "workflow_dispatch" && "$DRY_RUN_MODE" == "runtime-bundle" ]]'
    )
    expect(classify?.run).toContain('"lanes":["policy","unit_macos"]')
    expect(classify?.run).toContain('"bundles":["policy","unit"]')
    expect(classify?.run).toContain('"lanes":["policy","i18n"]')
    expect(classify?.run).toContain('"bundles":["policy","static"]')
    expect(classify?.run).toContain(
      'node "$TRUSTED_CLASSIFIER_DIR/module-impact-authority.mjs" --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
    expect(classify?.run).toContain("mode: 'full'")
    expect(classify?.run).toContain("'runtime_bundle'")
    expect(classify?.run).not.toContain(
      'node scripts/ci/classify-pr-changes.mjs --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
  })

  it.each(['pull_request', 'workflow_dispatch'])(
    'bootstraps a full plan without PR desktop bundles for %s',
    (event) => {
      const dir = mkdtempSync(join(tmpdir(), 'pr-gate-bootstrap-'))
      try {
        const output = join(dir, 'output')
        const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
        const run = spawnSync('bash', ['-eu', '-c', classify!.run!], {
          env: {
            ...process.env,
            EVENT_NAME: event,
            DRY_RUN_MODE: 'classified',
            TRUSTED_CLASSIFIER_SOURCE: 'bootstrap',
            TRUSTED_CLASSIFIER_DIR: dir,
            BASE_SHA: 'a'.repeat(40),
            HEAD_SHA: 'b'.repeat(40),
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: join(dir, 'summary')
          },
          encoding: 'utf8'
        })
        expect(run.status, run.stderr).toBe(0)
        const lines = readFileSync(output, 'utf8').split('\n')
        const plan = JSON.parse(lines.find((line) => line.startsWith('plan='))!.slice(5))
        const lanes = JSON.parse(lines.find((line) => line.startsWith('lanes='))!.slice(6))
        expect(plan).toMatchObject({ mode: 'full', roots: ['bootstrap'] })
        expect(plan).not.toHaveProperty('macosProfile')
        expect(plan.lanes).toEqual(lanes)
        for (const lane of plan.lanes) expect(manifest.laneOrder).toContain(lane)
        const expectedBundles = manifest.bundleOrder.filter((bundle) =>
          plan.lanes.some((lane: string) => manifest.laneBundles[lane] === bundle)
        )
        expect(plan.bundles).toEqual(expectedBundles)
        const desktop = ['macos_e2e', 'windows_e2e']
        if (event === 'pull_request') {
          expect(plan.bundles).toEqual([
            'policy',
            'static',
            'unit',
            'linux_runtime',
            'windows_core'
          ])
          expect(plan.lanes.some((lane: string) => lane.startsWith('e2e_'))).toBe(false)
        } else {
          expect(plan.bundles).toEqual(expect.arrayContaining(desktop))
        }
        const conclusions = Object.fromEntries(
          ['preflight', ...manifest.bundleOrder].map((job) => [
            job,
            plan.bundles.includes(job) || job === 'preflight' ? 'success' : 'skipped'
          ])
        )
        expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('fails the bootstrap evaluator closed on platform policy and skipped selected bundles', () => {
    const evaluate = workflow.jobs.gate.steps?.find(
      ({ name }) => name === 'Evaluate deterministic gate from trusted base'
    )
    const dir = mkdtempSync(join(tmpdir(), 'pr-gate-bootstrap-evaluator-'))
    const bundles = ['policy', 'static', 'unit', 'linux_runtime', 'windows_core']
    const plan = {
      schemaVersion: 1,
      mode: 'full',
      roots: ['bootstrap'],
      lanes: ['policy', 'lint', 'unit_macos', 'linux_runtime', 'windows_runtime'],
      bundles
    }
    const needs = (overrides: Record<string, string>): string =>
      JSON.stringify(
        Object.fromEntries(
          ['preflight', ...manifest.bundleOrder].map((job) => [
            job,
            {
              result:
                overrides[job] ??
                (job === 'preflight' || bundles.includes(job) ? 'success' : 'skipped')
            }
          ])
        )
      )
    // Run from an empty directory so the inline bootstrap evaluator is exercised.
    const run = (planJson: string, needsJson: string): ReturnType<typeof spawnSync> =>
      spawnSync('bash', ['-c', evaluate!.run!], {
        cwd: dir,
        env: {
          ...process.env,
          PREFLIGHT_RESULT: 'success',
          PR_GATE_PLAN: planJson,
          PR_GATE_NEEDS: needsJson,
          GITHUB_STEP_SUMMARY: join(dir, 'summary')
        },
        encoding: 'utf8'
      })
    try {
      expect(evaluate?.run).toContain("'macosProfile' in plan")
      expect(run(JSON.stringify(plan), needs({})).status).toBe(0)
      expect(run(JSON.stringify(plan), needs({ windows_core: 'skipped' })).status).toBe(1)
      expect(run(JSON.stringify(plan), needs({ windows_e2e: 'failure' })).status).toBe(1)
      for (const macosProfile of ['smoke', 'expanded', 'skip']) {
        expect(run(JSON.stringify({ ...plan, macosProfile }), needs({})).status).toBe(1)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('makes base-trusted module evidence authoritative without shadow steps', () => {
    const prepare = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Prepare trusted classifier'
    )
    const shadowPrepare = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Prepare trusted module shadow'
    )
    const shadowPublish = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Publish module impact shadow'
    )

    expect(workflow.jobs.preflight.outputs).toEqual({
      base: '${{ steps.revisions.outputs.base }}',
      head: '${{ steps.revisions.outputs.head }}',
      lanes: '${{ steps.classify.outputs.lanes }}',
      plan: '${{ steps.classify.outputs.plan }}'
    })
    expect(prepare?.['continue-on-error']).toBeUndefined()
    expect(prepare?.run).toContain('scripts/ci/module-impact-authority.mjs')
    expect(prepare?.run).toContain('scripts/ci/module-impact-shadow.mjs')
    expect(prepare?.run).toContain('scripts/ci/module-test-impact.mjs')
    expect(prepare?.run).toContain('scripts/ci/module-impact.json')
    expect(prepare?.run).toContain('git show "${BASE_SHA}:${file}"')
    expect(prepare?.run).toContain('source=bootstrap')
    expect(shadowPrepare).toBeUndefined()
    expect(shadowPublish).toBeUndefined()
  })

  it('aggregates all deterministic bundles into the stable PR Gate job', () => {
    const gate = workflow.jobs.gate

    expect(gate.name).toBe('PR Gate')
    expect(gate.if).toBe('${{ always() }}')
    expect(gate.needs).toEqual(expect.arrayContaining(['preflight', ...manifest.bundleOrder]))
    expect(gate.env).toBeUndefined()
    expect(gate.steps?.at(0)).toMatchObject({
      name: 'Checkout trusted gate evaluator',
      if: "${{ needs.preflight.result == 'success' }}",
      with: {
        'fetch-depth': 1,
        'persist-credentials': false,
        ref: "${{ github.event_name == 'workflow_dispatch' && github.sha || github.event.pull_request.base.sha || needs.preflight.outputs.base }}"
      }
    })
    expect(gate.steps?.at(0)?.env).toBeUndefined()
    expect(gate.steps?.at(-1)).toMatchObject({
      name: 'Evaluate deterministic gate from trusted base',
      env: {
        PR_GATE_EXECUTION_MODE: 'bundles',
        PR_GATE_PLAN: '${{ needs.preflight.outputs.plan }}',
        PREFLIGHT_RESULT: '${{ needs.preflight.result }}'
      }
    })
    const gateNeeds = Array.isArray(gate.needs) ? gate.needs : []
    for (const jobId of gateNeeds) {
      expect(gate.steps?.at(-1)?.env?.PR_GATE_NEEDS).toContain(
        `"${jobId}":{"result":"\${{ needs.${jobId}.result }}"}`
      )
    }
    expect(gate.steps?.at(-1)?.env?.PR_GATE_NEEDS).not.toContain('outputs')
    expect(gate.steps?.at(-1)?.run).toContain('node scripts/ci/evaluate-pr-gate.mjs')
    expect(gate.steps?.at(-1)?.run).toContain('Bootstrap-only strict evaluator')
    expect(workflowText).not.toContain('toJSON(needs)')
    expect(workflowText).not.toMatch(/needs:.*(?:ai|codex|review)/i)
  })

  it('validates commit policy without coupling the gate to editable PR metadata', () => {
    const policy = workflow.jobs.policy.steps?.find(
      ({ name }) => name === 'Validate pull request policy'
    )

    // Merge groups reuse preflight's target-branch narrowing so the migration set covers every
    // queued entry, not just the trailing pull request.
    expect(policy?.env).toEqual({
      BASE_SHA: '${{ github.event.pull_request.base.sha || needs.preflight.outputs.base }}',
      EVENT_NAME: '${{ github.event_name }}',
      HEAD_SHA:
        '${{ github.event.pull_request.head.sha || needs.preflight.outputs.head || github.sha }}',
      POLICY_SCOPE: 'commits'
    })
  })

  it('rejects newly introduced high-severity dependency vulnerabilities', () => {
    const review = workflow.jobs.policy.steps?.find(
      ({ name }) => name === 'Review dependency changes'
    )

    expect(review).toMatchObject({
      if: "${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}",
      uses: 'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
      with: {
        'base-ref': '${{ needs.preflight.outputs.base }}',
        'fail-on-severity': 'high',
        'fail-on-scopes': 'runtime, development',
        'head-ref': '${{ needs.preflight.outputs.head }}',
        'license-check': false,
        'show-openssf-scorecard': false
      }
    })
  })

  it('disables npm updates while keeping GitHub Actions updates policy-compatible', () => {
    const npm = dependabot.updates.find(
      (update) => update['package-ecosystem'] === 'npm' && update.directory === '/'
    )
    const actions = dependabot.updates.find(
      (update) => update['package-ecosystem'] === 'github-actions' && update.directory === '/'
    )

    expect(npm).toBeUndefined()
    expect(actions).toMatchObject({
      'commit-message': { prefix: 'ci(dependencies): update' },
      'open-pull-requests-limit': 2,
      'pull-request-branch-name': {
        'branch-name-case': 'lowercase',
        prefix: 'ci',
        template: '{prefix}/{group_name}'
      },
      groups: {
        'github-actions-security-updates': {
          'applies-to': 'security-updates',
          patterns: ['*']
        },
        'github-actions-version-updates': {
          'applies-to': 'version-updates',
          patterns: ['*']
        }
      }
    })
  })

  it('pins every third-party action to an immutable commit', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/)
      }
    }
  })

  it('blocks on actionlint and reports pinned zizmor findings during static checks', () => {
    const actionlint = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check GitHub Actions correctness'
    )
    const zizmor = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Audit GitHub Actions security with zizmor'
    )
    const enforce = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Enforce selected static checks'
    )

    expect(workflow.jobs.static['timeout-minutes']).toBe(15)
    expect(actionlint).toMatchObject({
      id: 'actionlint',
      'continue-on-error': true
    })
    expect(actionlint?.run).toContain(
      'releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz'
    )
    expect(actionlint?.run).toContain(
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
    )
    expect(actionlint?.run).toContain('-shellcheck= -pyflakes=')
    expect(zizmor).toMatchObject({
      'continue-on-error': true,
      uses: 'zizmorcore/zizmor-action@cc914d7f3750a2d13d75c7f184a1060aa0e9d482',
      with: {
        'advanced-security': false,
        annotations: true,
        'min-confidence': 'high',
        'min-severity': 'medium',
        version: 'v1.30.1'
      }
    })
    expect(enforce?.env).toMatchObject({
      ACTIONLINT_OUTCOME: '${{ steps.actionlint.outcome }}'
    })
    expect(enforce?.run).toContain('check actionlint "$ACTIONLINT_OUTCOME"')
    expect(enforce?.run).not.toContain('check zizmor')
  })

  it('uses runner-local concurrency while preserving separate static outcomes', () => {
    const lint = workflow.jobs.static.steps?.find(({ name }) => name === 'Lint')
    const typechecks = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Typecheck node and web'
    )
    const enforce = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Enforce selected static checks'
    )

    expect(lint?.run).toBe('npm run lint -- --concurrency auto')
    expect(typechecks).toMatchObject({
      id: 'typechecks',
      'continue-on-error': true,
      env: {
        RUN_TYPECHECK_NODE:
          "${{ contains(fromJSON(needs.preflight.outputs.plan).lanes, 'typecheck_node') }}",
        RUN_TYPECHECK_WEB:
          "${{ contains(fromJSON(needs.preflight.outputs.plan).lanes, 'typecheck_web') }}"
      }
    })
    expect(typechecks?.if).toContain("'typecheck_node'")
    expect(typechecks?.if).toContain("'typecheck_web'")
    expect(typechecks?.run).toContain('npm run typecheck:node >"$node_log" 2>&1 &')
    expect(typechecks?.run).toContain('npm run typecheck:web >"$web_log" 2>&1 &')
    expect(typechecks?.run).toContain('echo "node=$node_outcome" >> "$GITHUB_OUTPUT"')
    expect(typechecks?.run).toContain('echo "web=$web_outcome" >> "$GITHUB_OUTPUT"')
    expect(enforce?.env).toMatchObject({
      TYPECHECK_NODE_OUTCOME: '${{ steps.typechecks.outputs.node }}',
      TYPECHECK_WEB_OUTCOME: '${{ steps.typechecks.outputs.web }}',
      TYPECHECKS_OUTCOME: '${{ steps.typechecks.outcome }}'
    })
    expect(enforce?.run).toContain('check typechecks "$TYPECHECKS_OUTCOME"')
  })

  it('checks complete ownership and import consumers for selective source plans', () => {
    const guard = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check complete module ownership and consumer evidence'
    )
    expect(guard?.run).toContain('scripts/ci/audit-module-ownership.test.ts')
    expect(guard?.run).toContain('scripts/ci/module-consumer-coverage.test.ts')
    expect(guard?.if).toContain(".mode != 'full'")
    expect(guard?.if).toContain(".bundles, 'unit'")
    expect(guard?.['continue-on-error']).not.toBe(true)
  })

  it('runs the i18n catalog guard as a named static check', () => {
    const i18n = workflow.jobs.static.steps?.find(({ name }) => name === 'Check i18n catalog')
    const enforce = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Enforce selected static checks'
    )

    expect(i18n).toMatchObject({
      id: 'i18n',
      'continue-on-error': true,
      run: 'npx vitest run src/renderer/src/i18n/resources.test.ts'
    })
    expect(i18n?.if).toContain("'i18n'")
    expect(enforce?.env).toMatchObject({
      I18N_OUTCOME: '${{ steps.i18n.outcome }}'
    })
    expect(enforce?.run).toContain('check i18n "$I18N_OUTCOME"')
    expect(manifest.laneBundles.i18n).toBe('static')
    expect(manifest.laneOrder).toContain('i18n')
  })

  it('verifies the published runtime bundle as a named static check', () => {
    const runtimeBundle = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Verify published runtime bundle'
    )
    const enforce = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Enforce selected static checks'
    )

    expect(runtimeBundle).toMatchObject({
      id: 'runtime_bundle',
      'continue-on-error': true,
      run: 'node scripts/verify-runtime-bundle.mjs linux-64 osx-arm64 osx-64 win-64'
    })
    expect(runtimeBundle?.if).toContain("'runtime_bundle'")
    expect(runtimeBundle?.if).toContain("fromJSON(needs.preflight.outputs.plan).mode == 'full'")
    expect(enforce?.env).toMatchObject({
      RUNTIME_BUNDLE_OUTCOME: '${{ steps.runtime_bundle.outcome }}'
    })
    expect(enforce?.run).toContain('check runtime_bundle "$RUNTIME_BUNDLE_OUTCOME"')
    expect(manifest.laneBundles.runtime_bundle).toBe('static')
    expect(manifest.laneOrder).toContain('runtime_bundle')
    const classify = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Classify change impact'
    )
    expect(classify?.run).toContain("'runtime_bundle'")
  })

  it('shards full portable tests on Ubuntu and merges coverage into the stable unit bundle', () => {
    const unit = workflow.jobs.unit
    const shards = workflow.jobs.unit_shard
    const checkout = unit.steps?.find(({ name }) => name === 'Checkout')
    const related = unit.steps?.find(({ name }) => name === 'Test affected Modules')
    const download = unit.steps?.find(({ name }) => name === 'Download full-suite blob reports')
    const merge = unit.steps?.find(({ name }) => name === 'Merge full-suite reports and coverage')
    const coverageUpload = unit.steps?.find(({ name }) => name === 'Upload Module coverage report')
    const install = unit.steps?.find(({ name }) => name === 'Install dependencies')
    const installMerge = unit.steps?.find(
      ({ name }) => name === 'Install report merge dependencies'
    )
    const shardRun = shards.steps?.find(({ name }) => name === 'Test complete suite shard')
    const shardUpload = shards.steps?.find(({ name }) => name === 'Upload full-suite blob report')

    expect(workflow.jobs.coverage_macos).toBeUndefined()
    expect(unit).toMatchObject({
      name: 'Module tests and coverage',
      needs: ['preflight', 'unit_shard'],
      'runs-on':
        "${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group' || needs.unit_shard.result != 'skipped' || fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke') && 'ubuntu-latest' || 'macos-14' }}"
    })
    expect(unit.if).toContain('always()')
    expect(unit.env?.VITEST_DEFER_COVERAGE_THRESHOLDS).toBeUndefined()
    expect(shards.env?.VITEST_MAX_WORKERS).toBeUndefined()
    expect(shards.env?.OPEN_SCIENCE_TEST_MAX_WORKERS).toBeUndefined()
    expect(shards).toMatchObject({
      env: {
        VITEST_DEFER_COVERAGE_THRESHOLDS: '1',
        VITEST_PORTABLE_CI: '1'
      },
      name: 'Portable tests (Ubuntu, shard ${{ matrix.shard }}/4)',
      needs: 'preflight',
      'runs-on': 'ubuntu-latest',
      strategy: {
        'fail-fast': false,
        matrix: { shard: [1, 2, 3, 4] }
      }
    })
    expect(shards.if).toContain("fromJSON(needs.preflight.outputs.plan).mode == 'full'")
    expect(shards.if).toContain(
      "!contains(fromJSON(needs.preflight.outputs.plan).lanes, 'unit_macos')"
    )
    expect(shardRun).toMatchObject({
      'continue-on-error': true,
      run: [
        'npx vitest run',
        '--coverage',
        '--coverage.reporter=text-summary',
        '--testTimeout=30000',
        '--shard=${{ matrix.shard }}/4',
        '--reporter=dot',
        '--reporter=blob',
        '--reporter=github-actions',
        '--outputFile=vitest-reports/blob-${{ matrix.shard }}.json'
      ].join(' ')
    })
    expect(shardUpload).toMatchObject({
      if: '${{ always() }}',
      with: {
        name: 'unit-portable-blob-${{ matrix.shard }}',
        path: 'vitest-reports/',
        'retention-days': 1,
        'if-no-files-found': 'error'
      }
    })
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0 })
    expect(related).toMatchObject({
      id: 'unit_macos_related',
      'continue-on-error': true,
      env: {
        BASE_SHA: '${{ needs.preflight.outputs.base }}',
        HEAD_SHA: '${{ needs.preflight.outputs.head }}'
      },
      run: expect.stringContaining(
        'npm run test:affected -- --base "$BASE_SHA" --head "$HEAD_SHA" --coverage-changed "$BASE_SHA"'
      )
    })
    expect(related?.run).not.toMatch(/(?:^|\s)--changed(?:\s|$)/)
    expect(related?.if).toContain("fromJSON(needs.preflight.outputs.plan).mode == 'selective'")
    expect(install).toMatchObject({
      if: "${{ needs.unit_shard.result == 'skipped' }}",
      run: 'node scripts/ci/npm-ci.mjs'
    })
    expect(installMerge).toMatchObject({
      if: "${{ needs.unit_shard.result != 'skipped' }}",
      run: 'node scripts/ci/npm-ci.mjs --ignore-scripts --prefer-offline --no-audit --fund=false'
    })
    expect(download).toMatchObject({
      if: "${{ needs.unit_shard.result != 'skipped' }}",
      with: {
        pattern: 'unit-portable-blob-*',
        path: 'vitest-reports',
        'merge-multiple': true
      }
    })
    expect(merge).toMatchObject({
      id: 'unit_macos_full',
      'continue-on-error': true,
      if: "${{ needs.unit_shard.result != 'skipped' && (fromJSON(needs.preflight.outputs.plan).mode == 'full' || !contains(fromJSON(needs.preflight.outputs.plan).lanes, 'unit_macos')) }}",
      run: 'npx vitest run --merge-reports=vitest-reports --coverage --passWithNoTests'
    })
    expect(unit.steps?.some(({ name }) => name === 'Test Renderer (blocking)')).toBe(false)
    expect(unit.steps?.filter(({ run }) => run === 'npm run test:coverage')).toHaveLength(0)
    expect(coverageUpload).toMatchObject({
      if: "${{ always() && (steps.unit_macos_related.outcome != 'skipped' || steps.unit_macos_full.outcome != 'skipped' || steps.unit_macos_related_merge.outcome != 'skipped') }}",
      'continue-on-error': true,
      with: {
        name: 'coverage-report',
        path: 'coverage/',
        'retention-days': 5,
        'if-no-files-found': 'warn'
      }
    })
  })

  it.each(['macos', 'windows'])(
    'prepares %s E2E once and restores its exact artifact in every consumer',
    (platform) => {
      const bundle = `${platform}_e2e`
      const producerId = `${bundle}_setup`
      const producer = workflow.jobs[producerId]
      const consumer = workflow.jobs[bundle]
      expect(producer.needs).toBe('preflight')
      if (platform === 'windows') {
        expect(producer.if).toBe(
          "${{ needs.preflight.result == 'success' && contains(fromJSON(needs.preflight.outputs.plan).bundles, 'windows_e2e') }}"
        )
        expect(consumer.if).toBe(
          "${{ !cancelled() && needs.preflight.result == 'success' && contains(fromJSON(needs.preflight.outputs.plan).bundles, 'windows_e2e') && needs.windows_e2e_setup.result == 'success' }}"
        )
      } else {
        expect(producer.if).toContain(
          "!(fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke' || (fromJSON(needs.preflight.outputs.plan).macosProfile == 'expanded' && contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos')))"
        )
        expect(consumer.if).toContain(
          "(fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke' || (fromJSON(needs.preflight.outputs.plan).macosProfile == 'expanded' && contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos'))) || needs.macos_e2e_setup.result == 'success'"
        )
      }
      expect(producer.strategy).toBeUndefined()
      expect(producer['runs-on']).toBe(consumer['runs-on'])
      expect(consumer.needs).toEqual(['preflight', producerId])
      // A failed or cancelled producer must skip its consumer explicitly, never run it.
      expect(consumer.if).toContain('!cancelled()')
      expect(consumer.if).not.toContain('always()')
      expect(consumer.if).toContain(`needs.${producerId}.result == 'success'`)
      expect(producer.outputs).toEqual({
        artifact_id: '${{ steps.upload.outputs.artifact-id }}',
        node_version: '${{ steps.node.outputs.node-version }}'
      })
      expect(producer.steps?.filter(({ run }) => run === 'npm run build:e2e')).toHaveLength(1)
      expect(producer.steps?.filter(({ run }) => run === 'npm run build:web')).toHaveLength(
        platform === 'macos' ? 1 : 0
      )
      const upload = producer.steps?.find(({ id }) => id === 'upload')
      expect(upload?.['continue-on-error']).not.toBe(true)
      expect(upload?.with).toMatchObject({
        name: `e2e-setup-${platform}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
        'retention-days': 1,
        'compression-level': 0,
        'if-no-files-found': 'error'
      })
      expect(upload?.with).not.toHaveProperty('overwrite')
      const node = consumer.steps?.find(({ name }) => name === 'Setup Node')
      expect(node?.with).toEqual({
        'node-version':
          platform === 'macos'
            ? "${{ needs.macos_e2e_setup.outputs.node_version || '22' }}"
            : `\${{ needs.${producerId}.outputs.node_version }}`,
        ...(platform === 'macos'
          ? {
              cache:
                "${{ (fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke' || (fromJSON(needs.preflight.outputs.plan).macosProfile == 'expanded' && contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos'))) && 'npm' || '' }}"
            }
          : {}),
        'package-manager-cache': false
      })
      const download = consumer.steps?.find(({ name }) => name === 'Download E2E setup')
      expect(download?.with).toEqual({
        'artifact-ids': `\${{ needs.${producerId}.outputs.artifact_id }}`,
        path: '${{ runner.temp }}/e2e-setup/',
        'merge-multiple': true
      })
      const restore = consumer.steps?.find(({ id }) => id === 'setup')
      expect(restore?.run).toContain('e2e-setup-snapshot.mjs restore')
      expect(restore?.['continue-on-error']).not.toBe(true)
      expect(
        consumer.steps?.some(
          ({ run, if: condition }) =>
            /npm-ci\.mjs|npm ci|npm run build:/.test(run ?? '') &&
            !condition?.includes(
              "contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos')"
            )
        )
      ).toBe(false)
      // The trusted evaluator already rejects a selected bundle skipped by a failed/cancelled setup.
      const lane = `e2e_functional_${platform}`
      const result = evaluatePrGate(
        {
          schemaVersion: 1,
          mode: 'selective',
          lanes: ['policy', lane],
          bundles: ['policy', bundle],
          roots: ['manual:e2e'],
          reasonChains: []
        },
        { preflight: 'success', policy: 'success', [bundle]: 'skipped' },
        { executionMode: 'bundles' }
      )
      expect(result.ok).toBe(false)
    }
  )

  it('preserves test commands while moving matrix setup into platform producers', () => {
    for (const bundle of ['static', 'unit_shard', 'windows_core', 'macos_e2e_setup']) {
      expect(
        workflow.jobs[bundle].steps?.filter(({ run }) => run === 'node scripts/ci/npm-ci.mjs'),
        `${bundle} must install dependencies exactly once`
      ).toHaveLength(1)
    }
    expect(
      workflow.jobs.unit.steps?.filter(({ name }) =>
        ['Install dependencies', 'Install report merge dependencies'].includes(name ?? '')
      )
    ).toHaveLength(2)
    expect(
      workflow.jobs.windows_e2e_setup.steps?.filter(({ name }) => name === 'Install dependencies')
    ).toEqual([
      expect.objectContaining({
        run: 'node scripts/ci/npm-ci.mjs --prefer-offline --no-audit --fund=false'
      })
    ])

    const macosRuns = workflow.jobs.macos_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(macosRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(macosRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey -- --global-timeout=600000',
        'npm run test:e2e:workspace -- --global-timeout=900000',
        'npm run test:e2e:accessibility:signal',
        'npm run test:e2e:visual -- --global-timeout=300000'
      ])
    )

    const windowsRuns = workflow.jobs.windows_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(windowsRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(0)
    expect(windowsRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey -- --workers=1 --fully-parallel --shard=${{ matrix.shard }}/3 --global-timeout=600000',
        'npm run test:e2e:workspace -- --workers=1 --fully-parallel --shard=${{ matrix.shard }}/3 --global-timeout=900000'
      ])
    )
    expect(windowsRuns?.some((run) => run?.includes('test:e2e:accessibility'))).toBe(false)
  })

  it('budgets the complete Windows E2E path beyond dependency and build setup', () => {
    expect(workflow.jobs.windows_e2e['timeout-minutes']).toBe(35)
  })

  it('budgets the combined macOS builds and all four E2E groups', () => {
    expect(workflow.jobs.macos_e2e['timeout-minutes']).toBe(30)
  })

  it('shards every selected Windows suite without cancelling siblings or colliding artifacts', () => {
    const job = workflow.jobs.windows_e2e
    expect(job.strategy?.['fail-fast']).toBe(false)
    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(job.name).toBe('Windows E2E (shard ${{ matrix.shard }}/3)')
    expect(job.steps?.find(({ name }) => name === 'Install headless Chromium')?.if).toBeUndefined()
    expect(job.steps?.find(({ id }) => id === 'renderer_layout')?.if).toContain(
      "'e2e_browser_windows'"
    )
    expect(job.steps?.find(({ id }) => id === 'renderer_layout')?.run).toContain('--workers=1')
    expect(job.steps?.find(({ id }) => id === 'renderer_layout')?.run).toContain(
      '--shard=${{ matrix.shard }}/3'
    )
    for (const lane of ['e2e_functional_windows', 'e2e_workspace_windows']) {
      const step = job.steps?.find(({ id }) => id === lane)
      expect(step?.if).toContain(
        `contains(fromJSON(needs.preflight.outputs.plan).lanes, '${lane}')`
      )
      expect(step?.run).toContain('--workers=1 --fully-parallel --shard=${{ matrix.shard }}/3')
      expect(step?.run).not.toContain('--fail-on-flaky-tests')
    }
    const uploads = job.steps?.filter(({ name }) =>
      /Upload (functional|workspace)/.test(name ?? '')
    )
    expect(uploads).toHaveLength(2)
    for (const upload of uploads ?? []) {
      expect(upload.with?.name).toContain('${{ matrix.shard }}')
    }
    expect(workflow.jobs.gate.needs).toContain('windows_e2e')
    expect(
      workflow.jobs.gate.steps?.find(({ name }) => name?.startsWith('Evaluate deterministic gate'))
        ?.env?.PR_GATE_NEEDS
    ).toContain('"windows_e2e":{"result":"${{ needs.windows_e2e.result }}"}')
  })

  it.skipIf(process.platform === 'win32').each(['true', 'false'])(
    'retains unique static checks when dedicated tests are %s',
    (runDedicatedTests) => {
      const directory = mkdtempSync(join(tmpdir(), 'pr-gate-static-'))
      try {
        for (const command of ['npm', 'npx']) {
          writeFileSync(
            join(directory, command),
            `#!/bin/sh\nprintf '%s\\n' '${command}'" $*" >> "$COMMAND_LOG"\n`,
            { mode: 0o755 }
          )
        }
        for (const id of ['interface_contracts', 'cli_sdk']) {
          const step = workflow.jobs.static.steps?.find((step) => step.id === id)
          expect(step?.env?.RUN_DEDICATED_TESTS).toBe(
            "${{ fromJSON(needs.preflight.outputs.plan).mode != 'full' || !contains(fromJSON(needs.preflight.outputs.plan).bundles, 'unit') }}"
          )
          const log = join(directory, id)
          const run = spawnSync('bash', ['-e', '-c', step!.run!], {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              COMMAND_LOG: log,
              RUN_DEDICATED_TESTS: runDedicatedTests
            },
            encoding: 'utf8'
          })
          expect(run.status, run.stderr).toBe(0)
          const commands = readFileSync(log, 'utf8')
          expect(commands).toContain(
            id === 'interface_contracts' ? 'npm run check:web-api-map' : 'npm run check:cli-package'
          )
          expect(commands.includes('npx vitest run')).toBe(runDedicatedTests === 'true')
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32').each([
    [
      'windows-e2e',
      ['policy', 'windows_e2e'],
      ['policy', 'e2e_functional_windows', 'e2e_workspace_windows', 'e2e_browser_windows']
    ],
    ['windows-process', ['policy', 'windows_core'], ['policy', 'windows_runtime']]
  ])(
    'executes the focused %s plan through the real preflight script',
    (dryRunMode, bundles, lanes) => {
      const directory = mkdtempSync(join(tmpdir(), 'pr-gate-windows-'))
      try {
        const output = join(directory, 'output')
        const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
        const run = spawnSync('bash', ['-e', '-c', classify!.run!], {
          env: {
            ...process.env,
            EVENT_NAME: 'workflow_dispatch',
            DRY_RUN_MODE: dryRunMode,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: join(directory, 'summary')
          },
          encoding: 'utf8'
        })
        expect(run.status, run.stderr).toBe(0)
        const planLine = readFileSync(output, 'utf8')
          .split('\n')
          .find((line) => line.startsWith('plan='))!
        expect(JSON.parse(planLine.slice(5))).toMatchObject({
          mode: 'selective',
          bundles,
          lanes
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('rebuilds the Windows sandbox host before the native lifecycle smoke', () => {
    const steps = workflow.jobs.windows_core.steps ?? []
    const rustTest = steps.find(({ name }) => name === 'Test Windows sandbox native source')
    const build = steps.find(({ name }) => name === 'Build Windows sandbox native host')
    const smoke = steps.find(
      ({ name }) => name === 'Test Windows AppContainer ownership and removal lifecycle'
    )

    expect(rustTest?.run).toBe(
      'cargo test --locked --manifest-path packages/notebook-network-sandbox/vendor/windows-src/Cargo.toml'
    )
    expect(build?.run).toBe('node packages/notebook-network-sandbox/vendor/windows/build.mjs x64')
    expect(steps.indexOf(rustTest!)).toBeLessThan(steps.indexOf(build!))
    expect(steps.indexOf(build!)).toBeLessThan(steps.indexOf(smoke!))
  })

  it('carries no dead Windows accessibility lane in the workflow', () => {
    expect(manifest.laneOrder).not.toContain('e2e_accessibility_windows')
    expect(workflowText).not.toContain('e2e_accessibility_windows')
    expect(workflowText).not.toContain('pre-migration classifier')
    for (const step of workflow.jobs.windows_e2e.steps ?? []) {
      // Every lane-gated Windows E2E step must reference a declared lane.
      for (const lane of step.if?.match(/lanes, '([^']+)'/g)?.map((m) => m.slice(8, -1)) ?? []) {
        expect(manifest.laneOrder, `${step.name} gates on unknown lane ${lane}`).toContain(lane)
      }
    }
  })

  it('publishes accessibility diagnostics for both advisory and infrastructure outcomes', () => {
    const upload = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Upload accessibility diagnostics'
    )

    expect(upload).toMatchObject({
      if: "${{ steps.e2e_accessibility_macos.outcome != 'skipped' }}",
      'continue-on-error': true,
      with: {
        name: 'accessibility-macos-${{ matrix.group }}-diagnostics',
        path: 'playwright-report/\ntest-results/\n'
      }
    })
  })

  it('runs complete accessibility collection in the macOS PR lane', () => {
    const macosStep = workflow.jobs.macos_e2e.steps?.find(
      ({ id }) => id === 'e2e_accessibility_macos'
    )

    expect(macosStep?.run).toBe('npm run test:e2e:accessibility:signal')
  })

  it('retains focused real-Darwin coverage in full plans without another macOS job', () => {
    const native = workflow.jobs.macos_e2e.steps?.find(({ id }) => id === 'unit_macos_native')
    const enforce = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Enforce selected macOS checks'
    )

    expect(native).toMatchObject({
      'continue-on-error': true,
      if: expect.stringContaining("macosProfile == 'expanded'")
    })
    for (const testFile of [
      'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts',
      'packages/notebook-network-sandbox/src/network-enforcement.integration.test.ts',
      'src/main/net/network-info.test.ts',
      'src/main/notebook/kernel-executor.test.ts',
      'src/main/notebook/managed-runtime-guard.test.ts',
      'src/main/process-tree-darwin-recovery.test.ts',
      'src/main/process-tree-evidence.macos.integration.test.ts'
    ]) {
      expect(native?.run).toContain(testFile)
    }
    expect(native?.run).toContain(
      "-t 'executes the repl loop through the production network sandbox|recovers cross-session REPL'"
    )
    expect(enforce?.env).toMatchObject({
      UNIT_MACOS_NATIVE_OUTCOME: '${{ steps.unit_macos_native.outcome }}'
    })
    expect(enforce?.run).toContain('check unit_macos_native "$UNIT_MACOS_NATIVE_OUTCOME"')
  })

  it('collects independent bundle failures before failing the shared runner', () => {
    for (const bundle of [
      'static',
      'unit',
      'unit_shard',
      'windows_core',
      'macos_e2e',
      'windows_e2e'
    ]) {
      const enforce = workflow.jobs[bundle].steps?.find(({ name }) => name?.startsWith('Enforce'))
      expect(enforce, `${bundle} must enforce collected step outcomes`).toMatchObject({
        if: '${{ always() }}'
      })
      expect(enforce?.run).toContain('exit "$failed"')
    }

    for (const bundle of ['macos_e2e', 'windows_e2e']) {
      for (const upload of workflow.jobs[bundle].steps?.filter(({ name }) =>
        name?.startsWith('Upload')
      ) ?? []) {
        expect(upload['continue-on-error'], `${upload.name} must not stop later E2E checks`).toBe(
          true
        )
      }
    }

    const related = workflow.jobs.unit.steps?.find(({ name }) => name === 'Test affected Modules')
    const full = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Merge full-suite reports and coverage'
    )
    const enforceUnit = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Enforce selected unit checks'
    )
    expect(related?.['continue-on-error']).toBe(true)
    expect(full?.['continue-on-error']).toBe(true)
    expect(enforceUnit?.env).toEqual({
      UNIT_MACOS_FULL_OUTCOME: '${{ steps.unit_macos_full.outcome }}',
      UNIT_MACOS_RELATED_OUTCOME: '${{ steps.unit_macos_related.outcome }}',
      UNIT_MACOS_RELATED_MERGE_OUTCOME: '${{ steps.unit_macos_related_merge.outcome }}',
      UNIT_MACOS_SHARDS_RESULT: '${{ needs.unit_shard.result }}'
    })
    expect(enforceUnit?.run).toContain('check unit_macos_related "$UNIT_MACOS_RELATED_OUTCOME"')
    expect(enforceUnit?.run).toContain('check unit_macos_full "$UNIT_MACOS_FULL_OUTCOME"')
    expect(enforceUnit?.run).toContain('check unit_macos_shards "$UNIT_MACOS_SHARDS_RESULT"')
    expect(enforceUnit?.run).toContain(
      '[[ "$UNIT_MACOS_RELATED_OUTCOME" == "skipped" && "$UNIT_MACOS_FULL_OUTCOME" == "skipped" && "$UNIT_MACOS_RELATED_MERGE_OUTCOME" == "skipped" ]]'
    )
    expect(enforceUnit?.run).toContain('Selected unit bundle did not execute a Module-test path')
  })

  it('preserves the complete portable suite and hard Windows contracts', () => {
    const portable = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Merge full-suite reports and coverage'
    )
    expect(portable).toMatchObject({
      'continue-on-error': true,
      run: 'npx vitest run --merge-reports=vitest-reports --coverage --passWithNoTests'
    })

    expect(workflow.jobs.linux_runtime).toMatchObject({
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10
    })
    expect(workflow.jobs.linux_runtime.if).toBe(
      "${{ needs.preflight.result == 'success' && contains(fromJSON(needs.preflight.outputs.plan).bundles, 'linux_runtime') }}"
    )
    const linuxDependencies = workflow.jobs.linux_runtime.steps?.find(
      ({ name }) => name === 'Install Linux sandbox dependency'
    )
    expect(linuxDependencies?.run).toContain('apparmor-profiles')
    expect(linuxDependencies?.run).toContain('bwrap-userns-restrict')
    expect(linuxDependencies?.run).toContain('bwrap --unshare-all')
    expect(linuxDependencies?.run).not.toContain('apparmor_restrict_unprivileged_userns=0')
    expect(
      workflow.jobs.linux_runtime.steps?.find(
        ({ name }) => name === 'Test real Linux filesystem and network isolation'
      )?.run
    ).toContain('filesystem-enforcement.integration.test.ts')

    expect(workflow.jobs.windows_core).toMatchObject({
      'runs-on': 'windows-latest',
      'timeout-minutes': 15
    })
    const runtime = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows-specific behavior'
    )
    for (const testFile of [
      'scripts/windows-updater-certification.test.ts',
      'src/main/windows.test.ts',
      'src/main/windows-icon-assets.test.ts',
      'src/main/windows-powershell.test.ts',
      'src/main/delegation/acp-execution.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts',
      'src/main/file-save.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/notebook/micromamba-cache-powershell.test.ts',
      'src/main/notebook/micromamba-cache-acl.integration.test.ts'
    ]) {
      expect(runtime?.run).toContain(testFile)
    }

    const nativeMac = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Test macOS-native behavior'
    )
    for (const testFile of [
      'src/main/delegation/acp-execution.test.ts',
      'src/main/delegation/production-framework-runtime.test.ts'
    ])
      expect(nativeMac?.run).toContain(testFile)

    const wheelEvidence = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows wheel evidence recovery'
    )
    const enforceWindowsCore = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Enforce selected Windows core checks'
    )
    expect(wheelEvidence?.id).toBe('windows_wheel_evidence')
    expect(wheelEvidence?.if).toContain("'windows_runtime'")
    expect(wheelEvidence?.if).toContain("inputs.dry_run != 'windows-process'")
    expect(wheelEvidence?.env).toMatchObject({ RUN_KERNEL: '1' })
    expect(wheelEvidence?.run).toContain('OPEN_SCIENCE_TEST_PYTHON')
    expect(wheelEvidence?.run).toContain('pip-wheel-evidence.test.ts')
    expect(wheelEvidence?.run).toContain('pip-install-evidence.test.ts')
    // Collected like its siblings so a wheel failure cannot short-circuit later Windows checks.
    expect(wheelEvidence?.['continue-on-error']).toBe(true)
    expect(enforceWindowsCore?.env).toMatchObject({
      WINDOWS_WHEEL_EVIDENCE_OUTCOME: '${{ steps.windows_wheel_evidence.outcome }}'
    })
    expect(enforceWindowsCore?.run).toContain(
      'check windows_wheel_evidence "$WINDOWS_WHEEL_EVIDENCE_OUTCOME"'
    )
    for (const step of workflow.jobs.windows_core.steps ?? []) {
      // Every lane-gated Windows core test step is collected by the enforce step.
      if (!step.run || !step.if?.includes("'windows_runtime'") || !step.id) continue
      expect(step['continue-on-error'], `${step.name} must not short-circuit siblings`).toBe(true)
      expect(enforceWindowsCore?.run).toContain(`check ${step.id} `)
    }
    const wheelResult = spawnSync('bash', ['-c', enforceWindowsCore!.run!], {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.keys(enforceWindowsCore?.env ?? {}).map((key) => [key, 'success'])
        ),
        WINDOWS_WHEEL_EVIDENCE_OUTCOME: 'failure'
      },
      encoding: 'utf8'
    })
    expect(wheelResult.status).toBe(1)
    expect(wheelResult.stderr).toContain('windows_wheel_evidence ended with failure')

    const shell = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell behavior'
    )
    const serviceTimeout = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell service timeout'
    )
    for (const file of [
      'src/main/notebook/windows-shell.integration.test.ts',
      'src/main/notebook/powershell-search-parser.windows.test.ts',
      'src/main/notebook/shell-search-scope.test.ts'
    ])
      expect(shell?.run).toContain(file)
    expect(serviceTimeout?.run).toContain('src/main/notebook/runtime-service.test.ts')
    expect(serviceTimeout?.run).toContain('--testNamePattern')

    const path = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows path portability'
    )
    for (const testFile of [
      'src/main/acp/workspace-path.test.ts',
      'src/main/file-save.test.ts',
      'src/main/notebook/run-document-data-paths.test.ts',
      'src/main/notebook/runtime-paths.test.ts',
      'src/main/session-persistence/conversation-export.test.ts',
      'src/main/session-persistence/data-path-roundtrip.test.ts',
      'src/main/settings/notebook-runtime-settings.test.ts',
      'src/main/settings/preferences.test.ts',
      'src/main/settings/shell-path.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/storage/data-path.test.ts',
      'src/main/storage/normalize-legacy-paths.test.ts',
      'src/main/storage/path-presence.test.ts'
    ]) {
      expect(path?.run).toContain(testFile)
    }
    expect(path?.run).toContain('--maxWorkers=1')
    expect(path?.run).toContain('--testTimeout=30000')
    expect(path?.run).toContain('--hookTimeout=30000')
  })

  it('checks only changed files for formatting', () => {
    const checkout = workflow.jobs.static.steps?.find(({ name }) => name === 'Checkout')
    const docs = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check Markdown formatting'
    )
    const format = workflow.jobs.static.steps?.find(({ name }) => name === 'Check formatting')

    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(docs).toMatchObject({
      env: {
        BASE_SHA: '${{ needs.preflight.outputs.base }}',
        HEAD_SHA: '${{ needs.preflight.outputs.head }}'
      },
      run: 'node scripts/ci/check-changed-format.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --kind markdown'
    })
    expect(format).toMatchObject({
      env: {
        BASE_SHA: '${{ needs.preflight.outputs.base }}',
        HEAD_SHA: '${{ needs.preflight.outputs.head }}'
      },
      run: 'node scripts/ci/check-changed-format.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --kind non-markdown'
    })
  })

  it('covers both root CLI and publishable SDK tests in the narrow lane', () => {
    const testStep = workflow.jobs.static.steps?.find(({ name }) => name === 'Test CLI and SDK')

    expect(testStep?.run).toContain('npx vitest run cli packages/open-science')
    expect(testStep?.run).toContain('npm run check:cli-package')
  })

  it('labels the existing cross-process checks as a shadow baseline', () => {
    const step = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check interface contract baseline (shadow)'
    )

    expect(step).toBeDefined()
    for (const testFile of [
      'src/preload/index.test.ts',
      'src/preload/electron-renderer-contract-adapter.test.ts',
      'src/shared/renderer-contract.test.ts',
      'src/shared/renderer-contract-catalog.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/shared/web-rpc-contract.test.ts'
    ]) {
      expect(step?.run).toContain(testFile)
    }
    expect(manifest.laneOrder).not.toContain('unit_preload_contracts')
    expect(workflow.jobs).not.toHaveProperty('preload_contracts')
  })
})

describe('E2E throughput contracts', () => {
  it('dispatches the real E2E bundles with a valid focused plan', () => {
    const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
    const dir = mkdtempSync(join(tmpdir(), 'e2e-plan-'))
    try {
      const output = join(dir, 'output')
      const run = spawnSync('bash', ['-eu', '-c', classify!.run!], {
        env: {
          ...process.env,
          EVENT_NAME: 'workflow_dispatch',
          DRY_RUN_MODE: 'e2e',
          GITHUB_OUTPUT: output
        },
        encoding: 'utf8'
      })
      expect(run.status, run.stderr).toBe(0)
      const line = readFileSync(output, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('plan='))!
      const plan = JSON.parse(line.slice(5))
      expect(plan.bundles).toEqual(['policy', 'macos_e2e', 'windows_e2e'])
      expect([...new Set(plan.lanes.map((lane: string) => manifest.laneBundles[lane]))]).toEqual(
        plan.bundles
      )
      expect(plan.lanes).toContain('e2e_browser_windows')
      // Only the groups owning selected lanes may run; the trusted evaluator checks equality.
      expect(plan.macosGroups).toEqual(['journeys', 'presentation'])
      expect(plan.macosGroups).toEqual(macosGroupsForPlan(plan))
      const conclusions = { preflight: 'success', policy: 'success', macos_e2e: 'success' }
      expect(
        evaluatePrGate(
          plan,
          { ...conclusions, windows_e2e: 'success' },
          { executionMode: 'bundles' }
        ).ok
      ).toBe(true)
      expect(
        evaluatePrGate(
          plan,
          { ...conclusions, windows_e2e: 'skipped' },
          { executionMode: 'bundles' }
        ).ok
      ).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('partitions native-platform browser coverage across Windows runners', () => {
    const job = workflow.jobs.windows_e2e
    expect(job.steps?.find(({ id }) => id === 'renderer_layout')?.if).toContain(
      "contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_browser_windows')"
    )
    expect(job.steps?.find(({ id }) => id === 'renderer_layout')).toMatchObject({
      run: 'npm run test:e2e:browser -- --workers=1 --global-timeout=420000 --shard=${{ matrix.shard }}/3'
    })
    expect(
      job.steps?.find(({ name }) => name === 'Enforce selected Windows E2E checks')?.run
    ).toContain(
      '[[ "${E2E_BROWSER_SELECTED:-}" == "true" && "$RENDERER_LAYOUT_OUTCOME" != "success" ]]'
    )
  })

  it('partitions macOS groups while preserving the stable aggregate gate', () => {
    const job = workflow.jobs.macos_e2e
    expect(job.strategy?.matrix?.group).toBe(
      `\${{ fromJSON(needs.preflight.outputs.plan).macosGroups || fromJSON('["journeys","presentation","regressions","delegation"]') }}`
    )
    for (const [id, group] of [
      ['e2e_functional_macos', 'journeys'],
      ['e2e_workspace_macos', 'journeys'],
      ['e2e_accessibility_macos', 'presentation'],
      ['e2e_visual_macos', 'presentation'],
      ['renderer_layout', 'presentation']
    ]) {
      expect(job.steps?.find((step) => step.id === id)?.if).toContain(`matrix.group == '${group}'`)
    }
    expect(workflow.jobs.gate.needs).toContain('macos_e2e')
    const enforce = job.steps?.find(({ name }) => name === 'Enforce selected macOS checks')
    const run = spawnSync('bash', ['-c', enforce!.run!], {
      env: { ...process.env, RENDERER_LAYOUT_OUTCOME: 'failure' },
      encoding: 'utf8'
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('renderer_layout ended with failure')
  })
})

it('uses one selected plan without rollout stage or separate legacy coverage', () => {
  const raw = readFileSync('.github/workflows/pr-gate.yml', 'utf8')
  expect(raw).not.toContain('PR_GATE_MERGE_QUEUE_ENABLED')
  expect(raw).not.toContain('outputs.stage')
  expect(raw).not.toContain('coverage_macos')
  const related = workflow.jobs.unit.steps?.find(({ id }) => id === 'unit_macos_related')
  expect(related?.env?.VITEST_PORTABLE_CI).toContain("macosProfile == 'smoke'")
  expect(related?.run).toContain('--coverage-changed "$BASE_SHA"')
})

it('runs short Mac setup and tests in one job without web build or snapshot transfer', () => {
  const mac = workflow.jobs.macos_e2e
  const install = mac.steps?.find(({ name }) => name === 'Install short Mac dependencies')
  const build = mac.steps?.find(({ id }) => id === 'smoke_build')
  expect(install).toMatchObject({
    if: "${{ (fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke' || (fromJSON(needs.preflight.outputs.plan).macosProfile == 'expanded' && contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos'))) }}",
    run: 'node scripts/ci/npm-ci.mjs'
  })
  expect(build).toMatchObject({ if: install?.if, run: 'npm run build:e2e' })
  expect(mac.steps?.some(({ run }) => run === 'npm run build:web')).toBe(false)
  for (const name of ['Download E2E setup', 'Restore E2E setup']) {
    expect(mac.steps?.find((step) => step.name === name)?.if).toContain(
      "!(fromJSON(needs.preflight.outputs.plan).macosProfile == 'smoke' || (fromJSON(needs.preflight.outputs.plan).macosProfile == 'expanded' && contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_smoke_macos')))"
    )
  }
  const core = mac.steps?.find(({ id }) => id === 'e2e_smoke_macos')
  expect(core?.if).toContain("steps.smoke_build.outcome == 'success'")
  expect(mac.if).toContain('!cancelled()')
  expect(mac.if).toContain("needs.preflight.result == 'success'")
})

it('provides a focused manual plan that exercises the same single-runner Mac job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'macos-smoke-plan-'))
  try {
    const output = join(dir, 'output')
    const classify = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Classify change impact'
    )
    if (!classify?.run) throw new Error('Missing classifier')
    const result = spawnSync('bash', ['-c', classify.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_dispatch',
        DRY_RUN_MODE: 'macos-smoke',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(dir, 'summary')
      }
    })
    expect(result.status, result.stderr).toBe(0)
    const line = readFileSync(output, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('plan='))!
    const plan = JSON.parse(line.slice(5))
    expect(plan).toMatchObject({
      macosProfile: 'smoke',
      macosGroups: ['journeys'],
      bundles: ['policy', 'macos_e2e']
    })
    expect(
      evaluatePrGate(
        plan,
        { preflight: 'success', policy: 'success', macos_e2e: 'success' },
        { executionMode: 'bundles' }
      ).ok
    ).toBe(true)
    expect(
      evaluatePrGate(
        plan,
        { preflight: 'success', policy: 'success', macos_e2e: 'skipped' },
        { executionMode: 'bundles' }
      ).ok
    ).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps the platform policy explicit and keeps automated portable tests off macOS for both event types', () => {
  const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
  expect(classify?.env?.PR_GATE_PLATFORM_POLICY).toBe('risk-v1')
  const gate = workflow.jobs.gate.steps?.find(
    ({ name }) => name === 'Evaluate deterministic gate from trusted base'
  )
  expect(gate?.env?.PR_GATE_PLATFORM_POLICY).toBe('risk-v1')
  const related = workflow.jobs.unit.steps?.find(({ id }) => id === 'unit_macos_related')
  for (const event of ['pull_request', 'merge_group']) {
    expect(workflow.jobs.unit['runs-on']).toContain(`github.event_name == '${event}'`)
    expect(related?.env?.VITEST_PORTABLE_CI).toContain(`github.event_name == '${event}'`)
  }
})
