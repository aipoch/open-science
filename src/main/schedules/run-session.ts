import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { type PermissionProfileId } from '../../shared/permission-profiles'
import type { Project } from '../../shared/projects'
import type { SettingsSnapshot } from '../../shared/settings'
import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import {
  resolveValidatedSessionAgentTarget,
  toSessionAgentConfiguration
} from '../acp/session-agent-target'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import type { ArchiveCoordinator } from '../archive/coordinator'

export class ScheduleRunSessions {
  private readonly workspaces = createManagedSessionWorkspaceCapability()
  constructor(
    private readonly sessions: Pick<
      SessionPersistenceCommands,
      'saveSession' | 'findSessionForContinuation'
    >,
    private readonly archive: Pick<ArchiveCoordinator, 'withProjectAvailable'>,
    private readonly project: (projectId: string) => Promise<Project | null>,
    private readonly settings: () => Promise<SettingsSnapshot>
  ) {}
  find(projectId: string, id: string): Promise<PersistedChatSession | undefined> {
    return this.sessions.findSessionForContinuation(projectId, id)
  }
  prepare(
    projectId: string,
    id: string,
    title: string,
    assertCurrent: () => Promise<void>,
    permissionProfile: PermissionProfileId
  ): Promise<PersistedChatSession> {
    return this.archive.withProjectAvailable(projectId, async () => {
      await assertCurrent()
      const existing = await this.find(projectId, id)
      if (existing) return existing
      const project = await this.project(projectId)
      if (!project || project.archivedAt !== undefined)
        throw new Error('The scheduled project is unavailable.')
      const defaults = project.sessionDefaults
      const settings = await this.settings()
      const target = resolveValidatedSessionAgentTarget(
        { agentConfiguration: defaults?.agentConfiguration },
        settings
      )
      const workspace = await this.workspaces.acquire({ projectId })
      const now = Date.now()
      // Startup reconciliation removes an unreferenced workspace and finalizes one whose
      // Session was saved before a crash. Never release a directory after an ambiguous save.
      const session = await this.sessions.saveSession(
        materializeSessionConversationGraph({
          projectId,
          id,
          title,
          cwd: workspace.cwd,
          status: 'idle',
          createdAt: now,
          updatedAt: now,
          messages: [],
          agentFrameworkId: target.frameworkId,
          agentConfiguration: toSessionAgentConfiguration(target),
          permissionProfile,
          autoReviewEnabled: defaults?.autoReviewEnabled,
          memoryEnabled: defaults?.memoryEnabled,
          delegationPolicy: defaults?.delegationPolicy,
          specialistId: defaults?.specialistId,
          enabledComputeHosts: defaults?.computeHosts?.enabled,
          selectedComputeHosts: defaults?.computeHosts?.selected
        }),
        { expectedRevision: 0 }
      )
      await workspace.commit(id)
      return session
    })
  }
}
