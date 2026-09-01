import type { SessionNotification, ToolCallContent } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { MAX_ACP_MESSAGE_IMAGE_BYTES } from '../../shared/acp'
import { sanitizeToolActivity } from '../../shared/session-persistence'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'

describe('ACP runtime event normalization', () => {
  it('maps assistant text chunks into readable runtime events', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: {
          type: 'text',
          text: 'Hello from Claude'
        }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-1', 1710000000000)).toMatchObject({
      id: 'event-1',
      timestamp: 1710000000000,
      kind: 'message',
      role: 'assistant',
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Hello from Claude'
    })
  })

  it('rewrites Claude Code policy attribution only for assistant messages', () => {
    const text =
      'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request in a new session or change your model.'
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-refusal', 1710000000000, true).text).toBe(
      'The selected model declined to complete this response under its safety policy. Try rephrasing the request in a new session or change your model.'
    )
    expect(toAcpRuntimeEvent(notification, 'event-other-agent', 1710000000000).text).toBe(text)
    expect(
      toAcpRuntimeEvent(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text }
          }
        },
        'event-user-refusal',
        1710000000000,
        true
      ).text
    ).toBe(text)
  })

  it('preserves bounded assistant image chunks through the runtime fallback transport', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: {
          type: 'image',
          mimeType: 'image/png',
          data: 'AQID'
        }
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-image', 1710000000000)

    expect(event).toMatchObject({
      kind: 'message',
      role: 'assistant',
      image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 },
      text: '[open-science:acp-message-image]',
      raw: {
        update: {
          content: { type: 'image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }
        }
      }
    })
  })

  it('omits unsupported and oversized assistant image data', () => {
    const createImageNotification = (mimeType: string, data: string): SessionNotification =>
      ({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', mimeType, data }
        }
      }) as SessionNotification

    const unsupported = toAcpRuntimeEvent(
      createImageNotification('image/svg+xml', 'PHN2Zz4='),
      'event-svg'
    )
    const oversizedData = 'A'.repeat(Math.ceil(((MAX_ACP_MESSAGE_IMAGE_BYTES + 1) * 4) / 3))
    const oversized = toAcpRuntimeEvent(
      createImageNotification('image/png', oversizedData),
      'event-large'
    )

    expect(unsupported.image).toBeUndefined()
    expect(unsupported.text).toContain('omitted')
    expect(JSON.stringify(unsupported.raw)).not.toContain('PHN2Zz4=')
    expect(oversized.image).toBeUndefined()
    expect(JSON.stringify(oversized.raw)).not.toContain(oversizedData.slice(0, 100))
  })

  it('maps tool calls into compact runtime events', () => {
    const notification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        messageId: 'provider-message-1',
        toolCallId: 'tool-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
        _meta: {
          toolName: 'read_file',
          mcpServerId: 'filesystem',
          preview_tool_kind: 'mcp-component'
        }
      }
    } as unknown as SessionNotification

    const event = toAcpRuntimeEvent(notification, 'event-2', 1710000000001)

    expect(event).toMatchObject({
      id: 'event-2',
      timestamp: 1710000000001,
      kind: 'tool',
      sessionId: 'session-1',
      messageId: 'provider-message-1',
      toolCallId: 'tool-1',
      title: 'Read file',
      providerToolName: 'read_file',
      toolKind: 'read',
      status: 'pending'
    })
    expect(event).not.toHaveProperty('toolName')
    expect(event).not.toHaveProperty('toolCategory')
    expect(event).not.toHaveProperty('mcpServerId')
    expect(event).not.toHaveProperty('previewToolKind')
  })

  it('extracts CodeBuddy tool identity metadata', () => {
    expect(
      extractProviderToolName({ _meta: { 'codebuddy.ai/toolName': ' mcp__skills__load_skill ' } })
    ).toBe('mcp__skills__load_skill')
  })

  it('maps Codex context-compaction tool calls into the shared compaction lifecycle', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'compact-1',
        title: 'Context compacting',
        kind: 'other',
        status: 'in_progress',
        _meta: { contextCompaction: true }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-compact-start', 1710000000002)).toMatchObject({
      id: 'event-compact-start',
      timestamp: 1710000000002,
      kind: 'compaction',
      sessionId: 'session-1',
      toolCallId: 'compact-1',
      title: 'Compacting context',
      status: 'in_progress'
    })
  })

  it.each(['tool_call', 'tool_call_update'] as const)(
    'maps Codex %s completion events for live updates and history replay',
    (sessionUpdate) => {
      const notification: SessionNotification = {
        sessionId: 'session-1',
        update: {
          sessionUpdate,
          toolCallId: 'compact-1',
          title: 'Context compacted',
          kind: 'other',
          status: 'completed',
          _meta: { contextCompaction: true }
        }
      }

      expect(toAcpRuntimeEvent(notification, `event-${sessionUpdate}`)).toMatchObject({
        kind: 'compaction',
        sessionId: 'session-1',
        toolCallId: 'compact-1',
        title: 'Context compacted',
        status: 'completed'
      })
    }
  )

  it('maps tool call updates without preview metadata', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'execute',
        status: 'completed',
        _meta: {
          tool_name: 'jupyter',
          mcp_server_id: 'python',
          preview_tool_kind: 'mcp-component'
        }
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-3', 1710000000002)

    expect(event).toMatchObject({
      id: 'event-3',
      timestamp: 1710000000002,
      kind: 'tool',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      providerToolName: 'jupyter',
      status: 'completed'
    })
    expect(event).not.toHaveProperty('toolName')
    expect(event).not.toHaveProperty('toolCategory')
    expect(event).not.toHaveProperty('mcpServerId')
    expect(event).not.toHaveProperty('previewToolKind')
  })

  it('prefers trimmed Claude provider tool names over legacy metadata fields', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Search web',
        kind: 'fetch',
        status: 'pending',
        _meta: {
          toolName: 'legacy_search',
          claudeCode: {
            toolName: '  WebSearch  '
          }
        }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-4', 1710000000003)).toMatchObject({
      id: 'event-4',
      kind: 'tool',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      providerToolName: 'WebSearch',
      toolKind: 'fetch'
    })
  })

  it('captures raw tool input and output for the activity detail view', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls -la' },
        rawOutput: { stdout: 'total 8' }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-5', 1710000000004)).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      rawInput: { command: 'ls -la' },
      rawOutput: { stdout: 'total 8' }
    })
  })

  it('does not expose tool credentials through runtime events or persisted activities', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-secret',
        kind: 'execute',
        status: 'completed',
        rawInput: {
          query: 'safe input',
          connection: { apiKey: 'test-api-key-secret' }
        },
        rawOutput: {
          result: 'safe output',
          authorization: 'Bearer test-authorization-secret'
        }
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-secret', 1710000000005)
    const persisted = sanitizeToolActivity({
      ...event,
      sortIndex: 1,
      eventIds: [event.id],
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    })

    expect(event.rawInput).toMatchObject({ query: 'safe input' })
    expect(event.rawOutput).toMatchObject({ result: 'safe output' })
    expect(event.rawInput).toMatchObject({ connection: { apiKey: '[redacted]' } })
    expect(event.rawOutput).toMatchObject({ authorization: '[redacted]' })
    expect(JSON.stringify(event)).not.toContain('test-api-key-secret')
    expect(JSON.stringify(event)).not.toContain('test-authorization-secret')
    expect(JSON.stringify(persisted)).not.toContain('test-api-key-secret')
    expect(JSON.stringify(persisted)).not.toContain('test-authorization-secret')
  })

  it('redacts credentials embedded in raw tool payload strings', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-string-secret',
        kind: 'execute',
        status: 'completed',
        rawInput: {
          command:
            'curl "https://example.test/data?token=test-url-secret" --header "Authorization: Bearer test-header-secret"'
        },
        rawOutput: '{"apiKey":"test-json-secret"}'
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-string-secret', 1710000000006)
    const persisted = sanitizeToolActivity({
      ...event,
      sortIndex: 1,
      eventIds: [event.id],
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    })

    expect(JSON.stringify(event)).not.toContain('test-url-secret')
    expect(JSON.stringify(event)).not.toContain('test-header-secret')
    expect(JSON.stringify(event)).not.toContain('test-json-secret')
    expect(JSON.stringify(event)).toContain('[redacted]')
    expect(JSON.stringify(persisted)).not.toContain('test-url-secret')
    expect(JSON.stringify(persisted)).not.toContain('test-header-secret')
    expect(JSON.stringify(persisted)).not.toContain('test-json-secret')
  })

  it('bounds large tool detail fields before they enter runtime snapshots', () => {
    const event = new AcpRuntimeSnapshotOwner('/workspace').appendEvent(
      toAcpRuntimeEvent(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-large-output',
            status: 'in_progress',
            content: [
              { type: 'content', content: { type: 'text', text: 'a'.repeat(20_000) } },
              { type: 'content', content: { type: 'text', text: 'b'.repeat(20_000) } }
            ],
            _meta: { terminal_output: { data: 'c'.repeat(20_000) } }
          }
        },
        'event-large-output'
      )
    )

    expect(event.toolContent).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: `${'a'.repeat(16_000)}\n…` }
      }
    ])
    expect(event.terminalOutput).toBe(`${'c'.repeat(16_000)}\n…`)
    expect(JSON.stringify(event.toolContent).length).toBeLessThanOrEqual(32_000)
  })

  it('preserves a Literature presentation block when the full result is truncated', () => {
    const presentation = JSON.stringify({
      openScienceLiteraturePresentation: {
        retrievalMode: 'bm25',
        documentNames: ['paper.pdf'],
        passageCount: 4
      }
    })
    const event = new AcpRuntimeSnapshotOwner('/workspace').appendEvent(
      toAcpRuntimeEvent(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'literature-large-output',
            status: 'completed',
            content: [
              { type: 'content', content: { type: 'text', text: presentation } },
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({ passages: [{ content: 'a'.repeat(40_000) }] })
                }
              }
            ]
          }
        },
        'event-literature-large-output'
      )
    )

    expect(event.toolContent).toHaveLength(2)
    expect(event.toolContent?.[0]).toEqual({
      type: 'content',
      content: { type: 'text', text: presentation }
    })
    expect(JSON.stringify(event.toolContent?.[1])).toContain('…')
    expect(JSON.stringify(event.toolContent).length).toBeLessThanOrEqual(32_000)
  })

  it('recovers a Literature presentation block from an oversized native MCP result envelope', () => {
    const presentation = JSON.stringify({
      openScienceLiteraturePresentation: {
        retrievalMode: 'bm25',
        documentNames: ['paper.pdf'],
        passageCount: 6
      }
    })
    const event = toAcpRuntimeEvent(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'literature-native-large-output',
          status: 'completed',
          rawOutput: {
            result: {
              content: [
                { type: 'text', text: presentation },
                {
                  type: 'text',
                  text: JSON.stringify({ passages: [{ content: 'a'.repeat(40_000) }] })
                }
              ]
            },
            error: null
          }
        }
      },
      'event-literature-native-large-output'
    )

    expect(event.toolContent).toEqual([
      { type: 'content', content: { type: 'text', text: presentation } }
    ])
    expect(event.rawOutput).toBeUndefined()
  })

  it.each([
    'mcp__open-science-literature__read_document',
    'open_science_literature_read_document',
    'open-science-literature/read_document',
    'mcp.open-science-literature.read_document'
  ])('preserves page-batch metadata when a Literature result body is truncated for %s', (title) => {
    const result = JSON.stringify({
      scope: 'full-document',
      document: {
        id: 'private-binding-id',
        name: 'paper.pdf',
        checksum: 'private-checksum',
        pageCount: 14
      },
      passage: {
        pageStart: 1,
        pageEnd: 5,
        text: 'a'.repeat(40_000)
      },
      nextCursor: 'private-next-cursor'
    })
    const event = new AcpRuntimeSnapshotOwner('/workspace').appendEvent(
      toAcpRuntimeEvent(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'literature-page-batch',
            title,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: result } }]
          }
        },
        'event-literature-page-batch'
      )
    )

    expect(event.toolContent?.[0]).toEqual({
      type: 'content',
      content: {
        type: 'text',
        text: JSON.stringify({
          openScienceLiteraturePresentation: {
            documentNames: ['paper.pdf'],
            pageStart: 1,
            pageEnd: 5,
            hasMore: true
          }
        })
      }
    })
    expect(JSON.stringify(event.toolContent?.[0])).not.toContain('private-binding-id')
    expect(JSON.stringify(event.toolContent?.[0])).not.toContain('private-next-cursor')
  })

  it('projects ACP tool-result images without retaining bytes in runtime or Session JSON', () => {
    const imageData = Buffer.from('tiny-image').toString('base64')
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-image',
        title: 'View image',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: '{"status":"completed"}' } },
          {
            type: 'content',
            content: { type: 'image', mimeType: 'image/png', data: imageData }
          }
        ],
        rawOutput: {
          content: [
            { type: 'text', text: '{"status":"completed"}' },
            { type: 'image', mimeType: 'image/png', data: imageData }
          ]
        }
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-image-tool', 1710000000004)
    const persisted = sanitizeToolActivity({
      ...event,
      sortIndex: 1,
      eventIds: [event.id],
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    })

    expect(event.toolContent).toEqual([
      { type: 'content', content: { type: 'text', text: '{"status":"completed"}' } },
      { type: 'content', content: { type: 'text', text: '[image: image/png]' } }
    ])
    expect(event.rawOutput).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain(imageData)
    expect(JSON.stringify(persisted)).not.toContain(imageData)
  })

  it('drops image bytes that appear only inside nested raw tool output', () => {
    const imageData = Buffer.from('raw-only-image').toString('base64')
    for (const rawOutput of [
      {
        result: {
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: imageData }
            }
          ]
        }
      },
      {
        response: {
          output: [
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${imageData}`
            }
          ]
        }
      },
      JSON.stringify({
        content: [{ type: 'image', mimeType: 'image/png', data: imageData }]
      })
    ]) {
      const event = toAcpRuntimeEvent(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-raw-image',
            status: 'completed',
            content: [
              { type: 'content', content: { type: 'text', text: '{"status":"completed"}' } }
            ],
            rawOutput
          }
        },
        'event-raw-image',
        1710000000004
      )

      const persisted = sanitizeToolActivity({
        ...event,
        sortIndex: 1,
        eventIds: [event.id],
        createdAt: event.timestamp,
        updatedAt: event.timestamp
      })
      expect(event.rawOutput).toBeUndefined()
      expect(JSON.stringify(event)).not.toContain(imageData)
      expect(JSON.stringify(persisted)).not.toContain(imageData)
    }
  })

  it('does not inspect a raw-output echo after structured content proves an image', () => {
    const toJSON = vi.fn(() => {
      throw new Error('raw output should not be serialized')
    })
    const event = toAcpRuntimeEvent(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-structured-image',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'image', mimeType: 'image/png', data: 'transient' }
            }
          ],
          rawOutput: { toJSON }
        }
      },
      'event-structured-image',
      1710000000005
    )

    expect(event.rawOutput).toBeUndefined()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('omits native Skill instruction documents from activity events', () => {
    const skillDocument = '<skill_content name="mcp-pubmed">Internal instructions</skill_content>'
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'skill-1',
        title: 'Loaded skill: mcp-pubmed',
        status: 'completed',
        rawInput: { name: 'mcp-pubmed' },
        rawOutput: { content: skillDocument },
        content: [{ type: 'content', content: { type: 'text', text: skillDocument } }]
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-skill', 1710000000004)

    expect(event).toMatchObject({
      kind: 'tool',
      toolCallId: 'skill-1',
      title: 'Loaded skill: mcp-pubmed',
      status: 'completed'
    })
    expect(event).not.toHaveProperty('toolContent')
    expect(event).not.toHaveProperty('rawInput')
    expect(event).not.toHaveProperty('rawOutput')
    expect(JSON.stringify(event)).not.toContain(skillDocument)

    const genericUpdate = toAcpRuntimeEvent(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'skill-claude',
          title: 'Skill',
          status: 'completed',
          _meta: { claudeCode: { toolName: 'Skill' } }
        }
      },
      'event-claude-skill-update',
      1710000000005
    )
    expect(genericUpdate.title).toBeUndefined()
  })

  it('keeps only the safe Skill name from Claude native Skill events', () => {
    const skillDocument = '<skill_content name="mcp-pubmed">Internal instructions</skill_content>'
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'skill-claude',
        title: 'Skill',
        status: 'completed',
        rawInput: { name: 'mcp-pubmed' },
        rawOutput: { content: skillDocument },
        content: [{ type: 'content', content: { type: 'text', text: skillDocument } }],
        _meta: { claudeCode: { toolName: 'Skill' } }
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-claude-skill', 1710000000004)

    expect(event).toMatchObject({
      kind: 'tool',
      providerToolName: 'Skill',
      title: 'Loaded skill: mcp-pubmed',
      status: 'completed'
    })
    expect(event).not.toHaveProperty('toolContent')
    expect(event).not.toHaveProperty('rawInput')
    expect(event).not.toHaveProperty('rawOutput')
    expect(JSON.stringify(event)).not.toContain(skillDocument)
  })

  it('drops oversized raw tool payloads before runtime snapshots are broadcast', () => {
    const oversizedInput = { content: 'A'.repeat(10_000) }
    const oversizedOutput = { result: 'B'.repeat(10_000) }
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-large',
        kind: 'execute',
        status: 'completed',
        rawInput: oversizedInput,
        rawOutput: oversizedOutput
      }
    }

    const event = toAcpRuntimeEvent(notification, 'event-large-tool', 1710000000005)

    expect(event.rawInput).toBeUndefined()
    expect(event.rawOutput).toBeUndefined()
    expect(event.raw).toBeUndefined()
  })

  it('extracts streamed terminal output and exit code from tool metadata', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        _meta: {
          terminal_output: { terminal_id: 'tool-1', data: 'hello world' },
          terminal_exit: { terminal_id: 'tool-1', exit_code: 0, signal: null }
        }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-6', 1710000000005)).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      terminalOutput: 'hello world',
      terminalExitCode: 0
    })
  })

  it('carries token usage and ignores provider cost metadata', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 24890,
        size: 200000,
        cost: { amount: 0.12525, currency: 'USD' }
      }
    }

    expect(toAcpRuntimeEvent(notification, 'event-7', 1710000000006)).toMatchObject({
      kind: 'system',
      contextUsage: { used: 24890, size: 200000 }
    })
    expect(
      toAcpRuntimeEvent(notification, 'event-7', 1710000000006).contextUsage
    ).not.toHaveProperty('cost')
  })

  it('preserves an empty context with its required window size', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 0, size: 128000 }
    }

    const event = toAcpRuntimeEvent(notification, 'event-8', 1710000000007)

    expect(event.contextUsage).toEqual({ used: 0, size: 128000 })
  })
})

describe('extractToolFailureText', () => {
  const textContent = (text: string): ToolCallContent => ({
    type: 'content',
    content: { type: 'text', text }
  })

  it('joins text blocks and ignores non-text content to keep raw output out of the log', () => {
    const content: ToolCallContent[] = [
      textContent('Unable to verify if domain example.com is safe to fetch.'),
      { type: 'terminal', terminalId: 'term-1' } as unknown as ToolCallContent
    ]

    expect(extractToolFailureText(content)).toBe(
      'Unable to verify if domain example.com is safe to fetch.'
    )
  })

  it('truncates long reasons so large tool output cannot flood the log', () => {
    const result = extractToolFailureText([textContent('x'.repeat(500))])

    expect(result).toHaveLength(301)
    expect(result?.endsWith('…')).toBe(true)
  })

  it('returns undefined when there is no content or no text', () => {
    expect(extractToolFailureText(undefined)).toBeUndefined()
    expect(extractToolFailureText([])).toBeUndefined()
    expect(
      extractToolFailureText([{ type: 'terminal', terminalId: 't' } as unknown as ToolCallContent])
    ).toBeUndefined()
  })

  it('does not treat arbitrary raw MCP result text as a failure reason', () => {
    expect(
      extractToolFailureText(undefined, {
        result: { content: [{ type: 'text', text: 'artifact contents: api_key=do-not-log' }] }
      })
    ).toBeUndefined()
  })
})
