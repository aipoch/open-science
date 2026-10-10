import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { NotebookRuntimeService } from '../notebook/runtime-service'

// Each callback reads the current Session profile at the actual host decision, after discovery.
// Binding preparation and code-risk approval remain separate capabilities.
export function bindNotebookApprovals(
  notebook: Pick<NotebookRuntimeService, 'setExecutionApproval' | 'setRuntimeBindingApproval'>,
  runtimeForApproval: () =>
    Pick<AcpRuntimeCoordinator, 'getState' | 'requestAppApproval'> | undefined
): void {
  const runtime = (): NonNullable<ReturnType<typeof runtimeForApproval>> => {
    const current = runtimeForApproval()
    if (!current) throw new Error('ACP runtime is not initialized.')
    return current
  }
  notebook.setExecutionApproval(async (request) => {
    const current = runtime()
    if (current.getState().permissionProfiles[request.sessionId]?.selectedProfile === 'full')
      return true
    if (request.permissionPrompts === 'none') return false
    return current.requestAppApproval(request)
  })
  notebook.setRuntimeBindingApproval(async (request) => {
    const current = runtime()
    const profile = current.getState().permissionProfiles[request.sessionId]?.selectedProfile
    if (profile === 'full' || (profile === 'auto' && request.defaultManagedFirstBinding))
      return true
    if (request.permissionPrompts === 'none') return false
    return current.requestAppApproval(request)
  })
}
