import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
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
      if?: string
      permissions?: Record<string, string>
      'runs-on'?: string
      steps?: Step[]
      'timeout-minutes'?: number
      concurrency?: { group: string; 'cancel-in-progress': boolean }
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
  const result = Object.values(workflow.jobs)
    .flatMap((entry) => entry.steps ?? [])
    .find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing CI Integrity step: ${name}`)
  return result
}

describe('CI Integrity workflow', () => {
  it('runs the stable trusted check for pull requests and merge groups', () => {
    expect(workflow.on?.workflow_run).toEqual({
      workflows: ['PR Automation Signal'],
      types: ['completed']
    })
    expect(workflow.on).toHaveProperty('merge_group')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job.concurrency).toEqual({
      group:
        "ci-integrity-${{ github.event.merge_group.head_ref || format('{0}-{1}', needs.resolve.outputs.number, github.run_id) }}",
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
        ref: '${{ needs.resolve.outputs.base_sha || github.event.merge_group.base_ref }}'
      }
    })
    expect(step('Setup Node')).toMatchObject({
      uses: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
      with: { 'node-version': 24, cache: 'npm' }
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
        EVENT_NAME: "${{ github.event_name == 'merge_group' && 'merge_group' || 'pull_request' }}",
        PR_TITLE: '${{ needs.resolve.outputs.title || steps.merge_group_title.outputs.title }}',
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

  it('publishes the required check on the inspected head and fails closed after errors', async () => {
    const head = 'a'.repeat(40)
    const create = vi.fn(async () => ({ data: { id: 123 } }))
    const update = vi.fn()
    const github = {
      rest: {
        pulls: {
          get: vi.fn(async () => ({
            data: { state: 'open', title: 'ci(events): migrate signals', head: { sha: head } }
          }))
        },
        checks: { create, update }
      }
    }
    const context = {
      repo: { owner: 'aipoch', repo: 'open-science' },
      serverUrl: 'https://github.com',
      runId: 456,
      payload: {
        repository: { id: 1 },
        workflow_run: {
          repository: { id: 1 },
          event: 'pull_request',
          path: '.github/workflows/pr-automation-signal.yml',
          head_sha: head
        }
      }
    }
    const execute = async (name: string, env: Record<string, string>): Promise<void> => {
      const run = new Function(
        'github',
        'context',
        'core',
        'process',
        `return (async () => {${step(name).with!.script}})()`
      )
      await run(github, context, { setOutput: vi.fn() }, { env })
    }
    await execute('Start PR integrity check', { PR_NUMBER: '42', PR_HEAD_SHA: head })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CI Integrity', head_sha: head, status: 'in_progress' })
    )
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      await execute('Complete PR integrity check', {
        CHECK_ID: '123',
        RESULT: result,
        PR_NUMBER: '42',
        PR_HEAD_SHA: head,
        PR_TITLE: 'ci(events): migrate signals'
      })
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          check_run_id: 123,
          status: 'completed',
          conclusion: result === 'success' ? 'success' : 'failure'
        })
      )
    }
    create.mockClear()
    context.payload.workflow_run.path = '.github/workflows/other.yml'
    await execute('Start PR integrity check', {})
    expect(create).not.toHaveBeenCalled()
    expect(workflow.jobs.check.if).toBe("github.event_name == 'workflow_run'")
  })

  it('isolates preview check names from the dispatch revision required check', () => {
    const preview = load(readFileSync('.github/workflows/pr-automation-preview.yml', 'utf8')) as {
      jobs: { preview: { name: string; uses: string } }
    }
    expect(workflow.on).not.toHaveProperty('workflow_dispatch')
    expect(workflow.on).toHaveProperty('workflow_call')
    expect(preview.jobs.preview).toMatchObject({
      name: 'Preview',
      uses: './.github/workflows/ci-integrity.yml'
    })
    expect(`${preview.jobs.preview.name} / ${job.name}`).not.toBe('CI Integrity')
  })
})

describe('trusted PR signal resolution', () => {
  const resolver = load(
    readFileSync(join(process.cwd(), '.github/workflows/resolve-pr-signal.yml'), 'utf8')
  ) as Workflow
  const script = resolver.jobs.resolve.steps![0].with!.script as string

  it.each([
    'linked',
    'fork',
    'stale-head',
    'wrong-repo',
    'wrong-path',
    'old-attempt',
    'ambiguous-fork'
  ])('resolves only a current, uniquely identified PR: %s', async (scenario) => {
    const head = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const pr = {
      number: 42,
      state: 'open',
      title: 'ci(events): migrate signals',
      created_at: '2026-11-01',
      base: { repo: { id: 1 }, ref: 'main', sha: base },
      head: {
        repo: { id: 2 },
        ref: 'ci/events',
        sha: scenario === 'stale-head' ? 'c'.repeat(40) : head
      }
    }
    const run = {
      id: 100,
      repository: { id: scenario === 'wrong-repo' ? 9 : 1 },
      event: 'pull_request',
      path:
        scenario === 'wrong-path'
          ? '.github/workflows/other.yml'
          : '.github/workflows/pr-automation-signal.yml',
      status: 'completed',
      conclusion: 'success',
      run_attempt: scenario === 'old-attempt' ? 2 : 1,
      display_title: 'PR automation (synchronize)',
      head_sha: head,
      head_branch: 'ci/events',
      head_repository: { id: 2, owner: { login: 'contributor' } },
      created_at: '2026-11-19',
      pull_requests: scenario.includes('fork') ? [] : [pr]
    }
    const jobs = vi.fn()
    const pulls = vi.fn()
    const github = {
      rest: {
        actions: {
          getWorkflowRun: vi.fn(async () => ({ data: run })),
          listJobsForWorkflowRunAttempt: jobs
        },
        pulls: { list: pulls, get: vi.fn(async () => ({ data: pr })) }
      },
      paginate: vi.fn(async (method) =>
        method === jobs
          ? [{ name: 'Signal PR automation', conclusion: 'success' }]
          : scenario === 'ambiguous-fork'
            ? [pr, { ...pr, number: 43 }]
            : [pr]
      )
    }
    const output: Record<string, string> = {}
    const execute = new Function(
      'github',
      'context',
      'core',
      'process',
      `return (async () => {${script}})()`
    )
    await execute(
      github,
      {
        repo: { owner: 'aipoch', repo: 'open-science' },
        payload: { repository: { id: 1, default_branch: 'main' } }
      },
      {
        setOutput: (key: string, value: string) => {
          output[key] = value
        }
      },
      { env: { SIGNAL_RUN_ID: '100', SIGNAL_RUN_ATTEMPT: '1' } }
    )
    expect(output).toEqual(
      ['linked', 'fork'].includes(scenario)
        ? { number: '42', head_sha: head, base_sha: base, action: 'synchronize', title: pr.title }
        : {}
    )
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
  )(
    'schedules full portable registration validation at the scheduled acceptance boundary for $event at $path',
    ({ event, path }) => {
      const changes = [{ path, status: 'modified' }]
      const plan = platformExecutionPlan(classifyChanges(changes), changes, event)
      expect(plan.mode).toBe('full')
      expect(plan.bundles).not.toContain('unit')
      expect(plan.bundles).toContain('static')
    }
  )

  it('protects CI tooling and exempts only registration JSON', () => {
    const entries = readFileSync(join(process.cwd(), '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(entries).toEqual([
      '/packages/test-impact/ @aipoch/ci-maintainers',
      '/.github/CODEOWNERS @aipoch/ci-maintainers',
      '/CODEOWNERS @aipoch/ci-maintainers',
      '/.github/workflows/ @aipoch/ci-maintainers',
      '/.github/actions/ @aipoch/ci-maintainers',
      '/.github/codeql/ @aipoch/ci-maintainers',
      '/.github/dependabot.yml @aipoch/ci-maintainers',
      '/.github/labels.json @aipoch/ci-maintainers',
      '/scripts/ci/ @aipoch/ci-maintainers',
      '/scripts/ci/module-impact.json',
      '/scripts/ci/module-impact/*.json'
    ])
  })
})
