import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkCiIntegrityChanges, ciIntegrityFilesFromRevisions } from './check-ci-integrity.mjs'

describe('CI integrity policy', () => {
  it('accepts the repository PR Gate and CI Integrity workflows as new files', () => {
    const paths = ['.github/workflows/pr-gate.yml', '.github/workflows/ci-integrity.yml']
    const result = checkCiIntegrityChanges(
      paths.map((path) => ({
        path,
        baseText: '',
        headText: readFileSync(resolve(path), 'utf8')
      }))
    )

    expect(result).toMatchObject({ ok: true, violations: [] })
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
