import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkCiIntegrityChanges, ciIntegrityFilesFromRevisions } from './check-ci-integrity.mjs'

describe('CI integrity policy', () => {
  it('accepts the repository PR Gate and CI Integrity workflows as new files', () => {
    const paths = [
      '.github/workflows/pr-gate.yml',
      '.github/workflows/ci-integrity.yml',
      '.github/workflows/pr-automation-signal.yml',
      '.github/workflows/resolve-pr-signal.yml'
    ]
    const result = checkCiIntegrityChanges(
      paths.map((path) => ({
        path,
        baseText: '',
        headText: readFileSync(resolve(path), 'utf8')
      }))
    )

    expect(result).toMatchObject({ ok: true, violations: [] })
  })

  it.each([
    { signal: 'workflows: [PR Automation Signal]\n    types: [completed]', ok: true },
    { signal: 'workflows: [Other]\n    types: [completed]', ok: false },
    { signal: 'workflows: [PR Automation Signal]\n    types: [requested]', ok: false },
    {
      signal: 'workflows: [PR Automation Signal]\n    types: [completed]\n    branches: [main]',
      ok: false
    }
  ])('accepts only the unfiltered PR completion signal: $signal', ({ signal, ok }) => {
    const path = '.github/workflows/ci-integrity.yml'
    const result = checkCiIntegrityChanges([
      ...['pr-automation-signal', 'resolve-pr-signal'].map((name) => ({
        path: `.github/workflows/${name}.yml`,
        headText: readFileSync(`.github/workflows/${name}.yml`, 'utf8')
      })),
      {
        path,
        baseText: readFileSync(resolve(path), 'utf8'),
        headText: `on:
  workflow_run:
    ${signal}
  merge_group:
    types: [checks_requested]
jobs:
  resolve:
    uses: ./.github/workflows/resolve-pr-signal.yml
  integrity:
    name: CI Integrity
    needs: [resolve]
    if: \${{ needs.resolve.result == 'success' && needs.resolve.outputs.number != '' }}
    env:
      PR_NUMBER: \${{ needs.resolve.outputs.number }}
      PR_HEAD_SHA: \${{ needs.resolve.outputs.head_sha }}
      BASE_SHA: \${{ needs.resolve.outputs.base_sha }}
      PR_TITLE: \${{ needs.resolve.outputs.title }}
`
      }
    ])
    expect(result.ok).toBe(ok)
    if (!ok)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: 'required-check-triggers' })
      )
  })

  it('checks unchanged successor dependencies when a later PR disables its signal', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-signal-contract-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '--quiet')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      mkdirSync(join(root, '.github/workflows'), { recursive: true })
      const signal = '.github/workflows/pr-automation-signal.yml'
      const resolver = '.github/workflows/resolve-pr-signal.yml'
      const integrity = '.github/workflows/ci-integrity.yml'
      for (const path of [signal, resolver]) writeFileSync(join(root, path), readFileSync(path))
      writeFileSync(
        join(root, integrity),
        `on:
  workflow_run:
    workflows: [PR Automation Signal]
    types: [completed]
  merge_group:
    types: [checks_requested]
jobs:
  resolve:
    uses: ./.github/workflows/resolve-pr-signal.yml
  integrity:
    name: CI Integrity
    needs: [resolve]
    if: \${{ needs.resolve.result == 'success' && needs.resolve.outputs.number != '' }}
    env:
      PR_NUMBER: \${{ needs.resolve.outputs.number }}
      PR_HEAD_SHA: \${{ needs.resolve.outputs.head_sha }}
      BASE_SHA: \${{ needs.resolve.outputs.base_sha }}
      PR_TITLE: \${{ needs.resolve.outputs.title }}
`
      )
      git('add', '.')
      git('commit', '--quiet', '-m', 'baseline')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(
        join(root, signal),
        readFileSync(signal, 'utf8').replace(
          'name: Signal PR automation',
          'name: Signal PR automation\n    if: false'
        )
      )
      git('add', '.')
      git('commit', '--quiet', '-m', 'disable signal')
      const files = ciIntegrityFilesFromRevisions(base, git('rev-parse', 'HEAD'), { cwd: root })
      expect(files.map(({ path }) => path)).toEqual(
        expect.arrayContaining([signal, resolver, integrity])
      )
      expect(checkCiIntegrityChanges(files).violations).toContainEqual(
        expect.objectContaining({ path: signal, rule: 'pr-automation-support' })
      )
      expect(
        checkCiIntegrityChanges(
          files.map((file) => (file.path === signal ? { ...file, headText: '' } : file))
        ).ok
      ).toBe(false)
      expect(
        checkCiIntegrityChanges(
          files.map((file) =>
            file.path === signal ? { ...file, headText: readFileSync(signal, 'utf8') } : file
          )
        ).ok
      ).toBe(true)
      const validFiles = files.map((file) =>
        file.path === signal ? { ...file, headText: readFileSync(signal, 'utf8') } : file
      )
      const noOpResolver = validFiles.map((file) =>
        file.path === resolver
          ? {
              ...file,
              headText: `on:
  workflow_call:
    inputs:
      run_id:
        required: true
jobs:
  resolve:
    runs-on: ubuntu-latest
    steps:
      - run: true
`
            }
          : file
      )
      expect(checkCiIntegrityChanges(noOpResolver).violations).toContainEqual(
        expect.objectContaining({ path: resolver, rule: 'pr-automation-support' })
      )
      const resolverText = readFileSync(resolver, 'utf8')
      const scriptOffset = resolverText.indexOf('          script: |')
      const inertMarkerResolver = validFiles.map((file) =>
        file.path === resolver
          ? {
              ...file,
              headText:
                resolverText.slice(0, scriptOffset) +
                `          script: |
            // run.repository.id !== repo.id; run.event !== 'pull_request'; run.path !== '.github/workflows/pr-automation-signal.yml'
            // run.status !== 'completed'; run.conclusion !== 'success'; run.display_title; run.head_repository
            // job.name === 'Signal PR automation'; pr.state !== 'open'; pr.base.ref !== repo.default_branch
            // pr.head.sha !== run.head_sha; listJobsForWorkflowRunAttempt; run.pull_requests; run.run_attempt
            core.setOutput('number', '')
            core.setOutput('head_sha', '')
            core.setOutput('base_sha', '')
            core.setOutput('action', '')
            core.setOutput('title', '')
`
            }
          : file
      )
      expect(checkCiIntegrityChanges(inertMarkerResolver).violations).toContainEqual(
        expect.objectContaining({ path: resolver, rule: 'pr-automation-support' })
      )
      const skippedResolver = validFiles.map((file) =>
        file.path === resolver
          ? {
              ...file,
              headText: file.headText.replace(
                '  resolve:\n    runs-on:',
                '  resolve:\n    if: false\n    runs-on:'
              )
            }
          : file
      )
      expect(checkCiIntegrityChanges(skippedResolver).violations).toContainEqual(
        expect.objectContaining({ path: resolver, rule: 'pr-automation-support' })
      )
      for (const needs of ['resolve', 'unrelated-resolve']) {
        const candidate = validFiles.map((file) =>
          file.path === integrity
            ? { ...file, headText: file.headText.replace('needs: [resolve]', `needs: ${needs}`) }
            : file
        )
        expect(checkCiIntegrityChanges(candidate).ok).toBe(needs === 'resolve')
      }
      const renamedSignal = validFiles.map((file) =>
        file.path === signal
          ? {
              ...file,
              headText: file.headText.replace(
                'run-name: PR automation',
                'run-name: Renamed automation'
              )
            }
          : file
      )
      expect(checkCiIntegrityChanges(renamedSignal).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails its Git revision CLI and publishes violations for Actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-integrity-'))
    const summary = join(root, 'summary')

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
      writeFileSync(
        join(root, '.github', 'workflows', 'example.yml'),
        'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7\n'
      )
      execFileSync('git', ['add', '.github/workflows/example.yml'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'add workflow'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(
        process.execPath,
        [resolve('scripts/ci/check-ci-integrity.mjs'), '--base', base, '--head', head],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary }
        }
      )

      expect(result.status).toBe(1)
      expect(readFileSync(summary, 'utf8')).toContain('immutable-action-reference')
      expect(readFileSync(summary, 'utf8')).toContain('.github/workflows/example.yml')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('inspects CI scripts without treating embedded workflow fixtures as executable YAML', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-integrity-script-fixture-'))

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      mkdirSync(join(root, 'scripts', 'ci'), { recursive: true })
      writeFileSync(
        join(root, 'scripts', 'ci', 'policy.test.ts'),
        `const unsafeWorkflowFixture = \`on: pull_request_target
permissions:
  contents: write
jobs:
  inspect:
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.head.sha }}
\`\n`
      )
      execFileSync('git', ['add', 'scripts/ci/policy.test.ts'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'add CI policy fixture'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const files = ciIntegrityFilesFromRevisions(base, head, { cwd: root })
      expect(files.map(({ path }) => path)).toEqual(['scripts/ci/policy.test.ts'])
      expect(checkCiIntegrityChanges(files)).toMatchObject({ ok: true, violations: [] })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('ignores protected target-branch changes that are absent from a divergent PR head', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-integrity-divergent-pr-'))

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
      writeFileSync(
        join(root, '.github', 'workflows', 'pr-gate.yml'),
        'jobs:\n  gate:\n    name: PR Gate\n    steps:\n      - uses: actions/checkout@v7\n'
      )
      execFileSync('git', ['add', '.github/workflows/pr-gate.yml'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'initial gate'], { cwd: root })
      const branchPoint = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: root })
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = true\n')
      execFileSync('git', ['add', 'src/feature.ts'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'change product code'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      execFileSync('git', ['checkout', '--quiet', '-b', 'target', branchPoint], { cwd: root })
      writeFileSync(
        join(root, '.github', 'workflows', 'pr-gate.yml'),
        'jobs:\n  gate:\n    name: PR Gate\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'
      )
      execFileSync('git', ['add', '.github/workflows/pr-gate.yml'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'harden target gate'], { cwd: root })
      const target = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const files = ciIntegrityFilesFromRevisions(target, head, { cwd: root })

      expect(files).toEqual([])
      expect(checkCiIntegrityChanges(files)).toMatchObject({ ok: true, violations: [] })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects a newly introduced mutable third-party action reference', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/example.yml',
        baseText: '',
        headText: `jobs:
  verify:
    steps:
      - uses: actions/checkout@v7
`
      }
    ])

    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/example.yml',
        rule: 'immutable-action-reference'
      })
    )
  })

  it.each(['- "uses": actions/checkout@v7', '[{ "uses": actions/checkout@v7 }]'])(
    'rejects a mutable action reference expressed as valid YAML: %s',
    (stepYaml) => {
      const result = checkCiIntegrityChanges([
        {
          path: '.github/workflows/example.yml',
          baseText: '',
          headText: `jobs:
  verify:
    steps:
      ${stepYaml}
`
        }
      ])

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          path: '.github/workflows/example.yml',
          rule: 'immutable-action-reference'
        })
      )
    }
  )

  it('rejects mutable third-party action references retained in a changed workflow', () => {
    const text = `jobs:
  verify:
    steps:
      - uses: actions/checkout@v7
`
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/example.yml',
        baseText: text,
        headText: text
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/example.yml',
        rule: 'immutable-action-reference'
      })
    )
  })

  it('does not treat ordinary uses keys as action references', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/example.yml',
        baseText: '',
        headText: `env:
  uses: ordinary-value
jobs:
  verify:
    steps:
      - run: echo safe
        env: { uses: another-ordinary-value }
`
      }
    ])

    expect(result.violations).not.toContainEqual(
      expect.objectContaining({ rule: 'immutable-action-reference' })
    )
  })

  it.each([
    {
      label: 'reusable workflow job',
      path: '.github/workflows/reusable.yml',
      headText: `jobs:
  call:
    uses: example/project/.github/workflows/reuse.yml@main
`
    },
    {
      label: 'composite action step',
      path: '.github/actions/action.yml',
      headText: `name: Example
runs:
  using: composite
  steps:
    - uses: example/project/action@main
`
    }
  ])('rejects a mutable action reference in a $label', ({ path, headText }) => {
    const result = checkCiIntegrityChanges([{ path, baseText: '', headText }])

    expect(result.violations).toContainEqual(
      expect.objectContaining({ path, rule: 'immutable-action-reference' })
    )
  })

  it.each([
    {
      label: 'reusable workflow job',
      path: '.github/workflows/reusable.yml',
      headText: `jobs:
  call:
    uses: example/project/.github/workflows/reuse.yml@3d3c42e5aac5ba805825da76410c181273ba90b1
`
    },
    {
      label: 'composite action step',
      path: '.github/actions/example/action.yml',
      headText: `name: Example
runs:
  using: composite
  steps:
    - uses: example/project/action@3d3c42e5aac5ba805825da76410c181273ba90b1
`
    }
  ])('accepts an immutable action reference in a $label', ({ path, headText }) => {
    const result = checkCiIntegrityChanges([{ path, baseText: '', headText }])

    expect(result.violations).not.toContainEqual(
      expect.objectContaining({ rule: 'immutable-action-reference' })
    )
  })

  it('rejects invalid proposed workflow YAML', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/broken.yml',
        baseText: '',
        headText: 'jobs:\n  verify: ['
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/broken.yml',
        rule: 'valid-workflow-yaml'
      })
    )
  })

  it('rejects PR-head execution from a pull_request_target workflow', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/unsafe.yml',
        baseText: '',
        headText: `on: pull_request_target
jobs:
  inspect:
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/unsafe.yml',
        rule: 'no-pr-head-execution'
      })
    )
  })

  it('rejects newly introduced write permissions on pull_request_target', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/privileged.yml',
        baseText: '',
        headText: `on: pull_request_target
permissions:
  contents: write
jobs: {}
`
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/privileged.yml',
        rule: 'minimal-target-permissions'
      })
    )
  })

  it('rejects quoted inline write permissions on pull_request_target', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/privileged-inline.yml',
        baseText: '',
        headText: `"on": { "pull_request_target": {} }
"permissions": { "contents": write }
jobs: {}
`
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/privileged-inline.yml',
        rule: 'minimal-target-permissions'
      })
    )
  })

  it.each([
    ['.github/workflows/pr-gate.yml', 'PR Gate'],
    ['.github/workflows/ci-integrity.yml', 'CI Integrity']
  ])('preserves the stable required job name in %s', (path, requiredName) => {
    const result = checkCiIntegrityChanges([
      {
        path,
        baseText: `jobs:\n  gate:\n    name: ${requiredName}\n`,
        headText: 'jobs:\n  renamed:\n    name: Something Else\n'
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({ path, rule: 'stable-required-check' })
    )
  })

  it.each([`\${{ 'PR Gate' }}`, `\${{ matrix.check }}`, `PR \${{ matrix.suffix }}`])(
    'rejects a dynamic job name that can equal a reserved check: %s',
    (name) => {
      const result = checkCiIntegrityChanges([
        {
          path: '.github/workflows/untrusted.yml',
          baseText: '',
          headText: `jobs:
  other:
    name: "${name}"
    strategy:
      matrix:
        check: [PR Gate]
`
        }
      ])

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          path: '.github/workflows/untrusted.yml',
          rule: 'reserved-dynamic-check'
        })
      )
    }
  )

  it('rejects changes elsewhere in a workflow with a spoofable dynamic job name', () => {
    const baseText = `jobs:
  setup:
    outputs:
      check: Safe check
  verify:
    needs: setup
    name: "\${{ needs.setup.outputs.check }}"
`
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/existing.yml',
        baseText,
        headText: baseText.replace('Safe check', 'PR Gate')
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'reserved-dynamic-check' })
    )
  })

  it('allows a changed workflow whose dynamic name cannot equal a reserved check', () => {
    const workflow = `jobs:
  verify:
    name: "Verify (\${{ matrix.os }})"
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: echo safe
`
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/existing.yml',
        baseText: workflow,
        headText: workflow.replace('echo safe', 'echo still-safe')
      }
    ])

    expect(result.violations).not.toContainEqual(
      expect.objectContaining({ rule: 'reserved-dynamic-check' })
    )
  })

  it('allows owner-reviewed workflow edits that preserve required checks', () => {
    const baseText = `on:
  pull_request:
    branches: [main]
  merge_group:
    types: [checks_requested]
jobs:
  gate:
    name: PR Gate
    needs: [preflight]
    steps:
      - run: node scripts/ci/evaluate-pr-gate.mjs
`
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/pr-gate.yml',
        baseText,
        headText: baseText.replace('needs: [preflight]', 'needs: [preflight, policy]')
      }
    ])

    // Native ruleset review is separate from this structural validation.
    expect(result.ok).toBe(true)
  })

  it.each([
    {
      label: 'drops the merge_group trigger from pr-gate',
      path: '.github/workflows/pr-gate.yml',
      headText: `on:
  pull_request:
    branches: [main]
jobs:
  gate:
    name: PR Gate
`
    },
    {
      label: 'drops checks_requested from the ci-integrity merge_group trigger',
      path: '.github/workflows/ci-integrity.yml',
      headText: `on:
  pull_request_target:
    branches: [main]
  merge_group:
    types: [destroyed]
jobs:
  integrity:
    name: CI Integrity
`
    },
    {
      label: 'replaces pull_request_target with pull_request in ci-integrity',
      path: '.github/workflows/ci-integrity.yml',
      headText: `on:
  pull_request:
    branches: [main]
  merge_group:
    types: [checks_requested]
jobs:
  integrity:
    name: CI Integrity
`
    },
    {
      label: 'uses a bare pull_request trigger without merge_group in pr-gate',
      path: '.github/workflows/pr-gate.yml',
      headText: `on: pull_request
jobs:
  gate:
    name: PR Gate
`
    }
  ])('rejects a required workflow that $label', ({ path, headText }) => {
    const result = checkCiIntegrityChanges([
      { path, baseText: readFileSync(resolve(path), 'utf8'), headText }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({ path, rule: 'required-check-triggers' })
    )
    expect(result.violations).not.toContainEqual(
      expect.objectContaining({ rule: 'stable-required-check' })
    )
  })

  it('keeps required-check triggers when a required workflow is renamed', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/replacement.yml',
        previousPath: '.github/workflows/ci-integrity.yml',
        baseText: readFileSync(resolve('.github/workflows/ci-integrity.yml'), 'utf8'),
        headText: `on:
  pull_request_target:
    branches: [main]
jobs:
  integrity:
    name: CI Integrity
`
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/replacement.yml',
        rule: 'required-check-triggers'
      })
    )
  })

  it('does not apply required-check triggers to unrelated workflows', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/nightly.yml',
        baseText: '',
        headText: `on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  nightly:
    name: Nightly
    steps:
      - run: echo nightly
`
      }
    ])

    expect(result.violations).not.toContainEqual(
      expect.objectContaining({ rule: 'required-check-triggers' })
    )
  })

  it.each([
    'scripts/ci/check-ci-integrity.mjs',
    'scripts/ci/check-pr-policy.mjs',
    'scripts/ci/classify-pr-changes.mjs',
    'scripts/ci/change-impact.json',
    'scripts/ci/evaluate-pr-gate.mjs'
  ])('allows owner-reviewed changes to established control-plane file %s', (path) => {
    const result = checkCiIntegrityChanges([
      {
        path,
        baseText: 'trusted base content\n',
        headText: 'updated trusted content\n'
      }
    ])

    expect(result.ok).toBe(true)
  })

  it('rejects a content-preserving rename of an established required workflow', () => {
    const workflow = `jobs:
  gate:
    name: PR Gate
`
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/replacement.yml',
        previousPath: '.github/workflows/pr-gate.yml',
        baseText: workflow,
        headText: workflow
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/replacement.yml',
        rule: 'reserved-required-check'
      })
    )
  })

  it.each([
    ['gate', 'Unrelated gate'],
    ['other', 'PR Gate'],
    ['integrity', 'Unrelated integrity'],
    ['other', 'CI Integrity']
  ])('rejects reserved required-check identity %s/%s in another workflow', (jobId, name) => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/untrusted.yml',
        baseText: '',
        headText: `jobs:
  ${jobId}:
    name: ${name}
`
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/untrusted.yml',
        rule: 'reserved-required-check'
      })
    )
  })

  it('preserves the stable PR Gate when its workflow is renamed', () => {
    const result = checkCiIntegrityChanges([
      {
        path: '.github/workflows/replacement.yml',
        previousPath: '.github/workflows/pr-gate.yml',
        baseText: 'jobs:\n  gate:\n    name: PR Gate\n',
        headText: 'jobs:\n  renamed:\n    name: Something Else\n'
      }
    ])

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: '.github/workflows/replacement.yml',
        rule: 'stable-required-check'
      })
    )
  })

  it('retains the previous required-workflow path from a Git rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-integrity-rename-'))

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
      writeFileSync(
        join(root, '.github', 'workflows', 'pr-gate.yml'),
        `name: Pull request checks
on: pull_request
permissions:
  contents: read
jobs:
  gate:
    name: PR Gate
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`
      )
      execFileSync('git', ['add', '.github/workflows/pr-gate.yml'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'add gate'], { cwd: root })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      execFileSync(
        'git',
        ['mv', '.github/workflows/pr-gate.yml', '.github/workflows/replacement.yml'],
        { cwd: root }
      )
      writeFileSync(
        join(root, '.github', 'workflows', 'replacement.yml'),
        `name: Pull request checks
on: pull_request
permissions:
  contents: read
jobs:
  renamed:
    name: Something Else
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`
      )
      execFileSync('git', ['add', '.github/workflows/replacement.yml'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'rename gate'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const files = ciIntegrityFilesFromRevisions(base, head, { cwd: root })
      expect(files).toContainEqual(
        expect.objectContaining({
          path: '.github/workflows/replacement.yml',
          previousPath: '.github/workflows/pr-gate.yml'
        })
      )
      expect(checkCiIntegrityChanges(files).violations).toContainEqual(
        expect.objectContaining({ rule: 'stable-required-check' })
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
