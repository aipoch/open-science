import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

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
    matrix?: { shard?: number[] }
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
          options: ['classified', 'unit-coverage', 'i18n', 'windows-e2e']
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
    expect(classify?.run).toContain('"lanes":["policy","unit_macos"]')
    expect(classify?.run).toContain('"bundles":["policy","unit"]')
    expect(classify?.run).toContain('"lanes":["policy","i18n"]')
    expect(classify?.run).toContain('"bundles":["policy","static"]')
    expect(classify?.run).toContain(
      'node "$TRUSTED_CLASSIFIER_DIR/module-impact-authority.mjs" --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
    expect(classify?.run).toContain("mode: 'full'")
    expect(classify?.run).not.toContain(
      'node scripts/ci/classify-pr-changes.mjs --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
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
    expect(gate.needs).toEqual(
      expect.arrayContaining(['preflight', ...manifest.bundleOrder, 'coverage_macos'])
    )
    expect(gate.env).toBeUndefined()
    expect(gate.steps?.at(0)).toMatchObject({
      name: 'Checkout trusted gate evaluator',
      if: "${{ needs.preflight.result == 'success' }}",
      with: {
        'fetch-depth': 1,
        'persist-credentials': false,
        ref: "${{ github.event_name == 'workflow_dispatch' && github.sha || github.event.pull_request.base.sha || github.event.merge_group.base_sha || needs.preflight.outputs.base }}"
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

    expect(policy?.env).toEqual({
      BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
      EVENT_NAME: '${{ github.event_name }}',
      HEAD_SHA:
        '${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || github.sha }}',
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

    const legacyCoverage = workflow.jobs.coverage_macos
    const coverageOnly = legacyCoverage.steps?.find(
      ({ name }) => name === 'Test coverage-only legacy plan'
    )
    const consolidated = legacyCoverage.steps?.find(
      ({ name }) => name === 'Confirm coverage consolidated into Module tests'
    )

    expect(legacyCoverage).toMatchObject({
      name: 'Legacy coverage plan compatibility',
      'runs-on': 'macos-14'
    })
    expect(coverageOnly).toMatchObject({
      if: "${{ !contains(fromJSON(needs.preflight.outputs.plan).bundles, 'unit') }}",
      run: 'npm run test:coverage'
    })
    expect(consolidated).toMatchObject({
      if: "${{ contains(fromJSON(needs.preflight.outputs.plan).bundles, 'unit') }}"
    })
    expect(legacyCoverage.steps?.filter(({ run }) => run === 'npm run test:coverage')).toHaveLength(
      1
    )
    expect(
      legacyCoverage.steps?.filter(({ run }) => run === 'node scripts/ci/npm-ci.mjs')
    ).toHaveLength(1)
    expect(unit).toMatchObject({
      name: 'Module tests and coverage',
      needs: ['preflight', 'unit_shard'],
      'runs-on': "${{ needs.unit_shard.result != 'skipped' && 'ubuntu-latest' || 'macos-14' }}"
    })
    expect(unit.if).toContain('always()')
    expect(unit.env?.VITEST_DEFER_COVERAGE_THRESHOLDS).toBeUndefined()
    expect(shards).toMatchObject({
      env: { VITEST_DEFER_COVERAGE_THRESHOLDS: '1', VITEST_PORTABLE_CI: '1' },
      name: 'Full portable tests (Ubuntu, shard ${{ matrix.shard }}/3)',
      needs: 'preflight',
      'runs-on': 'ubuntu-latest',
      strategy: {
        'fail-fast': false,
        matrix: { shard: [1, 2, 3] }
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
        '--shard=${{ matrix.shard }}/3',
        '--reporter=blob',
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
      run: 'npm run test:affected -- --base "$BASE_SHA" --head "$HEAD_SHA" --coverage-changed "$BASE_SHA"'
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
      if: "${{ needs.unit_shard.result != 'skipped' }}",
      run: 'npx vitest run --merge-reports=vitest-reports --coverage --passWithNoTests'
    })
    expect(unit.steps?.some(({ name }) => name === 'Test Renderer (blocking)')).toBe(false)
    expect(unit.steps?.filter(({ run }) => run === 'npm run test:coverage')).toHaveLength(0)
    expect(coverageUpload).toMatchObject({
      if: "${{ always() && (steps.unit_macos_related.outcome != 'skipped' || steps.unit_macos_full.outcome != 'skipped') }}",
      'continue-on-error': true,
      with: {
        name: 'coverage-report',
        path: 'coverage/',
        'retention-days': 5,
        'if-no-files-found': 'warn'
      }
    })
  })

  it('shares dependency installation and Electron builds inside platform bundles', () => {
    for (const bundle of ['static', 'unit_shard', 'windows_core', 'macos_e2e']) {
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
      workflow.jobs.windows_e2e.steps?.filter(({ name }) => name === 'Install dependencies')
    ).toEqual([
      expect.objectContaining({
        run: 'node scripts/ci/npm-ci.mjs --prefer-offline --no-audit --fund=false'
      })
    ])

    const macosRuns = workflow.jobs.macos_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(macosRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(macosRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey -- --fail-on-flaky-tests',
        'npm run test:e2e:workspace -- --fail-on-flaky-tests',
        'npm run test:e2e:accessibility:signal',
        'npm run test:e2e:visual -- --fail-on-flaky-tests'
      ])
    )

    const windowsRuns = workflow.jobs.windows_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(windowsRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(windowsRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey -- --workers=2 --fully-parallel --shard=${{ matrix.shard }}/2 --fail-on-flaky-tests',
        'npm run test:e2e:workspace -- --workers=2 --fully-parallel --shard=${{ matrix.shard }}/2 --fail-on-flaky-tests',
        'npm run test:e2e:accessibility -- --fail-on-flaky-tests'
      ])
    )
  })

  it('budgets the complete Windows E2E path beyond dependency and build setup', () => {
    expect(workflow.jobs.windows_e2e['timeout-minutes']).toBe(25)
  })

  it('budgets the combined macOS builds and all four E2E groups', () => {
    expect(workflow.jobs.macos_e2e['timeout-minutes']).toBe(20)
  })

  it('shards every selected Windows journey without cancelling siblings or colliding artifacts', () => {
    const job = workflow.jobs.windows_e2e
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    expect(job.name).toBe('Windows E2E (shard ${{ matrix.shard }}/2)')
    for (const lane of ['e2e_functional_windows', 'e2e_workspace_windows']) {
      const step = job.steps?.find(({ id }) => id === lane)
      expect(step?.if).toContain(
        `contains(fromJSON(needs.preflight.outputs.plan).lanes, '${lane}')`
      )
      expect(step?.run).toContain('--workers=2 --fully-parallel --shard=${{ matrix.shard }}/2')
      expect(step?.run).toContain('--fail-on-flaky-tests')
    }
    const uploads = job.steps?.filter(({ name }) =>
      /Upload (functional|workspace)/.test(name ?? '')
    )
    expect(uploads).toHaveLength(2)
    for (const upload of uploads ?? []) {
      expect(upload.with?.name).toContain('${{ matrix.shard }}')
    }
    expect(job.steps?.find(({ id }) => id === 'e2e_accessibility_windows')?.if).toContain(
      'matrix.shard == 1'
    )
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

  it.skipIf(process.platform === 'win32')(
    'executes the focused Windows plan through the real preflight script',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'pr-gate-windows-'))
      try {
        const output = join(directory, 'output')
        const classify = workflow.jobs.preflight.steps?.find(({ id }) => id === 'classify')
        const run = spawnSync('bash', ['-e', '-c', classify!.run!], {
          env: {
            ...process.env,
            EVENT_NAME: 'workflow_dispatch',
            DRY_RUN_MODE: 'windows-e2e',
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
          bundles: ['policy', 'windows_e2e'],
          lanes: ['policy', 'e2e_functional_windows', 'e2e_workspace_windows']
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

  it('runs Windows accessibility only for a legacy selected lane', () => {
    const compatibility = workflow.jobs.windows_e2e.steps?.find(
      ({ name }) => name === 'Run legacy Windows accessibility compatibility'
    )
    const enforce = workflow.jobs.windows_e2e.steps?.find(
      ({ name }) => name === 'Enforce selected Windows E2E checks'
    )

    expect(manifest.laneOrder).not.toContain('e2e_accessibility_windows')
    expect(compatibility).toMatchObject({
      id: 'e2e_accessibility_windows',
      'continue-on-error': true,
      run: 'npm run test:e2e:accessibility -- --fail-on-flaky-tests'
    })
    expect(compatibility?.if).toContain(
      "contains(fromJSON(needs.preflight.outputs.plan).lanes, 'e2e_accessibility_windows')"
    )
    expect(enforce?.env).toMatchObject({
      E2E_ACCESSIBILITY_OUTCOME: '${{ steps.e2e_accessibility_windows.outcome }}'
    })
    expect(enforce?.run).toContain('check e2e_accessibility_windows "$E2E_ACCESSIBILITY_OUTCOME"')
  })

  it('publishes accessibility diagnostics for both advisory and infrastructure outcomes', () => {
    const upload = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Upload accessibility diagnostics'
    )

    expect(upload).toMatchObject({
      if: "${{ steps.e2e_accessibility_macos.outcome != 'skipped' }}",
      'continue-on-error': true,
      with: {
        name: 'accessibility-macos-diagnostics',
        path: 'playwright-report/\ntest-results/\n'
      }
    })
  })

  it('enables advisory accessibility signaling only in the macOS PR lane', () => {
    const macosStep = workflow.jobs.macos_e2e.steps?.find(
      ({ id }) => id === 'e2e_accessibility_macos'
    )
    const windowsStep = workflow.jobs.windows_e2e.steps?.find(
      ({ id }) => id === 'e2e_accessibility_windows'
    )

    expect(macosStep?.run).toBe('npm run test:e2e:accessibility:signal')
    expect(windowsStep?.run).toBe('npm run test:e2e:accessibility -- --fail-on-flaky-tests')
  })

  it('retains focused real-Darwin coverage in full plans without another macOS job', () => {
    const native = workflow.jobs.macos_e2e.steps?.find(({ id }) => id === 'unit_macos_native')
    const enforce = workflow.jobs.macos_e2e.steps?.find(
      ({ name }) => name === 'Enforce selected macOS checks'
    )

    expect(native).toMatchObject({
      'continue-on-error': true,
      if: "${{ fromJSON(needs.preflight.outputs.plan).mode == 'full' }}"
    })
    for (const testFile of [
      'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts',
      'packages/notebook-network-sandbox/src/network-enforcement.integration.test.ts',
      'src/main/net/network-info.test.ts',
      'src/main/notebook/kernel-executor.test.ts',
      'src/main/notebook/managed-runtime-guard.test.ts'
    ]) {
      expect(native?.run).toContain(testFile)
    }
    expect(native?.run).toContain(
      "-t 'executes the repl loop through the production network sandbox'"
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
      UNIT_MACOS_SHARDS_RESULT: '${{ needs.unit_shard.result }}'
    })
    expect(enforceUnit?.run).toContain('check unit_macos_related "$UNIT_MACOS_RELATED_OUTCOME"')
    expect(enforceUnit?.run).toContain('check unit_macos_full "$UNIT_MACOS_FULL_OUTCOME"')
    expect(enforceUnit?.run).toContain('check unit_macos_shards "$UNIT_MACOS_SHARDS_RESULT"')
    expect(enforceUnit?.run).toContain(
      '[[ "$UNIT_MACOS_RELATED_OUTCOME" == "skipped" && "$UNIT_MACOS_FULL_OUTCOME" == "skipped" ]]'
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
      'src/main/windows.test.ts',
      'src/main/windows-icon-assets.test.ts',
      'src/main/windows-powershell.test.ts',
      'src/main/file-save.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/notebook/micromamba-cache-powershell.test.ts',
      'src/main/notebook/micromamba-cache-acl.integration.test.ts'
    ]) {
      expect(runtime?.run).toContain(testFile)
    }

    const shell = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell behavior'
    )
    const serviceTimeout = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell service timeout'
    )
    expect(shell?.run).toBe('npx vitest run src/main/notebook/windows-shell.integration.test.ts')
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
