import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  shell?: string
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
  strategy?: { matrix?: unknown }
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, WorkflowJob>
  permissions?: Record<string, string>
  on?: {
    push?: { branches?: string[]; tags?: string[]; paths?: string[] }
    schedule?: Array<{ cron: string }>
    workflow_run?: { workflows?: string[]; types?: string[] }
    workflow_call?: {
      inputs?: Record<string, { default?: unknown; description?: string; type?: string }>
    }
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown; options?: string[]; type?: string }>
    }
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
  it('warms a shared main-branch runtime cache when its recipe changes', () => {
    const workflow = readWorkflow('windows-notebook-runtime.yml')
    expect(workflow.on).toHaveProperty('workflow_call')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.on?.push?.branches).toEqual(['main'])
    const paths = workflow.on?.push?.paths ?? []
    const action = load(
      readFileSync('.github/actions/windows-notebook-runtime/action.yml', 'utf8')
    ) as { runs: { steps: WorkflowStep[] } }
    const cache = action.runs.steps.find(({ id }) => id === 'runtime')!
    const inputs = [...String(cache.with?.key).matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(inputs).toHaveLength(3)
    for (const input of inputs) expect(paths).toContain(input)
    expect(paths).toContain('.github/workflows/windows-notebook-runtime.yml')
    expect(paths).toContain('.github/actions/windows-notebook-runtime/action.yml')
    for (const unrelated of [
      'src/renderer/src/pages/workspace/replay/ReplayPanel.tsx',
      'e2e/replay-stage.spec.ts',
      'packages/notebook-network-sandbox/src/index.ts',
      'packages/notebook-network-sandbox/vendor/windows-runtime/README.md'
    ]) {
      expect(
        paths.some((pattern) => posix.matchesGlob(unrelated, pattern)),
        unrelated
      ).toBe(false)
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['runtime'])
  })

  it.skipIf(process.platform !== 'win32')(
    'extracts compressed runtime sources and never promotes failed or timed-out extraction',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'runtime-extraction-'))
      const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
      const buildScript = join(
        process.cwd(),
        'packages/notebook-network-sandbox/vendor/windows-runtime/build.ps1'
      )
      try {
        const result = spawnSync(
          'pwsh.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `
          $ErrorActionPreference = 'Stop'
          $BuildRoot = ${quote(directory)}
          $ast = [Management.Automation.Language.Parser]::ParseFile(${quote(buildScript)}, [ref]$null, [ref]$null)
          $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Expand-Source' }, $true)
          if (!$function) { throw 'Missing bounded source extraction' }
          . ([scriptblock]::Create($function.Extent.Text))
          foreach ($format in @('xz', 'gz')) {
            $archive = Join-Path $BuildRoot "fixture.$format"
            & python -c 'import io, sys, tarfile; t = tarfile.open(sys.argv[1], "w:" + sys.argv[2]); m = tarfile.TarInfo("fixture/space and \\u4e2d\\u6587.txt"); m.size = 7; t.addfile(m, io.BytesIO(b"fixture")); t.close()' $archive $format
            if ($LASTEXITCODE -ne 0) { throw 'Fixture creation failed' }
            $source = Join-Path $BuildRoot 'fixture'
            Expand-Source $archive $source
            if ((Get-Content -Raw (Join-Path $source 'space and 中文.txt')) -ne 'fixture') { throw 'Extraction changed content' }
            Move-Item -LiteralPath $source -Destination (Join-Path $BuildRoot "complete-$format")
          }
          $invalid = Join-Path $BuildRoot 'invalid.tar'
          Set-Content -LiteralPath $invalid -Value 'invalid archive'
          $source = Join-Path $BuildRoot 'invalid'
          try { Expand-Source $invalid $source; throw 'Accepted invalid archive' }
          catch { if ($_.Exception.Message -notlike 'Source extraction failed:*') { throw } }
          if (Test-Path $source) { throw 'Promoted failed extraction' }
          try { Expand-Source $invalid $source; throw 'Reused partial extraction' }
          catch { if ($_.Exception.Message -notlike 'Incomplete source extraction:*') { throw } }
          $source = Join-Path $BuildRoot 'timeout'
          try { Expand-Source $archive $source -TimeoutSeconds 0; throw 'Accepted expired deadline' }
          catch { if ($_.Exception.Message -notlike 'Source extraction timed out:*') { throw } }
          if (Test-Path $source) { throw 'Promoted timed-out extraction' }
          exit 0
        `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 20_000 }
        )
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Extracted')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    25_000
  )

  it.skipIf(process.platform !== 'win32')(
    'promotes only verified runtime source downloads and rejects failed transfers',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'runtime-source-'))
      const fixture = join(directory, 'fixture.txt')
      const content = 'offline runtime source fixture'
      writeFileSync(fixture, content)
      const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
      const buildScript = join(
        process.cwd(),
        'packages/notebook-network-sandbox/vendor/windows-runtime/build.ps1'
      )
      try {
        const result = spawnSync(
          'pwsh.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference = 'Stop'
             $BuildRoot = ${quote(directory)}
             $ast = [Management.Automation.Language.Parser]::ParseFile(${quote(buildScript)}, [ref]$null, [ref]$null)
             $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-Source' }, $true)
             . ([scriptblock]::Create($function.Extent.Text))
             $source = @{ url = ${quote(pathToFileURL(fixture).href)}; sha256 = '${createHash('sha256').update(content).digest('hex')}' }
             $archive = Get-Source $source 'valid.txt'
             if ((Get-Content -Raw $archive) -ne ${quote(content)}) { throw 'Verified content differs' }
             if (Test-Path "$archive.download") { throw 'Verified download was not promoted' }
             $source.sha256 = 'invalid'
             try { Get-Source $source 'corrupt.txt'; throw 'Accepted corrupt source' }
             catch { if ($_.Exception.Message -notlike 'Source checksum mismatch:*') { throw } }
             if (Test-Path (Join-Path $BuildRoot 'corrupt.txt')) { throw 'Corrupt source was promoted' }
             $source.url = ${quote(pathToFileURL(join(directory, 'missing.txt')).href)}
             try { Get-Source $source 'failed.txt'; throw 'Accepted failed transfer' }
             catch { if ($_.Exception.Message -notlike 'Source download failed:*') { throw } }
             if (Test-Path (Join-Path $BuildRoot 'failed.txt')) { throw 'Failed transfer was promoted' }
             exit 0`
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
        )
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20_000
  )

  it('prepares the bundled runtime before Windows consumers and snapshot publication', () => {
    const consumers = [
      ['pr-gate.yml', 'windows_core', 'Test Windows notebook shell behavior'],
      ['pr-gate.yml', 'windows_e2e_setup', 'Pack E2E setup'],
      ['windows-e2e-regression.yml', 'windows_e2e_setup', 'Pack E2E setup'],
      ['windows-full-test.yml', 'windows_dependencies', 'Pack dependencies'],
      ['runtime-resource-soak.yml', 'runtime_resource_soak', 'Record runtime resource profile']
    ]
    for (const [file, jobId, consumer] of consumers) {
      const job = readWorkflow(file).jobs[jobId]
      const setup = findStep(job, 'Download Windows Notebook runtime')
      expect(setup.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/)
      expect(setup.with?.['artifact-ids']).toBe(
        '${{ needs.windows_notebook_runtime.outputs.artifact_id }}'
      )
      expect(job.needs).toContain('windows_notebook_runtime')
      expect(readWorkflow(file).jobs.windows_notebook_runtime.uses).toBe(
        './.github/workflows/windows-notebook-runtime.yml'
      )
      expect(setup['continue-on-error']).toBeUndefined()
      expect(job.steps!.indexOf(setup)).toBeLessThan(job.steps!.indexOf(findStep(job, consumer)))
    }
    const compiler = readWorkflow('windows-notebook-runtime.yml').jobs.runtime
    expect(compiler['runs-on']).toBe('windows-2022')
    expect(compiler['timeout-minutes']).toBe(90)
    expect(findStep(compiler, 'Prepare Windows Notebook runtime').uses).toBe(
      './.github/actions/windows-notebook-runtime'
    )
    expect(findStep(compiler, 'Upload Windows Notebook runtime').with?.['if-no-files-found']).toBe(
      'error'
    )
    const action = load(
      readFileSync('.github/actions/windows-notebook-runtime/action.yml', 'utf8')
    ) as { runs: { steps: WorkflowStep[] } }
    const cache = action.runs.steps.find(({ id }) => id === 'runtime')!
    expect(cache.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/)
    for (const input of ['sources.json', '*.patch', 'build.ps1']) {
      expect(cache.with?.key).toContain(input)
    }
    const build = action.runs.steps.find(({ name }) => name === 'Build Windows Notebook runtime')!
    expect(build.if).toContain("cache-hit != 'true'")
    expect(build.run).toContain('vendor/windows-runtime/build.ps1')
    const verify = action.runs.steps.find(({ name }) => name === 'Verify Windows Notebook runtime')!
    const npm = action.runs.steps.find(
      ({ name }) => name === 'Prepare bundled npm for shared Notebook tools'
    )!
    expect(npm.if).toBeUndefined()
    expect(npm.run).toContain('vendor/windows-runtime/npm/prepare.mjs')
    expect(action.runs.steps.indexOf(npm)).toBeGreaterThan(action.runs.steps.indexOf(build))
    expect(action.runs.steps.indexOf(npm)).toBeLessThan(action.runs.steps.indexOf(verify))
    expect(verify.if).toBeUndefined()
    for (const executable of ['node.exe', 'pwsh.exe', 'npm-cli.js'])
      expect(verify.run).toContain(executable)
  })

  it('blocks packaging on native data-location upgrade checks for every target OS', () => {
    const job = readWorkflow('build.yml').jobs.build
    const steps = job.steps ?? []
    const check = findStep(job, 'Verify native data-location upgrades')
    expect(job['runs-on']).toBe('${{ matrix.os }}')
    expect(check.if).toBeUndefined()
    expect(check['continue-on-error']).toBeUndefined()
    for (const suite of [
      'src/main/storage-root.test.ts',
      'src/main/storage/brand-location.test.ts',
      'src/main/storage/data-location-identity.test.ts',
      'src/main/settings/document-store.test.ts',
      'src/main/settings/repository.test.ts'
    ])
      expect(check.run).toContain(suite)
    expect(steps.indexOf(check)).toBeGreaterThan(
      steps.indexOf(findStep(job, 'Install dependencies'))
    )
    expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(findStep(job, 'Build & package')))
    expect(steps.indexOf(check)).toBeLessThan(
      steps.indexOf(findStep(job, 'Upload build artifacts'))
    )
  })

  it('stages the pinned compatibility runner before packaging Windows builds', () => {
    const job = readWorkflow('build.yml').jobs.build
    const stage = findStep(job, 'Stage notebook runtime resources')

    expect(stage.run).toContain('micromamba-compat.exe')
    expect(stage.run).toContain('compatibility')
    expect(stage.run).toContain('matrix.subdir }}" = "win-64')
    expect(stage.run).toContain('"$compatibility_path" --version')
  })

  it('rebuilds the Windows sandbox host before packaging', () => {
    const job = readWorkflow('build.yml').jobs.build
    const steps = job.steps ?? []
    const rustTest = findStep(job, 'Test Windows sandbox native source')
    const buildHost = findStep(job, 'Build Windows sandbox native host')
    const packageStep = findStep(job, 'Build & package')

    expect(rustTest.if).toBe("${{ matrix.platform == 'win' }}")
    expect(rustTest.run).toBe(
      'cargo test --locked --manifest-path packages/notebook-network-sandbox/vendor/windows-src/Cargo.toml'
    )
    expect(buildHost.if).toBe("${{ matrix.platform == 'win' }}")
    expect(buildHost.run).toBe(
      'node packages/notebook-network-sandbox/vendor/windows/build.mjs x64'
    )
    expect(steps.indexOf(rustTest)).toBeLessThan(steps.indexOf(buildHost))
    expect(steps.indexOf(buildHost)).toBeLessThan(steps.indexOf(packageStep))
  })

  it('batches complete Windows coverage independently against the latest main head', () => {
    const build = readWorkflow('build.yml')
    const workflow = readWorkflow('windows-full-test.yml')
    const plan = workflow.jobs.plan
    const dependencies = workflow.jobs.windows_dependencies
    const job = workflow.jobs.windows_full_test
    const sandbox = workflow.jobs.notebook_sandbox
    const dispatch = workflow.on?.workflow_dispatch

    expect(build.jobs.windows_full_test).toBeUndefined()
    expect(workflow.on?.push).toBeUndefined()
    expect(workflow.on?.schedule).toEqual([{ cron: '47 16 * * *' }])
    expect(dispatch?.inputs?.mode).toMatchObject({
      default: 'full',
      options: ['full', 'notebook-sandbox', 'notebook-mutation', 'regressions', 'scheduled-fixes']
    })
    expect(workflow.on).not.toHaveProperty('workflow_call')
    expect(findStep(plan, 'Check for untested main changes')).toMatchObject({
      uses: './.github/actions/skip-unchanged-scheduled',
      with: { 'workflow-file': 'windows-full-test.yml' }
    })
    expect(job).toMatchObject({
      needs: ['plan', 'windows_dependencies'],
      if: "${{ needs.plan.outputs.should_test == 'true' && needs.windows_dependencies.result == 'success' && (github.event_name != 'workflow_dispatch' || (inputs.mode == 'full' || inputs.mode == 'regressions' || inputs.mode == 'scheduled-fixes')) }}",
      env: { VITEST_WINDOWS_FULL_TEST: '1' },
      'runs-on': 'windows-latest',
      'timeout-minutes': 60
    })
    expect(dependencies).toMatchObject({
      needs: ['plan', 'windows_notebook_runtime'],
      'runs-on': 'windows-latest',
      outputs: {
        artifact_id: '${{ steps.upload.outputs.artifact-id }}',
        node_version: '${{ steps.node.outputs.node-version }}'
      }
    })
    expect(findStep(dependencies, 'Install dependencies').run).toBe('node scripts/ci/npm-ci.mjs')
    expect(findStep(dependencies, 'Pack dependencies').run).toContain('pack-dependencies')
    expect(findStep(dependencies, 'Pack dependencies').shell).toBe('bash')
    expect(findStep(job, 'Restore dependencies').run).toContain('restore-dependencies')
    expect(findStep(job, 'Restore dependencies').shell).toBe('bash')
    expect(findStep(workflow.jobs.notebook_mutation, 'Restore dependencies').shell).toBe('bash')
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy?.matrix).toEqual({
      shard:
        "${{ fromJSON((inputs.mode == 'regressions' || inputs.mode == 'scheduled-fixes') && '[1]' || '[1,2,3,4,5,6,7,8]') }}"
    })
    expect(findStep(job, 'Test complete suite shard').run).toBe(
      'npm test -- --shard=${{ matrix.shard }}/8 --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000 --reporter=default --reporter=github-actions'
    )
    expect(findStep(job, 'Test complete suite shard').if).toBe(
      "${{ github.event_name != 'workflow_dispatch' || inputs.mode == 'full' }}"
    )
    const regressions = findStep(job, 'Test recent Windows regressions')
    expect(regressions.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'regressions' }}"
    )
    expect(regressions.run).toContain('scripts/windows-release-workflows.test.ts')
    expect(regressions.run).not.toContain('--shard')
    const scheduledFixes = findStep(job, 'Test scheduled Windows fixes')
    expect(scheduledFixes.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'scheduled-fixes' }}"
    )
    expect(scheduledFixes.run).toContain(
      'src/main/managed-file-versions/version-file-operator.test.ts'
    )
    expect(scheduledFixes.run).toContain('src/main/settings/service.test.ts')
    expect(scheduledFixes.run).toContain('src/main/notebook/runtime-service.rpc-retirement.test.ts')
    expect(scheduledFixes.run).toContain('src/main/notebook/shell-npm-environment.test.ts')
    expect(scheduledFixes.run).not.toContain('--shard')
    expect(sandbox).toMatchObject({
      needs: 'plan',
      if: "${{ needs.plan.outputs.should_test == 'true' && (github.event_name != 'workflow_dispatch' || (inputs.mode == 'full' || inputs.mode == 'notebook-sandbox')) }}",
      'runs-on': 'windows-latest',
      'timeout-minutes': 20
    })
    const sandboxSteps = sandbox.steps ?? []
    const rustTest = findStep(sandbox, 'Test Windows sandbox native source')
    const buildHost = findStep(sandbox, 'Build Windows sandbox native host')
    const smoke = findStep(sandbox, 'Test AppContainer ownership and removal lifecycle')
    expect(findStep(sandbox, 'Setup Node').with).toMatchObject({ 'node-version': 24 })
    expect(rustTest.run).toBe(
      'cargo test --locked --manifest-path packages/notebook-network-sandbox/vendor/windows-src/Cargo.toml'
    )
    expect(buildHost.run).toBe(
      'node packages/notebook-network-sandbox/vendor/windows/build.mjs x64'
    )
    expect(sandboxSteps.indexOf(rustTest)).toBeLessThan(sandboxSteps.indexOf(buildHost))
    expect(sandboxSteps.indexOf(buildHost)).toBeLessThan(sandboxSteps.indexOf(smoke))
    expect(smoke.run).toContain('vendor/windows-src/ci/smoke.ps1')
  })

  it('hard-gates every packaged Windows build on a fresh install/start/uninstall smoke', () => {
    const job = readWorkflow('package-smoke.yml').jobs.smoke
    const smoke = findStep(job, 'Smoke test Windows installer')
    const install = findStep(job, 'Install Windows package for AppContainer certification')

    expect(job['continue-on-error']).toBeUndefined()
    expect(smoke.if).toBe("${{ !inputs.install_only && matrix.platform == 'win' }}")
    expect(smoke.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(smoke['timeout-minutes']).toBe(20)
    expect(install.run).toContain(
      '$installerProcess = Start-Process -FilePath $installer -ArgumentList @'
    )
    expect(install.run).toContain('-Wait -PassThru')
    expect(install.run).toContain('$installerProcess.ExitCode')
    expect(install.run).not.toContain('$LASTEXITCODE')
  })

  it.skipIf(process.platform !== 'win32')(
    'captures the GUI installer exit code after waiting for completion',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'installer-exit-code-'))
      const fixture = join(directory, 'fixture.vbs')
      const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
      writeFileSync(fixture, 'WScript.Quit 0')
      const invoke = (command: string): ReturnType<typeof spawnSync> =>
        spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000
        })

      try {
        const legacy = invoke(
          `$LASTEXITCODE = $null; & "$env:WINDIR\\System32\\wscript.exe" //nologo ${quote(fixture)}; if ($LASTEXITCODE -ne 0) { exit 1 }`
        )
        expect(legacy.error, legacy.stderr).toBeUndefined()
        expect(legacy.status, legacy.stdout + legacy.stderr).toBe(1)

        const fixed = invoke(
          `$process = Start-Process -FilePath "$env:WINDIR\\System32\\wscript.exe" -ArgumentList @('//nologo', ${quote(fixture)}) -Wait -PassThru; if ($process.ExitCode -ne 0) { exit 1 }`
        )
        expect(fixed.error, fixed.stderr).toBeUndefined()
        expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20_000
  )

  it('installs Electron from GitHub mirrors and exposes an install-only dry-run', () => {
    const smokeWorkflow = readWorkflow('package-smoke.yml')
    const job = smokeWorkflow.jobs.smoke
    const install = findStep(job, 'Install dependencies')
    const download = findStep(job, 'Download packaged artifacts')
    const linux = findStep(job, 'Smoke test Linux packages')
    const evidence = findStep(job, 'Record platform certification evidence')
    const uploadEvidence = findStep(job, 'Upload platform certification evidence')
    const dispatch = smokeWorkflow.on?.workflow_dispatch

    expect(smokeWorkflow.on).toHaveProperty('workflow_call')
    expect(smokeWorkflow.on).toHaveProperty('workflow_dispatch')
    expect(smokeWorkflow.on?.workflow_call?.inputs?.install_only).toMatchObject({
      type: 'boolean',
      default: false
    })
    expect(smokeWorkflow.on?.workflow_call?.inputs?.setup_only).toMatchObject({
      type: 'boolean',
      default: false
    })
    expect(dispatch?.inputs?.setup_only).toMatchObject({ type: 'boolean', default: false })
    expect(dispatch?.inputs?.install_only).toMatchObject({ type: 'boolean', default: true })
    expect(dispatch?.inputs?.platform_name).toMatchObject({
      type: 'choice',
      default: 'macos-x64',
      options: ['macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64', 'all']
    })
    expect(smokeWorkflow.permissions).toEqual({ contents: 'read' })
    expect(smokeWorkflow.concurrency).toEqual({
      group:
        "package-smoke-${{ github.workflow }}-${{ github.ref }}-${{ inputs.platform_name || 'all' }}",
      'cancel-in-progress': true
    })
    const setup = smokeWorkflow.jobs.setup
    expect(setup).toMatchObject({
      'runs-on': 'ubuntu-latest',
      outputs: { matrix: '${{ steps.set.outputs.matrix }}' }
    })
    expect(findStep(setup, 'Checkout').uses).toBe(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
    )
    expect(findStep(setup, 'Resolve platform include list')).toMatchObject({
      id: 'set',
      run: 'echo "matrix=$(node scripts/ci/resolve-package-smoke-matrix.mjs)" >> "$GITHUB_OUTPUT"'
    })
    expect(job.needs).toBe('setup')
    expect(job.if).toBe("${{ needs.setup.result == 'success' && !inputs.setup_only }}")
    expect(job.strategy?.matrix).toBe('${{ fromJson(needs.setup.outputs.matrix) }}')
    expect(install.run).toBe('node scripts/ci/npm-ci.mjs')
    expect(download.if).toBe('${{ !inputs.install_only }}')
    expect(linux.if).toBe("${{ !inputs.install_only && matrix.platform == 'linux' }}")
    expect(evidence.if).toBe('${{ !inputs.install_only }}')
    expect(uploadEvidence.if).toBe('${{ !inputs.install_only }}')
  })

  it('signs stable Windows packages through the protected OIDC environment', () => {
    const build = readWorkflow('build.yml')
    const job = build.jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const prepareMacSigning = findStep(job, 'Prepare macOS signing keychain')
    const azureLogin = findStep(job, 'Sign in to Azure for Windows code signing')
    const preinstallTrustedSigning = findStep(job, 'Pre-install Azure Trusted Signing module')
    const verifyTrustedSigning = findStep(
      job,
      'Verify Azure Trusted Signing module in packaging environment'
    )
    const packageStep = findStep(job, 'Build & package')
    const verifyWindows = findStep(job, 'Verify signed Windows package')
    const cleanupMacSigning = findStep(job, 'Clean up macOS signing keychain')

    expect(names).not.toContain('Require Windows signing credentials')
    expect(job.environment).toBe(
      "${{ inputs.sign_windows && matrix.platform == 'win' && 'windows-signing' || '' }}"
    )
    expect(job.permissions).toMatchObject({ contents: 'read', 'id-token': 'write' })
    expect(azureLogin).toMatchObject({
      if: "${{ matrix.platform == 'win' && inputs.sign_windows }}",
      with: {
        'client-id': '${{ vars.AZURE_CLIENT_ID }}',
        'tenant-id': '${{ vars.AZURE_TENANT_ID }}',
        'subscription-id': '${{ vars.AZURE_SUBSCRIPTION_ID }}'
      }
    })
    expect(preinstallTrustedSigning).toMatchObject({
      if: "${{ matrix.platform == 'win' && inputs.sign_windows }}",
      shell: 'pwsh'
    })
    expect(preinstallTrustedSigning.run).toContain(
      '"PSModulePath=$env:PSModulePath" >> $env:GITHUB_ENV'
    )
    expect(preinstallTrustedSigning.run).toContain("$pathEntries = @($env:PSModulePath -split ';'")
    expect(preinstallTrustedSigning.run).not.toContain('[Environment]::SetEnvironmentVariable')
    expect(verifyTrustedSigning).toMatchObject({
      if: "${{ matrix.platform == 'win' && inputs.sign_windows }}",
      shell: 'bash'
    })
    expect(verifyTrustedSigning.run).toContain(
      "pwsh -NoProfile -NonInteractive -Command 'Get-Command Invoke-TrustedSigning"
    )
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
    expect(packageStep.env).toMatchObject({
      CSC_KEYCHAIN: '${{ steps.mac_signing.outputs.keychain }}',
      AZURE_SIGNING_PUBLISHER: '${{ vars.AZURE_SIGNING_PUBLISHER }}',
      AZURE_SIGNING_ENDPOINT: '${{ vars.AZURE_SIGNING_ENDPOINT }}',
      AZURE_SIGNING_ACCOUNT: '${{ vars.AZURE_SIGNING_ACCOUNT }}',
      AZURE_SIGNING_PROFILE: '${{ vars.AZURE_SIGNING_PROFILE }}',
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
    expect(packageStep.run).toContain('-c.win.forceCodeSigning=true')
    expect(packageStep.run).toContain(
      '"-c.win.azureSignOptions.publisherName=$AZURE_SIGNING_PUBLISHER"'
    )
    expect(verifyWindows).toMatchObject({
      if: "${{ matrix.platform == 'win' && inputs.sign_windows }}",
      run: './scripts/ci/verify-windows-signature.ps1 -InstallerDir dist -CheckUnpacked'
    })
    const verification = readFileSync('scripts/ci/verify-windows-signature.ps1', 'utf8')
    expect(verification).toContain('Get-ChildItem -LiteralPath $unpacked -File -Recurse')
    expect(verification).toContain('Test-PortableExecutable $_.FullName')
    expect(verification).toContain('resources/micromamba.exe')
    expect(verification).toContain('resources/micromamba-compat.exe')
    expect(verification).toContain('notebook-appcontainer-host.exe')
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
    expect(workflow.on?.workflow_dispatch).toMatchObject({
      inputs: { provider: { type: 'choice', default: 'signpath', options: ['signpath', 'azure'] } }
    })
    expect(workflow).toMatchObject({
      permissions: { actions: 'read', contents: 'read', 'id-token': 'write' }
    })
    expect(workflow.jobs.build).toMatchObject({
      uses: './.github/workflows/build.yml',
      with: {
        platform_name: 'windows-x64',
        skip_verify: true,
        sign_windows: "${{ inputs.provider == 'azure' }}"
      }
    })
    expect(workflow.jobs['azure-package-smoke']).toMatchObject({
      if: "${{ inputs.provider == 'azure' }}",
      needs: 'build',
      uses: './.github/workflows/package-smoke.yml',
      with: { platform_name: 'windows-x64', require_windows_signing: true }
    })
    expect(sign).toMatchObject({
      if: "${{ inputs.provider == 'signpath' }}",
      needs: 'build',
      'runs-on': 'windows-latest'
    })
    expect(findStep(sign, 'Select unsigned NSIS installer').run).toContain('*-win-x64-setup.exe')
    expect(uploadUnsigned).toMatchObject({
      id: 'upload-unsigned-installer',
      uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      with: expect.objectContaining({ archive: false, 'if-no-files-found': 'error' })
    })
    expect(submit).toMatchObject({
      uses: expect.stringMatching(/^signpath\/github-action-submit-signing-request@[0-9a-f]{40}$/),
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
    const windowsSignature = findStep(smoke, 'Verify Windows Authenticode signature')
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
    expect(smoke.needs).toBe('setup')
    expect(smoke.strategy?.matrix).toBe('${{ fromJson(needs.setup.outputs.matrix) }}')
    expect(downloadPackage.with?.name).toBe('${{ matrix.name }}')
    expect(downloadPackage.with?.path).toBe('dist')
    expect(macos.if).toBe("${{ !inputs.install_only && matrix.platform == 'mac' }}")
    expect(macos.run).toBe('node scripts/macos-package-smoke.mjs --artifact-dir dist')
    expect(windows.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(windowsSignature).toMatchObject({
      if: "${{ !inputs.install_only && matrix.platform == 'win' && inputs.require_windows_signing }}",
      env: { AZURE_SIGNING_PUBLISHER: '${{ vars.AZURE_SIGNING_PUBLISHER }}' },
      run: './scripts/ci/verify-windows-signature.ps1 -InstallerDir dist'
    })
    expect(evidence.run).toContain('authenticode=passed')
    expect(linux.run).toContain('scripts/linux-package-smoke.mjs')
    // Hosted runner indexes can reference superseded packages that now return HTTP 404.
    expect(linux.run).toMatch(/sudo apt-get update\s+sudo apt-get install --yes \.\/dist\/\*\.deb/)
    expect(evidence.run).toContain('--electron-p0 not-applicable')
    expect(evidence.run).toContain('--visual-regression not-applicable')
    expect(evidence.run).toContain('--package-smoke passed')
    expect(evidence.run).toContain('database-migration-certification-${{ matrix.name }}.json')
    expect(evidence.run).toContain('--database-migration-certification "$database_certification"')
    expect(uploadEvidence.with?.name).toBe('certification-${{ matrix.name }}')
    expect(uploadEvidence.with?.['retention-days']).toBe(7)
    expect(p0Regression).toMatchObject({ needs: 'source', 'runs-on': 'macos-26' })
    expect(p0Regression.if).toBe(
      "needs.source.outputs.available == 'true' && inputs.suite != 'visual'"
    )
    expect(p0Regression['continue-on-error']).toBe('${{ inputs.allow_failure == true }}')
    expect(findStep(p0Regression, 'Download macOS ARM64 package').with?.name).toBe('macos-arm64')
    expect(findStep(p0Regression, 'Download macOS ARM64 package').with?.['run-id']).toBe(
      '${{ needs.source.outputs.run_id }}'
    )
    expect(findStep(p0Regression, 'Extract packaged application').run).toContain('ditto -x -k')
    expect(findStep(p0Regression, 'Run packaged P0 regression').run).toBe(
      'bash scripts/ci/run-macos-packaged-e2e.sh npm run test:e2e:p0'
    )
    expect(
      findStep(p0Regression, 'Run packaged P0 regression').env?.OPEN_SCIENCE_E2E_EXECUTABLE
    ).toBe('${{ steps.packaged_app.outputs.executable }}')
    expect(findStep(p0Regression, 'Upload P0 diagnostics').if).toBe('always()')
    expect(visualRegression).toMatchObject({ needs: 'source', 'runs-on': 'macos-15' })
    expect(visualRegression.if).toBe(
      "${{ !cancelled() && inputs.suite != 'p0' && (inputs.suite == 'visual' || needs.source.outputs.available == 'true') }}"
    )
    expect(visualRegression['continue-on-error']).toBe('${{ inputs.allow_failure == true }}')
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
    expect(release).toMatchObject({ permissions: { actions: 'read', contents: 'read' } })
    expect(release.jobs.publish.permissions.contents).toBe('write')
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
    expect(regression.on.workflow_dispatch).toMatchObject({
      inputs: {
        run_id: { required: false },
        suite: { default: 'all', options: ['all', 'p0', 'visual'] }
      }
    })
    expect(regression.jobs.source.if).toBe("inputs.suite != 'visual'")
    expect(findStep(regression.jobs.visual, 'Upload visual diagnostics').with?.name).toBe(
      'desktop-regression-visual-${{ needs.source.outputs.run_id || github.run_id }}'
    )
    expect(findStep(regression.jobs.p0, 'Checkout source revision').with?.ref).toBe(
      '${{ needs.source.outputs.sha }}'
    )
    expect(findStep(regression.jobs.p0, 'Checkout manual launch tooling')).toMatchObject({
      if: "github.event_name == 'workflow_dispatch'",
      with: { ref: '${{ github.sha }}', 'persist-credentials': false }
    })
    expect(
      findStep(regression.jobs.p0, 'Apply manual launch tooling').run?.trim().split('\n')
    ).toEqual([
      'cp .regression-tooling/e2e/fixtures/electron-app.ts e2e/fixtures/electron-app.ts',
      'cp .regression-tooling/scripts/ci/run-macos-packaged-e2e.sh scripts/ci/run-macos-packaged-e2e.sh'
    ])
    expect(findStep(regression.jobs.visual, 'Checkout source revision').with?.ref).toBe(
      "${{ github.event_name == 'workflow_dispatch' && github.sha || needs.source.outputs.sha }}"
    )
    expect(regression.on).toHaveProperty('workflow_call')
    expect(regression.jobs.source['continue-on-error']).toBe('${{ inputs.allow_failure == true }}')
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

  it.skipIf(process.platform === 'win32').each([
    { suite: 'all', runId: '', exit: 1, message: 'run_id is required' },
    { suite: 'p0', runId: '', exit: 1, message: 'run_id is required' },
    { suite: 'all', runId: '456', exit: 77, message: 'actions/runs/456' },
    { suite: 'p0', runId: '456', exit: 77, message: 'actions/runs/456' },
    { suite: '', runId: '', exit: 77, message: 'actions/runs/123' }
  ])(
    'validates source run before metadata lookup for suite=$suite run_id=$runId',
    ({ suite, runId, exit, message }) => {
      const source = readWorkflow('desktop-regression.yml').jobs.source
      const resolve = findStep(source, 'Resolve source run')
      expect(resolve.env?.REGRESSION_SUITE).toBe('${{ inputs.suite }}')
      const result = spawnSync(
        'bash',
        ['-c', `gh() { echo "$2" >&2; exit 77; };\n${resolve.run}`],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'aipoch/open-science',
            MANUAL_RUN_ID: runId,
            CURRENT_RUN_ID: '123',
            REGRESSION_SUITE: suite
          }
        }
      )
      expect(result.status).toBe(exit)
      expect(result.stderr).toContain(message)
    }
  )

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
      with: { 'node-version': 24 }
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
    expect(previous.run).toContain('gh api --paginate --slurp')
    expect(previous.run).toContain('$version -lt $current')
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
    ).toContain('--require-signed-windows')
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
    expect(preflight.outputs).toEqual({
      windows_runtime_source_changed: '${{ steps.runtime_change.outputs.source_changed }}',
      windows_runtime_catalog_changed: '${{ steps.runtime_change.outputs.catalog_changed }}'
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
    const runtimeChange = findStep(preflight, 'Detect Windows runtime changes')
    expect(runtimeChange).toMatchObject({ id: 'runtime_change', shell: 'bash' })
    expect(runtimeChange.run).toContain("git describe --tags --match 'v*'")
    expect(runtimeChange.run).toContain('src/main/notebook/windows-runtime-catalog.json')
    expect(runtimeChange.run).toContain('Runtime source changed without a catalog update')
    expect(runtimeChange.run).toContain("'.github/workflows/windows-notebook-runtime.yml'")
    const verifyRuntime = findStep(preflight, 'Verify reviewed Windows runtime CDN objects')
    expect(verifyRuntime).toMatchObject({
      if: "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      run: 'node scripts/windows-runtime-cdn.mjs check --verify-bytes',
      env: {
        CDN_BASE_URL: '${{ vars.CDN_BASE_URL }}',
        S3_PREFIX: '${{ vars.S3_PREFIX }}'
      }
    })
    expect(release.jobs['windows-notebook-runtime']).toBeUndefined()
    expect(release.jobs['windows-runtime-sign']).toBeUndefined()
    expect(release.jobs['windows-runtime-cdn']).toBeUndefined()
    expect(release.jobs.build.needs).toBe('release-preflight')
    expect(release.jobs.build.if).toBeUndefined()
    expect(release.jobs.build.with?.sign_windows).toBe(
      "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}"
    )
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
          mode: {
            description: 'Backfill versioned files only, or promote the stable channel',
            required: true,
            type: 'choice',
            options: ['backfill', 'promote'],
            default: 'backfill'
          },
          bootstrap_linux_arm64: {
            description:
              'First ARM64 promotion only: allow a confirmed missing ARM64 feed (requires promote)',
            required: false,
            type: 'boolean',
            default: false
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
    expect(generate.run).toContain('if [ ! -d "$NOTES_DIR" ]')
    expect(generate.run).toContain('gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json body')
    expect(generate.run).toContain('unset NOTES_DIR')
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
    expect(findStep(mirror, 'Sync installers to versioned path').run).toBe(
      'node scripts/publish-update-channel.mjs'
    )
    const historical = findStep(mirror, 'Collect historical Windows blockmaps')
    expect(historical.run).toContain('gh api --paginate')
    expect(historical.run).toContain('> "$blockmap_index"')
    expect(historical.run).toContain('done < "$blockmap_index"')
    expect(historical.run).not.toContain('done < <(')
    expect(historical.run).toContain('application/octet-stream')
    expect(historical.run).toContain('historical-blockmaps/$version/$name')
    expect(historical.run).toContain('gzip -t "$target"')
    const backfill = findStep(mirror, 'Backfill historical Windows blockmaps')
    expect(backfill.run).toContain(
      'scripts/publish-release-assets.mjs blockmaps historical-blockmaps'
    )
    for (const sideEffectStep of [
      'Configure AWS credentials',
      'Collect historical Windows blockmaps',
      'Backfill historical Windows blockmaps',
      'Sync installers to versioned path'
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
