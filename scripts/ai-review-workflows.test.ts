import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

describe('AI review workflow contract', () => {
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

  it('fails closed when review context exceeds the size limit', () => {
    expect(reviewWorkflow).toContain('exit 1')
    expect(reviewWorkflow).not.toContain('head -c 393216 review_context_raw.txt > review_context.txt')
  })
})
