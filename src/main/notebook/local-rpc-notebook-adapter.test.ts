import { describe, expect, it, vi } from 'vitest'

import {
  NOTEBOOK_LOCAL_RPC_METHODS,
  isNotebookLocalRpcMethod,
  opensNotebookInputRun,
  resolveNotebookLocalRpcHandler,
  type NotebookLocalRpcCapability,
  type NotebookLocalRpcMethod
} from './local-rpc-notebook-adapter'

const createCapability = (): NotebookLocalRpcCapability =>
  ({
    ...Object.fromEntries(
      NOTEBOOK_LOCAL_RPC_METHODS.map((method) => [
        method,
        vi.fn(async (request: unknown) => ({ method, request }))
      ])
    ),
    executeBackground: vi.fn(async (request: unknown) => ({
      method: 'executeBackground',
      request
    })),
    executeControlBackground: vi.fn(async (request: unknown) => ({
      method: 'executeControlBackground',
      request
    })),
    executeShellBackground: vi.fn(async (request: unknown) => ({
      method: 'executeShellBackground',
      request
    }))
  }) as unknown as NotebookLocalRpcCapability

const request = {
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  provenanceContext: {
    rootFrameId: 'frame-root',
    agentFrameId: 'frame-agent',
    messageBranchId: 'branch-1',
    runtimeSegmentId: 'runtime-1',
    promptMessageId: 'message-user-1'
  },
  registeredInputFiles: [
    {
      inputFileVersionId: 'input-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceProjectId: 'project-1',
      sourceSessionId: 'session-1',
      filename: 'input.csv',
      sizeBytes: 10,
      checksum: 'checksum-1',
      storageKey: 'uploads/input-1',
      association: 'turn-attached'
    }
  ],
  inputRunLeaseId: 'input-run-1'
}

const requestByMethod = {
  beginCodeCell: request,
  appendCodeCell: { ...request, writeId: 'write-1', cellId: 'cell-1', delta: 'print(1)' },
  abortCodeCell: { ...request, writeId: 'write-1', cellId: 'cell-1' },
  finishCodeCell: { ...request, writeId: 'write-1', cellId: 'cell-1' },
  runCell: { ...request, cellId: 'cell-1' },
  execute: {
    ...request,
    code: 'print(1)',
    language: 'python',
    kernelSkillIds: ['figure-style'],
    background: true
  },
  getBackgroundRun: { ...request, action: 'query', runId: 'run-1' },
  cancelBackgroundRun: { ...request, action: 'cancel', runId: 'run-1' },
  executeControl: { ...request, code: 'return 1' },
  executeShell: { ...request, command: 'echo hi', background: true },
  requestNetworkAccess: {
    ...request,
    hostname: 'data.example.org',
    reason: 'Download the requested public dataset.'
  },
  state: request,
  restart: { ...request, language: 'r', environment: 'default-r' },
  shutdown: request,
  inspectPackages: { ...request, language: 'python', packages: ['numpy'] },
  managePackages: { ...request, language: 'python', packages: ['numpy'] },
  manageEnvironments: { ...request, action: 'list' },
  listRuntimes: request,
  bindRuntime: { ...request, language: 'python', runtimeId: 'analysis' },
  switchRuntime: { ...request, language: 'python', runtimeId: 'analysis' }
} satisfies Record<NotebookLocalRpcMethod, Record<string, unknown>>

describe('notebook local RPC adapter', () => {
  it('owns exactly the notebook capability method surface', () => {
    expect(NOTEBOOK_LOCAL_RPC_METHODS).toEqual([
      'beginCodeCell',
      'appendCodeCell',
      'abortCodeCell',
      'finishCodeCell',
      'runCell',
      'execute',
      'getBackgroundRun',
      'cancelBackgroundRun',
      'executeControl',
      'executeShell',
      'requestNetworkAccess',
      'state',
      'restart',
      'shutdown',
      'inspectPackages',
      'managePackages',
      'manageEnvironments',
      'listRuntimes',
      'bindRuntime',
      'switchRuntime'
    ])
    expect(new Set(NOTEBOOK_LOCAL_RPC_METHODS).size).toBe(20)

    for (const method of [
      'listPackages',
      'listPackageCounts',
      'resolveNotebookInput',
      'mcpCall',
      'computeCall',
      'agentsCall',
      'reviewerCall',
      'skillImport',
      'artifactCreateVersion',
      'artifactReplayVersion',
      'toString',
      'constructor',
      '__proto__',
      null,
      1
    ]) {
      expect(isNotebookLocalRpcMethod(method)).toBe(false)
    }
  })

  it.each(
    NOTEBOOK_LOCAL_RPC_METHODS.filter((method) => method !== 'execute' && method !== 'executeShell')
  )('preserves request, result and error identity for %s', async (method) => {
    const capability = createCapability()
    const methodRequest = requestByMethod[method]
    const handler = resolveNotebookLocalRpcHandler(capability, method, methodRequest)
    const methodMock = (
      capability as unknown as Record<NotebookLocalRpcMethod, ReturnType<typeof vi.fn>>
    )[method]
    const result = { method }
    methodMock.mockResolvedValueOnce(result)

    await expect(handler(methodRequest)).resolves.toBe(result)
    expect(methodMock).toHaveBeenCalledTimes(1)
    expect(methodMock.mock.calls[0]?.[0]).toBe(methodRequest)
    for (const otherMethod of NOTEBOOK_LOCAL_RPC_METHODS) {
      if (otherMethod === method) continue
      expect(
        (capability as unknown as Record<NotebookLocalRpcMethod, ReturnType<typeof vi.fn>>)[
          otherMethod
        ]
      ).not.toHaveBeenCalled()
    }

    if (method === 'bindRuntime' || method === 'switchRuntime') return
    const failure = new Error(`${method} failed`)
    methodMock.mockRejectedValueOnce(failure)
    await expect(handler(methodRequest)).rejects.toBe(failure)
  })

  it('maps Agent-facing kernel Skill IDs to the runtime request at the adapter boundary', async () => {
    const capability = createCapability()
    const methodRequest = requestByMethod.execute
    const handler = resolveNotebookLocalRpcHandler(capability, 'execute', methodRequest)

    await handler(methodRequest)

    const runtimeRequest = vi.mocked(capability.executeBackground).mock.calls[0]?.[0]
    expect(runtimeRequest).toMatchObject({
      code: 'print(1)',
      language: 'python',
      background: true,
      helperModules: ['figure-style']
    })
    expect(runtimeRequest).not.toHaveProperty('kernelSkillIds')
    expect(capability.execute).not.toHaveBeenCalled()
  })

  it.each(['getBackgroundRun', 'cancelBackgroundRun'] as const)(
    'marks %s as an Agent observation at the local RPC seam',
    async (method) => {
      const capability = createCapability()
      const methodRequest = requestByMethod[method]
      const handler = resolveNotebookLocalRpcHandler(capability, method, methodRequest)

      await handler(methodRequest)

      expect(vi.mocked(capability[method])).toHaveBeenCalledWith(methodRequest, {
        consumer: 'agent'
      })
    }
  )

  it('routes background REPL requests through durable background admission', async () => {
    const capability = createCapability()
    const methodRequest = { ...requestByMethod.executeControl, background: true }
    const handler = resolveNotebookLocalRpcHandler(capability, 'executeControl', methodRequest)
    const cancellation = new AbortController()

    await handler(methodRequest, cancellation.signal)

    expect(capability.executeControlBackground).toHaveBeenCalledWith(
      methodRequest,
      cancellation.signal
    )
    expect(capability.executeControl).not.toHaveBeenCalled()
  })

  it('routes background Shell requests through the durable admission path', async () => {
    const capability = createCapability()
    const methodRequest = requestByMethod.executeShell
    const handler = resolveNotebookLocalRpcHandler(capability, 'executeShell', methodRequest)
    const cancellation = new AbortController()

    await handler(methodRequest, cancellation.signal)

    expect(capability.executeShellBackground).toHaveBeenCalledWith(
      methodRequest,
      cancellation.signal
    )
    expect(capability.executeShell).not.toHaveBeenCalled()
  })

  it.each(
    (['bindRuntime', 'switchRuntime'] as const).flatMap((method) =>
      [false, true].map((bindingChanged) => ({ method, bindingChanged }))
    )
  )(
    'forwards the $method failure receipt with bindingChanged=$bindingChanged',
    async ({ method, bindingChanged }) => {
      const capability = createCapability()
      const failure = {
        ok: false,
        bindingChanged,
        error: 'Binding persistence failed. The previous kernel has stopped.',
        target: { language: 'python', selection: 'unresolved' }
      }
      vi.mocked(capability[method]).mockResolvedValueOnce(failure)
      const methodRequest = requestByMethod[method]
      const handler = resolveNotebookLocalRpcHandler(capability, method, methodRequest)

      await expect(handler(methodRequest)).resolves.toBe(failure)
      expect(capability.listRuntimes).not.toHaveBeenCalled()
    }
  )

  it.each(['runCell', 'execute', 'executeControl'] as const)(
    'forwards request cancellation to durable execution method %s',
    async (method) => {
      const capability = createCapability()
      const methodRequest = requestByMethod[method]
      const handler = resolveNotebookLocalRpcHandler(capability, method, methodRequest)
      const cancellation = new AbortController()

      await (
        handler as unknown as (
          request: Record<string, unknown>,
          signal: AbortSignal
        ) => Promise<unknown>
      )(methodRequest, cancellation.signal)

      if (method === 'execute') {
        expect(capability.executeBackground).toHaveBeenCalledWith(
          expect.objectContaining({ helperModules: ['figure-style'] }),
          cancellation.signal
        )
        expect(vi.mocked(capability.executeBackground).mock.calls[0]?.[0]).not.toHaveProperty(
          'kernelSkillIds'
        )
      } else if (method === 'runCell') {
        expect(capability.runCell).toHaveBeenCalledWith(methodRequest, cancellation.signal)
      } else {
        expect(capability.executeControl).toHaveBeenCalledWith(methodRequest, cancellation.signal)
      }
    }
  )

  it('forwards request cancellation to a pending network access decision', async () => {
    const capability = createCapability()
    const methodRequest = requestByMethod.requestNetworkAccess
    const handler = resolveNotebookLocalRpcHandler(
      capability,
      'requestNetworkAccess',
      methodRequest
    )
    const cancellation = new AbortController()

    await handler(methodRequest, cancellation.signal)

    expect(capability.requestNetworkAccess).toHaveBeenCalledWith(methodRequest, cancellation.signal)
  })

  it('forwards request cancellation to shell execution', async () => {
    const capability = createCapability()
    const methodRequest = requestByMethod.executeShell
    const handler = resolveNotebookLocalRpcHandler(capability, 'executeShell', methodRequest)
    const cancellation = new AbortController()

    await handler(methodRequest, cancellation.signal)

    expect(capability.executeShellBackground).toHaveBeenCalledWith(
      methodRequest,
      cancellation.signal
    )
  })

  it.each(['managePackages', 'manageEnvironments'] as const)(
    'forwards request cancellation to %s',
    async (method) => {
      const capability = createCapability()
      const methodRequest = requestByMethod[method]
      const handler = resolveNotebookLocalRpcHandler(capability, method, methodRequest)
      const cancellation = new AbortController()

      await handler(methodRequest, cancellation.signal)

      expect(capability[method]).toHaveBeenCalledWith(methodRequest, cancellation.signal)
    }
  )

  it('validates common notebook routing fields before resolving a handler', () => {
    const capability = createCapability()

    for (const field of ['sessionId', 'workspaceCwd'] as const) {
      for (const invalid of [undefined, null, 1, [], {}]) {
        expect(() =>
          resolveNotebookLocalRpcHandler(capability, 'execute', {
            ...request,
            [field]: invalid
          })
        ).toThrow('Notebook RPC params must include sessionId and workspaceCwd.')
      }
    }

    expect(() =>
      resolveNotebookLocalRpcHandler(capability, 'execute', {
        ...request,
        sessionId: '',
        workspaceCwd: '',
        code: 'print(1)'
      })
    ).not.toThrow()
  })

  it.each([{ language: 'r' }, { environment: 'default-r' }])(
    'rejects a half-specified restart target',
    (target) => {
      const capability = createCapability()

      expect(() =>
        resolveNotebookLocalRpcHandler(capability, 'restart', { ...request, ...target })
      ).toThrow('Invalid notebook RPC params for restart')
    }
  )

  it('rejects unknown methods after validating common routing fields', () => {
    const capability = createCapability()

    for (const method of ['unknown', 'listPackages', 'listPackageCounts', 'reviewerCall']) {
      expect(() => resolveNotebookLocalRpcHandler(capability, method, request)).toThrow(
        `Unknown notebook RPC method: ${method}`
      )
    }
    expect(() => resolveNotebookLocalRpcHandler(capability, 'unknown', {})).toThrow(
      'Notebook RPC params must include sessionId and workspaceCwd.'
    )
  })

  it('identifies only execution methods as input-run lease owners', () => {
    const leaseMethods = NOTEBOOK_LOCAL_RPC_METHODS.filter(opensNotebookInputRun)

    expect(leaseMethods).toEqual(['runCell', 'execute', 'executeControl', 'executeShell'])
  })
})
