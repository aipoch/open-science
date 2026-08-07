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
  steps?: Step[]
  strategy?: { matrix?: { shard?: number[] } }
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: Record<string, unknown>
}

const workflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')) as Workflow

const step = (job: Job, name: string): Step => {
  const result = job.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing step: ${name}`)
  return result
}

describe('release and scheduled workflow topology', () => {
  it('runs three serial Windows full-suite shards', () => {
    const job = workflow('windows-full-test.yml').jobs.windows_full_test
    const test = step(job, 'Test complete suite shard')

    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(test.run).toContain('--shard=${{ matrix.shard }}/3')
    expect(test.run).toContain('--maxWorkers=1')
  })

  it('runs reusable verification beside native builds while callers remain fail closed', () => {
    const build = workflow('build.yml').jobs.build
    const nightly = workflow('nightly.yml')
    const release = workflow('release.yml')

    expect(build.needs).toBe('setup')
    expect(build.if).toBe("${{ needs.setup.result == 'success' }}")
    expect(nightly.jobs['publish-dry-run'].needs).toEqual(['plan', 'build'])
    expect(release.jobs.publish.needs).toEqual(['build', 'notarize-mac'])
    expect(release.jobs['notarize-mac'].needs).toBe('build')
  })

  it('batches Nightly hourly and limits manual runs to the real publish dry-run', () => {
    const nightly = workflow('nightly.yml')
    const schedule = nightly.on?.schedule as Array<{ cron: string }>

    expect(nightly.on).not.toHaveProperty('push')
    expect(schedule).toEqual([{ cron: '17 * * * *' }])
    expect(nightly.on).toHaveProperty('workflow_dispatch')
    expect(nightly.concurrency).toEqual({
      group: 'nightly-build',
      'cancel-in-progress': true
    })
    expect(nightly.jobs.build).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_build == 'true'",
      uses: './.github/workflows/build.yml',
      with: { nightly: true }
    })
    expect(step(nightly.jobs.plan, 'Compare main with the rolling nightly tag').run).toContain(
      'repos/$GITHUB_REPOSITORY/commits/nightly'
    )
    expect(nightly.jobs['publish-dry-run']).toMatchObject({
      needs: ['plan', 'build'],
      if: "github.event_name == 'workflow_dispatch' && needs.build.result == 'success'",
      uses: './.github/workflows/nightly-publish.yml',
      with: {
        dry_run: true,
        source_run_id: '${{ github.run_id }}',
        source_sha: '${{ github.sha }}'
      }
    })
  })

  it('serializes successful scheduled Nightly publication without cancellation', () => {
    const publishWorkflow = workflow('nightly-publish.yml')
    const plan = publishWorkflow.jobs.plan
    const publish = publishWorkflow.jobs.publish
    const download = step(publish, 'Download all build artifacts')
    const reset = step(publish, 'Reset nightly release')
    const release = step(publish, 'Publish nightly pre-release')
    const dryRun = step(publish, 'Upload prepared nightly dry-run')
    const workflowRun = publishWorkflow.on?.workflow_run as {
      types: string[]
      workflows: string[]
    }

    expect(workflowRun).toEqual({ workflows: ['Nightly'], types: ['completed'] })
    expect(publishWorkflow.on).toHaveProperty('workflow_call')
    expect(publishWorkflow.concurrency).toEqual({
      group: 'nightly-publish',
      'cancel-in-progress': false
    })
    expect(plan.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(plan.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(plan.if).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(step(plan, 'Check for an unpublished build').run).toContain(
      'repos/$GITHUB_REPOSITORY/commits/nightly'
    )
    expect(publish).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_publish == 'true'"
    })
    expect(download.with).toMatchObject({
      'github-token': '${{ secrets.GITHUB_TOKEN }}',
      'run-id': '${{ env.SOURCE_RUN_ID }}',
      'merge-multiple': true
    })
    expect(dryRun.if).toBe("env.DRY_RUN == 'true'")
    expect(reset.if).toBe("env.DRY_RUN != 'true'")
    expect(release.if).toBe("env.DRY_RUN != 'true'")
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
    expect(step(smoke, 'Download current Windows installer').run).toContain(
      'gh release download $env:CURRENT_TAG'
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
