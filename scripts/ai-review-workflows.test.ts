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
})
