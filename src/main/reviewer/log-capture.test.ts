// Tests for reviewer log capture (issue 13, updated for unified tool entry in issue 15).
// (a) capture: a simulated reviewer update stream produces the expected reviewerLog entries
//     and survives a repository round-trip.
// (c) regression: driveReviewerToStop guards still fire on timeout / max-updates.
// The driveReviewerToStop regression tests live in orchestrator-drive.test.ts; this file focuses on the
// log-capture behavior layered on top of driveReviewerToStop via the new `onUpdate` callback.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ReviewRepository } from './repository'
import { driveReviewerToStop } from './orchestrator'
import type { ReviewerLogEntry } from '../../shared/reviewer'

// ---------------------------------------------------------------------------
// driveReviewerToStop with onUpdate callback — log capture unit tests
// ---------------------------------------------------------------------------

type FakeUpdate = {
  kind: string
  stopReason?: string
  update?: { sessionUpdate?: string; [key: string]: unknown }
}

describe('driveReviewerToStop — log capture via onUpdate', () => {
  it('records media access distinctly without persisting MCP image base64', async () => {
    const base64 = Buffer.alloc(128, 7).toString('base64')
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-media',
          toolName: 'mcp__open_science_reviewer__read_artifact',
          rawInput: { id: 'plot-version', view: 'content' }
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-media',
          rawOutput: JSON.stringify({
            content: [
              { type: 'text', text: '{"kind":"media","mimeType":"image/png"}' },
              { type: 'image', data: base64, mimeType: 'image/png' }
            ]
          }),
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let index = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[index++]! }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (entry) => log.push(entry) }
    )

    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ kind: 'tool', evidenceKind: 'media', status: 'ok' })
    expect(log[0]?.kind === 'tool' ? log[0].rawOutput : '').toContain(
      '[omitted: MCP image content]'
    )
    expect(JSON.stringify(log)).not.toContain(base64)
  })

  it('redacts media through the bounded sanitizer for cyclic and deeply nested output', async () => {
    const base64 = Buffer.alloc(256, 9).toString('base64')
    const rawOutput: Record<string, unknown> = {
      content: [{ type: 'image', data: base64, mimeType: 'image/png' }]
    }
    rawOutput.cycle = rawOutput
    let deep: Record<string, unknown> = rawOutput
    for (let index = 0; index < 30; index++) {
      const next: Record<string, unknown> = {}
      deep.next = next
      deep = next
    }
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-cyclic-media',
          toolName: 'mcp__open_science_reviewer__read_artifact'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-cyclic-media',
          rawOutput,
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let index = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[index++]! }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(
      session,
      {
        timeoutMs: 1000,
        maxUpdates: 100,
        logLimits: {
          maxTextEntryBytes: 512,
          maxToolInputBytes: 512,
          maxToolOutputBytes: 512,
          maxLogBytes: 2_048
        }
      },
      { onUpdate: (entry) => log.push(entry) }
    )

    expect(log[0]).toMatchObject({ kind: 'tool', evidenceKind: 'media', status: 'ok' })
    expect(JSON.stringify(log)).not.toContain(base64)
    expect(log[0]?.kind === 'tool' ? log[0].rawOutput : '').toContain(
      '[omitted: MCP image content]'
    )
  })

  it('collects agent_thought_chunk updates into thought entries', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Thinking…' }
        }
      },
      {
        kind: 'session_update',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' More.' } }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    // Two thought chunks should be assembled into one thought entry.
    expect(log.filter((e) => e.kind === 'thought')).toHaveLength(1)
    const thought = log.find((e) => e.kind === 'thought')
    expect(thought?.kind).toBe('thought')
    if (thought?.kind === 'thought') {
      expect(thought.text).toContain('Thinking…')
      expect(thought.text).toContain(' More.')
    }
  })

  it('collects agent_message_chunk updates into message entries', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Review done.' }
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    const messages = log.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    if (messages[0]?.kind === 'message') {
      expect(messages[0].text).toBe('Review done.')
    }
  })

  it('caps a streaming text entry by serialized UTF-8 bytes', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ééé' }
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 5,
        maxToolInputBytes: 64,
        maxToolOutputBytes: 64,
        maxLogBytes: 256
      }
    }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(session, options, { onUpdate: (entry) => log.push(entry) })

    expect(log).toEqual([{ kind: 'message', text: 'éé', textTruncated: true }])
  })

  it('flushes interleaved content before tools and lets terminal output override raw output', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Trace the evidence.' }
        }
      },
      {
        kind: 'session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: 'Checking the result.' }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-order',
          _meta: { claudeCode: { toolName: 'Bash' } },
          title: 'check result',
          rawInput: 'check result'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-order',
          rawOutput: 'provider fallback',
          status: 'completed',
          _meta: {
            terminal_output: { data: 'terminal result' },
            terminal_exit: { exit_code: 0 }
          }
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (entry) => log.push(entry) }
    )

    expect(log).toEqual([
      { kind: 'thought', text: 'Trace the evidence.' },
      { kind: 'message', text: 'Checking the result.' },
      {
        kind: 'tool',
        toolName: 'Bash',
        title: 'check result',
        rawInput: 'check result',
        rawOutput: 'terminal result',
        status: 'ok',
        exitCode: 0
      }
    ])
  })

  it('caps tool input and output by serialized UTF-8 bytes', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-bounded',
          toolName: 'Bash',
          rawInput: 'ééé'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-bounded',
          rawOutput: 'ééé',
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 64,
        maxToolInputBytes: 5,
        maxToolOutputBytes: 5,
        maxLogBytes: 256
      }
    }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(session, options, { onUpdate: (entry) => log.push(entry) })

    expect(log).toEqual([
      {
        kind: 'tool',
        toolName: 'Bash',
        title: undefined,
        rawInput: 'éé',
        rawInputTruncated: true,
        rawOutput: 'éé',
        rawOutputTruncated: true,
        status: 'ok'
      }
    ])
  })

  it('caps the complete serialized reviewer log across individually valid entries', async () => {
    const chunkKinds = [
      'agent_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk'
    ]
    const updates: FakeUpdate[] = [
      ...chunkKinds.map((sessionUpdate, index) => ({
        kind: 'session_update',
        update: {
          sessionUpdate,
          content: { type: 'text', text: String(index).repeat(40) }
        }
      })),
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 64,
        maxToolInputBytes: 64,
        maxToolOutputBytes: 64,
        maxLogBytes: 256
      }
    }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(session, options, { onUpdate: (entry) => log.push(entry) })

    expect(Buffer.byteLength(JSON.stringify(log), 'utf8')).toBeLessThanOrEqual(256)
    expect(log.at(-1)).toMatchObject({ reviewLogTruncated: true })
  })

  it('keeps later tool updates within the complete serialized log budget', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'context' }
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-total-budget',
          toolName: 'Bash'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-total-budget',
          rawOutput: 'x'.repeat(120),
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 64,
        maxToolInputBytes: 128,
        maxToolOutputBytes: 128,
        maxLogBytes: 180
      }
    }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(session, options, { onUpdate: (entry) => log.push(entry) })

    expect(Buffer.byteLength(JSON.stringify(log), 'utf8')).toBeLessThanOrEqual(180)
    expect(log.at(-1)).toMatchObject({
      kind: 'tool',
      rawOutputTruncated: true,
      reviewLogTruncated: true,
      status: 'ok'
    })
  })

  it('shares the complete log budget across a recovery drive', async () => {
    const makeSession = (): { nextUpdate: () => Promise<FakeUpdate> } => {
      const updates: FakeUpdate[] = [
        {
          kind: 'session_update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'm'.repeat(40) }
          }
        },
        {
          kind: 'session_update',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 't'.repeat(40) }
          }
        },
        { kind: 'stop', stopReason: 'end_turn' }
      ]
      let i = 0
      return { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 64,
        maxToolInputBytes: 64,
        maxToolOutputBytes: 64,
        maxLogBytes: 256
      }
    }
    const log: ReviewerLogEntry[] = []
    const callbacks = {
      onUpdate: (entry: ReviewerLogEntry): void => {
        log.push(entry)
      },
      logState: {}
    }

    await driveReviewerToStop(makeSession(), options, callbacks)
    await driveReviewerToStop(makeSession(), options, callbacks)

    expect(Buffer.byteLength(JSON.stringify(log), 'utf8')).toBeLessThanOrEqual(256)
    expect(log.at(-1)).toMatchObject({ reviewLogTruncated: true })
  })

  it('produces ONE unified tool entry from tool_call + tool_call_update (not split tool_call/tool_result)', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          // ACP: real tool name is in _meta.claudeCode.toolName, not top-level toolName
          _meta: { claudeCode: { toolName: 'Bash' } },
          title: 'python3 -c "host.read_turn()"',
          rawInput: 'python3 -c "host.read_turn()"'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          rawOutput: '[{"kind": "message"}]',
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    // Must produce exactly ONE tool entry (not a tool_call + tool_result pair).
    const toolEntries = log.filter((e) => e.kind === 'tool')
    expect(toolEntries).toHaveLength(1)
    // Verify legacy kinds are absent (cast to string kind for type safety since they no longer exist in the union).
    expect(log.filter((e) => (e as { kind: string }).kind === 'tool_call')).toHaveLength(0)
    expect(log.filter((e) => (e as { kind: string }).kind === 'tool_result')).toHaveLength(0)

    // The entry must carry the real tool name from _meta.claudeCode.toolName.
    const tool = toolEntries[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.toolName).toBe('Bash')
      expect(tool.rawInput).toBe('python3 -c "host.read_turn()"')
      expect(tool.rawOutput).toBe('[{"kind": "message"}]')
      expect(tool.status).toBe('ok')
    }
  })

  it('fills rawInput from tool_call_update when the initial tool_call seeds an empty input', async () => {
    // Claude Code emits the initial tool_call with an empty rawInput ({}), then supplies the real
    // arguments on the following tool_call_update — mirror that so input is not lost.
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          _meta: { claudeCode: { toolName: 'Bash' } },
          title: 'Terminal',
          rawInput: {}
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          rawInput: { command: 'python3 -c "import host; host.read_turn()"' },
          rawOutput: '[block-0]',
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    const tool = log.find((e) => e.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      // The real command from the update wins over the empty {} seeded by the initial tool_call.
      expect(tool.rawInput).toBe(
        JSON.stringify({ command: 'python3 -c "import host; host.read_turn()"' })
      )
      expect(tool.rawInput).not.toBe('{}')
    }
  })

  it('serializes an object rawOutput as JSON, not "[object Object]"', async () => {
    // A non-terminal tool (e.g. submit_findings) returns an object rawOutput with no terminal meta.
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-submit',
          _meta: { claudeCode: { toolName: 'mcp__open-science-reviewer__submit_findings' } },
          title: 'submit_findings',
          rawInput: { checks: [{ status: 'pass' }] }
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-submit',
          rawOutput: { ok: true, received: 4 },
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    const tool = log.find((e) => e.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.rawOutput).toBe(JSON.stringify({ ok: true, received: 4 }))
      expect(tool.rawOutput).not.toContain('[object Object]')
    }
  })

  it('bounds structured tool output before serializing the display string', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-structured-budget',
          toolName: 'query_execution_log'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-structured-budget',
          rawOutput: { rows: Array.from({ length: 201 }, (_, index) => index) },
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const options = {
      timeoutMs: 1000,
      maxUpdates: 100,
      logLimits: {
        maxTextEntryBytes: 64,
        maxToolInputBytes: 4096,
        maxToolOutputBytes: 4096,
        maxLogBytes: 8192
      }
    }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(session, options, { onUpdate: (entry) => log.push(entry) })

    const tool = log[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind !== 'tool') return
    const output = JSON.parse(tool.rawOutput ?? '{}') as { rows?: unknown[] }
    expect(output.rows).toHaveLength(201)
    expect(output.rows?.at(-1)).toBe('[omitted: 1 array entries]')
    expect(tool.rawOutputTruncated).toBe(true)
  })

  it('stops traversing structured tool output after its shared byte budget is exhausted', async () => {
    const rawOutput: Record<string, unknown> = { first: 'x'.repeat(1024) }
    Object.defineProperty(rawOutput, 'unvisited', {
      enumerable: true,
      get: () => {
        throw new Error('structured serializer traversed beyond its byte budget')
      }
    })
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-structured-shared-budget',
          toolName: 'query_execution_log'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-structured-shared-budget',
          rawOutput,
          status: 'completed'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
    const log: ReviewerLogEntry[] = []

    await driveReviewerToStop(
      session,
      {
        timeoutMs: 1000,
        maxUpdates: 100,
        logLimits: {
          maxTextEntryBytes: 64,
          maxToolInputBytes: 64,
          maxToolOutputBytes: 64,
          maxLogBytes: 512
        }
      },
      { onUpdate: (entry) => log.push(entry) }
    )

    const tool = log[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind !== 'tool') return
    expect(Buffer.byteLength(tool.rawOutput ?? '', 'utf8')).toBeLessThanOrEqual(64)
    expect(tool.rawOutputTruncated).toBe(true)
  })

  it.each(['completed', 'failed', 'error', 'ok'])(
    'forgets a tool after terminal status %s',
    async (status) => {
      const updates: FakeUpdate[] = [
        {
          kind: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-reused',
            toolName: 'Bash'
          }
        },
        {
          kind: 'session_update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-reused',
            rawOutput: 'first',
            status
          }
        },
        {
          kind: 'session_update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-reused',
            toolName: 'Bash',
            rawOutput: 'late duplicate',
            status: 'completed'
          }
        },
        { kind: 'stop', stopReason: 'end_turn' }
      ]
      let i = 0
      const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }
      const log: ReviewerLogEntry[] = []

      await driveReviewerToStop(
        session,
        { timeoutMs: 1000, maxUpdates: 100 },
        { onUpdate: (entry) => log.push(entry) }
      )

      expect(log.filter((entry) => entry.kind === 'tool')).toHaveLength(2)
    }
  )

  it('merges terminal stdout and exit code from _meta.terminal_output / _meta.terminal_exit', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-bash',
          _meta: { claudeCode: { toolName: 'Bash' } },
          title: 'wc -l cohort.csv',
          rawInput: 'wc -l cohort.csv'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-bash',
          status: 'completed',
          _meta: {
            terminal_output: { data: '8904 cohort.csv' },
            terminal_exit: { exit_code: 0 }
          }
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    const toolEntries = log.filter((e) => e.kind === 'tool')
    expect(toolEntries).toHaveLength(1)
    const tool = toolEntries[0]
    if (tool?.kind === 'tool') {
      expect(tool.rawOutput).toBe('8904 cohort.csv')
      expect(tool.exitCode).toBe(0)
      expect(tool.status).toBe('ok')
    }
  })

  it('normalizes ACP "failed" status to "error" and "completed" to "ok"', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-err',
          _meta: { claudeCode: { toolName: 'Bash' } },
          rawInput: 'python3 bad.py'
        }
      },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-err',
          status: 'failed',
          _meta: {
            terminal_output: { data: 'SyntaxError: bad syntax' },
            terminal_exit: { exit_code: 1 }
          }
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    await driveReviewerToStop(
      session,
      { timeoutMs: 1000, maxUpdates: 100 },
      { onUpdate: (u) => log.push(u) }
    )

    const tool = log.find((e) => e.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.status).toBe('error')
      expect(tool.exitCode).toBe(1)
    }
  })

  it('does not add chunk updates to the discrete update count (loop guard preserved)', async () => {
    // 50 streaming chunks followed by a stop — maxUpdates is only 5 discrete updates.
    const chunkKinds = ['agent_message_chunk', 'agent_thought_chunk']
    const updates: FakeUpdate[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        kind: 'session_update' as const,
        update: { sessionUpdate: chunkKinds[i % chunkKinds.length] as string }
      })),
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    // Should not throw even though maxUpdates=5 and there are 50 chunks.
    await expect(
      driveReviewerToStop(
        session,
        { timeoutMs: 5000, maxUpdates: 5 },
        { onUpdate: (u) => log.push(u) }
      )
    ).resolves.toBe('end_turn')
  })

  it('works without onUpdate (backward-compatible: no callback = no log)', async () => {
    const updates: FakeUpdate[] = [
      { kind: 'session_update', update: { sessionUpdate: 'tool_call' } },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    // Should not throw when no onUpdate is passed.
    await expect(driveReviewerToStop(session, { timeoutMs: 1000, maxUpdates: 100 })).resolves.toBe(
      'end_turn'
    )
  })

  it('handles orphan tool_call_update with no prior tool_call (defensive)', async () => {
    const updates: FakeUpdate[] = [
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-orphan',
          _meta: { claudeCode: { toolName: 'Bash' } },
          status: 'completed',
          _meta2: undefined,
          rawOutput: 'result'
        }
      },
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    const log: ReviewerLogEntry[] = []
    // Should not crash; should produce a tool entry defensively.
    await expect(
      driveReviewerToStop(
        session,
        { timeoutMs: 1000, maxUpdates: 100 },
        { onUpdate: (u) => log.push(u) }
      )
    ).resolves.toBe('end_turn')

    const toolEntries = log.filter((e) => e.kind === 'tool')
    expect(toolEntries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Repository round-trip for reviewerLog
// ---------------------------------------------------------------------------

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-log-capture-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('ReviewRepository — reviewerLog round-trip', () => {
  it('persists a unified-tool reviewerLog and reloads it via getReviewsForSession', async () => {
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const log: ReviewerLogEntry[] = [
      { kind: 'thought', text: 'Let me read the turn first.' },
      {
        kind: 'tool',
        toolName: 'Bash',
        title: 'python3 host.read_turn()',
        rawInput: 'python3 host.read_turn()',
        rawOutput: '[block-0]',
        rawOutputTruncated: true,
        reviewLogTruncated: true,
        status: 'ok',
        exitCode: 0
      },
      { kind: 'message', text: 'Review complete.' },
      {
        kind: 'tool',
        toolName: 'review_coverage',
        rawOutput: JSON.stringify({
          turnRead: true,
          artifactReads: [
            {
              versionId: 'source-v1',
              role: 'source_document',
              traceRead: true,
              contentRead: true,
              mediaRead: false,
              requestedTargets: [{ pages: [4] }],
              actualTargets: [{ pages: [4] }],
              partial: false,
              limitations: []
            },
            {
              versionId: 'source-unavailable',
              role: 'source_document',
              traceRead: false,
              contentRead: true,
              mediaRead: false,
              requestedTargets: [{ pages: [1] }],
              actualTargets: [],
              partial: true,
              limitations: [
                {
                  kind: 'content-missing',
                  subjectId: 'source-unavailable',
                  detail: 'Source content missing from immutable storage'
                }
              ]
            },
            {
              versionId: 'source-sheet',
              role: 'source_document',
              traceRead: false,
              contentRead: true,
              mediaRead: false,
              requestedTargets: [
                { sheet: 'Results', rowStart: 100, rowEnd: 120, columns: ['D', 'E'] }
              ],
              actualTargets: [],
              partial: true,
              limitations: [
                {
                  kind: 'budget-exhausted',
                  subjectId: 'source-sheet',
                  detail: 'Reviewer session budget exhausted'
                }
              ]
            }
          ]
        }),
        status: 'ok'
      }
    ]

    await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'msg-1',
      scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
      lifecycle: 'complete',
      outcome: 'pass',
      model: 'claude-opus-4-5',
      reviewerLog: log
    })

    const reviews = await repository.getReviewsForSession('session-1')
    expect(reviews).toHaveLength(1)
    const reloaded = reviews[0]!
    expect(reloaded.reviewerLog).toHaveLength(4)
    expect(reloaded.reviewerLog[0]).toEqual({
      kind: 'thought',
      text: 'Let me read the turn first.'
    })
    expect(reloaded.reviewerLog[1]).toEqual({
      kind: 'tool',
      toolName: 'Bash',
      title: 'python3 host.read_turn()',
      rawInput: 'python3 host.read_turn()',
      rawOutput: '[block-0]',
      rawOutputTruncated: true,
      reviewLogTruncated: true,
      status: 'ok',
      exitCode: 0
    })
    expect(reloaded.reviewerLog[2]).toEqual({ kind: 'message', text: 'Review complete.' })
    expect(
      JSON.parse(
        reloaded.reviewerLog[3]?.kind === 'tool' ? reloaded.reviewerLog[3].rawOutput! : '{}'
      )
    ).toMatchObject({
      artifactReads: expect.arrayContaining([
        expect.objectContaining({
          versionId: 'source-v1',
          role: 'source_document',
          mediaRead: false
        }),
        expect.objectContaining({
          versionId: 'source-unavailable',
          requestedTargets: [{ pages: [1] }],
          actualTargets: [],
          limitations: [expect.objectContaining({ kind: 'content-missing' })]
        }),
        expect.objectContaining({
          versionId: 'source-sheet',
          requestedTargets: [{ sheet: 'Results', rowStart: 100, rowEnd: 120, columns: ['D', 'E'] }],
          actualTargets: [],
          limitations: [expect.objectContaining({ kind: 'budget-exhausted' })]
        })
      ])
    })

    await client.$disconnect()
  })

  it('tolerates legacy/unknown entry kinds in the persisted JSON without throwing', async () => {
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    // Simulate a legacy log that still uses the old tool_call/tool_result split (or unknown kind).
    // The repository parses defensively; unknown kinds should be returned as-is (no crash).
    const legacyLog = [
      { kind: 'thought', text: 'old thought' },
      { kind: 'tool_call', toolName: 'read_turn', title: 'read_turn()' }, // legacy
      { kind: 'tool_result', status: 'ok', rawOutput: '[...]' }, // legacy
      { kind: 'unknown_future_kind', data: 'whatever' } // unknown
    ]

    // Insert as raw JSON bypassing the typed API to simulate legacy data.
    await client.review.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-legacy',
        turnMessageId: 'msg-1',
        scope: JSON.stringify({ turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] }),
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test',
        reviewerLog: JSON.stringify(legacyLog)
      }
    })

    // Must not throw on reload.
    const reviews = await repository.getReviewsForSession('session-legacy')
    expect(reviews).toHaveLength(1)
    // The legacy entries are returned as-is (parseJson just returns the raw array).
    expect(reviews[0]?.reviewerLog).toHaveLength(4)

    await client.$disconnect()
  })

  it('returns an empty reviewerLog for reviews created without one', async () => {
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'msg-1',
      scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
      model: 'test'
    })

    const reviews = await repository.getReviewsForSession('session-1')
    expect(reviews[0]?.reviewerLog).toEqual([])

    await client.$disconnect()
  })

  it('persists a reviewerLog via updateReview patch', async () => {
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const created = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'msg-1',
      scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
      model: 'test'
    })

    const log: ReviewerLogEntry[] = [{ kind: 'thought', text: 'Updated thought.' }]

    await repository.updateReview(created.id, {
      reviewerLog: log,
      lifecycle: 'complete',
      outcome: 'pass'
    })

    const reviews = await repository.getReviewsForSession('session-1')
    expect(reviews[0]?.reviewerLog).toHaveLength(1)
    expect(reviews[0]?.reviewerLog[0]?.kind).toBe('thought')

    await client.$disconnect()
  })

  it('Review no longer has a reasoning field', async () => {
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'msg-1',
      scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
      model: 'test'
    })

    // reasoning field should not exist on Review
    expect('reasoning' in review).toBe(false)

    await client.$disconnect()
  })
})
