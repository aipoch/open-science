import type { AcpPermissionRequest } from '../../../../shared/acp'

// Limits visible permission controls to the conversation currently on screen.
const getVisiblePermissionRequests = (
  pendingPermissions: AcpPermissionRequest[],
  activeSessionId: string | undefined
): AcpPermissionRequest[] => {
  if (!activeSessionId) return []

  return pendingPermissions.filter((request) => request.sessionId === activeSessionId)
}

export { getVisiblePermissionRequests }
