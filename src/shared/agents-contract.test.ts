import { describe, expect, it } from 'vitest'

import {
  AGENTS_RESERVED_PARAM_KEYS,
  isAgentsOpName,
  isAgentsParams,
  stripAgentsReservedParams
} from './agents-contract'
import type {
  AgentsApprovedResult,
  AgentsDeclinedResult,
  AgentsRequest,
  ApprovalGateway,
  ApprovalResult,
  PendingSwitch,
  SwitchNotifier,
  TrustedCallingSession
} from './agents-contract'

describe('agents-contract: canonical request/result union', () => {
  it('recognizes every read and write op name', () => {
    const readOps = ['list', 'get', 'list_skills', 'list_connectors'] as const
    const writeOps = [
      'create',
      'update',
      'attach_skill',
      'detach_skill',
      'attach_connector',
      'detach_connector',
      'delete',
      'switch'
    ] as const
    for (const op of [...readOps, ...writeOps]) {
      expect(isAgentsOpName(op)).toBe(true)
    }
  })

  it('rejects unknown op names so the contract stays closed under extension', () => {
    expect(isAgentsOpName('rename')).toBe(false)
    expect(isAgentsOpName('')).toBe(false)
    expect(isAgentsOpName(undefined)).toBe(false)
    expect(isAgentsOpName(42)).toBe(false)
  })

  it('a write request satisfies the AgentsRequest union (compile-time contract)', () => {
    // If the union did not include these ops, this assignment would not type-check.
    const requests: AgentsRequest[] = [
      { op: 'list' },
      { op: 'get', params: { name: 'Bio' } },
      { op: 'list_skills', params: { name_or_id: 'demo' } },
      { op: 'list_connectors', params: {} },
      { op: 'create', params: { name: 'Bio', system_prompt: 'x' } },
      { op: 'update', params: { name: 'Bio', patch: { description: 'y' } } },
      { op: 'delete', params: { name: 'Bio', revision: 3 } },
      { op: 'switch', params: { name: null } },
      { op: 'attach_skill', params: { name: 'Bio', skill_ref: 'demo', revision: 3 } },
      { op: 'detach_skill', params: { name: 'Bio', skill_ref: 'demo', revision: 3 } },
      { op: 'attach_connector', params: { name: 'Bio', connector_ref: 'cust-1', revision: 3 } },
      { op: 'detach_connector', params: { name: 'Bio', connector_ref: 'cust-1', revision: 3 } }
    ]
    expect(requests).toHaveLength(12)
  })

  it('isAgentsParams narrows plain objects and rejects null/arrays/primitives', () => {
    expect(isAgentsParams({})).toBe(true)
    expect(isAgentsParams({ a: 1 })).toBe(true)
    expect(isAgentsParams(null)).toBe(false)
    expect(isAgentsParams(undefined)).toBe(false)
    expect(isAgentsParams([1, 2])).toBe(false)
    expect(isAgentsParams('x')).toBe(false)
  })
})

describe('agents-contract: reserved-param stripping', () => {
  it('removes every reserved routing/identity/switch key', () => {
    const params = {
      op: 'list_skills',
      session_id: 'forged-session',
      sessionId: 'forged-session-camel',
      turn_id: 'forged-turn',
      turnId: 'forged-turn-camel',
      generation: 999,
      control_invocation_generation: 999,
      controlInvocationGeneration: 999,
      tool_invocation_id: 'forged-tool',
      toolInvocationId: 'forged-tool-camel',
      specialist_id: 'forged-specialist',
      target_specialist_id: 'forged-target',
      targetSpecialistId: 'forged-target-camel',
      reconfigure: true,
      context_reset: true,
      contextReset: true,
      name_or_id: 'demo'
    }
    const stripped = stripAgentsReservedParams(params)
    expect(stripped).toEqual({ name_or_id: 'demo' })
    for (const key of AGENTS_RESERVED_PARAM_KEYS) {
      expect(stripped).not.toHaveProperty(key)
    }
  })

  it('leaves caller-supplied snake_case method params untouched', () => {
    const stripped = stripAgentsReservedParams({
      name: 'Bio',
      system_prompt: 'instructions',
      skill_names: ['demo']
    })
    expect(stripped).toEqual({
      name: 'Bio',
      system_prompt: 'instructions',
      skill_names: ['demo']
    })
  })

  it('handles an empty params object', () => {
    expect(stripAgentsReservedParams({})).toEqual({})
  })
})

describe('agents-contract: approval result shape', () => {
  it('the declined result carries the exact { status, operation } shape (PRD:137 / design:242)', () => {
    const declined: AgentsDeclinedResult = { status: 'declined', operation: 'switch' }
    expect(declined.status).toBe('declined')
    expect(declined.operation).toBe('switch')
    // operation is exactly the privileged-op set; no other value type-checks.
    const operations: AgentsDeclinedResult['operation'][] = ['update', 'delete', 'switch']
    expect(operations).toEqual(['update', 'delete', 'switch'])
  })

  it('the approved result has only a status field', () => {
    const approved: AgentsApprovedResult = { status: 'approved' }
    expect(approved.status).toBe('approved')
  })

  it('an ApprovalResult can be either branch', () => {
    const results: ApprovalResult[] = [
      { status: 'approved' },
      { status: 'declined', operation: 'delete' },
      { status: 'declined', operation: 'switch', reason: 'user said no' }
    ]
    expect(results[0].status).toBe('approved')
    expect(results[1].status).toBe('declined')
  })
})

describe('agents-contract: fakes satisfy the injected seams (develop against fakes)', () => {
  // This is the "develop against fakes in parallel" criterion: a downstream module implements
  // both the approval gateway and the switch notifier as plain objects and they type-check against
  // the shared interfaces — no real behavior required.
  it('a fake ApprovalGateway and SwitchNotifier satisfy their interfaces', async () => {
    const fakeGateway: ApprovalGateway = {
      decide: async () => ({ status: 'approved' })
    }
    const notified: PendingSwitch[] = []
    const fakeNotifier: SwitchNotifier = {
      notify: (pending) => {
        notified.push(pending)
      }
    }

    const decision = await fakeGateway.decide({
      operation: 'switch',
      summary: { target: 'Bio' },
      session: { sessionId: 'trusted-session' }
    })
    expect(decision.status).toBe('approved')

    await fakeNotifier.notify({
      sessionId: 'trusted-session',
      targetName: 'Bio'
    })
    expect(notified).toEqual([{ sessionId: 'trusted-session', targetName: 'Bio' }])
  })

  it('a fake gateway can decline with the structured shape', async () => {
    const fakeGateway: ApprovalGateway = {
      decide: async () => ({ status: 'declined', operation: 'switch', reason: 'nope' })
    }
    const decision = await fakeGateway.decide({
      operation: 'switch',
      summary: {},
      session: { sessionId: 's' } satisfies TrustedCallingSession
    })
    expect(decision).toEqual({ status: 'declined', operation: 'switch', reason: 'nope' })
  })
})
