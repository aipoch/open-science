import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'continue-on-error'?: boolean
  if?: string
  needs?: string | string[]
  'runs-on'?: string
  steps?: WorkflowStep[]
  strategy?: { matrix?: Record<string, unknown> }
  'timeout-minutes'?: number
}

type Workflow = {
  jobs: Record<string, WorkflowJob>
  on?: {
    push?: { branches?: string[]; tags?: string[] }
    workflow_dispatch?: unknown
  }
}

const readWorkflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Workflow

const findStep = (job: WorkflowJob, name: string): WorkflowStep => {
  const step = job.steps?.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

describe('post-merge Windows validation', () => {
  it('runs the complete Windows suite independently from nightly and release publishing', () => {
    const build = readWorkflow('build.yml')
    const workflow = readWorkflow('windows-full-test.yml')
    const job = workflow.jobs.windows_full_test

    expect(build.jobs.windows_full_test).toBeUndefined()
    expect(workflow.on?.push).toMatchObject({ branches: ['main'], tags: ['v*'] })
    expect(job).toMatchObject({
      'continue-on-error': true,
      'runs-on': 'windows-latest'
    })
    expect(job.strategy?.matrix?.shard).toEqual([1, 2])
    expect(findStep(job, 'Test complete suite shard').run).toBe(
      'npm test -- --shard=${{ matrix.shard }}/2 --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000'
    )
  })

  it('hard-gates every packaged Windows build on a fresh install/start/uninstall smoke', () => {
    const job = readWorkflow('build.yml').jobs.build
    const buildIndex = job.steps?.findIndex(({ name }) => name === 'Build & package') ?? -1
    const smokeIndex =
      job.steps?.findIndex(({ name }) => name === 'Smoke test Windows installer') ?? -1
    const uploadIndex = job.steps?.findIndex(({ name }) => name === 'Upload build artifacts') ?? -1
    const smoke = findStep(job, 'Smoke test Windows installer')

    expect(smoke.if).toBe("matrix.platform == 'win'")
    expect(smoke.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(smoke['timeout-minutes']).toBe(10)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(smokeIndex).toBeGreaterThan(buildIndex)
    expect(uploadIndex).toBeGreaterThan(smokeIndex)
  })

  it('runs the previous-stable upgrade smoke alongside notarization before publishing', () => {
    const release = readWorkflow('release.yml')
    const upgrade = release.jobs['windows-upgrade-smoke']

    expect(upgrade['runs-on']).toBe('windows-latest')
    expect(upgrade.needs).toBe('build')
    expect(upgrade['timeout-minutes']).toBe(20)
    expect(findStep(upgrade, 'Setup Node')).toMatchObject({
      uses: 'actions/setup-node@v7',
      with: { 'node-version': 22 }
    })
    expect(findStep(upgrade, 'Download current Windows installer').uses).toBe(
      'actions/download-artifact@v8'
    )
    const previous = findStep(upgrade, 'Download previous stable Windows installer')
    expect(previous.env?.CURRENT_TAG).toBe('${{ github.ref_name }}')
    expect(previous.run).toContain('gh release download')
    expect(previous.run).toContain("$_.tagName -like 'v*'")
    expect(previous.run).toContain('$_.tagName -ne $env:CURRENT_TAG')
    expect(findStep(upgrade, 'Smoke test Windows upgrade').run).toContain(
      '--previous-installer-dir previous'
    )
    expect(release.jobs.publish.needs).toEqual(['build', 'notarize-mac', 'windows-upgrade-smoke'])
  })
})
