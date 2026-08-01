import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkPrPolicy } from './check-pr-policy.mjs'

describe('pull request policy', () => {
  it('validates commit subjects from the Git revision CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-policy-'))
    const summary = join(root, 'summary')

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'chore(fixture): add baseline'], {
        cwd: root
      })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      writeFileSync(join(root, 'README.md'), '# updated fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync(
        'git',
        [
          'commit',
          '--quiet',
          '-m',
          'feat(api)!: remove legacy session endpoint',
          '-m',
          'BREAKING CHANGE: remove the legacy session endpoint.'
        ],
        { cwd: root }
      )
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_SHA: base,
          EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: summary,
          HEAD_SHA: head,
          PR_TITLE: 'feat(api): update the session endpoint'
        }
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(summary, 'utf8')).toContain('Result: **pass**')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('reports an invalid PR title and every invalid commit subject', () => {
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'Improve CI',
      commitSubjects: [
        'ci(gate): add aggregate result',
        'missing conventional format',
        'fix(Bad Scope): Uppercase description'
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      { kind: 'title', subject: 'Improve CI' },
      { kind: 'commit', subject: 'missing conventional format' },
      { kind: 'commit', subject: 'fix(Bad Scope): Uppercase description' }
    ])
  })

  it('can validate editable title policy separately from immutable commit policy', () => {
    expect(
      checkPrPolicy({
        eventName: 'pull_request',
        scope: 'title',
        title: 'Improve CI',
        commitSubjects: ['missing conventional format']
      }).violations
    ).toEqual([{ kind: 'title', subject: 'Improve CI' }])

    expect(
      checkPrPolicy({
        eventName: 'pull_request',
        scope: 'commits',
        title: 'Improve CI',
        commitSubjects: ['missing conventional format']
      }).violations
    ).toEqual([{ kind: 'commit', subject: 'missing conventional format' }])
  })

  it('validates a title-only CLI run without requiring Git revisions', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        GITHUB_STEP_SUMMARY: '',
        POLICY_SCOPE: 'title',
        PR_TITLE: 'feat(ci): refresh pull request metadata'
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Result: **pass**')
  })

  it('rejects a breaking commit without the required footer', () => {
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'feat(api): update the session endpoint',
      commitSubjects: ['feat(api)!: remove legacy session endpoint'],
      commitMessages: ['feat(api)!: remove legacy session endpoint']
    })

    expect(result.violations).toContainEqual({
      kind: 'breaking-change-footer',
      subject: 'feat(api)!: remove legacy session endpoint'
    })
  })

  it('accepts a breaking commit with its required footer', () => {
    const subject = 'feat(api)!: remove legacy session endpoint'
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'feat(api): update the session endpoint',
      commitSubjects: [subject],
      commitMessages: [`${subject}\n\nBREAKING CHANGE: remove the legacy session endpoint.`]
    })

    expect(result).toEqual({ ok: true, violations: [] })
  })
})
