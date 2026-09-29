import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as ModelContextProtocolClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer, NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT } from './mcp-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookProcessSandbox } from './process-sandbox'

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

type Harness = {
  root: string
  service: NotebookRuntimeService
  client: ModelContextProtocolClient
  close: () => Promise<void>
}
let active: Harness | undefined

const createHarness = async (
  processSandbox?: NotebookProcessSandbox,
  backgroundControl = false
): Promise<Harness> => {
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
  const controlConnection = backgroundControl
    ? await rpc.issueControlConnection('session-1', 'default-project', 'root-frame-session-1')
    : undefined
  const connection =
    controlConnection ??
    (await rpc.issueSessionConnection('session-1', 'default-project', 'root-frame-session-1'))
  const releaseControl = controlConnection?.beginControlInvocation({
    turnId: 'background-control-1',
    controlInvocationGeneration: 1,
    toolInvocationId: 'background-control-1',
    originatingUserMessageId: 'user-message-1',
    executionMode: 'background'
  })
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
      releaseControl?.()
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

describe('non-Shell structured RPC failures through the MCP SDK', () => {
  it('retains the background Host SDK rejection without a message field', async () => {
    const h = (active = await createHarness(undefined, true))
    const result = await h.client.callTool({
      name: 'ask_user_question',
      arguments: {
        questions: [{ question: 'Choose a format', options: [{ label: 'CSV' }, { label: 'JSON' }] }]
      }
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(JSON.parse(content.find((block) => block.type === 'text')!.text!)).toEqual({
      code: 'BACKGROUND_HOST_METHOD_UNSAFE',
      method: 'host.requestUserInput',
      retryable: false,
      hint: 'Run this Host SDK operation in foreground repl_execute.'
    })
  })

  it('retains the saved-identity recovery hint for a missing background Run', async () => {
    const h = (active = await createHarness())
    const result = await h.client.callTool({
      name: 'background_run',
      arguments: { action: 'query', runId: 'missing-run' }
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(JSON.parse(content.find((block) => block.type === 'text')!.text!)).toEqual({
      code: 'BACKGROUND_RUN_NOT_FOUND',
      stage: 'query',
      retryable: true,
      hint: 'Check the saved runId and submissionIdentity before deciding whether to resubmit.',
      runId: 'missing-run',
      message: 'No matching local background Run exists in this Agent Frame.'
    })
  })
})

describe('Shell request failures through real RPC and MCP transports', () => {
  it('reports a capability rejection without claiming the command started or completed', async () => {
    const h = (active = await createHarness(undefined, true))
    const result = await h.client.callTool({
      name: 'bash_execute',
      arguments: { command: 'printf forbidden' }
    })
    expect(result.isError).toBe(true)
    expect(resultBody(result)).toMatchObject({
      status: 'failed',
      execution: 'unknown',
      error: expect.stringContaining('Notebook RPC capability does not allow executeShell'),
      nextStep: expect.stringContaining('before rerunning')
    })
    expect(resultBody(result)).not.toHaveProperty('exitCode')
  })

  it('bounds an injected service exception without leaking private details or implying replay safety', async () => {
    const h = (active = await createHarness())
    // Inject at the service boundary; the HTTP error serialization and MCP SDK are real.
    const execute = vi
      .spyOn(h.service, 'executeShell')
      .mockRejectedValue(new Error('private-service-diagnostic'))
    const result = await h.client.callTool({
      name: 'bash_execute',
      arguments: { command: 'printf unused' }
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
    expect(resultBody(result)).toMatchObject({
      status: 'failed',
      execution: 'unknown',
      error: 'Shell request failed before a command result was returned.',
      nextStep: expect.stringContaining('may have changed files or external state')
    })
    expect(JSON.stringify(result)).not.toContain('private-service-diagnostic')
    expect(resultBody(result)).not.toHaveProperty('exitCode')
  })
})

describe.skipIf(process.platform === 'win32')(
  'Shell error output through real process, RPC, and MCP',
  () => {
    it.each([6_100])(
      'retains the final diagnostic after %i stderr characters',
      async (size) => {
        const h = (active = await createHarness())
        const result = await h.client.callTool({
          name: 'bash_execute',
          arguments: {
            command: `printf '%0${size}d' 0 >&2; printf '\\nfinal diagnosis\\n' >&2; (exit 7)`
          }
        })
        const body = resultBody(result)
        expect(result.isError).toBe(true)
        expect(body).toMatchObject({ status: 'failed', exitCode: 7, truncated: true })
        expect(body.stderr).toEqual(expect.stringContaining('final diagnosis\n'))
      },
      30_000
    )

    it('reports an interpreter killed by a signal as process failure with its stderr', async () => {
      const h = (active = await createHarness())
      const result = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: "printf 'before signal\\n' >&2; kill -TERM $$" }
      })
      expect(result.isError).toBe(true)
      expect(resultBody(result)).toMatchObject({
        status: 'failed',
        exitCode: null,
        errorCode: 'shell-process-error',
        stderr: 'before signal\n'
      })
    }, 30_000)

    it.each([false, true])(
      'bounds real escaped output while preserving failure facts (injected cleanup failure: %s)',
      async (injectCleanupFailure) => {
        let cleanupBlocked = injectCleanupFailure
        // The command and output are real. Only cleanup confirmation is fault-injected;
        // this does not simulate an OS termination failure or leave a child alive.
        const cleanup = vi.fn(async () => ({
          processesTerminated: true,
          networkClosed: !cleanupBlocked,
          temporaryResourcesRemoved: true
        }))
        const h = (active = await createHarness({
          wrap: async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        }))
        try {
          const markerPath = join(h.root, 'execution-count')
          const quotedMarker = `'${markerPath.replaceAll("'", "'\\''")}'`
          const result = await h.client.callTool({
            name: 'bash_execute',
            arguments: {
              command:
                `printf run >> ${quotedMarker}; ` +
                'i=0; while [ "$i" -lt 6500 ]; do printf \'\\001\'; i=$((i+1)); done; ' +
                "printf 'final diagnosis\\n' >&2; exit 7"
            }
          })
          const body = resultBody(result)
          const content = result.content as Array<{ type: string; text?: string }>
          const text = content.find((block) => block.type === 'text')!.text!
          expect(result.isError).toBe(true)
          expect(text.length).toBeLessThanOrEqual(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
          expect(body).toMatchObject({
            status: 'failed',
            exitCode: injectCleanupFailure ? null : 7,
            errorCode: injectCleanupFailure ? 'shell-cleanup-incomplete' : 'shell-nonzero-exit',
            error: injectCleanupFailure
              ? 'Shell process cleanup is unverified; the command result is not trusted.'
              : 'Shell command exited with code 7.',
            truncated: true,
            stderr: expect.stringContaining('final diagnosis\n')
          })
          expect(cleanup).toHaveBeenCalled()
          if (injectCleanupFailure) {
            expect(body.nextStep).toEqual(
              expect.stringMatching(
                /Do not rerun until cleanup is verified.*check partial effects first/
              )
            )
          }
          expect(await readFile(markerPath, 'utf8')).toBe('run')
        } finally {
          // Permit the normal disposal path to reconcile the injected cleanup restriction.
          cleanupBlocked = false
        }
      },
      30_000
    )

    it.each([false, true])(
      'retains failed Shell facts when reopened from disk (background: %s)',
      async (background) => {
        const h = (active = await createHarness())
        const submission = await h.client.callTool({
          name: 'bash_execute',
          arguments: { command: "printf 'before'; printf 'diagnosis' >&2; (exit 7)", background }
        })
        const initialBody = resultBody(submission)
        if (background) await h.service.waitForBackgroundRun(initialBody.runId as string)
        const reopened = await new NotebookRunRepository(h.root).findExisting(
          'default-project',
          'session-1'
        )
        const persisted = reopened!.runs.at(-1)!
        expect(persisted).toMatchObject({
          status: 'failed',
          exitCode: 7,
          shellErrorCode: 'shell-nonzero-exit',
          text: { stdout: 'before', stderr: 'diagnosis' }
        })
        let body = initialBody
        if (background) {
          // Foreground Runs deliberately cannot be queried through background_run.
          const query = await h.client.callTool({
            name: 'background_run',
            arguments: { action: 'query', runId: persisted.runId }
          })
          expect(query.isError).not.toBe(true)
          const content = query.content as Array<{ type: string; text?: string }>
          body = JSON.parse(content.find((block) => block.type === 'text')!.text!)
        } else {
          expect(submission.isError).toBe(true)
        }
        expect(body).toMatchObject({
          status: persisted.status,
          exitCode: persisted.exitCode,
          errorCode: persisted.shellErrorCode,
          stdout: persisted.text.stdout,
          stderr: persisted.text.stderr
        })
      },
      30_000
    )

    it('retains cleanup restrictions when foreground cancellation cannot verify cleanup', async () => {
      let cleanupBlocked = true
      // Real process cancellation; only the sandbox cleanup confirmation is injected.
      const h = (active = await createHarness({
        wrap: async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr) => stderr,
          cleanup: async () => ({
            processesTerminated: true,
            networkClosed: !cleanupBlocked,
            temporaryResourcesRemoved: true
          })
        })
      }))
      const markerPath = join(h.root, 'started')
      const quotedMarker = `'${markerPath.replaceAll("'", "'\\''")}'`
      const pending = h.client.callTool({
        name: 'bash_execute',
        arguments: { command: `printf started > ${quotedMarker}; sleep 30` }
      })
      try {
        await vi.waitFor(async () => expect(await readFile(markerPath, 'utf8')).toBe('started'), {
          timeout: 10_000
        })
        await h.service.shutdown({ sessionId: 'session-1', workspaceCwd: h.root })
        const result = await pending
        expect(result.isError).toBe(true)
        expect(resultBody(result)).toMatchObject({
          status: 'failed',
          errorCode: 'shell-cleanup-incomplete',
          nextStep: expect.stringMatching(
            /Do not rerun until cleanup is verified.*check partial effects first/
          )
        })
      } finally {
        cleanupBlocked = false
      }
    }, 30_000)

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
          hint: 'Shell interpreter exited.'
        })
        expect(resultBody(result)).not.toHaveProperty('stderr')
        const runs = (await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })).runs
        expect(runs.at(-1)).toMatchObject({
          shellExecutionNotice: 'Shell interpreter exited.',
          text: { stderr: '' }
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

    it('reports an admission denial as blocked before execution, not a command exit', async () => {
      const h = (active = await createHarness())
      const result = await h.client.callTool({
        name: 'bash_execute',
        arguments: { command: 'find / -maxdepth 1 -type f' }
      })
      expect(result.isError).toBe(true)
      expect(resultBody(result)).toMatchObject({
        status: 'failed',
        errorCode: 'shell-command-blocked',
        error: 'Shell command was blocked before execution.'
      })
      const document = await new NotebookRunRepository(h.root).findExisting(
        'default-project',
        'session-1'
      )
      expect(document?.runs.at(-1)).toMatchObject({
        status: 'failed',
        shellErrorCode: 'shell-command-blocked'
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
      const stateResult = await h.client.callTool({ name: 'notebook_state', arguments: {} })
      const stateContent = stateResult.content as Array<{ type: string; text?: string }>
      const state = JSON.parse(stateContent.find((block) => block.type === 'text')!.text!)
      expect(state.recentRuns.at(-1)).toMatchObject({
        status: 'failed',
        errorCode: 'shell-start-failed',
        systemErrorCode: 'ENOENT',
        error: 'Shell command did not start.'
      })
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
