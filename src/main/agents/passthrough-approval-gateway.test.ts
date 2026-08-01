import { describe, expect, it } from 'vitest'

import { passthroughApprovalGateway } from './passthrough-approval-gateway'
import type { ApprovalRequest } from '../../shared/agents-contract'

// The pass-through gateway is the milestone substitution point for the standard Specialist approval
// card. It must always approve, hold no state, and satisfy the ApprovalGateway contract so the
// dispatcher's gateway seam stays a no-op swap target.
describe('passthroughApprovalGateway (issue 08a milestone gateway)', () => {
  it('approves every privileged operation immediately', async () => {
    const requests: ApprovalRequest[] = [
      { operation: 'update', summary: { name: 'Old', newName: 'New' }, session: {} },
      { operation: 'delete', summary: { name: 'Old' }, session: {} },
      { operation: 'switch', summary: { target: 'Bio' }, session: { sessionId: 's' } }
    ]
    for (const request of requests) {
      await expect(passthroughApprovalGateway.decide(request)).resolves.toEqual({
        status: 'approved'
      })
    }
  })

  it('never declines (no pending state, no second approval store)', async () => {
    const result = await passthroughApprovalGateway.decide({
      operation: 'delete',
      summary: { name: 'X' },
      session: {}
    })
    expect(result.status).toBe('approved')
  })
})
