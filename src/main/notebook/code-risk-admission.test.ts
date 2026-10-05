import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookRuntimeService, type NotebookExecutionRequest } from './runtime-service'
import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'

const roots: string[] = []
const services: NotebookRuntimeService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdownAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(environmentCount = 0): Promise<{
  service: NotebookRuntimeService
  execute: ReturnType<typeof vi.fn>
  shell: ReturnType<typeof vi.fn>
  runtimes: DiscoveredInterpreter[]
  request: { projectId: string; sessionId: string; workspaceCwd: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'notebook-risk-'))
  roots.push(root)
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: [],
    kernelDispatched: true
  }))
  const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  const runtimes = Array.from({ length: environmentCount }, (_, index) => ({
    language: 'python' as const,
    provenance: 'user-own' as const,
    envId: join(root, `python-${index}`),
    interpreterPath: join(root, `python-${index}`),
    label: `Python ${index}`,
    runnable: true
  }))
  const service = new NotebookRuntimeService({
    notebookRuntimeSettings: {
      getSnapshot: async (language) => ({
        language,
        manualInterpreters: [],
        packageMirror: {},
        runtimeEnablement: {
          enabled: Object.fromEntries(runtimes.map((r) => [r.envId, true])),
          installAuthorized: {}
        }
      })
    },
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    discoverRuntimes: async (language) => (language === 'python' ? runtimes : []),
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
    shellProcess: { execute: shell }
  })
  services.push(service)
  return {
    service,
    execute,
    shell,
    runtimes,
    request: { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  }
}

describe('host-owned one-shot execution admission', () => {
  it('does not prompt for ordinary execution across fresh Sessions', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    for (const sessionId of ['one', 'two'])
      await service.execute({ ...request, sessionId, code: 'print(1)' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(approve).not.toHaveBeenCalled()
  })

  it('waits before dispatch and requests approval again on the next deletion', async () => {
    const { service, execute, request } = await harness()
    let release!: (value: boolean) => void
    const approve = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    service.setExecutionApproval(approve)
    const run = service.execute({ ...request, code: 'import os\nos.unlink("x")' })
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(execute).not.toHaveBeenCalled()
    release(true)
    await run
    expect(execute).toHaveBeenCalledTimes(1)
    const second = service.execute({ ...request, code: 'os.unlink("x")' })
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    release(false)
    await expect(second).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('blocks REPL and shell dispatch on declined approval', async () => {
    const { service, execute, shell, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({ ...request, code: 'const fs = require("fs"); fs.rmSync("x")' })
    await expect(service.executeShell({ ...request, command: 'rm -rf x' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
    expect(shell).not.toHaveBeenCalled()
  })

  it('does not dispatch when cancellation arrives during approval', async () => {
    const { service, execute, request } = await harness()
    const controller = new AbortController()
    service.setExecutionApproval(async () => {
      controller.abort(new Error('stopped'))
      return true
    })
    await expect(
      service.execute({ ...request, code: 'import os\nos.unlink("x")' }, controller.signal)
    ).rejects.toThrow('stopped')
    expect(execute).not.toHaveBeenCalled()
  })

  it('reviews the finalized streamed cell, including destructive code appended last', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const cell = await service.beginCodeCell({ ...request, language: 'r' })
    await service.appendCodeCell({ ...request, ...cell, delta: 'x <- 1\n' })
    await service.appendCodeCell({ ...request, ...cell, delta: 'unlink("x")' })
    await service.finishCodeCell({ ...request, ...cell })
    await expect(service.runCell({ ...request, cellId: cell.cellId })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })
  it('uses a sole enabled environment without a Session permission prompt', async () => {
    const { service, execute, request, runtimes } = await harness(1)
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: 'print(1)' })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await service.listRuntimes(request)).bindings.python?.runtimeId).toBe(runtimes[0].envId)
  })

  it('requires a concrete selection with multiple environments and preserves the binding on denied switch', async () => {
    const { service, request, runtimes } = await harness(2)
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    await expect(service.execute({ ...request, code: 'print(1)' })).rejects.toThrow(
      'Several python environments'
    )
    expect(approve).not.toHaveBeenCalled()
    const binding = {
      ...request,
      language: 'python' as const,
      runtimeId: runtimes[0].envId,
      provenanceContext: {
        rootFrameId: 'root',
        agentFrameId: 'root',
        messageBranchId: 'branch',
        runtimeSegmentId: 'segment',
        promptMessageId: 'prompt'
      }
    }
    expect(await service.bindRuntime(binding)).toHaveProperty('bound.runtimeId', runtimes[0].envId)
    expect(approve).toHaveBeenCalledTimes(1)
    await service.bindRuntime(binding)
    expect(approve).toHaveBeenCalledTimes(1)
    approve.mockResolvedValue(false)
    expect(
      await service.switchRuntime({ ...binding, runtimeId: runtimes[1].envId })
    ).toHaveProperty('bindingChanged', false)
    expect((await service.listRuntimes(request)).bindings.python?.runtimeId).toBe(runtimes[0].envId)
    expect(approve).toHaveBeenCalledTimes(2)
  })
})
