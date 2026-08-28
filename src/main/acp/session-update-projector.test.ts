import type { SessionNotification } from '@agentclientprotocol/sdk'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AcpRuntimeEvent } from '../../shared/acp'

import { AcpSessionUpdateProjector } from './session-update-projector'

type TestRouting = Readonly<{
  framework?: 'claude-code' | 'codex' | 'opencode' | 'codebuddy'
  appSessionId?: string
  eventId: string
  timestamp?: number
  visible: boolean
  reconnectPending: boolean
  mcpServerNames: readonly string[]
}>

type RecordedEffect = Readonly<Record<string, unknown> & { kind: string }>

type TestProjector = Readonly<{
  beginGeneration: (root?: string) => void
  clearGeneration: () => void
  clearSession: (sessionId: string) => void
  dispose: () => void
  route: (notification: SessionNotification, routing: TestRouting) => readonly RecordedEffect[]
}>

const createProjector = (
  initialPermissionProfile: SessionPermissionProfileState = {
    selectedProfile: 'ask',
    effectiveProfile: 'ask',
    currentModeId: 'default',
    availableModeIds: ['default', 'bypassPermissions'],
    fullAccessAvailable: true
  },
  acceptProviderPermissionProfile = true,
  presentationToolCallId: (
    notification: SessionNotification,
    context: Readonly<{ sessionId: string }>,
    providerToolCallId: string
  ) => string = (_notification, _context, providerToolCallId) => providerToolCallId
): TestProjector => {
  let routing: TestRouting = {
    eventId: 'event-route',
    visible: true,
    reconnectPending: false,
    mcpServerNames: []
  }
  let effects: RecordedEffect[] = []
  let permissionProfile = initialPermissionProfile
  const record = (effect: RecordedEffect): void => {
    effects.push(Object.freeze(effect))
  }
  const owner = new AcpSessionUpdateProjector({
    registry: {
      lookup: (sessionId) =>
        ({
          aggregate: {
            snapshot: () => ({
              frameworkId: routing.framework,
              permissionProfile
            }),
            setPermissionProfile: (profile: SessionPermissionProfileState) => {
              permissionProfile = profile
              record({
                kind: 'current-mode',
                sessionId,
                currentModeId: profile.currentModeId,
                selectedProfile: profile.selectedProfile
              })
            }
          }
        }) as never
    },
    contextUsage: {
      beginSession: () => undefined,
      observeSessionUpdate: (sessionId, notification, observation) =>
        record({ kind: 'context-observation', sessionId, notification, observation }),
      confirmProviderCompaction: (sessionId) => {
        record({ kind: 'provider-compaction-completed', sessionId })
        return true
      },
      reconcileProviderUsage: (sessionId, usage) =>
        record({ kind: 'provider-usage', sessionId, usage }),
      refreshUsage: (sessionId) => {
        record({ kind: 'context-refresh', sessionId })
        return true
      },
      usage: () => undefined
    },
    contextPolicy: {
      resolve: () => ({ estimateInput: { frameworkId: 'claude-code' } })
    },
    hasActiveSession: () => false,
    currentFramework: () => routing.framework ?? 'claude-code',
    reconnectPending: () => routing.reconnectPending,
    mcpServerNamesFor: () => routing.mcpServerNames,
    presentationToolCallId,
    nextEventId: () => routing.eventId,
    setProviderPermissionProfile: (sessionId, profile) => {
      if (!acceptProviderPermissionProfile) return false
      record({ kind: 'live-profile', sessionId, selectedProfile: profile.selectedProfile })
      return true
    },
    emitState: () => undefined,
    pushEvent: (event) => record({ kind: 'visible-event', event }),
    reportToolFailure: (effect) => record(effect)
  })
  return {
    beginGeneration: (root?: string) => owner.beginGeneration(root),
    clearGeneration: () => owner.clearGeneration(),
    clearSession: (sessionId: string) => owner.clearSession(sessionId),
    dispose: () => owner.dispose(),
    route: (notification: SessionNotification, nextRouting: TestRouting) => {
      routing = nextRouting
      effects = []
      owner.route(notification, {
        appSessionId: routing.appSessionId,
        visible: routing.visible
      })
      return Object.freeze([...effects])
    }
  }
}

describe('AcpSessionUpdateProjector', () => {
  it('projects a provider tool replay through its app presentation identity', () => {
    const projector = createProjector(
      undefined,
      true,
      (_notification, context, providerToolCallId) =>
        context.sessionId === 'stable-session' && providerToolCallId === 'tool-replayed'
          ? 'tool-original'
          : providerToolCallId
    )

    const effects = projector.route(
      {
        sessionId: 'provider-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-replayed',
          title: 'mcp__open-science-notebook__notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: { language: 'python', code: 'print(1)' }
        }
      },
      {
        framework: 'claude-code',
        appSessionId: 'stable-session',
        eventId: 'event-replayed',
        visible: true,
        reconnectPending: false,
        mcpServerNames: ['open-science-notebook']
      }
    )

    expect(effects).toContainEqual(
      expect.objectContaining({
        kind: 'visible-event',
        event: expect.objectContaining({
          sessionId: 'stable-session',
          toolCallId: 'tool-original'
        })
      })
    )
  })

  it('routes stable Session usage through context owners in projection order', () => {
    const journal: string[] = []
    const beginSession = vi.fn(() => journal.push('context:begin'))
    const observeSessionUpdate = vi.fn(() => journal.push('context:observe'))
    const reconcileProviderUsage = vi.fn(() => journal.push('context:reconcile'))
    const nextEventId = vi.fn(() => 'event-routed')
    const projector = new AcpSessionUpdateProjector({
      registry: {
        lookup: () => ({ aggregate: { snapshot: () => ({ frameworkId: 'opencode' }) } }) as never
      },
      contextUsage: {
        beginSession,
        confirmProviderCompaction: () => false,
        observeSessionUpdate,
        reconcileProviderUsage,
        refreshUsage: () => false,
        usage: () => undefined
      },
      contextPolicy: {
        resolve: () => {
          journal.push('context:resolve')
          return {
            estimateInput: { frameworkId: 'opencode', model: 'confirmed/model' },
            selectedWindow: 200_000
          }
        }
      },
      hasActiveSession: () => true,
      currentFramework: () => 'claude-code',
      reconnectPending: () => false,
      mcpServerNamesFor: () => [],
      presentationToolCallId: (_notification, _context, providerToolCallId) => providerToolCallId,
      nextEventId,
      setProviderPermissionProfile: () => true,
      emitState: () => journal.push('state:emit'),
      pushEvent: () => journal.push('event:push'),
      reportToolFailure: () => journal.push('diagnostic')
    })

    projector.route(
      {
        sessionId: 'provider-session',
        update: { sessionUpdate: 'usage_update', used: 42, size: 128_000 }
      },
      { appSessionId: 'stable-session' }
    )

    expect(nextEventId).toHaveBeenCalledOnce()
    expect(journal).toEqual([
      'context:resolve',
      'context:begin',
      'context:observe',
      'context:resolve',
      'context:reconcile',
      'state:emit'
    ])
    expect(observeSessionUpdate).toHaveBeenCalledWith(
      'stable-session',
      expect.objectContaining({ sessionId: 'stable-session' }),
      {}
    )
    expect(reconcileProviderUsage).toHaveBeenCalledWith(
      'stable-session',
      { used: 42, size: 128_000 },
      200_000
    )
  })

  it('relabels provider updates and orders context projection before the visible event', () => {
    const projector = createProjector()
    const notification: SessionNotification = {
      sessionId: 'provider-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'Hello' }
      }
    }

    const effects = projector.route(notification, {
      appSessionId: 'stable-session',
      eventId: 'event-1',
      timestamp: 1710000000000,
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    })

    expect(effects.map((effect) => effect.kind)).toEqual([
      'context-observation',
      'context-refresh',
      'visible-event'
    ])
    expect(effects[0]).toMatchObject({
      kind: 'context-observation',
      sessionId: 'stable-session',
      notification: { sessionId: 'stable-session' }
    })
    expect(effects[2]).toMatchObject({
      kind: 'visible-event',
      event: {
        id: 'event-1',
        timestamp: expect.any(Number),
        sessionId: 'stable-session',
        kind: 'message',
        text: 'Hello'
      }
    })
    expect(Object.isFrozen(effects)).toBe(true)
    expect(effects.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    ['claude-code', 'mcp__open-science-notebook__ask_user_question'],
    ['opencode', 'open_science_notebook_ask_user_question'],
    ['codex', 'mcp.open-science-notebook.ask_user_question']
  ] as const)(
    'keeps the %s app-owned user-choice MCP call out of the visible activity timeline',
    (framework, providerToolName) => {
      const projector = createProjector()
      const effects = projector.route(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'choice-tool-1',
            title: providerToolName,
            status: 'failed',
            _meta:
              framework === 'claude-code'
                ? { claudeCode: { toolName: providerToolName } }
                : { toolName: providerToolName }
          }
        },
        {
          framework,
          eventId: 'event-choice-tool',
          visible: true,
          reconnectPending: false,
          mcpServerNames: ['open-science-notebook']
        }
      )

      expect(effects.map((effect) => effect.kind)).toEqual([
        'context-observation',
        'context-refresh'
      ])
    }
  )

  it('keeps a sparse Codex app-owned user-choice MCP call out of the visible activity timeline', () => {
    const projector = createProjector()
    const effects = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'choice-tool-1',
          kind: 'execute',
          title: 'Tool activity',
          status: 'pending',
          rawInput: {
            server: 'open-science-notebook',
            tool: 'ask_user_question',
            arguments: { questions: [] }
          },
          _meta: { is_mcp_tool_call: true }
        }
      },
      {
        framework: 'codex',
        eventId: 'event-choice-tool',
        visible: true,
        reconnectPending: false,
        mcpServerNames: ['open-science-notebook']
      }
    )

    expect(effects.map((effect) => effect.kind)).toEqual(['context-observation', 'context-refresh'])
  })

  it('keeps generic Codex follow-up updates hidden for a recognized user-choice call', () => {
    const projector = createProjector()
    const routing = {
      framework: 'codex' as const,
      eventId: 'event-choice-tool',
      visible: true,
      reconnectPending: false,
      mcpServerNames: ['open-science-notebook']
    }

    projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'choice-tool-1',
          title: 'Tool activity',
          status: 'pending',
          rawInput: { server: 'open-science-notebook', tool: 'ask_user_question' },
          _meta: { is_mcp_tool_call: true }
        }
      },
      routing
    )
    const followUp = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'choice-tool-1',
          title: 'Tool activity',
          status: 'completed'
        }
      },
      { ...routing, eventId: 'event-choice-tool-completed' }
    )
    const reusedId = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'choice-tool-1',
          title: 'Ordinary tool',
          status: 'pending'
        }
      },
      { ...routing, eventId: 'event-ordinary-tool' }
    )

    expect(followUp.map((effect) => effect.kind)).toEqual([
      'context-observation',
      'context-refresh'
    ])
    expect(reusedId.map((effect) => effect.kind)).toContain('visible-event')
  })

  it.each([
    ['missing Codex MCP marker', undefined, 'open-science-notebook', 'ask_user_question'],
    [
      'unconfigured MCP server',
      { is_mcp_tool_call: true },
      'external-notebook',
      'ask_user_question'
    ],
    [
      'ordinary app MCP tool',
      { is_mcp_tool_call: true },
      'open-science-notebook',
      'notebook_execute'
    ]
  ] as const)('keeps sparse Codex tool activity visible for %s', (_name, meta, server, tool) => {
    const projector = createProjector()
    const effects = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          kind: 'execute',
          title: 'Tool activity',
          status: 'pending',
          rawInput: { server, tool, arguments: {} },
          ...(meta ? { _meta: meta } : {})
        }
      },
      {
        framework: 'codex',
        eventId: 'event-tool',
        visible: true,
        reconnectPending: false,
        mcpServerNames: ['open-science-notebook']
      }
    )

    expect(effects.map((effect) => effect.kind)).toEqual([
      'context-observation',
      'context-refresh',
      'visible-event'
    ])
  })

  it('suppresses only the unscoped Codex compaction warning', () => {
    const projector = createProjector()
    const warning =
      'Warning: Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.\n\n'
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: warning }
      }
    }
    const routing = {
      framework: 'codex' as const,
      eventId: 'event-warning',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    expect(projector.route(notification, routing)).toEqual([])
    expect(
      projector.route(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'model-message',
            content: { type: 'text', text: warning }
          }
        },
        routing
      )
    ).toMatchObject([
      { kind: 'context-observation' },
      { kind: 'context-refresh' },
      { kind: 'visible-event', event: { text: warning } }
    ])
    expect(projector.route(notification, { ...routing, framework: 'opencode' })).toMatchObject([
      { kind: 'context-observation' },
      { kind: 'context-refresh' },
      { kind: 'visible-event', event: { text: warning } }
    ])
    expect(
      projector.route(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: warning }
          }
        },
        routing
      )
    ).toMatchObject([
      { kind: 'context-observation' },
      { kind: 'context-refresh' },
      { kind: 'visible-event', event: { text: warning } }
    ])
  })

  it('projects CodeBuddy think-tag content separately without changing other frameworks', () => {
    const projector = createProjector()
    const routing = {
      framework: 'codebuddy' as const,
      eventId: 'event-codebuddy-thinking',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }
    const codeBuddy = projector.route(
      {
        sessionId: 'session-one-chunk',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '<think>private</think>Visible in one chunk' }
        }
      },
      routing
    )
    expect(
      codeBuddy.filter((effect) => effect.kind === 'visible-event').map((effect) => effect.event)
    ).toMatchObject([
      { kind: 'thought', text: 'private', raw: undefined },
      { kind: 'message', text: 'Visible in one chunk', raw: undefined }
    ])

    const opencode = createProjector()
    expect(
      opencode.route(
        {
          sessionId: 'session-2',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '<think>literal</think>' }
          }
        },
        { ...routing, framework: 'opencode' }
      )
    ).toContainEqual(
      expect.objectContaining({
        kind: 'visible-event',
        event: expect.objectContaining({ text: '<think>literal</think>' })
      })
    )
  })

  it('segments CodeBuddy assistant presentation across tool boundaries', () => {
    const projector = createProjector()
    const routing = {
      framework: 'codebuddy' as const,
      eventId: 'event-codebuddy-tool',
      visible: true,
      reconnectPending: false,
      mcpServerNames: ['open-science-notebook']
    }
    const toolMessageId = (toolCallId: string): string | undefined => {
      const effect = projector
        .route(
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: 'mcp__open_science_notebook__notebook_execute',
              kind: 'other',
              status: 'pending'
            }
          } as unknown as SessionNotification,
          routing
        )
        .find((candidate) => candidate.kind === 'visible-event')
      return (effect?.event as AcpRuntimeEvent | undefined)?.messageId
    }
    const messageId = (
      text: string,
      providerMessageId = 'codebuddy-turn-message'
    ): string | undefined => {
      const effect = projector
        .route(
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: providerMessageId,
              content: { type: 'text', text }
            }
          },
          routing
        )
        .find((candidate) => candidate.kind === 'visible-event')
      return (effect?.event as AcpRuntimeEvent | undefined)?.messageId
    }

    const firstTool = toolMessageId('notebook-state')
    const beforeExecution = messageId('Notebook is ready.')
    const secondTool = toolMessageId('notebook-execute')
    const afterExecution = messageId('The calculation completed.')
    const nextTurn = messageId('A new response.', 'codebuddy-next-message')

    expect(firstTool).toBeUndefined()
    expect(secondTool).toBeUndefined()
    expect(beforeExecution).toBe('codebuddy-turn-message:notebook-state')
    expect(afterExecution).toBe('codebuddy-turn-message:notebook-execute')
    expect(afterExecution).not.toBe(beforeExecution)
    expect(nextTurn).toBe('codebuddy-next-message')
  })

  it('projects the legacy Codex completion notice as a completed compaction lifecycle', () => {
    const projector = createProjector()
    const notice = "*Context compacted to fit the model's context window.*\n\n"
    const effects = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: notice }
        }
      },
      {
        framework: 'codex',
        eventId: 'event-legacy-compaction',
        visible: true,
        reconnectPending: false,
        mcpServerNames: []
      }
    )

    expect(effects).toMatchObject([
      { kind: 'context-observation' },
      { kind: 'provider-compaction-completed', sessionId: 'session-1' },
      { kind: 'context-refresh' },
      {
        kind: 'visible-event',
        event: {
          kind: 'compaction',
          sessionId: 'session-1',
          status: 'completed',
          title: 'Context compacted',
          toolCallId: 'context-compaction:event-legacy-compaction'
        }
      }
    ])
    expect(effects.at(-1)).not.toHaveProperty('event.text')
  })

  it('confirms a structured Codex compaction lifecycle before publishing completion', () => {
    const projector = createProjector()
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'provider-compaction',
        status: 'completed',
        _meta: { contextCompaction: true }
      }
    }
    const effects = projector.route(notification, {
      framework: 'codex',
      eventId: 'event-compaction',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    })

    expect(effects).toMatchObject([
      { kind: 'context-observation' },
      { kind: 'provider-compaction-completed', sessionId: 'session-1' },
      { kind: 'context-refresh' },
      {
        kind: 'visible-event',
        event: {
          kind: 'compaction',
          status: 'completed',
          toolCallId: 'provider-compaction'
        }
      }
    ])

    expect(
      projector.route(notification, {
        framework: 'codex',
        eventId: 'event-replayed-compaction',
        visible: true,
        reconnectPending: true,
        mcpServerNames: []
      })
    ).not.toContainEqual(expect.objectContaining({ kind: 'provider-compaction-completed' }))
  })

  it('projects usage to context state without a visible event and suppresses stale reconnect usage', () => {
    const projector = createProjector()
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 42, size: 128_000 }
    }
    const routing = {
      eventId: 'event-usage',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    expect(projector.route(notification, routing)).toMatchObject([
      { kind: 'context-observation', sessionId: 'session-1' },
      {
        kind: 'provider-usage',
        sessionId: 'session-1',
        usage: { used: 42, size: 128_000 }
      }
    ])
    expect(projector.route(notification, { ...routing, reconnectPending: true })).toEqual([])
  })

  it('removes Claude Code policy attribution from visible refusal messages', () => {
    const projector = createProjector()
    const [context, refresh, visible] = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing.'
          }
        }
      },
      {
        framework: 'claude-code',
        eventId: 'event-refusal',
        visible: true,
        reconnectPending: false,
        mcpServerNames: []
      }
    )

    expect([context.kind, refresh.kind, visible.kind]).toEqual([
      'context-observation',
      'context-refresh',
      'visible-event'
    ])
    expect(visible).toMatchObject({
      event: {
        text: 'The selected model declined to complete this response under its safety policy. Try rephrasing.'
      }
    })
  })

  it('synchronizes hidden current-mode downgrades with the live permission profile', () => {
    const projector = createProjector({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId: 'bypassPermissions',
      availableModeIds: ['default', 'bypassPermissions'],
      fullAccessAvailable: true
    })
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
    }
    const routing = {
      eventId: 'event-mode',
      visible: false,
      reconnectPending: true,
      mcpServerNames: []
    }

    expect(projector.route(notification, routing)).toMatchObject([
      {
        kind: 'live-profile',
        sessionId: 'session-1',
        selectedProfile: 'ask'
      },
      {
        kind: 'current-mode',
        sessionId: 'session-1',
        currentModeId: 'default',
        selectedProfile: 'ask'
      }
    ])
  })

  it('projects CodeBuddy fullAccess mode onto the Full access profile', () => {
    const projector = createProjector({
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId: 'default',
      availableModeIds: ['default', 'fullAccess'],
      fullAccessAvailable: true
    })

    expect(
      projector.route(
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'fullAccess' }
        },
        {
          framework: 'codebuddy',
          eventId: 'event-codebuddy-mode',
          visible: false,
          reconnectPending: true,
          mcpServerNames: []
        }
      )
    ).toMatchObject([
      { kind: 'live-profile', sessionId: 'session-1', selectedProfile: 'full' },
      {
        kind: 'current-mode',
        sessionId: 'session-1',
        currentModeId: 'fullAccess',
        selectedProfile: 'full'
      }
    ])
  })

  it('does not project provider modes while a user profile transition owns the state', () => {
    const projector = createProjector(
      {
        selectedProfile: 'full',
        effectiveProfile: 'full',
        currentModeId: 'bypassPermissions',
        availableModeIds: ['default', 'bypassPermissions'],
        fullAccessAvailable: true
      },
      false
    )

    expect(
      projector.route(
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
        },
        {
          eventId: 'event-mode',
          visible: false,
          reconnectPending: false,
          mcpServerNames: []
        }
      )
    ).toMatchObject([{ kind: 'context-observation', sessionId: 'session-1' }])
  })

  it('classifies MCP context and emits a bounded canonical failure diagnostic before the event', () => {
    const projector = createProjector()
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'https://example.com/secret',
        kind: 'other',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Unable to save the artifact.' }
          }
        ],
        rawOutput: { secret: 'do-not-log' },
        _meta: { toolName: 'open_science_artifacts_write_artifact_file' }
      }
    }

    const effects = projector.route(notification, {
      eventId: 'event-tool',
      visible: true,
      reconnectPending: false,
      mcpServerNames: ['open-science-artifacts']
    })

    expect(effects.map((effect) => effect.kind)).toEqual([
      'context-observation',
      'context-refresh',
      'tool-failure-diagnostic',
      'visible-event'
    ])
    expect(effects[0]).toMatchObject({ observation: { toolCategory: 'mcp' } })
    expect(effects[2]).toEqual({
      kind: 'tool-failure-diagnostic',
      tool: 'open-science-artifacts/write_artifact_file',
      toolCallId: 'tool-1',
      sessionId: 'session-1',
      reason: 'Unable to save the artifact.'
    })
    expect(JSON.stringify(effects[2])).not.toContain('example.com')
    expect(JSON.stringify(effects[2])).not.toContain('do-not-log')
  })

  it('uses a safe Codex MCP validation diagnostic when content is absent', () => {
    const sensitiveResult = 'artifact contents: api_key=do-not-log'
    const projector = createProjector()
    const effects = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          kind: 'execute',
          status: 'failed',
          rawInput: {
            server: 'open-science-artifacts',
            tool: 'write_artifact_file',
            arguments: {}
          },
          rawOutput: {
            result: {
              content: [
                {
                  type: 'text',
                  text: `MCP error -32602: Input validation error: Invalid arguments for tool write_artifact_file: Invalid input: expected string, received undefined at filename; ${sensitiveResult}`
                }
              ]
            },
            error: null
          },
          _meta: { toolName: 'mcp.open-science-artifacts.write_artifact_file' }
        }
      },
      {
        eventId: 'event-tool',
        visible: true,
        reconnectPending: false,
        mcpServerNames: ['open-science-artifacts']
      }
    )

    expect(effects[2]).toEqual({
      kind: 'tool-failure-diagnostic',
      tool: 'open-science-artifacts/write_artifact_file',
      toolCallId: 'tool-1',
      sessionId: 'session-1',
      reason: 'MCP input validation failed.'
    })
    expect(JSON.stringify(effects[2])).not.toContain(sensitiveResult)
  })

  it('suppresses empty message events after retaining their context refresh ordering', () => {
    const projector = createProjector()
    const effects = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' }
        }
      },
      {
        eventId: 'event-empty',
        visible: true,
        reconnectPending: false,
        mcpServerNames: []
      }
    )

    expect(effects.map((effect) => effect.kind)).toEqual(['context-observation', 'context-refresh'])
  })

  it('owns Codex Skill activity state for one generation and clears sparse lifecycle correlation', () => {
    const projector = createProjector()
    const skillsRoot = resolve('/data', 'codex-home', 'skills')
    const skillPath = join(skillsRoot, 'mcp-pubmed', 'SKILL.md')
    projector.beginGeneration(skillsRoot)
    const routing = {
      eventId: 'event-skill',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    const loading = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'skill-1',
          title: `Read file '${skillPath}'`,
          kind: 'read',
          status: 'in_progress',
          locations: [{ path: skillPath }]
        }
      },
      routing
    )
    const completed = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'skill-1',
          status: 'completed',
          rawOutput: { formatted_output: 'PRIVATE SKILL BODY' }
        }
      },
      { ...routing, eventId: 'event-skill-complete' }
    )

    expect(loading[0]).toMatchObject({
      kind: 'context-observation',
      observation: { toolCategory: 'skills', skillFilePath: skillPath }
    })
    expect(loading.at(-1)).toMatchObject({
      kind: 'visible-event',
      event: { title: 'Loading skill: mcp-pubmed' }
    })
    expect(completed[0]).toMatchObject({
      observation: { toolCategory: 'skills', skillFilePath: skillPath }
    })
    expect(completed.at(-1)).toMatchObject({
      event: { title: 'Loaded skill: mcp-pubmed' }
    })
    expect(JSON.stringify(completed.at(-1))).not.toContain('PRIVATE SKILL BODY')

    projector.clearGeneration()
    const afterClear = projector.route(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'skill-1',
          status: 'completed'
        }
      },
      { ...routing, eventId: 'event-after-clear' }
    )
    expect(afterClear[0]).toMatchObject({ observation: {} })
    expect(afterClear.at(-1)).not.toMatchObject({
      event: { title: expect.stringContaining('skill') }
    })

    projector.dispose()
  })

  it('clears Codex Skill presentation state for only one Session', () => {
    const projector = createProjector()
    const skillsRoot = resolve('/data', 'codex-home', 'skills')
    projector.beginGeneration(skillsRoot)
    const routing = {
      eventId: 'event-skill',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    for (const [sessionId, skillName] of [
      ['session-a', 'mcp-pubmed'],
      ['session-b', 'mcp-chemistry']
    ] as const) {
      projector.route(
        {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'shared-call-id',
            title: `Read ${skillName}`,
            kind: 'read',
            status: 'in_progress',
            locations: [{ path: join(skillsRoot, skillName, 'SKILL.md') }]
          }
        },
        routing
      )
    }

    projector.clearSession('session-a')
    const complete = (sessionId: string): ReturnType<typeof projector.route> =>
      projector.route(
        {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'shared-call-id',
            status: 'completed'
          }
        },
        { ...routing, eventId: `event-${sessionId}` }
      )

    expect(complete('session-a').at(-1)).not.toMatchObject({
      event: { title: expect.stringContaining('skill') }
    })
    expect(complete('session-b').at(-1)).toMatchObject({
      event: { title: 'Loaded skill: mcp-chemistry' }
    })
  })
})
