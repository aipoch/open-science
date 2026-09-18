import { describe, expect, it } from 'vitest'

import { RepeatedToolFailureGuard } from './repeated-tool-failure-guard'

describe('RepeatedToolFailureGuard', () => {
  it('allows one correction before stopping the same MCP validation failure', () => {
    const guard = new RepeatedToolFailureGuard()
    const failure = {
      interactionSequence: 7,
      reason:
        'MCP error -32602: Input validation error: Invalid arguments for tool write_artifact_file',
      sessionId: 'session-1',
      tool: 'open-science-artifacts/write_artifact_file',
      toolCallId: 'call-1'
    }

    expect(guard.observe(failure)).toBe(false)
    expect(guard.observe(failure)).toBe(false)
    expect(guard.observe({ ...failure, toolCallId: 'call-2' })).toBe(true)
    expect(guard.observe({ ...failure, toolCallId: 'call-3' })).toBe(false)
  })

  it('resets the retry allowance for a new prompt interaction', () => {
    const guard = new RepeatedToolFailureGuard()
    const failure = {
      reason: 'MCP input validation failed.',
      sessionId: 'session-1',
      tool: 'open-science-artifacts/write_artifact_file'
    }

    expect(
      guard.observe({ ...failure, interactionSequence: 1, toolCallId: 'first-turn-call' })
    ).toBe(false)
    expect(
      guard.observe({ ...failure, interactionSequence: 2, toolCallId: 'second-turn-call-1' })
    ).toBe(false)
    expect(
      guard.observe({ ...failure, interactionSequence: 2, toolCallId: 'second-turn-call-2' })
    ).toBe(true)
  })

  it('does not stop ordinary tool failures or mix different tools', () => {
    const guard = new RepeatedToolFailureGuard()

    expect(
      guard.observe({
        interactionSequence: 1,
        reason: 'File not found.',
        sessionId: 'session-1',
        tool: 'open-science-artifacts/write_artifact_file',
        toolCallId: 'call-1'
      })
    ).toBe(false)
    expect(
      guard.observe({
        interactionSequence: 1,
        reason: 'MCP input validation failed.',
        sessionId: 'session-1',
        tool: 'open-science-notebook/notebook_execute',
        toolCallId: 'call-2'
      })
    ).toBe(false)
    expect(
      guard.observe({
        interactionSequence: 1,
        reason: 'MCP input validation failed.',
        sessionId: 'session-1',
        tool: 'open-science-artifacts/write_artifact_file',
        toolCallId: 'call-3'
      })
    ).toBe(false)
  })
})
