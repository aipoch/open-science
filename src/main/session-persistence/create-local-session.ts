import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import {
  SESSION_DETAILS_TITLE_MAX_LENGTH,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  createManagedSessionWorkspaceCapability,
  type ManagedSessionWorkspaceCapability
} from '../acp/managed-session-workspace'
import { withDataRootWrite } from '../storage/migration-state'

const identity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const requestSchema = z
  .object({
    projectId: identity,
    title: z.string().trim().min(1).max(SESSION_DETAILS_TITLE_MAX_LENGTH)
  })
  .strict()

type CreateLocalSessionRequest = z.infer<typeof requestSchema>
type LocalSessionPersistence = {
  readSessionSnapshot(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession | undefined>
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession>
  deleteSession(projectId: string, sessionId: string): Promise<void>
}
type LocalSessionCreationDependencies = {
  sessions: LocalSessionPersistence
  withProjectAvailable<Result>(projectId: string, operation: () => Promise<Result>): Promise<Result>
  workspaces?: ManagedSessionWorkspaceCapability
  withDataRootWrite?: <Result>(operation: () => Promise<Result>) => Promise<Result>
  createId?: () => string
  now?: () => number
}

// Creates only application storage. Attaching an Agent or submitting a model prompt remains a
// separate operation. External tools use this same ordinary Session, never a private Session kind.
const createLocalSessionWorkflow = (
  dependencies: LocalSessionCreationDependencies
): {
  create(request: CreateLocalSessionRequest): Promise<PersistedChatSession>
} => {
  const workspaces = dependencies.workspaces ?? createManagedSessionWorkspaceCapability()
  const write = dependencies.withDataRootWrite ?? withDataRootWrite
  const createId = dependencies.createId ?? randomUUID
  const now = dependencies.now ?? Date.now
  return {
    async create(input) {
      const request = requestSchema.parse(input)
      return dependencies.withProjectAvailable(request.projectId, () =>
        write(async () => {
          const sessionId = identity.parse(createId())
          if (await dependencies.sessions.readSessionSnapshot(request.projectId, sessionId)) {
            throw new Error('The allocated Session identity already exists.')
          }
          const workspace = await workspaces.acquire({ projectId: request.projectId })
          const createdAt = now()
          const session: PersistedChatSession = {
            id: sessionId,
            projectId: request.projectId,
            title: request.title,
            cwd: workspace.cwd,
            status: 'idle',
            permissionProfile: DEFAULT_PERMISSION_PROFILE,
            messages: [],
            createdAt,
            updatedAt: createdAt
          }
          let published = false
          let release = true
          try {
            let saved: PersistedChatSession
            try {
              saved = await dependencies.sessions.saveSession(session)
              published = true
            } catch (error) {
              // The coordinator can commit JSON before a derived-index write fails. Retain that
              // Session's workspace even when the caller must retry publication or repair indexing.
              let durable: PersistedChatSession | undefined
              try {
                durable = await dependencies.sessions.readSessionSnapshot(
                  request.projectId,
                  sessionId
                )
              } catch (readError) {
                release = false
                throw new AggregateError(
                  [error, readError],
                  'Session publication is uncertain; its workspace was retained.'
                )
              }
              if (durable) {
                release = false
                if (durable.cwd === workspace.cwd) await workspace.commit(sessionId)
              }
              throw error
            }
            try {
              await workspace.commit(sessionId)
            } catch (error) {
              try {
                await dependencies.sessions.deleteSession(request.projectId, sessionId)
                published = false
              } catch (cleanupError) {
                release = false
                throw new AggregateError(
                  [error, cleanupError],
                  'Workspace publication and Session rollback failed; the workspace was retained.'
                )
              }
              throw error
            }
            return saved
          } finally {
            // release() is a no-op for a committed managed workspace. Never remove storage for a
            // published or uncertain Session merely because a later projection failed.
            if (release && !published) await workspace.release()
          }
        })
      )
    }
  }
}

export { createLocalSessionWorkflow }
export type { CreateLocalSessionRequest, LocalSessionCreationDependencies, LocalSessionPersistence }
