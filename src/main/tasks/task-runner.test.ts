import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { queryObjects } from 'node:v8'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { ComputeHostPreferenceValidationError } from '../../shared/compute'
import type { Project } from '../../shared/projects'
import type { SettingsSnapshot } from '../../shared/settings'
import {
  normalizeSessionFile,
  SessionConfigurationBusyError,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { TaskRun } from '../../shared/task-api'
import { EnabledComputeHostsRegistry } from '../compute/enabled-hosts-registry'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import type { TaskRunJournalEntry } from './task-run-journal'
import {
  TASK_RUN_DISPOSAL_BUDGET_MS,
  TaskRunner,
  type TaskAgentPort,
  type TaskPreviewResourcePort,
  type TaskProjectPort,
  type TaskRunnerDependencies,
  type TaskSessionPort
} from './task-runner'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

const project: Project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: project.id,
  title: 'Review session',
  cwd: '/workspace/review',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

const settings: SettingsSnapshot = {
  claude: {},
  opencode: {},
  codebuddy: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codebuddyManaged: false,
  codexManaged: false,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
}

const configuredSettings: SettingsSnapshot = {
  ...settings,
  activeProviderId: 'provider-1',
  activeModel: 'model-1',
  providers: [
    {
      id: 'provider-1',
      type: 'custom',
      name: 'Test provider',
      apiEndpoints: ['anthropic'],
      model: 'model-1',
      models: ['model-1', 'model-2'],
      supportsImageInput: false,
      hasKey: true,
      needsKey: false
    }
  ]
}

class RetainedRunEventPayload {}

type TaskRunnerOverrides = Omit<Partial<TaskRunnerDependencies>, 'agent' | 'sessions'> & {
  agent?: Partial<TaskAgentPort>
  sessions?: Omit<
    Partial<TaskSessionPort>,
    'save' | 'stageCompletion' | 'settleCompletion' | 'failRun'
  > & {
    save?: (session: PersistedChatSession) => Promise<PersistedChatSession | void>
    stageCompletion?: TaskSessionPort['stageCompletion']
    settleCompletion?: TaskSessionPort['settleCompletion']
    failRun?: TaskSessionPort['failRun']
  }
}

const createRunner = (overrides: TaskRunnerOverrides = {}): TaskRunner => {
  const sessions = new Map<string, PersistedChatSession>()
  const save = async (value: PersistedChatSession): Promise<PersistedChatSession> => {
    const persisted = (await overrides.sessions?.save?.(value)) ?? value
    sessions.set(persisted.id, structuredClone(persisted))
    return persisted
  }
  const loadSession = (sessionId: string): PersistedChatSession => {
    const current = sessions.get(sessionId)
    if (!current) throw new Error(`Missing test Session: ${sessionId}`)
    return structuredClone(current)
  }
  const defaultSessions: TaskSessionPort = {
    list: async () => {
      const loaded = (await overrides.sessions?.list?.()) ?? []
      for (const value of loaded) sessions.set(value.id, structuredClone(value))
      return loaded
    },
    save,
    stageCompletion: async (request) => {
      const current = loadSession(request.sessionId)
      const candidate: PersistedChatSession = {
        ...current,
        messages: request.message ? [...current.messages, request.message] : current.messages,
        activities: [...(current.activities ?? []), ...request.activities],
        updatedAt: request.updatedAt
      }
      if (request.clearPendingHistoryReplay) delete candidate.pendingHistoryReplay
      return save(candidate)
    },
    settleCompletion: async (request) => {
      const current = loadSession(request.sessionId)
      const artifactIds = request.artifacts.map(({ id }) => id)
      return save({
        ...current,
        status: 'idle',
        activeRun: undefined,
        taskRunCommitId: request.taskRunCommitId,
        messages: current.messages.map((message) =>
          message.id === request.messageId && artifactIds.length > 0
            ? { ...message, artifactIds }
            : message
        ),
        artifacts: [...(current.artifacts ?? []), ...request.artifacts],
        filesRevision:
          request.artifacts.length > 0 ? (current.filesRevision ?? 0) + 1 : current.filesRevision,
        updatedAt: request.updatedAt
      })
    },
    failRun: async (request) => {
      const current = loadSession(request.sessionId)
      return save({
        ...current,
        status: 'error',
        activeRun: undefined,
        taskRunCommitId: request.taskRunCommitId,
        error: request.error,
        errorReportable: request.errorReportable,
        artifacts: [...(current.artifacts ?? []), ...request.artifacts],
        updatedAt: request.updatedAt
      })
    },
    updateConfiguration: async (value) => save(value),
    setDelegationPolicy: async () => undefined
  }
  const defaultAgent: TaskAgentPort = {
    withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
    listAttachedSessionIds: async () => [],
    createSession: async () => ({ sessionId: 'session-created' }),
    resumeSession: async (request) => ({ sessionId: request.sessionId }),
    setPermissionProfile: async () => undefined,
    setMemoryEnabled: async () => undefined,
    cancelPrompt: async () => undefined,
    prompt: async () => undefined
  }
  return new TaskRunner({
    projects: {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    },
    previewResources: {
      acquire: async () => ({ id: 'resource-1', url: 'preview://resource-1', size: 0 }),
      release: async () => undefined
    },
    artifacts: {
      finalizeRun: async () => ({ ok: true, artifacts: [] })
    },
    runtimeEvents: { subscribe: () => () => undefined },
    settings: { get: async () => settings },
    specialists: { resolve: async (reference) => ({ id: reference }) },
    reviewer: { review: async () => ({ started: true }) },
    computePreferences: {
      withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
      set: async () => {
        throw new Error('Unexpected Compute preference update.')
      }
    },
    runWithLifecycleContext: (operation) => operation(),
    createId: () => 'generated-id',
    now: () => 1,
    ...overrides,
    agent: { ...defaultAgent, ...overrides.agent },
    sessions: {
      ...defaultSessions,
      ...overrides.sessions,
      list: defaultSessions.list,
      save,
      stageCompletion: overrides.sessions?.stageCompletion ?? defaultSessions.stageCompletion,
      settleCompletion: overrides.sessions?.settleCompletion ?? defaultSessions.settleCompletion,
      failRun: overrides.sessions?.failRun ?? defaultSessions.failRun
    }
  })
}
describe('TaskRunner', () => {
  it('updates an idle Session configuration atomically with revision and availability checks', async () => {
    let current: PersistedChatSession = {
      ...session,
      revision: 4,
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'default'
      }
    }
    const updateConfiguration = vi.fn(async (value: PersistedChatSession) => {
      current = { ...value, revision: (value.revision ?? 0) + 1 }
      return current
    })
    const validate = vi.fn(async (providerIds: readonly string[]) => [...new Set(providerIds)])
    const setMemoryEnabled = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: { list: async () => [current], updateConfiguration },
      settings: { get: async () => configuredSettings },
      agent: {
        listAttachedSessionIds: async () => [session.id],
        setMemoryEnabled
      },
      computePreferences: {
        withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
        set: async () => current,
        validate,
        listAvailable: async () => ['ssh:alpha']
      }
    })

    await expect(
      runner.updateSessionConfiguration(session.id, {
        expectedRevision: 4,
        agentConfiguration: { model: 'model-2', reasoningEffort: 'high' },
        permissionProfile: 'full',
        memoryEnabled: false,
        computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:alpha'] }
      })
    ).resolves.toMatchObject({
      revision: 5,
      persisted: {
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-2',
          reasoningEffort: 'high'
        },
        permissionProfile: 'full',
        memoryEnabled: false,
        computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:alpha'] }
      },
      availability: {
        agentConfiguration: { available: true },
        computeHosts: { 'ssh:alpha': { available: true } }
      }
    })
    expect(updateConfiguration).toHaveBeenCalledWith(expect.any(Object), 4)
    expect(setMemoryEnabled).toHaveBeenCalledWith(session.id, false)
    expect(validate).toHaveBeenCalledWith(['ssh:alpha', 'ssh:alpha'])
  })

  it('keeps a committed configuration update when its attached runtime detaches', async () => {
    let current: PersistedChatSession = { ...session, revision: 4, memoryEnabled: true }
    const updateConfiguration = vi.fn(async (value: PersistedChatSession) => {
      current = { ...value, revision: 5 }
      return current
    })
    const listAttachedSessionIds = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce([session.id])
      .mockResolvedValueOnce([])
    const runner = createRunner({
      sessions: { list: async () => [current], updateConfiguration },
      agent: {
        listAttachedSessionIds,
        setMemoryEnabled: async () => {
          throw new Error(`ACP session not found: ${session.id}`)
        }
      }
    })

    await expect(
      runner.updateSessionConfiguration(session.id, {
        expectedRevision: 4,
        memoryEnabled: false
      })
    ).resolves.toMatchObject({ revision: 5, persisted: { memoryEnabled: false } })
    expect(updateConfiguration).toHaveBeenCalledOnce()
    expect(listAttachedSessionIds).toHaveBeenCalledTimes(2)
  })

  it('reports a runtime synchronization failure while the Session remains attached', async () => {
    let current: PersistedChatSession = { ...session, revision: 4, memoryEnabled: true }
    const updateConfiguration = vi.fn(async (value: PersistedChatSession) => {
      current = { ...value, revision: 5 }
      return current
    })
    const runner = createRunner({
      sessions: { list: async () => [current], updateConfiguration },
      agent: {
        listAttachedSessionIds: async () => [session.id],
        setMemoryEnabled: async () => {
          throw new Error('runtime synchronization failed')
        }
      }
    })

    await expect(
      runner.updateSessionConfiguration(session.id, {
        expectedRevision: 4,
        memoryEnabled: false
      })
    ).rejects.toThrow('runtime synchronization failed')
    expect(updateConfiguration).toHaveBeenCalledOnce()
  })

  it('rejects stale or active Session configuration updates without persisting them', async () => {
    const current = { ...session, revision: 3 }
    const save = vi.fn(async (value: PersistedChatSession) => value)
    const staleRunner = createRunner({ sessions: { list: async () => [current], save } })

    await expect(
      staleRunner.updateSessionConfiguration(session.id, {
        expectedRevision: 2,
        memoryEnabled: false
      })
    ).rejects.toMatchObject({ code: 'session_revision_conflict' })

    const busyRunner = createRunner({
      sessions: { list: async () => [current], save },
      isSessionBusy: () => true
    })
    await expect(
      busyRunner.updateSessionConfiguration(session.id, {
        expectedRevision: 3,
        memoryEnabled: false
      })
    ).rejects.toMatchObject({ code: 'session_busy' })
    expect(save).not.toHaveBeenCalled()
  })

  it('reports availability for the persisted Agent configuration instead of its fallback', async () => {
    const pinned = {
      ...session,
      agentConfiguration: {
        providerId: 'provider-removed',
        model: 'model-removed',
        reasoningEffort: 'high' as const
      }
    }
    const runner = createRunner({
      sessions: { list: async () => [pinned] },
      settings: { get: async () => configuredSettings }
    })

    await expect(runner.getSessionConfiguration(pinned.id)).resolves.toMatchObject({
      persisted: { agentConfiguration: pinned.agentConfiguration },
      availability: { agentConfiguration: { available: false } }
    })
  })

  it('maps an authoritative concurrent-start rejection to session_busy', async () => {
    const current = { ...session, revision: 3 }
    const updateConfiguration = vi.fn(async (): Promise<PersistedChatSession> => {
      throw new SessionConfigurationBusyError(current.id)
    })
    const runner = createRunner({
      sessions: { list: async () => [current], updateConfiguration }
    })

    await expect(
      runner.updateSessionConfiguration(current.id, {
        expectedRevision: 3,
        memoryEnabled: false
      })
    ).rejects.toMatchObject({ code: 'session_busy' })
    expect(updateConfiguration).toHaveBeenCalledOnce()
  })

  it('requires an explicit model decision when changing providers', async () => {
    const current = {
      ...session,
      revision: 3,
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'default' as const
      }
    }
    const save = vi.fn(async (value: PersistedChatSession) => value)
    const runner = createRunner({
      sessions: { list: async () => [current], save },
      settings: { get: async () => configuredSettings }
    })

    await expect(
      runner.updateSessionConfiguration(session.id, {
        expectedRevision: 3,
        agentConfiguration: { providerId: 'provider-2' }
      })
    ).rejects.toMatchObject({ code: 'invalid_configuration' })
    expect(save).not.toHaveBeenCalled()
  })

  it('persists Project Session defaults without rewriting existing Sessions', async () => {
    let currentProject: Project = { ...project, updatedAt: 7 }
    const update = vi.fn(async (request: Parameters<NonNullable<TaskProjectPort['update']>>[0]) => {
      currentProject = {
        ...currentProject,
        sessionDefaults: request.sessionDefaults,
        updatedAt: 8
      }
      return currentProject
    })
    const save = vi.fn(async (value: PersistedChatSession) => value)
    const runner = createRunner({
      projects: {
        list: async () => [currentProject],
        create: async (request) => ({ ...currentProject, ...request }),
        update
      },
      sessions: { list: async () => [session], save },
      settings: { get: async () => configuredSettings },
      specialists: { resolve: async () => ({ id: 'specialist-id' }) },
      computePreferences: {
        withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
        set: async () => session,
        validate: async (providerIds) => [...new Set(providerIds)],
        listAvailable: async () => ['ssh:alpha']
      }
    })

    await expect(
      runner.updateProjectSessionDefaults(project.id, {
        expectedUpdatedAt: 7,
        patch: {
          agentConfiguration: {
            providerId: 'provider-1',
            model: 'model-2',
            reasoningEffort: 'high'
          },
          permissionProfile: 'auto',
          memoryEnabled: false,
          specialistId: 'specialist-name',
          computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:alpha'] }
        }
      })
    ).resolves.toMatchObject({
      updatedAt: 8,
      configured: {
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-2',
          reasoningEffort: 'high'
        },
        permissionProfile: 'auto',
        memoryEnabled: false,
        specialistId: 'specialist-id',
        computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:alpha'] }
      }
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, expectedUpdatedAt: 7 })
    )
    expect(save).not.toHaveBeenCalled()
  })

  it('snapshots Project defaults into only new Sessions with explicit Run overrides and additions', async () => {
    const defaultedProject: Project = {
      ...project,
      sessionDefaults: {
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-1',
          reasoningEffort: 'low'
        },
        permissionProfile: 'full',
        autoReviewEnabled: true,
        memoryEnabled: false,
        delegationPolicy: 'deny',
        computeHosts: {
          enabled: ['ssh:alpha', 'ssh:beta'],
          selected: ['ssh:alpha']
        }
      }
    }
    const created: Array<Parameters<TaskRunnerDependencies['agent']['createSession']>[0]> = []
    const saved: PersistedChatSession[] = []
    const ids = ['user-defaults', 'run-defaults', 'agent-defaults']
    const runner = createRunner({
      projects: {
        list: async () => [defaultedProject],
        create: async (request) => ({ ...defaultedProject, ...request })
      },
      settings: { get: async () => configuredSettings },
      sessions: {
        list: async () => [],
        save: async (value) => {
          saved.push(structuredClone(value))
          return value
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async (request) => {
          created.push(request)
          return {
            sessionId: 'session-defaults',
            agentConfiguration: request.agentConfiguration
          }
        },
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Use the configured defaults.',
      permissionProfile: 'auto',
      memoryEnabled: true,
      agentConfiguration: { model: 'model-2' },
      enabledComputeHostIds: ['ssh:gamma'],
      computeHostIds: ['ssh:beta']
    })
    await runner.waitForRun(started.id)

    expect(created).toEqual([
      {
        projectId: project.id,
        permissionProfile: 'auto',
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-2',
          reasoningEffort: 'low'
        }
      }
    ])
    expect(saved).toContainEqual(
      expect.objectContaining({
        permissionProfile: 'auto',
        autoReviewEnabled: true,
        memoryEnabled: true,
        delegationPolicy: 'deny',
        enabledComputeHosts: ['ssh:alpha', 'ssh:beta', 'ssh:gamma'],
        selectedComputeHosts: ['ssh:beta'],
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-2',
          reasoningEffort: 'low'
        }
      })
    )

    const cleared = await runner.startRun({
      project: project.id,
      prompt: 'Override the configured Compute Host defaults.',
      enabledComputeHostIds: [],
      computeHostIds: []
    })
    await runner.waitForRun(cleared.id)

    expect(saved).toContainEqual(
      expect.objectContaining({
        enabledComputeHosts: [],
        selectedComputeHosts: []
      })
    )
  })

  it('resolves only the active Task Run that owns a Session and prompt', async () => {
    let finishPrompt: (() => void) | undefined
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const ids = ['prompt-1', 'run-1', 'session-1']
    const runner = createRunner({
      createId: () => ids.shift() ?? 'generated-id',
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => prompt
      }
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
    expect(runner.resolveActiveRun('desktop-session')).toBeUndefined()
    expect(runner.resolveActiveRun(started.sessionId, 'stale-prompt')).toBeUndefined()
    expect(runner.resolveActiveRun(started.sessionId, 'prompt-1')).toEqual({
      runId: started.id,
      sessionId: started.sessionId,
      projectId: started.projectId
    })

    finishPrompt?.()
    await runner.waitForRun(started.id)
    expect(runner.resolveActiveRun(started.sessionId)).toBeUndefined()
    await runner.dispose()
  })

  it('does not retain raw runtime event payloads during or after a Run', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-created' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'thought-event',
            timestamp: 10,
            kind: 'thought',
            level: 'info',
            sessionId: 'session-created',
            text: 'Working',
            raw: new RetainedRunEventPayload()
          })
          await promptGate
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Review these papers.' })
    try {
      expect(queryObjects(RetainedRunEventPayload)).toBe(0)
    } finally {
      finishPrompt?.()
      await runner.waitForRun(started.id)
    }

    expect(queryObjects(RetainedRunEventPayload)).toBe(0)
  })

  it('returns the Session authority Compute preference from start, get, and wait', async () => {
    const saved: PersistedChatSession[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (value) => {
          saved.push(structuredClone(value))
          return {
            ...value,
            enabledComputeHosts: ['ssh:alpha', 'ssh:beta'],
            selectedComputeHosts: ['ssh:alpha', 'ssh:beta']
          }
        }
      },
      computePreferences: {
        withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
        set: async () => {
          throw new Error('Unexpected existing Session update.')
        }
      },
      createId: (() => {
        const ids = ['message-compute', 'run-compute', 'agent-compute']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Run the analysis.',
      computeHostIds: ['ssh:alpha', 'ssh:alpha', 'ssh:beta']
    })

    expect(started.preferredComputeHostIds).toEqual(['ssh:alpha', 'ssh:beta'])
    expect(runner.getRun(started.id).preferredComputeHostIds).toEqual(['ssh:alpha', 'ssh:beta'])
    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({
      preferredComputeHostIds: ['ssh:alpha', 'ssh:beta']
    })
    expect(saved[0]?.enabledComputeHosts).toEqual(['ssh:alpha', 'ssh:beta'])
    expect(saved[0]?.selectedComputeHosts).toEqual(['ssh:alpha', 'ssh:beta'])
  })

  it.each([
    { label: 'preserves an omitted preference', request: {}, expected: ['ssh:kept'] },
    { label: 'clears an explicit empty preference', request: { computeHostIds: [] }, expected: [] },
    {
      label: 'replaces an explicit preference in first-occurrence order',
      request: { computeHostIds: ['ssh:beta', 'ssh:alpha', 'ssh:beta'] },
      expected: ['ssh:beta', 'ssh:alpha']
    }
  ])('$label when continuing a Session', async ({ request, expected }) => {
    const existing = {
      ...session,
      enabledComputeHosts: ['ssh:kept', 'ssh:available'],
      selectedComputeHosts: ['ssh:kept']
    }
    const set = vi.fn(async (_sessionId: string, providerIds: readonly string[]) => ({
      ...existing,
      enabledComputeHosts: [...new Set([...existing.enabledComputeHosts, ...providerIds])],
      selectedComputeHosts: [...new Set(providerIds)]
    }))
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      computePreferences: {
        withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
        set
      }
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue the analysis.',
      ...request
    })

    expect(started.preferredComputeHostIds).toEqual(expected)
    if ('computeHostIds' in request)
      expect(set).toHaveBeenCalledWith(existing.id, request.computeHostIds)
    else expect(set).not.toHaveBeenCalled()
  })

  it('rejects an invalid Compute preference atomically before a Conversation Turn starts', async () => {
    const existing = { ...session, enabledComputeHosts: ['ssh:kept'] }
    const save = vi.fn(async () => undefined)
    const prompt = vi.fn(async () => undefined)
    const resumeSession = vi.fn(async () => ({ sessionId: existing.id }))
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      computePreferences: {
        withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
        set: async () => {
          throw new ComputeHostPreferenceValidationError('host_not_found', 'ssh:missing')
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt
      }
    })

    await expect(
      runner.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue the analysis.',
        computeHostIds: ['ssh:missing']
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Compute Host not found: ssh:missing'
    })
    expect(save).not.toHaveBeenCalled()
    expect(resumeSession).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it.each([
    ['an invalid provider id', 'local:invalid', 'Invalid Compute Host provider id: local:invalid'],
    ['an unknown provider id', 'ssh:missing', 'Compute Host not found: ssh:missing']
  ])(
    'rejects %s for a new Session before creating an ACP Session',
    async (_label, providerId, message) => {
      const durableSessions = new Map<string, PersistedChatSession>()
      const registry = new EnabledComputeHostsRegistry()
      registry.set('existing-session', ['ssh:kept'])
      const owner = new SessionEnabledComputeHostsOwner({
        registry,
        hostExists: async (candidate) => candidate === 'ssh:kept',
        listHostIds: async () => ['ssh:kept'],
        sessionAuthority: {
          sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
          setSessionEnabledComputeHosts: async () => {
            throw new Error('Unexpected existing Session update.')
          },
          pruneSessionEnabledComputeHosts: async () => ({
            sessions: [],
            previousSelections: []
          })
        },
        withDataRootWrite: (operation) => operation()
      })
      const save = vi.fn(async (value: PersistedChatSession) => {
        durableSessions.set(value.id, structuredClone(value))
      })
      const createSession = vi.fn(async () => ({ sessionId: 'must-not-create' }))
      const resumeSession = vi.fn(async (request) => ({ sessionId: request.sessionId }))
      const prompt = vi.fn(async () => undefined)
      const runner = createRunner({
        sessions: { list: async () => [...durableSessions.values()], save },
        computePreferences: owner,
        agent: {
          withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
          listAttachedSessionIds: async () => [],
          createSession,
          resumeSession,
          setPermissionProfile: async () => undefined,
          cancelPrompt: async () => undefined,
          prompt
        }
      })

      await expect(
        runner.startRun({
          project: project.id,
          prompt: 'Start the analysis.',
          computeHostIds: [providerId]
        })
      ).rejects.toMatchObject({ code: 'invalid_request', message })

      expect(createSession).not.toHaveBeenCalled()
      expect(resumeSession).not.toHaveBeenCalled()
      expect(prompt).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect([...durableSessions.values()]).toEqual([])
      expect(registry.get('existing-session')).toEqual(['ssh:kept'])
      expect(registry.get('must-not-create')).toEqual([])
    }
  )

  it('holds the Compute Host reservation through ACP creation and durable Session save', async () => {
    let reserved = false
    const save = vi.fn(async (value: PersistedChatSession) => {
      expect(reserved).toBe(true)
      return value
    })
    const runner = createRunner({
      sessions: { list: async () => [], save },
      computePreferences: {
        withReservation: async (providerIds, operation) => {
          reserved = true
          try {
            return await operation([...new Set(providerIds)])
          } finally {
            reserved = false
          }
        },
        set: async () => {
          throw new Error('Unexpected existing Session update.')
        }
      }
    })

    await expect(
      runner.startRun({
        project: project.id,
        prompt: 'Start the analysis.',
        computeHostIds: ['ssh:cluster']
      })
    ).resolves.toMatchObject({
      preferredComputeHostIds: ['ssh:cluster']
    })
    expect(save).toHaveBeenCalled()
    expect(reserved).toBe(false)
  })

  it('preserves a generic new Session persistence error', async () => {
    const persistenceFailure = new Error('Session store migration is unavailable.')
    const createSession = vi.fn(async () => ({ sessionId: 'session-created' }))
    const prompt = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => {
          throw persistenceFailure
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession,
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt
      }
    })

    await expect(
      runner.startRun({ project: project.id, prompt: 'Start the analysis.' })
    ).rejects.toBe(persistenceFailure)
    expect(createSession).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('lists projects through its public interface', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const runner = createRunner({ projects })

    await expect(runner.listProjects()).resolves.toEqual([{ ...project, hasAgentContext: false }])
  })

  it('projects and updates Agent Context without exposing its contents', async () => {
    const contextualProject = { ...project, agentContext: 'Always cite sources.' }
    const update = vi.fn(async (request) => ({ ...contextualProject, ...request, updatedAt: 2 }))
    const runner = createRunner({
      projects: {
        list: async () => [contextualProject],
        create: async (request) => ({ ...contextualProject, ...request }),
        update
      }
    })

    await expect(runner.listProjects()).resolves.toEqual([{ ...project, hasAgentContext: true }])
    await expect(
      runner.updateProject(project.id, {
        expectedUpdatedAt: project.updatedAt,
        agentContext: 'Prefer Python.',
        id: 'project-redirect',
        pinned: true
      } as never)
    ).resolves.toEqual({ ...project, updatedAt: 2, hasAgentContext: true })
    expect(update).toHaveBeenCalledWith({
      id: project.id,
      expectedUpdatedAt: project.updatedAt,
      agentContext: 'Prefer Python.'
    })

    update.mockRejectedValueOnce(new Error('Project changed elsewhere.'))
    await expect(
      runner.updateProject(project.id, {
        expectedUpdatedAt: project.updatedAt,
        agentContext: ''
      })
    ).rejects.toMatchObject({
      code: 'project_conflict',
      message: 'Project changed elsewhere. Refresh it and try again.'
    })
  })

  it('rejects an empty project name before creating a project', async () => {
    let created = false
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => {
        created = true
        return { ...project, ...request }
      }
    }
    const runner = createRunner({ projects })

    await expect(runner.createProject({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Project name is required.'
    })
    expect(created).toBe(false)
  })

  it('lists session snapshots for a project id', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const sessions: TaskRunnerOverrides['sessions'] = {
      list: async () => [session],
      save: async (value) => value,
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runner = createRunner({ projects, sessions })

    await expect(runner.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ id: session.id, projectId: project.id, title: session.title })
    ])
  })

  it('does not route headless requests by project display name', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const runner = createRunner({ projects })

    await expect(runner.listSessions(project.name)).rejects.toMatchObject({
      code: 'project_not_found'
    })
    await expect(
      runner.startRun({ project: project.name, prompt: 'Review these papers.' })
    ).rejects.toMatchObject({ code: 'project_not_found' })
  })

  it('returns a durable session snapshot and its artifacts', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined }
    })

    await expect(runner.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      artifactCount: 1
    })
    await expect(runner.listArtifacts(session.id)).resolves.toEqual(artifactSession.artifacts)
  })

  it('acquires and releases a persisted artifact through the preview-resource port', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const released: string[] = []
    const previewResources: TaskPreviewResourcePort = {
      acquire: async () => ({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.md',
        size: 12,
        mimeType: 'text/markdown'
      }),
      release: async (resourceId) => {
        released.push(resourceId)
      }
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined },
      previewResources
    })

    await expect(runner.acquireArtifact('artifact-1')).resolves.toMatchObject({
      resourceId: 'resource-1',
      name: 'report.md',
      mimeType: 'text/markdown'
    })
    await runner.releaseArtifact('resource-1')
    expect(released).toEqual(['resource-1'])
  })

  it('rejects malformed run requests before crossing a port', async () => {
    let listedProjects = false
    const runner = createRunner({
      projects: {
        list: async () => {
          listedProjects = true
          return [project]
        },
        create: async (request) => ({ ...project, ...request })
      }
    })

    await expect(runner.startRun(null as never)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Run request must be an object.'
    })
    await expect(
      runner.startRun({
        project: project.id,
        prompt: 'Research',
        permissionProfile: 'unsafe' as never
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      runner.startRun({ project: project.id, prompt: 'Research', cwd: 'relative/workspace' })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Working directory must be an absolute path.'
    })
    await expect(
      runner.startRun({ project: project.id, prompt: 'Research', cwd: 42 as never })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Working directory must be a string.'
    })
    expect(listedProjects).toBe(false)
  })

  it('rejects missing and non-directory paths before creating an external-workspace Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-task-cwd-file-'))
    temporaryRoots.push(root)
    const filePath = join(root, 'input.txt')
    await writeFile(filePath, 'not a directory', 'utf8')
    const createSession = vi.fn(async () => ({ sessionId: 'must-not-create' }))
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession,
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      }
    })

    const missingPath = join(root, 'missing')
    await expect(
      runner.startRun({
        project: project.id,
        prompt: 'Research in a missing directory.',
        cwd: missingPath
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: `Working directory does not exist: ${missingPath}`
    })

    await expect(
      runner.startRun({
        project: project.id,
        prompt: 'Research this file.',
        cwd: filePath
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: `Working directory is not a directory: ${filePath}`
    })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('rejects rebinding an existing Session to a different Specialist', async () => {
    const bound = { ...session, specialistId: 'specialist-existing' }
    const runner = createRunner({
      sessions: { list: async () => [bound], save: async () => undefined },
      specialists: { resolve: async () => ({ id: 'specialist-other' }) }
    })

    await expect(
      runner.startRun({
        project: project.id,
        sessionId: bound.id,
        prompt: 'Continue with another Specialist.',
        specialist: 'other-name'
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: `Session ${bound.id} is bound to a different Specialist.`
    })
  })

  it('rejects enabled Compute Host changes while resuming an existing Session', async () => {
    const save = vi.fn(async (value: PersistedChatSession) => value)
    const runner = createRunner({
      sessions: { list: async () => [session], save }
    })

    await expect(
      runner.startRun({
        project: project.id,
        sessionId: session.id,
        prompt: 'Continue with changed host access.',
        enabledComputeHostIds: ['ssh:alpha']
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message:
        'Provider, model, reasoning effort, memory, and enabled Compute Hosts must be changed with session config update before resuming an existing Session.'
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects a cwd that conflicts with an existing Session workspace', async () => {
    const existingRoot = await mkdtemp(join(tmpdir(), 'open-science-task-existing-cwd-'))
    const requestedRoot = await mkdtemp(join(tmpdir(), 'open-science-task-requested-cwd-'))
    temporaryRoots.push(existingRoot, requestedRoot)
    const existing = { ...session, cwd: existingRoot }
    const withSessionAvailable = vi.fn(async (_projectId, _sessionId, operation) => operation())
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable,
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'must-not-create' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      }
    })

    await expect(
      runner.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue elsewhere.',
        cwd: requestedRoot
      })
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: `Working directory does not match Session ${existing.id}.`
    })
    expect(withSessionAvailable).not.toHaveBeenCalled()
  })

  it('keeps an existing explicit workspace spelling when cwd resolves to the same directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-task-equivalent-cwd-'))
    temporaryRoots.push(root)
    await mkdir(join(root, 'nested'))
    const existingCwd = `${root}${sep}nested${sep}..`
    const existing = { ...session, cwd: existingCwd }
    const savedSessions: PersistedChatSession[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'must-not-create' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      }
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue in place.',
      cwd: root
    })
    expect(started.cwd).toBe(existingCwd)

    await runner.waitForRun(started.id)
    expect(savedSessions.at(-1)?.cwd).toBe(existingCwd)
  })

  it('runs a prompt in a new durable session and returns the assistant output', async () => {
    const requestedCwd = await mkdtemp(join(tmpdir(), 'open-science-task-cwd-'))
    temporaryRoots.push(requestedCwd)
    const canonicalCwd = await realpath(requestedCwd)
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const createRequests: unknown[] = []
    const ids = ['user-message-1', 'run-1', 'assistant-message-1']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async (request) => {
          createRequests.push(request)
          return {
            sessionId: 'session-1',
            cwd: canonicalCwd,
            frameworkId: 'codex',
            backendId: 'codex:shared',
            agentConfiguration: {
              providerId: 'provider-default',
              model: 'model-default',
              reasoningEffort: 'medium'
            }
          }
        },
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'event-1',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-1',
            role: 'assistant',
            text: 'Research complete.'
          })
          emitEvent?.({
            id: 'event-2',
            timestamp: 11,
            kind: 'stop',
            level: 'info',
            sessionId: 'session-1',
            text: 'end_turn',
            turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 1 },
            modelCallUsage: [
              {
                id: 'assistant-message-1:model-call:0',
                index: 0,
                inputTokens: 31,
                cacheTokens: 15,
                outputTokens: 14,
                contextUsedTokens: 46,
                contextWindowSize: 128_000
              }
            ]
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Review these papers.',
      permissionProfile: 'auto',
      cwd: requestedCwd
    })
    expect(started).toMatchObject({
      id: 'run-1',
      sessionId: 'session-1',
      projectId: project.id,
      status: 'running',
      cwd: canonicalCwd
    })

    expect(createRequests).toEqual([
      { projectId: project.id, permissionProfile: 'auto', cwd: canonicalCwd }
    ])

    await expect(runner.waitForRun('run-1')).resolves.toMatchObject({
      status: 'completed',
      output: 'Research complete.',
      cwd: canonicalCwd
    })
    expect(savedSessions.at(-1)).toMatchObject({
      id: 'session-1',
      projectId: project.id,
      cwd: canonicalCwd,
      status: 'idle',
      permissionProfile: 'auto',
      agentConfiguration: {
        providerId: 'provider-default',
        model: 'model-default',
        reasoningEffort: 'medium'
      },
      messages: [
        { id: 'user-message-1', role: 'user', content: 'Review these papers.' },
        {
          id: 'assistant-message-1',
          role: 'agent',
          content: 'Research complete.',
          turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 1 },
          modelCallUsage: [
            {
              id: 'assistant-message-1:model-call:0',
              index: 0,
              inputTokens: 31,
              cacheTokens: 15,
              outputTokens: 14,
              contextUsedTokens: 46,
              contextWindowSize: 128_000
            }
          ]
        }
      ]
    })
  })

  it('applies Plan, review, Specialist, and delegation controls to a new Session', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const createSession = vi.fn(async () => ({
      sessionId: 'session-controlled',
      frameworkId: 'codex' as const
    }))
    const prompt = vi.fn(async () => {
      emitEvent?.({
        id: 'plan-event',
        timestamp: 9,
        kind: 'plan',
        level: 'info',
        sessionId: 'session-controlled',
        text: 'Plan awaiting approval.',
        planProjection: {
          artifactId: 'plan-artifact',
          artifactVersionId: 'plan-version',
          artifactChecksum: 'plan-checksum',
          revision: 2,
          approval: 'pending',
          lifecycle: 'awaiting_approval'
        } as never
      })
      emitEvent?.({
        id: 'message-event',
        timestamp: 10,
        kind: 'message',
        level: 'info',
        sessionId: 'session-controlled',
        role: 'assistant',
        text: 'Controlled output.'
      })
    })
    const resolveSpecialist = vi.fn(async () => ({ id: 'specialist-uuid' }))
    const review = vi.fn(async () => ({
      started: true,
      id: 'review-1',
      lifecycle: 'complete' as const,
      outcome: 'pass' as const
    }))
    const ids = ['user-controlled', 'run-controlled', 'assistant-controlled']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession,
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt
      },
      specialists: { resolve: resolveSpecialist },
      reviewer: { review },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Plan and execute.',
      turnIntent: 'plan-first',
      autoReviewEnabled: true,
      specialist: 'stable-specialist-name',
      delegationPolicy: 'deny'
    })
    const completed = await runner.waitForRun(started.id)

    expect(resolveSpecialist).toHaveBeenCalledWith('stable-specialist-name')
    expect(createSession).toHaveBeenCalledWith({
      projectId: project.id,
      permissionProfile: 'ask',
      specialistId: 'specialist-uuid'
    })
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIntent: 'plan-first',
        promptMessageId: 'user-controlled',
        provenanceContext: {
          rootFrameId: 'root-frame-session-controlled',
          agentFrameId: 'root-frame-session-controlled',
          messageBranchId: 'message-branch-session-controlled',
          messageBranchAncestry: ['message-branch-session-controlled'],
          messageAncestry: ['user-controlled'],
          runtimeSegmentId: 'runtime-segment-session-controlled',
          promptMessageId: 'user-controlled'
        }
      }),
      expect.any(Object)
    )
    expect(savedSessions.at(-1)).toMatchObject({
      autoReviewEnabled: true,
      specialistId: 'specialist-uuid',
      delegationPolicy: 'deny',
      messages: [
        expect.objectContaining({ id: 'user-controlled', turnIntent: 'plan-first' }),
        expect.objectContaining({ id: 'assistant-controlled', content: 'Controlled output.' })
      ]
    })
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-controlled' }),
      'assistant-controlled',
      expect.any(AbortSignal)
    )
    expect(completed.review).toEqual({
      started: true,
      id: 'review-1',
      lifecycle: 'complete',
      outcome: 'pass'
    })
    expect(completed.attention).toMatchObject({
      kind: 'plan-approval',
      plan: { artifactVersionId: 'plan-version', revision: 2 }
    })
  })

  it('aborts an in-flight automatic review when Run cancellation is accepted', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markReviewStarted: (() => void) | undefined
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve
    })
    const review = vi.fn(
      (_session: PersistedChatSession, _turnMessageId: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          markReviewStarted?.()
          const rejectCancellation = (): void => reject(new Error('review cancelled'))
          if (signal.aborted) rejectCancellation()
          else signal.addEventListener('abort', rejectCancellation, { once: true })
        })
    )
    const cancelPrompt = vi.fn(async () => undefined)
    const ids = ['review-user', 'review-run', 'review-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => undefined
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-review-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt,
        prompt: async () => {
          emitEvent?.({
            id: 'review-message-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-review-cancel',
            role: 'assistant',
            text: 'Review this output.'
          })
        }
      },
      reviewer: { review },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Produce and review.',
      autoReviewEnabled: true
    })
    await reviewStarted
    const cancelled = await runner.cancelRun(started.id)

    expect(cancelled).toMatchObject({ status: 'cancelled', review: undefined })
    expect(cancelPrompt).toHaveBeenCalledWith('session-review-cancel')
    expect(review.mock.calls[0]?.[2].aborted).toBe(true)
  })

  it('aborts and awaits an in-flight automatic review when disposed', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markReviewStarted: (() => void) | undefined
    let releaseReviewCleanup: (() => void) | undefined
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve
    })
    const reviewCleanup = new Promise<void>((resolve) => {
      releaseReviewCleanup = resolve
    })
    const review = vi.fn(
      (_session: PersistedChatSession, _turnMessageId: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          markReviewStarted?.()
          const rejectAfterCleanup = (): void => {
            void reviewCleanup.then(() => reject(new Error('review disposed')))
          }
          if (signal.aborted) rejectAfterCleanup()
          else signal.addEventListener('abort', rejectAfterCleanup, { once: true })
        })
    )
    const ids = ['dispose-user', 'dispose-run', 'dispose-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => undefined
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-review-dispose' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'dispose-message-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-review-dispose',
            role: 'assistant',
            text: 'Review before disposal.'
          })
        }
      },
      reviewer: { review },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    await runner.startRun({
      project: project.id,
      prompt: 'Produce and review before disposal.',
      autoReviewEnabled: true
    })
    await reviewStarted
    let disposed = false
    const disposal = runner.dispose().then(() => {
      disposed = true
    })

    expect(review.mock.calls[0]?.[2].aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseReviewCleanup?.()
    await disposal
    expect(disposed).toBe(true)
  })

  it('bounds disposal when an automatic reviewer ignores abort', async () => {
    vi.useFakeTimers()
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markReviewStarted: (() => void) | undefined
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve
    })
    const review = vi.fn(
      (...args: [PersistedChatSession, string, AbortSignal]) =>
        new Promise<never>(() => {
          args[2].addEventListener('abort', () => undefined, { once: true })
          markReviewStarted?.()
        })
    )
    const ids = ['hung-review-user', 'hung-review-run', 'hung-review-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => undefined
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-hung-review-dispose' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'hung-review-message-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-hung-review-dispose',
            role: 'assistant',
            text: 'Review never settles.'
          })
        }
      },
      reviewer: { review },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    try {
      await runner.startRun({
        project: project.id,
        prompt: 'Produce a review that never settles.',
        autoReviewEnabled: true
      })
      await reviewStarted
      let disposed = false
      void runner.dispose().then(() => {
        disposed = true
      })

      expect(review.mock.calls[0]?.[2].aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(TASK_RUN_DISPOSAL_BUDGET_MS)
      expect(disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the dedicated policy mutation for an existing Session', async () => {
    const existing = { ...session, delegationPolicy: 'allow' as const }
    const setDelegationPolicy = vi.fn(async () => undefined)
    const ids = ['policy-user', 'policy-run', 'policy-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async () => undefined,
        setDelegationPolicy
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue without delegation.',
      delegationPolicy: 'deny'
    })
    await runner.waitForRun(started.id)

    expect(setDelegationPolicy).toHaveBeenCalledOnce()
    expect(setDelegationPolicy).toHaveBeenCalledWith(project.id, existing.id, 'deny')
  })

  it('skips automatic review when the current turn has no assistant message', async () => {
    const historical: PersistedChatSession = {
      ...session,
      autoReviewEnabled: true,
      messages: [
        {
          id: 'historical-user',
          role: 'user',
          content: 'Earlier request.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'historical-agent',
          role: 'agent',
          content: 'Earlier response.',
          status: 'complete',
          responseToMessageId: 'historical-user',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    const savedSessions: PersistedChatSession[] = []
    const review = vi.fn(async () => ({ started: true }))
    const ids = ['current-user', 'current-run', 'unused-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [historical],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [historical.id],
        createSession: async () => ({ sessionId: 'must-not-create' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      },
      reviewer: { review },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: historical.id,
      prompt: 'Produce no visible response.'
    })
    const completed = await runner.waitForRun(started.id)

    expect(completed).toMatchObject({ status: 'completed', output: '' })
    expect(review).not.toHaveBeenCalled()
    expect(savedSessions.at(-1)?.messages).toHaveLength(3)
  })
  it('keeps concurrent external-workspace Sessions isolated by canonical cwd', async () => {
    const requestedCwds = await Promise.all([
      mkdtemp(join(tmpdir(), 'open-science-task-concurrent-a-')),
      mkdtemp(join(tmpdir(), 'open-science-task-concurrent-b-'))
    ])
    temporaryRoots.push(...requestedCwds)
    const canonicalCwds = await Promise.all(requestedCwds.map((cwd) => realpath(cwd)))
    const sessionIdByCwd = new Map([
      [canonicalCwds[0], 'session-a'],
      [canonicalCwds[1], 'session-b']
    ])
    const createRequests: Array<{ projectId: string; permissionProfile: string; cwd?: string }> = []
    const savedSessions: PersistedChatSession[] = []
    let nextId = 0
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async (request) => {
          createRequests.push(request)
          return {
            sessionId: sessionIdByCwd.get(request.cwd ?? '') ?? 'unexpected-session',
            cwd: request.cwd
          }
        },
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      },
      createId: () => `generated-${++nextId}`
    })

    const started = await Promise.all(
      requestedCwds.map((cwd, index) =>
        runner.startRun({ project: project.id, prompt: `Research stream ${index + 1}.`, cwd })
      )
    )
    const completed = await Promise.all(started.map((run) => runner.waitForRun(run.id)))

    expect(createRequests).toEqual(
      expect.arrayContaining(
        canonicalCwds.map((cwd) => ({ projectId: project.id, permissionProfile: 'ask', cwd }))
      )
    )
    for (const [index, cwd] of canonicalCwds.entries()) {
      const sessionId = sessionIdByCwd.get(cwd)
      expect(started[index]).toMatchObject({ sessionId, cwd })
      expect(completed[index]).toMatchObject({ sessionId, cwd, status: 'completed' })
      expect(savedSessions.findLast((saved) => saved.id === sessionId)).toMatchObject({
        id: sessionId,
        cwd,
        status: 'idle'
      })
    }
  })

  it('publishes ordered Run progress from acceptance through completion', async () => {
    const runner = createRunner()
    const progress: Array<{ phase: string; heartbeat: boolean }> = []
    const unsubscribe = runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat })
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
    await runner.waitForRun(started.id)

    expect(progress).toEqual([
      { phase: 'accepted', heartbeat: false },
      { phase: 'session-ready', heartbeat: false },
      { phase: 'prompt-dispatched', heartbeat: false },
      { phase: 'completed', heartbeat: false }
    ])

    unsubscribe()
    await runner.dispose()
  })

  it('marks provider acceptance before the first visible provider event', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const phases: string[] = []
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          observer?.onProviderPromptAccepted?.()
          emitEvent?.({
            id: 'assistant-1',
            timestamp: 2,
            sessionId: request.sessionId,
            promptMessageId: request.promptMessageId,
            kind: 'message',
            role: 'assistant',
            level: 'info',
            text: 'Working on it.'
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => {
            emitEvent = undefined
          }
        }
      }
    })
    runner.subscribeProgress((event) => phases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
    await runner.waitForRun(started.id)

    expect(phases).toEqual([
      'accepted',
      'session-ready',
      'prompt-dispatched',
      'provider-accepted',
      'first-visible-output',
      'completed'
    ])
    await runner.dispose()
  })

  it('emits liveness heartbeats until the first visible provider event', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let finishPrompt: (() => void) | undefined
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const progress: Array<{ phase: string; heartbeat: boolean; elapsedMs: number }> = []
    const runner = createRunner({
      now: Date.now,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => prompt
      }
    })
    runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat, elapsedMs: event.elapsedMs })
    })

    try {
      const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(progress.at(-1)).toEqual({
        phase: 'prompt-dispatched',
        heartbeat: true,
        elapsedMs: 10_000
      })

      finishPrompt?.()
      await runner.waitForRun(started.id)
      const countAfterCompletion = progress.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(progress).toHaveLength(countAfterCompletion)
    } finally {
      await runner.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps Run execution independent from progress subscriber failures', async () => {
    const runner = createRunner()
    runner.subscribeProgress(() => {
      throw new Error('subscriber failed')
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })

    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({ status: 'completed' })
    await runner.dispose()
  })

  it('stops liveness heartbeats after the first visible provider event', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let acceptProvider: (() => void) | undefined
    let finishPrompt: (() => void) | undefined
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const progress: Array<{ phase: string; heartbeat: boolean }> = []
    const runner = createRunner({
      now: Date.now,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          acceptProvider = observer?.onProviderPromptAccepted
          return prompt
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => {
            emitEvent = undefined
          }
        }
      }
    })
    runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat })
    })

    try {
      const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
      acceptProvider?.()
      emitEvent?.({
        id: 'other-prompt-assistant',
        timestamp: 2,
        sessionId: 'session-1',
        promptMessageId: 'other-prompt',
        kind: 'message',
        role: 'assistant',
        level: 'info',
        text: 'Unrelated side-chat output.'
      })
      expect(progress.at(-1)).toEqual({ phase: 'provider-accepted', heartbeat: false })
      emitEvent?.({
        id: 'provider-warning',
        timestamp: 3,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'system',
        level: 'warning',
        text: 'Provider is retrying.'
      })
      emitEvent?.({
        id: 'terminal-stop',
        timestamp: 4,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'stop',
        level: 'info',
        title: 'Prompt stopped',
        text: 'end_turn'
      })
      expect(progress.at(-1)).toEqual({ phase: 'provider-accepted', heartbeat: false })
      emitEvent?.({
        id: 'assistant-1',
        timestamp: 5,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'message',
        role: 'assistant',
        level: 'info',
        text: 'Working on it.'
      })
      const countAfterFirstOutput = progress.length

      await vi.advanceTimersByTimeAsync(20_000)
      expect(progress).toHaveLength(countAfterFirstOutput)
      expect(progress.slice(-2)).toEqual([
        { phase: 'provider-accepted', heartbeat: false },
        { phase: 'first-visible-output', heartbeat: false }
      ])

      finishPrompt?.()
      const completed = await runner.waitForRun(started.id)
      expect(completed.output).toBe('Working on it.')
    } finally {
      await runner.dispose()
      vi.useRealTimers()
    }
  })

  it('rejects overlapping runs for the same durable session', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const existing: PersistedChatSession = {
      ...session,
      id: 'session-busy',
      cwd: '/workspace/session-busy'
    }
    const ids = ['first-user', 'first-run', 'second-user', 'second-run', 'assistant-message']
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => promptGate
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const first = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'First prompt'
    })

    try {
      await expect(
        runner.startRun({
          project: project.id,
          sessionId: existing.id,
          prompt: 'Overlapping prompt'
        })
      ).rejects.toMatchObject({
        code: 'session_busy',
        message: `Session already has an active run: ${existing.id}`
      })
    } finally {
      finishPrompt?.()
      await runner.waitForRun(first.id)
    }
  })

  it('does not persist a Task turn when ACP rejects admission for an active desktop turn', async () => {
    const existing: PersistedChatSession = {
      ...session,
      status: 'running',
      messages: [
        {
          id: 'desktop-prompt',
          role: 'user',
          content: 'Desktop prompt',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activeRun: { promptMessageId: 'desktop-prompt', startedAt: 1 }
    }
    const save = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          throw new Error('An ACP interaction is already running for this session')
        }
      }
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Task API prompt'
    })
    const failed = await runner.waitForRun(started.id)

    expect(save).not.toHaveBeenCalled()
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'An ACP interaction is already running for this session'
    })
  })

  it('persists detached provider rebinding without a Task turn when admission rejects', async () => {
    const existing: PersistedChatSession = {
      ...session,
      revision: 1,
      providerSessionId: 'provider-session-old',
      providerContinuityToken: 'continuity-old',
      messages: []
    }
    let durableSession = structuredClone(existing)
    const save = vi.fn(async (candidate: PersistedChatSession) => {
      durableSession = {
        ...structuredClone(candidate),
        revision: (candidate.revision ?? 0) + 1
      }
      return structuredClone(durableSession)
    })
    const runner = createRunner({
      sessions: { list: async () => [structuredClone(durableSession)], save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({
          sessionId: existing.id,
          frameworkId: 'opencode',
          backendId: 'opencode:provider-new',
          providerSessionId: 'provider-session-new',
          providerContinuityToken: 'continuity-new',
          contextReset: true
        }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          throw new Error('An ACP interaction is already running for this session')
        }
      }
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Task API prompt'
    })
    const failed = await runner.waitForRun(started.id)

    expect(save).toHaveBeenCalledOnce()
    expect(durableSession).toMatchObject({
      status: existing.status,
      messages: existing.messages,
      providerSessionId: 'provider-session-new',
      providerContinuityToken: 'continuity-new',
      agentFrameworkId: 'opencode',
      agentBackendId: 'opencode:provider-new',
      pendingHistoryReplay: { kind: 'all' }
    })
    expect(durableSession).not.toHaveProperty('activeRun')
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'An ACP interaction is already running for this session'
    })
  })

  it('cleans up an admitted Task turn when Session persistence commits before rejecting', async () => {
    let durableSession: PersistedChatSession = {
      ...session,
      revision: 1,
      messages: []
    }
    const save = vi.fn(async (candidate: PersistedChatSession) => {
      if (candidate.revision !== durableSession.revision) {
        throw new Error('Session revision conflict')
      }
      durableSession = {
        ...structuredClone(candidate),
        revision: (candidate.revision ?? 0) + 1
      }
      throw new Error('index unavailable after durable commit')
    })
    const runner = createRunner({
      sessions: { list: async () => [structuredClone(durableSession)], save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [durableSession.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      }
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: durableSession.id,
      prompt: 'Task API prompt'
    })
    const failed = await runner.waitForRun(started.id)

    expect(save).toHaveBeenCalledTimes(2)
    expect(durableSession).toMatchObject({
      status: 'error',
      activeRun: undefined,
      error: 'index unavailable after durable commit'
    })
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'index unavailable after durable commit'
    })
  })

  it('rebases an admitted Task turn onto concurrent Session metadata edits', async () => {
    let durableSession: PersistedChatSession = {
      ...session,
      revision: 1,
      messages: []
    }
    const list = vi.fn(async () => [structuredClone(durableSession)])
    const save = vi.fn(async (candidate: PersistedChatSession) => {
      if (candidate.revision !== durableSession.revision) {
        throw new Error('Session revision conflict')
      }
      durableSession = {
        ...structuredClone(candidate),
        revision: (candidate.revision ?? 0) + 1
      }
      return structuredClone(durableSession)
    })
    const runner = createRunner({
      sessions: { list, save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [durableSession.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          durableSession = {
            ...durableSession,
            title: 'Renamed concurrently',
            description: 'Keep this edit',
            revision: 2,
            updatedAt: 3
          }
          await observer?.onPromptAdmitted?.()
        }
      },
      createId: (() => {
        const ids = ['task-user', 'task-run', 'unused-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: durableSession.id,
      prompt: 'Task API prompt'
    })
    const completed = await runner.waitForRun(started.id)

    expect(completed.status).toBe('completed')
    expect(list).toHaveBeenCalledTimes(2)
    expect(durableSession).toMatchObject({
      title: 'Renamed concurrently',
      description: 'Keep this edit'
    })
    expect(durableSession.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-user', content: 'Task API prompt' })
      ])
    )
  })

  it('rejects a new authored turn while a restored Plan awaits approval', async () => {
    const existing: PersistedChatSession = {
      ...session,
      id: 'session-plan-pending',
      status: 'waiting-plan-approval',
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: {
          artifactId: 'plan-artifact',
          artifactVersionId: 'plan-version',
          artifactChecksum: 'plan-checksum',
          approval: 'pending',
          stepStatuses: {}
        }
      }
    }
    const resumeSession = vi.fn(async () => ({ sessionId: existing.id }))
    const save = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      }
    })

    await expect(
      runner.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Start another turn.'
      })
    ).rejects.toMatchObject({
      code: 'session_busy',
      message: `Session is waiting for Plan approval: ${existing.id}`
    })
    expect(resumeSession).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('checks archive admission before an existing session is resumed or saved', async () => {
    const existing = { ...session, id: 'session-archived' }
    const resumeSession = async (): Promise<never> => {
      throw new Error('must not resume')
    }
    const save = async (): Promise<never> => {
      throw new Error('must not save')
    }
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      agent: {
        withSessionAvailable: async () => {
          throw new Error('Restore this archived Session before continuing.')
        },
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      }
    })

    await expect(
      runner.startRun({ project: project.id, sessionId: existing.id, prompt: 'Resume research.' })
    ).rejects.toThrow('Restore this archived Session before continuing.')
  })

  it('resumes a detached session without duplicating the new prompt in history replay', async () => {
    const existing: PersistedChatSession = {
      ...session,
      memoryEnabled: false,
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      },
      messages: [
        {
          id: 'old-user',
          role: 'user',
          content: 'Initial question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'old-agent',
          role: 'agent',
          content: 'Initial answer',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    let admissionActive = false
    let saveCount = 0
    const savedSessions: PersistedChatSession[] = []
    const resumeRequests: Parameters<TaskRunnerDependencies['agent']['resumeSession']>[0][] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'run-2', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saveCount += 1
          savedSessions.push(structuredClone(value))
          if (saveCount === 1) expect(admissionActive).toBe(true)
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => {
          admissionActive = true
          try {
            return await operation()
          } finally {
            admissionActive = false
          }
        },
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => {
          expect(admissionActive).toBe(true)
          resumeRequests.push(request)
          return { sessionId: existing.id, cwd: existing.cwd, contextReset: true }
        },
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          await observer?.onPromptAdmitted?.()
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Follow-up question',
      permissionProfile: 'auto'
    })
    await runner.waitForRun(started.id)
    expect(admissionActive).toBe(false)
    expect(saveCount).toBeGreaterThanOrEqual(1)

    expect(resumeRequests).toEqual([
      expect.objectContaining({
        sessionId: existing.id,
        permissionProfile: 'auto',
        agentConfiguration: existing.agentConfiguration
      })
    ])
    expect(prompts).toEqual([
      {
        sessionId: existing.id,
        promptMessageId: 'new-user',
        provenanceContext: {
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'root-frame-session-1',
          messageBranchId: 'message-branch-session-1',
          messageBranchAncestry: ['message-branch-session-1'],
          messageAncestry: ['old-user', 'old-agent', 'new-user'],
          runtimeSegmentId: expect.not.stringMatching('runtime-segment-session-1'),
          promptMessageId: 'new-user'
        },
        text: 'Follow-up question',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Initial question\n\nAssistant: Initial answer'
      }
    ])
    const promptRuntimeSegmentId = prompts[0]?.provenanceContext.runtimeSegmentId
    expect(
      savedSessions.some(
        (saved) =>
          saved.activeRun?.promptMessageId === 'new-user' &&
          saved.conversationGraph?.runtimeSegments.some(({ id }) => id === promptRuntimeSegmentId)
      )
    ).toBe(true)
  })

  it('adopts a persisted agent configuration for an attached session', async () => {
    const existing: PersistedChatSession = {
      ...session,
      memoryEnabled: false,
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      }
    }
    const resumeSession = vi.fn(async () => ({ sessionId: existing.id, cwd: existing.cwd }))
    const ids = ['new-user', 'run-2', 'new-agent']
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue with the saved model.'
    })
    await runner.waitForRun(started.id)

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: existing.id,
        memoryEnabled: false,
        agentConfiguration: existing.agentConfiguration
      })
    )
  })

  it('materializes legacy agent identity before continuing an attached session', async () => {
    const existing: PersistedChatSession = {
      ...session,
      agentFrameworkId: 'opencode',
      agentBackendId: 'opencode:provider-legacy',
      agentModel: 'model-legacy'
    }
    const materializedConfiguration = {
      providerId: 'provider-legacy',
      model: 'model-legacy',
      reasoningEffort: 'high' as const
    }
    const resumeSession = vi.fn(async () => ({
      sessionId: existing.id,
      cwd: existing.cwd,
      agentConfiguration: materializedConfiguration
    }))
    const save = vi.fn(async (saved: PersistedChatSession) => saved)
    const ids = ['new-user', 'run-2', 'new-agent']
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue with the historical model.'
    })
    await runner.waitForRun(started.id)

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        previousBackendId: 'opencode:provider-legacy',
        previousModel: 'model-legacy'
      })
    )
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ agentConfiguration: materializedConfiguration })
    )
  })

  it('starts a new run without replaying an interrupted task prompt or retaining recovery state', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Collect the papers',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'Collected 20 papers',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'interrupted-user',
          role: 'user',
          content: 'Delete the duplicates',
          status: 'complete',
          interrupted: true,
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'interrupted-user'
      },
      pendingHistoryReplay: { kind: 'before-message', messageId: 'interrupted-user' },
      error: 'Session was interrupted before the app closed.'
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({
          sessionId: existing.id,
          cwd: existing.cwd,
          contextReset: true
        }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          await observer?.onPromptAdmitted?.()
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue with a different cleanup rule.'
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      expect.objectContaining({
        text: 'Continue with a different cleanup rule.',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Collect the papers\n\nAssistant: Collected 20 papers'
      })
    ])
    expect(prompts[0]?.historyPreamble).not.toContain('Delete the duplicates')
    const admitted = saved.find(({ activeRun }) => activeRun?.promptMessageId === 'new-user')
    expect(admitted).not.toHaveProperty('resumeRecovery')
    expect(admitted?.pendingHistoryReplay).toEqual({
      kind: 'before-message',
      messageId: 'interrupted-user'
    })
    expect(saved.at(-1)).not.toHaveProperty('pendingHistoryReplay')
    expect(
      admitted?.messages.filter((message) => message.content === 'Delete the duplicates')
    ).toHaveLength(1)
  })

  it('replays and consumes full-history recovery for an attached task session', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Summarize the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'The evidence is mixed.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      pendingHistoryReplay: { kind: 'all' }
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({ sessionId: 'unused' }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          await observer?.onPromptAdmitted?.()
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Compare the evidence groups.'
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      expect.objectContaining({
        text: 'Compare the evidence groups.',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Summarize the evidence\n\nAssistant: The evidence is mixed.'
      })
    ])
    expect(saved[0].pendingHistoryReplay).toEqual({ kind: 'all' })
    expect(saved.at(-1)).not.toHaveProperty('pendingHistoryReplay')
  })

  it('retains full-history replay when the task prompt is rejected before acceptance', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Summarize the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'The evidence is mixed.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      pendingHistoryReplay: { kind: 'all' }
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({ sessionId: 'unused' }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          await observer?.onPromptAdmitted?.()
          prompts.push(request)
          throw new Error('provider rejected prompt')
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Compare the evidence groups.'
    })
    const completed = await runner.waitForRun(started.id)

    expect(completed.status).toBe('failed')
    expect(prompts[0]).toMatchObject({
      contextReset: true,
      historyPreamble:
        'Previous conversation:\n\nUser: Summarize the evidence\n\nAssistant: The evidence is mixed.'
    })
    expect(saved[0].pendingHistoryReplay).toEqual({ kind: 'all' })
    expect(saved.at(-1)?.pendingHistoryReplay).toEqual({ kind: 'all' })
  })

  it('provides transcript fallback for skill-triggered reconnects', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Prior question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'Prior answer',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['skill-user', 'skill-run', 'skill-agent']
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Use the selected skill.',
      skillIds: ['literature-review']
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      {
        sessionId: existing.id,
        promptMessageId: 'skill-user',
        provenanceContext: {
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'root-frame-session-1',
          messageBranchId: 'message-branch-session-1',
          messageBranchAncestry: ['message-branch-session-1'],
          messageAncestry: ['prior-user', 'prior-agent', 'skill-user'],
          runtimeSegmentId: 'runtime-segment-session-1',
          promptMessageId: 'skill-user'
        },
        text: 'Use the selected skill.',
        skillIds: ['literature-review'],
        resumeFallback: {
          historyPreamble:
            'Previous conversation:\n\nUser: Prior question\n\nAssistant: Prior answer'
        }
      }
    ])
  })

  it('marks artifact-only completions when turn usage is unavailable', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const ids = ['artifact-user', 'artifact-run', 'artifact-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-artifact', cwd: '/workspace/artifact' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'artifact-event',
            timestamp: 10,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-artifact',
            runId: 'artifact-run',
            artifactClaimId: 'artifact-claim',
            artifacts: []
          })
          emitEvent?.({
            id: 'artifact-stop',
            timestamp: 11,
            kind: 'stop',
            level: 'info',
            sessionId: 'session-artifact',
            text: 'end_turn'
          })
        }
      },
      artifacts: {
        finalizeRun: async () => ({
          ok: true,
          artifacts: [
            {
              id: 'artifact-file',
              projectId: project.id,
              sessionId: 'session-artifact',
              messageId: 'artifact-agent',
              name: 'result.txt',
              path: '/artifacts/result.txt',
              fileUrl: 'open-science-preview://artifact-file/result.txt',
              mimeType: 'text/plain',
              size: 6,
              createdAt: '1970-01-01T00:00:00.010Z',
              mtimeMs: 11
            }
          ]
        })
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create a file.' })
    const completed = await runner.waitForRun(started.id)

    expect(completed).toMatchObject({
      status: 'completed',
      artifacts: [{ id: 'artifact-file', name: 'result.txt' }]
    })
    expect(savedSessions.at(-1)?.messages.at(-1)).toMatchObject({
      id: 'artifact-agent',
      role: 'agent',
      content: '',
      turnUsageUnavailable: true,
      artifactIds: ['artifact-file']
    })
    expect(savedSessions.at(-1)?.artifacts).toEqual([
      expect.objectContaining({ id: 'artifact-file', createdAt: 10 })
    ])
  })

  it('freezes completion projections before asynchronous artifact finalization', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let signalFinalizeStarted: (() => void) | undefined
    let finishFinalize: (() => void) | undefined
    const finalizeStarted = new Promise<void>((resolve) => {
      signalFinalizeStarted = resolve
    })
    const finalizeGate = new Promise<void>((resolve) => {
      finishFinalize = resolve
    })
    const savedSessions: PersistedChatSession[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-artifact-gate' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'assistant-before-finalize',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-artifact-gate',
            role: 'assistant',
            text: 'Before finalize.'
          })
          emitEvent?.({
            id: 'tool-before-finalize',
            timestamp: 11,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-artifact-gate',
            toolCallId: 'tool-finalize',
            status: 'in_progress'
          })
          emitEvent?.({
            id: 'artifact-before-finalize',
            timestamp: 12,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-artifact-gate',
            runId: 'generated-id',
            artifactClaimId: 'claim-finalize',
            artifacts: []
          })
        }
      },
      artifacts: {
        finalizeRun: async () => {
          signalFinalizeStarted?.()
          await finalizeGate
          return { ok: true, artifacts: [] }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create a report.' })
    await finalizeStarted
    emitEvent?.({
      id: 'assistant-during-finalize',
      timestamp: 13,
      kind: 'message',
      level: 'info',
      sessionId: 'session-artifact-gate',
      role: 'assistant',
      text: 'During finalize.'
    })
    emitEvent?.({
      id: 'tool-during-finalize',
      timestamp: 14,
      kind: 'tool',
      level: 'info',
      sessionId: 'session-artifact-gate',
      toolCallId: 'tool-finalize',
      status: 'completed'
    })
    finishFinalize?.()
    await runner.waitForRun(started.id)

    expect(savedSessions.at(-1)?.messages.at(-1)).toMatchObject({
      content: 'Before finalize.',
      eventIds: ['assistant-before-finalize']
    })
    expect(savedSessions.at(-1)?.activities).toEqual([
      expect.objectContaining({
        id: 'tool-finalize',
        status: 'in_progress',
        eventIds: ['tool-before-finalize']
      })
    ])
  })

  it('completes against current Session authority after a concurrent writer advances revision', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let authoritative: PersistedChatSession = { ...session, revision: 0 }
    const revisionConflicts: string[] = []
    const save = async (candidate: PersistedChatSession): Promise<PersistedChatSession> => {
      const expectedRevision = candidate.revision ?? 0
      const actualRevision = authoritative.revision ?? 0
      if (expectedRevision !== actualRevision) {
        const message = `Session revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`
        revisionConflicts.push(message)
        throw new Error(message)
      }
      authoritative = structuredClone({ ...candidate, revision: actualRevision + 1 })
      return structuredClone(authoritative)
    }
    const mutateAuthority = (
      mutation: (latest: PersistedChatSession) => PersistedChatSession
    ): Promise<PersistedChatSession> => save(mutation(structuredClone(authoritative)))
    const completionSessions = {
      stageCompletion: (request: {
        message?: PersistedChatSession['messages'][number]
        activities: readonly NonNullable<PersistedChatSession['activities']>[number][]
        updatedAt: number
      }) =>
        mutateAuthority((latest) => ({
          ...latest,
          messages: request.message ? [...latest.messages, request.message] : latest.messages,
          activities: [...(latest.activities ?? []), ...request.activities],
          updatedAt: request.updatedAt
        })),
      settleCompletion: (request: { taskRunCommitId: string; updatedAt: number }) =>
        mutateAuthority((latest) => ({
          ...latest,
          status: 'idle',
          activeRun: undefined,
          taskRunCommitId: request.taskRunCommitId,
          updatedAt: request.updatedAt
        })),
      failRun: (request: { taskRunCommitId: string; error: string; updatedAt: number }) =>
        mutateAuthority((latest) => ({
          ...latest,
          status: 'error',
          activeRun: undefined,
          taskRunCommitId: request.taskRunCommitId,
          error: request.error,
          updatedAt: request.updatedAt
        }))
    }
    const ids = ['task-user', 'task-run', 'task-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [structuredClone(authoritative)],
        save,
        ...completionSessions
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [session.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
          await save({
            ...authoritative,
            messages: [
              ...authoritative.messages,
              {
                id: 'concurrent-message',
                role: 'agent',
                content: 'Concurrent renderer state',
                status: 'complete',
                eventIds: ['concurrent-event'],
                createdAt: 20,
                updatedAt: 20
              }
            ],
            updatedAt: 20
          })
          emitEvent?.({
            id: 'task-output-event',
            timestamp: 21,
            kind: 'message',
            level: 'info',
            sessionId: session.id,
            role: 'assistant',
            text: 'Task answer'
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 30
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: session.id,
      prompt: 'Finish the task.'
    })
    const completed = await runner.waitForRun(started.id)

    expect(revisionConflicts).toEqual([])
    expect(completed.status).toBe('completed')
    expect(authoritative.taskRunCommitId).toBe(started.id)
    expect(authoritative.messages.map(({ id }) => id)).toEqual([
      'task-user',
      'concurrent-message',
      'task-agent'
    ])
  })

  it('settles a run as failed when final session persistence fails', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let saveCount = 0
    const ids = ['save-user', 'save-run', 'save-agent']
    const progressPhases: string[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => {
          saveCount += 1
        },
        settleCompletion: async () => {
          throw new Error('Session storage is unavailable')
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-save', cwd: '/workspace/save' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'save-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-save',
            role: 'assistant',
            text: 'Unsaved answer'
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })
    runner.subscribeProgress((event) => progressPhases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Produce an answer.' })

    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Session storage is unavailable',
      output: 'Unsaved answer',
      completedAt: 100
    })
    expect(saveCount).toBe(3)
    expect(progressPhases.at(-1)).toBe('failed')
  })

  it('preserves finalized artifacts when a later claim fails after ownership staging', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finalizeAttempts = 0
    const savedSessions: PersistedChatSession[] = []
    const ids = ['partial-user', 'partial-run', 'partial-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-partial', cwd: '/workspace/partial' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'artifact-first',
            timestamp: 10,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-partial',
            runId: 'partial-run',
            artifactClaimId: 'claim-1',
            artifacts: []
          })
          emitEvent?.({
            id: 'artifact-second',
            timestamp: 11,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-partial',
            runId: 'partial-run',
            artifactClaimId: 'claim-2',
            artifacts: []
          })
          emitEvent?.({
            id: 'provider-error',
            timestamp: 12,
            kind: 'error',
            level: 'error',
            sessionId: 'session-partial',
            text: 'Provider rejected the request.'
          })
          throw new Error('raw provider failure')
        }
      },
      artifacts: {
        finalizeRun: async (request) => {
          finalizeAttempts += 1
          if (request.claimId === 'claim-2') {
            throw new Error('compatibility publication failed')
          }
          return {
            ok: true,
            artifacts: [
              {
                id: 'artifact-partial',
                projectId: project.id,
                sessionId: 'session-partial',
                messageId: 'partial-agent',
                name: 'partial-report.md',
                path: '/artifacts/partial-report.md',
                fileUrl: 'open-science-preview://artifact-partial/partial-report.md',
                mimeType: 'text/markdown',
                size: 10,
                mtimeMs: 12
              }
            ]
          }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create a report.' })
    const failed = await runner.waitForRun(started.id)

    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-partial', name: 'partial-report.md' }]
    })
    expect(finalizeAttempts).toBe(2)
    expect(savedSessions.at(-1)).toMatchObject({
      status: 'error',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-partial', name: 'partial-report.md' }]
    })
  })

  it('persists terminal tool activity and provider failure reportability', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const ids = ['tool-user', 'tool-run', 'tool-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-tool', cwd: '/workspace/tool' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'failed-plan',
            timestamp: 9,
            kind: 'plan',
            level: 'info',
            sessionId: 'session-tool',
            text: 'Plan awaiting approval.',
            planProjection: {
              artifactId: 'failed-plan-artifact',
              artifactVersionId: 'failed-plan-version',
              artifactChecksum: 'failed-plan-checksum',
              revision: 1,
              approval: 'pending',
              lifecycle: 'awaiting_approval'
            } as never
          })
          emitEvent?.({
            id: 'tool-start',
            timestamp: 10,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            title: 'Run analysis',
            status: 'in_progress',
            providerToolName: 'shell'
          })
          emitEvent?.({
            id: 'tool-complete',
            timestamp: 11,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            status: 'completed',
            terminalOutput: 'done\n',
            terminalExitCode: 0
          })
          emitEvent?.({
            id: 'tool-metadata',
            timestamp: 12,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            rawOutput: { stdout: 'done' }
          })
          emitEvent?.({
            id: 'provider-error',
            timestamp: 13,
            kind: 'error',
            level: 'error',
            sessionId: 'session-tool',
            text: 'Provider quota exceeded.',
            providerError: true
          })
          throw new Error('opaque provider error')
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Run analysis.' })
    const failed = await runner.waitForRun(started.id)
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Provider quota exceeded.'
    })
    expect(failed.attention).toBeUndefined()
    expect(savedSessions.at(-1)).toMatchObject({
      status: 'error',
      error: 'Provider quota exceeded.',
      errorReportable: false,
      activities: [
        {
          id: 'tool-call-1',
          title: 'Run analysis',
          status: 'completed',
          eventIds: ['tool-start', 'tool-complete', 'tool-metadata'],
          rawOutput: { stdout: 'done' },
          terminalOutput: 'done\n',
          terminalExitCode: 0,
          createdAt: 10,
          updatedAt: 11
        }
      ]
    })
  })

  it('cancels one active run, retains partial output, and returns the Session to idle', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let rejectPrompt: ((error: Error) => void) | undefined
    const promptGate = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject
    })
    const savedSessions: PersistedChatSession[] = []
    const cancelPrompt = vi.fn(async (sessionId: string) => {
      emitEvent?.({
        id: 'partial-output',
        timestamp: 20,
        kind: 'message',
        level: 'info',
        sessionId,
        role: 'assistant',
        text: 'Partial result.'
      })
      rejectPrompt?.(new Error('provider prompt cancelled'))
    })
    let time = 100
    const progressPhases: string[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'cancel-plan',
            timestamp: 10,
            kind: 'plan',
            level: 'info',
            sessionId: 'session-cancel',
            text: 'Plan awaiting approval.',
            planProjection: {
              artifactId: 'cancel-plan-artifact',
              artifactVersionId: 'cancel-plan-version',
              artifactChecksum: 'cancel-plan-checksum',
              revision: 1,
              approval: 'pending',
              lifecycle: 'awaiting_approval'
            } as never
          })
          return promptGate
        },
        cancelPrompt
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['cancel-user', 'cancel-run', 'cancel-agent']
        return () => ids.shift() ?? 'generated-id'
      })(),
      now: () => ++time
    })
    runner.subscribeProgress((event) => progressPhases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Long research.' })
    expect(started.attention).toMatchObject({
      kind: 'plan-approval',
      plan: { artifactVersionId: 'cancel-plan-version' }
    })
    const cancelled = await runner.cancelRun(started.id)

    expect(cancelPrompt).toHaveBeenCalledOnce()
    expect(cancelPrompt).toHaveBeenCalledWith('session-cancel')
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      output: 'Partial result.',
      cancelRequestedAt: expect.any(Number),
      cancelledAt: expect.any(Number),
      completedAt: expect.any(Number)
    })
    expect(cancelled.cancelledAt).toBe(cancelled.completedAt)
    expect(cancelled.attention).toBeUndefined()
    expect(progressPhases.at(-1)).toBe('cancelled')
    expect(savedSessions.at(-1)).toMatchObject({
      id: 'session-cancel',
      status: 'idle',
      activeRun: undefined,
      messages: [
        expect.objectContaining({ role: 'user', content: 'Long research.' }),
        expect.objectContaining({ role: 'agent', content: 'Partial result.' })
      ]
    })
  })

  it('deduplicates concurrent cancellation and treats terminal cancellation as a read', async () => {
    let finishPrompt: (() => void) | undefined
    let acceptCancellation: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const cancellationGate = new Promise<void>((resolve) => {
      acceptCancellation = resolve
    })
    const cancelPrompt = vi.fn(async () => {
      await cancellationGate
      finishPrompt?.()
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-concurrent-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => promptGate,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['concurrent-user', 'concurrent-run', 'concurrent-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Cancel once.' })
    const first = runner.cancelRun(started.id)
    const second = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    acceptCancellation?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      expect.objectContaining({ status: 'cancelled' })
    ])
    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelPrompt).toHaveBeenCalledOnce()
  })

  it('leaves a naturally terminal run unchanged when cancellation arrives late', async () => {
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-completed' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => undefined,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['completed-user', 'completed-run', 'completed-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Finish naturally.' })
    await runner.waitForRun(started.id)

    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({
      status: 'completed',
      cancelRequestedAt: undefined,
      cancelledAt: undefined
    })
    expect(cancelPrompt).not.toHaveBeenCalled()
  })

  it('recovers cancellation accepted while the final Session save is draining', async () => {
    let finalSaveStarted: (() => void) | undefined
    let releaseFinalSave: (() => void) | undefined
    let terminalWriteStarted: (() => void) | undefined
    let releaseTerminalWrite: (() => void) | undefined
    const finalSaveStart = new Promise<void>((resolve) => {
      finalSaveStarted = resolve
    })
    const finalSaveGate = new Promise<void>((resolve) => {
      releaseFinalSave = resolve
    })
    const terminalWriteStart = new Promise<void>((resolve) => {
      terminalWriteStarted = resolve
    })
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve
    })
    let saveCount = 0
    let durableSession: PersistedChatSession | undefined
    let durableRuns: TaskRunJournalEntry[] = []
    let terminalWriteBlocked = false
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: {
        list: async () => (durableSession ? [normalizeSessionFile(durableSession)!] : []),
        save: async (session) => {
          saveCount += 1
          if (saveCount === 2) {
            finalSaveStarted?.()
            await finalSaveGate
          }
          durableSession = { ...session, revision: (session.revision ?? 0) + 1 }
          return durableSession
        }
      },
      runJournal: {
        load: async () => structuredClone(durableRuns),
        replace: async (runs) => {
          if (
            !terminalWriteBlocked &&
            runs.some((run) => run.id === 'save-run' && run.status === 'cancelled')
          ) {
            terminalWriteBlocked = true
            terminalWriteStarted?.()
            await terminalWriteGate
          }
          durableRuns = runs.map((run) => structuredClone(run))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-during-save' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => undefined,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['save-user', 'save-run', 'save-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Finish and persist.' })
    await finalSaveStart
    const cancellation = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    releaseFinalSave?.()

    await terminalWriteStart
    expect(durableRuns).toContainEqual(
      expect.objectContaining({
        id: started.id,
        status: 'running',
        sessionCommitStatus: 'cancelled'
      })
    )
    const recoveredRunner = createRunner({
      sessions: {
        list: async () => (durableSession ? [normalizeSessionFile(durableSession)!] : [])
      },
      runJournal: {
        load: async () => structuredClone(durableRuns),
        replace: async () => undefined
      }
    })
    await recoveredRunner.initialize()
    expect(recoveredRunner.getRun(started.id)).toMatchObject({ status: 'cancelled' })

    releaseTerminalWrite?.()
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelPrompt).toHaveBeenCalledOnce()
    await recoveredRunner.dispose()
  })

  it('waits for a queued Session commit marker before dispatching cancellation', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markQueuedWriteStarted: (() => void) | undefined
    let releaseQueuedWrite: (() => void) | undefined
    const queuedWriteStarted = new Promise<void>((resolve) => {
      markQueuedWriteStarted = resolve
    })
    const queuedWriteGate = new Promise<void>((resolve) => {
      releaseQueuedWrite = resolve
    })
    let journalWriteCount = 0
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      runJournal: {
        load: async () => [],
        replace: async () => {
          journalWriteCount += 1
          if (journalWriteCount === 3) {
            markQueuedWriteStarted?.()
            await queuedWriteGate
          }
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-queued-marker-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt,
        prompt: async () => {
          emitEvent?.({
            id: 'queued-plan-event',
            timestamp: 10,
            kind: 'plan',
            level: 'info',
            sessionId: 'session-queued-marker-cancel',
            text: 'Queue another journal write.',
            planProjection: {
              artifactId: 'queued-plan',
              artifactVersionId: 'queued-plan-version',
              artifactChecksum: 'queued-plan-checksum',
              revision: 1,
              approval: 'pending',
              lifecycle: 'awaiting_approval'
            } as never
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['queued-user', 'queued-run', 'queued-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Queue completion.' })
    await queuedWriteStarted
    const cancellation = runner.cancelRun(started.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelPrompt).not.toHaveBeenCalled()

    releaseQueuedWrite?.()

    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelPrompt).toHaveBeenCalledOnce()
  })

  it('keeps a real Prompt failure when cancellation is requested afterward', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finalizationStarted: (() => void) | undefined
    let releaseFinalization: (() => void) | undefined
    const finalizationStart = new Promise<void>((resolve) => {
      finalizationStarted = resolve
    })
    const finalizationGate = new Promise<void>((resolve) => {
      releaseFinalization = resolve
    })
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-failure-before-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'failure-artifact',
            timestamp: 20,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-failure-before-cancel',
            runId: 'failure-run',
            artifactClaimId: 'claim-failure-before-cancel',
            artifacts: []
          })
          throw new Error('provider failed before cancellation')
        },
        cancelPrompt
      },
      artifacts: {
        finalizeRun: async () => {
          finalizationStarted?.()
          await finalizationGate
          return { ok: true, artifacts: [] }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['failure-user', 'failure-run', 'failure-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Fail first.' })
    await finalizationStart
    const cancellation = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    releaseFinalization?.()

    await expect(cancellation).resolves.toMatchObject({
      status: 'failed',
      error: 'provider failed before cancellation'
    })
  })

  it('clears a rejected cancellation request while the run remains active', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const cancelPrompt = vi.fn(async () => {
      throw new Error('cancel dispatch failed')
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-failure' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => promptGate,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['failure-user', 'failure-run', 'failure-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Keep working.' })
    await expect(runner.cancelRun(started.id)).rejects.toThrow('cancel dispatch failed')
    expect(runner.getRun(started.id)).toMatchObject({
      status: 'running',
      cancelRequestedAt: undefined
    })

    finishPrompt?.()
    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({ status: 'completed' })
  })

  it('lets Artifact finalization failure win after cancellation is accepted', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-artifact' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'cancel-artifact',
            timestamp: 20,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-cancel-artifact',
            runId: 'artifact-run',
            artifactClaimId: 'claim-cancel-artifact',
            artifacts: []
          })
          return promptGate
        },
        cancelPrompt: async () => finishPrompt?.()
      },
      artifacts: {
        finalizeRun: async () => {
          throw new Error('artifact finalization failed')
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['artifact-user', 'artifact-run', 'artifact-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create then cancel.' })

    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'artifact finalization failed'
    })
  })

  it('releases its runtime-event subscription when disposed', async () => {
    let unsubscribeCount = 0
    const runner = createRunner({
      runtimeEvents: {
        subscribe: () => () => {
          unsubscribeCount += 1
        }
      }
    })

    await runner.dispose()

    expect(unsubscribeCount).toBe(1)
  })

  it('retains at most 200 terminal runs while preserving current snapshots', async () => {
    let idCounter = 0
    let sessionCounter = 0
    let time = 0
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: `session-${++sessionCounter}` }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      },
      createId: () => `id-${++idCounter}`,
      now: () => ++time
    })
    let firstRunId = ''
    let latestRunId = ''

    for (let index = 0; index < 201; index += 1) {
      const started = await runner.startRun({
        project: project.id,
        prompt: `Research request ${index}`
      })
      if (index === 0) firstRunId = started.id
      latestRunId = started.id
      await runner.waitForRun(started.id)
    }

    expect(() => runner.getRun(firstRunId)).toThrow(
      expect.objectContaining({ code: 'run_not_found' })
    )
    expect(runner.getRun(latestRunId)).toMatchObject({ status: 'completed' })
  })

  it('persists a new Run identity before its running Session', async () => {
    let markInitialSessionSaveStarted: (() => void) | undefined
    let releaseInitialSessionSave: (() => void) | undefined
    const initialSessionSaveStarted = new Promise<void>((resolve) => {
      markInitialSessionSaveStarted = resolve
    })
    const initialSessionSaveGate = new Promise<void>((resolve) => {
      releaseInitialSessionSave = resolve
    })
    let blockInitialSessionSave = true
    let durableRuns: TaskRunJournalEntry[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (value) => {
          if (blockInitialSessionSave && value.status === 'running') {
            blockInitialSessionSave = false
            markInitialSessionSaveStarted?.()
            await initialSessionSaveGate
          }
          return value
        }
      },
      runJournal: {
        load: async () => [],
        replace: async (runs) => {
          durableRuns = runs.map((run) => structuredClone(run))
        }
      },
      createId: (() => {
        const ids = ['ordered-prompt', 'ordered-run']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const starting = runner.startRun({ project: project.id, prompt: 'Persist in order.' })
    await initialSessionSaveStarted
    const runWasDurableBeforeSession = durableRuns.some(
      (run) => run.id === 'ordered-run' && run.status === 'running'
    )
    releaseInitialSessionSave?.()
    const started = await starting
    await runner.waitForRun(started.id)

    expect(runWasDurableBeforeSession).toBe(true)
  })

  it('keeps the Run identity when the initial Session save reports a post-commit failure', async () => {
    let durableSession: PersistedChatSession | undefined
    let rejectCommittedSave = true
    let durableRuns: TaskRunJournalEntry[] = []
    const sessions: NonNullable<TaskRunnerOverrides['sessions']> = {
      list: async () =>
        durableSession ? [normalizeSessionFile(structuredClone(durableSession))!] : [],
      save: async (value) => {
        durableSession = structuredClone(value)
        if (rejectCommittedSave && value.status === 'running') {
          rejectCommittedSave = false
          throw new Error('Session projection failed after commit.')
        }
        return value
      },
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRunJournalEntry[]) => {
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const runner = createRunner({
      sessions,
      runJournal,
      createId: (() => {
        const ids = ['post-commit-prompt', 'post-commit-run']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    await expect(
      runner.startRun({ project: project.id, prompt: 'Keep the durable identity.' })
    ).rejects.toThrow('Session projection failed after commit.')

    expect(durableRuns).toContainEqual(
      expect.objectContaining({
        id: 'post-commit-run',
        status: 'failed',
        error: 'Session projection failed after commit.'
      })
    )
    expect(durableSession).toMatchObject({
      status: 'error',
      taskRunCommitId: 'post-commit-run',
      error: 'Session projection failed after commit.'
    })

    const recoveredRunner = createRunner({ sessions, runJournal })
    await recoveredRunner.initialize()
    expect(recoveredRunner.getRun('post-commit-run')).toMatchObject({
      status: 'failed',
      error: 'Session projection failed after commit.'
    })
  })

  it('recovers a post-commit Session failure before its compensation save completes', async () => {
    let markCompensationStarted: (() => void) | undefined
    let releaseCompensation: (() => void) | undefined
    const compensationStarted = new Promise<void>((resolve) => {
      markCompensationStarted = resolve
    })
    const compensationGate = new Promise<void>((resolve) => {
      releaseCompensation = resolve
    })
    let durableSession: PersistedChatSession | undefined
    let rejectCommittedSave = true
    let blockCompensation = true
    let durableRuns: TaskRunJournalEntry[] = []
    const sessions: NonNullable<TaskRunnerOverrides['sessions']> = {
      list: async () =>
        durableSession ? [normalizeSessionFile(structuredClone(durableSession))!] : [],
      save: async (value) => {
        if (rejectCommittedSave && value.status === 'running') {
          durableSession = structuredClone(value)
          rejectCommittedSave = false
          throw new Error('Session projection failed after commit.')
        }
        if (blockCompensation && value.taskRunCommitId === 'crash-window-run') {
          blockCompensation = false
          markCompensationStarted?.()
          await compensationGate
        }
        durableSession = structuredClone(value)
        return value
      },
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRunJournalEntry[]) => {
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const runner = createRunner({
      sessions,
      runJournal,
      createId: (() => {
        const ids = ['crash-window-prompt', 'crash-window-run']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const starting = runner.startRun({
      project: project.id,
      prompt: 'Recover the compensation window.'
    })
    await compensationStarted

    expect(durableRuns).toContainEqual(
      expect.objectContaining({
        id: 'crash-window-run',
        status: 'running',
        sessionCommitStatus: 'failed',
        error: 'Session projection failed after commit.'
      })
    )

    const recoveredRunner = createRunner({ sessions, runJournal })
    await recoveredRunner.initialize()
    expect(recoveredRunner.getRun('crash-window-run')).toMatchObject({
      status: 'failed',
      failureCode: 'process_restarted',
      error: 'Run interrupted because Open Science restarted.'
    })
    expect(durableSession).toMatchObject({
      status: 'error',
      taskRunCommitId: 'crash-window-run'
    })

    releaseCompensation?.()
    await expect(starting).rejects.toThrow('Session projection failed after commit.')
  })

  it('terminates in memory and repairs the Session after its compensation save fails', async () => {
    let durableSession: PersistedChatSession | undefined
    let rejectCommittedSave = true
    let rejectCompensationSave = true
    let durableRuns: TaskRunJournalEntry[] = []
    const sessions: NonNullable<TaskRunnerOverrides['sessions']> = {
      list: async () =>
        durableSession ? [normalizeSessionFile(structuredClone(durableSession))!] : [],
      save: async (value) => {
        if (rejectCommittedSave && value.status === 'running') {
          durableSession = structuredClone(value)
          rejectCommittedSave = false
          throw new Error('Session projection failed after commit.')
        }
        if (rejectCompensationSave && value.taskRunCommitId === 'compensation-failure-run') {
          rejectCompensationSave = false
          throw new Error('Session compensation save failed.')
        }
        durableSession = structuredClone(value)
        return value
      },
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRunJournalEntry[]) => {
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const runner = createRunner({
      sessions,
      runJournal,
      createId: (() => {
        const ids = ['compensation-failure-prompt', 'compensation-failure-run']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    await expect(
      runner.startRun({ project: project.id, prompt: 'Fail the compensation save.' })
    ).rejects.toThrow('Session projection failed after commit.')

    expect(runner.getRun('compensation-failure-run')).toMatchObject({
      status: 'failed',
      error: 'Session projection failed after commit.'
    })
    expect(durableRuns).toContainEqual(
      expect.objectContaining({
        id: 'compensation-failure-run',
        status: 'failed',
        sessionCommitStatus: 'failed'
      })
    )

    const recoveredRunner = createRunner({ sessions, runJournal })
    await recoveredRunner.initialize()
    expect(recoveredRunner.getRun('compensation-failure-run')).toMatchObject({
      status: 'failed',
      error: 'Session projection failed after commit.'
    })
    expect(durableSession).toMatchObject({
      status: 'error',
      taskRunCommitId: 'compensation-failure-run'
    })
  })

  it('persists a witness for the recovered Session when an interrupted Run is restored', async () => {
    let durableSession = normalizeSessionFile({
      ...session,
      status: 'running',
      activeRun: { promptMessageId: 'interrupted-prompt', startedAt: 2 },
      messages: [
        {
          id: 'interrupted-prompt',
          role: 'user',
          content: 'Resume after restart.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })!
    let durableRuns: TaskRunJournalEntry[] = [
      {
        id: 'interrupted-run',
        sessionId: session.id,
        projectId: project.id,
        cwd: session.cwd,
        status: 'running',
        startedAt: 2,
        artifacts: [],
        preferredComputeHostIds: [],
        promptMessageId: 'interrupted-prompt'
      }
    ]
    let failureWasStagedBeforeSessionSave = false
    const runner = createRunner({
      sessions: {
        list: async () => [structuredClone(durableSession)],
        save: async (value) => {
          failureWasStagedBeforeSessionSave = durableRuns.some(
            (run) =>
              run.id === 'interrupted-run' &&
              run.status === 'running' &&
              run.sessionCommitStatus === 'failed'
          )
          durableSession = normalizeSessionFile(value)!
          return durableSession
        }
      },
      runJournal: {
        load: async () => structuredClone(durableRuns),
        replace: async (runs) => {
          durableRuns = runs.map((run) => structuredClone(run))
        }
      }
    })

    await runner.initialize()

    expect(runner.getRun('interrupted-run')).toMatchObject({
      status: 'failed',
      failureCode: 'process_restarted'
    })
    expect(durableSession).toMatchObject({
      status: 'error',
      taskRunCommitId: 'interrupted-run',
      error: 'Session was interrupted before the app closed.'
    })
    expect(durableSession.activeRun).toBeUndefined()
    expect(failureWasStagedBeforeSessionSave).toBe(true)
  })

  it('does not overwrite newer Session activity while reconciling an interrupted Run', async () => {
    const interruptedSession = normalizeSessionFile({
      ...session,
      status: 'running',
      activeRun: { promptMessageId: 'old-prompt', startedAt: 2 },
      messages: [
        {
          id: 'old-prompt',
          role: 'user',
          content: 'Old work.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })!
    const newerSession: PersistedChatSession = {
      ...session,
      status: 'running',
      activeRun: { promptMessageId: 'new-prompt', startedAt: 4 },
      messages: [
        ...interruptedSession.messages,
        {
          id: 'new-prompt',
          role: 'user',
          content: 'New work.',
          status: 'complete',
          eventIds: [],
          createdAt: 4,
          updatedAt: 4
        }
      ],
      updatedAt: 4
    }
    let reads = 0
    const journalSnapshots: TaskRunJournalEntry[][] = []
    let durableRuns: TaskRunJournalEntry[] = [
      {
        id: 'old-run',
        sessionId: session.id,
        projectId: project.id,
        cwd: session.cwd,
        status: 'running',
        startedAt: 2,
        artifacts: [],
        preferredComputeHostIds: [],
        promptMessageId: 'old-prompt'
      }
    ]
    const save = vi.fn(async (value: PersistedChatSession) => value)
    const runner = createRunner({
      sessions: {
        list: async () => structuredClone(reads++ === 0 ? [interruptedSession] : [newerSession]),
        save
      },
      runJournal: {
        load: async () => structuredClone(durableRuns),
        replace: async (runs) => {
          durableRuns = runs.map((run) => structuredClone(run))
          journalSnapshots.push(structuredClone(durableRuns))
        }
      }
    })

    await runner.initialize()

    expect(save).not.toHaveBeenCalled()
    expect(runner.getRun('old-run')).toMatchObject({
      status: 'failed',
      failureCode: 'process_restarted'
    })
    expect(journalSnapshots[0]).toContainEqual(
      expect.objectContaining({
        id: 'old-run',
        status: 'running',
        sessionCommitStatus: 'failed'
      })
    )
    expect(durableRuns[0]?.sessionCommitStatus).toBeUndefined()
  })

  it('does not report completion when the terminal Run record cannot be persisted', async () => {
    let writes = 0
    let durableSession: PersistedChatSession | undefined
    const runner = createRunner({
      sessions: {
        list: async () => (durableSession ? [structuredClone(durableSession)] : []),
        save: async (value) => {
          durableSession = structuredClone(value)
          return value
        }
      },
      runJournal: {
        load: async () => [],
        replace: async () => {
          writes += 1
          if (writes > 2) throw new Error('disk full')
        }
      }
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Persist this Run.' })

    await expect(runner.waitForRun(started.id)).rejects.toThrow('disk full')
    expect(runner.getRun(started.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Task Run terminal state could not be persisted.')
    })
    await expect(runner.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: started.sessionId, status: 'error' })
    ])
    expect(durableSession?.activeRun).toBeUndefined()
  })

  it('recovers a terminal persistence fallback without stale Session commit metadata', async () => {
    let writes = 0
    let durableRuns: TaskRunJournalEntry[] = []
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRunJournalEntry[]) => {
        writes += 1
        if (writes === 4) throw new Error('terminal write failed once')
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const runner = createRunner({ runJournal })

    const started = await runner.startRun({ project: project.id, prompt: 'Fallback durably.' })
    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Task Run terminal state could not be persisted.')
    })

    const recoveredRunner = createRunner({ runJournal })
    await recoveredRunner.initialize()

    expect(recoveredRunner.getRun(started.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Task Run terminal state could not be persisted.')
    })
    expect(durableRuns.find((run) => run.id === started.id)?.sessionCommitStatus).toBeUndefined()
  })

  it('recovers a completed Run when the Session commit precedes automatic review', async () => {
    let durableSession: PersistedChatSession | undefined
    let durableRuns: TaskRun[] = []
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markReviewStarted: (() => void) | undefined
    let releaseReview: (() => void) | undefined
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve
    })
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    const sessions: NonNullable<TaskRunnerOverrides['sessions']> = {
      list: async () => (durableSession ? [normalizeSessionFile(durableSession)!] : []),
      save: async (value) => {
        const persisted = { ...value, revision: (value.revision ?? 0) + 1 }
        durableSession = structuredClone(persisted)
        return persisted
      },
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRun[]) => {
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const ids = ['recovery-user', 'recovery-run', 'recovery-agent']
    const runner = createRunner({
      sessions,
      runJournal,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-review-recovery' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'recovery-message-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-review-recovery',
            role: 'assistant',
            text: 'Durable response.'
          })
        }
      },
      reviewer: {
        review: async () => {
          markReviewStarted?.()
          await reviewGate
          return { started: true }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      prompt: 'Commit before review.',
      autoReviewEnabled: true
    })
    await reviewStarted

    expect(durableSession).toMatchObject({ status: 'idle', activeRun: undefined })
    expect(durableSession?.taskRunCommitId).toBe(started.id)
    expect(durableRuns).toContainEqual(expect.objectContaining({ status: 'running' }))
    expect(runner.getRun(started.id)).toMatchObject({ status: 'running', output: undefined })

    const recoveredRunner = createRunner({ sessions, runJournal })
    await recoveredRunner.initialize()

    expect(recoveredRunner.getRun(started.id)).toMatchObject({
      status: 'completed',
      output: 'Durable response.'
    })

    releaseReview?.()
    await runner.waitForRun(started.id)
    await recoveredRunner.dispose()
  })

  it('recovers the original failure when the failed Session commit precedes terminalization', async () => {
    let durableSession: PersistedChatSession | undefined
    let durableRuns: TaskRunJournalEntry[] = []
    let markTerminalWriteStarted: (() => void) | undefined
    let releaseTerminalWrite: (() => void) | undefined
    const terminalWriteStarted = new Promise<void>((resolve) => {
      markTerminalWriteStarted = resolve
    })
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve
    })
    let terminalWriteBlocked = false
    const sessions: NonNullable<TaskRunnerOverrides['sessions']> = {
      list: async () => (durableSession ? [normalizeSessionFile(durableSession)!] : []),
      save: async (value) => {
        const persisted = { ...value, revision: (value.revision ?? 0) + 1 }
        durableSession = structuredClone(persisted)
        return persisted
      },
      updateConfiguration: async (value) => value,
      setDelegationPolicy: async () => undefined
    }
    const runJournal = {
      load: async () => structuredClone(durableRuns),
      replace: async (runs: readonly TaskRunJournalEntry[]) => {
        if (
          !terminalWriteBlocked &&
          runs.some((run) => run.id === 'failure-run' && run.status === 'failed')
        ) {
          terminalWriteBlocked = true
          markTerminalWriteStarted?.()
          await terminalWriteGate
        }
        durableRuns = runs.map((run) => structuredClone(run))
      }
    }
    const ids = ['failure-user', 'failure-run', 'failure-agent']
    const runner = createRunner({
      sessions,
      runJournal,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-failure-recovery' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          throw new Error('provider failed')
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Fail durably.' })
    await terminalWriteStarted

    expect(durableSession).toMatchObject({ status: 'error', error: 'provider failed' })
    expect(durableSession?.taskRunCommitId).toBe(started.id)
    expect(durableRuns).toContainEqual(
      expect.objectContaining({
        id: started.id,
        status: 'running',
        sessionCommitStatus: 'failed',
        error: 'provider failed'
      })
    )

    const recoveredRunner = createRunner({ sessions, runJournal })
    await recoveredRunner.initialize()

    expect(recoveredRunner.getRun(started.id)).toMatchObject({
      status: 'failed',
      error: 'provider failed',
      failureCode: undefined
    })

    releaseTerminalWrite?.()
    await runner.waitForRun(started.id)
    await recoveredRunner.dispose()
  })

  it('does not recover a staged completion after an unrelated startup Session save', async () => {
    const normalizedSession = normalizeSessionFile({
      ...session,
      status: 'running',
      activeRun: { promptMessageId: 'staged-prompt', startedAt: 2 },
      messages: [
        {
          id: 'staged-prompt',
          role: 'user',
          content: 'Finish this work.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })!
    const startupSession = { ...normalizedSession, status: 'idle' as const, revision: 1 }
    const runner = createRunner({
      sessions: {
        list: async () => [startupSession]
      },
      runJournal: {
        load: async () => [
          {
            id: 'staged-run',
            sessionId: session.id,
            projectId: project.id,
            cwd: session.cwd,
            status: 'running',
            startedAt: 2,
            completedAt: 3,
            output: 'Not committed yet.',
            artifacts: [],
            preferredComputeHostIds: [],
            promptMessageId: 'staged-prompt',
            sessionCommitStatus: 'completed'
          }
        ],
        replace: async () => undefined
      }
    })

    await runner.initialize()

    expect(runner.getRun('staged-run')).toMatchObject({
      status: 'failed',
      failureCode: 'process_restarted'
    })
  })

  it('clears stale attention when recovering a committed cancellation', async () => {
    const runner = createRunner({
      sessions: {
        list: async () => [
          normalizeSessionFile({
            ...session,
            status: 'idle',
            activeRun: undefined,
            taskRunCommitId: 'cancelled-run'
          })!
        ]
      },
      runJournal: {
        load: async () => [
          {
            id: 'cancelled-run',
            sessionId: session.id,
            projectId: project.id,
            cwd: session.cwd,
            status: 'running',
            startedAt: 2,
            completedAt: 3,
            cancelledAt: 3,
            artifacts: [],
            preferredComputeHostIds: [],
            promptMessageId: 'cancelled-prompt',
            sessionCommitStatus: 'cancelled',
            attention: { kind: 'plan-approval', plan: {} as never }
          }
        ],
        replace: async () => undefined
      }
    })

    await runner.initialize()

    expect(runner.getRun('cancelled-run')).toMatchObject({
      status: 'cancelled',
      attention: undefined
    })
  })

  it('rolls back a staged cancellation when its journal write fails', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markReviewStarted: (() => void) | undefined
    let releaseReview: (() => void) | undefined
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve
    })
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    let journalWriteCount = 0
    let durableRuns: TaskRunJournalEntry[] = []
    let sessionCount = 0
    const ids = ['cancel-user', 'cancel-run', 'cancel-agent', 'next-user', 'next-run', 'next-agent']
    const runner = createRunner({
      runJournal: {
        load: async () => [],
        replace: async (runs) => {
          journalWriteCount += 1
          if (journalWriteCount === 4) throw new Error('cancel journal failed')
          durableRuns = runs.map((run) => structuredClone(run))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: `session-${++sessionCount}` }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          emitEvent?.({
            id: `${request.sessionId}-message`,
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: request.sessionId,
            role: 'assistant',
            text: 'Durable response.'
          })
        }
      },
      reviewer: {
        review: async () => {
          markReviewStarted?.()
          await reviewGate
          return { started: true }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const first = await runner.startRun({
      project: project.id,
      prompt: 'Review before cancellation.',
      autoReviewEnabled: true
    })
    await reviewStarted
    await expect(runner.cancelRun(first.id)).rejects.toThrow('cancel journal failed')

    const next = await runner.startRun({ project: project.id, prompt: 'Persist another Run.' })
    await runner.waitForRun(next.id)

    expect(durableRuns.find((run) => run.id === first.id)).toMatchObject({
      status: 'running',
      sessionCommitStatus: 'completed'
    })

    releaseReview?.()
    await expect(runner.waitForRun(first.id)).resolves.toMatchObject({ status: 'completed' })
  })

  it('excludes a failed initial Run from snapshots queued behind its rejected write', async () => {
    let releaseFirstWrite: (() => void) | undefined
    let markFirstWriteStarted: (() => void) | undefined
    let finishPrompt: (() => void) | undefined
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve
    })
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const snapshots: (readonly TaskRun[])[] = []
    let writeCount = 0
    let sessionCount = 0
    const ids = ['user-1', 'run-1', 'user-2', 'run-2']
    const runner = createRunner({
      runJournal: {
        load: async () => [],
        replace: async (runs) => {
          writeCount += 1
          if (writeCount === 1) {
            markFirstWriteStarted?.()
            await firstWriteGate
            throw new Error('initial journal write failed')
          }
          snapshots.push(structuredClone(runs))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: `session-${++sessionCount}` }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => promptGate
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const rejectedStart = runner.startRun({ project: project.id, prompt: 'First Run.' })
    await firstWriteStarted
    const acceptedStart = runner.startRun({ project: project.id, prompt: 'Second Run.' })
    await vi.waitFor(() => expect(() => runner.getRun('run-2')).not.toThrow())
    releaseFirstWrite?.()

    await expect(rejectedStart).rejects.toThrow('initial journal write failed')
    const accepted = await acceptedStart
    expect(snapshots[0]?.map(({ id }) => id)).toEqual(['run-2'])

    finishPrompt?.()
    await runner.waitForRun(accepted.id)
  })
})
