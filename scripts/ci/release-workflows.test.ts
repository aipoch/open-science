import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  shell?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: Step[]
  strategy?: { matrix?: { shard?: number[] } }
  'timeout-minutes'?: number | string
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const workflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')) as Workflow

const step = (job: Job, name: string): Step => {
  const result = job.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing step: ${name}`)
  return result
}

describe('release and scheduled workflow topology', () => {
  it.each(['0189093', '0000000', '1234567', 'abc1234', null])(
    'keeps backend and installer versions identical for commit %s (null is stable)',
    (shortSha) => {
      const root = mkdtempSync(join(tmpdir(), 'nightly-version-'))
      try {
        const manifest = { name: 'nightly-version-fixture', version: '0.37.1', private: true }
        writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
        writeFileSync(
          join(root, 'package-lock.json'),
          JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': manifest } })
        )
        const build = step(workflow('build.yml').jobs.build, 'Build & package').run!
        // Execute the real version preparation, stopping before builds, signing, or publication.
        const preparation = build.slice(0, build.indexOf('npm run build:e2e'))
        expect(preparation).toContain('npm version --no-git-tag-version')
        const output = execFileSync(
          'bash',
          [
            '-e',
            '-c',
            preparation.replaceAll('${{ inputs.nightly }}', String(shortSha !== null)) +
              '\nprintf "package-version=%s\\n" "${eb_ver[@]}"'
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_SHA: `${shortSha ?? 'abc1234'}${'0'.repeat(33)}` }
          }
        )
        const version = shortSha ? `0.37.1-nightly.g${shortSha}` : manifest.version
        expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe(version)
        const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
        expect(lock.version).toBe(version)
        expect(lock.packages[''].version).toBe(version)
        expect(output).toContain(
          `package-version=${shortSha ? `-c.extraMetadata.version=${version}` : ''}\n`
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('allows Build OIDC through every direct and nested caller', () => {
    // GitHub validates declared permissions before evaluating signing inputs or job conditions.
    const callees = new Set([
      './.github/workflows/build.yml',
      './.github/workflows/performance-package-dryrun.yml'
    ])
    const callers: string[] = []
    for (const name of readdirSync(join(process.cwd(), '.github/workflows'))) {
      if (!name.endsWith('.yml')) continue
      const document = workflow(name)
      for (const [id, job] of Object.entries(document.jobs)) {
        if (!callees.has(job.uses ?? '')) continue
        callers.push(`${name}:${id}`)
        expect(job.permissions ?? document.permissions, `${name}:${id}`).toMatchObject({
          contents: 'read',
          'id-token': 'write'
        })
      }
    }
    expect(callers.sort()).toEqual([
      'nightly.yml:build',
      'notarize-dryrun.yml:build',
      'performance-package-dryrun.yml:build',
      'release.yml:build',
      'runtime-resource-soak.yml:packaged_performance',
      'signpath-test.yml:build'
    ])
    for (const name of [
      'nightly.yml',
      'notarize-dryrun.yml',
      'performance-package-dryrun.yml',
      'runtime-resource-soak.yml'
    ]) {
      const document = workflow(name)
      expect(document.permissions?.['id-token']).toBeUndefined()
      for (const job of Object.values(document.jobs)) {
        if (callees.has(job.uses ?? '')) {
          expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
        } else {
          expect(job.permissions?.['id-token']).toBeUndefined()
        }
      }
    }
  })

  it('blocks Windows builds including package dry-runs on real receipt publication and submission recovery', () => {
    const build = workflow('build.yml').jobs.build
    const gate = step(build, 'Verify Windows receipt publication and submission recovery')
    expect(gate.if).toBe("${{ matrix.platform == 'win' }}")
    expect(gate['continue-on-error']).not.toBe(true)
    expect(gate.run).toContain('npx vitest run')
    expect(gate.run).toContain('src/main/notebook/file-evidence-publication.integration.test.ts')
    expect(gate.run).toContain(
      'src/main/compute/compute-submission-evidence-recovery.integration.test.ts'
    )
    const steps = build.steps ?? []
    expect(steps.indexOf(gate)).toBeGreaterThan(steps.indexOf(step(build, 'Install dependencies')))
    expect(steps.indexOf(gate)).toBeLessThan(
      steps.indexOf(step(build, 'Prune foreign Prisma engines'))
    )
  })

  it('batches latest-main Windows coverage daily across eight serial shards', () => {
    const windows = workflow('windows-full-test.yml')
    const schedule = windows.on?.schedule as Array<{ cron: string }>
    const dispatch = windows.on?.workflow_dispatch as {
      inputs?: { mode?: { default?: string; options?: string[] } }
    }
    const plan = windows.jobs.plan
    const dependencies = windows.jobs.windows_dependencies
    const job = windows.jobs.windows_full_test
    const sandbox = windows.jobs.notebook_sandbox
    const test = step(job, 'Test complete suite shard')
    const sandboxSmoke = step(sandbox, 'Test AppContainer ownership and removal lifecycle')

    expect(job.strategy?.matrix?.shard).toBe(
      "${{ fromJSON((inputs.mode == 'regressions' || inputs.mode == 'scheduled-fixes') && '[1]' || '[1,2,3,4,5,6,7,8]') }}"
    )
    expect(dependencies).toMatchObject({
      needs: ['plan', 'windows_notebook_runtime'],
      'runs-on': 'windows-latest',
      outputs: {
        artifact_id: '${{ steps.upload.outputs.artifact-id }}',
        node_version: '${{ steps.node.outputs.node-version }}'
      }
    })
    expect(step(dependencies, 'Install dependencies').run).toBe('node scripts/ci/npm-ci.mjs')
    expect(step(dependencies, 'Pack dependencies').run).toContain('pack-dependencies')
    expect(step(dependencies, 'Pack dependencies').shell).toBe('bash')
    expect(step(job, 'Restore dependencies').shell).toBe('bash')
    expect(step(windows.jobs.notebook_mutation, 'Restore dependencies').shell).toBe('bash')
    expect(step(dependencies, 'Upload dependencies').with?.['compression-level']).toBe(0)
    expect(job.env).toMatchObject({ VITEST_WINDOWS_FULL_TEST: '1' })
    expect(test.run).toContain('--shard=${{ matrix.shard }}/8')
    expect(test.run).toContain('--maxWorkers=1')
    expect(test.run).toContain('--reporter=github-actions')
    expect(windows.on).not.toHaveProperty('push')
    expect(schedule).toEqual([{ cron: '47 16 * * *' }])
    expect(dispatch.inputs?.mode).toMatchObject({
      default: 'full',
      options: ['full', 'notebook-sandbox', 'notebook-mutation', 'regressions', 'scheduled-fixes']
    })
    expect(windows.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(plan).toMatchObject({
      'runs-on': 'ubuntu-latest',
      outputs: { should_test: '${{ steps.decide.outputs.should_run }}' }
    })
    expect(step(plan, 'Check for untested main changes')).toMatchObject({
      uses: './.github/actions/skip-unchanged-scheduled',
      with: { 'workflow-file': 'windows-full-test.yml' }
    })
    expect(job).toMatchObject({
      needs: ['plan', 'windows_dependencies'],
      if: "${{ needs.plan.outputs.should_test == 'true' && needs.windows_dependencies.result == 'success' && (github.event_name != 'workflow_dispatch' || (inputs.mode == 'full' || inputs.mode == 'regressions' || inputs.mode == 'scheduled-fixes')) }}",
      'timeout-minutes': 60
    })
    expect(sandbox).toMatchObject({
      needs: 'plan',
      if: "${{ needs.plan.outputs.should_test == 'true' && (github.event_name != 'workflow_dispatch' || (inputs.mode == 'full' || inputs.mode == 'notebook-sandbox')) }}",
      'runs-on': 'windows-latest',
      'timeout-minutes': 20
    })
    expect(sandboxSmoke.run).toContain('vendor/windows-src/ci/smoke.ps1')
    expect(sandboxSmoke.run).toContain('vendor/windows/x64/notebook-appcontainer-host.exe')
    expect(sandboxSmoke.run).toContain('-Mode Full')
    expect(test.if).toBe("${{ github.event_name != 'workflow_dispatch' || inputs.mode == 'full' }}")
    const regressions = step(job, 'Test recent Windows regressions')
    expect(regressions.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'regressions' }}"
    )
    expect(regressions.run).not.toContain('--shard')
    expect(regressions.run).toContain('src/main/delegation/opencode-runtime-preparation.test.ts')
    expect(regressions.shell).toBe('bash')
    expect(regressions.env?.TEST_NAME_PATTERN).toBe("${{ inputs.test_name_pattern || '.*' }}")
    expect(regressions.run).toContain('--testNamePattern="$TEST_NAME_PATTERN"')
    expect(regressions.run).toContain('--maxWorkers=1 --testTimeout=60000 --hookTimeout=60000')
    const scheduledFixes = step(job, 'Test scheduled Windows fixes')
    expect(scheduledFixes.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'scheduled-fixes' }}"
    )
    expect(scheduledFixes.run).toContain(
      'src/main/managed-file-versions/version-file-operator.test.ts'
    )
    expect(scheduledFixes.run).toContain('src/main/settings/service.test.ts')
    expect(scheduledFixes.run).not.toContain('--shard')
    for (const file of [
      'cli/locate-app.test.ts',
      'scripts/credential-helper-signing.test.ts',
      'src/main/credential-identity/sqlite-snapshot.test.ts',
      'src/main/local-models/owner.test.ts',
      'src/main/notebook/input-registry.test.ts',
      'src/main/session-package/literature.test.ts',
      'src/main/session-plan/plan-context-file.test.ts',
      'test/config/vitest.config.test.ts',
      'scripts/ci/notebook-analysis-native.test.ts',
      'scripts/pdf-package-fixtures.test.ts',
      'scripts/ci/release-workflows.test.ts',
      'scripts/windows-release-workflows.test.ts',
      'src/main/database/database-null-and-version-bounds.test.ts',
      'src/main/database/migration-service.test.ts',
      'src/main/notebook/runtime-service.test.ts',
      'packages/environment/src/python-command.test.ts',
      'src/main/notebook/shell-process-ownership.test.ts',
      'src/main/literature/batch-jobs.test.ts',
      'packages/notebook-analysis/src/source-file-access-analysis.test.ts',
      'packages/notebook-analysis/src/source-file-access-analysis.additional-omics.test.ts',
      'packages/notebook-analysis/src/source-file-access-analysis.clinical-formats.test.ts',
      'packages/notebook-analysis/src/source-file-access-analysis.workflow-orchestration.test.ts',
      'src/main/session-package/archive.test.ts',
      'src/main/session-package/service.test.ts',
      'packages/environment/src/package-manager.test.ts',
      'src/main/notebook/package-process-sandbox.test.ts',
      'src/main/notebook/network-sandbox-owner.test.ts',
      'packages/notebook-analysis/src/dependency-analysis.test.ts',
      'src/main/notebook/working-file-observer.analysis-contract.integration.test.ts',
      'packages/notebook-analysis/src/dependency-analysis.chord.test.ts',
      'packages/notebook-analysis/src/dependency-analysis.path-plot.test.ts',
      'packages/notebook-analysis/src/dependency-analysis.anndata.test.ts',
      'src/main/artifacts/artifact-reproducibility-outputs.test.ts',
      'src/main/acp/context-usage-static-context.test.ts',
      'packages/environment/src/provisioner.test.ts',
      'src/main/notebook/reproduction-runtime.test.ts',
      'packages/environment/src/recovery-coordinator.test.ts',
      'src/main/artifacts/provenance-repository.test.ts',
      'src/main/artifacts/provenance-write-contract.test.ts',
      'src/main/artifacts/artifact-reproducibility-export.test.ts',
      'src/main/agent-framework/opencode.test.ts',
      'src/main/logger.test.ts',
      'packages/diagnostics/src/logger.test.ts',
      'src/main/delegation/production-composition.test.ts',
      'packages/notebook-network-sandbox/src/gateway.test.ts',
      'packages/notebook-network-sandbox/src/public-read-lifecycle.test.ts'
    ]) {
      expect(regressions.run).toContain(file)
    }
  })

  it('runs a separate daily Windows resource soak with a focused manual smoke path', () => {
    const resource = workflow('runtime-resource-soak.yml')
    const schedule = resource.on?.schedule as Array<{ cron: string }>
    const dispatch = resource.on?.workflow_dispatch as {
      inputs?: { mode?: { default?: string; options?: string[] } }
    }
    const plan = resource.jobs.plan
    const soak = resource.jobs.runtime_resource_soak
    const profile = step(soak, 'Record runtime resource profile')
    const upload = step(soak, 'Upload runtime resource evidence')

    expect(schedule).toEqual([{ cron: '23 19 * * *' }])
    expect(dispatch.inputs?.mode).toMatchObject({
      default: 'smoke',
      options: ['smoke', 'soak', 'package-macos-arm64']
    })
    expect(resource.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(resource.concurrency).toEqual({
      group: 'runtime-resource-soak-${{ github.event_name }}-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(step(plan, 'Check for unprofiled main changes')).toMatchObject({
      uses: './.github/actions/skip-unchanged-scheduled',
      with: { 'workflow-file': 'runtime-resource-soak.yml' }
    })
    expect(soak).toMatchObject({
      needs: ['plan', 'windows_notebook_runtime'],
      if: "needs.plan.outputs.should_test == 'true' && inputs.mode != 'package-macos-arm64'",
      'runs-on': 'windows-latest',
      'timeout-minutes': 70
    })
    expect(profile.run).toContain("'--stress-cycles=1'")
    expect(profile.run).toContain("'--stress-cycles=6'")
    expect(profile.run).toContain("'--output=test-results/performance'")
    expect(upload).toMatchObject({ if: 'always()' })
    expect(upload.with).toMatchObject({
      path: 'test-results',
      'retention-days': 14,
      'if-no-files-found': 'error'
    })
  })

  it('runs reusable verification beside native builds while callers remain fail closed', () => {
    const build = workflow('build.yml').jobs.build
    const nightly = workflow('nightly.yml')
    const release = workflow('release.yml')

    expect(build.needs).toEqual(['setup'])
    expect(build.if).toBe("${{ !cancelled() && needs.setup.result == 'success' }}")
    expect(nightly.jobs.prepare.needs).toEqual(['plan', 'build', 'package-smoke', 'cli-artifacts'])
    expect(release.jobs.publish.needs).toEqual([
      'build',
      'package-smoke',
      'notarize-mac',
      'cli-artifacts',
      'linux-cli-packages'
    ])
    expect(release.jobs['cli-artifacts'].needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(release.jobs['publish-npm']).toBeUndefined()
    expect(release.jobs['notarize-mac'].needs).toEqual(['build', 'package-smoke'])
  })

  it('batches Nightly daily and prepares publication without write access', () => {
    const nightly = workflow('nightly.yml')
    const schedule = nightly.on?.schedule as Array<{ cron: string }>
    const prepare = nightly.jobs.prepare

    expect(nightly.on).not.toHaveProperty('push')
    expect(schedule).toEqual([{ cron: '17 15 * * *' }])
    expect(nightly.on).toHaveProperty('workflow_dispatch')
    expect(nightly.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(nightly.concurrency).toEqual({
      group:
        "nightly-build-${{ github.event_name }}${{ inputs.dry_run == 'linux-arm64' && '-linux-arm64' || inputs.dry_run == 'linux-cli' && '-linux-cli' || inputs.dry_run == 'windows-package' && '-windows-package' || '' }}",
      'cancel-in-progress': true
    })
    expect(nightly.jobs.build).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_build == 'true' && inputs.dry_run != 'runtime-source'",
      uses: './.github/workflows/build.yml',
      with: {
        nightly: true,
        skip_verify:
          "${{ inputs.dry_run == 'macos-x64' || inputs.dry_run == 'linux-cli' || inputs.dry_run == 'linux-arm64' || inputs.dry_run == 'windows-package' }}",
        platform_name:
          "${{ inputs.dry_run == 'macos-x64' && 'macos-x64' || inputs.dry_run == 'linux-arm64' && 'linux-arm64' || inputs.dry_run == 'linux-cli' && 'linux-x64' || inputs.dry_run == 'windows-package' && 'windows-x64' || '' }}"
      }
    })
    expect(nightly.jobs.plan.outputs).toEqual({
      should_build: '${{ steps.decide.outputs.should_run }}'
    })
    expect(
      step(nightly.jobs.plan, 'Compare main with the last successful scheduled build')
    ).toMatchObject({
      uses: './.github/actions/skip-unchanged-scheduled',
      with: { 'workflow-file': 'nightly.yml' }
    })
    expect(nightly.jobs).not.toHaveProperty('publish-dry-run')
    const dispatch = nightly.on?.workflow_dispatch as {
      inputs?: { dry_run?: { default?: string; options?: string[] } }
    }
    expect(dispatch.inputs?.dry_run).toMatchObject({
      default: 'full',
      options: [
        'full',
        'runtime-source',
        'macos-x64',
        'linux-cli',
        'linux-arm64',
        'windows-package'
      ]
    })
    // Package dry-runs must exercise the produced installer without requesting signing or
    // falling back to the setup-only/install-only paths that never launch the package.
    expect(nightly.jobs.build.with).not.toHaveProperty('sign_windows')
    const buildInputs = workflow('build.yml').on?.workflow_call as {
      inputs: Record<string, { default?: unknown }>
    }
    expect(buildInputs.inputs.sign_windows.default).toBe(false)
    expect(nightly.jobs['package-smoke'].with).not.toHaveProperty('install_only')
    expect(nightly.jobs['package-smoke'].with).not.toHaveProperty('setup_only')
    expect(nightly.jobs['package-smoke']['continue-on-error']).not.toBe(true)
    expect(nightly.jobs['package-smoke'].if).toBe("inputs.dry_run != 'macos-x64'")
    expect(nightly.jobs['package-smoke'].with).toEqual({
      platform_name:
        "${{ inputs.dry_run == 'linux-arm64' && 'linux-arm64' || inputs.dry_run == 'linux-cli' && 'linux-x64' || inputs.dry_run == 'windows-package' && 'windows-x64' || '' }}"
    })
    expect(nightly.jobs.regression.if).toBe(
      "inputs.dry_run != 'linux-cli' && inputs.dry_run != 'linux-arm64' && inputs.dry_run != 'windows-package'"
    )
    expect(nightly.jobs['runtime-certification'].if).toContain("inputs.dry_run != 'macos-x64'")
    expect(prepare).toMatchObject({
      needs: ['plan', 'build', 'package-smoke', 'cli-artifacts'],
      if: "needs.build.result == 'success' && needs.package-smoke.result == 'success' && needs.cli-artifacts.result == 'success' && inputs.dry_run != 'linux-cli' && inputs.dry_run != 'linux-arm64' && inputs.dry_run != 'windows-package'",
      'runs-on': 'ubuntu-latest'
    })
    expect(step(prepare, 'Aggregate release certification evidence').run).toContain(
      '--expected-sha "$GITHUB_SHA"'
    )
    expect(step(prepare, 'Generate checksums').run).toContain('sha256sum')
    expect(step(prepare, 'Upload prepared nightly metadata').with).toMatchObject({
      name: 'nightly-ready',
      'retention-days': 5,
      'if-no-files-found': 'error'
    })
  })

  it('publishes prepared scheduled artifacts without executing triggering-run code', () => {
    const publishWorkflow = workflow('nightly-publish.yml')
    const plan = publishWorkflow.jobs.plan
    const publish = publishWorkflow.jobs.publish
    const download = step(publish, 'Download prepared nightly artifacts')
    const refresh = step(publish, 'Refresh nightly release')
    const existing = step(publish, 'Check existing nightly release')
    const release = step(publish, 'Publish nightly pre-release')
    const advance = step(publish, 'Advance nightly tag')
    const workflowRun = publishWorkflow.on?.workflow_run as {
      branches: string[]
      types: string[]
      workflows: string[]
    }

    expect(workflowRun).toEqual({
      workflows: ['Nightly'],
      types: ['completed'],
      branches: ['main']
    })
    expect(publishWorkflow.on).not.toHaveProperty('workflow_call')
    expect(publishWorkflow.concurrency).toEqual({
      group: 'nightly-publish',
      'cancel-in-progress': false
    })
    expect(plan.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(plan.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(plan.if).toContain("github.event.workflow_run.head_branch == 'main'")
    const checkout = step(plan, 'Checkout trusted gate code')
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}/)
    expect(checkout.with).toEqual({
      ref: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && github.sha || 'refs/heads/main' }}",
      'persist-credentials': false,
      'sparse-checkout': 'scripts/ci/nightly-publish-gates.mjs',
      'sparse-checkout-cone-mode': false
    })
    const gates = step(plan, 'Require advisory certification and regression jobs to have passed')
    expect(gates.id).toBe('gates')
    const fetchJobs = step(plan, 'Fetch publication jobs')
    expect(fetchJobs.run).toContain('repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs')
    expect(fetchJobs.run).toContain('--paginate')
    expect(fetchJobs.run).toContain('{name, conclusion}')
    expect(gates.run).toContain('node scripts/ci/nightly-publish-gates.mjs --jobs')
    expect(gates.run).not.toContain('workflow_run.head')
    expect(plan.steps?.some(({ run }) => run?.includes('npm '))).toBe(false)
    const decide = step(plan, 'Check for an unpublished build')
    expect(decide.env).toMatchObject({ GATES_OK: '${{ steps.gates.outputs.ok }}' })
    const publicationPlan = decide.run
    expect(publicationPlan).toContain('if [ "$GATES_OK" != "true" ]')
    expect(publicationPlan).toContain('blocked publication gates')
    const planSteps = plan.steps ?? []
    expect(planSteps.indexOf(checkout)).toBeLessThan(planSteps.indexOf(gates))
    expect(planSteps.indexOf(gates)).toBeLessThan(planSteps.indexOf(decide))
    expect(publicationPlan).toContain('repos/$GITHUB_REPOSITORY/commits/nightly')
    expect(publicationPlan).toContain('repos/$GITHUB_REPOSITORY/compare/$published...$SOURCE_SHA')
    expect(publicationPlan).toContain("grep -Eq 'HTTP (404|422)'")
    expect(publicationPlan).toContain('cat "$error_file" >&2')
    expect(publicationPlan).toContain('ahead)')
    expect(publicationPlan).toContain('identical|behind)')
    expect(publicationPlan).toContain('skipping stale publication')
    expect(publicationPlan).toContain('Cannot safely advance nightly')
    expect(publish.needs).toBe('plan')
    expect(publish.if).toContain("needs.plan.outputs.should_publish == 'true'")
    expect(download.with).toMatchObject({
      'github-token': '${{ secrets.GITHUB_TOKEN }}',
      'run-id': '${{ env.SOURCE_RUN_ID }}',
      'merge-multiple': true
    })
    expect(step(publish, 'Verify prepared nightly metadata').run).toContain(
      'test -s artifacts/RELEASE-CERTIFICATION.json'
    )
    expect(publish.steps?.some(({ uses }) => uses?.startsWith('actions/checkout@'))).toBe(false)
    expect(
      publish.steps?.some(({ run }) => run?.includes('release-certification-evidence.mjs'))
    ).toBe(false)
    expect(existing.if).toBeUndefined()
    expect(refresh.if).toBe("github.event_name != 'workflow_dispatch' || !inputs.dry_run")
    expect(existing.run).toContain('repos/$GITHUB_REPOSITORY/releases/tags/nightly')
    expect(existing.run).toContain('refusing to create a new Zenodo-visible release')
    expect(existing.run).toContain('repos/$GITHUB_REPOSITORY/git/ref/tags/nightly')
    expect(existing.run).toContain('refusing to publish without a retry marker')
    expect(refresh.run).not.toContain('--method PATCH')
    expect(refresh.run).not.toContain('--method POST')
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/releases/$release_id/assets')
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/releases/assets/$asset_id')
    expect(refresh.run).not.toContain('DELETE "repos/$GITHUB_REPOSITORY/releases/$release_id"')
    expect(refresh.run).not.toMatch(/\|\|\s*true/)
    expect(release.if).toBe(refresh.if)
    expect(advance.if).toBe(refresh.if)
    expect(advance.run).toContain('--method PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/nightly"')
    expect(advance.run).toContain('-F force=true')
    const publishSteps = publish.steps ?? []
    expect(publishSteps.indexOf(refresh)).toBeLessThan(publishSteps.indexOf(release))
    expect(publishSteps.indexOf(release)).toBeLessThan(publishSteps.indexOf(advance))
  })

  it('makes manual publication opt-in and resolves source identity before planning or downloading', () => {
    const flow = workflow('nightly-publish.yml')
    expect(flow.on?.workflow_dispatch).toMatchObject({
      inputs: {
        source_run_id: { required: true, type: 'string' },
        dry_run: { default: true, type: 'boolean' }
      }
    })
    expect(flow.jobs.plan.if).toContain("github.ref == 'refs/heads/main' || inputs.dry_run")
    expect(flow.jobs.plan.outputs).toMatchObject({
      source_run_id: '${{ steps.source.outputs.source_run_id }}',
      source_sha: '${{ steps.source.outputs.source_sha }}'
    })
    expect(flow.jobs.publish.env).toMatchObject({
      SOURCE_RUN_ID: '${{ needs.plan.outputs.source_run_id }}',
      SOURCE_SHA: '${{ needs.plan.outputs.source_sha }}'
    })
    const steps = flow.jobs.plan.steps!
    expect(steps.indexOf(step(flow.jobs.plan, 'Validate source run'))).toBeLessThan(
      steps.indexOf(
        step(flow.jobs.plan, 'Require advisory certification and regression jobs to have passed')
      )
    )
    expect(
      step(flow.jobs.plan, 'Require advisory certification and regression jobs to have passed').run
    ).toContain('--publish')
  })

  it('keeps dry-run artifact verification read-only and gates the write job on main publication', () => {
    const flow = workflow('nightly-publish.yml')
    const { verify, publish } = flow.jobs
    expect(verify.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(verify.if).toBe(
      "needs.plan.outputs.should_publish == 'true' && github.event_name == 'workflow_dispatch' && inputs.dry_run"
    )
    expect(publish.permissions).toEqual({ actions: 'read', contents: 'write' })
    expect(publish.if).toBe(
      "needs.plan.outputs.should_publish == 'true' && (github.event_name == 'workflow_run' ||\n (github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && !inputs.dry_run))"
    )
    expect(verify.steps).toEqual(publish.steps!.slice(0, 3))
    expect(verify.steps).toHaveLength(3)
    expect(verify.steps!.map(({ name }) => name)).toEqual([
      'Download prepared nightly artifacts',
      'Verify prepared nightly metadata',
      'Check existing nightly release'
    ])
  })

  it('keeps credentials out of candidate gate execution', () => {
    const flow = workflow('nightly-publish.yml')
    const plan = flow.jobs.plan
    expect(plan.env).not.toHaveProperty('GH_TOKEN')
    expect(plan.env).not.toHaveProperty('GITHUB_TOKEN')
    const evaluators = plan.steps!.filter(({ run }) => run?.includes('node scripts/'))
    expect(evaluators).toHaveLength(2)
    for (const evaluator of evaluators) {
      expect(evaluator.env).toBeUndefined()
      expect(evaluator.run).not.toContain('gh api')
      expect(evaluator.run).not.toContain('secrets.')
    }
    for (const name of ['Fetch source run', 'Fetch publication jobs']) {
      const fetch = step(plan, name)
      expect(fetch.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
      expect(fetch.run).not.toContain('node ')
    }
  })

  it.skipIf(process.platform === 'win32')(
    'runs recovery source ancestry checks and rejects unreachable or malformed sources',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'nightly-source-'))
      const source = {
        id: 123,
        repository: { full_name: 'aipoch/open-science' },
        head_repository: { full_name: 'aipoch/open-science' },
        path: '.github/workflows/nightly.yml',
        head_branch: 'main',
        head_sha: 'a'.repeat(40),
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch'
      }
      const plan = workflow('nightly-publish.yml').jobs.plan
      const script = [
        step(plan, 'Fetch source run').run,
        step(plan, 'Validate source run').run
      ].join('\n')
      const run = (status: string, id = '123'): string =>
        execFileSync(
          'bash',
          [
            '-e',
            '-o',
            'pipefail',
            '-c',
            `gh() { case "$2" in */actions/runs/123) printf '%s' "$MOCK_SOURCE";; */compare/*...main) printf '%s' "$MOCK_STATUS";; *) return 99;; esac; }\n${script}`
          ],
          {
            encoding: 'utf8',
            stdio: 'pipe',
            env: {
              ...process.env,
              RUNNER_TEMP: root,
              GITHUB_OUTPUT: join(root, 'output'),
              GITHUB_REPOSITORY: 'aipoch/open-science',
              SOURCE_RUN_ID: id,
              MOCK_SOURCE: JSON.stringify(source),
              MOCK_STATUS: status
            }
          }
        )
      try {
        run('ahead')
        run('identical')
        expect(readFileSync(join(root, 'output'), 'utf8')).toContain(
          `source_sha=${source.head_sha}`
        )
        for (const status of ['behind', 'diverged', '']) expect(() => run(status)).toThrow()
        expect(() => run('ahead', '../123')).toThrow()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'checks actual prepared bytes and rejects missing, corrupt or foreign CLI artifacts before writes',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'nightly-artifacts-'))
      const artifacts = join(root, 'artifacts')
      mkdirSync(artifacts)
      const sha = 'a'.repeat(40)
      const sums: string[] = []
      const targets = [
        'darwin-arm64',
        'darwin-x64',
        'linux-x64-gnu',
        'linux-arm64-gnu',
        'win32-x64'
      ]
      for (const target of targets) {
        const filename = `open-science-cli-1.0.0-nightly.gaaaaaaa-${target}.${target === 'win32-x64' ? 'zip' : 'tar.gz'}`
        writeFileSync(join(artifacts, filename), target)
        writeFileSync(
          join(artifacts, `${target}.json`),
          JSON.stringify({ filename, target, sourceSha: sha, version: '1.0.0-nightly.gaaaaaaa' })
        )
        sums.push(`${createHash('sha256').update(target).digest('hex')}  ${filename}\n`)
      }
      writeFileSync(join(artifacts, 'SHA256SUMS.txt'), sums.join(''))
      writeFileSync(join(artifacts, 'CLI-SHA256SUMS.txt'), sums.join(''))
      writeFileSync(join(artifacts, 'RELEASE-CERTIFICATION.json'), '{}')
      const script = step(
        workflow('nightly-publish.yml').jobs.publish,
        'Verify prepared nightly metadata'
      ).run!
      const run = (): string =>
        execFileSync(
          'bash',
          [
            '-e',
            '-o',
            'pipefail',
            '-c',
            `${process.platform === 'darwin' ? 'sha256sum() { shasum -a 256 "$@"; }\n' : ''}${script}`
          ],
          { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, SOURCE_SHA: sha } }
        )
      try {
        run()
        const receipt = join(artifacts, 'darwin-arm64.json')
        const original = readFileSync(receipt, 'utf8')
        writeFileSync(receipt, original.replace(sha, 'b'.repeat(40)))
        expect(run).toThrow()
        writeFileSync(receipt, original)
        const filename = JSON.parse(original).filename
        writeFileSync(join(artifacts, filename), 'corrupt')
        expect(run).toThrow()
        rmSync(join(artifacts, filename))
        expect(run).toThrow()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('publishes stable release notes as the GitHub and Zenodo description', () => {
    const publish = workflow('release.yml').jobs.publish
    const resolve = step(publish, 'Resolve release notes')
    const release = step(publish, 'Publish GitHub Release')

    expect(resolve.run).toContain('release-notes/${GITHUB_REF_NAME#v}/en.md')
    expect(resolve.run).toContain('if [ ! -s "$path" ]')
    expect(release.with?.body_path).toBe('${{ steps.release_notes.outputs.path }}')
    expect(release.with).not.toHaveProperty('generate_release_notes')
  })

  it('dispatches the advisory Windows upgrade drill only after stable publication', () => {
    const releaseWorkflow = workflow('release.yml')
    const publishSteps = releaseWorkflow.jobs.publish.steps ?? []
    const publishIndex = publishSteps.findIndex(({ name }) => name === 'Publish GitHub Release')
    const dispatchIndex = publishSteps.findIndex(
      ({ name }) => name === 'Dispatch advisory Windows upgrade smoke'
    )

    expect(releaseWorkflow.jobs).not.toHaveProperty('windows-upgrade-smoke')
    expect(dispatchIndex).toBeGreaterThan(publishIndex)
    expect(publishSteps[dispatchIndex]).toMatchObject({
      'continue-on-error': true,
      env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
    })
    expect(publishSteps[dispatchIndex].run).toContain('event_type=windows-upgrade-smoke')
    expect(publishSteps[dispatchIndex].run).toContain('client_payload[tag]=$GITHUB_REF_NAME')
  })

  it('runs Windows upgrade smoke independently against published release assets', () => {
    const smokeWorkflow = workflow('windows-upgrade-smoke.yml')
    const smoke = smokeWorkflow.jobs['windows-upgrade-smoke']

    const dryRun = smokeWorkflow.jobs['baseline-dry-run']
    expect(dryRun.if).toBe('${{ inputs.dry_run }}')
    expect(dryRun['runs-on']).toBe('windows-latest')
    expect(step(dryRun, 'Generate test database client').run).toBe('npx prisma generate')
    expect(
      step(dryRun, 'Test actual Windows baseline selection and installer observation').run
    ).toContain('scripts/windows-updater-certification.test.ts')
    const dispatch = smokeWorkflow.on?.repository_dispatch as { types: string[] }

    expect(dispatch.types).toEqual(['windows-upgrade-smoke'])
    expect(smokeWorkflow.on).toHaveProperty('workflow_dispatch')
    expect(smokeWorkflow.concurrency?.['cancel-in-progress']).toBe(false)
    expect(smoke['continue-on-error']).toBeUndefined()
    const checkout = step(smoke, 'Checkout smoke harness')
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'fetch-depth': 0 }
    })
    expect(checkout.with).not.toHaveProperty('ref')
    const released = step(smoke, 'Resolve released revision')
    expect(released.run).toContain('git rev-parse "$($env:CURRENT_TAG)^{commit}"')
    expect(released.run).toContain('git merge-base --is-ancestor $releasedSha $env:GITHUB_SHA')
    expect(released.run).toContain(
      'git ls-tree -r --name-only $releasedSha -- src/main/database/migrations'
    )
    expect(released.run).toContain('$migrationPattern')
    expect(released.run).toContain('Unexpected released migration path')
    expect(released.run).toContain('Released migrations are not a continuous prefix')
    expect(released.run).toContain('"sha=$releasedSha"')
    expect(released.run).toContain('"migration_count=$($migrationFiles.Count)"')
    expect(released.run).toContain('1a6faf134836d417b8bb1cdf89571f5d9dee2a0b')
    expect(released.run).toContain('f12fd1f871022c7a9b771d193202d9ecf98aca96')
    expect(released.run)
      .toContain(`$artifactSaveBase = git merge-base $artifactSaveCommit $releasedSha
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($artifactSaveBase)) {
  Write-Error "Could not resolve the released Artifact RPC contract at $releasedSha."
  exit 1
}
$artifactReservationBase = git merge-base $artifactReservationCommit $releasedSha
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($artifactReservationBase)) {
  Write-Error "Could not resolve the released Artifact RPC contract at $releasedSha."
  exit 1
}
if ($artifactSaveBase -eq $artifactSaveCommit) {
  $artifactRpcContract = 'save'
} elseif ($artifactReservationBase -eq $artifactReservationCommit) {
  $artifactRpcContract = 'reservation'
} else {
  $artifactRpcContract = 'legacy'
}`)
    expect(released.run).toContain('"artifact_rpc_contract=$artifactRpcContract"')
    const updaterRoot = step(smoke, 'Certify Windows electron-updater differential update').env
      ?.OPEN_SCIENCE_E2E_STORAGE_ROOT
    const installerRoot = step(
      smoke,
      'Drill Windows silent upgrade, process lock, rollback, and restart'
    ).env?.OPEN_SCIENCE_E2E_STORAGE_ROOT
    expect(updaterRoot).toBe('${{ runner.temp }}\\open-science-updater-certification')
    expect(installerRoot).toBe('${{ runner.temp }}\\open-science-installer-certification')
    expect(updaterRoot).not.toBe(installerRoot)
    expect(
      step(smoke, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain("--expected-migration-count '${{ steps.current.outputs.migration_count }}'")
    expect(
      step(smoke, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain("--artifact-rpc-contract '${{ steps.current.outputs.artifact_rpc_contract }}'")
    expect(step(smoke, 'Record Windows update-drill evidence')).toMatchObject({
      env: { GITHUB_SHA: '${{ steps.current.outputs.sha }}' }
    })
    expect(step(smoke, 'Download current Windows installer').run).toContain(
      'gh release download $env:CURRENT_TAG'
    )
    expect(step(smoke, 'Record Windows update-drill evidence').run).toContain(
      '--database-migration-certification'
    )
    expect(step(smoke, 'Upload Windows update-drill evidence').if).toBe('always()')
    expect(step(smoke, 'Report Windows update-drill outcome').run).toBe('exit 1')
  })

  it('pins third-party actions in every changed workflow', () => {
    for (const name of [
      'build.yml',
      'nightly.yml',
      'nightly-publish.yml',
      'release.yml',
      'release-sbom-poc.yml',
      'runtime-resource-soak.yml',
      'source-regression.yml',
      'windows-full-test.yml',
      'windows-upgrade-smoke.yml'
    ]) {
      for (const job of Object.values(workflow(name).jobs)) {
        for (const candidate of job.steps ?? []) {
          if (!candidate.uses || candidate.uses.startsWith('./')) continue
          expect(candidate.uses, `${name}: ${candidate.name}`).toMatch(/^[^@]+@[0-9a-f]{40}$/)
        }
      }
    }
  })

  it('automatically probes final stable-release SBOM coverage without publication rights', () => {
    const sbom = workflow('release-sbom-poc.yml')
    const job = sbom.jobs['sbom-poc']
    const triggers = sbom.on as {
      push: { branches: string[]; paths: string[] }
      release: { types: string[] }
      workflow_call: { inputs: { tag: { required: boolean; type: string } } }
      workflow_dispatch: { inputs: { tag: { required: boolean; type: string } } }
    }

    expect(triggers.workflow_call.inputs.tag).toMatchObject({
      required: true,
      type: 'string'
    })
    expect(triggers.release).toEqual({ types: ['published'] })
    expect(triggers.push).toEqual({
      branches: ['main'],
      paths: ['.github/workflows/release-sbom-poc.yml', 'scripts/ci/validate-release-sbom.mjs']
    })
    expect(triggers.workflow_dispatch.inputs.tag).toMatchObject({
      required: false,
      type: 'string'
    })
    expect(sbom.permissions).toEqual({ contents: 'read' })
    expect(sbom.concurrency).toEqual({
      group: 'release-sbom-poc-${{ github.event.release.tag_name || inputs.tag || github.sha }}',
      'cancel-in-progress': false
    })
    expect(job).toMatchObject({
      if: "${{ github.event_name != 'release' || github.event.release.prerelease == false }}",
      'continue-on-error': true,
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20
    })
    expect(step(job, 'Resolve stable release').run).toContain(
      'gh release list --exclude-drafts --exclude-pre-releases'
    )
    expect(step(job, 'Download final macOS arm64 archive').run).toContain(
      "--pattern '*-mac-arm64.zip'"
    )
    const materialize = step(job, 'Materialize packaged application for scanning')
    expect(materialize.run).toContain('npm ci --ignore-scripts --omit=optional')
    expect(materialize.run).toContain('unzip -q "$ARTIFACT_PATH"')
    expect(materialize.run).toContain('node node_modules/@electron/asar/bin/asar.js extract')
    expect(materialize.run).toContain('mv "$RUNNER_TEMP/app-asar-content" "$asar"')
    expect(step(job, 'Generate SPDX SBOM from final archive')).toMatchObject({
      uses: expect.stringMatching(/^anchore\/sbom-action@[0-9a-f]{40}$/),
      env: { SYFT_SELECT_CATALOGERS: '+javascript-package-cataloger' },
      with: {
        path: '${{ steps.scan.outputs.path }}',
        format: 'spdx-json',
        'output-file': 'release-sbom.spdx.json',
        'dependency-snapshot': false,
        'upload-artifact': false,
        'upload-release-assets': false,
        'syft-version': 'v1.52.0'
      }
    })
    expect(step(job, 'Validate representative packaged-component coverage').run).toContain(
      'node scripts/ci/validate-release-sbom.mjs'
    )
    expect(step(job, 'Validate representative packaged-component coverage').run).toContain(
      'exit "${status:-0}"'
    )
    expect(step(job, 'Upload PoC evidence')).toMatchObject({
      if: '${{ always() }}',
      with: {
        'retention-days': 7,
        'if-no-files-found': 'warn'
      }
    })
    const text = readFileSync(join(process.cwd(), '.github/workflows/release-sbom-poc.yml'), 'utf8')
    expect(text).not.toContain('actions/attest')
    expect(text).not.toContain('contents: write')

    expect(workflow('release.yml').jobs['release-sbom-poc']).toMatchObject({
      needs: 'publish',
      permissions: { contents: 'read' },
      uses: './.github/workflows/release-sbom-poc.yml',
      with: { tag: '${{ github.ref_name }}' }
    })
  })

  it.each([
    'nightly.yml',
    'windows-full-test.yml',
    'source-regression.yml',
    'runtime-resource-soak.yml'
  ])('reports scheduled %s outcomes after all scheduled validation jobs', (name) => {
    const document = workflow(name)
    const { report, ...jobs } = document.jobs
    const script = step(report, 'Open, refresh, or close the tracking issue')

    expect(report.name).toBe('Report scheduled outcome')
    expect(report.if).toBe("${{ always() && github.event_name == 'schedule' }}")
    expect(report).toMatchObject({
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      permissions: { contents: 'read', issues: 'write' }
    })
    expect(document.permissions).toEqual({ actions: 'read', contents: 'read' })
    const scheduledJobIds: string[] = []
    for (const [id, job] of Object.entries(jobs)) {
      if (
        job.uses === './.github/workflows/build.yml' ||
        job.uses === './.github/workflows/performance-package-dryrun.yml'
      ) {
        expect(job.permissions, id).toEqual({ contents: 'read', 'id-token': 'write' })
      } else if (
        name === 'source-regression.yml' &&
        (id === 'runtime_evidence' || id === 'static_impact')
      ) {
        expect(job.permissions, id).toEqual({ contents: 'read' })
        const mode = id === 'runtime_evidence' ? 'runtime-evidence' : 'static-impact'
        expect(job.if, id).toBe(
          `\${{ github.event_name == 'workflow_dispatch' && inputs.mode == '${mode}' }}`
        )
        continue
      } else {
        expect(job.permissions, id).toBeUndefined()
      }
      scheduledJobIds.push(id)
    }
    expect([...(report.needs as string[])].sort()).toEqual(scheduledJobIds.sort())
    expect(step(report, 'Checkout reporter')).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'persist-credentials': false,
        'sparse-checkout': expect.stringContaining('scripts/ci/report-scheduled-failure.mjs')
      }
    })
    expect(script.uses).toBe('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3')
    // Nightly's certification and regression callers are advisory, so their job results stay
    // successful; the reporter inspects the nested conclusions instead.
    const advisory = name === 'nightly.yml' ? " || steps.advisory.outputs.ok != 'true'" : ''
    expect(script.env?.CONCLUSION).toBe(
      name === 'source-regression.yml'
        ? "${{ needs.macos_setup.result == 'success' && needs.regression.result == 'success' && needs.packages.result == 'success' && needs.portable.result == 'success' && needs.portable_report.result == 'success' && 'success' || 'failure' }}"
        : `\${{ (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')${advisory}) && 'failure' || 'success' }}`
    )
    if (name === 'nightly.yml') {
      const detect = step(report, 'Detect advisory job failures')
      expect(detect.id).toBe('advisory')
      expect(detect.run).toContain('actions/runs/$GITHUB_RUN_ID/jobs')
      expect(detect.run).toContain('nightly-publish-gates.mjs --jobs')
      expect(detect.run).toContain('--report')
      expect(step(report, 'Checkout reporter').with?.['sparse-checkout']).toContain(
        'scripts/ci/nightly-publish-gates.mjs'
      )
    }
    expect(script.with?.script).toContain(`workflowFile: '${name}'`)
    expect(script.with?.script).toContain('conclusion: process.env.CONCLUSION')
    expect(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')).toContain(
      'tracking issue labelled ci-scheduled-failure'
    )
  })
})

describe('website mirror publication intent', () => {
  it('serializes channel writers and defaults to versioned backfill', () => {
    const mirror = workflow('mirror-to-website.yml')
    expect(mirror.concurrency).toEqual({
      group: 'mirror-website-stable',
      'cancel-in-progress': false
    })
    const dispatch = mirror.on?.workflow_dispatch as {
      inputs: {
        mode: { default: string; options: string[] }
        bootstrap_linux_arm64: { default: boolean; type: string }
      }
    }
    expect(dispatch.inputs.mode).toMatchObject({
      default: 'backfill',
      options: ['backfill', 'promote']
    })
    const publication = step(mirror.jobs.mirror, 'Sync installers to versioned path')
    expect(dispatch.inputs.bootstrap_linux_arm64).toMatchObject({ default: false, type: 'boolean' })
    expect(publication.env?.BOOTSTRAP_LINUX_ARM64).toBe('${{ inputs.bootstrap_linux_arm64 }}')
    expect(publication.env?.MODE).toBe('${{ inputs.mode }}')
    expect(publication.if).toBe('${{ !inputs.dry_run }}')
    expect(publication.run).toBe('node scripts/publish-update-channel.mjs')
  })
})

describe('build verification throughput', () => {
  it('runs Ubuntu static checks independently from six complete portable shards', () => {
    const { verify, verify_tests: tests, verify_macos: macos } = workflow('build.yml').jobs
    expect(verify['runs-on']).toBe('ubuntu-latest')
    expect(verify.needs).toBeUndefined()
    expect(tests.needs).toBeUndefined()
    expect(tests['runs-on']).toBe('ubuntu-latest')
    expect(tests.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6])
    expect(tests['timeout-minutes']).toBe(60)
    expect(step(tests, 'Test complete suite shard').run).toContain('--testTimeout=60000')
    expect(tests.env).toEqual({
      VITEST_DEFER_COVERAGE_THRESHOLDS: '1',
      VITEST_PORTABLE_CI: '1'
    })
    expect(step(tests, 'Test complete suite shard').run).toContain('--shard=${{ matrix.shard }}/6')
    expect(step(tests, 'Test complete suite shard').run).toContain('--coverage')
    expect(step(tests, 'Test complete suite shard').run).toContain('--reporter=blob')
    expect(step(tests, 'Test complete suite shard').run).toContain('--reporter=github-actions')
    expect(step(tests, 'Enforce full-suite shard').if).toBe('${{ always() }}')
    expect(step(verify, 'Check translation catalogs').run).toBe(
      'npx vitest run src/renderer/src/i18n/resources.test.ts'
    )
    for (const job of [verify, tests, macos]) {
      expect(job.if).toBe('${{ !inputs.skip_verify }}')
    }
    expect(macos['runs-on']).toBe('macos-15')
    const native = step(macos, 'Test macOS native behavior and release regressions').run
    for (const path of [
      'src/main/windows.test.ts',
      'packages/notebook-network-sandbox/src/filesystem-policy.test.ts',
      'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts',
      'packages/notebook-network-sandbox/src/network-enforcement.integration.test.ts',
      'src/main/net/network-info.test.ts',
      'src/main/notebook/managed-runtime-guard.test.ts',
      'src/main/notebook/network-sandbox-owner.macos-isolation.integration.test.ts',
      'src/main/notebook/runtime-service.macos-isolation.integration.test.ts',
      'src/main/notebook/package-cache-sandbox.integration.test.ts',
      'src/main/acp/prompt-attachment-notebook-sandbox.integration.test.ts',
      'src/main/compute/compute-remote-operation-owner.test.ts',
      'scripts/ci/mirror-channel-publication.test.ts',
      'src/main/literature/catalog-capacity.test.ts'
    ])
      expect(native).toContain(path)
    expect(native).not.toContain('-t ')
    expect(native).toContain('set -euo pipefail')
    expect(native).toContain(
      `OPEN_SCIENCE_TEST_PY_ENV="$(python3 -c 'import sys; print(sys.executable)')"`
    )
    expect(native).toContain('test -x "$OPEN_SCIENCE_TEST_PY_ENV"')
    expect(native).toContain('export OPEN_SCIENCE_TEST_PY_ENV')
    expect(step(macos, 'Test production macOS kernel sandbox').run).toContain(
      'executes the repl loop through the production network sandbox'
    )
  })

  it('requires successful shards and all blobs before enforcing aggregate coverage', () => {
    const job = workflow('build.yml').jobs.verify_coverage
    expect(job.needs).toBe('verify_tests')
    expect(job.if).toBe('${{ !cancelled() && !inputs.skip_verify }}')
    expect(job.env).toBeUndefined()
    const guard = step(job, 'Require complete successful shards')
    expect(guard.env).toEqual({ SHARDS_RESULT: '${{ needs.verify_tests.result }}' })
    expect(guard.run).toContain('test "$SHARDS_RESULT" = success')
    expect(guard.run).toContain('for shard in 1 2 3 4 5 6; do')
    expect(guard.run).toContain('test -s "vitest-reports/blob-$shard.json"')
    expect(step(job, 'Merge test reports and enforce coverage').run).toBe(
      'npx vitest run --merge-reports=vitest-reports --coverage --passWithNoTests'
    )
    expect(step(job, 'Upload coverage report').with).toMatchObject({
      overwrite: true,
      'if-no-files-found': 'error'
    })
  })

  it.each([
    'complete',
    'missing-4',
    'empty-4',
    'missing-5',
    'empty-5',
    'missing-6',
    'empty-6',
    'failed-shard'
  ])('checks actual shard artifacts before coverage: %s', (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), 'build-coverage-guard-'))
    try {
      mkdirSync(join(cwd, 'vitest-reports'))
      for (const shard of [1, 2, 3, 4, 5, 6]) {
        if (scenario === `missing-${shard}`) continue
        writeFileSync(
          join(cwd, `vitest-reports/blob-${shard}.json`),
          scenario === `empty-${shard}` ? '' : '{}'
        )
      }
      const guard = step(
        workflow('build.yml').jobs.verify_coverage,
        'Require complete successful shards'
      )
      const run = (): void => {
        execFileSync('bash', ['-e', '-c', guard.run!], {
          cwd,
          env: {
            ...process.env,
            SHARDS_RESULT: scenario === 'failed-shard' ? 'failure' : 'success'
          },
          stdio: 'pipe'
        })
      }
      if (scenario === 'complete') expect(run).not.toThrow()
      else expect(run).toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reuses real verification for a manual release dry-run without packaging or publication', () => {
    const release = workflow('release.yml')
    const build = workflow('build.yml')
    expect(release.on?.workflow_dispatch).toMatchObject({
      inputs: { verify_only: { type: 'boolean', default: false } }
    })
    expect(release.jobs.build.with?.verify_only).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.verify_only }}"
    )
    expect(build.jobs.setup.if).toBe('${{ !inputs.verify_only }}')
    expect(build.jobs.build.needs).toEqual(['setup'])
    expect(build.jobs.build.if).toBe("${{ !cancelled() && needs.setup.result == 'success' }}")
    expect(release.jobs['package-smoke'].if).toBe('${{ !inputs.verify_only }}')
    for (const name of ['publish', 'notarize-mac']) {
      expect(release.jobs[name].if).toBe(
        "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
      )
    }
  })

  it('reuses Release packages for diagnostic smoke without builds or publication', () => {
    const release = workflow('release.yml')
    const smoke = workflow('package-smoke.yml')
    expect(release.on?.workflow_dispatch).toMatchObject({
      inputs: { package_smoke_run_id: { type: 'string', default: '' } }
    })
    for (const name of ['release-preflight', 'build']) {
      expect(release.jobs[name].if).toBe(
        "${{ github.event_name != 'workflow_dispatch' || !inputs.package_smoke_run_id }}"
      )
    }
    expect(release.jobs['package-smoke-dry-run']).toEqual({
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.package_smoke_run_id != '' }}",
      uses: './.github/workflows/package-smoke.yml',
      with: {
        artifact_run_id: '${{ inputs.package_smoke_run_id }}',
        require_windows_signing: false
      }
    })
    expect(smoke.on?.workflow_call).toMatchObject({
      inputs: { artifact_run_id: { type: 'string', default: '' } }
    })
    expect(step(smoke.jobs.smoke, 'Download packaged artifacts').with).toMatchObject({
      'run-id': '${{ inputs.artifact_run_id || github.run_id }}',
      'github-token': '${{ github.token }}'
    })
    for (const name of [
      'Record platform certification evidence',
      'Upload platform certification evidence'
    ]) {
      expect(step(smoke.jobs.smoke, name).if).toBe(
        '${{ !inputs.install_only && !inputs.artifact_run_id }}'
      )
    }
    for (const name of ['publish', 'notarize-mac', 'cli-artifacts']) {
      expect(release.jobs[name].if).toContain("github.event_name == 'push'")
    }
    expect(release.jobs.regression.needs).toEqual(['build', 'package-smoke'])
    expect(release.jobs['release-sbom-poc'].needs).toBe('publish')
  })

  it.each([
    { certified: 'true', source: '', operation: 'notarize', arch: 'all', allowed: true },
    { certified: 'true', source: '123', operation: 'notarize', arch: 'all', allowed: false },
    { certified: 'true', source: '', operation: 'staple', arch: 'all', allowed: false },
    { certified: 'true', source: '', operation: 'smoke', arch: 'all', allowed: false },
    { certified: 'true', source: '', operation: 'notarize', arch: 'arm64', allowed: false },
    { certified: 'false', source: '123', operation: 'staple', arch: 'arm64', allowed: true },
    { certified: 'false', source: '123', operation: 'smoke', arch: 'x64', allowed: true },
    { certified: 'false', source: '123', operation: 'skip', arch: 'arm64', allowed: false },
    { certified: 'false', source: '123', operation: 'staple', arch: 'unknown', allowed: false }
  ])(
    'enforces the actual release/dry-run shell guard: %j',
    ({ certified, source, operation, arch, allowed }) => {
      const execute = (): void => {
        execFileSync(
          'bash',
          [
            '-e',
            '-c',
            step(workflow('notarize-mac.yml').jobs.notarize, 'Require unpublished build artifacts')
              .run!
          ],
          {
            stdio: 'pipe',
            env: {
              ...process.env,
              FROM_RUN: 'true',
              CERTIFIED_BUILD: certified,
              SOURCE_RUN: source,
              OPERATION: operation,
              ARCHITECTURE: arch
            }
          }
        )
      }
      if (allowed) expect(execute).not.toThrow()
      else expect(execute).toThrow()
    }
  )

  it('retries Apple transport operations without wrapping submission or weakening package gates', () => {
    const notarize = workflow('notarize-mac.yml')
    const job = notarize.jobs.notarize
    const script = step(job, 'Notarize + staple').run ?? ''
    expect(script.match(/xcrun notarytool submit/g)).toHaveLength(1)
    expect(script).not.toContain('apple-notarization-retry.mjs notarytool submit')
    expect(script).not.toContain('2>/dev/null')
    for (const operation of ['notarytool wait', 'stapler staple', 'stapler validate']) {
      expect(script).toContain(`apple-notarization-retry.mjs ${operation}`)
    }
    expect(script).toContain('if [ "$OPERATION" = "notarize" ]; then submit "$dmg"; fi')
    expect(script).toContain('Accepted) [ "$wait_code" = 0 ]')
    expect(step(job, 'Smoke test final macOS packages').run).toContain('--gatekeeper')
    expect(step(job, 'Smoke test final macOS packages')['continue-on-error']).not.toBe(true)
    expect(step(job, 'Remove App Store Connect API key').if).toBe('always()')
  })

  it('limits CFNetwork capture to unauthenticated diagnostics and exports only summaries', () => {
    const capture = step(workflow('notarize-mac.yml').jobs.notarize, 'Notarize + staple')
    expect(capture.env?.CFNETWORK_DIAGNOSTICS).toBe(
      "${{ !inputs.certified_build && inputs.source_run != '' && inputs.operation != 'notarize' && '3' || '0' }}"
    )
    expect(capture.run).toContain('--predicate \'process == "stapler"\'')
    expect(capture.run).toContain('--summarize-network "$network_log"')
    expect(capture.run).toContain('trap finish_network_diagnostics EXIT')
    expect(capture.run).toContain('exit "$code"')
    expect(capture.run).toContain('rm -f "$network_log"')
    expect(capture.run).toContain('(deny network-outbound (remote udp "*:443"))')
    expect(capture.run!.indexOf('stapler_prefix=(')).toBeLessThan(
      capture.run!.indexOf('if [ "${CFNETWORK_DIAGNOSTICS:-0}" = 3 ]')
    )
    expect(capture.run).not.toContain('stapler_prefix=()')
    expect(capture.run?.match(/"\$\{stapler_prefix\[@\]\}" node/g)).toHaveLength(4)
    expect(capture.run).not.toContain(
      'stapler_prefix[@]}" node scripts/ci/apple-notarization-retry.mjs notarytool'
    )
  })

  it('reuses source artifacts in focused dry runs without emitting release certification', () => {
    const dryRun = workflow('notarize-dryrun.yml')
    expect(dryRun.jobs.build.if).toContain("inputs.source_run == ''")
    expect(dryRun.jobs.notarize.uses).toBe('./.github/workflows/notarize-mac.yml')
    expect(dryRun.jobs.notarize.with).toMatchObject({
      certified_build: false,
      source_run: '${{ inputs.source_run }}',
      architecture: '${{ inputs.architecture }}',
      operation: '${{ inputs.operation }}'
    })
    expect(dryRun.jobs.notarize.if).toContain("needs.build.result == 'skipped'")
    expect(Object.keys(dryRun.jobs)).toEqual(['validate', 'build', 'notarize'])
    const job = workflow('notarize-mac.yml').jobs.notarize
    expect(step(job, 'Download signed mac artifact (from this run)').with).toMatchObject({
      'run-id': '${{ inputs.source_run || github.run_id }}',
      'github-token': '${{ github.token }}'
    })
    expect(step(job, 'Validate reused release source').run).toContain(
      'validate-notarize-source.mjs'
    )
    expect(step(job, 'Require unpublished build artifacts').run).toContain(
      'Focused modes cannot produce release certification.'
    )
    expect(step(job, 'Refresh macOS certification evidence').if).toContain('inputs.certified_build')
    expect(step(job, 'Gate on API key presence').run).toContain(
      'Dry run requires Apple credentials'
    )
    expect(step(job, 'Re-emit stapled artifact (for publish)').with?.['run-id']).toBeUndefined()
  })

  it('keeps reusable build workflows read-only, caller-scoped, and time-bounded', () => {
    const build = workflow('build.yml')
    const notarize = workflow('notarize-mac.yml')
    const regression = workflow('desktop-regression.yml')
    const dryRun = workflow('notarize-dryrun.yml')
    const release = workflow('release.yml')

    expect(build.permissions).toEqual({ contents: 'read' })
    expect(notarize.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(dryRun.permissions).toEqual({ contents: 'read', actions: 'read' })
    // Packaging and notarization queue instead of cancelling; regression reruns supersede.
    expect(build.concurrency).toEqual({
      group: 'build-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': false
    })
    expect(notarize.concurrency).toEqual({
      group: 'notarize-mac-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': false
    })
    expect(regression.concurrency).toEqual({
      group: 'desktop-regression-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(build.jobs.verify['timeout-minutes']).toBe(15)
    expect(build.jobs.setup['timeout-minutes']).toBe(5)
    expect(build.jobs.build['timeout-minutes']).toBe("${{ matrix.platform == 'mac' && 45 || 30 }}")
    expect(regression.jobs.source['timeout-minutes']).toBe(5)
    expect(release.jobs['release-preflight']['timeout-minutes']).toBe(5)
    expect(release.jobs.publish['timeout-minutes']).toBe(15)
    const publishSteps = release.jobs.publish.steps ?? []
    const setupNode = publishSteps.findIndex(({ name }) => name === 'Setup Node')
    const install = publishSteps.findIndex(
      ({ name }) => name === 'Install release transform dependencies'
    )
    expect(publishSteps[setupNode]?.with).toEqual({ 'node-version': 24 })
    expect(setupNode).toBeLessThan(install)
    for (const reusable of [build, regression, workflow('package-smoke.yml')]) {
      for (const job of Object.values(reusable.jobs)) {
        for (const checkout of (job.steps ?? []).filter(({ uses }) =>
          uses?.startsWith('actions/checkout@')
        )) {
          expect(checkout.with?.['persist-credentials']).toBe(false)
        }
      }
    }
  })
})
