import type { AcpResumeSessionRequest } from '../../shared/acp'

const bindResumeRequestToProject = (
  request: AcpResumeSessionRequest,
  projectId: string
): AcpResumeSessionRequest => {
  const assertedProjectId = request.projectId?.trim()
  if (assertedProjectId && assertedProjectId !== projectId) {
    throw new Error('Session does not belong to the requested Project.')
  }
  return { ...request, projectId }
}

export { bindResumeRequestToProject }
