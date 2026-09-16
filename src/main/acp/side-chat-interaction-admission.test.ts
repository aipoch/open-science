import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { CredentialRequestBroker } from '../connectors/credential-request-broker'

// Exercise the actual runtime composition, not a precomputed boolean in the transport fake.
describe('Side chat runtime interaction authority', () => {
  const setup = (): {
    credentials: CredentialRequestBroker
    base: ReturnType<typeof composeAcpRuntimeBaseOwners>
    session: ReturnType<typeof composeAcpRuntimeSessionOwners>
    runtime: AcpRuntime
  } => {
    const credentials = new CredentialRequestBroker({
      generateId: () => 'credential',
      broadcast: vi.fn(),
      replay: vi.fn()
    })
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      hasPendingCredentialRequest: (id: string) => credentials.hasPendingForSession(id)
    }
    const base = composeAcpRuntimeBaseOwners(options)
    const session = composeAcpRuntimeSessionOwners(options, base)
    const runtime = new AcpRuntime(options, base, session)
    return { credentials, base, session, runtime }
  }
  it('reads real credential requests and stops blocking after settlement', async () => {
    const { credentials, runtime } = setup()
    const pending = credentials.request({
      sessionId: 'main',
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works'
    })
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(true)
    expect(runtime.hasPendingSideChatInteraction('other')).toBe(false)
    credentials.respond('credential', false)
    await pending
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(false)
  })
  it('reads plan reservations before an approval is parked and after it is released', () => {
    const { base, runtime } = setup()
    base.planInteractions.reserveApproval('main', 'approval')
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(true)
    expect(runtime.hasPendingSideChatInteraction('other')).toBe(false)
    base.planInteractions.releaseApprovalReservation('main', 'approval')
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(false)
  })
  it('reads real user questions and their cancellation', async () => {
    const { session, runtime } = setup()
    const pending = session.elicitationOwner.request(
      {
        mode: 'form',
        sessionId: 'provider',
        toolCallId: 'question-tool',
        message: 'Choose',
        requestedSchema: {
          type: 'object',
          properties: { choice: { type: 'string', title: 'Choice' } }
        }
      },
      { sessionId: 'main' }
    )
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(true)
    expect(runtime.hasPendingSideChatInteraction('other')).toBe(false)
    session.elicitationOwner.cancelForSession('main')
    await pending
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(false)
  })
  it('reads real permission waits and their cancellation', async () => {
    const { session, runtime } = setup()
    const pending = session.permissionContext.requestAppApproval({
      sessionId: 'main',
      title: 'Approve fixture',
      rawInput: {}
    })
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(true)
    expect(runtime.hasPendingSideChatInteraction('other')).toBe(false)
    const request = session.permissionContext.getPendingRequests()[0]
    await session.permissionContext.respondToPermission(
      { requestId: request.requestId, cancelled: true },
      { kind: 'human' }
    )
    await pending
    expect(runtime.hasPendingSideChatInteraction('main')).toBe(false)
  })
})
