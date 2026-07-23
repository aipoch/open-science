import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

// Behavior tests execute the exact inline github-script blocks shipped by the label lifecycle and
// AI review workflows instead of reimplementing their logic.
type WorkflowJob = { steps: { with?: { script?: string } }[] }
const labelsWorkflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ai-review-labels.yml'), 'utf8')
) as { jobs: Record<string, WorkflowJob> }
const reviewWorkflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8')
) as { jobs: Record<string, WorkflowJob> }

type MockFn = ReturnType<typeof vi.fn>
type MockGithub = {
  rest: {
    pulls: { get: MockFn }
    issues: {
      createLabel: MockFn
      addLabels: MockFn
      removeLabel: MockFn
    }
  }
}
type MockCore = { notice: MockFn; warning: MockFn; setFailed: MockFn }
type Context = { repo: { owner: string; repo: string }; payload: Record<string, unknown> }

function makeGithub({ prHeadSha = 'sha1', labels = [] as string[] } = {}): {
  github: MockGithub
  added: string[][]
  removed: string[]
  created: string[]
} {
  const added: string[][] = []
  const removed: string[] = []
  const created: string[] = []
  const github = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: { head: { sha: prHeadSha } } })) },
      issues: {
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
    }
  }
  return { github, added, removed, created }
}

async function runJob(
  jobId: string,
  context: Context,
  github: MockGithub,
  env: Record<string, string> = {}
): Promise<MockCore> {
  const workflow = jobId === 'apply_review_outcome' ? reviewWorkflow : labelsWorkflow
  const script = workflow.jobs[jobId]?.steps[0].with?.script
  if (!script) throw new Error(`job ${jobId} has no inline script`)
  const core = { notice: vi.fn(), warning: vi.fn(), setFailed: vi.fn() }
  const processStub = { env }
  const run = new Function(
    'github',
    'context',
    'core',
    'process',
    `return (async () => {\n${script}\n})()`
  )
  await run(github, context, core, processStub)
  return core
}

const repo = { owner: 'o', repo: 'r' }

function reviewContext(overrides: Record<string, unknown> = {}): Context {
  return {
    repo,
    payload: overrides
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

const reviewBody = (header: string, verdict: string): string =>
  [header, `**Verdict: ${verdict}**`].join('\n')

function reviewEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PR_NUMBER: '7',
    REVIEW_HEAD_SHA: 'sha1',
    CLAUDE_RESULT: 'success',
    CLAUDE_POST_RESULT: 'success',
    CLAUDE_POSTED: 'true',
    CLAUDE_REVIEW_BODY: reviewBody('## Claude Architecture Review', 'mergeable'),
    CODEX_RESULT: 'skipped',
    CODEX_POST_RESULT: 'skipped',
    CODEX_POSTED: '',
    CODEX_REVIEW_BODY: '',
    ...overrides
  }
}

describe('apply_review_outcome', () => {
  it('labels ready-to-merge when the skipped reviewer is ignored and the rest mergeable', async () => {
    const { github, added, removed } = makeGithub()
    await runJob('apply_review_outcome', reviewContext(), github, reviewEnv())
    expect(added).toEqual([['ready-to-merge']])
    expect(removed).toEqual([])
  })

  it('labels ready-to-merge when every completed reviewer is mergeable', async () => {
    const { github, added, removed } = makeGithub()

    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({
        CODEX_RESULT: 'success',
        CODEX_POST_RESULT: 'success',
        CODEX_POSTED: 'true',
        CODEX_REVIEW_BODY: reviewBody('## Codex Correctness Review', 'mergeable')
      })
    )

    expect(added).toEqual([['ready-to-merge']])
    expect(removed).toEqual([])
  })

  it('fails closed when a reviewer job ran but did not succeed', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ CODEX_RESULT: 'failure' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when a review comment was not posted', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ CLAUDE_POSTED: 'false' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('removes the label when any verdict is needs changes', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({
        CLAUDE_REVIEW_BODY: reviewBody('## Claude Architecture Review', 'needs changes')
      })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when an active reviewer output has no unambiguous verdict', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ CLAUDE_REVIEW_BODY: 'review unavailable' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('does nothing when a newer pull request commit exists', async () => {
    const { github, added, removed } = makeGithub({ prHeadSha: 'newer-sha' })
    await runJob('apply_review_outcome', reviewContext(), github, reviewEnv())
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
