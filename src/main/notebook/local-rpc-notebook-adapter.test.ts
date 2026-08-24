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
    )
  }) as unknown as NotebookLocalRpcCapability

const request = {
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  provenanceContext: { promptMessageId: 'message-user-1' },
  registeredInputFiles: [{ inputFileVersionId: 'input-1' }],
  inputRunLeaseId: 'input-run-1'
}

describe('notebook local RPC adapter', () => {
  it('owns exactly the notebook capability method surface', () => {
    expect(NOTEBOOK_LOCAL_RPC_METHODS).toEqual([
      'beginCodeCell',
      'appendCodeCell',
      'finishCodeCell',
      'runCell',
      'execute',
      'executeControl',
      'executeShell',
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
    expect(new Set(NOTEBOOK_LOCAL_RPC_METHODS).size).toBe(16)

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

  it.each(NOTEBOOK_LOCAL_RPC_METHODS)(
    'preserves request, result and error identity for %s',
    async (method) => {
      const capability = createCapability()
      const handler = resolveNotebookLocalRpcHandler(capability, method, request)
      const methodMock = (
        capability as unknown as Record<NotebookLocalRpcMethod, ReturnType<typeof vi.fn>>
      )[method]
      const result = { method }
      methodMock.mockResolvedValueOnce(result)

      await expect(handler(request)).resolves.toBe(result)
      expect(methodMock).toHaveBeenCalledTimes(1)
      expect(methodMock.mock.calls[0]?.[0]).toBe(request)
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
      await expect(handler(request)).rejects.toBe(failure)
    }
  )

  it.each(['bindRuntime', 'switchRuntime'] as const)(
    'forwards the service-owned failure receipt for %s without deriving a target',
    async (method) => {
      const capability = createCapability()
      const failure = {
        ok: false,
        bindingChanged: false,
        error: '"analysis" is not an enabled python runtime.',
        target: { language: 'python', selection: 'unresolved' }
      }
      vi.mocked(capability[method]).mockResolvedValueOnce(failure)
      const handler = resolveNotebookLocalRpcHandler(capability, method, request)

      await expect(
        handler({ ...request, language: 'python', runtimeId: 'analysis' })
      ).resolves.toBe(failure)
      expect(capability.listRuntimes).not.toHaveBeenCalled()
    }
  )

  it.each(['runCell', 'execute'] as const)(
    'forwards request cancellation to data execution method %s',
    async (method) => {
      const capability = createCapability()
      const handler = resolveNotebookLocalRpcHandler(capability, method, request)
      const cancellation = new AbortController()

      await (
        handler as unknown as (
          request: Record<string, unknown>,
          signal: AbortSignal
        ) => Promise<unknown>
      )(request, cancellation.signal)

      expect(capability[method]).toHaveBeenCalledWith(request, cancellation.signal)
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
        workspaceCwd: ''
      })
    ).not.toThrow()
  })

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
