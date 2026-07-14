import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookExecutionRequest, NotebookExecutionResult } from './runtime-service'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookRunRepository } from './repository'

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

describe('notebook runtime service', () => {
  it('streams agent code into a locked cell and runs it through the shared executor', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      storageRoot: root,
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
        shutdown: async () => undefined
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
      storageRoot: root,
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
        shutdown: async () => undefined
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
      storageRoot: root,
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
        shutdown: async () => undefined
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
      storageRoot: root,
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
        shutdown: async () => undefined
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

  it('threads the resolved mcp RPC connection into the execute request env', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      storageRoot: root,
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
        shutdown: async () => undefined
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

    expect(executions[0]).toMatchObject({
      mcpRpcEndpoint: 'http://127.0.0.1:1/x',
      mcpRpcToken: 'tok'
    })
  })

  it('returns null when a session has no persisted notebook run history', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      storageRoot: root,
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
      storageRoot: root,
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
        shutdown: async () => undefined
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
      storageRoot: root,
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

  it('serializes overlapping runs on the shared interpreter instead of failing the second', async () => {
    const root = await createStorageRoot()
    let active = 0
    let maxConcurrent = 0
    const releases: Array<() => void> = []
    const service = new NotebookRuntimeService({
      storageRoot: root,
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
        shutdown: async () => undefined
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
      storageRoot: root,
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
        shutdown: async () => undefined
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
})
