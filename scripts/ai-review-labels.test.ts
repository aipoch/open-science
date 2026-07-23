import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

// Behavior tests for the inline github-script blocks in ai-review-labels.yml: each script is
// extracted from the workflow and executed against mocked GitHub APIs, so the tests exercise the
// exact code that ships instead of a reimplementation.
type WorkflowJob = { steps: { with?: { script?: string } }[] }
const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ai-review-labels.yml'), 'utf8')
) as { jobs: Record<string, WorkflowJob> }

type MockJob = { name: string; conclusion: string }
type MockComment = { body: string; created_at: string; user: { login: string } }
type MockFn = ReturnType<typeof vi.fn>
type MockGithub = {
  rest: {
    pulls: { get: MockFn }
    actions: { listJobsForWorkflowRun: MockFn }
    issues: {
      listComments: MockFn
      createLabel: MockFn
      addLabels: MockFn
      removeLabel: MockFn
    }
  }
  paginate: MockFn
}
type MockCore = { notice: MockFn; warning: MockFn; setFailed: MockFn }
type Context = { repo: { owner: string; repo: string }; payload: Record<string, unknown> }

const RUN_STARTED_AT = '2026-01-01T00:00:00Z'
const AFTER_RUN = '2026-01-01T00:05:00Z'
const BEFORE_RUN = '2025-12-31T23:55:00Z'
const BOT = 'github-actions[bot]'

function makeGithub({
  jobs = [] as MockJob[],
  comments = [] as MockComment[],
  prHeadSha = 'sha1',
  labels = [] as string[]
} = {}): { github: MockGithub; added: string[][]; removed: string[]; created: string[] } {
  const added: string[][] = []
  const removed: string[] = []
  const created: string[] = []
  const github = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: { head: { sha: prHeadSha } } })) },
      actions: {
        listJobsForWorkflowRun: vi.fn(async () => ({ data: { jobs } }))
      },
      issues: {
        listComments: vi.fn(),
        // The label always exists in these tests; the workflow tolerates the 422 either way.
        createLabel: vi.fn(async ({ name }: { name: string }) => {
          created.push(name)
          const error = new Error('already exists') as Error & { status: number }
          error.status = 422
          throw error
        }),
        addLabels: vi.fn(async ({ labels: names }: { labels: string[] }) => {
          added.push(names)
        }),
        removeLabel: vi.fn(async ({ name }: { name: string }) => {
          if (!labels.includes(name)) {
            const error = new Error('not found') as Error & { status: number }
            error.status = 404
            throw error
          }
          removed.push(name)
        })
      }
    },
    paginate: vi.fn(async () => comments)
  }
  return { github, added, removed, created }
}

async function runJob(jobId: string, context: Context, github: MockGithub): Promise<MockCore> {
  const script = workflow.jobs[jobId].steps[0].with?.script
  if (!script) throw new Error(`job ${jobId} has no inline script`)
  const core = { notice: vi.fn(), warning: vi.fn(), setFailed: vi.fn() }
  const run = new Function('github', 'context', 'core', `return (async () => {\n${script}\n})()`)
  await run(github, context, core)
  return core
}

const repo = { owner: 'o', repo: 'r' }

function reviewContext(overrides: Record<string, unknown> = {}): Context {
  return {
    repo,
    payload: {
      workflow_run: {
        id: 1,
        head_sha: 'sha1',
        created_at: RUN_STARTED_AT,
        pull_requests: [{ number: 7 }],
        ...overrides
      }
    }
  }
}

function pullRequestContext(overrides: Record<string, unknown> = {}): Context {
  return {
    repo,
    payload: {
      pull_request: {
        number: 7,
        title: 'feat(ai-review): add thing',
        head: { ref: 'feat/ai-review-thing' },
        labels: [],
        ...overrides
      }
    }
  }
}

const verdictComment = (
  header: string,
  verdict: string,
  login = BOT,
  createdAt = AFTER_RUN,
  headSha = 'sha1',
  runId = 1
): MockComment => ({
  body: [
    header.includes('Claude') ? '<!-- ai-review:claude -->' : '<!-- ai-review:codex -->',
    `<!-- ai-review-meta head=${headSha} run=${runId} -->`,
    header,
    `**Verdict: ${verdict}**`
  ].join('\n'),
  created_at: createdAt,
  user: { login }
})

describe('apply_review_outcome', () => {
  const claudeJob: MockJob = { name: 'Claude architecture review', conclusion: 'success' }

  it('labels ready-to-merge when the skipped reviewer is ignored and the rest mergeable', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob, { name: 'Codex correctness review', conclusion: 'skipped' }],
      comments: [verdictComment('## Claude Architecture Review', 'mergeable')]
    })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([['ready-to-merge']])
    expect(removed).toEqual([])
    expect(github.paginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ since: new Date(RUN_STARTED_AT).toISOString() })
    )
  })

  it('labels ready-to-merge when every completed reviewer is mergeable', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob, { name: 'Codex correctness review', conclusion: 'success' }],
      comments: [
        verdictComment('## Claude Architecture Review', 'mergeable'),
        verdictComment('## Codex Correctness Review', 'mergeable')
      ]
    })

    await runJob('apply_review_outcome', reviewContext(), github)

    expect(added).toEqual([['ready-to-merge']])
    expect(removed).toEqual([])
  })

  it('uses the associated PR head for pull_request_target workflow runs', async () => {
    const { github, added } = makeGithub({
      jobs: [{ name: 'Codex correctness review', conclusion: 'success' }],
      comments: [
        verdictComment('## Codex Correctness Review', 'mergeable', BOT, AFTER_RUN, 'pr-head-sha')
      ],
      prHeadSha: 'pr-head-sha'
    })
    await runJob(
      'apply_review_outcome',
      reviewContext({
        event: 'pull_request_target',
        head_sha: 'base-sha',
        pull_requests: [{ number: 7, head: { sha: 'pr-head-sha' } }]
      }),
      github
    )

    expect(added).toEqual([['ready-to-merge']])
  })

  it('ignores a late comment from an older workflow run', async () => {
    const { github, added } = makeGithub({
      jobs: [{ name: 'Codex correctness review', conclusion: 'success' }],
      comments: [
        {
          body: [
            '<!-- ai-review:codex -->',
            '<!-- ai-review-meta head=old-head run=1 -->',
            '## Codex Correctness Review',
            '**Verdict: mergeable**'
          ].join('\n'),
          created_at: AFTER_RUN,
          user: { login: BOT }
        }
      ],
      prHeadSha: 'new-head'
    })
    await runJob(
      'apply_review_outcome',
      reviewContext({
        id: 2,
        event: 'pull_request_target',
        head_sha: 'base-sha',
        pull_requests: [{ number: 7, head: { sha: 'new-head' } }]
      }),
      github
    )

    expect(added).toEqual([])
  })

  it('requires the verdict comment to come from the completed workflow run', async () => {
    const { github, added } = makeGithub({
      jobs: [{ name: 'Codex correctness review', conclusion: 'success' }],
      comments: [
        verdictComment('## Codex Correctness Review', 'mergeable', BOT, AFTER_RUN, 'sha1', 1)
      ]
    })

    await runJob('apply_review_outcome', reviewContext({ id: 2 }), github)

    expect(added).toEqual([])
  })

  it('fails closed when a reviewer job ran but did not succeed', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob, { name: 'Codex correctness review', conclusion: 'failure' }],
      comments: [verdictComment('## Claude Architecture Review', 'mergeable')],
      labels: ['ready-to-merge']
    })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('removes the label when any verdict is needs changes', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob],
      comments: [verdictComment('## Claude Architecture Review', 'needs changes')],
      labels: ['ready-to-merge']
    })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('ignores a forged verdict comment from a non-bot author and fails closed', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob],
      comments: [verdictComment('## Claude Architecture Review', 'mergeable', 'contributor')],
      labels: ['ready-to-merge']
    })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('ignores verdict comments posted before the run started and fails closed', async () => {
    const { github, added, removed } = makeGithub({
      jobs: [claudeJob],
      comments: [verdictComment('## Claude Architecture Review', 'mergeable', BOT, BEFORE_RUN)],
      labels: ['ready-to-merge']
    })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('does nothing when a newer pull request commit exists', async () => {
    const { github, added, removed } = makeGithub({ prHeadSha: 'newer-sha' })
    await runJob('apply_review_outcome', reviewContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })
})

describe('apply_type_labels', () => {
  it('maps the conventional type from the title to the built-in label', async () => {
    const { github, added, removed } = makeGithub()
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([['enhancement']])
    expect(removed).toEqual([])
  })

  it('falls back to the branch name when the title is not conventional', async () => {
    const { github, added } = makeGithub()
    await runJob(
      'apply_type_labels',
      pullRequestContext({ title: 'Improve the docs', head: { ref: 'docs/readme-update' } }),
      github
    )
    expect(added).toEqual([['documentation']])
  })

  it('removes the stale managed label when the pull request type changes', async () => {
    const { github, added, removed } = makeGithub({ labels: ['enhancement'] })
    await runJob(
      'apply_type_labels',
      pullRequestContext({ title: 'fix(notebook): stop crash', labels: [{ name: 'enhancement' }] }),
      github
    )
    expect(removed).toEqual(['enhancement'])
    expect(added).toEqual([['bug']])
  })

  it('drops managed labels when the type has no mapping but keeps unmanaged ones', async () => {
    const { github, added, removed } = makeGithub({ labels: ['bug', 'duplicate'] })
    await runJob(
      'apply_type_labels',
      pullRequestContext({
        title: 'ci(review): tweak workflow',
        labels: [{ name: 'bug' }, { name: 'duplicate' }]
      }),
      github
    )
    expect(removed).toEqual(['bug'])
    expect(added).toEqual([])
  })
})

describe('reset_review_labels', () => {
  it('removes stale outcome labels and tolerates missing ones', async () => {
    const { github, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob('reset_review_labels', pullRequestContext(), github)
    expect(removed).toEqual(['ready-to-merge'])
  })
})
