import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeApplicationDiagnostics, reportApplicationStartupFailure } from './startup'

let logDir: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (logDir) await rm(logDir, { recursive: true, force: true })
  logDir = undefined
})

describe('application startup diagnostics integration', () => {
  it.each(['json', 'text', undefined] as const)(
    'applies console format %s before emitting startup records',
    async (consoleFormat) => {
      logDir = await mkdtemp(join(tmpdir(), 'os-startup-console-'))
      const mirror = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      const diagnostics = initializeApplicationDiagnostics({
        logDir,
        runId: 'console-startup',
        mirrorToConsole: true,
        consoleFormat,
        version: '1.2.3',
        isPackaged: true,
        platform: 'linux',
        arch: 'x64',
        nodeVersion: '24.0.0'
      })
      await diagnostics.flush()
      const lines = (await readFile(join(logDir, 'main.log'), 'utf8')).trimEnd().split('\n')
      expect(mirror).toHaveBeenCalledTimes(lines.length)
      for (const [index, line] of lines.entries()) {
        if (consoleFormat === 'json') expect(mirror.mock.calls[index]).toEqual([line])
        else {
          const record = JSON.parse(line)
          expect(mirror.mock.calls[index]).toEqual([`[${record.scope}] ${record.msg}`, record.data])
        }
      }
    }
  )

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
