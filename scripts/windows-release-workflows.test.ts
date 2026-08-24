import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  'continue-on-error'?: boolean
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
  permissions?: Record<string, string>
  on?: {
    push?: { branches?: string[]; tags?: string[] }
    schedule?: Array<{ cron: string }>
    workflow_run?: { workflows?: string[]; types?: string[] }
    workflow_call?: {
      inputs?: Record<string, { default?: unknown; description?: string; type?: string }>
    }
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
  it('stages the pinned compatibility runner before packaging Windows builds', () => {
    const job = readWorkflow('build.yml').jobs.build
    const stage = findStep(job, 'Stage notebook runtime resources')

    expect(stage.run).toContain('micromamba-compat.exe')
    expect(stage.run).toContain('compatibility')
    expect(stage.run).toContain('matrix.subdir }}" = "win-64')
    expect(stage.run).toContain('"$compatibility_path" --version')
  })

  it('batches complete Windows coverage independently against the latest main head', () => {
    const build = readWorkflow('build.yml')
    const workflow = readWorkflow('windows-full-test.yml')
    const plan = workflow.jobs.plan
    const job = workflow.jobs.windows_full_test

    expect(build.jobs.windows_full_test).toBeUndefined()
    expect(workflow.on?.push).toBeUndefined()
    expect(workflow.on?.schedule).toEqual([{ cron: '47 * * * *' }])
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.on).not.toHaveProperty('workflow_call')
    expect(findStep(plan, 'Check for untested main changes').run).toContain('status=success')
    expect(job).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_test == 'true'",
      'runs-on': 'windows-latest'
    })
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(findStep(job, 'Test complete suite shard').run).toBe(
      'npm test -- --shard=${{ matrix.shard }}/3 --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000'
    )
  })

  it('hard-gates every packaged Windows build on a fresh install/start/uninstall smoke', () => {
    const job = readWorkflow('package-smoke.yml').jobs.smoke
    const smoke = findStep(job, 'Smoke test Windows installer')

    expect(job['continue-on-error']).toBeUndefined()
    expect(smoke.if).toBe("matrix.platform == 'win'")
    expect(smoke.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(smoke['timeout-minutes']).toBe(10)
  })

  it('keeps Windows packaging unsigned until signing credentials are available', () => {
    const build = readWorkflow('build.yml')
    const job = build.jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const prepareMacSigning = findStep(job, 'Prepare macOS signing keychain')
    const packageStep = findStep(job, 'Build & package')
    const cleanupMacSigning = findStep(job, 'Clean up macOS signing keychain')

    expect(names).not.toContain('Require Windows signing credentials')
    expect(names).not.toContain('Verify Windows Authenticode signature')
    expect(prepareMacSigning).toMatchObject({
      id: 'mac_signing',
      if: "${{ matrix.platform == 'mac' && !inputs.nightly }}"
    })
    expect(prepareMacSigning.run).toContain('security create-keychain -p "$keychain_password"')
    expect(prepareMacSigning.run).toContain('security list-keychains -d user > "$keychain_list"')
    expect(prepareMacSigning.run).toContain(
      'security list-keychains -d user -s "$keychain" "${user_keychains[@]}"'
    )
    expect(prepareMacSigning.run).toContain('-P "${MAC_CSC_KEY_PASSWORD:-}"')
    expect(prepareMacSigning.run).toContain('-k "$keychain_password"')
    expect(prepareMacSigning.run).toContain("grep -q 'Developer ID Application:'")
    expect(packageStep.env).toEqual({
      CSC_KEYCHAIN: '${{ steps.mac_signing.outputs.keychain }}',
      NODE_OPTIONS: '--max-old-space-size=8192'
    })
    expect(packageStep.run).toContain(
      'if [ "${{ steps.mac_signing.outputs.enabled }}" = "true" ]; then'
    )
    expect(cleanupMacSigning).toMatchObject({
      if: "${{ always() && steps.mac_signing.outputs.keychain != '' }}",
      env: {
        MAC_SIGNING_CERTIFICATE: '${{ steps.mac_signing.outputs.certificate }}',
        MAC_SIGNING_KEYCHAIN: '${{ steps.mac_signing.outputs.keychain }}',
        MAC_SIGNING_KEYCHAIN_LIST: '${{ steps.mac_signing.outputs.keychain_list }}'
      }
    })
    expect(cleanupMacSigning.run).toContain(
      'security list-keychains -d user -s "${user_keychains[@]}"'
    )
    expect(cleanupMacSigning.run).toContain('security delete-keychain "$MAC_SIGNING_KEYCHAIN"')
    expect(cleanupMacSigning.run).toContain(
      'rm -f "$MAC_SIGNING_CERTIFICATE" "$MAC_SIGNING_KEYCHAIN_LIST"'
    )
    expect(packageStep.run).toContain('unsigned_args=(-c.dmg.sign=false)')
    expect(packageStep.run).not.toContain('publisherName')
  })

  it('provides an isolated Windows-only SignPath dry-run', () => {
    const build = readWorkflow('build.yml')
    const inputs = build.on?.workflow_call?.inputs
    const workflow = readWorkflow('signpath-test.yml')
    const sign = workflow.jobs['sign-installer']
    const uploadUnsigned = findStep(sign, 'Upload raw installer for SignPath')
    const submit = findStep(sign, 'Submit SignPath test signing request')
    const verify = findStep(sign, 'Verify Authenticode signature was added')
    const uploadSigned = findStep(sign, 'Upload signed installer')

    expect(inputs?.platform_name).toMatchObject({ type: 'string', default: '' })
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow).toMatchObject({ permissions: { actions: 'read', contents: 'read' } })
    expect(workflow.jobs.build).toMatchObject({
      uses: './.github/workflows/build.yml',
      with: { platform_name: 'windows-x64', skip_verify: true }
    })
    expect(sign).toMatchObject({ needs: 'build', 'runs-on': 'windows-latest' })
    expect(findStep(sign, 'Select unsigned NSIS installer').run).toContain('*-win-x64-setup.exe')
    expect(uploadUnsigned).toMatchObject({
      id: 'upload-unsigned-installer',
      uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      with: expect.objectContaining({ archive: false, 'if-no-files-found': 'error' })
    })
    expect(submit).toMatchObject({
      uses: 'signpath/github-action-submit-signing-request@c92b958760219087e01f8d67a1669ed57afe2627',
      with: expect.objectContaining({
        'api-token': '${{ secrets.SIGNPATH_API_TOKEN }}',
        'organization-id': '${{ vars.SIGNPATH_ORGANIZATION_ID }}',
        'project-slug': 'open-science',
        'signing-policy-slug': 'test-signing',
        'artifact-configuration-slug': 'windows-installer',
        'github-artifact-id': '${{ steps.upload-unsigned-installer.outputs.artifact-id }}',
        'skip-decompress': true,
        'wait-for-completion': true
      })
    })
    expect(verify.run).toContain('Get-AuthenticodeSignature')
    expect(verify.run).toContain(
      '$expectedTestCertificateSubject = "CN=Test certificate for \'Open Science [OSS]\'"'
    )
    expect(verify.run).toContain('$expectedUntrustedRootMessage =')
    expect(verify.run).toContain("$signature.Status -eq 'UnknownError'")
    expect(verify.run).toContain(
      '$signature.SignerCertificate.Subject -eq $signature.SignerCertificate.Issuer'
    )
    expect(verify.run).toContain('$signature.StatusMessage -eq $expectedUntrustedRootMessage')
    expect(verify.run).not.toContain('X509Store')
    expect(uploadSigned.with).toMatchObject({
      name: 'signpath-test-windows-x64',
      'retention-days': 7,
      'if-no-files-found': 'error'
    })
    expect(workflow.jobs).not.toHaveProperty('publish')
  })

  it('separates immutable builds from blocking package smoke and advisory regressions', () => {
    const setup = readWorkflow('build.yml').jobs.setup.steps?.find(({ id }) => id === 'set')
    const build = readWorkflow('build.yml').jobs.build
    const buildNames = build.steps?.map(({ name }) => name) ?? []
    const upload = findStep(build, 'Upload build artifacts')
    const smokeWorkflow = readWorkflow('package-smoke.yml')
    const smoke = smokeWorkflow.jobs.smoke
    const downloadPackage = findStep(smoke, 'Download packaged artifacts')
    const macos = findStep(smoke, 'Smoke test macOS packages')
    const windows = findStep(smoke, 'Smoke test Windows installer')
    const linux = findStep(smoke, 'Smoke test Linux packages')
    const evidence = findStep(smoke, 'Record platform certification evidence')
    const uploadEvidence = findStep(smoke, 'Upload platform certification evidence')
    const regressionWorkflow = readWorkflow('desktop-regression.yml')
    const p0Regression = regressionWorkflow.jobs.p0
    const visualRegression = regressionWorkflow.jobs.visual
    const notarize = readWorkflow('notarize-mac.yml').jobs.notarize
    const notarizeDryRun = readWorkflow('notarize-dryrun.yml').jobs.notarize
    const finalMacos = findStep(notarize, 'Smoke test final macOS packages')
    const refreshedMacosEvidence = findStep(notarize, 'Refresh macOS certification evidence')

    expect(setup.env).toEqual({ PLATFORM_NAME: '${{ inputs.platform_name }}' })
    expect(setup.run).toContain('"name":"macos-arm64","os":"macos-26"')
    expect(setup.run).toContain('"name":"macos-x64","os":"macos-26-intel"')
    expect(setup.run).toContain(
      'include=$(jq -c --arg name "$PLATFORM_NAME" \'[.[] | select(.name == $name)]\' <<<"$include")'
    )
    expect(setup.run).toContain("unknown platform_name '$PLATFORM_NAME'")
    expect(build.env?.MACOSX_DEPLOYMENT_TARGET).toBe(
      "${{ matrix.platform == 'mac' && '12.0' || '' }}"
    )
    expect(buildNames).not.toEqual(
      expect.arrayContaining([
        'Run P0 Electron certification',
        'Run desktop visual regression',
        'Smoke test macOS packages',
        'Smoke test Windows installer',
        'Smoke test Linux packages'
      ])
    )
    expect(upload.if).toBeUndefined()
    expect(upload.with?.['retention-days']).toBe(7)
    expect(smoke.strategy?.matrix).toEqual({
      include: [
        { name: 'macos-arm64', os: 'macos-26', platform: 'mac' },
        { name: 'macos-x64', os: 'macos-26-intel', platform: 'mac' },
        { name: 'linux-x64', os: 'ubuntu-latest', platform: 'linux' },
        { name: 'windows-x64', os: 'windows-latest', platform: 'win' }
      ]
    })
    expect(downloadPackage.with?.name).toBe('${{ matrix.name }}')
    expect(downloadPackage.with?.path).toBe('dist')
    expect(macos.if).toBe("matrix.platform == 'mac'")
    expect(macos.run).toBe('node scripts/macos-package-smoke.mjs --artifact-dir dist')
    expect(windows.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(linux.run).toContain('scripts/linux-package-smoke.mjs')
    expect(evidence.run).toContain('--electron-p0 not-applicable')
    expect(evidence.run).toContain('--visual-regression not-applicable')
    expect(evidence.run).toContain('--package-smoke passed')
    expect(evidence.run).toContain('database-migration-certification-${{ matrix.name }}.json')
    expect(evidence.run).toContain('--database-migration-certification "$database_certification"')
    expect(uploadEvidence.with?.name).toBe('certification-${{ matrix.name }}')
    expect(uploadEvidence.with?.['retention-days']).toBe(7)
    expect(p0Regression).toMatchObject({ needs: 'source', 'runs-on': 'macos-26' })
    expect(p0Regression.if).toBe("needs.source.outputs.available == 'true'")
    expect(p0Regression['continue-on-error']).toBe('${{ inputs.allow_failure }}')
    expect(findStep(p0Regression, 'Download macOS ARM64 package').with?.name).toBe('macos-arm64')
    expect(findStep(p0Regression, 'Download macOS ARM64 package').with?.['run-id']).toBe(
      '${{ needs.source.outputs.run_id }}'
    )
    expect(findStep(p0Regression, 'Extract packaged application').run).toContain('ditto -x -k')
    expect(findStep(p0Regression, 'Run packaged P0 regression').run).toBe('npm run test:e2e:p0')
    expect(
      findStep(p0Regression, 'Run packaged P0 regression').env?.OPEN_SCIENCE_E2E_EXECUTABLE
    ).toBe('${{ steps.packaged_app.outputs.executable }}')
    expect(findStep(p0Regression, 'Upload P0 diagnostics').if).toBe('always()')
    expect(visualRegression).toMatchObject({ needs: 'source', 'runs-on': 'macos-14' })
    expect(visualRegression.if).toBe("needs.source.outputs.available == 'true'")
    expect(visualRegression['continue-on-error']).toBe('${{ inputs.allow_failure }}')
    expect(findStep(visualRegression, 'Build Electron application').run).toBe('npm run build:e2e')
    expect(findStep(visualRegression, 'Run visual stability regression')).toMatchObject({
      run: 'npm run test:e2e:visual -- --fail-on-flaky-tests'
    })
    expect(findStep(visualRegression, 'Upload visual diagnostics').if).toBe('always()')
    expect(finalMacos.run).toBe(
      'node scripts/macos-package-smoke.mjs --artifact-dir mac --gatekeeper'
    )
    expect(notarize['runs-on']).toBe('${{ matrix.os }}')
    expect(notarize.strategy?.matrix).toEqual({
      include: [
        { arch: 'arm64', os: 'macos-15' },
        { arch: 'x64', os: 'macos-15-intel' }
      ]
    })
    expect(refreshedMacosEvidence.run).toContain('--package-smoke passed')
    expect(refreshedMacosEvidence.run).toContain(
      '--database-migration-certification mac/database-migration-certification.json'
    )
    expect(refreshedMacosEvidence.run).toContain('--electron-p0 not-applicable')
    expect(refreshedMacosEvidence.run).toContain('--visual-regression not-applicable')
    expect(refreshedMacosEvidence.if).toContain('inputs.certified_build')
    expect(notarizeDryRun.with?.certified_build).toBe(false)
    expect(notarize.steps?.indexOf(refreshedMacosEvidence)).toBeGreaterThan(
      notarize.steps?.indexOf(finalMacos) ?? -1
    )
  })

  it('keeps package smoke blocking while release and nightly regressions are advisory', () => {
    const release = readWorkflow('release.yml')
    const nightly = readWorkflow('nightly.yml')
    const regression = readWorkflow('desktop-regression.yml')

    expect(release.jobs.build.uses).toBe('./.github/workflows/build.yml')
    expect(release).toMatchObject({ permissions: { actions: 'read', contents: 'write' } })
    expect(release.jobs['package-smoke']).toMatchObject({
      needs: 'build',
      uses: './.github/workflows/package-smoke.yml'
    })
    expect(release.jobs['notarize-mac'].needs).toEqual(['build', 'package-smoke'])
    expect(release.jobs.publish.needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(nightly.jobs.build.uses).toBe('./.github/workflows/build.yml')
    expect(nightly.jobs['package-smoke']).toMatchObject({
      needs: 'build',
      if: "inputs.dry_run != 'macos-x64'",
      uses: './.github/workflows/package-smoke.yml'
    })
    expect(nightly.jobs.prepare.needs).toEqual(['plan', 'build', 'package-smoke'])
    expect(regression.on).not.toHaveProperty('workflow_run')
    expect(regression.on).toHaveProperty('workflow_dispatch')
    expect(regression.on).toHaveProperty('workflow_call')
    expect(regression.jobs.source['continue-on-error']).toBe('${{ inputs.allow_failure }}')
    expect(findStep(regression.jobs.source, 'Resolve source run').run).toContain(
      '.name == "macos-arm64" and (.expired | not)'
    )
    expect(release.jobs.regression).toMatchObject({
      needs: ['build', 'package-smoke'],
      uses: './.github/workflows/desktop-regression.yml',
      with: { allow_failure: true }
    })
    expect(nightly.jobs.regression).toMatchObject({
      needs: ['build', 'package-smoke'],
      uses: './.github/workflows/desktop-regression.yml',
      with: { allow_failure: true }
    })
  })

  it('builds every platform without repeating the verified typecheck', () => {
    const workflow = readWorkflow('build.yml')
    const verifyTypecheck = findStep(workflow.jobs.verify, 'Typecheck')
    const build = findStep(workflow.jobs.build, 'Build & package')
    const commands = build.run?.split('\n').map((line) => line.trim()) ?? []

    expect(verifyTypecheck.run).toBe('npm run typecheck')
    expect(verifyTypecheck.env).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096' })
    expect(build.env).toMatchObject({ NODE_OPTIONS: '--max-old-space-size=8192' })
    expect(commands).toContain('npm run build:e2e')
    expect(commands).toContain('npm run build:web')
    expect(commands).not.toContain('npm run build')
    expect(commands.some((command) => command.startsWith('npm run typecheck'))).toBe(false)
  })

  it('records unsigned Windows update diagnostics without blocking publishing', () => {
    const release = readWorkflow('release.yml')
    const upgrade = readWorkflow('windows-upgrade-smoke.yml').jobs['windows-upgrade-smoke']

    expect(upgrade['runs-on']).toBe('windows-latest')
    expect(upgrade.needs).toBeUndefined()
    expect(upgrade['continue-on-error']).toBeUndefined()
    expect(upgrade['timeout-minutes']).toBe(40)
    expect(findStep(upgrade, 'Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22 }
    })
    expect(findStep(upgrade, 'Install dependencies').run).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund'
    )
    expect(findStep(upgrade, 'Generate Prisma client').run).toBe('npx prisma generate')
    const checkout = findStep(upgrade, 'Checkout smoke harness')
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'fetch-depth': 0 }
    })
    expect(checkout.with).not.toHaveProperty('ref')

    const released = findStep(upgrade, 'Resolve released revision')
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

    const updaterStep = findStep(upgrade, 'Certify Windows electron-updater differential update')
    const installerStep = findStep(
      upgrade,
      'Drill Windows silent upgrade, process lock, rollback, and restart'
    )
    expect(updaterStep).toMatchObject({
      env: {
        OPEN_SCIENCE_E2E_STORAGE_ROOT: '${{ runner.temp }}\\open-science-updater-certification'
      }
    })
    expect(installerStep).toMatchObject({
      env: {
        OPEN_SCIENCE_E2E_STORAGE_ROOT: '${{ runner.temp }}\\open-science-installer-certification'
      }
    })
    expect(updaterStep.env?.OPEN_SCIENCE_E2E_STORAGE_ROOT).not.toBe(
      installerStep.env?.OPEN_SCIENCE_E2E_STORAGE_ROOT
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence')).toMatchObject({
      env: { GITHUB_SHA: '${{ steps.current.outputs.sha }}' }
    })

    const current = findStep(upgrade, 'Download current Windows installer')
    expect(current.run).toContain('gh release download $env:CURRENT_TAG')
    expect(current.run).toContain("--pattern 'latest.yml'")
    const previous = findStep(upgrade, 'Download previous stable Windows installer')
    expect(previous.run).toContain('gh release download')
    expect(previous.run).toContain('*-win-x64-setup.exe.blockmap')
    expect(previous.run).not.toContain('Get-AuthenticodeSignature')
    expect(previous.run).toContain("$_.tagName -like 'v*'")
    expect(previous.run).toContain('$_.tagName -ne $env:CURRENT_TAG')
    expect(findStep(upgrade, 'Certify Windows electron-updater differential update')).toMatchObject(
      {
        id: 'updater',
        if: "steps.previous.outputs.available == 'true'",
        'continue-on-error': true,
        run: expect.stringContaining('windows-updater-certification.log')
      }
    )
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain('--previous-installer-dir previous')
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain("--expected-migration-count '${{ steps.current.outputs.migration_count }}'")
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain("--artifact-rpc-contract '${{ steps.current.outputs.artifact_rpc_contract }}'")
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart')
    ).toMatchObject({ id: 'installer', 'continue-on-error': true })
    expect(release.jobs['windows-full-test']).toBeUndefined()
    expect(release.jobs['windows-upgrade-smoke']).toBeUndefined()
    expect(release.jobs.publish.needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).not.toContain('--require-signed-windows')
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).not.toContain('--require-windows-update')
    expect(
      findStep(release.jobs.publish, 'Aggregate release certification evidence').run
    ).not.toContain('--windows-full-suite')
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      'write-windows-update'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      '--updater-observation'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      '--database-migration-certification'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      "elseif ($passed) { 'passed' } else { 'failed' }"
    )
    expect(findStep(upgrade, 'Upload Windows update-drill evidence')).toMatchObject({
      if: 'always()',
      with: expect.objectContaining({
        path: expect.stringContaining('windows-*-certification.log')
      })
    })
    expect(findStep(upgrade, 'Report Windows update-drill outcome').run).toBe('exit 1')
    expect(findStep(release.jobs.publish, 'Dispatch advisory Windows upgrade smoke')).toMatchObject(
      {
        'continue-on-error': true,
        run: expect.stringContaining('event_type=windows-upgrade-smoke')
      }
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
    expect(release.jobs['windows-upgrade-smoke']).toBeUndefined()
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
          },
          dry_run: {
            description: 'Run local release transforms without AWS credentials or uploads',
            required: false,
            type: 'boolean',
            default: false
          }
        }
      }
    })
    expect(install.run).toBe(
      'npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund'
    )
    const dryRunStage = findStep(mirror, 'Stage release metadata for dry run')
    expect(dryRunStage.if).toBe('${{ inputs.dry_run }}')
    expect(dryRunStage.run).toContain("--pattern 'SHA256SUMS.txt' --pattern '*.yml'")
    expect(dryRunStage.run).toContain('truncate -s "$size" "dist-assets/$name"')
    const generate = findStep(mirror, 'Generate version.json')
    expect(generate.env?.NOTES_DIR).toBe('release-notes/${{ steps.ref.outputs.version }}')
    expect(generate.run).not.toContain(
      'gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json body'
    )
    expect(findStep(mirror, 'Summarize dry run').if).toBe('${{ inputs.dry_run }}')
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
    for (const sideEffectStep of [
      'Configure AWS credentials',
      'Collect historical Windows blockmaps',
      'Backfill historical Windows blockmaps',
      'Sync installers to versioned path',
      'Upload version.json',
      'Upload update feed to channel root'
    ]) {
      expect(findStep(mirror, sideEffectStep).if).toBe('${{ !inputs.dry_run }}')
    }
  })

  it('pins external actions in every changed release workflow', () => {
    for (const workflowName of [
      'build.yml',
      'desktop-regression.yml',
      'nightly.yml',
      'notarize-mac.yml',
      'package-smoke.yml',
      'release.yml',
      'signpath-test.yml',
      'mirror-to-website.yml',
      'windows-upgrade-smoke.yml'
    ]) {
      const workflow = readWorkflow(workflowName)
      const references = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).flatMap(({ uses }) => (uses?.startsWith('./') || !uses ? [] : [uses]))
      )

      expect(references.length).toBeGreaterThan(0)
      expect(references.every((reference) => /@[0-9a-f]{40}$/i.test(reference))).toBe(true)
    }
  })
})
