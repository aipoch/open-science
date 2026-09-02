import type {
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_ID } from '../../shared/artifacts'
import { withDataRootWrite } from '../storage/migration-state'
import {
  createManagedSessionWorkspaceCapability,
  type ManagedSessionWorkspaceCapability
} from './managed-session-workspace'

type AcpSessionCreator = {
  createSession(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
  deleteSession(request: AcpDeleteSessionRequest): Promise<unknown>
}

type DataRootWrite = <Result>(write: () => Promise<Result>) => Promise<Result>

type AcpCreateSessionWorkflowDependencies = {
  workspaces: ManagedSessionWorkspaceCapability
  withDataRootWrite: DataRootWrite
  withProjectAvailable<Result>(
    projectId: string | undefined,
    operation: () => Promise<Result>
  ): Promise<Result>
}

type AcpCreateSessionWorkflow = {
  create(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
}

// Keeps transport-independent Session startup ordering behind one application seam. Explicit
// workspaces bypass managed storage; managed workspaces hold the relocation writer guard across
// allocation, Session publication, and any rollback.
const createAcpCreateSessionWorkflow = (
  sessions: AcpSessionCreator,
  dependencies: Partial<AcpCreateSessionWorkflowDependencies> = {}
): AcpCreateSessionWorkflow => {
  const workspaces = dependencies.workspaces ?? createManagedSessionWorkspaceCapability()
  const runDataRootWrite = dependencies.withDataRootWrite ?? withDataRootWrite

  return {
    async create(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse> {
      const requestedProjectId = request.projectId?.trim() || undefined
      const normalizedRequest =
        requestedProjectId === request.projectId
          ? request
          : { ...request, projectId: requestedProjectId }
      const createAvailableSession = async (): Promise<AcpCreateSessionResponse> => {
        const explicitCwd = request.cwd?.trim()
        if (explicitCwd) {
          return sessions.createSession({ ...normalizedRequest, cwd: explicitCwd })
        }

        return runDataRootWrite(async () => {
          const projectId = requestedProjectId ?? DEFAULT_ARTIFACT_PROJECT_ID
          const workspace = await workspaces.acquire({ projectId })
          let releaseWorkspace = true
          try {
            const response = await sessions.createSession({
              ...normalizedRequest,
              projectId,
              cwd: workspace.cwd
            })
            try {
              await workspace.commit(response.sessionId)
            } catch (publicationError) {
              try {
                await sessions.deleteSession({ sessionId: response.sessionId })
              } catch (cleanupError) {
                releaseWorkspace = false
                throw new AggregateError(
                  [publicationError, cleanupError],
                  'Managed workspace publication and Session rollback failed.'
                )
              }
              throw publicationError
            }
            return response
          } finally {
            if (releaseWorkspace) await workspace.release()
          }
        })
      }
      return dependencies.withProjectAvailable
        ? dependencies.withProjectAvailable(requestedProjectId, createAvailableSession)
        : createAvailableSession()
    }
  }
}

export { createAcpCreateSessionWorkflow }
export type { AcpCreateSessionWorkflow }
