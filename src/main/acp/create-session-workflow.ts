import type { AcpCreateSessionRequest, AcpCreateSessionResponse } from '../../shared/acp'
import { withDataRootWrite } from '../storage/migration-state'
import {
  createManagedSessionWorkspaceCapability,
  type ManagedSessionWorkspaceCapability
} from './managed-session-workspace'

type AcpSessionCreator = {
  createSession(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
}

type DataRootWrite = <Result>(write: () => Promise<Result>) => Promise<Result>

type AcpCreateSessionWorkflowDependencies = {
  workspaces: ManagedSessionWorkspaceCapability
  withDataRootWrite: DataRootWrite
  assertProjectAvailable(projectId: string | undefined): Promise<void>
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
      await dependencies.assertProjectAvailable?.(request.projectName)
      const explicitCwd = request.cwd?.trim()
      if (explicitCwd) {
        return sessions.createSession({ ...request, cwd: explicitCwd })
      }

      return runDataRootWrite(async () => {
        const workspace = await workspaces.acquire()
        try {
          const response = await sessions.createSession({ ...request, cwd: workspace.cwd })
          workspace.commit()
          return response
        } finally {
          await workspace.release()
        }
      })
    }
  }
}

export { createAcpCreateSessionWorkflow }
export type { AcpCreateSessionWorkflow }
