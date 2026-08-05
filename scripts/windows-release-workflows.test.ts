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
  permissions?: Record<string, string>
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
      'npm test -- --shard=${{ matrix.shard }}/2 --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000'
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

  it('builds every platform without repeating the verified typecheck', () => {
    const workflow = readWorkflow('build.yml')
    const verifyTypecheck = findStep(workflow.jobs.verify, 'Typecheck')
    const build = findStep(workflow.jobs.build, 'Build & package')
    const commands = build.run?.split('\n').map((line) => line.trim()) ?? []

    expect(verifyTypecheck.run).toBe('npm run typecheck')
    expect(commands).toContain('npm run build:e2e')
    expect(commands).toContain('npm run build:web')
    expect(commands).not.toContain('npm run build')
    expect(commands.some((command) => command.startsWith('npm run typecheck'))).toBe(false)
  })

  it('runs the previous-stable upgrade smoke alongside notarization before publishing', () => {
    const release = readWorkflow('release.yml')
    const upgrade = release.jobs['windows-upgrade-smoke']

    expect(upgrade['runs-on']).toBe('windows-latest')
    expect(upgrade.needs).toBe('build')
    expect(upgrade['timeout-minutes']).toBe(20)
    expect(findStep(upgrade, 'Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22 }
    })
    expect(findStep(upgrade, 'Install dependencies').run).toBe(
      'npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund'
    )
    expect(findStep(upgrade, 'Download current Windows installer').uses).toBe(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
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

  it('validates stable desktop tags on main before starting platform builds', () => {
    const release = readWorkflow('release.yml')
    const preflight = release.jobs['release-preflight']
    const checkout = findStep(preflight, 'Checkout')
    const validateTag = findStep(preflight, 'Validate desktop release tag')
    const verifyMain = findStep(preflight, 'Verify release commit is on main')
    const stableTagCondition = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"

    expect(preflight).toMatchObject({
      permissions: { contents: 'read' },
      'runs-on': 'ubuntu-latest'
    })
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'fetch-depth': 0 }
    })
    expect(validateTag.if).toBe(stableTagCondition)
    expect(validateTag.run).toContain("require('./package.json').version")
    expect(validateTag.run).toContain('$GITHUB_REF_NAME')
    expect(verifyMain).toMatchObject({
      if: stableTagCondition,
      run: 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main'
    })
    expect(release.jobs.build.needs).toBe('release-preflight')
    expect(release.jobs['notarize-mac'].if).toBe(stableTagCondition)
    expect(release.jobs['windows-upgrade-smoke'].if).toBe(stableTagCondition)
    expect(release.jobs.publish.if).toBe(stableTagCondition)
  })

  it('locks mirror dependencies and completes local transforms before configuring credentials', () => {
    const mirror = readWorkflow('mirror-to-website.yml').jobs.mirror
    const stepNames = mirror.steps?.map(({ name }) => name) ?? []
    const install = findStep(mirror, 'Install manifest dependencies')
    const configureIndex = stepNames.indexOf('Configure AWS credentials')

    expect(install.run).toBe(
      'npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund'
    )
    expect(mirror.steps?.filter(({ run }) => run?.includes('npm install'))).toEqual([])
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Install manifest dependencies'))
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Generate version.json'))
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Rewrite update feed paths'))
    expect(configureIndex).toBeGreaterThan(
      stepNames.indexOf('Inject release notes into update feeds')
    )
    expect(stepNames.indexOf('Sync installers to versioned path')).toBeGreaterThan(configureIndex)
    expect(stepNames.indexOf('Upload version.json')).toBeGreaterThan(configureIndex)
    expect(stepNames.indexOf('Upload update feed to channel root')).toBeGreaterThan(configureIndex)
  })

  it('pins external actions in every changed release workflow', () => {
    for (const workflowName of ['release.yml', 'mirror-to-website.yml']) {
      const workflow = readWorkflow(workflowName)
      const references = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).flatMap(({ uses }) => (uses?.startsWith('./') || !uses ? [] : [uses]))
      )

      expect(references.length).toBeGreaterThan(0)
      expect(references.every((reference) => /@[0-9a-f]{40}$/i.test(reference))).toBe(true)
    }
  })
})
