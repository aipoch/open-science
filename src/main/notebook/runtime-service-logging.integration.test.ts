import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { flushLogs, initLogger } from '../logger'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

let root: string | undefined

afterAll(async () => {
  await flushLogs()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('NotebookRuntimeService main-process logging', () => {
  it('writes bounded redacted installer diagnostics through the default main.log sink', async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-runtime-main-log-'))
    const logDir = join(root, 'logs')
    initLogger({ logDir, mirrorToConsole: false })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: {
        prepareRun: vi.fn(),
        captureCompletedRun: vi.fn(),
        inspectPackages: vi.fn(),
        markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
      },
      executorFactory: () => ({
        execute: async () => {
          throw new Error('not used')
        },
        shutdown: async () => ({ reaped: true })
      }),
      installPackagesImpl: vi.fn().mockResolvedValue({
        ok: true,
        needsRestart: true,
        method: 'conda',
        log:
          'FETCH https://user:password@example.test/channel?token=secret\n' +
          `${'x'.repeat(20_000)}\ntransaction-tail-marker`
      })
    })

    await service.managePackages({ language: 'r', packages: ['ggplot2'] })
    await flushLogs()

    const serialized = await readFile(join(logDir, 'main.log'), 'utf8')
    const record = serialized
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (candidate) =>
          candidate.scope === 'notebook:runtime' && candidate.msg === 'package installer completed'
      )
    expect(record).toMatchObject({
      level: 'info',
      scope: 'notebook:runtime',
      msg: 'package installer completed',
      data: {
        language: 'r',
        environmentName: 'default-r',
        packages: ['ggplot2'],
        installerLog: {
          truncated: true,
          text: expect.stringContaining('transaction-tail-marker')
        }
      }
    })
    expect(serialized).not.toContain('user:password')
    expect(serialized).not.toContain('token=secret')
  })
})
