import type { ManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import type { NotebookRunRepository } from '../notebook/repository'
import type { SessionRepository } from '../session-persistence/repository'
import { getProjectRecordRoot } from './record-storage'

type RestoreProjectRecordSessionsOptions = {
  storageRoot: string
  projectId: string
  sessions: SessionRepository
  notebooks: NotebookRunRepository
  workspaces: ManagedSessionWorkspaceCapability
}

// Called only after the user explicitly reopens retained Project records. Notebook documents are
// research history, not provider/chat history: create missing discovery shells, never import or
// rewrite runs, reconstruct prompts, or change an existing Session's runtime identity.
export async function restoreProjectRecordSessions(
  options: RestoreProjectRecordSessionsOptions
): Promise<string[]> {
  if (!getProjectRecordRoot(options.storageRoot, options.projectId)) return []
  const restored: string[] = []
  for (const sessionId of await options.notebooks.listProjectSessionIds(options.projectId)) {
    const current = await options.sessions.loadSessionWithDiagnostics(
      options.projectId,
      sessionId,
      {
        mode: 'read-only',
        preserveRuntimeState: true
      }
    )
    if (current.status === 'found') continue
    if (current.status === 'unreadable')
      throw new Error(`Cannot restore research Session over unreadable history: ${sessionId}`)
    const documents = await options.notebooks.readSessionDocuments(options.projectId, sessionId)
    if (!documents.length) continue
    const times = documents
      .flatMap((document) => [
        document.updatedAt,
        ...document.runs.flatMap((run) => [
          run.startedAt,
          ...(run.endedAt === undefined ? [] : [run.endedAt])
        ])
      ])
      .filter((time) => Number.isFinite(time) && time >= 0)
    const now = Date.now()
    const createdAt = times.reduce((minimum, time) => Math.min(minimum, time), times[0] ?? now)
    const updatedAt = times.reduce((maximum, time) => Math.max(maximum, time), times[0] ?? now)
    const workspace = await options.workspaces.acquire({ projectId: options.projectId })
    let published = false
    try {
      await options.sessions.saveSession(
        {
          id: sessionId,
          projectId: options.projectId,
          title: 'Notebook',
          cwd: workspace.cwd,
          status: 'idle',
          permissionProfile: 'ask',
          memoryEnabled: false,
          delegationPolicy: 'deny',
          autoReviewEnabled: false,
          enabledComputeHosts: [],
          selectedComputeHosts: [],
          messages: [],
          createdAt,
          updatedAt
        },
        0,
        {
          onJsonCommitted: () => {
            published = true
          }
        }
      )
      restored.push(sessionId)
    } finally {
      // JSON can commit before a derived projection fails. Keep its workspace alive in that case;
      // repository reconciliation repairs the index without ever dropping the retained Notebook.
      // A failed ownership commit also retains the provisional directory for diagnosis/recovery.
      if (published) await workspace.commit(sessionId)
      await workspace.release()
    }
  }
  return restored
}
