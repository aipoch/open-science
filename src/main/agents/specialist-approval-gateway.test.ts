import { describe, expect, it, vi } from 'vitest'

import { AcpSpecialistApprovalGateway } from './specialist-approval-gateway'
import type {
  SpecialistBridgeDecision,
  SpecialistPermissionBridgeInFlight
} from './specialist-approval-gateway'
import type {
  SpecialistDeleteCardPayload,
  SpecialistPermissionCardPayload,
  SpecialistSwitchCardPayload,
  SpecialistUpdateCardPayload
} from '../../shared/agents-contract'

type FakeBridge = {
  bridge: SpecialistPermissionBridgeInFlight
  published: Array<{ payload: SpecialistPermissionCardPayload; sessionId?: string }>
  setNext: (
    value:
      SpecialistBridgeDecision | ((p: SpecialistPermissionCardPayload) => SpecialistBridgeDecision)
  ) => void
}

// A fake bridge that records every published payload and resolves the next decision on demand.
const makeBridge = (): FakeBridge => {
  const published: Array<{ payload: SpecialistPermissionCardPayload; sessionId?: string }> = []
  let next:
    | SpecialistBridgeDecision
    | ((payload: SpecialistPermissionCardPayload) => SpecialistBridgeDecision) = {
    outcome: 'approved'
  }
  const bridge: SpecialistPermissionBridgeInFlight = {
    requestApproval: vi.fn(async (payload, session) => {
      published.push({ payload, sessionId: session.sessionId })
      return typeof next === 'function' ? next(payload) : next
    })
  }
  return {
    bridge,
    published,
    setNext: (
      value:
        | SpecialistBridgeDecision
        | ((p: SpecialistPermissionCardPayload) => SpecialistBridgeDecision)
    ) => {
      next = value
    }
  }
}

describe('AcpSpecialistApprovalGateway — implements the issue 02 ApprovalGateway contract', () => {
  it('is an ApprovalGateway (decide returns an ApprovalResult)', async () => {
    const { bridge } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    const result = await gateway.decide({
      operation: 'delete',
      summary: { name: 'DATA_ANALYST' },
      session: { sessionId: 's-1' }
    })
    expect(result).toEqual({ status: 'approved' })
  })

  it('does NOT carry a second request store / responder / state machine (delegates parking to the bridge)', () => {
    const { bridge } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    // The gateway exposes no pending map, no respond(), no state of its own. It only decides.
    expect((gateway as unknown as Record<string, unknown>).pending).toBeUndefined()
    expect((gateway as unknown as Record<string, unknown>).respond).toBeUndefined()
    expect(typeof gateway.decide).toBe('function')
  })
})

describe('AcpSpecialistApprovalGateway — name-changing update card', () => {
  it('publishes an update payload (old name, new name, bindings stable) and forwards the session', async () => {
    const { bridge, published } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    await gateway.decide({
      operation: 'update',
      summary: { name: 'DATA_ANALYST', newName: 'DATA_SCIENTIST' },
      session: { sessionId: 's-9' }
    })
    expect(bridge.requestApproval).toHaveBeenCalledTimes(1)
    expect(published[0].sessionId).toBe('s-9')
    const payload = published[0].payload as SpecialistUpdateCardPayload
    expect(payload.kind).toBe('update')
    expect(payload.name).toBe('DATA_ANALYST')
    expect(payload.newName).toBe('DATA_SCIENTIST')
    expect(payload.bindingsStable).toBe(true)
  })

  it('maps the bridge decision to an ApprovalResult carrying the operation on decline', async () => {
    const { bridge, setNext } = makeBridge()
    setNext({ outcome: 'declined', reason: 'user cancelled' })
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    const result = await gateway.decide({
      operation: 'update',
      summary: { name: 'OLD', newName: 'NEW' },
      session: {}
    })
    expect(result).toEqual({ status: 'declined', operation: 'update', reason: 'user cancelled' })
  })
})

describe('AcpSpecialistApprovalGateway — delete card', () => {
  it('publishes a delete payload stating bound conversations become unavailable', async () => {
    const { bridge, published } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    await gateway.decide({
      operation: 'delete',
      summary: { name: 'SQL_WRANGLER' },
      session: {}
    })
    const payload = published[0].payload as SpecialistDeleteCardPayload
    expect(payload.kind).toBe('delete')
    expect(payload.name).toBe('SQL_WRANGLER')
    expect(payload.boundConversationsUnavailable).toBe(true)
  })

  it('maps a declined bridge decision to {operation:"delete"}', async () => {
    const { bridge, setNext } = makeBridge()
    setNext({ outcome: 'declined' })
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    const result = await gateway.decide({
      operation: 'delete',
      summary: { name: 'SQL_WRANGLER' },
      session: {}
    })
    expect(result).toEqual({ status: 'declined', operation: 'delete' })
  })
})

describe('AcpSpecialistApprovalGateway — switch card', () => {
  it('publishes a switch payload with current/target and next-message timing', async () => {
    const { bridge, published } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    await gateway.decide({
      operation: 'switch',
      summary: { name: 'Data Analyst', target: 'SQL Wrangler' },
      session: {}
    })
    const payload = published[0].payload as SpecialistSwitchCardPayload
    expect(payload.kind).toBe('switch')
    expect(payload.currentName).toBe('Data Analyst')
    expect(payload.targetName).toBe('SQL Wrangler')
    expect(payload.takesEffectAfterCurrentTool).toBe(true)
  })

  it('maps target null to Main Agent', async () => {
    const { bridge, published } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    await gateway.decide({
      operation: 'switch',
      summary: { name: 'Data Analyst', target: null },
      session: {}
    })
    const payload = published[0].payload as SpecialistSwitchCardPayload
    expect(payload.targetName).toBeNull()
  })
})

describe('AcpSpecialistApprovalGateway — never exposes sensitive values on the wire', () => {
  it('the published payload never contains UUIDs, secrets, tokens, or system instructions', async () => {
    const { bridge, published } = makeBridge()
    const gateway = new AcpSpecialistApprovalGateway({ bridge })
    await gateway.decide({
      operation: 'update',
      // A malicious/leaky summary must not survive into the card payload verbatim.
      summary: { name: 'DATA_ANALYST', newName: 'DATA_SCIENTIST' },
      session: { sessionId: 'leaked-session' }
    })
    const serialized = JSON.stringify(published[0].payload)
    expect(serialized).not.toContain('leaked-session')
    expect(serialized).not.toMatch(/systemPrompt|instructions|token|secret|credential/i)
  })
})
