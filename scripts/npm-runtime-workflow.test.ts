/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    expect(flow.jobs.verify.needs).toBe('source')
    expect(flow.jobs.verify.uses).toBeUndefined()
    expect(flow.on.workflow_dispatch.inputs.target).toBeUndefined()
    for (const job of [flow.jobs.verify, flow.jobs.publish]) {
      const download = job.steps.find((s: any) => s.uses?.startsWith('actions/download-artifact@'))
      expect(download.with).toMatchObject({
        pattern: 'npm-*',
        path: 'out/distributions',
        'run-id': '${{ needs.source.outputs.release_run_id }}',
        'github-token': '${{ github.token }}'
      })
      expect(JSON.stringify(job)).not.toMatch(/stage:backend|pack:npm-release|runtime-packages.yml/)
    }
    expect(JSON.stringify(flow.jobs.verify)).not.toMatch(/secrets\.|id-token|--publish-release/)
    expect(flow.jobs.verify.steps.at(-1).run).toContain('--verify-release')
    expect(flow.jobs.verify.secrets).toBeUndefined()
    expect(flow.jobs.publish.needs).toEqual(['source', 'verify'])
    expect(flow.jobs.publish.if).toContain('!inputs.dry_run')
    expect(flow.jobs.publish.environment).toBe('npm')
    expect(flow.jobs.publish.permissions['id-token']).toBe('write')
    const steps = flow.jobs.publish.steps
    const publish = steps.findIndex((s: any) => s.name === 'Publish verified packages')
    expect(publish).toBeGreaterThan(-1)
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
    expect(flow.on.workflow_dispatch.inputs.include_npm.default).toBe(false)
    expect(flow.jobs.verify.with.include_npm).toBe('${{ inputs.include_npm }}')
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
      ).env.SOURCE_SHA
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
  it.skipIf(process.platform === 'win32')(
    'passes the certified source to the Ubuntu publication check',
    () => {
      const step = workflow('runtime-packages.yml').jobs['publication-check'].steps.find(
        (s: any) => s.name === 'Verify complete npm version and integrity set without publication'
      )
      // The runner owns GITHUB_* defaults; YAML env cannot override GITHUB_SHA.
      expect(step.env.GITHUB_SHA).toBeUndefined()
      for (const sourceSha of ['a'.repeat(40), 'b'.repeat(40)]) {
        const output = execFileSync(
          'bash',
          [
            '-c',
            `npm() { printf '%s' "$GITHUB_SHA"; }
${step.run}`
          ],
          {
            env: { ...process.env, GITHUB_SHA: 'b'.repeat(40), SOURCE_SHA: sourceSha },
            encoding: 'utf8'
          }
        )
        expect(output).toBe(sourceSha)
      }
    }
  )
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
  it('prepares both formats from one backend without a registry dependency in Release', () => {
    const flow = workflow('runtime-packages.yml')
    expect(flow.on.workflow_call.inputs.include_npm.default).toBe(false)
    expect(workflow('nightly.yml').jobs['cli-artifacts'].with.include_npm).toBeUndefined()
    const steps = flow.jobs.verify.steps
    for (const name of [
      'Pack ordinary Node runtime',
      'Verify npm publish input without publication',
      'Verify native npm installation',
      'Setup minimum supported Node',
      'Verify installed native ABI on minimum Node',
      'Upload verified native npm tarballs'
    ]) {
      expect(steps.find((s: any) => s.name === name).if).toContain('inputs.include_npm')
    }
    expect(
      steps.find((s: any) => s.name === 'Upload verified native npm tarballs').with[
        'retention-days'
      ]
    ).toBe(30)
    const linux = steps.find(
      (s: any) => s.name === 'Verify headless Linux install and real Notebook lifecycle'
    )
    expect(linux.env.INCLUDE_NPM).toBe('${{ inputs.include_npm }}')
    expect(linux.run).toContain('[ "$INCLUDE_NPM" = true ]')
    const checks = flow.jobs['publication-check'].steps
    const downloads = checks.filter((s: any) => s.uses?.startsWith('actions/download-artifact@'))
    expect(downloads.map((s: any) => s.with.path)).toEqual([
      'out/distributions',
      'out/npm-distributions'
    ])
    expect(downloads[1].with.pattern).toBe('npm-*')
    const npmCheck = checks.find(
      (s: any) => s.name === 'Verify complete npm version and integrity set without publication'
    )
    expect(npmCheck.if).toContain('inputs.include_npm')
    expect(npmCheck.run).toContain('out/npm-distributions --dry-run')
    const script = flow.jobs.plan.steps[0].run.replace(/^node <<'JS'\n/, '').replace(/\nJS\s*$/, '')
    const root = mkdtempSync(join(tmpdir(), 'npm-combined-inputs-'))
    try {
      const env = {
        ...process.env,
        GITHUB_OUTPUT: join(root, 'output'),
        GITHUB_RUN_ID: '42',
        GITHUB_EVENT_NAME: 'push',
        DISTRIBUTION: 'archive',
        INCLUDE_NPM: 'true',
        DESKTOP_RUN: '42',
        TARGET: 'all',
        NIGHTLY: 'false',
        VERIFY_DESKTOP_ONLY: 'false',
        SOURCE_SHA: ''
      }
      execFileSync(process.execPath, ['-e', script], { env, stdio: 'pipe' })
      // The focused manual dispatcher uses this same path without publication.
      execFileSync(process.execPath, ['-e', script], {
        env: {
          ...env,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          DESKTOP_RUN: '',
          TARGET: 'linux-x64-gnu'
        },
        stdio: 'pipe'
      })
      for (const overrides of [
        { NIGHTLY: 'true' },
        { VERIFY_DESKTOP_ONLY: 'true' },
        { SOURCE_SHA: 'a'.repeat(40) },
        { DISTRIBUTION: 'npm' }
      ]) {
        expect(() =>
          execFileSync(process.execPath, ['-e', script], {
            env: { ...env, ...overrides },
            stdio: 'pipe'
          })
        ).toThrow()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
    expect(flow.jobs['cli-artifacts'].with.include_npm).toBe(true)
    expect(flow.jobs.publish.needs).toContain('cli-artifacts')
    expect(flow.jobs['publish-npm']).toBeUndefined()
    const steps = flow.jobs.publish.steps
    expect(steps.find((s: any) => s.name === 'Download all build artifacts').with.pattern).toBe(
      '!npm-*'
    )
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

describe('installed npm registry proxy', () => {
  const source = readFileSync(new URL('./test-npm-installed.mjs', import.meta.url), 'utf8')
  const proxySource = source.slice(
    source.indexOf('// The staged entry package'),
    source.indexOf('const server =')
  )
  const setup = (): {
    body: Buffer
    fetch: ReturnType<typeof vi.fn>
    proxy: (path: string, response: unknown) => Promise<void>
    response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  } => {
    const body = Buffer.from([0x1f, 0x8b, 0x00, 0xff])
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => body
    })
    const proxy = runInNewContext(`${proxySource}; upstreamRegistry`, { fetch, Buffer })
    const response = { writeHead: vi.fn(), end: vi.fn() }
    return { body, fetch, proxy, response }
  }

  it.each([
    'isexe',
    '@modelcontextprotocol/sdk',
    'isexe/-/isexe-2.0.0.tgz',
    '@modelcontextprotocol/sdk/-/sdk-1.0.0.tgz'
  ])('forwards dependency request %s without changing bytes', async (path) => {
    const { body, fetch, proxy, response } = setup()
    await proxy(path, response)
    expect(fetch).toHaveBeenCalledWith(`https://registry.npmjs.org/${path}`)
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/octet-stream'
    })
    expect(response.end).toHaveBeenCalledWith(body)
  })

  it.each([
    '//evil.example/archive.tgz',
    'https://evil.example/archive.tgz',
    'isexe/-/../../archive.tgz',
    'isexe/-/archive.tgz?redirect=evil',
    'isexe/-/archive.zip',
    '@scope/pkg/-/nested/archive.tgz'
  ])('rejects invalid registry path %s before fetching', async (path) => {
    const { fetch, proxy, response } = setup()
    await proxy(path, response)
    expect(fetch).not.toHaveBeenCalled()
    expect(response.writeHead).toHaveBeenCalledWith(404)
    expect(response.end).toHaveBeenCalledWith('{"error":"not_found"}')
  })
})
