import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExecuteShellRequest } from '../../shared/notebook'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { initializeWsl2BashPreview } from '../wsl/wsl2-preview-gate'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { NotebookRuntimeService } from './runtime-service'
import { getNotebookDataRoot } from './repository'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const enabled = process.platform === 'win32' && Boolean(distro && user)

// Exercise the production scheduler, repository, process adapter and WSL sandbox together.
// Only Settings and network-consent callbacks are fixtures; no guest process is simulated.
describe.runIf(enabled)('WSL2 real Notebook scheduling', () => {
  let root = ''
  let workspace = ''
  let sandbox: NotebookNetworkSandboxOwner | undefined
  let service: NotebookRuntimeService | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-wsl-scheduler-'))
    workspace = join(root, 'workspace')
    const manifestRoot = join(root, 'resources', 'notebook-network-sandbox', 'wsl2')
    await Promise.all([mkdir(workspace), mkdir(manifestRoot, { recursive: true })])
    await copyFile(
      join(process.cwd(), 'packages/notebook-network-sandbox/vendor/wsl2/manifest.json'),
      join(manifestRoot, 'manifest.json')
    )
    initializeWsl2BashPreview({
      platform: 'win32',
      arch: 'x64',
      packaged: true,
      resourcesPath: join(root, 'resources')
    })
    sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getParentProxy: async () => undefined,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
  })

  afterEach(async () => {
    try {
      if (service) expect(await service.dispose()).toEqual({ reaped: true })
    } finally {
      service = undefined
      await sandbox?.dispose()
      sandbox = undefined
      initializeWsl2BashPreview({ platform: 'win32', arch: 'x64', packaged: false })
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 30_000)

  const runtime = (limit: number): NotebookRuntimeService => {
    service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'wsl-scheduling',
      platform: 'win32',
      processSandbox: sandbox!,
      shellConcurrencyLimit: limit,
      backgroundExecutionEnabled: true,
      shellRuntimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'live-test',
        distro: distro!,
        user: user!
      }
    })
    return service
  }

  const request = (name: string, sessionId = name): ExecuteShellRequest => ({
    sessionId,
    workspaceCwd: workspace,
    background: true,
    executionInvocationId: name,
    command: `printf started > ${name}.started; while [ ! -f ${name}.release ]; do sleep 0.1; done; printf '${name} done'`,
    timeoutMs: 60_000
  })
  const marker = (name: string, sessionId = name): string =>
    join(getNotebookDataRoot(root, 'wsl-scheduling', sessionId), name)
  const started = async (name: string, sessionId = name): Promise<void> => {
    await expect
      .poll(() => existsSync(`${marker(name, sessionId)}.started`), { timeout: 15_000 })
      .toBe(true)
  }
  const release = (name: string, sessionId = name): Promise<void> =>
    writeFile(`${marker(name, sessionId)}.release`, '')

  it('deduplicates background submissions and cancels queued work without guest side effects', async () => {
    const owner = runtime(1)
    const firstRequest = request('first')
    const first = await owner.executeShellBackground(firstRequest)
    await started('first')
    const queuedRequest = request('queued')
    const queued = await owner.executeShellBackground(queuedRequest)
    expect((await owner.executeShellBackground(queuedRequest)).runId).toBe(queued.runId)
    expect(
      (await owner.getBackgroundRun({ ...queuedRequest, runId: queued.runId })).run.status
    ).toBe('queued')
    expect(existsSync(marker('queued.started', 'queued'))).toBe(false)

    const cancelled = await owner.cancelBackgroundRun({ ...queuedRequest, runId: queued.runId })
    expect(cancelled.run.status).toBe('cancelled')
    expect(
      (await owner.cancelBackgroundRun({ ...queuedRequest, runId: queued.runId })).run.status
    ).toBe('cancelled')
    await release('first')
    await owner.waitForBackgroundRun(first.runId)
    expect(
      (await owner.getBackgroundRun({ ...firstRequest, runId: first.runId })).run
    ).toMatchObject({
      status: 'completed',
      exitCode: 0,
      text: { stdout: 'first done' }
    })
    expect(existsSync(marker('queued.started', 'queued'))).toBe(false)
  }, 90_000)

  it('serializes one session while admitting a different session into the second slot', async () => {
    const owner = runtime(2)
    const firstRequest = request('first', 'shared-session')
    const secondRequest = request('second', 'shared-session')
    const otherRequest = request('other', 'other-session')
    const first = await owner.executeShellBackground(firstRequest)
    await started('first', 'shared-session')
    const second = await owner.executeShellBackground(secondRequest)
    const other = await owner.executeShellBackground(otherRequest)
    await started('other', 'other-session')
    expect(existsSync(marker('second.started', 'shared-session'))).toBe(false)
    expect(
      (await owner.getBackgroundRun({ ...secondRequest, runId: second.runId })).run.status
    ).toBe('queued')
    await release('first', 'shared-session')
    await owner.waitForBackgroundRun(first.runId)
    await started('second', 'shared-session')
    await Promise.all([release('second', 'shared-session'), release('other', 'other-session')])
    await Promise.all([
      owner.waitForBackgroundRun(second.runId),
      owner.waitForBackgroundRun(other.runId)
    ])
    for (const [input, receipt] of [
      [firstRequest, first],
      [secondRequest, second],
      [otherRequest, other]
    ] as const) {
      expect((await owner.getBackgroundRun({ ...input, runId: receipt.runId })).run.status).toBe(
        'completed'
      )
    }
  }, 90_000)

  it('drains an active guest writer and a queued run before application disposal returns', async () => {
    const owner = runtime(1)
    await owner.executeShellBackground({
      ...request('writer'),
      command: 'printf started > writer.started; while :; do printf x >> writes; sleep 0.1; done'
    })
    await started('writer')
    await owner.executeShellBackground(request('queued'))
    expect(await owner.dispose()).toEqual({ reaped: true })
    service = undefined
    const content = await readFile(marker('writes', 'writer'), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await readFile(marker('writes', 'writer'), 'utf8')).toBe(content)
    expect(existsSync(marker('queued.started', 'queued'))).toBe(false)
  }, 90_000)

  it('records cold and repeated end-to-end shell latency without a machine-specific speed threshold', async () => {
    const owner = runtime(2)
    const durations: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now()
      expect(
        await owner.executeShell({
          sessionId: 'latency',
          workspaceCwd: workspace,
          command: 'printf measured',
          timeoutMs: 30_000
        })
      ).toMatchObject({ stdout: 'measured', stderr: '', exitCode: 0 })
      durations.push(Math.round(performance.now() - start))
    }
    console.info('WSL shell end-to-end latency (ms)', JSON.stringify(durations))
  }, 120_000)
})
