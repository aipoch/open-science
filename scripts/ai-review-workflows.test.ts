import {
  chmodSync,
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

type WorkflowStep = {
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

const mainText = readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8')
const codexText = readFileSync(join(process.cwd(), '.github/workflows/ai-codex-review.yml'), 'utf8')
const publisherText = readFileSync(
  join(process.cwd(), '.github/workflows/ai-post-review.yml'),
  'utf8'
)
const reviewDocsText = readFileSync(join(process.cwd(), '.github/action/ai-review.md'), 'utf8')
const mainWorkflow = load(mainText) as Workflow
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
  dispatchReviewer?: string
  automaticMode?: 'both' | 'correctness' | 'architecture' | 'disabled'
  enabled?: 'true' | 'false'
  isFork?: boolean
  forkMode?: 'disabled' | 'manual' | 'automatic'
}

function runTarget(options: TargetOptions = {}): {
  status: number | null
  stderr: string
  outputs: Record<string, string>
} {
  const root = fixtureRoot('dual-codex-target-')
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
        CODEX_REVIEW_AUTH_MODE: options.authMode ?? 'api-key',
        ENABLE_CODEX_REVIEW: options.enabled ?? 'true',
        CODEX_REVIEW_MODE: options.automaticMode ?? 'correctness',
        DISPATCH_REVIEWER: options.dispatchReviewer ?? 'both',
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
  isFork?: boolean
  openAiApiKey?: string
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
  const root = fixtureRoot('dual-codex-auth-')
  const codexHome = join(root, 'codex-home')
  const authFile = join(codexHome, 'auth.json')
  const configFile = join(codexHome, 'config.toml')
  const output = join(root, 'github-output')
  const result = spawnSync(
    'bash',
    ['-c', getRun(codexWorkflow, 'review', 'Prepare Codex authentication')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_AUTH_JSON: options.authJson ?? '',
        CODEX_AUTH_MODE: options.authMode ?? 'api-key',
        CODEX_BASE_URL: options.baseUrl ?? 'https://api.openai.com',
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'aipoch/open-science',
        GITHUB_WORKSPACE: root,
        IS_FORK: String(options.isFork ?? false),
        OPENAI_API_KEY: options.openAiApiKey ?? 'sk-test',
        REVIEW_EVENT: options.event ?? 'workflow_dispatch',
        RUNNER_TEMP: root
      }
    }
  )
  return {
    authFile,
    codexHome,
    configFile,
    mode:
      result.status === 0 && options.authMode === 'subscription'
        ? statSync(authFile).mode
        : undefined,
    outputs: result.status === 0 ? simpleOutputs(output) : {},
    status: result.status,
    stderr: result.stderr
  }
}

type ReviewComment = { body: string | null; user: { login: string } }

function runGate(
  comments: ReviewComment[],
  { correctness = 'true', architecture = 'true', max = '20' } = {}
): { status: number | null; stderr: string; outputs: Record<string, string>; summary: string } {
  const root = fixtureRoot('dual-codex-gate-')
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
        CORRECTNESS_ENABLED: correctness,
        ARCHITECTURE_ENABLED: architecture,
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

function runReviewInputs(scope: 'correctness' | 'architecture'): {
  prompt: string
  instructions: string
  schema: Record<string, unknown>
  outputs: Record<string, string>
} {
  const root = fixtureRoot(`dual-codex-${scope}-inputs-`)
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
        REVIEW_SCOPE: scope,
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
      REVIEW_BODY: '## Codex Architecture Review\n\n**Verdict: mergeable**',
      REVIEW_HEADER: '## Codex Architecture Review',
      REVIEW_MARKER: '<!-- ai-review:codex-architecture -->',
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

describe('dual Codex workflow contract', () => {
  it('parses all three workflows as YAML', () => {
    expect(() => load(mainText)).not.toThrow()
    expect(() => load(codexText)).not.toThrow()
    expect(() => load(publisherText)).not.toThrow()
  })

  it('documents subscription setup and credential refresh limitations', () => {
    expect(reviewDocsText).toContain('gh secret set CODEX_AUTH_JSON')
    expect(reviewDocsText).toContain('gh variable set CODEX_REVIEW_AUTH_MODE --body subscription')
    expect(reviewDocsText).toContain('GitHub-hosted runners are ephemeral')
    expect(reviewDocsText).toContain(
      'manually dispatched review of a\n> same-repository pull request'
    )
  })

  it('removes Claude, Anthropic, and CodeGraph runtime configuration', () => {
    const all = `${mainText}\n${codexText}\n${publisherText}`
    expect(all).not.toMatch(/Claude|CLAUDE|Anthropic|ANTHROPIC|CodeGraph|CODEGRAPH/)
  })

  it('supports automatic and manual reviewer switching', () => {
    expect(mainText).toContain("vars.CODEX_REVIEW_MODE || 'correctness'")
    expect(mainText).toMatch(
      /reviewer:\n(?:\s+.*\n)*?\s+default: both\n(?:\s+.*\n)*?\s+options:\n\s+- both\n\s+- correctness\n\s+- architecture/
    )

    expect(runTarget().outputs).toMatchObject({
      correctness_enabled: 'true',
      architecture_enabled: 'false'
    })
    expect(runTarget({ automaticMode: 'both' }).outputs).toMatchObject({
      correctness_enabled: 'true',
      architecture_enabled: 'true'
    })
    expect(runTarget({ automaticMode: 'architecture' }).outputs).toMatchObject({
      correctness_enabled: 'false',
      architecture_enabled: 'true'
    })
    expect(
      runTarget({
        event: 'workflow_dispatch',
        automaticMode: 'architecture',
        dispatchReviewer: 'correctness'
      }).outputs
    ).toMatchObject({ correctness_enabled: 'true', architecture_enabled: 'false' })
    expect(runTarget({ enabled: 'false' }).outputs).toMatchObject({
      correctness_enabled: 'false',
      architecture_enabled: 'false'
    })
    expect(runTarget({ event: 'workflow_dispatch' }).outputs).toMatchObject({
      correctness_enabled: 'true',
      architecture_enabled: 'true'
    })
  })

  it('rejects removed manual reviewer aliases', () => {
    const result = runTarget({ event: 'workflow_dispatch', dispatchReviewer: 'codex' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Dispatch reviewer must be both, correctness, or architecture.')
  })

  it('keeps fork review policy independent from reviewer selection', () => {
    expect(runTarget({ isFork: true, forkMode: 'manual' }).outputs.review_allowed).toBe('false')
    expect(
      runTarget({
        event: 'workflow_dispatch',
        dispatchReviewer: 'architecture',
        isFork: true,
        forkMode: 'manual'
      }).outputs.review_allowed
    ).toBe('true')
    expect(runTarget({ isFork: true, forkMode: 'automatic' }).outputs.review_allowed).toBe('true')
  })

  it('uses subscription only for manual same-repository reviews and otherwise falls back to API auth', () => {
    expect(runTarget({ authMode: 'subscription' }).outputs).toMatchObject({
      auth_mode: 'api-key',
      review_allowed: 'true'
    })
    expect(
      runTarget({
        authMode: 'subscription',
        event: 'workflow_dispatch'
      }).outputs
    ).toMatchObject({ auth_mode: 'subscription', review_allowed: 'true' })
    const fork = runTarget({
      authMode: 'subscription',
      event: 'workflow_dispatch',
      isFork: true,
      forkMode: 'automatic'
    })
    expect(fork.status, fork.stderr).toBe(0)
    expect(fork.outputs).toMatchObject({ auth_mode: 'api-key', review_allowed: 'true' })
  })

  it('rejects an invalid automatic review mode', () => {
    const root = fixtureRoot('dual-codex-invalid-mode-')
    const result = spawnSync(
      'bash',
      ['-c', getRun(mainWorkflow, 'review_target', 'Resolve pull request metadata')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORK_REVIEW_MODE: 'manual',
          CODEX_REVIEW_AUTH_MODE: 'api-key',
          CODEX_REVIEW_MODE: 'claude',
          ENABLE_CODEX_REVIEW: 'true'
        }
      }
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('CODEX_REVIEW_MODE must be')
  })

  it('counts correctness and architecture review rounds independently', () => {
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
    expect(result.outputs).toMatchObject({
      correctness_should_run: 'true',
      architecture_should_run: 'false'
    })
    expect(result.summary).toContain('correctness review round 20 of 20')
    expect(result.summary).toContain('architecture review skipped')
  })

  it('skips an unselected reviewer without consuming its round', () => {
    const result = runGate([], { correctness: 'false', architecture: 'true', max: '0' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toMatchObject({
      correctness_should_run: 'false',
      architecture_should_run: 'true'
    })
    expect(result.summary).not.toContain('correctness review round')
    expect(result.summary).toContain('architecture review round 1 (unlimited)')
  })

  it('invokes the reusable Codex workflow twice with independent backends', () => {
    const correctness = mainWorkflow.jobs.codex_correctness_review
    const architecture = mainWorkflow.jobs.codex_architecture_review
    expect(correctness.uses).toBe('./.github/workflows/ai-codex-review.yml')
    expect(architecture.uses).toBe('./.github/workflows/ai-codex-review.yml')
    expect(correctness.name).toBe('Correctness')
    expect(architecture.name).toBe('Architecture')
    expect(codexWorkflow.jobs.review.name).toBe('Run Codex')
    expect(correctness.permissions).toEqual({ contents: 'read' })
    expect(architecture.permissions).toEqual({ contents: 'read' })
    expect(correctness.with).toMatchObject({
      auth_mode: '${{ needs.review_target.outputs.auth_mode }}',
      scope: 'correctness',
      model: "${{ vars.CODEX_CORRECTNESS_MODEL || vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol' }}",
      effort: "${{ vars.CODEX_CORRECTNESS_EFFORT || vars.CODEX_REVIEW_EFFORT || 'high' }}"
    })
    expect(correctness.secrets).toEqual({
      CODEX_AUTH_JSON:
        "${{ needs.review_target.outputs.auth_mode == 'subscription' && secrets.CODEX_AUTH_JSON || '' }}",
      OPENAI_API_KEY: '${{ secrets.CODEX_CORRECTNESS_API_KEY || secrets.OPENAI_API_KEY }}',
      CODEX_BASE_URL: '${{ secrets.CODEX_CORRECTNESS_BASE_URL || secrets.CODEX_BASE_URL }}'
    })
    expect(architecture.with).toMatchObject({
      auth_mode: '${{ needs.review_target.outputs.auth_mode }}',
      scope: 'architecture',
      model: "${{ vars.CODEX_ARCHITECTURE_MODEL || vars.CODEX_REVIEW_MODEL || 'gpt-5.6-sol' }}",
      effort: "${{ vars.CODEX_ARCHITECTURE_EFFORT || vars.CODEX_REVIEW_EFFORT || 'high' }}"
    })
    expect(architecture.secrets).toEqual({
      CODEX_AUTH_JSON:
        "${{ needs.review_target.outputs.auth_mode == 'subscription' && secrets.CODEX_AUTH_JSON || '' }}",
      OPENAI_API_KEY: '${{ secrets.CODEX_ARCHITECTURE_API_KEY || secrets.OPENAI_API_KEY }}',
      CODEX_BASE_URL: '${{ secrets.CODEX_ARCHITECTURE_BASE_URL || secrets.CODEX_BASE_URL }}'
    })
  })

  it('bootstraps managed subscription auth on a GitHub-hosted runner', () => {
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

  it('rejects a subscription secret that is not managed ChatGPT auth', () => {
    const result = runAuth({
      authJson: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-wrong-mode' }),
      authMode: 'subscription'
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'Codex subscription auth must be a valid chatgpt auth.json with a refresh token.'
    )
  })

  it('rejects subscription auth outside a manual same-repository review', () => {
    const seed = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-seed' }
    })
    const automatic = runAuth({
      authJson: seed,
      authMode: 'subscription',
      event: 'pull_request_target'
    })
    expect(automatic.status).not.toBe(0)
    expect(automatic.stderr).toContain('manual workflow_dispatch reviews')

    const fork = runAuth({ authJson: seed, authMode: 'subscription', isFork: true })
    expect(fork.status).not.toBe(0)
    expect(fork.stderr).toContain('same-repository pull requests')
  })

  it('uses the API action only for API-key auth and installs the CLI directly for subscription auth', () => {
    const prepareRuntime = getStep(codexWorkflow, 'review', 'Prepare Codex review runtime')
    expect(prepareRuntime.if).toBe("${{ inputs.auth_mode == 'api-key' }}")
    expect(prepareRuntime.with).toMatchObject({
      'codex-home': '${{ steps.codex_auth.outputs.codex_home }}',
      'codex-version': '0.144.6',
      'openai-api-key': "${{ inputs.auth_mode == 'api-key' && secrets.OPENAI_API_KEY || '' }}",
      'responses-api-endpoint': '${{ steps.responses_endpoint.outputs.url }}'
    })
    expect(getStep(codexWorkflow, 'review', 'Resolve Responses API endpoint').if).toBe(
      "${{ inputs.auth_mode == 'api-key' }}"
    )
    const setupNode = getStep(codexWorkflow, 'review', 'Set up Node.js for subscription auth')
    expect(setupNode.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(setupNode.uses).toBe('actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f')
    expect(setupNode.with).toEqual({ 'node-version': '24' })
    const installCli = getStep(codexWorkflow, 'review', 'Install Codex CLI for subscription auth')
    expect(installCli.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(installCli.env).toEqual({ CODEX_VERSION: '0.144.6' })
    expect(installCli.run).toContain('npm install -g "@openai/codex@${CODEX_VERSION}"')
    expect(installCli.run).toContain('codex --version')
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
    expect(sandbox.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(sandbox.run).toContain('kernel.unprivileged_userns_clone')
    expect(sandbox.run).toContain('kernel.apparmor_restrict_unprivileged_userns')
  })

  it('drops sudo and verifies the subscription credential is denied to sandboxed commands', () => {
    const hardening = getStep(codexWorkflow, 'review', 'Harden subscription review runtime')
    expect(hardening.if).toBe("${{ inputs.auth_mode == 'subscription' }}")
    expect(hardening.run).toContain('/etc/sudoers.d/*')
    expect(hardening.run).not.toContain('command -v bwrap')
    expect(hardening.run).toContain('sudo -n true')
    expect(hardening.run).toContain('codex sandbox --permission-profile ai_review')
    expect(hardening.run).toContain('test -r "$CODEX_HOME/auth.json"')
    expect(hardening.run).toContain('test -r "$GITHUB_WORKSPACE/package.json"')
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: hardening.run })
    expect(syntax.status, syntax.stderr).toBe(0)
  })

  it('gives each Codex reviewer a distinct, non-overlapping focus', () => {
    const correctness = runReviewInputs('correctness')
    const architecture = runReviewInputs('architecture')
    expect(correctness.outputs.review_header).toBe('## Codex Correctness Review')
    expect(correctness.instructions).toContain('Branch name valid: true')
    expect(correctness.prompt).toContain('correctness, security, regression')
    expect(architecture.outputs.review_header).toBe('## Codex Architecture Review')
    expect(architecture.instructions).not.toContain('Branch name valid')
    expect(architecture.prompt).toContain('Focus exclusively on architecture and integration')
    expect(architecture.prompt).toContain('IPC ownership')
    expect(correctness.schema).toHaveProperty('properties')
  })

  it('keeps both Codex reviewers static and read-only', () => {
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
          REVIEW_SCOPE: 'architecture',
          GITHUB_STEP_SUMMARY: summary
        }
      }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Codex items: unique=2, tool_calls=1, failed=0')
    expect(result.stdout).toContain('Codex tokens: input=100, cached_input=80')
    const summaryText = readFileSync(summary, 'utf8')
    expect(summaryText).toContain('### Codex architecture review telemetry')
    expect(summaryText).toContain('| 1 | 100 | 80 | 20 | 5 |')
    expect(summaryText).toContain('| `command_execution` | 1 |')
  })

  it('normalizes schema-valid results for either Codex header', async () => {
    await expect(
      normalize(
        JSON.stringify({ verdict: 'mergeable', summary: 'No issues.', findings: [] }),
        '## Codex Architecture Review'
      )
    ).resolves.toContain('## Codex Architecture Review\n\n**Verdict: mergeable**')

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
        '## Codex Correctness Review'
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
        '## Codex Correctness Review'
      )
    ).rejects.toThrow('Codex verdict disagrees with its findings')
  })

  it('publishes each reviewer through the shared trusted workflow', () => {
    expect(mainWorkflow.jobs.post_codex_correctness_feedback.uses).toBe(
      './.github/workflows/ai-post-review.yml'
    )
    expect(mainWorkflow.jobs.post_codex_correctness_feedback.with).toMatchObject({
      scope: 'correctness',
      marker: '<!-- ai-review:codex -->',
      header: '## Codex Correctness Review'
    })
    expect(mainWorkflow.jobs.post_codex_architecture_feedback.with).toMatchObject({
      scope: 'architecture',
      marker: '<!-- ai-review:codex-architecture -->',
      header: '## Codex Architecture Review'
    })
    expect(getStep(publisherWorkflow, 'publish', 'Post Codex review').with?.retries).toBe(3)
  })

  it('publishes architecture feedback with trusted provenance', async () => {
    const result = await runPublisher()
    expect(result.output).toBe('true')
    expect(result.postedBodies).toEqual([
      [
        '<!-- ai-review:codex-architecture -->',
        '<!-- ai-review-meta head=head-sha run=1234 -->',
        '## Codex Architecture Review',
        '',
        '**Verdict: mergeable**'
      ].join('\n')
    ])
  })

  it('does not publish stale feedback or exceed the per-reviewer round limit', async () => {
    await expect(runPublisher({ currentHead: 'newer-head' })).resolves.toMatchObject({
      output: 'false',
      postedBodies: []
    })
    const prior = Array.from({ length: 20 }, () => ({
      body: '<!-- ai-review:codex-architecture -->',
      user: { login: 'github-actions[bot]' }
    }))
    await expect(runPublisher({ comments: prior })).resolves.toMatchObject({
      output: 'false',
      postedBodies: []
    })
  })

  it('serializes each selected reviewer while allowing the two scopes to run in parallel', () => {
    expect(mainWorkflow.concurrency).toEqual({
      group:
        "ai-pr-review-${{ github.event.inputs.pull_request_number || github.event.pull_request.number }}-${{ github.event_name == 'workflow_dispatch' && github.event.inputs.reviewer || 'both' }}",
      'cancel-in-progress': true
    })
    expect(codexWorkflow.jobs.review.concurrency).toEqual({
      group: "${{ format('codex-{0}-review-{1}', inputs.scope, inputs.pull_request_number) }}",
      'cancel-in-progress': true
    })
    expect(mainWorkflow.jobs.codex_correctness_review.needs).toEqual([
      'review_target',
      'codex_review_gate'
    ])
    expect(mainWorkflow.jobs.codex_architecture_review.needs).toEqual([
      'review_target',
      'codex_review_gate'
    ])
  })
})
