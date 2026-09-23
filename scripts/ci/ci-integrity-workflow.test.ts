import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { classifyChanges, platformExecutionPlan } from './classify-pr-changes.mjs'

type Step = {
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<
    string,
    {
      name?: string
      permissions?: Record<string, string>
      'runs-on'?: string
      steps?: Step[]
      'timeout-minutes'?: number
    }
  >
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ci-integrity.yml'), 'utf8')
) as Workflow
const job = workflow.jobs.integrity

const step = (name: string): Step => {
  const result = job?.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing CI Integrity step: ${name}`)
  return result
}

describe('CI Integrity workflow', () => {
  it('runs the stable trusted check for pull requests and merge groups', () => {
    expect(workflow.on?.pull_request_target).toEqual({
      branches: ['main'],
      types: ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']
    })
    expect(workflow.on).toHaveProperty('merge_group')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group:
        'ci-integrity-${{ github.event.pull_request.number || github.event.merge_group.head_ref || github.ref }}',
      'cancel-in-progress': true
    })
    expect(job).toMatchObject({
      name: 'CI Integrity',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5
    })
  })

  it('checks out only the trusted base revision with immutable actions', () => {
    expect(step('Checkout trusted base')).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.event.pull_request.base.sha || github.event.merge_group.base_ref }}'
      }
    })
    expect(step('Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22, cache: 'npm' }
    })
    expect(step('Install trusted parsing toolchain').run).toBe('npm ci --ignore-scripts --no-audit')
  })

  it('fetches PR objects without checking out or executing the head revision', () => {
    const revisions = step('Resolve inspected revisions')

    expect(revisions.id).toBe('revisions')
    expect(revisions.run).toContain('refs/pull/${PR_NUMBER}/head')
    expect(revisions.run).toContain('git rev-parse FETCH_HEAD')
    expect(revisions.run).not.toContain('git checkout')
    expect(revisions.run).not.toContain('git switch')
    expect(step('Inspect CI-sensitive changes').run).toBe(
      'node scripts/ci/check-ci-integrity.mjs --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
  })

  it('inspects a stacked merge group against the target branch tip, not the entry ahead', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-integrity-revisions-')))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '--quiet', '-b', 'main')
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI Test')
      writeFileSync(join(root, 'README.md'), 'base\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'main tip')
      const mainTip = git('rev-parse', 'HEAD')
      const queueRef = `gh-readonly-queue/main/pr-2-${'b'.repeat(40)}`
      git('checkout', '--quiet', '-b', queueRef)
      writeFileSync(join(root, 'ahead.txt'), 'entry ahead\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'entry ahead')
      const entryAhead = git('rev-parse', 'HEAD')
      writeFileSync(join(root, 'trailing.txt'), 'trailing entry\n')
      git('add', '.')
      git('commit', '--quiet', '-m', 'trailing entry')
      const head = git('rev-parse', 'HEAD')
      // actions/checkout leaves the trusted target branch tip at HEAD.
      git('checkout', '--quiet', 'main')
      git('remote', 'add', 'origin', root)
      const output = join(root, 'outputs')
      const result = spawnSync('bash', ['-c', step('Resolve inspected revisions').run!], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT_NAME: 'merge_group',
          MERGE_HEAD_REF: queueRef,
          MERGE_HEAD_SHA: head,
          GITHUB_OUTPUT: output
        }
      })
      expect(result.status, result.stderr).toBe(0)
      const revisions = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      )
      expect(revisions).toEqual({ base: mainTip, head })
      expect(revisions.base).not.toBe(entryAhead)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('revalidates PR metadata with the trusted base policy instead of restarting PR Gate', () => {
    expect(step('Validate pull request metadata')).toMatchObject({
      env: {
        EVENT_NAME:
          "${{ github.event_name == 'pull_request_target' && 'pull_request' || github.event_name }}",
        PR_TITLE: '${{ github.event.pull_request.title || steps.merge_group_title.outputs.title }}',
        POLICY_SCOPE: 'title'
      },
      run: 'node scripts/ci/check-pr-policy.mjs'
    })
  })

  it('resolves the squash subject from the queued pull request on merge_group', () => {
    const resolveTitle = step('Resolve merge-group squash subject')

    expect(resolveTitle.id).toBe('merge_group_title')
    expect(resolveTitle.if).toBe("${{ github.event_name == 'merge_group' }}")
    expect(resolveTitle.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      MERGE_HEAD_REF: '${{ github.event.merge_group.head_ref }}'
    })
    expect(resolveTitle.run).toContain('set -euo pipefail')
    expect(resolveTitle.run).toContain('gh-readonly-queue/main/pr-([0-9]+)-[0-9a-f]{40}$')
    expect(resolveTitle.run).toContain('gh pr view "$pr_number" --json title --jq .title')
    expect(resolveTitle.run).toContain('exit 1')
    expect(resolveTitle.run).not.toContain('git checkout')
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
  })
})

describe('module registration approval boundary', () => {
  it.each(
    ['pull_request', 'merge_group'].flatMap((event) =>
      ['scripts/ci/module-impact.json', 'scripts/ci/module-impact/sample.json'].map((path) => ({
        event,
        path
      }))
    )
  )('retains full portable fallback for $event registration at $path', ({ event, path }) => {
    const changes = [{ path, status: 'modified' }]
    const plan = platformExecutionPlan(classifyChanges(changes), changes, event)
    expect(plan.mode).toBe('full')
    expect(plan.bundles).toContain('unit')
  })

  it('exempts only registration JSON after the CI script owner rule', () => {
    const entries = readFileSync(join(process.cwd(), '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(entries).toEqual([
      '/.github/CODEOWNERS @aipoch/ci-maintainers',
      '/CODEOWNERS @aipoch/ci-maintainers',
      '/.github/workflows/ @aipoch/ci-maintainers',
      '/.github/actions/ @aipoch/ci-maintainers',
      '/.github/dependabot.yml @aipoch/ci-maintainers',
      '/.github/labels.json @aipoch/ci-maintainers',
      '/scripts/ci/ @aipoch/ci-maintainers',
      '/scripts/ci/module-impact.json',
      '/scripts/ci/module-impact/*.json'
    ])
  })
})
