import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { NotebookExecutionRequest, NotebookExecutionResult } from './runtime-service'
import {
  NotebookRuntimeService,
  resolveDefaultExecutorOptions,
  resolveLoopScriptPaths
} from './runtime-service'
import { NotebookKernelExecutor } from './kernel-executor'
import { effectiveMirrorAsync, resetAutoMirrorCache } from './mirror-probe'
import { NotebookRunRepository, getRuntimeRoot } from './repository'
import { RuntimeOperationJournal, operationJournalPath } from './operation-journal'
import type {
  InstallDeps as InstallDepsForTest,
  InstallRequest as InstallRequestForTest,
  InstallResult as InstallResultForTest
} from './package-manager'
import type { EnvironmentInfo } from '../../shared/notebook-env'
import type { NotebookEnvironmentStatus } from '../../shared/notebook'
import type { DiscoveredInterpreter, RuntimeEnablement } from '../../shared/notebook-runtime'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  envPrefix,
  pythonBin,
  writeRReadyMarker
} from './runtime-paths'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-runtime-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

// Prime the process-wide fastest-mirror memo with a no-network probe so managePackages tests never
// race real HTTP — the live probe adds nondeterministic latency (which flakes the timing-sensitive
// concurrency tests) and geography-dependent results. Tests that assert a specific mirror reset +
// inject their own probe on top of this.
beforeAll(async () => {
  resetAutoMirrorCache()
  await effectiveMirrorAsync(undefined, 'en-US', {
    probe: async () => {
      throw new Error('no network in tests')
    }
  })
})

describe('notebook runtime service', () => {
  it('streams agent code into a locked cell and runs it through the shared executor', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          const rawRunJson = await readFile(
            join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
            'utf8'
          )
          const document = JSON.parse(rawRunJson) as Awaited<
            ReturnType<NotebookRunRepository['loadOrCreate']>
          >

          expect(document.runs).toHaveLength(1)
          expect(document.runs[0]).toMatchObject({
            script: "print('hello')",
            status: 'running'
          })

          return {
            status: 'completed',
            stdout: 'hello\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [
              {
                type: 'stream',
                name: 'stdout',
                text: 'hello\n'
              }
            ],
            workingFiles: [
              {
                path: join(root, 'notebooks', 'default-project', 'session-1', 'data', 'result.csv'),
                relativePath: 'data/result.csv',
                kind: 'processed-data',
                size: 12,
                mtimeMs: 200
              }
            ]
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const begin = await service.beginCodeCell({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    await service.appendCodeCell({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: "print('hello')"
    })

    await expect(
      service.beginCodeCell({
        projectName: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
    ).rejects.toThrow(/already receiving code/)

    await service.finishCodeCell({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId
    })

    const summary = await service.runCell({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: begin.cellId
    })

    expect(summary).toMatchObject({
      cellId: begin.cellId,
      source: 'agent',
      script: "print('hello')",
      status: 'completed',
      text: {
        stdout: 'hello\n'
      },
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      runtimeRoot: join(root, 'runtime'),
      workingFiles: [
        {
          relativePath: 'data/result.csv',
          kind: 'processed-data'
        }
      ]
    })
    expect(executions[0]).toMatchObject({
      code: "print('hello')",
      // The interpreter runs in the session's writable data dir (Jupyter-style), not the workspace,
      // so relative writes land inside the artifact import roots.
      cwd: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      runtimeRoot: join(root, 'runtime')
    })

    const rawRunJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )

    expect(rawRunJson).toContain(`"script": "print('hello')"`)
    expect(JSON.parse(rawRunJson).runs).toHaveLength(1)
    expect(JSON.parse(rawRunJson).runs[0]).toMatchObject({
      status: 'completed'
    })
    expect(rawRunJson).toContain('"relativePath": "data/result.csv"')
  })

  it('captures executor failures as failed run summaries instead of throwing', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'failed',
          stdout: '',
          stderr: 'ModuleNotFoundError: No module named pandas\n',
          traceback: 'Traceback...\nModuleNotFoundError: No module named pandas',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'import pandas'
    })

    expect(summary).toMatchObject({
      status: 'failed',
      text: {
        stderr: 'ModuleNotFoundError: No module named pandas\n',
        traceback: 'Traceback...\nModuleNotFoundError: No module named pandas'
      },
      runtimeRoot: join(root, 'runtime')
    })
  })

  it('records terminal submissions in the shared run history', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: `${request.code}\n`,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(os.getcwd())',
      source: 'user',
      inputKind: 'terminal'
    })
    const state = await service.state({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(summary).toMatchObject({
      source: 'user',
      inputKind: 'terminal',
      script: 'print(os.getcwd())'
    })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      source: 'user',
      inputKind: 'terminal',
      script: 'print(os.getcwd())'
    })
  })

  it('announces agent notebook availability once while publishing notebook changes', async () => {
    const root = await createStorageRoot()
    const availableSessions: string[] = []
    const changedSessions: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      callbacks: {
        onNotebookAvailable: (event) => availableSessions.push(event.sessionId),
        onNotebookChanged: (event) => changedSessions.push(event.sessionId)
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.beginCodeCell({
      projectName: 'default-project',
      sessionId: 'user-session',
      workspaceCwd: '/workspace',
      source: 'user'
    })

    expect(availableSessions).toEqual([])

    const begin = await service.beginCodeCell({
      projectName: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace'
    })
    await service.appendCodeCell({
      projectName: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: "print('ok')"
    })
    await service.finishCodeCell({
      projectName: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId
    })
    await service.runCell({
      projectName: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      cellId: begin.cellId
    })

    expect(availableSessions).toEqual(['agent-session'])
    expect(changedSessions).toContain('agent-session')
    expect(changedSessions.filter((sessionId) => sessionId === 'agent-session').length).toBe(5)
  })

  it('does not thread the mcp RPC connection into the data-cell execute request', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      token: 'tok'
    }))

    await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: "print('hi')"
    })

    // Data kernels (python/r) have no host.mcp; the RPC connection stays with the control-plane repl.
    expect(executions[0].mcpRpcEndpoint).toBeUndefined()
    expect(executions[0].mcpRpcToken).toBeUndefined()
  })

  it('routes executeControl to the repl kernel kind, threads the RPC connection, and records a repl run', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: 'from-repl\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [{ type: 'stream', name: 'stdout', text: 'from-repl\n' }]
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      token: 'tok'
    }))

    const state0 = await service.state({ sessionId: 'session-1', workspaceCwd: root })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'return 1'
    })

    // The control path targets the repl kernel, not a language-derived data kernel.
    expect(executions).toHaveLength(1)
    expect(executions[0].kind).toBe('repl')
    expect(executions[0].language).toBeUndefined()
    expect(executions[0]).toMatchObject({
      code: 'return 1',
      mcpRpcEndpoint: 'http://127.0.0.1:1/x',
      mcpRpcToken: 'tok'
    })

    // Mapped outputs are still returned inline for the agent (recording is a side effect; the
    // repl_execute contract to the agent is unchanged).
    expect(result).toMatchObject({
      status: 'completed',
      stdout: 'from-repl\n',
      outputs: [{ type: 'stream', name: 'stdout', text: 'from-repl\n' }]
    })

    // A control-plane run now creates a run-history record tagged with kernelKind 'repl'.
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs).toHaveLength(state0.runs.length + 1)
    expect(state.runs[state.runs.length - 1]).toMatchObject({
      kernelKind: 'repl',
      script: 'return 1',
      status: 'completed',
      source: 'agent'
    })
  })

  it('records a failed repl run when the executor throws', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (): Promise<NotebookExecutionResult> => {
          throw new Error('repl kernel exploded')
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'throw new Error("boom")'
    })

    expect(result.status).toBe('failed')

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      kernelKind: 'repl',
      status: 'failed'
    })
  })

  it('forwards repl workingFiles into the recorded run and the returned result', async () => {
    const root = await createStorageRoot()
    const writtenFile = {
      path: join(root, 'notebooks', 'default-project', 'session-1', 'handoff', 'data.json'),
      relativePath: 'handoff/data.json',
      kind: 'raw-data' as const
    }
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: [],
          workingFiles: [writtenFile]
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'writeHandoffFile()'
    })

    expect(result.workingFiles).toMatchObject([{ relativePath: 'handoff/data.json' }])

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].workingFiles).toMatchObject([{ relativePath: 'handoff/data.json' }])
  })

  describe('executeShell', () => {
    it('runs a command in a fresh sh process and captures stdout/exitCode', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'echo hi'
      })

      expect(result.stdout).toContain('hi')
      expect(result.exitCode).toBe(0)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs).toHaveLength(1)
      expect(state.runs[0]).toMatchObject({
        kernelKind: 'bash',
        script: 'echo hi',
        status: 'completed',
        source: 'agent'
      })
      expect(state.runs[0].text.stdout).toContain('hi')
    })

    // POSIX-only: reads env via the shell. bash must NOT inherit arbitrary host env (secrets), only an
    // allowlist + the handoff channel — so a leaked connector token / API key can't reach the shell.
    it.skipIf(process.platform === 'win32')(
      'scrubs host secrets from the bash environment, keeping only the allowlist + handoff dir',
      async () => {
        const root = await createStorageRoot()
        process.env.OPEN_SCIENCE_TEST_SECRET = 'super-secret-token'
        try {
          const service = new NotebookRuntimeService({
            configRoot: root,
            dataRoot: root,
            projectName: 'default-project',
            repository: new NotebookRunRepository(root)
          })

          const result = await service.executeShell({
            sessionId: 'session-1',
            workspaceCwd: root,
            command:
              'echo "secret=[${OPEN_SCIENCE_TEST_SECRET}]"; echo "handoff=[${OPEN_SCIENCE_HANDOFF_DIR:+set}]"'
          })

          // The host secret is dropped; the workspace channel var is preserved.
          expect(result.stdout).toContain('secret=[]')
          expect(result.stdout).toContain('handoff=[set]')
        } finally {
          delete process.env.OPEN_SCIENCE_TEST_SECRET
        }
      }
    )

    it('returns the process non-zero exit code instead of throwing', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'exit 3'
      })

      expect(result.exitCode).toBe(3)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({
        kernelKind: 'bash',
        script: 'exit 3',
        status: 'failed'
      })
    })

    it('kills a command that outlasts the timeout and returns a non-normal result', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      const startedAt = Date.now()
      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'sleep 5',
        timeoutMs: 100
      })
      const elapsedMs = Date.now() - startedAt

      // The promise settles on the timeout, not after the full sleep duration.
      expect(elapsedMs).toBeLessThan(4000)
      expect(result.exitCode).not.toBe(0)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({
        kernelKind: 'bash',
        script: 'sleep 5',
        status: 'timeout'
      })
    })

    it('spawns a fresh process per call instead of reusing a persistent shell', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'FOO=bar'
      })
      // A persistent shell would remember FOO from the previous call; a fresh process never does.
      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'echo "[$FOO]"'
      })

      expect(result.stdout).toContain('[]')

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      // Each executeShell call produces its own record: two calls, two distinct runIds.
      expect(state.runs).toHaveLength(2)
      expect(state.runs.every((run) => run.kernelKind === 'bash')).toBe(true)
      expect(new Set(state.runs.map((run) => run.runId)).size).toBe(2)
    })

    // POSIX-only: relies on `trap '' TERM` (a SIGTERM-ignoring shell) and pgrep to inspect the real
    // process table — neither exists on Windows, where signal semantics differ entirely.
    it.skipIf(process.platform === 'win32')(
      'SIGKILLs a timed-out command that ignores SIGTERM instead of leaving it running',
      async () => {
        const root = await createStorageRoot()
        const service = new NotebookRuntimeService({
          configRoot: root,
          dataRoot: root,
          projectName: 'default-project',
          repository: new NotebookRunRepository(root)
        })
        // A marker unique to this test run, embedded as a harmless shell comment so it shows up in the
        // spawned process's command line (visible to pgrep -f) without affecting what the shell runs.
        const marker = `os-notebook-shell-test-${randomUUID()}`

        const result = await service.executeShell({
          sessionId: 'session-1',
          workspaceCwd: root,
          // Ignores SIGTERM; only SIGKILL can end it before its own 30s sleep completes.
          command: `trap '' TERM; sleep 30 # ${marker}`,
          timeoutMs: 100
        })

        // The RPC promise settles at the timeout, well before either the grace period or the sleep.
        expect(result.exitCode).toBeNull()

        // Poll the real process table until the marked process is gone -- not child.killed, which Node
        // sets as soon as SIGTERM is delivered regardless of whether the (SIGTERM-ignoring) process
        // actually died. Polling (rather than a single fixed sleep) absorbs SIGKILL-escalation +
        // process-teardown latency on a loaded CI runner, so the test isn't timing-flaky; if SIGKILL
        // never worked, it stays non-empty until the deadline and the assertion fails.
        const pgrepMarker = async (): Promise<string> =>
          new Promise<string>((resolve) => {
            const check = spawn('sh', ['-c', `pgrep -f '${marker}' || true`])
            let out = ''
            check.stdout.on('data', (chunk: Buffer) => {
              out += chunk.toString('utf8')
            })
            check.once('exit', () => resolve(out.trim()))
          })

        let stillRunning = await pgrepMarker()
        const deadline = Date.now() + 10_000
        while (stillRunning !== '' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500))
          stillRunning = await pgrepMarker()
        }

        expect(stillRunning).toBe('')
      },
      15_000
    )

    it('records two distinct runs for overlapping calls instead of colliding (no serialization queue)', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      // Two calls fired without awaiting between them: executeShell has no per-session serialization
      // queue, so both spawn immediately, relying on the repository's own write-serialization to keep
      // their running/completed records from clobbering each other.
      const [okResult, failResult] = await Promise.all([
        service.executeShell({ sessionId: 'session-1', workspaceCwd: root, command: 'echo one' }),
        service.executeShell({ sessionId: 'session-1', workspaceCwd: root, command: 'exit 5' })
      ])

      expect(okResult.exitCode).toBe(0)
      expect(failResult.exitCode).toBe(5)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs).toHaveLength(2)
      expect(new Set(state.runs.map((run) => run.runId)).size).toBe(2)
      expect(new Set(state.runs.map((run) => run.cellId)).size).toBe(2)

      const statuses = state.runs.map((run) => run.status).sort()
      expect(statuses).toEqual(['completed', 'failed'])
      expect(state.runs.every((run) => run.kernelKind === 'bash')).toBe(true)
    })
  })

  it('returns null when a session has no persisted notebook run history', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })

    const reference = await service.getSessionReference({
      projectName: 'default-project',
      sessionId: 'never-used',
      workspaceCwd: '/workspace'
    })

    expect(reference).toBeNull()
  })

  it('rebuilds a session reference from persisted run.json without a live runtime session', async () => {
    const root = await createStorageRoot()

    // Execute against one service instance, then throw it away to simulate an app restart.
    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: 'done\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await firstService.execute({
      projectName: 'default-project',
      sessionId: 'restored-session',
      workspaceCwd: '/workspace',
      code: "print('done')"
    })

    // A fresh service has no in-memory session, mirroring the state after relaunch.
    const restartedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })

    const reference = await restartedService.getSessionReference({
      sessionId: 'restored-session',
      workspaceCwd: '/workspace'
    })

    expect(reference).toMatchObject({
      sessionId: 'restored-session',
      projectName: 'default-project',
      workspaceCwd: '/workspace',
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'restored-session'),
      dataRoot: join(root, 'notebooks', 'default-project', 'restored-session', 'data'),
      runtimeRoot: join(root, 'runtime'),
      runJsonPath: join(root, 'notebooks', 'default-project', 'restored-session', 'run.json')
    })
  })

  it('recovers an interrupted download by cleaning orphan staging + clearing the journal (WS13)', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = join(root, 'runtime')
    // Simulate a process killed mid-download: an orphan .incoming-* staging dir + its journal entry.
    const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
    await mkdir(staging, { recursive: true })
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'd',
      kind: 'download',
      runtimeId: 'python-3.12',
      phase: 'fetch',
      startedAt: 100,
      targetPath: staging
    })

    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    await service.recoverInterruptedOperations()

    // The orphan staging dir is removed and the journal entry is cleared (not reprocessed next boot).
    expect(existsSync(staging)).toBe(false)
    expect(await journal.pending()).toEqual([])
  })

  it('reconciles a stale running run to interrupted on first load after a crash (WS12)', async () => {
    const root = await createStorageRoot()

    // Simulate a prior process that died mid-run: persist a run left in 'running'.
    const priorRepo = new NotebookRunRepository(root)
    await priorRepo.loadOrCreate({
      projectName: 'default-project',
      sessionId: 'crashed',
      workspaceCwd: '/workspace'
    })
    await priorRepo.appendRun({
      projectName: 'default-project',
      sessionId: 'crashed',
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: 'long()',
        status: 'running',
        startedAt: 100,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    // A fresh service loading the session reconciles the stale run (no live kernel exists for it).
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const state = await service.state({ sessionId: 'crashed', workspaceCwd: '/workspace' })
    expect(state.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'interrupted',
      interruptionReason: 'app-terminated'
    })
  })

  it('serializes overlapping runs on the shared interpreter instead of failing the second', async () => {
    const root = await createStorageRoot()
    let active = 0
    let maxConcurrent = 0
    const releases: Array<() => void> = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          active += 1
          maxConcurrent = Math.max(maxConcurrent, active)

          // Mirror the real single-slot executor: a second concurrent execution is rejected.
          if (active > 1) {
            active -= 1
            throw new Error('Notebook execution is already running.')
          }

          // Hold this execution open so a second run can attempt to overlap with it.
          await new Promise<void>((resolve) => releases.push(resolve))
          active -= 1

          return {
            status: 'completed',
            stdout: `${request.code}\n`,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const submit = (code: string): Promise<unknown> =>
      service.execute({
        projectName: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code,
        source: 'user',
        inputKind: 'terminal'
      })

    const first = submit("print('a')")
    // Wait until the first run has actually entered the executor and is holding the single slot.
    await vi.waitFor(() => expect(releases).toHaveLength(1))

    const second = submit("print('b')")
    // Give the second run a chance to (wrongly) reach the executor while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // With serialization the second run is still queued, so only the first has entered the executor.
    expect(releases).toHaveLength(1)

    // Drain the first run; the second should then take the freed slot and run on its own.
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()

    const [firstSummary, secondSummary] = (await Promise.all([first, second])) as Array<{
      status: string
    }>

    expect(maxConcurrent).toBe(1)
    expect(firstSummary.status).toBe('completed')
    expect(secondSummary.status).toBe('completed')

    const rawRunJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )
    const document = JSON.parse(rawRunJson) as Awaited<
      ReturnType<NotebookRunRepository['loadOrCreate']>
    >
    expect(document.runs).toHaveLength(2)
    expect(document.runs.every((run) => run.status === 'completed')).toBe(true)
  })

  it('runs different sessions in parallel instead of serializing across sessions', async () => {
    const root = await createStorageRoot()
    let active = 0
    let maxConcurrent = 0
    const releases = new Map<string, () => void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      // Each session gets its own executor; the shared counter proves both can be in flight at once.
      executorFactory: (sessionId) => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          active += 1
          maxConcurrent = Math.max(maxConcurrent, active)

          // Hold each session's execution open until released so both can overlap.
          await new Promise<void>((resolve) => releases.set(sessionId, resolve))
          active -= 1

          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const submit = (sessionId: string): Promise<unknown> =>
      service.execute({
        projectName: 'default-project',
        sessionId,
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user',
        inputKind: 'terminal'
      })

    const runA = submit('session-a')
    const runB = submit('session-b')

    // Both sessions should be inside their own executors at the same time — the per-session queue
    // must not serialize one session behind another.
    await vi.waitFor(() => expect(releases.size).toBe(2))
    expect(maxConcurrent).toBe(2)

    releases.get('session-a')?.()
    releases.get('session-b')?.()
    await Promise.all([runA, runB])
  })

  it('threads the cell language to the executor (default python)', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1 + 1'
    })

    expect(executions).toHaveLength(1)
    expect(executions[0].language).toBe('python')

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].kernelKind).toBe('python')
  })

  it('threads an explicit r language from the execute request to the executor', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1 + 1',
      language: 'r'
    })

    expect(executions).toHaveLength(1)
    expect(executions[0].language).toBe('r')

    // Guards the I1 mislabel: an R cell run must record kernelKind 'r', not the python default.
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].kernelKind).toBe('r')
  })

  it('restart calls executor.restart when the executor supports it', async () => {
    const root = await createStorageRoot()
    let restarts = 0
    let shutdowns = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => {
          shutdowns += 1
          return { reaped: true }
        },
        restart: async () => {
          restarts += 1
        }
      })
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await service.restart({ sessionId: 'session-1', workspaceCwd: root })

    expect(restarts).toBe(1)
    // In-place restart keeps the same executor instance, so no shutdown+recreate is needed.
    expect(shutdowns).toBe(0)
  })

  it('reports a restarting kernel status while restart() is in flight, then settles to idle', async () => {
    const root = await createStorageRoot()
    let releaseRestart: (() => void) | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart: () =>
          new Promise<void>((resolve) => {
            releaseRestart = resolve
          })
      })
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    const restarting = service.restart({ sessionId: 'session-1', workspaceCwd: root })
    // Wait for restart() to reach and await executor.restart() (the in-flight window).
    await vi.waitFor(() => expect(releaseRestart).toBeDefined())

    const midFlight = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(midFlight.kernelStatus).toBe('restarting')

    releaseRestart?.()
    const settled = await restarting

    expect(settled.kernelStatus).toBe('idle')
  })

  it('idle-shutdown reports a terminated kernel status and notifies listeners', async () => {
    const root = await createStorageRoot()
    const changedSessions: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      callbacks: {
        onNotebookChanged: (event) => changedSessions.push(event.sessionId)
      },
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    // Establishes the runtime session (and its persisted run.json) the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    // Simulates NotebookKernelExecutor's onIdleShutdown firing after its idle window elapses. The
    // executorFactory branch above never wires this callback (only the default real-executor branch
    // does, see createExecutor); this exercises the persistence+notify logic it calls directly.
    await (
      service as unknown as {
        handleKernelIdleShutdown: (sessionId: string, projectName: string) => Promise<void>
      }
    ).handleKernelIdleShutdown('session-1', 'default-project')

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.kernelStatus).toBe('terminated')
    expect(changedSessions).toContain('session-1')
  })

  it('clears a stale terminated status once a run completes on the transparently respawned kernel', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    // Establishes the runtime session and persisted run.json the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    // Simulates the executor's own idle timer dropping the proc between runs (see the
    // 'idle-shutdown reports a terminated kernel status' test above for the same mechanism).
    await (
      service as unknown as {
        handleKernelIdleShutdown: (sessionId: string, projectName: string) => Promise<void>
      }
    ).handleKernelIdleShutdown('session-1', 'default-project')

    const afterShutdown = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterShutdown.kernelStatus).toBe('terminated')

    // The next execute() transparently respawns a fresh kernel (executorFactory above never actually
    // dies), so the run completes normally — the persisted status must no longer read 'terminated'.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    const afterRespawn = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterRespawn.kernelStatus).toBe('idle')
  })

  it('clears a stale terminated status once a control-plane run completes on the respawned kernel', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    // Establishes the runtime session and persisted run.json the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    await (
      service as unknown as {
        handleKernelIdleShutdown: (sessionId: string, projectName: string) => Promise<void>
      }
    ).handleKernelIdleShutdown('session-1', 'default-project')

    const afterShutdown = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterShutdown.kernelStatus).toBe('terminated')

    await service.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    const afterRespawn = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterRespawn.kernelStatus).toBe('idle')
  })

  describe('lifecycle & concurrency (G2/G3/G4/G5)', () => {
    // Executor double that holds each run open until released, recording every start so a test can
    // observe how many runs are concurrently in flight and in what order.
    const holdingService = (
      root: string,
      onStart: (request: NotebookExecutionRequest, release: () => void) => void
    ): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            await new Promise<void>((resolve) => onStart(request, resolve))
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

    it('writes a running kernel status during a live run, then settles to idle (G4)', async () => {
      const root = await createStorageRoot()
      let release: (() => void) | undefined
      const service = holdingService(root, (_request, resolve) => {
        release = resolve
      })

      const run = service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
      await vi.waitFor(() => expect(release).toBeDefined())

      // The kernel reads 'running' while the run is in flight (G4: the union member is now written).
      const midFlight = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(midFlight.kernelStatus).toBe('running')

      release?.()
      await run
      const settled = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(settled.kernelStatus).toBe('idle')
    })

    it('runs python and r concurrently while serializing same-language runs (G5)', async () => {
      const root = await createStorageRoot()
      let active = 0
      let maxConcurrent = 0
      const releases: Array<{ language?: string; release: () => void }> = []
      const service = holdingService(root, (request, resolve) => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        releases.push({ language: request.language, release: resolve })
      })
      // Undo the shared active counter as each held run is released.
      const drain = (entry: { release: () => void }): void => {
        active -= 1
        entry.release()
      }

      // Pre-create the cells sequentially (the write-lock dance can't run concurrently), then fire the
      // runs at once so the per-kind execution queues — not the write lock — govern concurrency.
      const makeCell = async (cellId: string, language: 'python' | 'r'): Promise<void> => {
        const begin = await service.beginCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          cellId,
          language
        })
        await service.appendCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          writeId: begin.writeId,
          cellId,
          delta: '1'
        })
        await service.finishCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          writeId: begin.writeId,
          cellId
        })
      }
      await makeCell('py1', 'python')
      await makeCell('r1', 'r')
      await makeCell('py2', 'python')

      const py1 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'py1' })
      const r1 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'r1' })
      const py2 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'py2' })

      // python and r are independent processes → both enter the executor at once; the second python
      // queues behind the first, so exactly two runs (one python, one r) are in flight.
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(releases).toHaveLength(2)
      expect(maxConcurrent).toBe(2)
      expect(releases.map((entry) => entry.language).sort()).toEqual(['python', 'r'])

      // Drain the first python; the queued second python now takes the freed python slot (still only
      // two concurrent, never three).
      drain(releases.find((entry) => entry.language === 'python')!)
      await vi.waitFor(() => expect(releases).toHaveLength(3))
      expect(maxConcurrent).toBe(2)

      releases.forEach((entry) => entry.release())
      await Promise.all([py1, r1, py2])
    })

    it('blocks a package install on the same language until an in-flight run finishes (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseRun: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:start')
            await new Promise<void>((resolve) => {
              releaseRun = resolve
            })
            events.push('run:end')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:run')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      await vi.waitFor(() => expect(releaseRun).toBeDefined())

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      // The install (exclusive writer) must not start while the run holds the python env read lock.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toEqual(['run:start'])

      releaseRun?.()
      await Promise.all([run, install])
      expect(events).toEqual(['run:start', 'run:end', 'install:run'])
    })

    it('blocks a run on the same language until an in-flight install finishes (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:run')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          events.push('install:end')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      // The run (reader) must wait out the install (exclusive writer) on the same env.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toEqual(['install:start'])

      releaseInstall?.()
      await Promise.all([install, run])
      expect(events).toEqual(['install:start', 'install:end', 'run:run'])
    })

    it('does not block a different-language run behind an install (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push(`run:${request.language}`)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:python:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      // An r run proceeds to completion even while a python install holds the python env lock — the
      // lock is keyed per language, so it only blocks the target env's queue.
      const rRun = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'r'
      })
      expect(rRun.status).toBe('completed')
      expect(events).toContain('run:r')

      releaseInstall?.()
      await install
    })

    it('leaves a terminated kernel status after a run whose kernel rejected (G3)', async () => {
      const root = await createStorageRoot()
      // eslint-disable-next-line prefer-const -- forward ref: the executor closure captures svc before `service` exists
      let svc: NotebookRuntimeService | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (): Promise<NotebookExecutionResult> => {
            // Simulate the executor's onTerminated firing mid-run (crash), then the run rejecting so
            // the runtime service's executor-rejection path sets executedOnLiveKernel false.
            await (
              svc as unknown as {
                handleKernelTerminated: (s: string, p: string, k: string) => Promise<void>
              }
            ).handleKernelTerminated('session-1', 'default-project', 'python')
            throw new Error('Notebook kernel process exited.')
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      svc = service

      const summary = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(summary.status).toBe('failed')

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.kernelStatus).toBe('terminated')
    })

    it('does not overwrite a mid-run termination with idle when the executor resolves (G3)', async () => {
      const root = await createStorageRoot()
      // eslint-disable-next-line prefer-const -- forward ref: the executor closure captures svc before `service` exists
      let svc: NotebookRuntimeService | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            // The real executor catches a crash internally and RESOLVES a failed result while its
            // onTerminated callback fires — the terminatedKernels guard must still keep 'terminated'.
            await (
              svc as unknown as {
                handleKernelTerminated: (s: string, p: string, k: string) => Promise<void>
              }
            ).handleKernelTerminated('session-1', 'default-project', 'python')
            return {
              status: 'failed',
              stdout: '',
              stderr: 'boom',
              traceback: 'boom',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      svc = service

      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.kernelStatus).toBe('terminated')
    })

    it('clears a crash terminated status once a clean run of that kind completes (G3)', async () => {
      const root = await createStorageRoot()
      let mode: 'crash' | 'ok' = 'crash'
      // eslint-disable-next-line prefer-const -- forward ref: the executor closure captures svc before `service` exists
      let svc: NotebookRuntimeService | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            if (mode === 'crash') {
              await (
                svc as unknown as {
                  handleKernelTerminated: (s: string, p: string, k: string) => Promise<void>
                }
              ).handleKernelTerminated('session-1', 'default-project', 'python')
              return {
                status: 'failed',
                stdout: '',
                stderr: 'boom',
                traceback: 'boom',
                cwdAfter: request.cwd,
                outputs: []
              }
            }
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      svc = service

      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('terminated')

      // The next clean run of the same kind clears the flag at run start and settles back to 'idle'.
      mode = 'ok'
      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '2',
        language: 'python'
      })
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('idle')
    })
  })

  it('restart falls back to shutdown+recreate when the executor has no restart()', async () => {
    const root = await createStorageRoot()
    let shutdowns = 0
    let factoryCalls = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => {
        factoryCalls += 1
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => {
            shutdowns += 1
            return { reaped: true }
          }
        }
      }
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    expect(factoryCalls).toBe(1)

    await service.restart({ sessionId: 'session-1', workspaceCwd: root })

    expect(shutdowns).toBe(1)
    expect(factoryCalls).toBe(2)
  })

  it('surfaces (without throwing) when the session cwd has disappeared before a run', async () => {
    const root = await createStorageRoot()
    // A cell can os.chdir() to a directory outside the repository-managed session tree (whose
    // sub-directories are recreated on every write); simulate that, then delete it.
    const changedCwd = await mkdtemp(join(tmpdir(), 'open-science-notebook-chdir-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: changedCwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    // First run establishes the session and leaves it chdir'd into a real (temp) directory.
    const first = await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    expect(first.status).toBe('completed')

    // The directory the interpreter last chdir'd into is now gone.
    await rm(changedCwd, { recursive: true, force: true })

    const second = await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    expect(second.status).toBe('completed')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Session cwd is missing'))

    errorSpy.mockRestore()
  })

  describe('managePackages', () => {
    it('resolves the effective mirror from the injected getPackageMirror + locale and forwards it as installPackages deps', async () => {
      const root = await createStorageRoot()
      const calls: Array<[InstallRequestForTest, Partial<InstallDepsForTest> | undefined]> = []
      const scriptedResult: InstallResultForTest = { ok: true, needsRestart: false, log: 'done' }
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        getPackageMirror: () => ({ pypiIndex: 'https://corp.example/simple' }),
        locale: 'zh-CN',
        installPackagesImpl: async (request, deps) => {
          calls.push([request, deps])
          return scriptedResult
        }
      })

      const request: InstallRequestForTest = {
        language: 'python',
        packages: ['numpy'],
        usePip: true
      }
      const result = await service.managePackages(request)

      expect(result).toBe(scriptedResult)
      expect(calls).toHaveLength(1)
      // The service forwards the request with the install target PINNED to the binding-resolved env
      // (default-python here), so it is a copy of the original fields plus `environment`, not the same
      // object reference (the service pins the install target to the binding-resolved env).
      expect(calls[0][0]).toEqual({ ...request, environment: DEFAULT_PY_ENV })
      // The configured pypiIndex overrides the CN region default entirely (effectiveMirror semantics):
      // a configured field wins outright, so condaChannel/cranMirror stay unset rather than CN defaults.
      expect(calls[0][1]).toMatchObject({
        storageRoot: root,
        pypiIndex: 'https://corp.example/simple'
      })
      expect(calls[0][1]?.condaChannel).toBeUndefined()
      expect(calls[0][1]?.cranMirror).toBeUndefined()
    })

    it('falls back to the region default mirror when nothing is configured', async () => {
      const root = await createStorageRoot()
      const calls: Array<Partial<InstallDepsForTest> | undefined> = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        getPackageMirror: () => undefined,
        locale: 'zh-CN',
        // Force the latency probe to find nothing reachable so the resolver takes the deterministic
        // locale fallback (zh-CN -> CN mirror) instead of racing real network from the CI runner,
        // where the public mirror wins and leaves condaChannel unset.
        mirrorProbe: {
          probe: async () => {
            throw new Error('probe unreachable (test)')
          }
        },
        installPackagesImpl: async (_request, deps) => {
          calls.push(deps)
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      // Clear any mirror cached by an earlier test so the injected probe actually runs.
      resetAutoMirrorCache()
      await service.managePackages({ language: 'r', packages: ['ggplot2'] })

      expect(calls[0]?.condaChannel).toMatch(/tuna|ustc|aliyun/i)
      expect(calls[0]?.cranMirror).toMatch(/tuna|ustc/i)
    })

    it('never spawns real installs when installPackagesImpl is injected (no getPackageMirror wired)', async () => {
      const root = await createStorageRoot()
      let called = false
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          called = true
          return { ok: false, needsRestart: false, log: '', error: 'boom' }
        }
      })

      const result = await service.managePackages({ language: 'python', packages: ['seaborn'] })

      expect(called).toBe(true)
      expect(result.error).toBe('boom')
    })
  })

  describe('default executor factory (D-B4)', () => {
    afterEach(() => {
      delete process.env.OPEN_SCIENCE_PYTHON_LOOP
      delete process.env.OPEN_SCIENCE_R_LOOP
      delete process.env.OPEN_SCIENCE_REPL_LOOP
    })

    it('returns only the three exec-loop script paths (de-pinned: no single pythonBin/rEnvPrefix)', async () => {
      await createStorageRoot()
      const options = resolveDefaultExecutorOptions()

      // The executor now derives each interpreter prefix per request (from request.runtimeRoot + the
      // resolved env name), so the default options no longer pin a single env's bin/prefix.
      expect(options.pythonBin).toBeUndefined()
      expect(options.rEnvPrefix).toBeUndefined()
      // Resolved against the real repo tree (not the temp storage root), so these should exist.
      expect(options.pythonLoopPath).toMatch(/python_loop\.py$/)
      expect(options.rLoopPath).toMatch(/r_loop\.R$/)
      expect(options.replLoopPath).toMatch(/repl_loop\.js$/)
      expect(existsSync(options.pythonLoopPath as string)).toBe(true)
      expect(existsSync(options.rLoopPath as string)).toBe(true)
      expect(existsSync(options.replLoopPath as string)).toBe(true)
    })

    it('honors OPEN_SCIENCE_PYTHON_LOOP / OPEN_SCIENCE_R_LOOP / OPEN_SCIENCE_REPL_LOOP overrides', () => {
      process.env.OPEN_SCIENCE_PYTHON_LOOP = '/tmp/custom-python-loop.py'
      process.env.OPEN_SCIENCE_R_LOOP = '/tmp/custom-r-loop.R'
      process.env.OPEN_SCIENCE_REPL_LOOP = '/tmp/custom-repl-loop.js'

      expect(resolveLoopScriptPaths()).toEqual({
        pythonLoopPath: '/tmp/custom-python-loop.py',
        rLoopPath: '/tmp/custom-r-loop.R',
        replLoopPath: '/tmp/custom-repl-loop.js'
      })
    })

    it('builds a NotebookKernelExecutor by default (no executorFactory injected)', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      // beginCodeCell creates the runtime session (and thus the default executor) without ever
      // spawning a loop -- spawning is deferred to the first execute(). Reach into the private
      // session map to prove the default backend is the exec-loop executor, python and r as two
      // independent persistent processes rather than a single restart-on-language-switch kernel.
      await service.beginCodeCell({ sessionId: 'session-1', workspaceCwd: root })
      const executor = (
        service as unknown as { sessions: Map<string, { executor: unknown }> }
      ).sessions.get('session-1')?.executor

      expect(executor).toBeInstanceOf(NotebookKernelExecutor)
    })
  })

  describe('named environments (D1/D4/D5/D2)', () => {
    const recordingService = (
      root: string,
      executions: NotebookExecutionRequest[]
    ): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            executions.push(request)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

    it('auto-provisions a missing default env on demand, but not a named env or an existing default', async () => {
      const root = await createStorageRoot()
      const service = recordingService(root, [])
      const provisionR = vi.fn(async () => undefined)
      const provisionPython = vi.fn(async () => undefined)
      service.setDefaultEnvProvisioner({ provisionPython, provisionR })

      // default-r missing → an R run (unbound → managed default) triggers provisionR (build on demand).
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })
      expect(provisionR).toHaveBeenCalledTimes(1)
      expect(provisionPython).not.toHaveBeenCalled()

      // An already-materialized default env is not re-provisioned.
      const rBinPath = join(root, 'runtime', 'envs', 'default-r', 'bin', 'R')
      await mkdir(join(rBinPath, '..'), { recursive: true })
      await writeFile(rBinPath, '')
      writeRReadyMarker(join(root, 'runtime'), DEFAULT_ENV_VERSION, 'now')
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '2', language: 'r' })
      expect(provisionR).toHaveBeenCalledTimes(1)
    })

    it('broadcasts lazy provisioning progress and records its root cause as a failed run', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)
      const progress: Array<{ phase: string; message: string; progress: number }> = []
      service.setDefaultEnvProvisioner(
        {
          provisionPython: async () => undefined,
          provisionR: async (onProgress) => {
            onProgress({ phase: 'fetch-r', message: 'Downloading R runtime', progress: 0.4 })
            throw new Error('checksum mismatch')
          }
        },
        (event) => progress.push(event)
      )

      const run = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'r'
      })

      expect(executions).toHaveLength(0)
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toContain('Could not prepare default-r: checksum mismatch')
      expect(progress).toEqual([
        { phase: 'fetch-r', message: 'Downloading R runtime', progress: 0.4 },
        {
          phase: 'error',
          message: 'Could not prepare default-r: checksum mismatch',
          progress: 0
        }
      ])
    })

    it('threads the binding-resolved env to the executor and records it on the run', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)

      // Unbound python → the app-managed default env; v4 always threads the resolved env name to the
      // executor (not a per-call argument) and records it on the run for history/replay.
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      expect(executions[0].environment).toBe('default-python')
      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runs[0].environment).toBe('default-python')
    })

    it('blocks a run on the same bound env until an in-flight install into that env finishes (D5)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:run')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          events.push('install:end')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The run (reader) waits out the install (writer) on the SAME (default) env.
      expect(events).toEqual(['install:start'])

      releaseInstall?.()
      await Promise.all([install, run])
      expect(events).toEqual(['install:start', 'install:end', 'run:run'])
    })

    it('does not block a run in a different env behind an install (D5)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      // v4: a session runs ONE env per language, so "different envs" now means different SESSIONS —
      // an installer session bound to a named env vs a runner session on the app-managed default.
      const namedPy = join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python')
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        // Surface the named agent-created env so the installer session can bind it.
        discoverRuntimes: async (language) =>
          language === 'python'
            ? [
                {
                  language: 'python',
                  provenance: 'agent-created',
                  envId: namedPy,
                  interpreterPath: namedPy,
                  label: 'my-analysis',
                  condaEnv: 'my-analysis',
                  version: '3.12',
                  runnable: true
                }
              ]
            : [],
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push(`run:${request.environment ?? 'default'}`)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:my-analysis:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      // Installer session bound to the named env -> its install holds the 'my-analysis' env lock.
      await service.bindRuntime({
        sessionId: 'installer',
        workspaceCwd: root,
        language: 'python',
        runtimeId: namedPy
      })
      const install = service.managePackages({
        sessionId: 'installer',
        language: 'python',
        packages: ['numpy']
      })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      // A run in a DIFFERENT session on the DEFAULT python env proceeds while the my-analysis install
      // holds only its own env lock — the lock is keyed by resolved env name, not language.
      const run = await service.execute({
        sessionId: 'runner',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(run.status).toBe('completed')
      expect(events).toContain('run:default-python')

      releaseInstall?.()
      await install
    })

    it('manageEnvironments create/list/remove delegates to the injected environment manager', async () => {
      const root = await createStorageRoot()
      const envs: EnvironmentInfo[] = [
        { name: 'default-python', language: 'python', ready: true, isDefault: true }
      ]
      const created: Array<{ name: string; language: string; packages?: string[] }> = []
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language, packages) => {
            created.push({ name, language, packages })
            const info: EnvironmentInfo = { name, language, ready: true, isDefault: false }
            envs.push(info)
            return info
          },
          listEnvironments: () => [...envs],
          removeEnvironment: (name) => {
            removed.push(name)
            return envs.filter((env) => env.name !== name)
          }
        }
      })

      const createResult = await service.manageEnvironments({
        action: 'create',
        language: 'python',
        name: 'my-analysis',
        packages: ['numpy']
      })
      expect(created).toEqual([{ name: 'my-analysis', language: 'python', packages: ['numpy'] }])
      expect(createResult.environments.map((env) => env.name)).toEqual([
        'default-python',
        'my-analysis'
      ])

      const listResult = await service.manageEnvironments({ action: 'list' })
      expect(listResult.environments.map((env) => env.name)).toEqual([
        'default-python',
        'my-analysis'
      ])

      const removeResult = await service.manageEnvironments({
        action: 'remove',
        name: 'my-analysis'
      })
      expect(removed).toEqual(['my-analysis'])
      expect(removeResult.environments.map((env) => env.name)).toEqual(['default-python'])
    })

    it('named-env create awaits crash recovery before writing a prefix (barrier)', async () => {
      // create writes into <root>/envs, so it must wait for startup recovery to finish reconciling —
      // otherwise recovery's cleanup/verify could race the fresh create. Seed an interrupted op so
      // recovery has real async work, kick it off, then create WITHOUT awaiting recovery and assert the
      // create only runs after recovery settled.
      const root = await createStorageRoot()
      const runtimeRoot = join(root, 'runtime')
      const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
      await mkdir(staging, { recursive: true })
      const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'd',
        kind: 'download',
        runtimeId: 'python-3.12',
        phase: 'fetch',
        startedAt: 100,
        targetPath: staging
      })

      let recoveryDone = false
      const order: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language) => {
            // The observable check: recovery MUST have settled before create touches the prefix.
            order.push(recoveryDone ? 'create-after-recovery' : 'create-before-recovery')
            return { name, language, ready: true, isDefault: false }
          },
          listEnvironments: () => [],
          removeEnvironment: () => []
        }
      })

      // Kick off recovery (do NOT await) and mark when it settles, then immediately create.
      const recovery = service.recoverInterruptedOperations().then(() => {
        recoveryDone = true
        order.push('recovery-done')
      })
      await service.manageEnvironments({
        action: 'create',
        language: 'python',
        name: 'my-analysis'
      })
      await recovery

      expect(order).toEqual(['recovery-done', 'create-after-recovery'])
    })

    it('named-env remove awaits crash recovery before rm -rf a prefix (barrier)', async () => {
      // remove rm -rf's a prefix, so — like create — it must wait for recovery to finish reconciling, or
      // recovery's verify/rebuild could race the delete. Seed an interrupted op for real async recovery
      // work, kick recovery off, remove WITHOUT awaiting it, and assert the delete ran only after
      // recovery settled.
      const root = await createStorageRoot()
      const runtimeRoot = join(root, 'runtime')
      const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
      await mkdir(staging, { recursive: true })
      const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'd',
        kind: 'download',
        runtimeId: 'python-3.12',
        phase: 'fetch',
        startedAt: 100,
        targetPath: staging
      })

      let recoveryDone = false
      const order: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language) => ({
            name,
            language,
            ready: true,
            isDefault: false
          }),
          listEnvironments: () => [],
          removeEnvironment: () => {
            order.push(recoveryDone ? 'remove-after-recovery' : 'remove-before-recovery')
            return []
          }
        }
      })

      const recovery = service.recoverInterruptedOperations().then(() => {
        recoveryDone = true
        order.push('recovery-done')
      })
      // 'my-analysis' is agent-created provenance, so it passes the remove guard.
      await service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
      await recovery

      expect(order).toEqual(['recovery-done', 'remove-after-recovery'])
    })

    it('refuses to remove an environment that is in use by a live kernel', async () => {
      const root = await createStorageRoot()
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        discoverRuntimes: async (language) =>
          language === 'python'
            ? [
                {
                  language: 'python',
                  provenance: 'agent-created',
                  envId: join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python'),
                  interpreterPath: join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python'),
                  label: 'my-analysis',
                  condaEnv: 'my-analysis',
                  version: '3.12',
                  runnable: true
                }
              ]
            : [],
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        environmentManager: {
          createNamedEnvironment: async (name, language) => ({
            name,
            language,
            ready: true,
            isDefault: false
          }),
          listEnvironments: () => [],
          removeEnvironment: (name) => {
            removed.push(name)
            return []
          }
        }
      })

      // Bind the named env, then a completed run leaves the my-analysis python proc live (idle, not
      // terminated) — a run now targets the bound env, not a per-call environment argument.
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python')
      })
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      await expect(
        service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
      ).rejects.toThrow(/in use by a running kernel/)
      expect(removed).toEqual([])

      // A different env with no live proc is removable.
      await service.manageEnvironments({ action: 'remove', name: 'other-env' })
      expect(removed).toEqual(['other-env'])
    })

    it('rejects hostile / reserved environment names before touching the manager (security)', async () => {
      const root = await createStorageRoot()
      const created: string[] = []
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        environmentManager: {
          createNamedEnvironment: async (name, language) => {
            created.push(name)
            return { name, language, ready: true, isDefault: false }
          },
          listEnvironments: () => [],
          removeEnvironment: (name) => {
            removed.push(name)
            return []
          }
        }
      })

      // Path traversal must never reach removeEnvironment's rm -rf (the ship-blocking finding).
      await expect(
        service.manageEnvironments({ action: 'remove', name: '../../../../tmp/victim' })
      ).rejects.toThrow(/Invalid environment name/)
      // Reserved/default/alias names are refused on create so a created env is always reachable.
      for (const reserved of ['python', 'r', 'default-python', 'default-r']) {
        await expect(
          service.manageEnvironments({ action: 'create', language: 'python', name: reserved })
        ).rejects.toThrow(/reserved environment name/)
      }
      // create without a language is a clean domain error, not a raw crash.
      await expect(
        service.manageEnvironments({
          action: 'create',
          name: 'x'
        } as unknown as Parameters<typeof service.manageEnvironments>[0])
      ).rejects.toThrow(/requires a language/)

      expect(created).toEqual([])
      expect(removed).toEqual([])
    })

    it('surfaces the resolved per-env kernel status in state().environments', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.environments).toContainEqual({
        processKey: 'python:default-python',
        kind: 'python',
        environment: 'default-python',
        status: 'idle',
        restartRecommended: false
      })
    })

    it('flags restartRecommended on the R env after an R install and clears it on restart', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        // An R install reports needsRestart; a Python install would not (asserted below).
        installPackagesImpl: async (request) => ({
          ok: true,
          needsRestart: request.language === 'r',
          log: 'done'
        })
      })

      // Spawn the R kernel status entry so the env view has something to flag.
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })

      const rEntry = (
        s: Awaited<ReturnType<typeof service.state>>
      ): NotebookEnvironmentStatus | undefined =>
        s.environments.find((entry) => entry.processKey === 'r:default-r')

      await service.managePackages({ language: 'r', packages: ['ggplot2'] })
      const afterInstall = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(rEntry(afterInstall)?.restartRecommended).toBe(true)

      await service.restart({ sessionId: 's', workspaceCwd: root })
      const afterRestart = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(rEntry(afterRestart)?.restartRecommended).toBe(false)
    })

    it('does not flag restartRecommended for a Python install', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: 'done' })
      })

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
      await service.managePackages({ language: 'python', packages: ['numpy'], usePip: true })
      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(
        state.environments.find((entry) => entry.processKey === 'python:default-python')
          ?.restartRecommended
      ).toBe(false)
    })
  })
})

describe('v4 runtime bindings & agent tools', () => {
  const managedPy: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'app-managed',
    envId: '/root/runtime/envs/default-python/bin/python',
    interpreterPath: '/root/runtime/envs/default-python/bin/python',
    label: 'default-python',
    version: '3.12.0',
    runnable: true
  }
  const userPyA: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'user-own',
    envId: '/usr/bin/python3',
    interpreterPath: '/usr/bin/python3',
    label: '/usr/bin/python3',
    version: '3.11.0',
    runnable: true
  }
  const userPyB: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'user-own',
    envId: '/opt/py/bin/python3',
    interpreterPath: '/opt/py/bin/python3',
    label: '/opt/py/bin/python3',
    version: '3.10.0',
    runnable: true
  }
  const managedR: DiscoveredInterpreter = {
    language: 'r',
    provenance: 'app-managed',
    envId: '/root/runtime/envs/default-r/bin/R',
    interpreterPath: '/root/runtime/envs/default-r/bin/R',
    label: 'default-r',
    version: '4.3.1',
    runnable: true
  }
  const userR: DiscoveredInterpreter = {
    language: 'r',
    provenance: 'user-own',
    envId: '/usr/local/bin/R',
    interpreterPath: '/usr/local/bin/R',
    label: '/usr/local/bin/R',
    version: '4.4.0',
    runnable: true
  }

  // Service with injected discovery + enablement + a recording executor, so the tools run without any
  // real interpreter and executions can be inspected for the resolved interpreter.
  const bindingService = (
    root: string,
    options: {
      discovered?: DiscoveredInterpreter[]
      enablement?: RuntimeEnablement
      executions?: NotebookExecutionRequest[]
      terminations?: string[]
      installPackagesImpl?: (
        request: InstallRequestForTest,
        deps?: Partial<InstallDepsForTest>
      ) => Promise<InstallResultForTest>
    } = {}
  ): NotebookRuntimeService =>
    new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) =>
        (options.discovered ?? [managedPy, userPyA, userPyB]).filter(
          (env) => env.language === language
        ),
      getRuntimeEnablement: async () => options.enablement,
      installPackagesImpl: options.installPackagesImpl,
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          options.executions?.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true }),
        terminate: async (kind, env) => {
          options.terminations?.push(`${kind}:${env}`)
        }
      })
    })

  it('list_notebook_runtimes returns only enabled runtimes (never disabled), flagging the binding', async () => {
    const root = await createStorageRoot()
    // No enablement override: user-own defaults OFF, app-managed defaults ON.
    const service = bindingService(root)

    const listedDefault = await service.listRuntimes({ sessionId: 's', workspaceCwd: root })
    expect(listedDefault.runtimes.map((r) => r.runtimeId)).toEqual([managedPy.envId])

    // Enabling one external env surfaces it too, still excluding the other (disabled) one.
    const enabledService = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    const listed = await enabledService.listRuntimes({ sessionId: 's2', workspaceCwd: root })
    expect(listed.runtimes.map((r) => r.runtimeId).sort()).toEqual(
      [managedPy.envId, userPyA.envId].sort()
    )
    expect(listed.runtimes.every((r) => r.runtimeId !== userPyB.envId)).toBe(true)
  })

  it('refuses binding a disabled or unknown runtime IN THE MAIN process', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root)

    // userPyA is discovered but disabled (user-own default OFF) -> refused even with a valid id.
    await expect(
      service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
    ).rejects.toThrow(/not an enabled python runtime/)

    // A completely unknown id is likewise refused (a guessed path cannot bypass the gate).
    await expect(
      service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: '/tmp/hacker/python'
      })
    ).rejects.toThrow(/not an enabled python runtime/)
  })

  it('refuses a no-binding execute when the app-managed default is disabled (no silent fallback)', async () => {
    const root = await createStorageRoot()
    // Explicitly disable the app-managed default python (as toggling it off in Settings would), keyed
    // by the same interpreter path isDefaultEnvDisabled computes for this data root.
    const defaultPyId = pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV))
    const service = bindingService(root, {
      enablement: { enabled: { [defaultPyId]: false }, installAuthorized: {} }
    })

    // No bind: the run must FAIL with an actionable message rather than silently running the disabled
    // default (Settings would show no available runtime while execute still ran it).
    const summary = await service.execute({ sessionId: 's', workspaceCwd: root, code: '1' })
    expect(summary.status).toBe('failed')
    expect(summary.text.traceback).toMatch(/No enabled python runtime/i)
  })

  it('runs a bound enabled NAMED env even when the app-managed default is disabled', async () => {
    // Regression: disabling default-python must not block a session already bound to an enabled
    // agent-created env. The run resolves to the named env (not the default), so the disabled-default
    // gate must not fire.
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const namedPyId = join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python')
    const defaultPyId = pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV))
    const namedEnv: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: namedPyId,
      interpreterPath: namedPyId,
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, {
      discovered: [managedPy, namedEnv],
      // Default OFF, named env ON.
      enablement: { enabled: { [defaultPyId]: false, [namedPyId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedPyId
    })

    const summary = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    // The run succeeds against the named env; the disabled default never gates it.
    expect(summary.status).toBe('completed')
    expect(executions).toHaveLength(1)
    expect(executions[0].environment).toBe('my-analysis')
    // A managed named env is not the default, so the on-demand default provision never runs.
    expect(provisionPython).not.toHaveBeenCalled()
  })

  it('binds an enabled external runtime and runs the user interpreter without touching the managed default', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    expect(bound.bindings.python?.runtimeId).toBe(userPyA.envId)
    expect(bound.bindings.python?.source).toBe('external')

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
    // The bound external interpreter is threaded to the executor, and the managed default is NOT built.
    expect(executions[0].resolvedInterpreter?.command).toBe(userPyA.interpreterPath)
    expect(provisionPython).not.toHaveBeenCalled()

    // notebook_state surfaces the current binding.
    const state = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
  })

  it('switch tears down the language kernel, clears its state, and rebinds to the new runtime', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const terminations: string[] = []
    const service = bindingService(root, {
      enablement: {
        enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
        installAuthorized: {}
      },
      executions,
      terminations
    })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

    // The run left the python default-env kernel live.
    const before = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(before.environments.some((e) => e.processKey === 'python:default-python')).toBe(true)

    const switched = await service.switchRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyB.envId
    })
    expect(switched.bindings.python?.runtimeId).toBe(userPyB.envId)

    // The old kernel was PHYSICALLY torn down via the executor (external bindings share the default
    // env key), not just left to the interpreter-identity respawn seam.
    expect(terminations).toContain('python:default-python')

    // The old kernel's state was torn down (dropped from the live env view).
    const after = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(after.environments.some((e) => e.processKey === 'python:default-python')).toBe(false)
    expect(after.runtimeBindings.python?.runtimeId).toBe(userPyB.envId)

    // Subsequent runs use the newly-bound interpreter.
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '2', language: 'python' })
    expect(executions.at(-1)?.resolvedInterpreter?.command).toBe(userPyB.interpreterPath)
  })

  it('refuses switching to a disabled runtime', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await expect(
      service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyB.envId
      })
    ).rejects.toThrow(/not an enabled python runtime/)
  })

  it('binds an enabled external R runtime and runs the user Rscript without provisioning managed R', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const provisionR = vi.fn(async () => undefined)
    const service = bindingService(root, {
      discovered: [managedR, userR],
      enablement: { enabled: { [userR.envId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython: async () => undefined, provisionR })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      runtimeId: userR.envId
    })
    expect(bound.bindings.r?.runtimeId).toBe(userR.envId)
    expect(bound.bindings.r?.source).toBe('external')

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })
    // External R launches via Rscript (…/bin/R -> …/bin/Rscript), not the R binary, matching the
    // managed rScriptBin path; the managed R env is NOT built.
    expect(executions[0].resolvedInterpreter?.command).toBe('/usr/local/bin/Rscript')
    expect(provisionR).not.toHaveBeenCalled()
  })

  it('binds an agent-created named env and runs cells in it via the managed conda path', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const namedAgent: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: '/root/runtime/envs/my-analysis/bin/python',
      interpreterPath: '/root/runtime/envs/my-analysis/bin/python',
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    // No enablement override: agent-created defaults ENABLED, so it is bindable without a manual enable.
    const service = bindingService(root, { discovered: [managedPy, namedAgent], executions })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedAgent.envId
    })
    // A conda env WE own is 'managed' (executor resolves it by NAME), not 'external'.
    expect(bound.bound.source).toBe('managed')

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
    // The run targets the bound named env by name via the managed path — no raw external interpreter.
    expect(executions[0].environment).toBe('my-analysis')
    expect(executions[0].resolvedInterpreter).toBeUndefined()
  })

  it('installs into the bound external interpreter when the user authorized package install', async () => {
    const root = await createStorageRoot()
    const captured: Array<{ command: string; args?: string[] } | undefined> = []
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async (_request, deps) => {
        captured.push(deps?.interpreter)
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    const result = await service.managePackages({
      sessionId: 's',
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)
    // pip runs against the user's OWN interpreter (no app-owned overlay).
    expect(captured[0]?.command).toBe(userPyA.interpreterPath)
  })

  it('refuses installing into a bound external runtime that is not install-authorized', async () => {
    const root = await createStorageRoot()
    let installRan = false
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      // Enabled (so it can be bound), but NOT install-authorized.
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    const result = await service.managePackages({
      sessionId: 's',
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not authorized/)
    expect(installRan).toBe(false)
  })

  it('refuses installing into a MANAGED (agent-created) binding that has been revoked/disabled (unified gate)', async () => {
    // Regression: the manage_packages gate was external-only, so a disabled MANAGED runtime still
    // installed. This binds a genuinely MANAGED runtime (an agent-created named env — source 'managed',
    // NOT the user-own/external branch), revokes it, and asserts the install is refused by the managed
    // gate (an earlier version bound userPyA, which is provenance user-own and only exercised the
    // external branch, so it never covered the managed gate).
    const root = await createStorageRoot()
    let installRan = false
    const namedPyId = join(root, 'runtime', 'envs', 'my-analysis', 'bin', 'python')
    const namedEnv: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: namedPyId,
      interpreterPath: namedPyId,
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    const service = bindingService(root, {
      discovered: [managedPy, namedEnv],
      enablement: { enabled: { [namedPyId]: true }, installAuthorized: {} },
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    // Bind the MANAGED named env, then disable+revoke it -> the binding is kept but unavailable.
    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedPyId
    })
    // Guard the regression: this MUST be the managed branch, not external, or the test is vacuous.
    expect(bound.bound.source).toBe('managed')
    await service.revokeRuntime('python', namedPyId)

    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/RUNTIME_BINDING_UNAVAILABLE/)
    expect(installRan).toBe(false)
  })

  it('pins the install target to the binding env, ignoring a stale request.environment', async () => {
    // Regression: package-manager re-derived the env from request.environment and the local RPC forwards
    // the raw request, so a stale/mismatched environment could install into a DIFFERENT env than the one
    // whose lock/journal/repair the service resolved. The service now overrides it with the binding env.
    const root = await createStorageRoot()
    const captured: Array<string | undefined> = []
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      installPackagesImpl: async (request) => {
        captured.push(request.environment)
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    // No binding -> managed default. A caller passing a bogus environment must not redirect the install.
    const result = await service.managePackages({
      sessionId: 's',
      language: 'python',
      packages: ['numpy'],
      environment: 'some-other-env'
    } as InstallRequestForTest)
    expect(result.ok).toBe(true)
    // The forwarded request carries the binding-resolved default env, not the caller's stale value.
    expect(captured[0]).toBe(DEFAULT_PY_ENV)
  })

  it('honors a PERSISTED binding on the first manage_packages after a restart (fresh service)', async () => {
    // Regression: managePackages resolved the session with a bare sessions.get, so the FIRST install
    // after an app restart (session not yet in memory) saw no binding and silently installed into the
    // default env — bypassing the bound runtime + its install authorization. It now ensureSession()s
    // first, rehydrating the persisted binding.
    const root = await createStorageRoot()
    // Service A: bind an external, install-authorized runtime and persist it to run.json.
    const serviceA = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      }
    })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // Service B: a fresh process (no in-memory session). Its FIRST call is manage_packages — it must
    // load the session, rehydrate the persisted external binding, and pip into the user's OWN
    // interpreter, NOT micromamba into the default managed prefix.
    const captured: Array<{ interpreter?: string; environment?: string }> = []
    const serviceB = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async (request, deps) => {
        captured.push({ interpreter: deps?.interpreter?.command, environment: request.environment })
        return { ok: true, needsRestart: false, log: '' }
      }
    })

    const result = await serviceB.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)
    // Installed into the user's own interpreter (external pip), proving the persisted binding was
    // honored — not the managed default prefix.
    expect(captured[0]?.interpreter).toBe(userPyA.interpreterPath)
  })

  it('revokes a disabled runtime from a bound session so execution rejects (no silent fallback)', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      executions
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // Disable the bound runtime -> revoke it from the session.
    await service.revokeRuntime('python', userPyA.envId)

    // notebook_state surfaces the binding as unavailable/disabled (kept, not cleared — no fallback).
    const state = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.status).toBe('unavailable')
    expect(state.runtimeBindings.python?.reason).toBe('disabled')

    // A subsequent run FAILS with an actionable message instead of silently running the managed default.
    const run = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    expect(run.status).toBe('failed')
    expect(run.text.traceback).toContain('RUNTIME_BINDING_UNAVAILABLE')
    // The revoked interpreter was never dispatched to the executor.
    expect(executions).toHaveLength(0)
  })

  it('drains then physically closes a revoked runtime kernel in the background (WS10 remainder)', async () => {
    const root = await createStorageRoot()
    const terminations: string[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      terminations
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    // A completed run leaves the external kernel live under the default env key.
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

    await service.revokeRuntime('python', userPyA.envId)

    // Disable is non-blocking: the drain-and-close runs in the background — the kernel is torn down
    // after the in-flight run drains (here already finished), not left to idle-timeout.
    await vi.waitFor(() => expect(terminations).toContain('python:default-python'))
    await service.shutdownAll()
  })

  it('describeRuntimeUsage counts bound sessions by kernel state for the disable warning (WS11)', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    // s1: bound + ran -> a live-but-idle kernel. s2: bound, never ran -> dormant (no kernel).
    for (const sessionId of ['s1', 's2']) {
      await service.bindRuntime({
        sessionId,
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
    }
    await service.execute({ sessionId: 's1', workspaceCwd: root, code: '1', language: 'python' })

    expect(service.describeRuntimeUsage('python', userPyA.envId)).toEqual({
      running: 0,
      idle: 1,
      dormant: 1
    })
    // A runtime nobody is bound to has no usage.
    expect(service.describeRuntimeUsage('python', userPyB.envId)).toEqual({
      running: 0,
      idle: 0,
      dormant: 0
    })
  })

  it('force-stop disable aborts the running cell and records it cancelled (WS10 force-stop)', async () => {
    const root = await createStorageRoot()
    // A blocking executor: execute() stays pending until terminate() rejects it (a killed kernel).
    let rejectRun: ((error: unknown) => void) | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) => (language === 'python' ? [userPyA] : []),
      getRuntimeEnablement: async () => ({
        enabled: { [userPyA.envId]: true },
        installAuthorized: {}
      }),
      executorFactory: () => ({
        execute: () =>
          new Promise<NotebookExecutionResult>((_resolve, reject) => {
            rejectRun = reject
          }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => {
          rejectRun?.(new Error('kernel killed'))
          rejectRun = undefined
        }
      })
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    const runPromise = service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'long()',
      language: 'python'
    })
    // Wait until the cell is genuinely in flight (the executor was invoked).
    await vi.waitFor(() => expect(rejectRun).toBeDefined())

    // Force-stop: abort the running cell now. The killed run is recorded 'cancelled', not 'failed'.
    await service.revokeRuntime('python', userPyA.envId, { force: true })
    const summary = await runPromise
    expect(summary.status).toBe('cancelled')
  })

  it('persists a binding and restores it active on a fresh service (WS1-rest/WS12 boot revalidation)', async () => {
    const root = await createStorageRoot()
    const enablement = { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    // Service A binds an external runtime -> persisted to run.json.
    const serviceA = bindingService(root, { enablement })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // A FRESH service over the same root (app restart) reloads + revalidates the persisted binding.
    const serviceB = bindingService(root, { enablement })
    const state = await serviceB.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
    expect(state.runtimeBindings.python?.status).toBe('active')
  })

  it('reloads a persisted binding as unavailable when its runtime is now disabled (no silent fallback)', async () => {
    const root = await createStorageRoot()
    // Bind while enabled...
    const serviceA = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // ...then a fresh service where the runtime is DISABLED (still detected, gate off) -> unavailable.
    const serviceB = bindingService(root, {
      enablement: { enabled: {}, installAuthorized: {} }
    })
    const state = await serviceB.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
    expect(state.runtimeBindings.python?.status).toBe('unavailable')
    expect(state.runtimeBindings.python?.reason).toBe('disabled')
  })

  // WS9: certify the disable/binding lifecycle across the scenarios from the disable-binding spec.
  describe('disable lifecycle certification (WS9)', () => {
    it('dormant session: revoking a runtime with no live kernel marks it unavailable + rejects', async () => {
      const root = await createStorageRoot()
      const terminations: string[] = []
      const service = bindingService(root, {
        enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
        terminations
      })
      // Bind but NEVER run -> the session is "dormant" (no live kernel).
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })

      // revokeRuntime marks the in-memory binding unavailable synchronously (before the background
      // drain), so no live kernel + no shutdown needed to observe it.
      await service.revokeRuntime('python', userPyA.envId)

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runtimeBindings.python?.status).toBe('unavailable')
      const run = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toContain('RUNTIME_BINDING_UNAVAILABLE')
    })

    it('disable-then-resume: after a revoke, switching to an enabled runtime restores execution', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = bindingService(root, {
        enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
        executions
      })
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      await service.revokeRuntime('python', userPyA.envId)
      // Rejected while unavailable...
      const rejected = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(rejected.status).toBe('failed')

      // ...the agent recovers by switching to the (enabled) app-managed default.
      await service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: managedPy.envId
      })
      const resumed = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '2',
        language: 'python'
      })
      expect(resumed.status).toBe('completed')
      // Managed binding runs via the managed path (no external interpreter override).
      expect(executions.at(-1)?.resolvedInterpreter).toBeUndefined()
    })

    it('A->B->A: switching back to a previously-bound runtime rebinds it', async () => {
      const root = await createStorageRoot()
      const terminations: string[] = []
      const service = bindingService(root, {
        enablement: {
          enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
          installAuthorized: {}
        },
        terminations
      })
      const bind = (runtimeId: string): Promise<unknown> =>
        service.bindRuntime({ sessionId: 's', workspaceCwd: root, language: 'python', runtimeId })
      const to = (runtimeId: string): Promise<unknown> =>
        service.switchRuntime({ sessionId: 's', workspaceCwd: root, language: 'python', runtimeId })

      await bind(userPyA.envId)
      await to(userPyB.envId)
      const back = await service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      expect(back.bindings.python?.runtimeId).toBe(userPyA.envId)
      // Each switch physically tore down the outgoing kernel.
      expect(terminations.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('leaves the managed-default path unchanged when no runtime is bound', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, { executions })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
    // No binding -> managed default: no resolved interpreter override, and the default env is built.
    expect(executions[0].resolvedInterpreter).toBeUndefined()
    expect(provisionPython).toHaveBeenCalledTimes(1)
  })

  it('remove-guard: only agent-created envs are removable (app-managed refused)', async () => {
    const root = await createStorageRoot()
    const removed: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentManager: {
        createNamedEnvironment: async (name, language) => ({
          name,
          language,
          ready: true,
          isDefault: false
        }),
        listEnvironments: () => [],
        removeEnvironment: (name) => {
          removed.push(name)
          return []
        }
      }
    })

    // A versioned app-managed env slips past assertSafeEnvName but is refused by the provenance guard.
    await expect(
      service.manageEnvironments({ action: 'remove', name: 'default-python-3.13' })
    ).rejects.toThrow(/app-managed and cannot be removed/)
    expect(removed).toEqual([])

    // An agent-created env is removable.
    await service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
    expect(removed).toEqual(['my-analysis'])
  })

  // End-to-end wiring of setManualInterpretersResolver: a Settings-added interpreter is folded into the
  // service's REAL default discovery (NOT an injected discoverRuntimes), so it becomes discoverable,
  // enable-able, and bindable — and survives a restart (a fresh service with the same resolver still
  // resolves it active, not 'missing'). Exercises the actual manualInterpretersResolver seam with a real
  // executable interpreter so the version probe + runnability classification run for real. POSIX-only:
  // it relies on a chmod-executable shell shim, which Windows can't run as `<path> --version`.
  it.skipIf(process.platform === 'win32')(
    'discovers, binds, and (across a restart) keeps a manual interpreter added via setManualInterpretersResolver',
    async () => {
      // Real discovery is exercised (no injected discoverRuntimes): it enumerates PATH + conda roots and
      // probes every real interpreter's `--version`, and it runs on each list/bind/execute/restart call —
      // so this legitimately needs far more than the default 5s budget on a machine with many envs.
      const root = await createStorageRoot()

      // A real, runnable Python shim OUTSIDE runtime/envs (so discovery classifies it 'user-own'): it
      // answers `--version` with a Python-3 string, which is exactly what the default probe validates.
      const manualDir = await mkdtemp(join(tmpdir(), 'open-science-manual-interp-'))
      const shim = join(manualDir, 'python3')
      await writeFile(shim, '#!/bin/sh\necho "Python 3.12.7"\n')
      await chmod(shim, 0o755)
      // Key everything by the canonical path — discovery's realpath-dedup makes envId the real path.
      const manualPath = await realpath(shim)

      let manualResolverCalls = 0
      const resolver = async (language: 'python' | 'r'): Promise<string[]> => {
        manualResolverCalls += 1
        return language === 'python' ? [manualPath] : []
      }
      // A user-own interpreter defaults OFF, so it must be explicitly enabled (as toggling it on in
      // Settings would) before it is bindable — keyed by the same envId discovery computes.
      const enablement: RuntimeEnablement = {
        enabled: { [manualPath]: true },
        installAuthorized: {}
      }
      const executions: NotebookExecutionRequest[] = []
      const makeService = (): NotebookRuntimeService => {
        // NO discoverRuntimes injected: the REAL default discovery runs and must consult the manual
        // resolver — the wiring under test. Enablement is wired so the user-own env can be enabled.
        const service = new NotebookRuntimeService({
          configRoot: root,
          dataRoot: root,
          projectName: 'default-project',
          repository: new NotebookRunRepository(root),
          getRuntimeEnablement: async () => enablement,
          executorFactory: () => ({
            execute: async (request): Promise<NotebookExecutionResult> => {
              executions.push(request)
              return {
                status: 'completed',
                stdout: '',
                stderr: '',
                traceback: '',
                cwdAfter: request.cwd,
                outputs: []
              }
            },
            shutdown: async () => ({ reaped: true }),
            terminate: async () => undefined
          })
        })
        service.setManualInterpretersResolver(resolver)
        return service
      }

      const service = makeService()

      // 1) The manual interpreter surfaces through the agent-facing list (real discovery folded it in).
      const listed = await service.listRuntimes({ sessionId: 's', workspaceCwd: root })
      const manualListing = listed.runtimes.find((r) => r.runtimeId === manualPath)
      expect(manualResolverCalls).toBeGreaterThan(0) // proves the resolver was consulted by discovery
      expect(manualListing).toBeDefined()
      expect(manualListing?.provenance).toBe('user-own')
      expect(manualListing?.runnable).toBe(true)
      expect(manualListing?.version).toMatch(/^3\.12\.7/)

      // 2) It is bindable, and a subsequent state/execute reflects the binding + threads the interpreter.
      const bound = await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: manualPath
      })
      expect(bound.bound.source).toBe('external')
      expect(bound.bound.runtimeId).toBe(manualPath)

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runtimeBindings.python?.runtimeId).toBe(manualPath)
      expect(state.runtimeBindings.python?.status ?? 'active').toBe('active')

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
      expect(executions.at(-1)?.resolvedInterpreter?.command).toBe(manualPath)

      // 3) Restart: a FRESH service instance (same manual resolver + same on-disk repository) must still
      // discover the interpreter and rehydrate the persisted binding as ACTIVE — never 'missing'.
      const afterRestart = makeService()
      const restartState = await afterRestart.state({ sessionId: 's', workspaceCwd: root })
      expect(restartState.runtimeBindings.python?.runtimeId).toBe(manualPath)
      expect(restartState.runtimeBindings.python?.status ?? 'active').toBe('active')
      expect(restartState.runtimeBindings.python?.reason).toBeUndefined()

      const relisted = await afterRestart.listRuntimes({ sessionId: 's', workspaceCwd: root })
      expect(relisted.runtimes.some((r) => r.runtimeId === manualPath)).toBe(true)

      await rm(manualDir, { recursive: true, force: true })
    },
    30_000
  )
})
