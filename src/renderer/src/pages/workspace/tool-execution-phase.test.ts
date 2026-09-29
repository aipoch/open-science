import { describe, expect, it } from 'vitest'

import type { SessionPermissionRuntimeContext } from '../../../../shared/session-persistence'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ToolActivity } from '@/stores/session-store'
import { getToolExecutionPhase } from './tool-execution-phase'

const activity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'mcp__open-science-notebook__notebook_execute',
  providerToolName: 'mcp__open-science-notebook__notebook_execute',
  promptMessageId: 'prompt-1',
  status: 'in_progress',
  eventIds: ['event-1'],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const permission = (
  overrides: Partial<SessionPermissionRuntimeContext> = {}
): SessionPermissionRuntimeContext => ({
  state: 'pending',
  request: {
    requestId: 'permission-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'Run code',
    options: []
  },
  originatingPromptMessageId: 'prompt-1',
  fingerprint: 'fingerprint-1',
  createdAt: 1,
  ...overrides
})

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  executionInvocationId: 'invocation-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'running',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

describe('getToolExecutionPhase', () => {
  it.each([
    [{ status: 'failed', errorCode: 'shell-start-failed', exitCode: null }, 'failed'],
    [{ status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 7 }, 'failed'],
    [{ status: 'completed', exitCode: 0, stderr: 'warning' }, 'completed']
  ] as const)(
    'restores an unhydrated Shell result from its structured outcome %#',
    (result, phase) => {
      const shellActivity = activity({
        title: 'mcp__open-science-notebook__bash_execute',
        providerToolName: 'mcp__open-science-notebook__bash_execute',
        status: phase === 'failed' ? 'failed' : 'completed',
        rawOutput: { structuredContent: result }
      })

      expect(getToolExecutionPhase(shellActivity, undefined)).toBe(phase)
    }
  )

  it.each([
    [{ status: 'timeout', exitCode: null }, 'limit-reached'],
    [{ status: 'cancelled', exitCode: null }, 'cancelled'],
    [{ status: 'interrupted', exitCode: null }, 'interrupted'],
    [{ status: 'queued', runId: 'shell-background' }, 'executing'],
    [{ status: 'running', runId: 'shell-background' }, 'executing'],
    [{ status: 'failed', execution: 'unknown', error: 'Shell request failed.' }, 'failed']
  ] as const)('restores the actual Shell result %j without a hydrated Run', (result, phase) => {
    const shellActivity = activity({
      title: 'mcp__open-science-notebook__bash_execute',
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      status: 'completed',
      rawOutput: { structuredContent: result }
    })
    expect(getToolExecutionPhase(shellActivity, undefined)).toBe(phase)
  })

  it('does not restore a Shell phase from observer status, stderr, or an unrelated query result', () => {
    const shellActivity = activity({
      title: 'mcp__open-science-notebook__bash_execute',
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      status: 'failed',
      rawOutput: { stderr: 'permission denied' }
    })
    expect(getToolExecutionPhase(shellActivity, undefined)).toBe('prepared')
    expect(
      getToolExecutionPhase(
        { ...shellActivity, rawOutput: { status: 'failed', exitCode: null } },
        undefined
      )
    ).toBe('prepared')
    expect(
      getToolExecutionPhase(
        {
          ...shellActivity,
          rawOutput: { status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 0 }
        },
        undefined
      )
    ).toBe('prepared')
    expect(
      getToolExecutionPhase(
        {
          ...shellActivity,
          providerToolName: 'mcp__other-server__bash_execute',
          status: 'completed',
          rawOutput: { status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 7 }
        },
        undefined
      )
    ).toBe('prepared')

    const queriedFailedRun = activity({
      title: 'mcp__open-science-notebook__notebook_state',
      providerToolName: 'mcp__open-science-notebook__notebook_state',
      status: 'completed',
      rawOutput: {
        structuredContent: { status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 7 }
      }
    })
    expect(getToolExecutionPhase(queriedFailedRun, undefined)).toBe('completed')
  })

  it('keeps a hydrated Shell Run authoritative over a contradictory compact tool result', () => {
    const shellActivity = activity({
      title: 'mcp__open-science-notebook__bash_execute',
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      executionInvocationId: 'invocation-1',
      status: 'failed',
      rawOutput: { status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 7 }
    })
    const runs = new Map([['run-1', run({ kernelKind: 'bash', status: 'completed', exitCode: 0 })]])

    expect(getToolExecutionPhase(shellActivity, undefined, runs)).toBe('completed')
  })

  it('reads a nested Codex MCP result envelope without parsing stream text as JSON', () => {
    const shellActivity = activity({
      title: 'mcp__open-science-notebook__bash_execute',
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      status: 'completed',
      rawOutput: {
        result: {
          content: [{ type: 'text', text: 'Shell command exited with code 7.' }],
          structuredContent: {
            status: 'failed',
            errorCode: 'shell-nonzero-exit',
            exitCode: 7,
            stderr: '{"status":"completed","exitCode":0}'
          }
        }
      }
    })

    expect(getToolExecutionPhase(shellActivity, undefined)).toBe('failed')
  })

  it('separates prepared code from a matching durable approval wait', () => {
    expect(getToolExecutionPhase(activity(), undefined)).toBe('prepared')
    expect(getToolExecutionPhase(activity(), permission())).toBe('awaiting-approval')
  })

  it('moves one approved Notebook activity from approval preview into Run execution', () => {
    const authorizedActivity = activity({ executionInvocationId: 'invocation-1' })

    expect([
      getToolExecutionPhase(activity(), permission()),
      getToolExecutionPhase(authorizedActivity, undefined),
      getToolExecutionPhase(
        authorizedActivity,
        undefined,
        new Map([['run-1', run({ status: 'running' })]])
      ),
      getToolExecutionPhase(
        authorizedActivity,
        undefined,
        new Map([['run-1', run({ status: 'completed', endedAt: 2 })]])
      )
    ]).toEqual(['awaiting-approval', 'prepared', 'executing', 'completed'])
  })

  it('skips approval preview when Notebook execution is already authorized', () => {
    const authorizedActivity = activity({ executionInvocationId: 'invocation-1' })

    expect([
      getToolExecutionPhase(authorizedActivity, undefined),
      getToolExecutionPhase(
        authorizedActivity,
        undefined,
        new Map([['run-1', run({ status: 'running' })]])
      )
    ]).toEqual(['prepared', 'executing'])
  })

  it('fails closed when permission identity does not match the active activity', () => {
    expect(
      getToolExecutionPhase(
        activity(),
        permission({ request: { ...permission().request, toolCallId: 'other-tool' } })
      )
    ).toBe('prepared')
    expect(
      getToolExecutionPhase(activity(), permission({ originatingPromptMessageId: 'other-prompt' }))
    ).toBe('prepared')
  })

  it('keeps explicit rejection and permission closure distinct from observer failure', () => {
    expect(
      getToolExecutionPhase(
        activity({ status: 'completed', toolDisposition: 'declined' }),
        undefined
      )
    ).toBe('declined')
    expect(
      getToolExecutionPhase(
        activity({ status: 'in_progress', toolDisposition: 'permission-closed' }),
        undefined
      )
    ).toBe('prepared')
    expect(getToolExecutionPhase(activity({ status: 'failed' }), undefined)).toBe('prepared')
  })

  it('closes an ordinary tool row when its permission settles without execution', () => {
    expect(
      getToolExecutionPhase(
        activity({
          title: 'Run shell command',
          providerToolName: 'Bash',
          toolDisposition: 'permission-closed'
        }),
        undefined
      )
    ).toBe('closed')
  })

  it('requires an exact app-owned invocation identity before showing Notebook execution', () => {
    const runs = new Map([['run-1', run()]])
    expect(getToolExecutionPhase(activity({ status: 'completed' }), undefined, runs)).toBe(
      'prepared'
    )
    expect(
      getToolExecutionPhase(activity({ executionInvocationId: 'invocation-1' }), undefined, runs)
    ).toBe('executing')
    expect(
      getToolExecutionPhase(
        activity({ status: 'completed', executionInvocationId: 'stale-invocation' }),
        undefined,
        runs
      )
    ).toBe('prepared')
  })

  it.each(['Claude Code', 'OpenCode', 'Codex Responses', 'Codex Bridge'])(
    'does not let a %s observer limit terminate or relabel an admitted Run',
    () => {
      const runs = new Map([['run-1', run()]])
      expect(
        getToolExecutionPhase(
          activity({ status: 'failed', executionInvocationId: 'invocation-1' }),
          undefined,
          runs
        )
      ).toBe('executing')

      runs.set('run-1', run({ status: 'completed', endedAt: 2 }))
      expect(
        getToolExecutionPhase(
          activity({ status: 'failed', executionInvocationId: 'invocation-1' }),
          undefined,
          runs
        )
      ).toBe('completed')
    }
  )

  it.each([
    ['failed', 'failed'],
    ['timeout', 'limit-reached'],
    ['interrupted', 'interrupted'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed']
  ] as const)('preserves the correlated Run terminal status %s', (status, phase) => {
    const runs = new Map([['run-1', run({ status, endedAt: 2 })]])

    expect(
      getToolExecutionPhase(
        activity({ status: 'completed', executionInvocationId: 'invocation-1' }),
        undefined,
        runs
      )
    ).toBe(phase)
  })

  it.each([
    ['failed', 'failed'],
    ['timeout', 'limit-reached'],
    ['interrupted', 'interrupted'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed']
  ] as const)(
    'restores the compact historical Run terminal status %s outside the hydrated window',
    (status, phase) => {
      const historicalActivity = activity({
        status: 'completed',
        executionInvocationId: 'invocation-old',
        toolContent: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: JSON.stringify({
                runId: 'run-old',
                executionInvocationId: 'invocation-old',
                status
              })
            }
          }
        ]
      })

      expect(getToolExecutionPhase(historicalActivity, undefined)).toBe(phase)
      expect(
        getToolExecutionPhase(
          { ...historicalActivity, executionInvocationId: undefined },
          undefined
        )
      ).toBe('prepared')
    }
  )

  it('fails closed when the compact Run result belongs to another invocation', () => {
    expect(
      getToolExecutionPhase(
        activity({
          status: 'completed',
          executionInvocationId: 'invocation-current',
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify({
                  runId: 'run-stale',
                  executionInvocationId: 'invocation-stale',
                  status: 'completed'
                })
              }
            }
          ]
        }),
        undefined
      )
    ).toBe('prepared')
  })
})
