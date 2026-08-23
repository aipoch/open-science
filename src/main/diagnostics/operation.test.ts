import { describe, expect, it } from 'vitest'

import type { Logger } from '../logger'
import {
  type DiagnosticFields,
  type DiagnosticOperationInput,
  startDiagnosticOperation
} from './operation'

type CapturedRecord = {
  level: keyof Logger
  message: string
  data: unknown
}

const createRecordingLogger = (): { logger: Logger; records: CapturedRecord[] } => {
  const records: CapturedRecord[] = []
  const capture =
    (level: keyof Logger) =>
    (message: string, data?: unknown): void => {
      records.push({ level, message, data })
    }

  return {
    logger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error')
    },
    records
  }
}

describe('diagnostic operation', () => {
  it('starts once with a stable operation ID and scalar context', () => {
    const { logger, records } = createRecordingLogger()

    startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy', retry: false }
    })

    expect(records).toEqual([
      {
        level: 'info',
        message: 'operation started',
        data: {
          source: 'legacy',
          retry: false,
          operation: 'data-root-migration',
          operationId: 'migration-1',
          outcome: 'started'
        }
      }
    ])
  })

  it('records a phase with the operation context', () => {
    const { logger, records } = createRecordingLogger()
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy' },
      now: () => 0
    })

    operation.phase('copy', { filesCopied: 3 })

    expect(records[1]).toEqual({
      level: 'info',
      message: 'operation phase',
      data: {
        source: 'legacy',
        filesCopied: 3,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'copy',
        elapsedMs: 0,
        phaseDurationMs: 0
      }
    })
  })

  it('records cumulative and previous-phase duration for every phase', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 100
    const operation = startDiagnosticOperation(logger, {
      operation: 'application-startup',
      operationId: 'startup-1',
      now: () => timestamp
    })

    timestamp = 125
    operation.phase('database-startup')
    timestamp = 170
    operation.phase('compose-runtime')

    expect(records[1]).toMatchObject({
      data: { phase: 'database-startup', elapsedMs: 25, phaseDurationMs: 25 }
    })
    expect(records[2]).toMatchObject({
      data: { phase: 'compose-runtime', elapsedMs: 70, phaseDurationMs: 45 }
    })
  })

  it('classifies a long off-CPU phase as io-or-wait', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 0
    const cpuSamples = [
      { user: 1_000, system: 0 },
      { user: 2_000, system: 0 }
    ]
    const operation = startDiagnosticOperation(logger, {
      operation: 'application-composition',
      operationId: 'compose-1',
      now: () => timestamp,
      cpuUsage: () => cpuSamples.shift() ?? { user: 2_000, system: 0 }
    })
    timestamp = 120_000
    operation.phase('specialist-catalog')

    expect(records[1]).toMatchObject({
      data: {
        phase: 'specialist-catalog',
        phaseDurationMs: 120_000,
        phaseCpuTotalMs: 1,
        phaseWaitMs: 119_999,
        delayKind: 'io-or-wait'
      }
    })
  })

  it('records opt-in cumulative and phase CPU deltas without changing default diagnostics', () => {
    const { logger, records } = createRecordingLogger()
    const cpuSamples = [
      { user: 1_000, system: 500 },
      { user: 4_000, system: 1_500 },
      { user: 7_500, system: 2_000 }
    ]
    const operation = startDiagnosticOperation(logger, {
      operation: 'session-hydration',
      operationId: 'session-1',
      now: () => 0,
      cpuUsage: () => cpuSamples.shift() ?? { user: 0, system: 0 }
    })

    operation.phase('load-authority')
    operation.complete()

    expect(records[1]).toMatchObject({
      data: {
        phase: 'load-authority',
        cpuIntervalPhase: 'operation-start',
        cpuUserMs: 3,
        cpuSystemMs: 1,
        cpuTotalMs: 4,
        phaseCpuUserMs: 3,
        phaseCpuSystemMs: 1,
        phaseCpuTotalMs: 4
      }
    })
    expect(records[2]).toMatchObject({
      data: {
        phase: 'load-authority',
        cpuIntervalPhase: 'load-authority',
        cpuUserMs: 6.5,
        cpuSystemMs: 1.5,
        cpuTotalMs: 8,
        phaseCpuUserMs: 3.5,
        phaseCpuSystemMs: 0.5,
        phaseCpuTotalMs: 4
      }
    })
  })

  it('completes with duration and the latest phase', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 100
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy' },
      now: () => timestamp
    })
    operation.phase('verify-target')

    timestamp = 145
    operation.complete({ filesCopied: 3 })

    expect(records[2]).toEqual({
      level: 'info',
      message: 'operation completed',
      data: {
        source: 'legacy',
        filesCopied: 3,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'verify-target',
        outcome: 'completed',
        durationMs: 45
      }
    })
  })

  it('fails with a coarse error category and no raw error payload', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 10
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      now: () => timestamp
    })
    operation.phase('copy')

    timestamp = 34
    operation.fail(
      Object.assign(new Error('secret target path'), {
        code: 'EACCES',
        path: '/private/secret'
      }),
      { recoverable: true }
    )

    expect(records[2]).toEqual({
      level: 'error',
      message: 'operation failed',
      data: {
        recoverable: true,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'copy',
        outcome: 'failed',
        durationMs: 24,
        errorCategory: 'permission'
      }
    })
    expect(JSON.stringify(records[2])).not.toContain('secret')
  })

  it('emits at most one terminal record and ignores every call after it', () => {
    const { logger, records } = createRecordingLogger()
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-check',
      operationId: 'update-1',
      now: () => 10
    })

    operation.complete()
    operation.phase('late-phase')
    operation.complete()
    operation.cancel()
    operation.fail(new Error('late failure'))

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      message: 'operation completed',
      data: { outcome: 'completed' }
    })
  })

  it('records cancellation separately from failure', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 20
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-download',
      operationId: 'update-1',
      now: () => timestamp
    })
    operation.phase('download')

    timestamp = 32
    operation.cancel({ requestedByUser: true })

    expect(records[2]).toEqual({
      level: 'warn',
      message: 'operation cancelled',
      data: {
        requestedByUser: true,
        operation: 'update-download',
        operationId: 'update-1',
        phase: 'download',
        outcome: 'cancelled',
        durationMs: 12
      }
    })
  })

  it('keeps only scalar fields and protects diagnostic-owned fields', () => {
    const { logger, records } = createRecordingLogger()

    startDiagnosticOperation(logger, {
      operation: 'session-hydration',
      operationId: 'session-1',
      fields: {
        safe: 'kept',
        operation: 'spoofed',
        nested: { research: 'private' },
        list: ['private']
      } as unknown as DiagnosticFields
    })

    expect(records[0].data).toEqual({
      safe: 'kept',
      operation: 'session-hydration',
      operationId: 'session-1',
      outcome: 'started'
    })
  })

  it('sanitizes scalar fields supplied to phase and terminal calls', () => {
    const { logger, records } = createRecordingLogger()
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-check',
      operationId: 'update-1',
      now: () => 5
    })

    operation.phase('checking', {
      scalar: 1,
      phase: 'spoofed',
      nested: { secret: true }
    } as unknown as DiagnosticFields)
    operation.complete({
      result: true,
      outcome: 'spoofed',
      nested: { secret: true }
    } as unknown as DiagnosticFields)

    expect(records[1].data).toEqual({
      scalar: 1,
      operation: 'update-check',
      operationId: 'update-1',
      phase: 'checking',
      elapsedMs: 0,
      phaseDurationMs: 0
    })
    expect(records[2].data).toEqual({
      result: true,
      operation: 'update-check',
      operationId: 'update-1',
      phase: 'checking',
      outcome: 'completed',
      durationMs: 0
    })
  })

  it('never throws when the diagnostic clock or sink fails', () => {
    const throwFromSink = (): never => {
      throw new Error('sink unavailable')
    }
    const logger: Logger = {
      debug: throwFromSink,
      info: throwFromSink,
      warn: throwFromSink,
      error: throwFromSink
    }
    let operation: ReturnType<typeof startDiagnosticOperation> | undefined

    expect(() => {
      operation = startDiagnosticOperation(logger, {
        operation: 'startup',
        operationId: 'startup-1',
        now: () => {
          throw new Error('clock unavailable')
        }
      })
    }).not.toThrow()

    expect(() => operation?.phase('compose')).not.toThrow()
    expect(() => operation?.complete()).not.toThrow()
    expect(() => operation?.cancel()).not.toThrow()
    expect(() => operation?.fail(new Error('authoritative failure'))).not.toThrow()
  })

  it('never throws when the operation input has hostile property access', () => {
    const { logger } = createRecordingLogger()
    const hostileInput = new Proxy({} as DiagnosticOperationInput, {
      get() {
        throw new Error('input getter failed')
      }
    })
    let operation: ReturnType<typeof startDiagnosticOperation> | undefined

    expect(() => {
      operation = startDiagnosticOperation(logger, hostileInput)
    }).not.toThrow()
    expect(() => operation?.phase('fallback')).not.toThrow()
    expect(() => operation?.fail(new Error('original failure'))).not.toThrow()
  })
})
