import { expect, it, vi } from 'vitest'
import { ScheduleRunSessions } from './run-session'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SettingsSnapshot } from '../../shared/settings'
import type { Project } from '../../shared/projects'

vi.mock('../acp/managed-session-workspace', () => ({
  createManagedSessionWorkspaceCapability: () => ({
    acquire: async () => ({ cwd: '/isolated-workspace', commit: vi.fn() })
  })
}))
vi.mock('../acp/session-agent-target', () => ({
  resolveValidatedSessionAgentTarget: () => ({
    frameworkId: 'open-science-agent',
    providerId: 'test',
    model: 'test'
  }),
  toSessionAgentConfiguration: () => ({ providerId: 'test', model: 'test' })
}))

it.each(['ask', 'auto', 'full'] as const)(
  'persists the task permission %s instead of mutable project defaults',
  async (permissionProfile) => {
    let saved: PersistedChatSession | undefined
    const saveSession = vi.fn(async (session: PersistedChatSession) => (saved = session))
    const owner = new ScheduleRunSessions(
      { saveSession, findSessionForContinuation: async () => saved },
      { withProjectAvailable: async (_project, run) => run() },
      async () =>
        ({
          sessionDefaults: { permissionProfile: permissionProfile === 'full' ? 'ask' : 'full' }
        }) as Project,
      async () => ({ defaultPermissionProfile: 'full' }) as SettingsSnapshot
    )
    const first = await owner.prepare('p', 'run', 'Review', async () => {}, permissionProfile)
    expect(first.permissionProfile).toBe(permissionProfile)
    // A pre-admission retry reuses the reserved conversation, without resetting its permissions.
    expect(await owner.prepare('p', 'run', 'Review', async () => {}, permissionProfile)).toBe(first)
    expect(saveSession).toHaveBeenCalledOnce()
  }
)
