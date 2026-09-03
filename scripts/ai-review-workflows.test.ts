import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pit = it.skipIf(process.platform === 'win32')

type WorkflowStep = {
  'continue-on-error'?: boolean
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

type WorkflowJob = {
  concurrency?: { group: string; 'cancel-in-progress': boolean | string }
  steps?: WorkflowStep[]
  if?: string
  name?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  secrets?: Record<string, string>
  uses?: string
  with?: Record<string, string>
  outputs?: Record<string, string>
  'timeout-minutes'?: number
}

type Workflow = {
  concurrency?: { group: string; 'cancel-in-progress': boolean | string }
  jobs: Record<string, WorkflowJob>
}

const mainText = readFileSync(join(process.cwd(), '.github/workflows/ai-review-single.yml'), 'utf8')
const retiredText = readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8')
const codexText = readFileSync(join(process.cwd(), '.github/workflows/ai-codex-review.yml'), 'utf8')
const publisherText = readFileSync(
  join(process.cwd(), '.github/workflows/ai-post-review.yml'),
  'utf8'
)
const reviewDocsText = readFileSync(join(process.cwd(), '.github/action/ai-review.md'), 'utf8')
const mainWorkflow = load(mainText) as Workflow
const retiredWorkflow = load(retiredText) as Record<string, unknown>
const codexWorkflow = load(codexText) as Workflow
const publisherWorkflow = load(publisherText) as Workflow
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  fixtureRoots.push(root)
  return root
}

function executable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function getStep(workflow: Workflow, jobName: string, stepName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps?.find(({ name }) => name === stepName)
  if (!step) throw new Error(`Missing step ${jobName}.${stepName}`)
  return step
}

function getRun(workflow: Workflow, jobName: string, stepName: string): string {
  const run = getStep(workflow, jobName, stepName).run
  if (!run) throw new Error(`Missing run script ${jobName}.${stepName}`)
  return run
}

function simpleOutputs(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2) as [string, string])
  )
}

type TargetOptions = {
  authMode?: 'api-key' | 'subscription'
  event?: 'pull_request_target' | 'workflow_dispatch'
  enabled?: string
  isFork?: boolean
  forkMode?: 'disabled' | 'manual' | 'automatic'
  reviewMode?: 'both' | 'correctness' | 'architecture' | 'disabled'
  credentialPairs?: Array<'review' | 'correctness' | 'architecture' | 'shared'>
  credentialKeys?: Array<'review' | 'correctness' | 'architecture' | 'shared'>
  credentialBaseUrls?: Array<'review' | 'correctness' | 'architecture' | 'shared'>
}

function runTarget(options: TargetOptions = {}): {
  status: number | null
  stderr: string
  outputs: Record<string, string>
} {
  const root = fixtureRoot('single-codex-target-')
  const bin = join(root, 'bin')
  const output = join(root, 'github-output')
  mkdirSync(bin)
  executable(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == 'pr' && "$2" == 'view' ]]
[[ " $* " == *' --repo aipoch/open-science '* ]]
printf '%s' "$PR_JSON"
`
  )
  const event = options.event ?? 'pull_request_target'
  const credentialPairs = options.credentialPairs ?? ['shared']
  const credentialKeys = options.credentialKeys ?? credentialPairs
  const credentialBaseUrls = options.credentialBaseUrls ?? credentialPairs
  const result = spawnSync(
    'bash',
    ['-c', getRun(mainWorkflow, 'review_target', 'Resolve pull request metadata')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PR_JSON: JSON.stringify({
          number: 392,
          headRefName: 'ci/dual-codex-review',
          headRefOid: 'head-sha',
          baseRefOid: 'base-sha',
          title: 'ci(review): replace Claude with dual Codex reviews',
          isCrossRepository: options.isFork ?? false,
          state: 'OPEN',
          mergeCommit: null
        }),
        GH_REPO: 'aipoch/open-science',
        DISPATCH_PR_NUMBER: event === 'workflow_dispatch' ? '392' : '',
        EVENT_PR_NUMBER: event === 'pull_request_target' ? '392' : '',
        FORK_REVIEW_MODE: options.forkMode ?? 'manual',
        CODEX_REVIEW_AUTH_MODE: options.authMode ?? 'subscription',
        CODEX_REVIEW_MODE: options.reviewMode ?? 'correctness',
        ENABLE_CODEX_REVIEW: options.enabled ?? 'true',
        REVIEW_API_KEY_CONFIGURED: String(credentialKeys.includes('review')),
        REVIEW_BASE_URL_CONFIGURED: String(credentialBaseUrls.includes('review')),
        CORRECTNESS_API_KEY_CONFIGURED: String(credentialKeys.includes('correctness')),
        CORRECTNESS_BASE_URL_CONFIGURED: String(credentialBaseUrls.includes('correctness')),
        ARCHITECTURE_API_KEY_CONFIGURED: String(credentialKeys.includes('architecture')),
        ARCHITECTURE_BASE_URL_CONFIGURED: String(credentialBaseUrls.includes('architecture')),
        SHARED_API_KEY_CONFIGURED: String(credentialKeys.includes('shared')),
        SHARED_BASE_URL_CONFIGURED: String(credentialBaseUrls.includes('shared')),
        REVIEW_EVENT: event,
        GITHUB_OUTPUT: output
      }
    }
  )
  return {
    status: result.status,
    stderr: result.stderr,
    outputs: result.status === 0 ? simpleOutputs(output) : {}
  }
}

type AuthOptions = {
  authJson?: string
  authMode?: 'api-key' | 'subscription'
  baseUrl?: string
  event?: 'pull_request_target' | 'workflow_dispatch'
  installAvailable?: boolean
  isFork?: boolean
  openAiApiKey?: string
  sandboxAvailable?: boolean
  sandboxProbeAvailable?: boolean
  subscriptionAvailable?: boolean
}

function runAuth(options: AuthOptions = {}): {
  authFile: string
  codexHome: string
  configFile: string
  mode: number | undefined
  outputs: Record<string, string>
  status: number | null
  stderr: string
} {
  const root = fixtureRoot('single-codex-auth-')
  const bin = join(root, 'bin')
  const codexHome = join(root, 'codex-home')
  const authFile = join(codexHome, 'auth.json')
  const configFile = join(codexHome, 'config.toml')
  const output = join(root, 'github-output')
  mkdirSync(bin)
  executable(
    join(bin, 'codex'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${OPENAI_API_KEY:-}" || -n "\${CODEX_BASE_URL:-}" ]]; then
  echo 'fallback API credentials leaked into subscription preflight' >&2
  exit 3
fi
if [[ -z "\${CODEX_HOME:-}" || ! -s "$CODEX_HOME/auth.json" ]]; then
  echo 'staged subscription credential is unavailable' >&2
  exit 2
fi
if [[ "\${1:-}" == 'sandbox' ]]; then
  if [[ "$SANDBOX_PROBE_AVAILABLE" != 'true' ]]; then
    exit 4
  fi
  if [[ " $* " == *'/auth.json'* ]]; then
    exit 1
  fi
  exit 0
fi
if [[ "$SUBSCRIPTION_AVAILABLE" != 'true' ]]; then
  echo 'subscription authentication rejected' >&2
  exit 1
fi
printf '%s\n' '{"type":"turn.completed"}'
`
  )
  executable(
    join(bin, 'sudo'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == 'chown' ]]; then
  exit 0
fi
if [[ "$1" == '-u' && "$2" == 'nobody' && "$3" == '--' ]]; then
  shift 3
  if [[ "$1" == 'env' && "$2" == '-i' ]]; then
    shift 2
    exec env -i \
      SANDBOX_PROBE_AVAILABLE="$SANDBOX_PROBE_AVAILABLE" \
      SUBSCRIPTION_AVAILABLE="$SUBSCRIPTION_AVAILABLE" \
      "$@"
  fi
fi
exec "$@"
`
  )
  const result = spawnSync(
    'bash',
    ['-c', getRun(codexWorkflow, 'review', 'Prepare Codex authentication')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_AUTH_JSON: options.authJson ?? '',
        CODEX_AUTH_MODE: options.authMode ?? 'api-key',
        CODEX_BASE_URL: options.baseUrl ?? 'https://api.openai.com',
        CODEX_INSTALL_OUTCOME: options.installAvailable === false ? 'failure' : 'success',
        CODEX_SANDBOX_OUTCOME: options.sandboxAvailable === false ? 'failure' : 'success',
        CODEX_MODEL: 'gpt-5.6-sol',
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'aipoch/open-science',
        GITHUB_WORKSPACE: root,
        IS_FORK: String(options.isFork ?? false),
        OPENAI_API_KEY: options.openAiApiKey ?? 'sk-test',
        REVIEW_EVENT: options.event ?? 'workflow_dispatch',
        RUNNER_TEMP: root,
        SANDBOX_PROBE_AVAILABLE: String(options.sandboxProbeAvailable ?? true),
        SUBSCRIPTION_AVAILABLE: String(options.subscriptionAvailable ?? true)
      }
    }
  )
  return {
    authFile,
    codexHome,
    configFile,
    mode: result.status === 0 && existsSync(authFile) ? statSync(authFile).mode : undefined,
    outputs: result.status === 0 ? simpleOutputs(output) : {},
    status: result.status,
    stderr: result.stderr
  }
}

type ReviewComment = { body: string | null; user: { login: string } }

function runGate(
  comments: ReviewComment[],
  { max = '20' } = {}
): { status: number | null; stderr: string; outputs: Record<string, string>; summary: string } {
  const root = fixtureRoot('single-codex-gate-')
  const bin = join(root, 'bin')
  const output = join(root, 'github-output')
  const summary = join(root, 'summary')
  mkdirSync(bin)
  executable(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == 'api' && "$2" == '--paginate' && "$3" == '--slurp' ]]
printf '%s' "$COMMENTS_PAGES_JSON"
`
  )
  const result = spawnSync(
    'bash',
    ['-c', getRun(mainWorkflow, 'codex_review_gate', 'Check Codex review counts')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMMENTS_PAGES_JSON: JSON.stringify([comments]),
        GH_REPO: 'aipoch/open-science',
        PR_NUMBER: '392',
        CODEX_REVIEW_MAX_ROUNDS: max,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary
      }
    }
  )
  return {
    status: result.status,
    stderr: result.stderr,
    outputs: result.status === 0 ? simpleOutputs(output) : {},
    summary: result.status === 0 ? readFileSync(summary, 'utf8') : ''
  }
}

function runReviewInputs(): {
  prompt: string
  instructions: string
  schema: Record<string, unknown>
  outputs: Record<string, string>
} {
  const root = fixtureRoot('single-codex-review-inputs-')
  const output = join(root, 'github-output')
  const result = spawnSync(
    'bash',
    ['-c', getRun(codexWorkflow, 'review', 'Build Codex review inputs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        PR_BRANCH: 'ci/dual-codex-review',
        PR_DIFF_BASE: 'base-sha',
        PR_TITLE: 'ci(review): replace Claude with dual Codex reviews',
        REVIEW_SHA: 'review-sha',
        GITHUB_OUTPUT: output
      }
    }
  )
  expect(result.status, result.stderr).toBe(0)
  const outputs = simpleOutputs(output)
  return {
    prompt: readFileSync(outputs.prompt_file, 'utf8'),
    instructions: readFileSync(outputs.instructions_file, 'utf8'),
    schema: JSON.parse(readFileSync(outputs.schema_file, 'utf8')) as Record<string, unknown>,
    outputs
  }
}

async function normalize(raw: string, header: string): Promise<string> {
  const script = getStep(codexWorkflow, 'review', 'Normalize Codex review').with?.script
  if (!script) throw new Error('Missing normalization script')
  let body = ''
  const core = {
    setOutput: vi.fn((name: string, value: string) => {
      if (name === 'review_body') body = value
    })
  }
  const processStub = { env: { CODEX_FINAL_MESSAGE: raw, REVIEW_HEADER: header } }
  const run = new Function('core', 'process', `return (async () => {\n${script}\n})()`)
  await run(core, processStub)
  return body
}

function writeJsonLines(path: string, events: unknown[]): void {
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

async function runPublisher({
  currentHead = 'head-sha',
  comments = [] as ReviewComment[],
  maxRounds = '20'
} = {}): Promise<{ postedBodies: string[]; output: string }> {
  const script = getStep(publisherWorkflow, 'publish', 'Post Codex review').with?.script
  if (!script) throw new Error('Missing publisher script')
  const postedBodies: string[] = []
  let output = ''
  const github = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: { head: { sha: currentHead } } })) },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async ({ body }: { body: string }) => postedBodies.push(body))
      }
    },
    paginate: vi.fn(async () => comments)
  }
  const context = { repo: { owner: 'aipoch', repo: 'open-science' } }
  const core = {
    notice: vi.fn(),
    setOutput: vi.fn((name: string, value: string) => {
      if (name === 'posted') output = value
    })
  }
  const processStub = {
    env: {
      REVIEW_BODY: '## Codex Review\n\n**Verdict: mergeable**',
      REVIEW_HEADER: '## Codex Review',
      REVIEW_MARKER: '<!-- ai-review:codex -->',
      PR_NUMBER: '392',
      REVIEW_HEAD_SHA: 'head-sha',
      REVIEW_RUN_ID: '1234',
      CODEX_REVIEW_MAX_ROUNDS: maxRounds
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
  return { postedBodies, output }
}

describe('single Codex workflow contract', () => {
  it('parses all active and retired workflows as YAML', () => {
    expect(() => load(mainText)).not.toThrow()
    expect(() => load(retiredText)).not.toThrow()
    expect(() => load(codexText)).not.toThrow()
    expect(() => load(publisherText)).not.toThrow()
  })

  it('keeps the retired dual-review workflow inert', () => {
    expect(retiredText).toContain('name: AI PR Review (Disabled)')
    expect(retiredWorkflow.on).toEqual({ workflow_call: null })
  })

  it('documents subscription setup and credential refresh limitations', () => {
    expect(reviewDocsText).toContain('gh secret set CODEX_AUTH_JSON')
    expect(reviewDocsText).toContain('gh variable set CODEX_REVIEW_AUTH_MODE --body subscription')
    expect(reviewDocsText).toContain('GitHub-hosted runners are ephemeral')
    expect(reviewDocsText).toMatch(
      /Subscription auth is the default for every allowed automatic or manually dispatched pull request\s+review\./
    )
    expect(reviewDocsText).toContain(
      'Invalid or missing subscription credentials fall back to API-key auth.'
    )
  })

  it('removes Claude, Anthropic, and CodeGraph runtime configuration', () => {
    const all = `${mainText}\n${codexText}\n${publisherText}`
    expect(all).not.toMatch(/Claude|CLAUDE|Anthropic|ANTHROPIC|CodeGraph|CODEGRAPH/)
  })

  it('uses one reviewer for automatic and manual runs', () => {
    expect(mainText).not.toContain('DISPATCH_REVIEWER')
    expect(runTarget().outputs.review_enabled).toBe('true')
    expect(runTarget({ event: 'workflow_dispatch' }).outputs.review_enabled).toBe('true')
    expect(runTarget({ enabled: 'false' }).outputs.review_enabled).toBe('false')
  })

  it('preserves the legacy manual-only review mode', () => {
    expect(runTarget({ reviewMode: 'disabled' }).outputs.review_enabled).toBe('false')
    expect(
      runTarget({ event: 'workflow_dispatch', reviewMode: 'disabled' }).outputs.review_enabled
    ).toBe('true')
  })

  it('selects API credentials as an atomic pair with deterministic legacy priority', () => {
    expect(runTarget({ credentialPairs: ['shared'] }).outputs.credential_scope).toBe('shared')
    expect(
      runTarget({ credentialPairs: ['architecture', 'shared'] }).outputs.credential_scope
    ).toBe('architecture')
    expect(
      runTarget({ credentialPairs: ['correctness', 'architecture'] }).outputs.credential_scope
    ).toBe('correctness')
    expect(runTarget({ credentialPairs: ['review', 'correctness'] }).outputs.credential_scope).toBe(
      'review'
    )
    expect(
      runTarget({
        credentialKeys: ['review', 'correctness'],
        credentialBaseUrls: ['correctness']
      }).outputs.credential_scope
    ).toBe('correctness')
    expect(
      runTarget({
        credentialKeys: ['architecture', 'shared'],
        credentialBaseUrls: ['review', 'shared']
      }).outputs.credential_scope
    ).toBe('shared')
  })

  it('rejects an invalid reviewer enable flag', () => {
    const result = runTarget({ enabled: 'sometimes' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ENABLE_CODEX_REVIEW must be true or false.')
  })

  it('keeps fork review policy independent from the reviewer toggle', () => {
    expect(runTarget({ isFork: true, forkMode: 'manual' }).outputs.review_allowed).toBe('false')
    expect(
      runTarget({
        event: 'workflow_dispatch',
        isFork: true,
        forkMode: 'manual'
      }).outputs.review_allowed
    ).toBe('true')
    expect(runTarget({ isFork: true, forkMode: 'automatic' }).outputs.review_allowed).toBe('true')
  })

  it('prefers subscription for automatic and manual reviews before API fallback', () => {
    expect(mainText).toContain(
      "CODEX_REVIEW_AUTH_MODE: ${{ vars.CODEX_REVIEW_AUTH_MODE || 'subscription' }}"
    )
    expect(runTarget().outputs).toMatchObject({
      auth_mode: 'subscription',
      review_allowed: 'true'
    })
    expect(
      runTarget({
        authMode: 'subscription',
        event: 'workflow_dispatch'
      }).outputs
    ).toMatchObject({ auth_mode: 'subscription', review_allowed: 'true' })
    expect(runTarget({ authMode: 'api-key' }).outputs.auth_mode).toBe('api-key')
    const fork = runTarget({
      authMode: 'subscription',
      event: 'workflow_dispatch',
      isFork: true,
      forkMode: 'automatic'
    })
    expect(fork.status, fork.stderr).toBe(0)
    expect(fork.outputs).toMatchObject({ auth_mode: 'subscription', review_allowed: 'true' })
  })

  it('counts one combined review round and ignores retired architecture comments', () => {
    const comments: ReviewComment[] = [
      ...Array.from({ length: 19 }, () => ({
        body: '<!-- ai-review:codex -->\n## Codex Correctness Review',
        user: { login: 'github-actions[bot]' }
      })),
      ...Array.from({ length: 20 }, () => ({
        body: '<!-- ai-review:codex-architecture -->\n## Codex Architecture Review',
        user: { login: 'github-actions[bot]' }
      })),
      {
        body: '<!-- ai-review:codex-architecture -->',
        user: { login: 'contributor' }
      }
    ]
    const result = runGate(comments)
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.should_run).toBe('true')
    expect(result.summary).toContain('Codex review round 20 of 20')

    const atLimit = runGate([
      ...comments,
      {
        body: '<!-- ai-review:codex -->\n## Codex Review',
        user: { login: 'github-actions[bot]' }
      }
    ])
    expect(atLimit.status, atLimit.stderr).toBe(0)
    expect(atLimit.outputs.should_run).toBe('false')
    expect(atLimit.summary).toContain('Codex review skipped')
  })

  it('supports an unlimited combined review round count', () => {
    const result = runGate([], { max: '0' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.should_run).toBe('true')
    expect(result.summary).toContain('Codex review round 1 (unlimited)')
  })

  it('invokes the reusable Codex workflow once for a combined review', () => {
    const reviewJobs = Object.values(mainWorkflow.jobs).filter(
      ({ uses }) => uses === './.github/workflows/ai-codex-review.yml'
    )
    const review = mainWorkflow.jobs.codex_review
    expect(reviewJobs).toHaveLength(1)
    expect(review).toBe(reviewJobs[0])
    expect(review.name).toBe('Review')
    expect(codexWorkflow.jobs.review.name).toBe('Run Codex')
    expect(review.permissions).toEqual({ contents: 'read' })
    expect(review.with).toMatchObject({
      auth_mode: '${{ needs.review_target.outputs.auth_mode }}',
      model:
        "${{ vars.CODEX_REVIEW_MODEL || (needs.review_target.outputs.credential_scope == 'correctness' && vars.CODEX_CORRECTNESS_MODEL) || (needs.review_target.outputs.credential_scope == 'architecture' && vars.CODEX_ARCHITECTURE_MODEL) || ((needs.review_target.outputs.credential_scope == 'review' || needs.review_target.outputs.credential_scope == 'shared' || needs.review_target.outputs.credential_scope == 'none') && (vars.CODEX_CORRECTNESS_MODEL || vars.CODEX_ARCHITECTURE_MODEL)) || 'gpt-5.6-sol' }}",
      effort:
        "${{ vars.CODEX_REVIEW_EFFORT || (needs.review_target.outputs.credential_scope == 'correctness' && vars.CODEX_CORRECTNESS_EFFORT) || (needs.review_target.outputs.credential_scope == 'architecture' && vars.CODEX_ARCHITECTURE_EFFORT) || ((needs.review_target.outputs.credential_scope == 'review' || needs.review_target.outputs.credential_scope == 'shared' || needs.review_target.outputs.credential_scope == 'none') && (vars.CODEX_CORRECTNESS_EFFORT || vars.CODEX_ARCHITECTURE_EFFORT)) || 'high' }}"
    })
    expect(review.with).not.toHaveProperty('scope')
    expect(review.secrets).toEqual({
      CODEX_AUTH_JSON:
        "${{ needs.review_target.outputs.auth_mode == 'subscription' && secrets.CODEX_AUTH_JSON || '' }}",
      OPENAI_API_KEY:
        "${{ (needs.review_target.outputs.credential_scope == 'review' && secrets.CODEX_REVIEW_API_KEY) || (needs.review_target.outputs.credential_scope == 'correctness' && secrets.CODEX_CORRECTNESS_API_KEY) || (needs.review_target.outputs.credential_scope == 'architecture' && secrets.CODEX_ARCHITECTURE_API_KEY) || (needs.review_target.outputs.credential_scope == 'shared' && secrets.OPENAI_API_KEY) || '' }}",
      CODEX_BASE_URL:
        "${{ (needs.review_target.outputs.credential_scope == 'review' && secrets.CODEX_REVIEW_BASE_URL) || (needs.review_target.outputs.credential_scope == 'correctness' && secrets.CODEX_CORRECTNESS_BASE_URL) || (needs.review_target.outputs.credential_scope == 'architecture' && secrets.CODEX_ARCHITECTURE_BASE_URL) || (needs.review_target.outputs.credential_scope == 'shared' && secrets.CODEX_BASE_URL) || '' }}"
    })
  })

  pit('bootstraps managed subscription auth on a GitHub-hosted runner', () => {
    const seed = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-seed' },
      last_refresh: '2026-07-25T00:00:00Z'
    })
    const result = runAuth({ authJson: seed, authMode: 'subscription' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toMatchObject({
      auth_mode: 'subscription',
      codex_home: result.codexHome
    })
    expect(readFileSync(result.authFile, 'utf8')).toBe(seed)
    expect(result.mode! & 0o777).toBe(0o600)
    const config = readFileSync(result.configFile, 'utf8')
    expect(config).toContain('default_permissions = "ai_review"')
    expect(config).toContain('project_doc_max_bytes = 0')
    expect(config).toContain(`[projects.${JSON.stringify(dirname(result.codexHome))}]`)
    expect(config).toContain('trust_level = "untrusted"')
    expect(config).toContain('extends = ":read-only"')
    expect(config).toContain(`${JSON.stringify(result.codexHome)} = "deny"`)
  })

  it('ignores untrusted checkout configuration in API-key mode too', () => {
    const result = runAuth({ authMode: 'api-key' })
    expect(result.status, result.stderr).toBe(0)
    const config = readFileSync(result.configFile, 'utf8')
    expect(config).toContain('default_permissions = ":read-only"')
    expect(config).toContain('project_doc_max_bytes = 0')
    expect(config).toContain('trust_level = "untrusted"')
  })

  it('falls back to API-key auth when subscription credentials are unavailable', () => {
    const invalid = runAuth({
      authJson: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-wrong-mode' }),
      authMode: 'subscription'
    })
    expect(invalid.status, invalid.stderr).toBe(0)
    expect(invalid.outputs.auth_mode).toBe('api-key')
    expect(existsSync(invalid.authFile)).toBe(false)

    const missing = runAuth({ authMode: 'subscription' })
    expect(missing.status, missing.stderr).toBe(0)
    expect(missing.outputs.auth_mode).toBe('api-key')

    const rejected = runAuth({
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'revoked-refresh-token' }
      }),
      authMode: 'subscription',
      subscriptionAvailable: false
    })
    expect(rejected.status, rejected.stderr).toBe(0)
    expect(rejected.outputs.auth_mode).toBe('api-key')
    expect(existsSync(rejected.authFile)).toBe(false)

    const installFailed = runAuth({
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-seed' }
      }),
      authMode: 'subscription',
      installAvailable: false
    })
    expect(installFailed.status, installFailed.stderr).toBe(0)
    expect(installFailed.outputs.auth_mode).toBe('api-key')

    const sandboxFailed = runAuth({
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-seed' }
      }),
      authMode: 'subscription',
      sandboxAvailable: false
    })
    expect(sandboxFailed.status, sandboxFailed.stderr).toBe(0)
    expect(sandboxFailed.outputs.auth_mode).toBe('api-key')

    const sandboxProbeFailed = runAuth({
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-seed' }
      }),
      authMode: 'subscription',
      sandboxProbeAvailable: false
    })
    expect(sandboxProbeFailed.status, sandboxProbeFailed.stderr).toBe(0)
    expect(sandboxProbeFailed.outputs.auth_mode).toBe('api-key')
  })

  it('fails closed when neither subscription nor API-key credentials are available', () => {
    const result = runAuth({
      authMode: 'subscription',
      baseUrl: '',
      openAiApiKey: ''
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'Repository secret OPENAI_API_KEY is required for API-key auth.'
    )
  })

  pit('accepts subscription auth for automatic, manual, and fork reviews', () => {
    const seed = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-seed' }
    })
    const automatic = runAuth({
      authJson: seed,
      authMode: 'subscription',
      event: 'pull_request_target'
    })
    expect(automatic.status, automatic.stderr).toBe(0)
    expect(automatic.outputs.auth_mode).toBe('subscription')

    const fork = runAuth({ authJson: seed, authMode: 'subscription', isFork: true })
    expect(fork.status, fork.stderr).toBe(0)
    expect(fork.outputs.auth_mode).toBe('subscription')
  })

  it('uses the API action only for API-key auth and installs the CLI directly for subscription auth', () => {
    const prepareRuntime = getStep(codexWorkflow, 'review', 'Prepare Codex review runtime')
    expect(prepareRuntime.if).toBe("${{ steps.codex_auth.outputs.auth_mode == 'api-key' }}")
    expect(prepareRuntime.with).toMatchObject({
      'codex-home': '${{ steps.codex_auth.outputs.codex_home }}',
      'codex-version': '0.144.6',
      'openai-api-key':
        "${{ steps.codex_auth.outputs.auth_mode == 'api-key' && secrets.OPENAI_API_KEY || '' }}",
      'responses-api-endpoint': '${{ steps.responses_endpoint.outputs.url }}'
    })
    expect(getStep(codexWorkflow, 'review', 'Resolve Responses API endpoint').if).toBe(
      "${{ steps.codex_auth.outputs.auth_mode == 'api-key' }}"
    )
    const setupNode = getStep(codexWorkflow, 'review', 'Set up Node.js for subscription auth')
    expect(setupNode.id).toBe('setup_subscription_node')
    expect(setupNode.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(setupNode['continue-on-error']).toBe(true)
    expect(setupNode.uses).toBe('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020')
    expect(setupNode.with).toEqual({ 'node-version': '24' })
    const installCli = getStep(codexWorkflow, 'review', 'Install Codex CLI for subscription auth')
    expect(installCli.id).toBe('install_subscription_cli')
    expect(installCli.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(installCli['continue-on-error']).toBe(true)
    expect(installCli.env).toEqual({ CODEX_VERSION: '0.144.6' })
    expect(installCli.run).toContain('npm install -g "@openai/codex@${CODEX_VERSION}"')
    expect(installCli.run).toContain('codex --version')
    const prepareAuth = getStep(codexWorkflow, 'review', 'Prepare Codex authentication')
    expect(prepareAuth.run).toContain('sudo -u nobody -- env -i')
    expect(prepareAuth.run).toContain(
      'preflight_dir="$(mktemp -d /tmp/codex-auth-preflight-work.XXXXXX)"'
    )
    expect(prepareAuth.run).toContain(
      'sudo chown -R "$preflight_uid:$preflight_gid" "$preflight_home" "$preflight_dir"'
    )
    expect(prepareAuth.run).toContain('CODEX_HOME="$preflight_home"')
    expect(getStep(codexWorkflow, 'review', 'Run Codex review').env?.CODEX_PERMISSION_PROFILE).toBe(
      "${{ steps.codex_auth.outputs.auth_mode == 'subscription' && 'ai_review' || ':read-only' }}"
    )
    const stepNames = codexWorkflow.jobs.review.steps?.map(({ name }) => name) ?? []
    expect(stepNames.indexOf('Install Codex CLI for subscription auth')).toBeLessThan(
      stepNames.indexOf('Prepare Codex authentication')
    )
    expect(stepNames.indexOf('Prepare Codex authentication')).toBeLessThan(
      stepNames.indexOf('Checkout pull request review commit')
    )
  })

  it('prepares the GitHub-hosted Linux sandbox when the action runs install-only', () => {
    const sandbox = getStep(
      codexWorkflow,
      'review',
      'Prepare GitHub-hosted sandbox for subscription auth'
    )
    expect(sandbox.id).toBe('prepare_subscription_sandbox')
    expect(sandbox.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(sandbox['continue-on-error']).toBe(true)
    expect(sandbox.run).toContain('kernel.unprivileged_userns_clone')
    expect(sandbox.run).toContain('kernel.apparmor_restrict_unprivileged_userns')
    const stepNames = codexWorkflow.jobs.review.steps?.map(({ name }) => name) ?? []
    expect(stepNames.indexOf('Prepare GitHub-hosted sandbox for subscription auth')).toBeLessThan(
      stepNames.indexOf('Prepare Codex authentication')
    )
  })

  it('drops sudo and verifies the subscription credential is denied to sandboxed commands', () => {
    const hardening = getStep(codexWorkflow, 'review', 'Harden subscription review runtime')
    expect(hardening.if).toBe("${{ steps.codex_auth.outputs.auth_mode == 'subscription' }}")
    expect(hardening.run).toContain('/etc/sudoers.d/*')
    expect(hardening.run).not.toContain('command -v bwrap')
    expect(hardening.run).toContain('sudo -n true')
    expect(hardening.run).toContain('codex sandbox --permission-profile ai_review')
    expect(hardening.run).toContain('test -r "$CODEX_HOME/auth.json"')
    expect(hardening.run).toContain('test -r "$GITHUB_WORKSPACE/package.json"')
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: hardening.run })
    expect(syntax.status, syntax.stderr).toBe(0)
  })

  pit('combines correctness and architecture into one Codex review', () => {
    const review = runReviewInputs()
    expect(review.outputs.review_header).toBe('## Codex Review')
    expect(review.instructions).toContain('Branch name valid: true')
    expect(review.prompt).toContain('correctness, security, regression')
    expect(review.prompt).toContain('architecture, and integration defects')
    expect(review.prompt).toContain('IPC ownership')
    expect(review.schema).toHaveProperty('properties')
  })

  it('keeps the Codex reviewer static and read-only', () => {
    const inputs = getRun(codexWorkflow, 'review', 'Build Codex review inputs')
    const run = getRun(codexWorkflow, 'review', 'Run Codex review')
    for (const command of ['install dependencies', 'lint', 'tests', 'typecheck', 'build']) {
      expect(inputs).toContain(command)
    }
    expect(run).toContain('--strict-config')
    expect(run).toContain('--config project_doc_max_bytes=0')
    expect(run).toContain('--config "default_permissions=\\"${CODEX_PERMISSION_PROFILE}\\""')
    expect(run).toContain('--ephemeral')
    expect(run).toContain('--ignore-rules')
    expect(run).toContain('--output-schema "$CODEX_SCHEMA_FILE"')
  })

  it('captures raw JSONL without mirroring it into the Actions log', () => {
    const run = getRun(codexWorkflow, 'review', 'Run Codex review')
    expect(run).toContain('--json')
    expect(run).toContain('> "$execution_file"')
    expect(run).not.toContain('tee "$execution_file"')
  })

  it('runs the real workflow shell against a fake Codex CLI', () => {
    const root = fixtureRoot('dual-codex-exec-')
    const bin = join(root, 'bin')
    const argsFile = join(root, 'args.json')
    const stdinFile = join(root, 'stdin.txt')
    const output = join(root, 'github-output')
    const instructions = join(root, 'instructions.txt')
    const prompt = join(root, 'prompt.txt')
    const schema = join(root, 'schema.json')
    mkdirSync(bin)
    writeFileSync(instructions, 'Review safely.\n')
    writeFileSync(prompt, 'Review this pull request.\n')
    writeFileSync(schema, '{}\n')
    executable(
      join(bin, 'codex'),
      `#!/usr/bin/env bash
set -euo pipefail
jq -cn --args '$ARGS.positional' -- "$@" > "$CAPTURE_ARGS"
args=("$@")
output_file=''
for (( index = 0; index < \${#args[@]}; index++ )); do
  if [[ "\${args[index]}" == '--output-last-message' ]]; then
    output_file="\${args[index + 1]}"
  fi
done
cat > "$CAPTURE_STDIN"
printf '%s' '{"verdict":"mergeable","summary":"No issues found.","findings":[]}' > "$output_file"
printf '%s\n' \\
  '{"type":"thread.started","thread_id":"thread-1"}' \\
  '{"type":"turn.started"}' \\
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":8,"output_tokens":2,"reasoning_output_tokens":1}}'
`
    )
    const result = spawnSync('bash', ['-c', getRun(codexWorkflow, 'review', 'Run Codex review')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CAPTURE_ARGS: argsFile,
        CAPTURE_STDIN: stdinFile,
        CODEX_EFFORT: 'high',
        CODEX_HOME: join(root, 'codex-home'),
        CODEX_INSTRUCTIONS_FILE: instructions,
        CODEX_MODEL: 'codex-auto-review',
        CODEX_PERMISSION_PROFILE: ':read-only',
        CODEX_PROMPT_FILE: prompt,
        CODEX_SCHEMA_FILE: schema,
        GITHUB_OUTPUT: output,
        GITHUB_WORKSPACE: root,
        RUNNER_TEMP: root
      }
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('thread.started')
    expect(readFileSync(join(root, 'codex-execution.jsonl'), 'utf8')).toContain(
      '"type":"turn.completed"'
    )
    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    expect(args).toContain('--json')
    expect(args).toContain('--strict-config')
    expect(args).toContain('default_permissions=":read-only"')
    expect(readFileSync(stdinFile, 'utf8')).toBe('Review this pull request.\n')
    expect(readFileSync(output, 'utf8')).toContain('"verdict":"mergeable"')
  })

  it('reports turns, tokens, and unique tool calls to the step summary', () => {
    const root = fixtureRoot('dual-codex-telemetry-')
    const execution = join(root, 'execution.jsonl')
    const summary = join(root, 'summary')
    writeJsonLines(execution, [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'command-1', type: 'command_execution', status: 'in_progress' }
      },
      {
        type: 'item.completed',
        item: { id: 'command-1', type: 'command_execution', status: 'completed' }
      },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', status: 'completed' }
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 5
        }
      }
    ])
    const result = spawnSync(
      'bash',
      ['-c', getRun(codexWorkflow, 'review', 'Report Codex review telemetry')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_EFFORT: 'high',
          CODEX_MODEL: 'codex-auto-review',
          DURATION_SECONDS: '7',
          EXECUTION_FILE: execution,
          GITHUB_STEP_SUMMARY: summary
        }
      }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Codex items: unique=2, tool_calls=1, failed=0')
    expect(result.stdout).toContain('Codex tokens: input=100, cached_input=80')
    const summaryText = readFileSync(summary, 'utf8')
    expect(summaryText).toContain('### Codex review telemetry')
    expect(summaryText).toContain('| 1 | 100 | 80 | 20 | 5 |')
    expect(summaryText).toContain('| `command_execution` | 1 |')
  })

  it('normalizes schema-valid results for the combined Codex header', async () => {
    await expect(
      normalize(
        JSON.stringify({ verdict: 'mergeable', summary: 'No issues.', findings: [] }),
        '## Codex Review'
      )
    ).resolves.toContain('## Codex Review\n\n**Verdict: mergeable**')

    await expect(
      normalize(
        JSON.stringify({
          verdict: 'needs changes',
          summary: 'One issue.',
          findings: [
            {
              priority: 'P1',
              title: 'Boundary is bypassed',
              path: 'src/main/example.ts',
              line: 12,
              impact: 'Renderer gains unintended ownership.',
              recommendation: 'Route the operation through preload.'
            }
          ]
        }),
        '## Codex Review'
      )
    ).resolves.toContain('### [P1] Boundary is bypassed')
  })

  it('fails closed when the verdict contradicts findings', async () => {
    await expect(
      normalize(
        JSON.stringify({
          verdict: 'mergeable',
          summary: 'Contradictory.',
          findings: [
            {
              priority: 'P1',
              title: 'Issue',
              path: 'src/main/example.ts',
              line: 1,
              impact: 'Breaks behavior.',
              recommendation: 'Fix it.'
            }
          ]
        }),
        '## Codex Review'
      )
    ).rejects.toThrow('Codex verdict disagrees with its findings')
  })

  it('publishes the combined review through the shared trusted workflow', () => {
    expect(mainWorkflow.jobs.post_codex_feedback.uses).toBe(
      './.github/workflows/ai-post-review.yml'
    )
    expect(mainWorkflow.jobs.post_codex_feedback.with).toMatchObject({
      scope: 'review',
      marker: '<!-- ai-review:codex -->',
      header: '## Codex Review'
    })
    expect(getStep(publisherWorkflow, 'publish', 'Post Codex review').with?.retries).toBe(3)
  })

  it('publishes combined feedback with trusted provenance', async () => {
    const result = await runPublisher()
    expect(result.output).toBe('true')
    expect(result.postedBodies).toEqual([
      [
        '<!-- ai-review:codex -->',
        '<!-- ai-review-meta head=head-sha run=1234 -->',
        '## Codex Review',
        '',
        '**Verdict: mergeable**'
      ].join('\n')
    ])
  })

  it('does not publish stale feedback or exceed the review round limit', async () => {
    await expect(runPublisher({ currentHead: 'newer-head' })).resolves.toMatchObject({
      output: 'false',
      postedBodies: []
    })
    const prior = Array.from({ length: 20 }, () => ({
      body: '<!-- ai-review:codex -->',
      user: { login: 'github-actions[bot]' }
    }))
    await expect(runPublisher({ comments: prior })).resolves.toMatchObject({
      output: 'false',
      postedBodies: []
    })
  })

  it('serializes duplicate runs of the single reviewer for each pull request', () => {
    expect(mainWorkflow.concurrency).toEqual({
      group:
        'ai-pr-review-${{ github.event.inputs.pull_request_number || github.event.pull_request.number }}',
      'cancel-in-progress': true
    })
    expect(codexWorkflow.jobs.review.concurrency).toEqual({
      group: "${{ format('codex-review-{0}', inputs.pull_request_number) }}",
      'cancel-in-progress': true
    })
    expect(mainWorkflow.jobs.codex_review.needs).toEqual(['review_target', 'codex_review_gate'])
  })
})
