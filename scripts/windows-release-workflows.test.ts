import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
  strategy?: { matrix?: Record<string, unknown> }
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  jobs: Record<string, WorkflowJob>
  on?: {
    push?: { branches?: string[]; tags?: string[] }
    workflow_call?: unknown
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
  it('runs the complete Windows suite independently after changes land on main', () => {
    const build = readWorkflow('build.yml')
    const workflow = readWorkflow('windows-full-test.yml')
    const job = workflow.jobs.windows_full_test

    expect(build.jobs.windows_full_test).toBeUndefined()
    expect(workflow.on?.push).toMatchObject({ branches: ['main'] })
    expect(workflow.on).not.toHaveProperty('workflow_call')
    expect(job).toMatchObject({
      'runs-on': 'windows-latest'
    })
    expect(job['continue-on-error']).toBeUndefined()
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

  it('keeps Windows packaging unsigned until signing credentials are available', () => {
    const build = readWorkflow('build.yml')
    const job = build.jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const packageStep = findStep(job, 'Build & package')

    expect(names).not.toContain('Require Windows signing credentials')
    expect(names).not.toContain('Verify Windows Authenticode signature')
    expect(packageStep.env).toMatchObject({
      CSC_LINK: "${{ matrix.platform == 'mac' && secrets.MAC_CSC_LINK || '' }}",
      CSC_KEY_PASSWORD: "${{ matrix.platform == 'mac' && secrets.MAC_CSC_KEY_PASSWORD || '' }}"
    })
  })

  it('runs cross-platform P0 and visual against packaged apps before recording evidence', () => {
    const setup = readWorkflow('build.yml').jobs.setup.steps?.find(({ id }) => id === 'set')
    const job = readWorkflow('build.yml').jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const packaged = findStep(job, 'Resolve packaged Electron executable')
    const p0 = findStep(job, 'Run P0 Electron certification')
    const visual = findStep(job, 'Run desktop visual regression')
    const macos = findStep(job, 'Smoke test macOS packages')
    const linux = findStep(job, 'Smoke test Linux packages')
    const evidence = findStep(job, 'Record platform certification evidence')
    const notarize = readWorkflow('notarize-mac.yml').jobs.notarize
    const finalMacos = findStep(notarize, 'Smoke test final macOS packages')
    const refreshedMacosEvidence = findStep(notarize, 'Refresh macOS certification evidence')

    expect(setup.run).toContain('"name":"macos-arm64","os":"macos-14"')
    expect(setup.run).toContain('"name":"macos-x64","os":"macos-15-intel"')
    expect(job.env?.MACOSX_DEPLOYMENT_TARGET).toBe(
      "${{ matrix.platform == 'mac' && '12.0' || '' }}"
    )
    expect(packaged.id).toBe('packaged_app')
    expect(packaged.run).toContain('Open Science.app/Contents/MacOS/Open Science')
    expect(packaged.run).toContain('win-unpacked/open-science.exe')
    expect(packaged.run).toContain('linux-unpacked/open-science')
    expect(p0.env?.OPEN_SCIENCE_E2E_EXECUTABLE).toBe('${{ steps.packaged_app.outputs.executable }}')
    expect(visual.env?.OPEN_SCIENCE_E2E_EXECUTABLE).toBe(
      '${{ steps.packaged_app.outputs.executable }}'
    )
    expect(p0.run).toContain('npm run test:e2e:p0')
    expect(visual.run).toContain('npm run test:e2e:visual')
    expect(macos.if).toBe("${{ matrix.platform == 'mac' && !inputs.skip_verify }}")
    expect(macos.run).toBe('node scripts/macos-package-smoke.mjs --artifact-dir dist')
    expect(linux.run).toContain('scripts/linux-package-smoke.mjs')
    expect(evidence.run).toContain('package_smoke=passed')
    expect(finalMacos.run).toBe(
      'node scripts/macos-package-smoke.mjs --artifact-dir mac --gatekeeper'
    )
    expect(refreshedMacosEvidence.run).toContain('--package-smoke passed')
    expect(names.indexOf('Record platform certification evidence')).toBeGreaterThan(
      names.indexOf('Smoke test macOS packages')
    )
    expect(names.indexOf('Record platform certification evidence')).toBeGreaterThan(
      names.indexOf('Smoke test Linux packages')
    )
    expect(names.indexOf('Upload build artifacts')).toBeGreaterThan(
      names.indexOf('Record platform certification evidence')
    )
    expect(notarize.steps?.indexOf(refreshedMacosEvidence)).toBeGreaterThan(
      notarize.steps?.indexOf(finalMacos) ?? -1
    )
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

  it('runs differential updater and installer compatibility drills before publishing', () => {
    const release = readWorkflow('release.yml')
    const upgrade = release.jobs['windows-upgrade-smoke']

    expect(upgrade['runs-on']).toBe('windows-latest')
    expect(upgrade.needs).toBe('build')
    expect(upgrade['timeout-minutes']).toBe(40)
    expect(findStep(upgrade, 'Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22 }
    })
    expect(findStep(upgrade, 'Install dependencies').run).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund'
    )
    expect(findStep(upgrade, 'Download current Windows installer').uses).toBe(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
    )
    const previous = findStep(upgrade, 'Download previous stable Windows installer')
    expect(previous.env?.CURRENT_TAG).toBe('${{ github.ref_name }}')
    expect(previous.run).toContain('gh release download')
    expect(previous.run).toContain('*-win-x64-setup.exe.blockmap')
    expect(previous.run).not.toContain('Get-AuthenticodeSignature')
    expect(previous.run).toContain("$_.tagName -like 'v*'")
    expect(previous.run).toContain('$_.tagName -ne $env:CURRENT_TAG')
    expect(findStep(upgrade, 'Certify Windows electron-updater differential update')).toMatchObject(
      {
        if: "steps.previous.outputs.available == 'true'",
        run: expect.stringContaining('scripts/windows-updater-certification.mjs')
      }
    )
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain('--previous-installer-dir previous')
    expect(release.jobs['windows-full-test']).toBeUndefined()
    expect(release.jobs.publish.needs).toEqual(['build', 'notarize-mac', 'windows-upgrade-smoke'])
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).not.toContain('--require-signed-windows')
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).toContain('--require-windows-update')
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).not.toContain('--windows-full-suite')
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      'write-windows-update'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      '--updater-observation'
    )
    expect(release.jobs.mirror).toBeUndefined()
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
    expect(release.jobs.build.with?.require_windows_signing).toBeUndefined()
    expect(release.jobs['notarize-mac'].if).toBe(stableTagCondition)
    expect(release.jobs['windows-upgrade-smoke'].if).toBe(stableTagCondition)
    expect(release.jobs.publish.if).toBe(stableTagCondition)
  })

  it('locks mirror dependencies and completes local transforms before configuring credentials', () => {
    const workflow = readWorkflow('mirror-to-website.yml')
    const mirror = workflow.jobs.mirror
    const stepNames = mirror.steps?.map(({ name }) => name) ?? []
    const install = findStep(mirror, 'Install manifest dependencies')
    const configureIndex = stepNames.indexOf('Configure AWS credentials')

    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          tag: {
            description: 'Release tag to mirror (e.g. v0.1.2)',
            required: true
          }
        }
      }
    })
    expect(install.run).toBe(
      'npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund'
    )
    expect(mirror.steps?.filter(({ run }) => run?.includes('npm install'))).toEqual([])
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Install manifest dependencies'))
    expect(configureIndex).toBeGreaterThan(
      stepNames.indexOf('Collect historical Windows blockmaps')
    )
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Generate version.json'))
    expect(configureIndex).toBeGreaterThan(stepNames.indexOf('Rewrite update feed paths'))
    expect(configureIndex).toBeGreaterThan(
      stepNames.indexOf('Inject release notes into update feeds')
    )
    expect(stepNames.indexOf('Sync installers to versioned path')).toBeGreaterThan(configureIndex)
    expect(stepNames.indexOf('Backfill historical Windows blockmaps')).toBeGreaterThan(
      configureIndex
    )
    expect(stepNames.indexOf('Upload version.json')).toBeGreaterThan(configureIndex)
    expect(stepNames.indexOf('Upload update feed to channel root')).toBeGreaterThan(configureIndex)
    const historical = findStep(mirror, 'Collect historical Windows blockmaps')
    expect(historical.run).toContain('gh api --paginate')
    expect(historical.run).toContain('> "$blockmap_index"')
    expect(historical.run).toContain('done < "$blockmap_index"')
    expect(historical.run).not.toContain('done < <(')
    expect(historical.run).toContain('application/octet-stream')
    expect(historical.run).toContain('historical-blockmaps/$version/$name')
    expect(historical.run).toContain('gzip -t "$target"')
    const backfill = findStep(mirror, 'Backfill historical Windows blockmaps')
    expect(backfill.run).toContain('releases/$version/$(basename "$blockmap")')
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
