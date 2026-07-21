// Unit tests for the isolated reviewer prompt: it advertises only the scope-bounded MCP evidence tools,
// carries no executable bootstrap/secret, and binds fix-loop dispositions to stable finding ids.

import { describe, expect, it } from 'vitest'

import { buildReviewerPrompt } from './orchestrator'
import type { ReviewCheck, TurnScope } from '../../shared/reviewer'

const scope: TurnScope = {
  turnMessageId: 'msg-1',
  blocks: [
    { id: 'message:msg-1', kind: 'message', sourceId: 'msg-1', blockIndex: 0, contentHash: 'h' }
  ],
  artifactVersionIds: []
}

describe('buildReviewerPrompt — isolated evidence access', () => {
  it('advertises only MCP evidence tools and carries no Bash/Python bootstrap or bearer secret', () => {
    const prompt = buildReviewerPrompt(scope)

    expect(prompt).toContain('read_turn')
    expect(prompt).toContain('query_execution_log')
    expect(prompt).toContain('read_artifact')
    expect(prompt).not.toContain('http://')
    expect(prompt).not.toContain('Bearer')
    expect(prompt).not.toContain('```python')
    expect(prompt).toContain('Do not use Bash')
  })

  it('requires every fix-loop finding to be dispositioned by stable id', () => {
    const tracked: ReviewCheck[] = [
      {
        id: 'finding-stable-1',
        reviewId: 'review-1',
        status: 'fail',
        resolution: 'open',
        claim: 'The count is wrong',
        evidence: 'Output says 3',
        sortIndex: 0,
        reflagCount: 0
      }
    ]
    const prompt = buildReviewerPrompt(scope, tracked)

    expect(prompt).toContain('sourceFindingId')
    expect(prompt).toContain('finding-stable-1')
    expect(prompt).toContain('exactly once')
  })
})
