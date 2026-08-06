import { describe, expect, it } from 'vitest'

import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime Session Plan composition', () => {
  it('builds a fresh frozen workflow without publishing or requiring Plan capability', async () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): ReturnType<typeof composeAcpRuntimePlanWorkflow> => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const workflow = composeAcpRuntimePlanWorkflow(options, base, session)

      expect(session.publication.getSnapshot().events).toEqual([])
      return workflow
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first)).toBe(true)
    expect(first).not.toBe(second)
    await expect(first.projection('project', 'session')).resolves.toBeNull()
    await expect(
      first.call({ projectId: 'project', sessionId: 'session', operation: 'approve' })
    ).rejects.toThrow('Session Plan capability is not configured.')
    await expect(
      first.respond({ projectId: 'project', sessionId: 'session', feedback: 'continue' })
    ).rejects.toThrow('Session Plan capability is not configured.')
  })
})
