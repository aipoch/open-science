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
  name?: string
  run?: string
  'working-directory'?: string
  env?: Record<string, string>
  with?: { script?: string }
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

function runCodexReviewStep(): { captureDir: string; githubOutput: string } {
  const root = createFixtureRoot('ai-review-codex-')
  const binDir = join(root, 'bin')
  const captureDir = join(root, 'capture')
  const codexHome = join(root, 'codex-home')
  const githubOutput = join(root, 'github-output')
  mkdirSync(binDir)
  mkdirSync(captureDir)

  writeExecutable(
    join(binDir, 'codex-responses-api-proxy'),
    `#!/usr/bin/env bash
set -euo pipefail
read -r api_key
[[ "$api_key" == "test-api-key" ]]
[[ -z "\${OPENAI_API_KEY:-}" ]]
while (( $# )); do
  if [[ "$1" == "--server-info" ]]; then
    server_info="$2"
    shift 2
  else
    shift
  fi
done
echo '{"port":43210}' > "$server_info"
`
  )

  writeExecutable(
    join(binDir, 'codex'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$TEST_CAPTURE/args"
printf '%s' "\${OPENAI_API_KEY-unset}" > "$TEST_CAPTURE/openai-api-key"
printf '%s' "\${CODEX_BASE_URL-unset}" > "$TEST_CAPTURE/codex-base-url"
cat > "$TEST_CAPTURE/stdin"
while (( $# )); do
  if [[ "$1" == "-o" ]]; then
    output_file="$2"
    break
  fi
  shift
done
echo 'review result' > "$output_file"
`
  )

  const result = spawnSync('bash', ['-c', getRunStep('codex_review', 'run_codex')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TEST_CAPTURE: captureDir,
      OPENAI_API_KEY: 'test-api-key',
      CODEX_BASE_URL: 'https://example.test/v1/responses',
      CODEX_MODEL: 'test-model',
      CODEX_HOME: codexHome,
      PR_NUMBER: '349',
      PR_BASE_SHA: 'base-sha',
      PR_HEAD_SHA: 'head-sha',
      PR_TITLE: 'ci(review): test workflow',
      PR_BRANCH: 'ci/test-workflow',
      GITHUB_OUTPUT: githubOutput
    }
  })

  if (result.status !== 0) {
    throw new Error(`Codex review step failed:\n${result.stdout}\n${result.stderr}`)
  }
  return { captureDir, githubOutput }
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
    expect(reviewWorkflow).toContain('vars.CLAUDE_REVIEW_MODEL')
    expect(reviewWorkflow).toContain("vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol'")
  })

  it('exposes a workflow_dispatch trigger with a pull request number input', () => {
    expect(reviewWorkflow).toContain('workflow_dispatch:')
    expect(reviewWorkflow).toContain('pull_request_number')
  })

  it('runs again when a pull request receives new commits', () => {
    expect(reviewWorkflow).toContain('types: [opened, synchronize, reopened]')
  })

  it('lets both review jobs run on manual dispatch by bypassing the fork gate', () => {
    const dispatchGuards = reviewWorkflow.match(/github\.event_name == 'workflow_dispatch'/g)
    expect(dispatchGuards?.length).toBe(2)
  })

  it('passes --repo to gh pr view so it works before checkout on a clean runner', () => {
    expect(reviewWorkflow).toContain('--repo "${{ github.repository }}"')
  })

  it('runs the Claude agent with zero tools so it cannot read runner secrets', () => {
    // --tools "" disables ALL built-in tools (not --allowedTools which is just the confirm-free list).
    expect(reviewWorkflow).toContain('--tools ""')
    // --safe-mode disables all project customisations (hooks, MCP servers, .claude/settings.json).
    expect(reviewWorkflow).toContain('--safe-mode')
    expect(reviewWorkflow).toContain('--strict-mcp-config')
    // Must NOT use the old --allowedTools approach which does not actually disable tools.
    expect(reviewWorkflow).not.toContain('--allowedTools')
    expect(reviewWorkflow).toContain('Generate review context')
    expect(reviewWorkflow).toContain('post_claude_feedback')
    expect(reviewWorkflow).toContain('--json-schema')
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

  it('fails closed when review context exceeds the size limit', () => {
    expect(reviewWorkflow).toContain('exit 1')
    expect(reviewWorkflow).not.toContain(
      'head -c 393216 review_context_raw.txt > review_context.txt'
    )
  })

  it('uses codex exec review (built-in) instead of openai/codex-action with prompt injection', () => {
    // codex exec review scopes the diff natively via --base and treats the prompt
    // argument as supplementary instructions, not the entire review framing.
    expect(reviewWorkflow).toContain('codex exec review')
    expect(reviewWorkflow).toContain('--base')
    expect(reviewWorkflow).toContain('CODEX_HOME: ${{ runner.temp }}/codex-home')
    expect(reviewWorkflow).not.toContain('--ignore-user-config')
    expect(reviewWorkflow).not.toContain('openai/codex-action')
  })

  it('pins compatible Codex CLI and proxy versions', () => {
    const step = getNamedStep('codex_review', 'Install Codex CLI and Responses API proxy')

    expect(step.run).toContain('@openai/codex@0.145.0')
    expect(step.run).toContain('@openai/codex-responses-api-proxy@0.145.0')
  })

  it('installs review binaries without reading fork-controlled npm configuration', () => {
    const step = getNamedStep('codex_review', 'Install Codex CLI and Responses API proxy')

    expect(step['working-directory']).toBe('${{ runner.temp }}')
    expect(step.env?.NPM_CONFIG_USERCONFIG).toBe('${{ runner.temp }}/review-npmrc')
    expect(step.run).toContain('--registry=https://registry.npmjs.org/')
    expect(step.run).toContain('--ignore-scripts')
  })

  it('runs codex review with the sandbox option and generated proxy config enabled', () => {
    const { captureDir } = runCodexReviewStep()
    const args = readFileSync(join(captureDir, 'args'), 'utf8').trim().split('\n')

    expect(args.slice(0, 4)).toEqual(['exec', '--sandbox', 'read-only', 'review'])
    expect(args).not.toContain('--ignore-user-config')
  })

  it('does not expose upstream secrets to the codex process', () => {
    const { captureDir } = runCodexReviewStep()

    expect(readFileSync(join(captureDir, 'openai-api-key'), 'utf8')).toBe('unset')
    expect(readFileSync(join(captureDir, 'codex-base-url'), 'utf8')).toBe('unset')
  })

  it('includes the pull request branch in the supplementary review instructions', () => {
    const { captureDir } = runCodexReviewStep()

    expect(readFileSync(join(captureDir, 'stdin'), 'utf8')).toContain(
      'Pull request branch: ci/test-workflow'
    )
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
