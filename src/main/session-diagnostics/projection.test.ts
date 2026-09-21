import { describe, expect, it } from 'vitest'
import { projectDiagnosticLog } from './projection'

describe('diagnostic log event projection', () => {
  it.each([
    'app starting',
    'operation failed',
    'database startup blocked',
    'renderer process gone',
    'child process gone',
    'renderer became unresponsive',
    'renderer became responsive',
    'renderer preload failed'
  ])('preserves the fixed event %s without process names or error text', (event) => {
    expect(
      projectDiagnosticLog({
        msg: event,
        data: {
          reason: 'oom',
          exitCode: 9,
          wasUnresponsive: true,
          unresponsiveDurationMs: 123,
          name: 'private-process-name',
          serviceName: 'private-service',
          error: { message: 'private-error', stack: 'private-stack' }
        }
      })
    ).toEqual({
      event,
      diagnostics: {
        reason: 'oom',
        exitCode: 9,
        wasUnresponsive: true,
        unresponsiveDurationMs: 123
      }
    })
  })
})

it.each([
  ['operation started', 'started'],
  ['operation phase', undefined],
  ['operation completed', 'completed'],
  ['operation failed', 'failed']
])('retains safe hydration details for %s', (event, outcome) => {
  expect(
    projectDiagnosticLog({
      msg: event,
      data: {
        operation: 'session-hydration',
        operationId: 'op-1',
        phase: 'load-authority',
        outcome,
        mode: 'reconcile',
        status: 'failed',
        errorCategory: 'permission',
        hydrationAvailable: false,
        sessionCount: 2,
        warningCount: 1,
        projectDirectoryCount: 1,
        sessionBytes: 1024,
        phaseDurationMs: 30,
        error: { message: 'PRIVATE_ERROR', stack: 'PRIVATE_STACK' },
        name: 'PRIVATE_NAME',
        path: '/PRIVATE_PATH'
      }
    })
  ).toEqual({
    event,
    diagnostics: {
      status: 'failed',
      operationId: 'op-1',
      operation: 'session-hydration',
      phase: 'load-authority',
      ...(outcome ? { outcome } : {}),
      mode: 'reconcile',
      errorCategory: 'permission',
      hydrationAvailable: false,
      sessionCount: 2,
      warningCount: 1,
      projectDirectoryCount: 1,
      sessionBytes: 1024,
      phaseDurationMs: 30
    }
  })
})

it('omits unrecognized operation vocabulary instead of passing through private text', () => {
  expect(
    projectDiagnosticLog({
      msg: 'PRIVATE_EVENT',
      data: {
        reason: 'private-reason',
        error: { message: 'private-error' },
        operation: 'PRIVATE_OPERATION',
        phase: '/PRIVATE_PATH',
        outcome: 'PRIVATE_OUTCOME',
        errorCategory: 'PRIVATE_ERROR',
        sessionCount: 'PRIVATE_COUNT',
        hydrationAvailable: 'PRIVATE_BOOL'
      }
    })
  ).toEqual({})
})
