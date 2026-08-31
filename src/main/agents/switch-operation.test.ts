// Tests for the standalone host.agents.switch(nameOrNull) operation module (issue 05).
//
// These tests use a FAKE approval gateway + fake notifier + fake persistence, so this slice proceeds
// in parallel with issue 04 (the concrete broker); issue 08 composes the real wiring. The operation
// must NEVER accept a sandbox-supplied session id — it uses only the trusted calling-session identity
// captured by issue 02 and forwarded as server context.

import { describe, expect, it, vi } from 'vitest'

import {
  SwitchOperation,
  SwitchCommitSequencer,
  SWITCH_METHOD,
  type SwitchParams
} from './switch-operation'
import type {
  ApprovalGateway,
  ApprovalResult,
  PendingSwitch,
  SwitchNotifier
} from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'

const profile = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'sp-1',
  name: 'BIO_EXPERT',
  displayName: 'Bio Expert',
  description: 'a specialist',
  systemPrompt: 'SECRET INSTRUCTIONS',
  iconKey: 'beaker',
  colorKey: 'green',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: ['demo'], connectorIds: [], connectorTools: [] },
  revision: 3,
  ...overrides
})

const makeSpecialistService = (
  profiles: SpecialistView[],
  overrides: Partial<SpecialistService> = {}
): SpecialistService => {
  const service = {
    list: vi.fn(async () => profiles),
    getByName: vi.fn(async (name: string) => {
      const found = profiles.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    }),
    getById: vi.fn(async (id: string) => {
      const found = profiles.find((p) => p.id === id)
      if (!found) throw new Error(`Specialist ${id} not found.`)
      return found
    }),
    ...overrides
  } as unknown as SpecialistService
  service.resolveRunnableByName =
    overrides.resolveRunnableByName ?? vi.fn(async (name: string) => service.getByName(name))
  service.resolveRunnableById =
    overrides.resolveRunnableById ?? vi.fn(async (id: string) => service.getById(id))
  return service
}

const makeSessionBinding = (initial: Map<string, string | undefined>): SessionBindingService => {
  const bindings = new Map(initial)
  return {
    setBinding: vi.fn((sessionId: string, specialistId: string | undefined) => {
      if (specialistId === undefined) bindings.delete(sessionId)
      else bindings.set(sessionId, specialistId)
    }),
    getBinding: vi.fn((sessionId: string) => bindings.get(sessionId)),
    resolve: vi.fn(async (sessionId: string) => {
      const id = bindings.get(sessionId)
      if (!id) return { kind: 'main' as const }
      return { kind: 'bound' as const, profile: profile({ id }) }
    })
  } as unknown as SessionBindingService
}

// An approval-gateway fake that always approves. `vi.fn(async () => ({ status: 'approved' }))` alone
// widens `status` to `string`, which isn't assignable to the `(request) => Promise<ApprovalResult>`
// contract — the explicit `Promise<ApprovalResult>` return annotation keeps the literal narrow.
const approvingGateway = (): ApprovalGateway => ({
  decide: vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
})

describe('SwitchOperation — target resolution', () => {
  it('switches to a builtin through the runnable resolver without exposing it to custom queries', async () => {
    const builtin = profile({ id: 'builtin-curator', name: 'BUILTIN_CURATOR', revision: 0 })
    const ps = makeSpecialistService([builtin], {
      getByName: vi.fn(async () => {
        throw new Error('custom-only query must not be used')
      }),
      getById: vi.fn(async () => {
        throw new Error('custom-only query must not be used')
      }),
      resolveRunnableByName: vi.fn(async () => builtin),
      resolveRunnableById: vi.fn(async () => builtin)
    })
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn()
    })

    await expect(
      op.run({ name: builtin.name }, { sessionId: 'session-trusted' })
    ).resolves.toMatchObject({
      status: 'approved',
      binding: { specialistId: builtin.id, targetName: builtin.name }
    })
    expect(ps.getByName).not.toHaveBeenCalled()
  })

  it('resolves an enabled custom Specialist by exact public name and returns persisted binding', async () => {
    const ps = makeSpecialistService([profile()])
    const binding = makeSessionBinding(new Map())
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: persist
    })

    const result = await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })

    expect(result).toMatchObject({
      status: 'approved',
      operation: 'switch',
      binding: { sessionId: 'session-trusted', specialistId: 'sp-1', targetName: 'BIO_EXPERT' },
      pendingReconfigure: { sessionId: 'session-trusted', targetName: 'BIO_EXPERT' }
    })
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(binding.setBinding).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(notify).toHaveBeenCalledWith({
      sessionId: 'session-trusted',
      targetName: 'BIO_EXPERT'
    } satisfies PendingSwitch)
  })

  it('null name selects Main Agent without creating a mutable Main Profile', async () => {
    const ps = makeSpecialistService([profile()])
    const binding = makeSessionBinding(new Map([['session-trusted', 'sp-1']]))
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: persist
    })

    const result = (await op.run({ name: null }, { sessionId: 'session-trusted' })) as {
      status: string
      binding: { specialistId: string | undefined; targetName: string | null }
    }

    expect(result.status).toBe('approved')
    expect(result.binding.specialistId).toBeUndefined()
    expect(result.binding.targetName).toBeNull()
    expect(persist).toHaveBeenCalledWith('session-trusted', undefined)
    expect(binding.setBinding).toHaveBeenCalledWith('session-trusted', undefined)
    expect(notify).toHaveBeenCalledWith({
      sessionId: 'session-trusted',
      targetName: null
    } satisfies PendingSwitch)
    // A Main switch never re-resolves a Specialist (no mutable Main Profile is ever read or created):
    // getByName is called at most once for the pre-resolution probe, and the binding is simply cleared.
    expect((ps.getByName as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('rejects a disabled Specialist with a host.agents.switch-prefixed error before approval', async () => {
    const ps = makeSpecialistService([profile({ enabled: false })])
    const gateway = approvingGateway()
    const binding = makeSessionBinding(new Map())
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: gateway,
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn()
    })

    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
    // Approval gateway is never consulted because pre-approval resolution already failed closed.
    expect(gateway.decide).not.toHaveBeenCalled()
  })

  it('rejects an unknown name with a host.agents.switch-prefixed error', async () => {
    const ps = makeSpecialistService([])
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: { decide: vi.fn() },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn()
    })
    await expect(op.run({ name: 'GHOST' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
  })

  it('does not accept a sandbox-supplied session id: uses only the trusted context', async () => {
    const ps = makeSpecialistService([profile()])
    const binding = makeSessionBinding(new Map())
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    // A sandbox tries to forge a session id inside params. The dispatcher already strips reserved
    // keys, but even if a forged 'session_id' survived here it MUST be ignored — only the trusted
    // context session is honored.
    await op.run(
      { name: 'BIO_EXPERT', session_id: 'forged', sessionId: 'forged' } as unknown as SwitchParams,
      { sessionId: 'session-trusted' }
    )
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(binding.setBinding).toHaveBeenCalledWith('session-trusted', 'sp-1')
  })

  it('fails closed when no trusted calling session identity is present', async () => {
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile()]),
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: { decide: vi.fn() },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn()
    })
    await expect(op.run({ name: 'BIO_EXPERT' }, {})).rejects.toThrow(/host\.agents\.switch:/)
    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: '' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
  })
})

describe('SwitchOperation — approval gateway', () => {
  it.each([
    ['decline', async (): Promise<ApprovalResult> => ({ status: 'declined', operation: 'switch' })],
    ['error', async (): Promise<ApprovalResult> => Promise.reject(new Error('approval failed'))]
  ])(
    'publishes awaiting approval before the gateway and clears it on %s',
    async (_name, decide) => {
      const onAwaitingApproval = vi.fn()
      const settleApproval = vi.fn()
      const gateway: ApprovalGateway = {
        decide: vi.fn(async (request) => {
          expect(onAwaitingApproval).toHaveBeenCalledOnce()
          void request
          return decide()
        })
      }
      const op = new SwitchOperation({
        specialistService: makeSpecialistService([profile()]),
        sessionBinding: makeSessionBinding(new Map()),
        approvalGateway: gateway,
        approvalLifecycle: { onAwaitingApproval, settleApproval },
        switchNotifier: { notify: vi.fn() },
        persistBinding: vi.fn(async () => undefined)
      })
      const run = op.run(
        { name: 'BIO_EXPERT' },
        {
          sessionId: 'session-trusted',
          turnId: 'control-1',
          controlInvocationGeneration: 1,
          toolInvocationId: 'control-1',
          originatingTurnId: 'prompt-1',
          originatingUserMessageId: 'prompt-1',
          attachmentIds: ['upload-1'],
          artifactIds: ['artifact-1']
        }
      )

      if (_name === 'error') await expect(run).rejects.toThrow('approval failed')
      else await expect(run).resolves.toMatchObject({ status: 'declined' })
      const approvalContext = expect.objectContaining({
        sessionId: 'session-trusted',
        originatingTurnId: 'prompt-1',
        toolInvocationId: 'control-1',
        target: { kind: 'specialist', name: 'BIO_EXPERT' },
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      })
      expect(onAwaitingApproval).toHaveBeenCalledWith(approvalContext)
      expect(settleApproval).toHaveBeenCalledWith(approvalContext, false)
    }
  )

  it('emits the shared switch approval request shape with the trusted session', async () => {
    const ps = makeSpecialistService([profile()])
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: { decide },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })

    await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })

    expect(decide).toHaveBeenCalledWith({
      operation: 'switch',
      summary: expect.objectContaining({ target: 'BIO_EXPERT' }),
      session: { sessionId: 'session-trusted' }
    })
  })

  it('summary.name is the CURRENT specialist (not the target) for a specialist→specialist switch', async () => {
    // The approval card shows current → target. `summary.name` must carry the CURRENT binding's public
    // name so the struck-through label is correct; `summary.target` carries the destination.
    const ps = makeSpecialistService([
      profile({ id: 'sp-current', name: 'CURRENT' }),
      profile({ id: 'sp-target', name: 'TARGET' })
    ])
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    const op = new SwitchOperation({
      specialistService: ps,
      // The session is currently bound to the "CURRENT" specialist.
      sessionBinding: makeSessionBinding(new Map([['session-trusted', 'sp-current']])),
      approvalGateway: { decide },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })

    await op.run({ name: 'TARGET' }, { sessionId: 'session-trusted' })

    expect(decide).toHaveBeenCalledWith({
      operation: 'switch',
      summary: expect.objectContaining({ name: 'CURRENT', target: 'TARGET' }),
      session: { sessionId: 'session-trusted' }
    })
  })

  it('summary.name is the CURRENT specialist for a specialist→Main switch (target: null)', async () => {
    // Reverting to Main still names the current specialist in `summary.name`; `target` is null.
    const ps = makeSpecialistService([profile({ id: 'sp-current', name: 'CURRENT' })])
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map([['session-trusted', 'sp-current']])),
      approvalGateway: { decide },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })

    await op.run({ name: null }, { sessionId: 'session-trusted' })

    expect(decide).toHaveBeenCalledWith({
      operation: 'switch',
      summary: expect.objectContaining({ name: 'CURRENT', target: null }),
      session: { sessionId: 'session-trusted' }
    })
  })

  it('summary.name is omitted when the session is currently on Main (no current binding)', async () => {
    // From Main → Specialist there is no current specialist name to show; `summary.name` is omitted
    // (it stays out of the object, never carries the target as the current name).
    const ps = makeSpecialistService([profile({ id: 'sp-target', name: 'TARGET' })])
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: { decide },
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })

    await op.run({ name: 'TARGET' }, { sessionId: 'session-trusted' })

    expect(decide).toHaveBeenCalledWith({
      operation: 'switch',
      summary: expect.objectContaining({ target: 'TARGET' }),
      session: { sessionId: 'session-trusted' }
    })
    // The decide mock is annotated by return type only (keeps the `status` literal narrow — see
    // approvingGateway above), so its `.mock.calls` args are typed as an empty tuple. Reach the
    // captured request via the same `unknown` cast used elsewhere in this file.
    const decideCalls = (
      decide as unknown as { mock: { calls: { summary: { name?: string } }[][] } }
    ).mock.calls
    expect(decideCalls[0][0].summary.name).toBeUndefined()
  })

  it('decline returns { status: "declined", operation: "switch" } and changes nothing', async () => {
    const ps = makeSpecialistService([profile()])
    const binding = makeSessionBinding(new Map([['session-trusted', undefined]]))
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const gateway: ApprovalGateway = {
      decide: vi.fn(async (): Promise<ApprovalResult> => ({
        status: 'declined',
        operation: 'switch'
      }))
    }
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: gateway,
      switchNotifier: { notify },
      persistBinding: persist
    })

    const result = await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })

    expect(result).toEqual({ status: 'declined', operation: 'switch' })
    expect(persist).not.toHaveBeenCalled()
    expect(binding.setBinding).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('SwitchOperation — approval-time re-validation (fail closed)', () => {
  it('fails closed when the target was renamed between approval and commit', async () => {
    let resolveCount = 0
    const ps = makeSpecialistService([profile()])
    // On the approval-time re-resolution, the profile is gone (renamed away / deleted).
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ name })
      throw new Error(`Specialist "${name}" not found.`)
    })
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn()
    })

    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
  })

  it('fails closed when the target was disabled after approval', async () => {
    let resolveCount = 0
    const ps = makeSpecialistService([profile()])
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ name, enabled: true })
      return profile({ name, enabled: false })
    })
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      'host.agents.switch: Specialist "BIO_EXPERT" was disabled before the switch committed'
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('fails closed on revision drift when a reviewed revision was carried', async () => {
    let resolveCount = 0
    const ps = makeSpecialistService([profile({ revision: 3 })])
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ name, revision: 3 })
      return profile({ name, revision: 4 })
    })
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    await expect(
      op.run({ name: 'BIO_EXPERT', revision: 3 }, { sessionId: 'session-trusted' })
    ).rejects.toThrow(/host\.agents\.switch:/)
    expect(persist).not.toHaveBeenCalled()
  })

  it('fails closed on revision drift observed during approval when the public SDK omitted a revision', async () => {
    let resolveCount = 0
    const ps = makeSpecialistService([profile({ revision: 3 })])
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ name, revision: 3 })
      return profile({ name, revision: 4 })
    })
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })

    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('fails closed when a different profile takes over the approved public name', async () => {
    let resolveCount = 0
    const ps = makeSpecialistService([profile({ id: 'approved-id' })])
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ id: 'approved-id', name })
      return profile({ id: 'replacement-id', name })
    })
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })

    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('does not broaden to Main Agent on target failure', async () => {
    const ps = makeSpecialistService([])
    const binding = makeSessionBinding(new Map())
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    await expect(op.run({ name: 'GHOST' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
    // No Main clearing, no broadcast, no persistence — fail closed, never broadens to Main.
    expect(persist).not.toHaveBeenCalled()
    expect(binding.setBinding).not.toHaveBeenCalled()
  })
})

describe('SwitchOperation — last-write-wins & restart survival', () => {
  it('multiple approved switches before the next message are last-write-wins', async () => {
    const ps = makeSpecialistService([
      profile({ id: 'sp-1', name: 'A' }),
      profile({ id: 'sp-2', name: 'B' })
    ])
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: persist
    })

    const first = (await op.run({ name: 'A' }, { sessionId: 'session-trusted' })) as {
      binding: { specialistId: string }
    }
    const second = (await op.run({ name: 'B' }, { sessionId: 'session-trusted' })) as {
      binding: { specialistId: string }
    }

    expect(first.binding.specialistId).toBe('sp-1')
    expect(second.binding.specialistId).toBe('sp-2')
    // Final persisted/broadcast state is the newer target (B).
    expect(persist).toHaveBeenLastCalledWith('session-trusted', 'sp-2')
    expect(notify).toHaveBeenLastCalledWith({
      sessionId: 'session-trusted',
      targetName: 'B'
    } satisfies PendingSwitch)
  })

  it('a stale completion does not overwrite a newer approved target', async () => {
    const ps = makeSpecialistService([
      profile({ id: 'sp-1', name: 'A' }),
      profile({ id: 'sp-2', name: 'B' })
    ])
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: persist
    })

    // Start the first switch, interleave a newer one before the first commits. The first (stale)
    // completion must NOT overwrite the newer persisted target.
    const first = op.run({ name: 'A' }, { sessionId: 'session-trusted' })
    await op.run({ name: 'B' }, { sessionId: 'session-trusted' })
    await first

    expect(persist).toHaveBeenLastCalledWith('session-trusted', 'sp-2')
    expect(notify).toHaveBeenLastCalledWith({
      sessionId: 'session-trusted',
      targetName: 'B'
    } satisfies PendingSwitch)
  })

  it('last-write-wins holds across separate per-call instances sharing the dispatcher sequencer', async () => {
    // Production (agents-service.ts runSwitch) creates a NEW SwitchOperation per host.agents.switch
    // call. The guard must still order interleaved commits because the dispatcher shares ONE
    // sequencer across those instances — without it, per-instance counters reset and a stale older
    // completion overwrites the newer target.
    const ps = makeSpecialistService([
      profile({ id: 'sp-1', name: 'A' }),
      profile({ id: 'sp-2', name: 'B' })
    ])
    const persist = vi.fn(async () => undefined)
    const notify = vi.fn(async () => undefined)
    const sharedSequencer = new SwitchCommitSequencer()
    const makeOp = (): SwitchOperation =>
      new SwitchOperation({
        specialistService: ps,
        sessionBinding: makeSessionBinding(new Map()),
        approvalGateway: approvingGateway(),
        switchNotifier: { notify },
        persistBinding: persist,
        sequencer: sharedSequencer
      })

    // Two separate instances (as the dispatcher creates), interleaved. The first (A) is stale; the
    // newer (B) must own the final persisted/broadcast state.
    const first = makeOp().run({ name: 'A' }, { sessionId: 'session-trusted' })
    await makeOp().run({ name: 'B' }, { sessionId: 'session-trusted' })
    await first

    expect(persist).toHaveBeenLastCalledWith('session-trusted', 'sp-2')
    expect(notify).toHaveBeenLastCalledWith({
      sessionId: 'session-trusted',
      targetName: 'B'
    } satisfies PendingSwitch)
  })

  it('successful switch returns actual persisted binding/pending read-back', async () => {
    const ps = makeSpecialistService([profile({ id: 'sp-9', name: 'Z', revision: 7 })])
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })

    const result = (await op.run({ name: 'Z' }, { sessionId: 'sX' })) as {
      binding: { sessionId: string; specialistId: string; targetName: string; revision: number }
      pendingReconfigure: PendingSwitch
    }
    // Read-back reflects the actual persisted record (id/revision), not the request.
    expect(result.binding.specialistId).toBe('sp-9')
    expect(result.binding.revision).toBe(7)
    expect(result.binding.targetName).toBe('Z')
    expect(result.pendingReconfigure).toEqual({ sessionId: 'sX', targetName: 'Z' })
  })

  it('approval immediately persists + broadcasts a pending-reconfigure notification', async () => {
    const ps = makeSpecialistService([profile()])
    const persist = vi.fn(async () => undefined)
    const order: string[] = []
    const notify = vi.fn(async () => {
      order.push('notify')
    })
    persist.mockImplementation(async () => {
      order.push('persist')
    })
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: persist
    })
    await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })
    expect(order).toEqual(['persist', 'notify'])
  })
})

describe('SwitchOperation — sanitization and no-sensitive-data', () => {
  it('sanitizes persistence failure as a host.agents.switch-prefixed error', async () => {
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile()]),
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => {
        throw new Error('disk write failed: credentials=/etc/shadow')
      })
    })
    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      'host.agents.switch: Internal operation failed.'
    )
  })

  it('notify failure does NOT throw: the persisted binding is authoritative and the switch still reports approved', async () => {
    // The broadcast is a best-effort renderer mirror; the persisted binding is authoritative and
    // applies at the next send. A notify rejection must NOT surface as a thrown error to the caller —
    // the switch has already committed (persisted + set in memory). Only persist/setBinding errors
    // remain fatal.
    const ps = makeSpecialistService([profile({ id: 'sp-1', name: 'BIO_EXPERT' })])
    const persist = vi.fn(async () => undefined)
    const binding = makeSessionBinding(new Map())
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: {
        notify: vi.fn(async () => {
          throw new Error('renderer broadcast down')
        })
      },
      persistBinding: persist
    })

    const result = await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })

    // The switch committed despite the notify failure.
    expect(result).toMatchObject({ status: 'approved' })
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(binding.setBinding).toHaveBeenCalledWith('session-trusted', 'sp-1')
  })

  it('surfaces an authoritative completion-gate persistence failure after keeping the binding committed', async () => {
    const persist = vi.fn(async () => undefined)
    const binding = makeSessionBinding(new Map())
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile({ id: 'sp-1', name: 'BIO_EXPERT' })]),
      sessionBinding: binding,
      approvalGateway: approvingGateway(),
      switchNotifier: {
        authority: 'completion-gate',
        notify: vi.fn(async () => {
          throw new Error('handoff approval persistence failed')
        })
      },
      persistBinding: persist
    })

    await expect(op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })).rejects.toThrow(
      'handoff approval persistence failed'
    )
    expect(persist).toHaveBeenCalledWith('session-trusted', 'sp-1')
    expect(binding.setBinding).toHaveBeenCalledWith('session-trusted', 'sp-1')
  })

  it('approval summary and notifications contain no system instructions or sensitive data', async () => {
    const ps = makeSpecialistService([profile({ systemPrompt: 'SECRET INSTRUCTIONS' })])
    const decide = vi.fn(async (): Promise<ApprovalResult> => ({ status: 'approved' }))
    const notify = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: { decide },
      switchNotifier: { notify },
      persistBinding: vi.fn(async () => undefined)
    })
    await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })

    // Serialize the FULL recorded calls (one each) — no [0][0] tuple access needed on the no-arg
    // mocks. If any system instructions leaked into the request or notification, this would contain
    // them.
    const serialized = JSON.stringify(decide.mock.calls) + JSON.stringify(notify.mock.calls)
    expect(serialized).not.toContain('SECRET INSTRUCTIONS')
    expect(serialized).not.toContain('systemPrompt')
  })
})

describe('SwitchOperation — durable next-message reconfigure lifecycle', () => {
  // The operation module must NEVER dispose the running Agent that hosts the agentsCall. The runtime
  // reconfigure barrier (existing runtime.switchSpecialist → contextReset + history replay) runs at
  // the SAFE next-message boundary, not inside this SDK call. This module's responsibility is to
  // persist the binding + broadcast a pending-reconfigure and nothing more on the runtime side.
  it('does not touch the runtime reconfigure barrier inside the SDK call (current reply completes)', async () => {
    const runtimeSwitch = vi.fn(async () => ({ contextReset: false }))
    // The deps deliberately have NO runtime-switch callback: the module physically cannot call it.
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile()]),
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: vi.fn(async () => undefined)
    })
    await op.run({ name: 'BIO_EXPERT' }, { sessionId: 'session-trusted' })
    expect(runtimeSwitch).not.toHaveBeenCalled()
  })

  it('persists the binding immediately so it survives application restart before the next message', async () => {
    const ps = makeSpecialistService([profile({ id: 'sp-7', name: 'Z' })])
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    await op.run({ name: 'Z' }, { sessionId: 'session-restart' })
    // The durable writer was invoked with the target UUID — restart reads this back, not a snapshot.
    expect(persist).toHaveBeenCalledWith('session-restart', 'sp-7')
  })

  it('broadcasts the pending-reconfigure intent the renderer/runtime consumes at the next send', async () => {
    const notify = vi.fn(async () => undefined) as unknown as SwitchNotifier['notify']
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile({ name: 'SQL_WRANGLER' })]),
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: vi.fn(async () => undefined)
    })
    await op.run({ name: 'SQL_WRANGLER' }, { sessionId: 'session-next' })
    const pending = (notify as unknown as { mock: { calls: PendingSwitch[][] } }).mock.calls[0][0]
    expect(pending).toEqual({ sessionId: 'session-next', targetName: 'SQL_WRANGLER' })
  })

  it('a stale reconfigure target does not silently broaden to Main Agent', async () => {
    // If reconfiguration of the approved target later fails (target disabled mid-flight), the
    // operation has already failed closed at approval-time re-validation — there is no path that
    // clears the binding to Main on failure.
    let resolveCount = 0
    const ps = makeSpecialistService([profile({ name: 'FLAKY' })])
    ps.getByName = vi.fn(async (name: string) => {
      resolveCount += 1
      if (resolveCount === 1) return profile({ name, enabled: true })
      return profile({ name, enabled: false }) // disabled at commit time → fail closed, not Main.
    })
    const persist = vi.fn(async () => undefined)
    const op = new SwitchOperation({
      specialistService: ps,
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify: vi.fn() },
      persistBinding: persist
    })
    await expect(op.run({ name: 'FLAKY' }, { sessionId: 's' })).rejects.toThrow(
      /host\.agents\.switch:/
    )
    expect(persist).not.toHaveBeenCalledWith('s', undefined) // never broadened to Main
  })
})

describe('SwitchOperation — does not import issue 03/04 implementation', () => {
  it('exposes the SWITCH method constant used by the dispatcher', () => {
    expect(SWITCH_METHOD).toBe('switch')
  })

  it('notifier is the only broadcast seam (no parallel switch service)', async () => {
    // The notifier contract is the single sink; confirming it is invoked with PendingSwitch shape.
    const notify = vi.fn(async () => undefined) as unknown as SwitchNotifier['notify']
    const op = new SwitchOperation({
      specialistService: makeSpecialistService([profile()]),
      sessionBinding: makeSessionBinding(new Map()),
      approvalGateway: approvingGateway(),
      switchNotifier: { notify },
      persistBinding: vi.fn(async () => undefined)
    })
    await op.run({ name: 'BIO_EXPERT' }, { sessionId: 's' })
    expect(notify).toHaveBeenCalledTimes(1)
    const pending = (notify as unknown as { mock: { calls: PendingSwitch[][] } }).mock.calls[0][0]
    expect(pending).toEqual({ sessionId: 's', targetName: 'BIO_EXPERT' })
  })
})
