import { Client as ModelContextProtocolClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer } from './mcp-server'

const deferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('Notebook MCP management lifecycle', () => {
  it.each([
    ['manage_packages', 'managePackages', { language: 'python', packages: ['numpy'] }],
    [
      'manage_environments',
      'manageEnvironments',
      { action: 'create', language: 'python', name: 'analysis' }
    ]
  ] as const)(
    'stops the background %s operation when the MCP client deadline expires',
    async (toolName, method, args) => {
      const started = deferred<AbortSignal | undefined>()
      const release = deferred<unknown>()
      let backgroundSettled = false
      const operation = vi.fn(async (_request: unknown, signal?: AbortSignal) => {
        started.resolve(signal)
        if (signal?.aborted) backgroundSettled = true
        else
          signal?.addEventListener(
            'abort',
            () => {
              backgroundSettled = true
              release.resolve(undefined)
            },
            { once: true }
          )
        return release.promise
      })
      const rpcServer = new NotebookLocalRpcServer({ [method]: operation } as never, {
        transport: 'tcp'
      })
      const connection = await rpcServer.ensureStarted()
      const mcpServer = createNotebookMcpServer({
        ...connection,
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
      const mcpClient = new ModelContextProtocolClient({
        name: 'management-lifecycle-test',
        version: '1.0.0'
      })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await mcpServer.connect(serverTransport)
      await mcpClient.connect(clientTransport)

      try {
        const call = mcpClient.callTool({ name: toolName, arguments: args }, undefined, {
          timeout: 100
        })
        const timedOut = expect(call).rejects.toThrow(/timed out/i)
        const signal = await started.promise
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal?.aborted).toBe(false)

        await timedOut
        await vi.waitFor(() => expect(signal?.aborted).toBe(true))
        await vi.waitFor(() => expect(backgroundSettled).toBe(true))
      } finally {
        release.resolve(undefined)
        await mcpClient.close()
        await mcpServer.close()
        await rpcServer.close()
      }
    }
  )
})
