import type {
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_ID } from '../../shared/artifacts'
import { withDataRootWrite } from '../storage/migration-state'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { waitForSessionCreationCleanup } from './session-creation-cleanup'
import {
  createManagedSessionWorkspaceCapability,
  type ManagedSessionWorkspaceCapability
} from './managed-session-workspace'

type AcpSessionCreator = {
  createSession(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
  deleteSession(request: AcpDeleteSessionRequest): Promise<unknown>
}
const log = createLogger('acp')

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
      let resolveResult!: (response: AcpCreateSessionResponse) => void
      let rejectResult!: (error: unknown) => void
      const result = new Promise<AcpCreateSessionResponse>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      const requestedProjectId = request.projectId?.trim() || undefined
      const normalizedRequest =
        requestedProjectId === request.projectId
          ? request
          : { ...request, projectId: requestedProjectId }
      const createAvailableSession = async (): Promise<AcpCreateSessionResponse> => {
        const explicitCwd = request.cwd?.trim()
        if (explicitCwd) {
          try {
            return await sessions.createSession({ ...normalizedRequest, cwd: explicitCwd })
          } catch (error) {
            rejectResult(error)
            await waitForSessionCreationCleanup(error)
            throw error
          }
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
              rejectResult(publicationError)
              try {
                await sessions.deleteSession({ sessionId: response.sessionId })
              } catch (cleanupError) {
                releaseWorkspace = false
                log.warn(
                  'Managed workspace Session rollback failed',
                  diagnosticErrorFields(cleanupError)
                )
              }
              throw publicationError
            }
            return response
          } catch (error) {
            // Report before cleanup, but retain the Project and relocation guards below.
            rejectResult(error)
            await waitForSessionCreationCleanup(error)
            throw error
          } finally {
            if (releaseWorkspace) {
              try {
                await workspace.release()
              } catch (error) {
                log.warn('Managed workspace release failed', diagnosticErrorFields(error))
              }
            }
          }
        })
      }
      const operation = dependencies.withProjectAvailable
        ? dependencies.withProjectAvailable(requestedProjectId, createAvailableSession)
        : createAvailableSession()
      void operation.then(resolveResult, rejectResult)
      return result
    }
  }
}

export { createAcpCreateSessionWorkflow }
export type { AcpCreateSessionWorkflow }
