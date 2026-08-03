import { describe, expect, it } from 'vitest'

import { createWebCallerContext } from '../caller-context'
import { createRendererFailureReporter } from '../renderer-diagnostics'
import type { Logger } from '../logger'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'
import { startDiagnosticOperation } from './operation'

const PRIVACY_CANARIES = [
  'sk-diagnostic-secret',
  'Authorization: Bearer diagnostic-token',
  '/Users/example/private-study/patient.csv',
  'C:\\Users\\example\\private-study\\patient.csv',
  'private prompt marker',
  'private provider response marker',
  'https://example.test/file?token=diagnostic-token'
] as const

const createCapturingLogger = (): { log: Logger; records: unknown[] } => {
  const records: unknown[] = []
  const capture = (message: string, data?: unknown): void => {
    records.push({ message, data })
  }
  return {
    log: { debug: capture, info: capture, warn: capture, error: capture },
    records
  }
}

describe('shared diagnostic privacy canary', () => {
  it('keeps raw failures and request/report payloads out of every shared boundary', async () => {
    const { log, records } = createCapturingLogger()
    const privateText = PRIVACY_CANARIES.join(' | ')
    const privateError = Object.assign(new Error(privateText), {
      code: 'EACCES',
      data: { prompt: privateText },
      path: PRIVACY_CANARIES[2]
    })

    for (const operationName of [
      'application-startup',
      'data-root-copy',
      'data-root-commit',
      'update-check',
      'application-shutdown'
    ]) {
      startDiagnosticOperation(log, { operation: operationName }).fail(privateError)
    }

    await expect(
      invokeWithIpcRejectionDiagnostics({
        channel: 'projects:list',
        callerContext: createWebCallerContext('private-client'),
        invoke: async () => {
          void privateText
          throw privateError
        },
        log
      })
    ).rejects.toBe(privateError)

    const reporter = createRendererFailureReporter({ log })
    reporter.report('private-sender', {
      source: 'window-error',
      surface: 'workspace',
      errorCategory: 'error',
      message: privateText
    })

    const serialized = JSON.stringify(records)
    for (const canary of PRIVACY_CANARIES) expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('private-client')
    expect(serialized).not.toContain('private-sender')
  })
})
