import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Contract and behavior tests for ai-review.yml. Inline github-script blocks are executed directly
// so the tests exercise the code that ships instead of a reimplementation.
const reviewWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8')

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
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'timeout-minutes'?: number
  concurrency?: { group: string; 'cancel-in-progress': boolean }
}

type Workflow = {
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, WorkflowJob>
}

const parsedWorkflow = load(reviewWorkflow) as Workflow
const fixtureRoots: string[] = []
const claudeReviewTools = ['Agent', 'Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput']

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

function writeJsonLines(path: string, events: unknown[]): void {
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

function claudeFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    priority: 'P1',
    title: 'Runtime ownership can drift',
    path: 'src/main/acp/runtime.ts',
    line: 100,
    impact: 'A session can use the wrong runtime.',
    recommendation: 'Validate ownership before sending.',
    ...overrides
  }
}

function claudeStructuredOutput(
  findings: Record<string, unknown>[] = [],
  verdict = findings.length > 0 ? 'needs changes' : 'mergeable'
): Record<string, unknown> {
  return {
    verdict,
    summary: findings.length > 0 ? 'Architecture changes are required.' : 'No issues found.',
    findings
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createMergeCommit(
  files: Record<string, string | Buffer>,
  baseFiles: Record<string, string | Buffer> = {}
): string {
  const root = createFixtureRoot('ai-review-context-')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'README.md'), 'base\n')
  for (const [path, contents] of Object.entries(baseFiles))
    writeFileSync(join(root, path), contents)
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  git(root, 'checkout', '-b', 'feature')
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
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
  additionalComments: ReviewComment[] = [],
  maxReviews = '20'
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
      PR_NUMBER: '349',
      CODEX_REVIEW_MAX_ROUNDS: maxReviews,
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
  currentHeadSha = 'head-sha',
  maxReviews = '20'
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
  const core = { notice: vi.fn(), setOutput: vi.fn() }
  const processStub = {
    env: {
      CODEX_REVIEW_BODY:
        '## Codex Correctness Review\n**Verdict: mergeable**\n\n**No actionable findings.**',
      PR_NUMBER: '349',
      REVIEW_HEAD_SHA: 'head-sha',
      REVIEW_RUN_ID: '1234',
      CODEX_REVIEW_MAX_ROUNDS: maxReviews
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
  const core = { notice: vi.fn(), setOutput: vi.fn() }
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

async function normalizeCodexReview(rawReview: string): Promise<string> {
  const script = getNamedStep('codex_review', 'Normalize Codex review').with?.script
  if (!script) throw new Error('Missing Codex review normalization script')

  let reviewBody = ''
  const core = {
    setOutput: vi.fn((name: string, value: string) => {
      if (name === 'review_body') reviewBody = value
    })
  }
  const processStub = { env: { CODEX_FINAL_MESSAGE: rawReview } }
  const run = new Function('core', 'process', `return (async () => {\n${script}\n})()`)
  await run(core, processStub)
  return reviewBody
}

describe('AI review workflow contract', () => {
  it('is valid YAML', () => {
    expect(() => load(reviewWorkflow)).not.toThrow()
  })

  it('keeps the verdict format consumed by the outcome job in both normalizers', () => {
    expect(getRunStep('claude_review', 'extract_claude')).toContain(
      '"**Verdict: \\(.verdict)**\\n\\n"'
    )
    expect(getNamedStep('codex_review', 'Normalize Codex review').with?.script).toContain(
      '`**Verdict: ${result.verdict}**`'
    )
  })

  it('applies labels only after both reviewer publish jobs have settled', () => {
    const outcome = parsedWorkflow.jobs.apply_review_outcome
    const step = getNamedStep(
      'apply_review_outcome',
      'Apply ready-to-merge from published review outputs'
    )

    expect(outcome.if).toContain('always()')
    expect(outcome.needs).toEqual([
      'review_target',
      'claude_review',
      'post_claude_feedback',
      'codex_review',
      'post_codex_feedback'
    ])
    expect(step.env).toMatchObject({
      CLAUDE_POSTED: '${{ needs.post_claude_feedback.outputs.posted }}',
      CODEX_POSTED: '${{ needs.post_codex_feedback.outputs.posted }}'
    })
    expect(parsedWorkflow.jobs.post_claude_feedback.outputs?.posted).toBe(
      '${{ steps.post.outputs.posted }}'
    )
    expect(parsedWorkflow.jobs.post_codex_feedback.outputs?.posted).toBe(
      '${{ steps.post.outputs.posted }}'
    )
  })

  it('retries transient GitHub API failures while publishing reviews and labels', () => {
    const steps = [
      getNamedStep('post_claude_feedback', 'Post Claude architecture review'),
      getNamedStep('post_codex_feedback', 'Post Codex correctness review'),
      getNamedStep('apply_review_outcome', 'Apply ready-to-merge from published review outputs')
    ]

    for (const step of steps) expect(step.with?.retries).toBe(3)
  })

  it('supports disabled, manual, and automatic fork review modes', () => {
    const targetStep = getNamedStep('review_target', 'Resolve pull request metadata')

    expect(targetStep.env?.FORK_REVIEW_MODE).toBe("${{ vars.FORK_REVIEW_MODE || 'manual' }}")
    expect(targetStep.run).toContain('disabled|manual|automatic')
    expect(targetStep.run).toContain('isCrossRepository')
    expect(parsedWorkflow.jobs.claude_review.if).toContain(
      "needs.review_target.outputs.fork_mode == 'automatic'"
    )
    expect(parsedWorkflow.jobs.codex_review_gate.if).toContain(
      "needs.review_target.outputs.fork_mode != 'disabled'"
    )
  })

  it('externalizes review models to repository variables', () => {
    expect(reviewWorkflow).toContain("vars.CLAUDE_REVIEW_MODEL || 'claude-sonnet-5'")
    expect(reviewWorkflow).toContain("vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol'")
  })

  it('exposes workflow_dispatch inputs for the pull request and selected reviewer', () => {
    expect(reviewWorkflow).toContain('workflow_dispatch:')
    expect(reviewWorkflow).toContain('pull_request_number')
    expect(reviewWorkflow).toContain('enable_codegraph')
    expect(reviewWorkflow).toMatch(/reviewer:\n\s+description: Reviewer to run/)
    expect(reviewWorkflow).toMatch(/options:\n\s+- both\n\s+- claude\n\s+- codex/)
  })

  it('runs again when a pull request receives new commits', () => {
    expect(reviewWorkflow).toContain('types: [opened, synchronize, reopened]')
  })

  it('lets manual dispatch select either reviewer subject to the configured fork mode', () => {
    const dispatchGuards = reviewWorkflow.match(/github\.event_name == 'workflow_dispatch'/g)
    expect(dispatchGuards?.length).toBeGreaterThanOrEqual(3)
    expect(reviewWorkflow.match(/github\.event\.inputs\.reviewer == 'both'/g)?.length).toBe(2)
    expect(reviewWorkflow.match(/github\.event\.inputs\.reviewer == 'claude'/g)?.length).toBe(1)
    expect(reviewWorkflow.match(/github\.event\.inputs\.reviewer == 'codex'/g)?.length).toBe(1)
    expect(reviewWorkflow).toContain("needs.review_target.outputs.fork_mode != 'disabled'")
  })

  it('keeps pull_request_target checkout on the GitHub merge ref', () => {
    const expectedRef =
      "${{ github.event_name == 'pull_request_target' && format('refs/pull/{0}/merge', needs.review_target.outputs.number) || needs.review_target.outputs.review_sha }}"
    for (const job of ['claude_review', 'codex_review']) {
      expect(getNamedStep(job, 'Checkout pull request review commit').with?.ref).toBe(expectedRef)
      expect(getNamedStep(job, 'Resolve review comparison base').run).toContain(
        'git rev-parse HEAD^1'
      )
    }
  })

  it('passes --repo to gh pr view so it works before checkout on a clean runner', () => {
    expect(reviewWorkflow).toContain('--repo "${{ github.repository }}"')
  })

  it('lets Claude use Bash only through its built-in read-only command classifier', () => {
    const step = getNamedStep('claude_review', 'Run Claude architecture review')
    const command = step.run

    expect(command).toContain("tools='Read,Glob,Grep,Bash,Agent'")
    expect(command).toContain('--tools "$tools"')
    expect(command).toContain('--effort "$CLAUDE_REVIEW_EFFORT"')
    expect(step.env?.CLAUDE_REVIEW_EFFORT).toBe("${{ vars.CLAUDE_REVIEW_EFFORT || 'high' }}")
    expect(command).toContain('--permission-mode dontAsk')
    expect(command).toContain("allowed_tools='Read,Glob,Grep,Agent'")
    expect(command).toContain('--allowedTools "$allowed_tools"')
    expect(command).not.toContain('--permission-mode bypassPermissions')
    expect(command).not.toContain('--max-turns')
    expect(parsedWorkflow.jobs.claude_review['timeout-minutes']).toBe(30)
    expect(command).toContain('--setting-sources ""')
    expect(command).toContain('--settings "$CLAUDE_SETTINGS_FILE"')
    expect(command).toContain('--agents "$CLAUDE_REVIEW_AGENTS"')
    expect(command).toContain('--disable-slash-commands')
    expect(step.env).toMatchObject({
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1'
    })
    expect(command).not.toContain('--safe-mode')
    expect(command).toContain('--strict-mcp-config')
    expect(command).not.toMatch(/--allowedTools[^\n]*Bash/)
    expect(reviewWorkflow).toContain('Build Claude review prompt')
    expect(reviewWorkflow).toContain('post_claude_feedback')
  })

  it('bounds Claude subagent parallelism and records lifecycle hooks', () => {
    const runtimeStep = getNamedStep('claude_review', 'Build Claude runtime configuration')
    const reviewStep = getNamedStep('claude_review', 'Run Claude architecture review')
    const telemetryStep = getNamedStep('claude_review', 'Report Claude review telemetry')

    expect(reviewStep.env).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: '2',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1'
    })
    expect(runtimeStep.run).toContain('SessionStart')
    expect(runtimeStep.run).toContain('PostToolUse')
    expect(runtimeStep.run).toContain('SubagentStart')
    expect(runtimeStep.run).toContain('SubagentStop')
    expect(runtimeStep.run).toContain('SessionEnd')
    expect(runtimeStep.env).toMatchObject({
      SUBAGENT_EFFORT: "${{ vars.CLAUDE_REVIEW_SUBAGENT_EFFORT || 'medium' }}",
      SUBAGENT_MAX_TURNS: "${{ vars.CLAUDE_REVIEW_SUBAGENT_MAX_TURNS || '8' }}"
    })
    expect(runtimeStep.run).toContain('effort: $effort')
    expect(runtimeStep.run).toContain('maxTurns: $max_turns')
    expect(telemetryStep.if).toBe('${{ always() }}')
    expect(telemetryStep.run).toContain('Claude model turns')
    expect(telemetryStep.run).toContain('cache_read_input_tokens')
    expect(telemetryStep.run).toContain('Claude init MCP servers')
    expect(telemetryStep.run).toContain('GITHUB_STEP_SUMMARY')
  })

  it('keeps CodeGraph opt-in and supplies it through a trusted MCP config', () => {
    const installStep = getNamedStep('claude_review', 'Install CodeGraph')
    const indexStep = getNamedStep('claude_review', 'Build CodeGraph index')
    const runtimeStep = getNamedStep('claude_review', 'Build Claude runtime configuration')
    const reviewStep = getNamedStep('claude_review', 'Run Claude architecture review')

    expect(installStep.if).toContain("github.event.inputs.enable_codegraph == 'true'")
    expect(installStep.if).toContain("vars.ENABLE_CLAUDE_CODEGRAPH == 'true'")
    expect(installStep.run).toContain('@colbymchenry/codegraph@1.5.0')
    expect(installStep.run).not.toContain('codegraph install')
    expect(indexStep.if).toContain("github.event.inputs.enable_codegraph == 'true'")
    expect(indexStep.env?.CODEGRAPH_TELEMETRY).toBe('0')
    expect(indexStep.run).toContain('codegraph init')
    expect(runtimeStep.run).toContain('args: ["serve", "--mcp"]')
    expect(reviewStep.run).toContain('--mcp-config "$CLAUDE_MCP_CONFIG_FILE"')
  })

  it('streams Codex JSON events so turn usage is visible in the action log', () => {
    const argsStep = getNamedStep('codex_review', 'Build Codex review arguments')
    expect(argsStep.run).toContain('"--json"')
  })

  it('reports Claude per-turn usage and hook lifecycle counts', () => {
    const root = createFixtureRoot('ai-review-claude-telemetry-')
    const executionFile = join(root, 'execution.jsonl')
    const hookLog = join(root, 'hooks.jsonl')
    const summary = join(root, 'summary.md')
    writeJsonLines(executionFile, [
      {
        type: 'assistant',
        message: {
          id: 'turn-1',
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
            output_tokens: 30
          }
        }
      },
      // Streamed content can repeat a message id; telemetry must count that model turn once.
      {
        type: 'assistant',
        message: {
          id: 'turn-1',
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
            output_tokens: 30
          }
        }
      },
      {
        type: 'assistant',
        message: {
          id: 'turn-2',
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 0,
            output_tokens: 40
          }
        }
      },
      {
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        duration_api_ms: 1234,
        total_cost_usd: 0.42
      }
    ])
    writeJsonLines(hookLog, [
      { hook_event_name: 'SubagentStart' },
      { hook_event_name: 'PostToolUse' },
      { hook_event_name: 'PostToolUse' },
      { hook_event_name: 'SubagentStop' }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'claude_telemetry')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXECUTION_FILE: executionFile,
        HOOK_LOG: hookLog,
        DURATION_SECONDS: '3',
        GITHUB_STEP_SUMMARY: summary
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Claude model turns: reported=2, observed=2')
    expect(result.stdout).toContain('1  claude-sonnet-5  10  100  20  30')
    expect(result.stdout).toContain('PostToolUse: 2')
    const summaryText = readFileSync(summary, 'utf8')
    expect(summaryText).toContain('| 2 | claude-sonnet-5 | 5 | 200 | 0 | 40 |')
    expect(summaryText).toContain('- `SubagentStart`: 1')
  })

  it('keeps both reviewers on static code inspection instead of running project checks', () => {
    const claudePrompt = getRunStep('claude_review', 'context')
    const codexStep = getNamedStep('codex_review', 'Run Codex correctness review')
    const prohibitedChecks = ['install dependencies', 'lint', 'tests', 'typecheck', 'build']

    for (const check of prohibitedChecks) {
      expect(claudePrompt).toContain(check)
      expect(codexStep.with?.prompt).toContain(check)
    }
  })

  it('runs Claude with an explicit Sonnet model and endpoint-compatible output framing', () => {
    const step = getNamedStep('claude_review', 'Run Claude architecture review')
    const installStep = getNamedStep('claude_review', 'Install Claude CLI')

    expect(installStep.run).toContain('@anthropic-ai/claude-code@2.1.218')
    expect(installStep.run).not.toContain('--ignore-scripts')
    expect(step.env?.CLAUDE_MODEL).toBe("${{ vars.CLAUDE_REVIEW_MODEL || 'claude-sonnet-5' }}")
    expect(step.env?.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_AUTH_TOKEN }}')
    expect(step.run).toContain('--output-format stream-json')
    expect(step.run).toContain('Claude CLI failed: subtype=')
    expect(step.run).toContain('--json-schema "$CLAUDE_REVIEW_SCHEMA"')
    expect(step.env).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL')
  })

  it('extracts a valid review when Claude exits nonzero after producing structured output', () => {
    const root = createFixtureRoot('ai-review-claude-blocking-limit-')
    const binDir = join(root, 'bin')
    const promptFile = join(root, 'prompt.md')
    const runOutput = join(root, 'run-output')
    const extractOutput = join(root, 'extract-output')
    mkdirSync(binDir)
    writeFileSync(promptFile, 'Review this pull request.\n')
    writeExecutable(
      join(binDir, 'claude'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"type":"system","subtype":"init","tools":["Agent","Bash","Glob","Grep","Read","StructuredOutput"]}'
printf '%s\\n' '{"type":"result","subtype":"success","terminal_reason":"blocking_limit","structured_output":{"verdict":"mergeable","summary":"No issues found.","findings":[]}}'
exit 1
`
    )

    const runResult = spawnSync('bash', ['-c', getRunStep('claude_review', 'run_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        CLAUDE_PROMPT_FILE: promptFile,
        CLAUDE_MODEL: 'claude-sonnet-5',
        CLAUDE_REVIEW_EFFORT: 'high',
        CLAUDE_REVIEW_SCHEMA: '{}',
        CLAUDE_SETTINGS_FILE: join(root, 'settings.json'),
        CLAUDE_MCP_CONFIG_FILE: join(root, 'mcp.json'),
        CLAUDE_REVIEW_AGENTS: '{}',
        CLAUDE_HOOK_LOG: join(root, 'hooks.jsonl'),
        CODEGRAPH_ENABLED: 'false',
        GITHUB_OUTPUT: runOutput
      }
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    const executionFile = readSimpleOutputs(runOutput).execution_file
    const extractResult = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXECUTION_FILE: executionFile,
        GITHUB_OUTPUT: extractOutput
      }
    })

    expect(extractResult.status, extractResult.stderr).toBe(0)
    expect(readFileSync(extractOutput, 'utf8')).toContain('**Verdict: mergeable**')
  })

  it('allows Codex non-write actors only for explicitly automatic fork reviews', () => {
    const codexStep = getNamedStep('codex_review', 'Run Codex correctness review')
    const automaticForkExpression =
      "${{ needs.review_target.outputs.is_fork == 'true' && needs.review_target.outputs.fork_mode == 'automatic' && '*' || '' }}"

    expect(codexStep.with?.['allow-users']).toBe(automaticForkExpression)
  })

  it('fails closed when Claude emits assistant text without structured output', () => {
    const root = createFixtureRoot('ai-review-claude-output-')
    const executionFile = join(root, 'execution.json')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/main/acp/runtime.ts' } },
            { type: 'text', text: 'draft' }
          ]
        }
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '## Claude Architecture Review' },
            { type: 'text', text: '**Verdict: mergeable**' }
          ]
        }
      },
      { type: 'result', subtype: 'success' }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no structured review')
  })

  it('fails closed when Claude emits only an unstructured result event', () => {
    const root = createFixtureRoot('ai-review-claude-result-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'StructuredOutput', input: { review: 'submitted' } }]
        }
      },
      {
        type: 'result',
        subtype: 'success',
        result:
          '<thinking>private reasoning\n' +
          '<review>## Claude Architecture Review\n**Verdict: mergeable**</review>\n' +
          'that must not be published</thinking>'
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no structured review')
  })

  it('prefers schema-validated review output over free-form reasoning', () => {
    const root = createFixtureRoot('ai-review-claude-structured-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'result',
        subtype: 'success',
        result: '<thinking>private reasoning</thinking>',
        structured_output: claudeStructuredOutput()
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status, result.stderr).toBe(0)
    const output = readFileSync(githubOutput, 'utf8')
    expect(output).not.toContain('private reasoning')
    expect(output).toContain('## Claude Architecture Review\n\n**Verdict: mergeable**')
  })

  it('allows structured findings to quote review framing tags', () => {
    const root = createFixtureRoot('ai-review-claude-literal-tags-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'result',
        subtype: 'success',
        structured_output: claudeStructuredOutput([
          claudeFinding({
            title: 'Do not reject literal <review> and </review> tags in findings'
          })
        ])
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(githubOutput, 'utf8')).toContain('literal <review> and </review> tags')
  })

  it('rejects a mergeable Claude verdict that contains an actionable finding', () => {
    const root = createFixtureRoot('ai-review-claude-contradictory-verdict-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'result',
        subtype: 'success',
        structured_output: claudeStructuredOutput([claudeFinding()], 'mergeable')
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status).not.toBe(0)
  })

  it('keeps a structured review after Claude attempts an unavailable tool', () => {
    const root = createFixtureRoot('ai-review-claude-tool-use-')
    const executionFile = join(root, 'execution.json')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: 'changed.txt' } },
            { type: 'text', text: 'The unavailable tool call was rejected by Claude Code.' }
          ]
        }
      },
      {
        type: 'result',
        subtype: 'success',
        structured_output: claudeStructuredOutput()
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(githubOutput, 'utf8')).toContain('**Verdict: mergeable**')
  })

  it('fails closed if Claude advertises tools outside the review tool set', () => {
    const root = createFixtureRoot('ai-review-claude-tools-available-')
    const executionFile = join(root, 'execution.json')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: [...claudeReviewTools, 'Write'] },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '## Claude Architecture Review' }] }
      }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EXECUTION_FILE: executionFile, GITHUB_OUTPUT: githubOutput }
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exposed an unexpected tool set')
  })

  it('allows a configured CodeGraph MCP server to defer its tool until use', () => {
    const root = createFixtureRoot('ai-review-claude-deferred-mcp-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      { type: 'system', subtype: 'init', tools: claudeReviewTools, mcp_servers: ['codegraph'] },
      { type: 'result', subtype: 'success', structured_output: claudeStructuredOutput() }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXECUTION_FILE: executionFile,
        CODEGRAPH_ENABLED: 'true',
        GITHUB_OUTPUT: githubOutput
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(githubOutput, 'utf8')).toContain('**Verdict: mergeable**')
  })

  it('accepts the Task alias reported for Claude subagents', () => {
    const root = createFixtureRoot('ai-review-claude-task-tool-')
    const executionFile = join(root, 'execution.jsonl')
    const githubOutput = join(root, 'github-output')
    writeJsonLines(executionFile, [
      {
        type: 'system',
        subtype: 'init',
        tools: [
          'Task',
          'Bash',
          'Glob',
          'Grep',
          'Read',
          'StructuredOutput',
          'mcp__codegraph__codegraph_explore'
        ]
      },
      { type: 'result', subtype: 'success', structured_output: claudeStructuredOutput() }
    ])

    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'extract_claude')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXECUTION_FILE: executionFile,
        CODEGRAPH_ENABLED: 'true',
        GITHUB_OUTPUT: githubOutput
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(githubOutput, 'utf8')).toContain('**Verdict: mergeable**')
  })

  it('feeds a short task prompt through stdin instead of injecting pull request code', () => {
    const contextStep = getNamedStep('claude_review', 'Build Claude review prompt')
    const reviewStep = getNamedStep('claude_review', 'Run Claude architecture review')

    expect(contextStep.run).toContain('prompt_file="$RUNNER_TEMP/claude-review-prompt.md"')
    expect(contextStep.env?.PR_DIFF_BASE).toBe('${{ steps.diff_base.outputs.sha }}')
    expect(contextStep.run).toContain('git diff --stat %s HEAD')
    expect(contextStep.run).not.toMatch(/^\s+git diff /m)
    expect(reviewStep.run).toContain('< "$CLAUDE_PROMPT_FILE"')
    expect(reviewWorkflow).not.toContain('steps.context.outputs.content')
    expect(reviewWorkflow).not.toContain('anthropics/claude-code-action')
  })

  it('keeps the Claude prompt small when the pull request changes a large file', () => {
    const baseContents = Array.from(
      { length: 20_000 },
      (_, index) => `export const value${index} = ${index}\n`
    ).join('')
    const changedContents = baseContents.replace(
      'export const value10000 = 10000',
      'export const value10000 = 10001'
    )
    const root = createMergeCommit({ 'large.ts': changedContents }, { 'large.ts': baseContents })
    const githubOutput = join(root, 'github-output')
    const result = spawnSync('bash', ['-c', getRunStep('claude_review', 'context')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        PR_NUMBER: '376',
        PR_DIFF_BASE: 'base-sha',
        REPOSITORY: 'aipoch/open-science',
        GITHUB_OUTPUT: githubOutput
      }
    })

    expect(result.status, result.stderr).toBe(0)
    const prompt = readFileSync(join(root, 'claude-review-prompt.md'), 'utf8')
    expect(prompt).not.toContain('export const value10000 = 10001')
    expect(prompt).toContain('git diff --stat base-sha HEAD')
    expect(Buffer.byteLength(prompt)).toBeLessThan(8_192)
    expect(getNamedStep('claude_review', 'Install Claude CLI').if).toBeUndefined()
    expect(getNamedStep('claude_review', 'Run Claude architecture review').if).toBeUndefined()
  })

  it('runs structured Codex exec through the action proxy and read-only permission profile', () => {
    const step = getNamedStep('codex_review', 'Run Codex correctness review')

    expect(parsedWorkflow.jobs.codex_review['timeout-minutes']).toBe(30)
    expect(step.uses).toBe('openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56')
    expect(step.with).toMatchObject({
      'openai-api-key': '${{ secrets.OPENAI_API_KEY }}',
      'responses-api-endpoint': '${{ steps.responses_endpoint.outputs.url }}',
      model: "${{ vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol' }}",
      effort: "${{ vars.CODEX_REVIEW_EFFORT || 'high' }}",
      'permission-profile': ':read-only',
      'codex-args': '${{ steps.codex_args.outputs.value }}',
      'output-schema-file': '${{ steps.codex_args.outputs.schema_file }}'
    })
    expect(step.with).not.toHaveProperty('sandbox')
    expect(step.with?.prompt).toContain('Return the review through the required JSON schema')
    expect(reviewWorkflow).not.toContain('codex-responses-api-proxy')
  })

  it('builds a generic structured codex exec invocation', () => {
    const root = createFixtureRoot('ai-review-codex-args-')
    const githubOutput = join(root, 'github-output')
    const result = spawnSync('bash', ['-c', getRunStep('codex_review', 'codex_args')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        PR_BRANCH: 'ci/reviewer-dispatch-selector',
        PR_TITLE: 'ci(review): allow selecting a dispatched reviewer',
        GITHUB_OUTPUT: githubOutput
      }
    })

    expect(result.status, result.stderr).toBe(0)
    const outputLines = readFileSync(githubOutput, 'utf8').trim().split('\n')
    const args = JSON.parse(outputLines[0]!.slice('value='.length)) as string[]
    expect(args).not.toContain('review')
    expect(args).not.toContain('--base')
    expect(args).not.toContain('--output-schema')
    expect(args).not.toContain('--title')
    expect(args).not.toContain('-')
    // codex-action writes its proxy route to the isolated CODEX_HOME config.
    expect(args).not.toContain('--ignore-user-config')
    const schemaFile = outputLines[1]!.slice('schema_file='.length)
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(['verdict', 'summary', 'findings'])
    expect(schema.properties).toHaveProperty('findings')
    const instructions = args.find((arg) => arg.startsWith('developer_instructions='))
    expect(instructions).toContain('Branch name valid: true')
    expect(instructions).toContain('Pull request title valid: true')
    expect(instructions).not.toContain('ci/reviewer-dispatch-selector')
    expect(instructions).not.toContain('allow selecting a dispatched reviewer')
  })

  it('formats a schema-validated Codex approval with an explicit no-findings verdict', async () => {
    const review = await normalizeCodexReview(
      JSON.stringify({
        verdict: 'mergeable',
        summary: 'The reconnect behavior is safe and the updated tests cover the failure paths.',
        findings: []
      })
    )

    expect(review).toContain('## Codex Correctness Review')
    expect(review).toContain('**Verdict: mergeable**')
    expect(review).toContain('**No actionable findings.**')
    expect(review).toContain('The reconnect behavior is safe')
  })

  it('formats schema-validated Codex findings as a needs-changes verdict', async () => {
    const review = await normalizeCodexReview(
      JSON.stringify({
        verdict: 'needs changes',
        summary: 'The reconnect path has a race.',
        findings: [
          {
            priority: 'P1',
            title: 'Reconnect can race with teardown',
            path: 'src/main/acp/runtime.ts',
            line: 100,
            impact: 'A new session can use a stale provider.',
            recommendation: 'Wait for teardown before publishing the connection.'
          }
        ]
      })
    )

    expect(review).toContain('**Verdict: needs changes**')
    expect(review).toContain('[P1] Reconnect can race with teardown')
    expect(review).toContain('**src/main/acp/runtime.ts:100**')
  })

  it('fails closed when Codex ignores the required JSON schema', async () => {
    await expect(normalizeCodexReview('**[P1] Reconnect can race with teardown**')).rejects.toThrow(
      'valid JSON'
    )
  })

  it('fails closed on the partial JSON finding shape from the review regression', async () => {
    await expect(
      normalizeCodexReview('{"title":"[P1] Reconnect can race with teardown"}')
    ).rejects.toThrow('required output schema')
  })

  it('fails closed when the Codex verdict disagrees with its findings', async () => {
    await expect(
      normalizeCodexReview(
        JSON.stringify({
          verdict: 'mergeable',
          summary: 'Looks good.',
          findings: [
            {
              priority: 'P1',
              title: 'Hidden finding',
              path: 'src/main/acp/runtime.ts',
              line: 100,
              impact: 'Incorrect behavior.',
              recommendation: 'Fix it.'
            }
          ]
        })
      )
    ).rejects.toThrow('disagrees with its findings')
  })

  it('allows the first Codex review for a pull request', () => {
    expect(runCodexReviewGate(0)).toMatchObject({ should_run: 'true', round: '1' })
  })

  it('allows the twentieth Codex review for a pull request by default', () => {
    expect(runCodexReviewGate(19)).toMatchObject({ should_run: 'true', round: '20' })
  })

  it('skips Codex review after twenty successful reviews by default', () => {
    expect(runCodexReviewGate(20)).toMatchObject({ should_run: 'false', round: '21' })
  })

  it('supports unlimited Codex reviews when the configured maximum is zero', () => {
    expect(runCodexReviewGate(100, [], '0')).toMatchObject({
      should_run: 'true',
      round: '101'
    })
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

    expect(runCodexReviewGate(19, unrelatedComments)).toMatchObject({
      should_run: 'true',
      round: '20'
    })
  })

  it('publishes the twentieth Codex review with a trusted marker', async () => {
    const [body] = await runPostCodexFeedback(19)

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

  it('does not publish a twenty-first Codex review', async () => {
    await expect(runPostCodexFeedback(20)).resolves.toEqual([])
  })

  it('publishes Codex feedback without a round limit when configured with zero', async () => {
    await expect(runPostCodexFeedback(100, 'head-sha', '0')).resolves.toHaveLength(1)
  })

  it('does not publish or consume a review round for a stale pull request head', async () => {
    await expect(runPostCodexFeedback(19, 'newer-head-sha')).resolves.toEqual([])
  })

  it('serializes the complete review workflow per pull request', () => {
    expect(parsedWorkflow.concurrency).toEqual({
      group:
        "ai-pr-review-${{ github.event.inputs.pull_request_number || github.event.pull_request.number }}-${{ github.event_name == 'workflow_dispatch' && github.event.inputs.reviewer || 'both' }}",
      'cancel-in-progress': true
    })
  })
})
