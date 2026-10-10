import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { AcpPermissionBroker } from './permission-broker'
import { withTrustedMcpToolIdentity } from './permission-policy'

const profile = (selectedProfile: 'ask' | 'auto'): SessionPermissionProfileState => ({
  selectedProfile,
  effectiveProfile: selectedProfile,
  availableModeIds: [],
  autoReviewStrategy: 'conservative',
  fullAccessAvailable: true
})
const request = (action = 'query', callId = 'run-query'): RequestPermissionRequest =>
  withTrustedMcpToolIdentity(
    {
      sessionId: 'session',
      toolCall: {
        toolCallId: callId,
        title: 'background_run',
        rawInput: { action, runId: 'owned-run' },
        _meta: { providerToolName: 'mcp__open-science-notebook__background_run' }
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
      ]
    },
    'open-science-notebook/background_run'
  )
const context = {
  profile: 'auto' as const,
  frameworkId: 'codex' as const,
  autoReviewStrategy: 'conservative' as const,
  mcpServerNames: ['open-science-notebook']
}

describe('Auto operation broker lifecycle', () => {
  it('allows each Run operation once without persisting a wait or remembering approval', async () => {
    const emit = vi.fn()
    const persist = vi.fn()
    const broker = new AcpPermissionBroker(emit, undefined, undefined, undefined, {
      persist,
      settleLive: vi.fn()
    })
    for (const action of ['query', 'cancel']) {
      await expect(broker.requestPermission(request(action, action), context)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
    }
    expect(emit).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(broker.listGrants('session')).toEqual([])
    expect(broker.getPendingRequests()).toEqual([])
  })

  it('uses the committed Ask mode even when the caller captured Auto', async () => {
    const emit = vi.fn()
    const broker = new AcpPermissionBroker(emit)
    broker.setLivePermissionProfile('session', profile('ask'))
    const pending = broker.requestPermission(request(), context)
    expect(emit).toHaveBeenCalledOnce()
    await broker.respond({ requestId: emit.mock.calls[0][0].requestId, optionId: 'deny' })
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(broker.listGrants('session')).toEqual([])
  })

  it('releases an existing Ask wait once on Auto transition and ignores a late human answer', async () => {
    const emit = vi.fn()
    const broker = new AcpPermissionBroker(emit)
    const pending = broker.requestPermission(request(), { ...context, profile: 'ask' })
    const requestId = emit.mock.calls[0][0].requestId
    expect(await broker.applyPermissionProfile('session', profile('auto'))).toEqual([requestId])
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(await broker.respond({ requestId, optionId: 'once' })).toBe(false)
    expect(broker.getPendingRequests()).toEqual([])
    expect(broker.listGrants('session')).toEqual([])
  })

  it('does not revive a stopped wait when Auto is subsequently applied', async () => {
    const emit = vi.fn()
    const broker = new AcpPermissionBroker(emit)
    const pending = broker.requestPermission(request(), { ...context, profile: 'ask' })
    const requestId = emit.mock.calls[0][0].requestId
    broker.cancelAllPending()
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await broker.applyPermissionProfile('session', profile('auto'))).toEqual([])
    expect(await broker.respond({ requestId, optionId: 'once' })).toBe(false)
    expect(broker.listGrants('session')).toEqual([])
  })

  it('does not replace missing single-use approval with persistent permission', async () => {
    const emit = vi.fn()
    const broker = new AcpPermissionBroker(emit)
    const input = request()
    input.options = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }]
    await expect(broker.requestPermission(input, context)).resolves.toEqual({
      outcome: { outcome: 'cancelled' }
    })
    expect(emit).not.toHaveBeenCalled()
    expect(broker.listGrants('session')).toEqual([])
  })
})
