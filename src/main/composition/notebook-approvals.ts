import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { PermissionProfileId } from '../../shared/permission-profiles'

// Each callback reads the current Session profile at the actual host decision, after discovery.
// Binding preparation and code-risk approval remain separate capabilities.
export function bindNotebookApprovals(
  notebook: Pick<NotebookRuntimeService, 'setExecutionApproval' | 'setRuntimeBindingApproval'>,
  runtimeForApproval: () =>
    Pick<AcpRuntimeCoordinator, 'getState' | 'requestAppApproval'> | undefined,
  readSessionProfile?: (
    projectId: string,
    sessionId: string
  ) => Promise<PermissionProfileId | undefined>
): void {
  const runtime = (): NonNullable<ReturnType<typeof runtimeForApproval>> => {
    const current = runtimeForApproval()
    if (!current) throw new Error('ACP runtime is not initialized.')
    return current
  }
  const profileFor = async (request: {
    projectId?: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<PermissionProfileId | undefined> => {
    request.signal?.throwIfAborted()
    const live = runtime().getState().permissionProfiles[request.sessionId]?.selectedProfile
    if (live !== undefined) return live
    const saved = request.projectId
      ? await readSessionProfile?.(request.projectId, request.sessionId)
      : undefined
    request.signal?.throwIfAborted()
    // A user may attach the session and tighten its policy while disk is being read.
    return runtime().getState().permissionProfiles[request.sessionId]?.selectedProfile ?? saved
  }
  notebook.setExecutionApproval(async (request) => {
    if ((await profileFor(request)) === 'full') return true
    if (request.permissionPrompts === 'none') return false
    return runtime().requestAppApproval(request)
  })
  notebook.setRuntimeBindingApproval(async (request) => {
    const profile = await profileFor(request)
    if (profile === 'full' || (profile === 'auto' && request.defaultManagedFirstBinding))
      return true
    if (request.permissionPrompts === 'none') return false
    return runtime().requestAppApproval(request)
  })
}
