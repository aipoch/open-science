import type { SessionNotification } from '@agentclientprotocol/sdk'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AcpSessionUpdateProjector } from './session-update-projector'

describe('AcpSessionUpdateProjector', () => {
  it('relabels provider updates and orders context projection before the visible event', () => {
    const projector = new AcpSessionUpdateProjector()
    const notification: SessionNotification = {
      sessionId: 'provider-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'Hello' }
      }
    }

    const effects = projector.project(notification, {
      kind: 'runtime',
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
        timestamp: 1710000000000,
        sessionId: 'stable-session',
        kind: 'message',
        text: 'Hello'
      }
    })
    expect(Object.isFrozen(effects)).toBe(true)
    expect(effects.every(Object.isFrozen)).toBe(true)
  })

  it('projects usage to context state without a visible event and suppresses stale reconnect usage', () => {
    const projector = new AcpSessionUpdateProjector()
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 42, size: 128_000 }
    }
    const routing = {
      kind: 'runtime' as const,
      eventId: 'event-usage',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    expect(projector.project(notification, routing)).toMatchObject([
      { kind: 'context-observation', sessionId: 'session-1' },
      {
        kind: 'provider-usage',
        sessionId: 'session-1',
        usage: { used: 42, size: 128_000 }
      }
    ])
    expect(projector.project(notification, { ...routing, reconnectPending: true })).toEqual([])
  })

  it('projects hidden current-mode updates while a reconnect suppresses stale context effects', () => {
    const projector = new AcpSessionUpdateProjector()
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' }
    }
    const routing = {
      kind: 'runtime' as const,
      eventId: 'event-mode',
      visible: false,
      reconnectPending: true,
      mcpServerNames: []
    }

    expect(projector.project(notification, routing)).toMatchObject([
      {
        kind: 'current-mode',
        sessionId: 'session-1',
        currentModeId: 'bypassPermissions'
      }
    ])
  })

  it('classifies MCP context and emits a bounded canonical failure diagnostic before the event', () => {
    const projector = new AcpSessionUpdateProjector()
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

    const effects = projector.project(notification, {
      kind: 'runtime',
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

  it('suppresses empty message events after retaining their context refresh ordering', () => {
    const projector = new AcpSessionUpdateProjector()
    const effects = projector.project(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' }
        }
      },
      {
        kind: 'runtime',
        eventId: 'event-empty',
        visible: true,
        reconnectPending: false,
        mcpServerNames: []
      }
    )

    expect(effects.map((effect) => effect.kind)).toEqual(['context-observation', 'context-refresh'])
  })

  it('owns Codex Skill activity state for one generation and clears sparse lifecycle correlation', () => {
    const projector = new AcpSessionUpdateProjector()
    const skillsRoot = resolve('/data', 'codex-home', 'skills')
    const skillPath = join(skillsRoot, 'mcp-pubmed', 'SKILL.md')
    projector.beginGeneration(skillsRoot)
    const routing = {
      kind: 'runtime' as const,
      eventId: 'event-skill',
      visible: true,
      reconnectPending: false,
      mcpServerNames: []
    }

    const loading = projector.project(
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
    const completed = projector.project(
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
    const afterClear = projector.project(
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

  it('projects Permission tool correlation first with the stable Session identity', () => {
    const projector = new AcpSessionUpdateProjector()
    const effects = projector.project(
      {
        sessionId: 'provider-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mcp-1',
          title: 'Run notebook cell',
          kind: 'execute',
          status: 'pending'
        }
      },
      {
        kind: 'permission',
        appSessionId: 'stable-session',
        framework: 'codex',
        mcpServerNames: ['open-science-notebook']
      }
    )

    expect(effects).toEqual([
      {
        kind: 'permission-tool-correlation',
        notification: {
          sessionId: 'stable-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'mcp-1',
            title: 'Run notebook cell',
            kind: 'execute',
            status: 'pending'
          }
        },
        context: {
          sessionId: 'stable-session',
          framework: 'codex',
          mcpServerNames: ['open-science-notebook']
        }
      }
    ])
    expect(Object.isFrozen(effects[0])).toBe(true)
  })
})
