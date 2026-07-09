import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NotebookRunRepository, getNotebookSessionRoot } from './repository'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-runs-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook run repository', () => {
  it('creates run.json under the notebook session workspace with runtime and data roots', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    const document = await repository.loadOrCreate({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      pythonPath: '/usr/bin/python3',
      kernelName: 'python3'
    })

    expect(document).toMatchObject({
      version: 1,
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      kernel: {
        language: 'python',
        pythonPath: '/usr/bin/python3',
        kernelName: 'python3',
        runtimeRoot: join(root, 'runtime'),
        lastKnownStatus: 'idle'
      },
      runs: []
    })
    await expect(
      readFile(join(root, 'notebooks', 'default-project', 'session-1', 'run.json'), 'utf8')
    ).resolves.toContain('"sessionId": "session-1"')
  })

  it('appends completed runs with working file metadata but not file contents', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await repository.loadOrCreate({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectName: 'default-project',
      sessionId: 'session-1',
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        script: "print('hello')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: {
          stdout: 'hello\n',
          stderr: '',
          traceback: '',
          plain: ['hello']
        },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: join(root, 'notebooks', 'default-project', 'session-1', 'data', 'processed.csv'),
            relativePath: 'data/processed.csv',
            kind: 'processed-data',
            size: 123,
            mtimeMs: 200,
            createdByRunId: 'run-1'
          }
        ]
      }
    })

    const rawJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )
    const document = JSON.parse(rawJson) as Awaited<
      ReturnType<NotebookRunRepository['loadOrCreate']>
    >

    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      text: {
        stdout: 'hello\n'
      },
      workingFiles: [
        {
          relativePath: 'data/processed.csv',
          kind: 'processed-data',
          size: 123
        }
      ]
    })
    expect(rawJson).toContain('"relativePath": "data/processed.csv"')
    expect(rawJson).not.toContain('hello,file,contents')
  })

  it('updates an existing run without duplicating its history entry', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await repository.loadOrCreate({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectName: 'default-project',
      sessionId: 'session-1',
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        script: "print('hello')",
        status: 'running',
        startedAt: 100,
        text: {
          stdout: '',
          stderr: '',
          traceback: '',
          plain: []
        },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })
    const document = await repository.updateRun({
      projectName: 'default-project',
      sessionId: 'session-1',
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        script: "print('hello')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: {
          stdout: 'hello\n',
          stderr: '',
          traceback: '',
          plain: ['hello']
        },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      endedAt: 200,
      text: {
        stdout: 'hello\n'
      }
    })
  })

  it('rejects unsafe project and session path segments', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    expect(() => getNotebookSessionRoot(root, '../project', 'session-1')).toThrow(
      /Invalid notebook path segment/
    )
    await expect(
      repository.loadOrCreate({
        projectName: 'default-project',
        sessionId: 'session/1',
        workspaceCwd: '/workspace'
      })
    ).rejects.toThrow(/Invalid notebook path segment/)
  })
})
