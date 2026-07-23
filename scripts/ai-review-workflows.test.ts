import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ai-review-labels.yml consumes reviewer job names and comment headers produced by ai-review.yml.
// That contract is otherwise invisible: a rename on either side silently disables verdict-based
// labeling, so assert the two workflow files stay in sync.
const reviewWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8')
const labelsWorkflow = readFileSync(
  join(process.cwd(), '.github/workflows/ai-review-labels.yml'),
  'utf8'
)

const jobNames = [...labelsWorkflow.matchAll(/jobName: '([^']+)'/g)].map(([, name]) => name)
const headers = [...labelsWorkflow.matchAll(/header: '([^']+)'/g)].map(([, header]) => header)

type WorkflowStep = {
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  'working-directory'?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

type WorkflowJob = {
  steps: WorkflowStep[]
  concurrency?: { group: string; 'cancel-in-progress': boolean }
}

type Workflow = {
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, WorkflowJob>
}

const parsedWorkflow = load(reviewWorkflow) as Workflow
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function createFixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  fixtureRoots.push(root)
  return root
}

function getRunStep(jobName: string, stepId: string): string {
  const step = parsedWorkflow.jobs[jobName].steps.find(({ id }) => id === stepId)
  if (!step?.run) throw new Error(`Missing run step ${jobName}.${stepId}`)
  return step.run
}

function getNamedStep(jobName: string, stepName: string): WorkflowStep {
  const step = parsedWorkflow.jobs[jobName].steps.find(({ name }) => name === stepName)
  if (!step) throw new Error(`Missing step ${jobName}.${stepName}`)
  return step
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createMergeCommit(
  files: Record<string, string | Buffer>,
  symlinks: Record<string, string> = {}
): string {
  const root = createFixtureRoot('ai-review-context-')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'base')
  git(root, 'checkout', '-b', 'feature')
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
  for (const [path, target] of Object.entries(symlinks)) symlinkSync(target, join(root, path))
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'feature')
  git(root, 'checkout', 'main')
  git(root, 'merge', '--no-ff', 'feature', '-m', 'merge')
  return root
}

function readSimpleOutputs(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2) as [string, string])
  )
}

type ReviewComment = {
  id: number
  body: string | null
  user: { login: string }
}

function runCodexReviewGate(
  existingReviews: number,
  additionalComments: ReviewComment[] = []
): Record<string, string> {
  const root = createFixtureRoot('ai-review-gate-')
  const binDir = join(root, 'bin')
  const githubOutput = join(root, 'github-output')
  mkdirSync(binDir)

  writeExecutable(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "api" ]]
[[ "$2" == "--paginate" ]]
[[ "$3" == "repos/$GH_REPO/issues/349/comments?per_page=100" ]]
[[ "$4" == "--jq" ]]
printf '%s' "$REVIEW_COMMENTS_JSON" | jq -r "$5"
`
  )

  const comments: ReviewComment[] = [
    ...Array.from({ length: existingReviews }, (_, id) => ({
      id,
      body: '<!-- ai-review:codex -->\nreview body',
      user: { login: 'github-actions[bot]' }
    })),
    ...additionalComments
  ]

  const result = spawnSync('bash', ['-c', getRunStep('codex_review_gate', 'gate')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REVIEW_COMMENTS_JSON: JSON.stringify(comments),
      GH_TOKEN: 'test-token',
      GH_REPO: 'aipoch/open-science',
      DISPATCH_PR_NUMBER: '',
      EVENT_PR_NUMBER: '349',
      GITHUB_OUTPUT: githubOutput,
      GITHUB_STEP_SUMMARY: join(root, 'summary')
    }
  })

  if (result.status !== 0) {
    throw new Error(`Codex review gate failed:\n${result.stdout}\n${result.stderr}`)
  }
  return readSimpleOutputs(githubOutput)
}

async function runPostCodexFeedback(
  existingReviews: number,
  currentHeadSha = 'head-sha'
): Promise<string[]> {
  const script = getNamedStep('post_codex_feedback', 'Post Codex correctness review').with?.script
  if (!script) throw new Error('Missing post_codex_feedback script')

  const marker = '<!-- ai-review:codex -->'
  const comments = Array.from({ length: existingReviews }, () => ({
    body: marker,
    user: { login: 'github-actions[bot]' }
  }))
  const postedBodies: string[] = []
  const github = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({ data: { head: { sha: currentHeadSha } } }))
      },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async ({ body }: { body: string }) => postedBodies.push(body))
      }
    },
    paginate: vi.fn(async () => comments)
  }
  const context = { repo: { owner: 'aipoch', repo: 'open-science' } }
  const core = { notice: vi.fn() }
  const processStub = {
    env: {
      CODEX_FINAL_MESSAGE: '## Codex Correctness Review\n**Verdict: mergeable**',
      PR_NUMBER: '349',
      REVIEW_HEAD_SHA: 'head-sha',
      REVIEW_RUN_ID: '1234'
    }
  }
  const run = new Function(
    'github',
    'context',
    'core',
    'process',
    `return (async () => {\n${script}\n})()`
  )
  await run(github, context, core, processStub)
  return postedBodies
}

async function runPostClaudeFeedback(currentHeadSha = 'head-sha'): Promise<string[]> {
  const script = getNamedStep('post_claude_feedback', 'Post Claude architecture review').with
    ?.script
  if (!script) throw new Error('Missing post_claude_feedback script')

  const postedBodies: string[] = []
  const github = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({ data: { head: { sha: currentHeadSha } } }))
      },
      issues: {
        createComment: vi.fn(async ({ body }: { body: string }) => postedBodies.push(body))
      }
    }
  }
  const context = { repo: { owner: 'aipoch', repo: 'open-science' } }
  const core = { notice: vi.fn() }
  const processStub = {
    env: {
      REVIEW_BODY: '## Claude Architecture Review\n**Verdict: mergeable**',
      PR_NUMBER: '349',
      REVIEW_HEAD_SHA: 'head-sha',
      REVIEW_RUN_ID: '1234'
    }
  }
  const run = new Function(
    'github',
    'context',
    'core',
    'process',
    `return (async () => {\n${script}\n})()`
  )
  await run(github, context, core, processStub)
  return postedBodies
}

describe('AI review workflow contract', () => {
  it('is valid YAML', () => {
    expect(() => load(reviewWorkflow)).not.toThrow()
  })

  it('declares at least one reviewer pairing in ai-review-labels.yml', () => {
    expect(jobNames.length).toBeGreaterThan(0)
    expect(headers.length).toBe(jobNames.length)
  })

  it.each(jobNames)('keeps reviewer job name "%s" in ai-review.yml', (jobName) => {
    expect(reviewWorkflow).toContain(`name: ${jobName}`)
  })

  it.each(headers)('keeps comment header "%s" in an ai-review.yml prompt', (header) => {
    expect(reviewWorkflow).toContain(header)
  })

  it('keeps the verdict format consumed by ai-review-labels.yml in the reviewer prompts', () => {
    expect(reviewWorkflow).toContain('**Verdict: mergeable**')
    expect(reviewWorkflow).toContain('**Verdict: needs changes**')
  })

  it('gates both review jobs behind ENABLE_FORK_REVIEW for fork pull requests', () => {
    const gates = reviewWorkflow.match(/vars\.ENABLE_FORK_REVIEW == 'true'/g)
    expect(gates?.length).toBe(2)
  })

  it('externalizes review models to repository variables', () => {
    expect(reviewWorkflow).toContain("vars.CLAUDE_REVIEW_MODEL || 'claude-opus-4-8'")
    expect(reviewWorkflow).toContain("vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol'")
  })

  it('exposes workflow_dispatch inputs for the pull request and selected reviewer', () => {
    expect(reviewWorkflow).toContain('workflow_dispatch:')
    expect(reviewWorkflow).toContain('pull_request_number')
    expect(reviewWorkflow).toMatch(/reviewer:\n\s+description: Reviewer to run/)
    expect(reviewWorkflow).toMatch(/options:\n\s+- both\n\s+- claude\n\s+- codex/)
  })

  it('runs again when a pull request receives new commits', () => {
    expect(reviewWorkflow).toContain('types: [opened, synchronize, reopened]')
  })

  it('lets manual dispatch select either reviewer while bypassing the fork gate', () => {
    const dispatchGuards = reviewWorkflow.match(/github\.event_name == 'workflow_dispatch'/g)
    expect(dispatchGuards?.length).toBe(2)
    expect(reviewWorkflow.match(/inputs\.reviewer == 'both'/g)?.length).toBe(2)
    expect(reviewWorkflow.match(/inputs\.reviewer == 'claude'/g)?.length).toBe(1)
    expect(reviewWorkflow.match(/inputs\.reviewer == 'codex'/g)?.length).toBe(1)
    expect(reviewWorkflow.match(/github\.event_name != 'workflow_dispatch'/g)?.length).toBe(2)
  })

  it('passes --repo to gh pr view so it works before checkout on a clean runner', () => {
    expect(reviewWorkflow).toContain('--repo "${{ github.repository }}"')
  })

  it('runs the Claude agent with zero tools so it cannot read runner secrets', () => {
    const step = getNamedStep('claude_review', 'Run Claude architecture review')
    const args = step.with?.claude_args

    // --tools "" disables ALL built-in tools (not --allowedTools which is just the confirm-free list).
    expect(args).toContain('--tools ""')
    // --safe-mode disables all project customisations (hooks, MCP servers, .claude/settings.json).
    expect(args).toContain('--safe-mode')
    expect(args).toContain('--strict-mcp-config')
    // Must NOT use the old --allowedTools approach which does not actually disable tools.
    expect(reviewWorkflow).not.toContain('--allowedTools')
    expect(reviewWorkflow).toContain('Generate review context')
    expect(reviewWorkflow).toContain('post_claude_feedback')
    expect(args).toContain('--json-schema')
  })

  it('runs Claude with an explicit Opus model and action-compatible output framing', () => {
    const step = getNamedStep('claude_review', 'Run Claude architecture review')
    const args = step.with?.claude_args

    expect(args).toContain('--model "${{ vars.CLAUDE_REVIEW_MODEL || \'claude-opus-4-8\' }}"')
    expect(args).not.toContain('--output-format json')
    expect(step.env).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL')
  })

  it('reads changed file contents via git show (not cat) to prevent symlink traversal', () => {
    expect(reviewWorkflow).toContain('git show "HEAD:${f}"')
    expect(reviewWorkflow).not.toMatch(/^\s+cat "\$f"$/m)
    expect(reviewWorkflow).toContain('binary')
  })

  it('uses a random delimiter for $GITHUB_OUTPUT context', () => {
    expect(reviewWorkflow).toMatch(/head -c 16 \/dev\/urandom/)
  })

  it('skips binary blobs when generating Claude review context', () => {
    const root = createMergeCommit({
      'payload.bin': Buffer.concat([Buffer.from([0]), Buffer.alloc(200_000, 65)])
    })
    const githubOutput = join(root, 'github-output')
    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'context')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status, result.stderr).toBe(0)
    const output = readFileSync(githubOutput)
    expect(output.includes(0)).toBe(false)
    expect(output.toString('utf8')).toContain('### payload.bin (skipped: binary)')
  })

  it('does not follow changed symlinks when generating Claude review context', () => {
    if (process.platform === 'win32') return

    const root = createMergeCommit({}, { 'outside-link': '/etc/hosts' })
    const githubOutput = join(root, 'github-output')
    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'context')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(githubOutput, 'utf8')).toContain('### outside-link (skipped: symlink)')
  })

  it('skips Claude without truncating review context when the size limit is exceeded', () => {
    const contextStep = getNamedStep('claude_review', 'Generate review context')
    const reviewStep = getNamedStep('claude_review', 'Run Claude architecture review')

    expect(contextStep.run).toContain('should_run=false')
    expect(contextStep.run).not.toContain('head -c 393216 review_context_raw.txt')
    expect(reviewStep.if).toBe("${{ steps.context.outputs.should_run == 'true' }}")
  })

  it('runs Codex through the known-good action with the configured Responses endpoint', () => {
    const step = getNamedStep('codex_review', 'Run Codex correctness review')

    expect(step.uses).toBe('openai/codex-action@v1')
    expect(step.with).toMatchObject({
      'openai-api-key': '${{ secrets.OPENAI_API_KEY }}',
      'responses-api-endpoint': '${{ steps.responses_endpoint.outputs.url }}',
      model: "${{ vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol' }}",
      effort: 'high',
      sandbox: 'read-only'
    })
    expect(reviewWorkflow).not.toContain('codex-responses-api-proxy')
    expect(reviewWorkflow).not.toContain('codex exec')
  })

  it('allows the first Codex review for a pull request', () => {
    expect(runCodexReviewGate(0)).toMatchObject({ should_run: 'true', round: '1' })
  })

  it('allows the tenth Codex review for a pull request', () => {
    expect(runCodexReviewGate(9)).toMatchObject({ should_run: 'true', round: '10' })
  })

  it('skips Codex review after ten successful reviews', () => {
    expect(runCodexReviewGate(10)).toMatchObject({ should_run: 'false', round: '11' })
  })

  it('ignores untrusted or unrelated pull request comments when counting reviews', () => {
    const unrelatedComments: ReviewComment[] = [
      {
        id: 100,
        body: '## Codex Correctness Review\n**Verdict: mergeable**',
        user: { login: 'contributor' }
      },
      { id: 101, body: 'ordinary bot comment', user: { login: 'github-actions[bot]' } },
      { id: 102, body: null, user: { login: 'github-actions[bot]' } }
    ]

    expect(runCodexReviewGate(9, unrelatedComments)).toMatchObject({
      should_run: 'true',
      round: '10'
    })
  })

  it('publishes the tenth Codex review with a trusted marker', async () => {
    const [body] = await runPostCodexFeedback(9)

    expect(body).toContain('<!-- ai-review:codex -->')
    expect(body).toContain('<!-- ai-review-meta head=head-sha run=1234 -->')
  })

  it('publishes Claude reviews with trusted run and head provenance', async () => {
    const step = getNamedStep('post_claude_feedback', 'Post Claude architecture review')

    expect(step.env?.REVIEW_HEAD_SHA).toBe('${{ needs.claude_review.outputs.head_sha }}')
    expect(step.env?.REVIEW_RUN_ID).toBe('${{ github.run_id }}')
    await expect(runPostClaudeFeedback()).resolves.toEqual([
      [
        '<!-- ai-review:claude -->',
        '<!-- ai-review-meta head=head-sha run=1234 -->',
        '## Claude Architecture Review',
        '**Verdict: mergeable**'
      ].join('\n')
    ])
  })

  it('does not publish Claude feedback for a stale pull request head', async () => {
    await expect(runPostClaudeFeedback('newer-head-sha')).resolves.toEqual([])
  })

  it('does not publish an eleventh Codex review', async () => {
    await expect(runPostCodexFeedback(10)).resolves.toEqual([])
  })

  it('does not publish or consume a review round for a stale pull request head', async () => {
    await expect(runPostCodexFeedback(9, 'newer-head-sha')).resolves.toEqual([])
  })

  it('serializes the complete review workflow per pull request', () => {
    expect(parsedWorkflow.concurrency).toEqual({
      group:
        'ai-pr-review-${{ github.event.inputs.pull_request_number || github.event.pull_request.number }}',
      'cancel-in-progress': true
    })
  })
})
