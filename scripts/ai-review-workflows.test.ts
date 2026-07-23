import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

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

type Workflow = {
  jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>
}

const parsedWorkflow = load(reviewWorkflow) as Workflow

function getRunStep(jobName: string, stepId: string): string {
  const step = parsedWorkflow.jobs[jobName].steps.find(({ id }) => id === stepId)
  if (!step?.run) throw new Error(`Missing run step ${jobName}.${stepId}`)
  return step.run
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createMergeCommit(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-review-context-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'base')
  git(root, 'checkout', '-b', 'feature')
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'feature')
  git(root, 'checkout', 'main')
  git(root, 'merge', '--no-ff', 'feature', '-m', 'merge')
  return root
}

function runCodexReviewStep(): { captureDir: string; githubOutput: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-review-codex-'))
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
    expect(reviewWorkflow).toContain(
      'npm install -g @openai/codex@0.145.0 @openai/codex-responses-api-proxy@0.145.0'
    )
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
})
