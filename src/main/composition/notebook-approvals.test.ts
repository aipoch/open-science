import { expect, it, vi } from 'vitest'
import { bindNotebookApprovals } from './notebook-approvals'
import type {
  NotebookExecutionApproval,
  NotebookRuntimeBindingApproval
} from '../notebook/runtime-service'
import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../shared/permission-profiles'

function harness(saved: () => Promise<PermissionProfileId | undefined>): {
  execute: NotebookExecutionApproval
  bind: NotebookRuntimeBindingApproval
  profiles: Record<string, SessionPermissionProfileState>
  read: ReturnType<typeof vi.fn<typeof saved>>
  requestAppApproval: ReturnType<typeof vi.fn<() => Promise<boolean>>>
} {
  let execute!: NotebookExecutionApproval
  let bind!: NotebookRuntimeBindingApproval
  const profiles: Record<string, SessionPermissionProfileState> = {}
  const requestAppApproval = vi.fn(async () => true)
  const read = vi.fn(saved)
  bindNotebookApprovals(
    {
      setExecutionApproval: (handler) => {
        execute = handler
      },
      setRuntimeBindingApproval: (handler) => {
        bind = handler
      }
    },
    () =>
      ({
        getState: () => ({ permissionProfiles: profiles }),
        requestAppApproval,
        pendingNotebookReviews: () => []
      }) as unknown as Pick<
        AcpRuntimeCoordinator,
        'getState' | 'requestAppApproval' | 'pendingNotebookReviews'
      >,
    read
  )
  return {
    execute: (request: Parameters<NotebookExecutionApproval>[0]) => execute(request),
    bind: (request: Parameters<NotebookRuntimeBindingApproval>[0]) => bind(request),
    profiles,
    read,
    requestAppApproval
  }
}
const request = {
  projectId: 'project',
  sessionId: 'session',
  title: 'Run',
  rawInput: {},
  permissionPrompts: 'none' as const
}

it.each(['ask', 'auto', 'full', undefined] as const)(
  'uses the saved %s profile before runtime attachment without opening approval UI',
  async (profile) => {
    const h = harness(async () => profile)
    expect(await h.execute(request)).toBe(profile === 'full')
    expect(await h.bind({ ...request, defaultManagedFirstBinding: true })).toBe(
      profile === 'full' || profile === 'auto'
    )
    expect(await h.bind({ ...request, defaultManagedFirstBinding: false })).toBe(profile === 'full')
    expect(h.read).toHaveBeenCalledWith('project', 'session')
    expect(h.requestAppApproval).not.toHaveBeenCalled()
  }
)

it('honors a live permission change and cancellation while loading saved permissions', async () => {
  const pending = Promise.withResolvers<PermissionProfileId>()
  const h = harness(() => pending.promise)
  const decision = h.execute(request)
  h.profiles.session = {
    selectedProfile: 'ask',
    effectiveProfile: 'ask',
    availableModeIds: [],
    fullAccessAvailable: true
  }
  pending.resolve('full')
  expect(await decision).toBe(false)
  delete h.profiles.session
  const controller = new AbortController()
  const cancelled = h.execute({ ...request, signal: controller.signal })
  controller.abort()
  await expect(cancelled).rejects.toThrow()
  expect(h.requestAppApproval).not.toHaveBeenCalled()
})
