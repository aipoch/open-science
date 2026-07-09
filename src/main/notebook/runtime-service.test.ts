import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
      cwd: '/workspace',
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
})
