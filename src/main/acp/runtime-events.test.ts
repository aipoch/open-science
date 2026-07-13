import type { SessionNotification, ToolCallContent } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { extractToolFailureText, toAcpRuntimeEvent } from './runtime-events'

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

  it('maps tool calls into compact runtime events', () => {
    const notification: SessionNotification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
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
    }

    const event = toAcpRuntimeEvent(notification, 'event-2', 1710000000001)

    expect(event).toMatchObject({
      id: 'event-2',
      timestamp: 1710000000001,
      kind: 'tool',
      sessionId: 'session-1',
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
})
