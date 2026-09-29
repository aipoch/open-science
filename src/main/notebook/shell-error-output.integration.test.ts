import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client as ModelContextProtocolClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer } from './mcp-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookProcessSandbox } from './process-sandbox'

type Harness = {
  root: string
  service: NotebookRuntimeService
  client: ModelContextProtocolClient
  close: () => Promise<void>
}
let active: Harness | undefined

const createHarness = async (processSandbox?: NotebookProcessSandbox): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-shell-mcp-'))
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'default-project',
    repository: new NotebookRunRepository(root),
    ...(processSandbox
      ? { shellProcess: new NotebookShellProcessAdapter(process.platform, processSandbox) }
      : {})
  })
  const rpc = new NotebookLocalRpcServer(service, { transport: 'tcp' })
  const connection = await rpc.issueSessionConnection(
    'session-1',
    'default-project',
    'root-frame-session-1'
  )
  const mcp = createNotebookMcpServer({
    ...connection,
    projectId: 'default-project',
    sessionId: 'session-1',
    workspaceCwd: root
  })
  const client = new ModelContextProtocolClient({ name: 'shell-error-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    root,
    service,
    client,
    close: async () => {
      await client.close()
      await mcp.close()
      await rpc.close()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
}

const resultBody = (
  result: Awaited<ReturnType<ModelContextProtocolClient['callTool']>>
): Record<string, unknown> => {
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.find((item) => item.type === 'text')
  expect(text?.type).toBe('text')
  const body = JSON.parse(text!.text!) as Record<string, unknown>
  expect(result.structuredContent).toEqual(body)
  return body
}

afterEach(async () => {
  await active?.close()
  active = undefined
})

describe.skipIf(process.platform === 'win32')(
  'Shell error output through real process, RPC, and MCP',
  () => {
    it('marks nonzero exit as a tool error but a successful stderr warning as completed', async () => {
      const h = (active = await createHarness())

      const failed = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: "printf 'command diagnosis\\n' >&2; (exit 7)" }
      })
      expect(failed.isError).toBe(true)
      expect(resultBody(failed)).toMatchObject({
        status: 'failed',
        exitCode: 7,
        errorCode: 'shell-nonzero-exit',
        error: 'Shell command exited with code 7.',
        stderr: 'command diagnosis\n'
      })
      expect(resultBody(failed)).not.toHaveProperty('runId')

      const warning = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: "printf 'warning only\\n' >&2; true" }
      })
      expect(warning.isError).not.toBe(true)
      expect(resultBody(warning)).toEqual({
        status: 'completed',
        exitCode: 0,
        stderr: 'warning only\n'
      })

      const runs = (await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })).runs
      expect(runs.map((run) => run.status)).toEqual(['failed', 'completed'])
      expect(runs[0]).toMatchObject({ shellErrorCode: 'shell-nonzero-exit', exitCode: 7 })
    }, 30_000)

    it('preserves interpreter-exit diagnostics for explicit exit commands', async () => {
      const h = (active = await createHarness())
      for (const code of [7, 0]) {
        const result = await h.client.callTool({
          name: 'bash_execute',
          arguments: { command: `exit ${code}` }
        })
        expect(result.isError === true).toBe(code !== 0)
        expect(resultBody(result)).toMatchObject({
          status: code === 0 ? 'completed' : 'failed',
          exitCode: code,
          stderr: expect.stringContaining('Shell interpreter exited; interpreter state was reset.')
        })
      }
    }, 30_000)

    it('keeps a foreground timeout distinct from command failure', async () => {
      const h = (active = await createHarness())
      const result = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: 'sleep 30', timeoutMs: 100 }
      })
      expect(result.isError).toBe(true)
      expect(resultBody(result)).toMatchObject({
        status: 'timeout',
        exitCode: null,
        error: 'Shell command timed out before a verified result was returned.'
      })
    }, 30_000)

    it('reports a cancelled foreground Run without claiming command failure', async () => {
      const h = (active = await createHarness())
      const result = h.client.callTool({
        name: 'bash_execute',
        arguments: { command: 'sleep 30' }
      })
      await vi.waitFor(
        async () => {
          const state = await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })
          expect(state.runs.some((run) => run.status === 'running')).toBe(true)
        },
        { timeout: 10_000 }
      )
      await h.service.shutdown({ sessionId: 'session-1', workspaceCwd: h.root })
      const cancelled = await result
      expect(cancelled.isError).not.toBe(true)
      expect(resultBody(cancelled)).toMatchObject({ status: 'cancelled', exitCode: null })
    }, 30_000)

    it('returns a failed background Shell Run as a successful query', async () => {
      const h = (active = await createHarness())
      const submission = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: '(exit 7)', background: true }
      })
      expect(submission.isError).not.toBe(true)
      const runId = resultBody(submission).runId
      expect(typeof runId).toBe('string')
      await h.service.waitForBackgroundRun(runId as string)

      const query = await h.client.callTool({
        name: 'background_run',
        arguments: { action: 'query', runId }
      })
      expect(query.isError).not.toBe(true)
      const content = query.content as Array<{ type: string; text?: string }>
      const text = content.find((item) => item.type === 'text')
      expect(text?.type).toBe('text')
      expect(JSON.parse(text!.text!)).toMatchObject({
        status: 'failed',
        runId,
        exitCode: 7,
        errorCode: 'shell-nonzero-exit',
        error: 'Shell command exited with code 7.'
      })
    }, 30_000)

    it('reports a real spawn ENOENT as never started without exposing the host path', async () => {
      let missingExecutable = ''
      const sandbox: NotebookProcessSandbox = {
        wrap: async (invocation) => {
          missingExecutable = join(invocation.cwd, 'missing-shell-executable')
          return {
            executable: missingExecutable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup: async () => ({
              processesTerminated: true,
              networkClosed: true,
              temporaryResourcesRemoved: true
            })
          }
        }
      }
      const h = (active = await createHarness(sandbox))
      const failed = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: 'printf should-not-run' }
      })
      expect(failed.isError).toBe(true)
      const body = resultBody(failed)
      expect(body).toMatchObject({
        status: 'failed',
        exitCode: null,
        errorCode: 'shell-start-failed',
        systemErrorCode: 'ENOENT',
        error: 'Shell command did not start.'
      })
      expect(body).not.toHaveProperty('stderr')
      expect(JSON.stringify(body)).not.toContain(missingExecutable)
      expect(JSON.stringify(body)).not.toContain('stack')
      const runs = (await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })).runs
      expect(runs[0]).toMatchObject({
        status: 'failed',
        exitCode: null,
        shellErrorCode: 'shell-start-failed',
        shellSystemErrorCode: 'ENOENT'
      })
    }, 30_000)
  }
)
