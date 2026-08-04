import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { initializeApplicationDiagnostics, reportApplicationStartupFailure } from './startup'

let logDir: string | undefined

afterEach(async () => {
  if (logDir) await rm(logDir, { recursive: true, force: true })
  logDir = undefined
})

describe('application startup diagnostics integration', () => {
  it('flushes the last startup phase to JSONL without retaining the original failure', async () => {
    logDir = await mkdtemp(join(tmpdir(), 'os-startup-diagnostics-'))
    const diagnostics = initializeApplicationDiagnostics({
      logDir,
      runId: 'startup-run',
      mirrorToConsole: false,
      version: '1.2.3',
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      electronVersion: '38.0.0',
      nodeVersion: '22.0.0'
    })
    diagnostics.operation.phase('electron-ready')
    const failure = Object.assign(
      new Error('failed at /Users/example/private-study/patient.csv?token=diagnostic-token'),
      { code: 'EACCES', data: { prompt: 'private prompt marker' } }
    )

    await expect(
      reportApplicationStartupFailure({
        operation: diagnostics.operation,
        error: failure,
        flush: diagnostics.flush,
        timeoutMs: 1_000
      })
    ).resolves.toBe('flushed')

    const jsonl = await readFile(join(logDir, 'main.log'), 'utf8')
    const records = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.length).toBeGreaterThanOrEqual(4)
    expect(new Set(records.map((record) => record.runId))).toEqual(new Set(['startup-run']))
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        scope: 'main',
        msg: 'operation failed',
        data: expect.objectContaining({
          operation: 'application-startup',
          phase: 'electron-ready',
          outcome: 'failed',
          errorCategory: 'permission'
        })
      })
    )
    expect(jsonl).not.toContain('patient.csv')
    expect(jsonl).not.toContain('diagnostic-token')
    expect(jsonl).not.toContain('private prompt marker')
  })
})
