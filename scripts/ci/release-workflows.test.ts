import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'runs-on'?: string
  steps?: Step[]
  strategy?: { matrix?: { shard?: number[] } }
  'timeout-minutes'?: number
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
  it('batches latest-main Windows coverage hourly across three serial shards', () => {
    const windows = workflow('windows-full-test.yml')
    const schedule = windows.on?.schedule as Array<{ cron: string }>
    const dispatch = windows.on?.workflow_dispatch as {
      inputs?: { mode?: { default?: string; options?: string[] } }
    }
    const plan = windows.jobs.plan
    const job = windows.jobs.windows_full_test
    const sandbox = windows.jobs.notebook_sandbox
    const test = step(job, 'Test complete suite shard')
    const sandboxSmoke = step(sandbox, 'Test AppContainer ownership and removal lifecycle')

    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(test.run).toContain('--shard=${{ matrix.shard }}/3')
    expect(test.run).toContain('--maxWorkers=1')
    expect(windows.on).not.toHaveProperty('push')
    expect(schedule).toEqual([{ cron: '47 * * * *' }])
    expect(dispatch.inputs?.mode).toMatchObject({
      default: 'full',
      options: ['full', 'notebook-sandbox']
    })
    expect(windows.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(plan).toMatchObject({
      'runs-on': 'ubuntu-latest',
      outputs: { should_test: '${{ steps.decide.outputs.should_test }}' }
    })
    expect(step(plan, 'Check for untested main changes').run).toContain(
      'actions/workflows/windows-full-test.yml/runs?branch=main&event=schedule&status=success&per_page=1'
    )
    expect(job).toMatchObject({
      needs: 'plan',
      if: "${{ needs.plan.outputs.should_test == 'true' && (github.event_name != 'workflow_dispatch' || inputs.mode == 'full') }}"
    })
    expect(sandbox).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_test == 'true'",
      'runs-on': 'windows-latest',
      'timeout-minutes': 20
    })
    expect(sandboxSmoke.run).toContain('vendor/windows-src/ci/smoke.ps1')
    expect(sandboxSmoke.run).toContain('vendor/windows/x64/notebook-appcontainer-host.exe')
    expect(sandboxSmoke.run).toContain('-Mode Full')
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

    expect(schedule).toEqual([{ cron: '23 3 * * *' }])
    expect(dispatch.inputs?.mode).toMatchObject({
      default: 'smoke',
      options: ['smoke', 'soak']
    })
    expect(resource.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(resource.concurrency).toEqual({
      group: 'runtime-resource-soak-${{ github.ref }}',
      'cancel-in-progress': true
    })
    expect(step(plan, 'Check for unprofiled main changes').run).toContain(
      'event=schedule&status=success&per_page=1'
    )
    expect(soak).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_test == 'true'",
      'runs-on': 'windows-latest',
      'timeout-minutes': 40
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

    expect(build.needs).toBe('setup')
    expect(build.if).toBe("${{ needs.setup.result == 'success' }}")
    expect(nightly.jobs.prepare.needs).toEqual(['plan', 'build', 'package-smoke'])
    expect(release.jobs.publish.needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(release.jobs['notarize-mac'].needs).toEqual(['build', 'package-smoke'])
  })

  it('batches Nightly hourly and prepares publication without write access', () => {
    const nightly = workflow('nightly.yml')
    const schedule = nightly.on?.schedule as Array<{ cron: string }>
    const prepare = nightly.jobs.prepare

    expect(nightly.on).not.toHaveProperty('push')
    expect(schedule).toEqual([{ cron: '17 * * * *' }])
    expect(nightly.on).toHaveProperty('workflow_dispatch')
    expect(nightly.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(nightly.concurrency).toEqual({
      group: 'nightly-build',
      'cancel-in-progress': true
    })
    expect(nightly.jobs.build).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_build == 'true' && inputs.dry_run != 'runtime-source'",
      uses: './.github/workflows/build.yml',
      with: {
        nightly: true,
        skip_verify: "${{ inputs.dry_run == 'macos-x64' }}",
        platform_name: "${{ inputs.dry_run == 'macos-x64' && 'macos-x64' || '' }}"
      }
    })
    expect(step(nightly.jobs.plan, 'Compare main with the rolling nightly tag').run).toContain(
      'repos/$GITHUB_REPOSITORY/commits/nightly'
    )
    expect(nightly.jobs).not.toHaveProperty('publish-dry-run')
    const dispatch = nightly.on?.workflow_dispatch as {
      inputs?: { dry_run?: { default?: string; options?: string[] } }
    }
    expect(dispatch.inputs?.dry_run).toMatchObject({
      default: 'full',
      options: ['full', 'runtime-source', 'macos-x64']
    })
    expect(nightly.jobs['package-smoke'].if).toBe("inputs.dry_run != 'macos-x64'")
    expect(nightly.jobs['runtime-certification'].if).toContain("inputs.dry_run != 'macos-x64'")
    expect(prepare).toMatchObject({
      needs: ['plan', 'build', 'package-smoke'],
      if: "needs.build.result == 'success' && needs.package-smoke.result == 'success'",
      'runs-on': 'ubuntu-latest'
    })
    expect(step(prepare, 'Aggregate release certification evidence').run).toContain(
      '--expected-sha "$GITHUB_SHA"'
    )
    expect(step(prepare, 'Generate checksums').run).toContain('sha256sum')
    expect(step(prepare, 'Upload prepared nightly metadata').with).toMatchObject({
      name: 'nightly-ready',
      'retention-days': 1,
      'if-no-files-found': 'error'
    })
  })

  it('publishes prepared scheduled artifacts without executing triggering-run code', () => {
    const publishWorkflow = workflow('nightly-publish.yml')
    const plan = publishWorkflow.jobs.plan
    const publish = publishWorkflow.jobs.publish
    const download = step(publish, 'Download prepared nightly artifacts')
    const refresh = step(publish, 'Refresh nightly release')
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
    const publicationPlan = step(plan, 'Check for an unpublished build').run
    expect(publicationPlan).toContain('repos/$GITHUB_REPOSITORY/commits/nightly')
    expect(publicationPlan).toContain('repos/$GITHUB_REPOSITORY/compare/$published...$SOURCE_SHA')
    expect(publicationPlan).toContain("grep -Eq 'HTTP (404|422)'")
    expect(publicationPlan).toContain('cat "$error_file" >&2')
    expect(publicationPlan).toContain('ahead)')
    expect(publicationPlan).toContain('identical|behind)')
    expect(publicationPlan).toContain('skipping stale publication')
    expect(publicationPlan).toContain('Cannot safely advance nightly')
    expect(publish).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_publish == 'true'"
    })
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
    expect(refresh.if).toBeUndefined()
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/releases/tags/nightly')
    expect(refresh.run).toContain('refusing to create a new Zenodo-visible release')
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/git/ref/tags/nightly')
    expect(refresh.run).toContain('refusing to publish without a retry marker')
    expect(refresh.run).not.toContain('--method PATCH')
    expect(refresh.run).not.toContain('--method POST')
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/releases/$release_id/assets')
    expect(refresh.run).toContain('repos/$GITHUB_REPOSITORY/releases/assets/$asset_id')
    expect(refresh.run).not.toContain('DELETE "repos/$GITHUB_REPOSITORY/releases/$release_id"')
    expect(refresh.run).not.toMatch(/\|\|\s*true/)
    expect(release.if).toBeUndefined()
    expect(advance.run).toContain('--method PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/nightly"')
    expect(advance.run).toContain('-F force=true')
    const publishSteps = publish.steps ?? []
    expect(publishSteps.indexOf(refresh)).toBeLessThan(publishSteps.indexOf(release))
    expect(publishSteps.indexOf(release)).toBeLessThan(publishSteps.indexOf(advance))
  })

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
    expect(released.run).toContain('f12fd1f871022c7a9b771d193202d9ecf98aca96')
    expect(released.run)
      .toContain(`$artifactReservationBase = git merge-base $artifactReservationCommit $releasedSha
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($artifactReservationBase)) {
  Write-Error "Could not resolve the released Artifact RPC contract at $releasedSha."
  exit 1
}
if ($artifactReservationBase -eq $artifactReservationCommit) {
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
})
