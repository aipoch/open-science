/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
const workflow = (name: string): any =>
  load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'))
describe('runtime distribution boundary', () => {
  it('isolates npm publication from builds and keeps manual dry-runs credential-free', () => {
    const flow = workflow('npm-release.yml')
    expect(flow.on.workflow_run).toEqual({ workflows: ['Release'], types: ['completed'] })
    expect(flow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
    expect(flow.on.workflow_dispatch.inputs.bootstrap.default).toBe(false)
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.concurrency).toEqual({ group: 'npm-release', 'cancel-in-progress': false })
    expect(flow.jobs.source.steps.find((s: any) => s.id === 'source').run).toBe(
      'node scripts/publish-npm-release.mjs --plan-release'
    )
    expect(flow.jobs.verify).toMatchObject({
      needs: 'source',
      uses: './.github/workflows/runtime-packages.yml',
      with: { distribution: 'npm', source_sha: '${{ needs.source.outputs.source_sha }}' }
    })
    expect(flow.jobs.verify.secrets).toBeUndefined()
    expect(flow.jobs.publish.needs).toEqual(['source', 'verify'])
    expect(flow.jobs.publish.if).toContain('!inputs.dry_run')
    expect(flow.jobs.publish.environment).toBe('npm')
    expect(flow.jobs.publish.permissions['id-token']).toBe('write')
    const steps = flow.jobs.publish.steps
    const verify = steps.findIndex(
      (s: any) => s.name === 'Revalidate certified source and complete artifact set'
    )
    const publish = steps.findIndex((s: any) => s.name === 'Publish verified packages')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(publish)
    expect(steps[publish].env.NODE_AUTH_TOKEN).toContain('inputs.bootstrap')
    expect(steps[publish].run).toContain('--publish-release')
    expect(JSON.stringify(steps.slice(0, publish))).not.toContain('NPM_BOOTSTRAP_TOKEN')
    const script = flow.jobs.source.steps
      .find((s: any) => s.id === 'inputs')
      .run.replace(/^node --input-type=module <<'JS'\n/, '')
      .replace(/\nJS\s*$/, '')
    const root = mkdtempSync(join(tmpdir(), 'npm-release-inputs-'))
    try {
      const env = {
        ...process.env,
        GITHUB_OUTPUT: join(root, 'output'),
        NPM_RELEASE_RUN_ID: '42',
        GITHUB_REPOSITORY: 'aipoch/open-science',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_WORKFLOW_REF:
          'aipoch/open-science/.github/workflows/npm-release.yml@refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        DRY_RUN: 'false',
        TARGET: 'all'
      }
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'pipe' })
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('release_run_id=42')
      for (const overrides of [
        { TARGET: 'linux-x64-gnu' },
        { GITHUB_REF: 'refs/heads/feature' },
        { GITHUB_EVENT_NAME: 'pull_request' },
        { NPM_RELEASE_RUN_ID: '../42' }
      ])
        expect(() =>
          execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...env, ...overrides },
            stdio: 'pipe'
          })
        ).toThrow()
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...env, DRY_RUN: 'true', TARGET: 'linux-x64-gnu', GITHUB_REF: 'refs/heads/feature' },
        stdio: 'pipe'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('defaults the existing manual dispatcher to archives without publish permissions or secrets', () => {
    const flow = workflow('publish-npm.yml')
    expect(Object.keys(flow.on)).toEqual(['workflow_dispatch'])
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.on.workflow_dispatch.inputs.distribution.default).toBe('archive')
    expect(flow.jobs.verify.uses).toBe('./.github/workflows/runtime-packages.yml')
    expect(flow.jobs.verify.secrets).toBeUndefined()
    expect(flow.jobs.verify.with.desktop_run_id).toBe('${{ inputs.desktop_run_id }}')
    expect(flow.jobs.verify.with.verify_desktop_only).toBe("${{ inputs.desktop_run_id != '' }}")
    expect(flow.on.workflow_dispatch.inputs.release_run_id.default).toBe('')
    expect(flow.jobs.verify.needs).toBe('source')
    expect(flow.jobs.verify.with.source_sha).toBe('${{ needs.source.outputs.source_sha }}')
    const source = flow.jobs.source.steps.find((s: any) => s.id === 'source')
    expect(source.if).toBe("inputs.release_run_id != ''")
    expect(source.run).toContain('test "$DISTRIBUTION" = npm')
    expect(source.run).toContain('--plan-release')
  })
  it('allows prior-run extraction only for an explicit manual verification without packaging or uploads', () => {
    const flow = workflow('runtime-packages.yml')
    expect(flow.on.workflow_call.inputs.verify_desktop_only.default).toBe(false)
    const script = flow.jobs.plan.steps[0].run.replace(/^node <<'JS'\n/, '').replace(/\nJS\s*$/, '')
    const root = mkdtempSync(join(tmpdir(), 'runtime-workflow-'))
    const env = {
      ...process.env,
      GITHUB_OUTPUT: join(root, 'output'),
      GITHUB_RUN_ID: '200',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      DESKTOP_RUN: '100',
      VERIFY_DESKTOP_ONLY: 'true',
      DISTRIBUTION: 'archive',
      TARGET: 'darwin-arm64'
    }
    try {
      execFileSync(process.execPath, ['-e', script], { env, stdio: 'pipe' })
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('macos-15')
      for (const override of [
        { VERIFY_DESKTOP_ONLY: 'false' },
        { GITHUB_EVENT_NAME: 'push' },
        { DESKTOP_RUN: '' },
        { DESKTOP_RUN: '../100' },
        { DISTRIBUTION: 'npm' }
      ])
        expect(() =>
          execFileSync(process.execPath, ['-e', script], {
            env: { ...env, ...override },
            stdio: 'pipe'
          })
        ).toThrow()
      for (const override of [
        { DESKTOP_RUN: '100' },
        { DESKTOP_RUN: '' },
        { DISTRIBUTION: 'npm' },
        { GITHUB_EVENT_NAME: 'push' },
        { VERIFY_DESKTOP_ONLY: 'true' }
      ])
        expect(() =>
          execFileSync(process.execPath, ['-e', script], {
            env: {
              ...env,
              NIGHTLY: 'true',
              DESKTOP_RUN: '200',
              VERIFY_DESKTOP_ONLY: 'false',
              ...override
            },
            stdio: 'pipe'
          })
        ).toThrow()
      execFileSync(process.execPath, ['-e', script], {
        env: { ...env, NIGHTLY: 'true', DESKTOP_RUN: '200', VERIFY_DESKTOP_ONLY: 'false' },
        stdio: 'pipe'
      })
      const historical = {
        ...env,
        DISTRIBUTION: 'npm',
        DESKTOP_RUN: '',
        VERIFY_DESKTOP_ONLY: 'false',
        SOURCE_SHA: 'a'.repeat(40)
      }
      execFileSync(process.execPath, ['-e', script], { env: historical, stdio: 'pipe' })
      for (const overrides of [
        { SOURCE_SHA: 'main' },
        { DISTRIBUTION: 'archive' },
        { DESKTOP_RUN: '200' },
        { NIGHTLY: 'true' }
      ])
        expect(() =>
          execFileSync(process.execPath, ['-e', script], {
            env: { ...historical, ...overrides },
            stdio: 'pipe'
          })
        ).toThrow()
      // Ordinary Release calls must continue to accept their own run's artifacts.
      execFileSync(process.execPath, ['-e', script], {
        env: {
          ...env,
          GITHUB_EVENT_NAME: 'push',
          DESKTOP_RUN: '200',
          VERIFY_DESKTOP_ONLY: 'false'
        },
        stdio: 'pipe'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    const steps = flow.jobs.verify.steps
    expect(steps[0].with.ref).toBe('${{ inputs.source_sha || github.sha }}')
    expect(flow.jobs['publication-check'].steps[0].with.ref).toBe(
      '${{ inputs.source_sha || github.sha }}'
    )
    expect(
      flow.jobs['publication-check'].steps.find(
        (s: any) => s.name === 'Verify complete npm version and integrity set without publication'
      ).env.GITHUB_SHA
    ).toBe('${{ inputs.source_sha || github.sha }}')
    expect(
      steps.find((s: any) => s.name === 'Download certified desktop payload').with['run-id']
    ).toBe('${{ inputs.desktop_run_id }}')
    expect(steps.find((s: any) => s.name === 'Extract and verify signed backend').run).toBe(
      'node scripts/extract-runtime-desktop.mjs'
    )
    for (const step of steps.filter((s: any) =>
      /^(Install build|Pack |Verify |Setup minimum|Upload )/.test(s.name ?? '')
    ))
      expect(step.if, step.name).toContain('!inputs.verify_desktop_only')
    expect(flow.jobs['publication-check'].if).toContain('!inputs.verify_desktop_only')
  })
  it('shares native build/extraction while testing both distributions without publication', () => {
    const flow = workflow('runtime-packages.yml')
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.on.workflow_call.inputs.distribution.default).toBe('archive')
    const steps = flow.jobs.verify.steps
    expect(steps.find((s: any) => s.name === 'Pack standalone archive').run).toBe(
      'npm run pack:runtime-archive'
    )
    expect(
      steps.find((s: any) => s.name === 'Stage pinned Node for independent archives').run
    ).toBe('npm run stage:node-runtime')
    expect(steps.some((s: any) => s.run?.includes('npm run test:runtime-archive-installed'))).toBe(
      true
    )
    expect(steps.some((s: any) => s.run?.includes('npm run test:npm-installed'))).toBe(true)
    expect(steps.find((s: any) => s.name === 'Extract and verify signed backend').if).toBe(
      "inputs.desktop_run_id != ''"
    )
    for (const step of steps) {
      for (const line of (step.run ?? '').split('\n'))
        if (line.includes('npm publish')) expect(line).toContain('--dry-run')
      expect(JSON.stringify(step)).not.toContain('secrets.')
    }
    expect(
      flow.jobs['publication-check'].steps.some(
        (s: any) => s.run === 'npm run verify:runtime-archives -- out/distributions'
      )
    ).toBe(true)
  })
  it('reuses nightly desktop bytes, native CLI installation and complete-set verification', () => {
    const nightly = workflow('nightly.yml')
    const runtime = workflow('runtime-packages.yml')
    const publish = workflow('nightly-publish.yml')
    expect(runtime.on.workflow_call.inputs.nightly.default).toBe(false)
    expect(runtime.jobs.verify.env.OPEN_SCIENCE_RUNTIME_NIGHTLY).toBe('${{ inputs.nightly }}')
    expect(runtime.jobs['publication-check'].env.OPEN_SCIENCE_RUNTIME_NIGHTLY).toBe(
      '${{ inputs.nightly }}'
    )
    expect(nightly.jobs['cli-artifacts']).toMatchObject({
      needs: ['build', 'package-smoke'],
      uses: './.github/workflows/runtime-packages.yml',
      with: { nightly: true, desktop_run_id: "${{ format('{0}', github.run_id) }}" }
    })
    expect(nightly.jobs.prepare.needs).toContain('cli-artifacts')
    expect(nightly.jobs.prepare.if).toContain("needs.cli-artifacts.result == 'success'")
    const steps = nightly.jobs.prepare.steps
    expect(steps.find((s: any) => s.name === 'Verify all five nightly CLI archives')).toMatchObject(
      {
        env: { OPEN_SCIENCE_RUNTIME_NIGHTLY: 'true' },
        run: 'node scripts/runtime-archives.mjs verify artifacts'
      }
    )
    expect(steps.find((s: any) => s.name === 'Generate checksums').run).toContain(
      'open-science-cli-*.tar.gz'
    )
    const files = publish.jobs.publish.steps.find(
      (s: any) => s.name === 'Publish nightly pre-release'
    ).with.files
    expect(files).toContain('artifacts/open-science-cli-*.tar.gz')
    expect(files).toContain('artifacts/CLI-SHA256SUMS.txt')
  })
  it('requires same-run signed inputs, all five archives and checksums before Release publication', () => {
    const flow = workflow('release.yml')
    expect(flow.jobs['cli-artifacts'].needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(flow.jobs['cli-artifacts'].uses).toBe('./.github/workflows/runtime-packages.yml')
    expect(flow.jobs['cli-artifacts'].with.desktop_run_id).toContain('github.run_id')
    expect(flow.jobs['cli-artifacts'].with.distribution ?? 'archive').toBe('archive')
    expect(flow.jobs.publish.needs).toContain('cli-artifacts')
    expect(flow.jobs['publish-npm']).toBeUndefined()
    const steps = flow.jobs.publish.steps
    const verify = steps.findIndex((s: any) => s.name === 'Verify standalone release archive set')
    const publish = steps.findIndex((s: any) => s.name === 'Publish GitHub Release')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(publish)
    expect(steps.find((s: any) => s.name === 'Generate checksums').run).toContain('*.tar.gz')
    for (const name of ['Attest build provenance', 'Publish GitHub Release']) {
      const entry = steps.find((s: any) => s.name === name)
      const patterns = entry.with['subject-path'] ?? entry.with.files
      expect(patterns).toContain('artifacts/open-science-cli-*.tar.gz')
      expect(patterns).toContain('artifacts/*.zip')
    }
    expect(JSON.stringify(flow)).not.toContain('NPM_TOKEN')
  })
})
