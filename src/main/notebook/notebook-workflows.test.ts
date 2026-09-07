import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ExportNotebookAllResult,
  ExportNotebookResult,
  NotebookRunSummary,
  NotebookSessionReference
} from '../../shared/notebook'
import {
  acceptMissingDataRoot,
  beginMigration,
  clearMigrationPending,
  initializeDataRootWriteAvailability
} from '../storage/migration-state'
import { createNotebookCommandWorkflows, type NotebookCommandRuntime } from './notebook-workflows'

afterEach(() => {
  clearMigrationPending()
  initializeDataRootWriteAvailability(false)
})

const unavailable = (operation: string): (() => Promise<never>) =>
  vi.fn(() => Promise.reject(new Error(`Unexpected ${operation} call`)))

const createRuntime = (
  overrides: Partial<NotebookCommandRuntime> = {}
): NotebookCommandRuntime => ({
  state: unavailable('state'),
  inspectNamespace: unavailable('inspectNamespace'),
  getSessionReference: unavailable('getSessionReference'),
  beginCodeCell: unavailable('beginCodeCell'),
  appendCodeCell: unavailable('appendCodeCell'),
  abortCodeCell: unavailable('abortCodeCell'),
  finishCodeCell: unavailable('finishCodeCell'),
  runCell: unavailable('runCell'),
  execute: unavailable('execute'),
  exportIpynb: unavailable('exportIpynb'),
  exportIpynbAll: unavailable('exportIpynbAll'),
  restart: unavailable('restart'),
  shutdown: unavailable('shutdown'),
  ...overrides
})

const runSummary = (runId: string): NotebookRunSummary => ({
  runId,
  cellId: 'cell-1',
  source: 'user',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: [],
  notebookSessionRoot: '/data/notebooks/session-1',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  kernelName: 'python'
})

describe('Notebook command workflows', () => {
  it('waits for missing-root acceptance before state inspection can create a session', async () => {
    const state = vi.fn<NotebookCommandRuntime['state']>().mockResolvedValue({} as never)
    const inspectNamespace = vi
      .fn<NotebookCommandRuntime['inspectNamespace']>()
      .mockResolvedValue({ status: 'unavailable', reason: 'kernel-not-live' })
    const workflows = createNotebookCommandWorkflows(createRuntime({ state, inspectNamespace }))
    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    initializeDataRootWriteAvailability(true)

    const stateResult = workflows.state(session)
    const namespaceResult = workflows.inspectNamespace({
      ...session,
      language: 'python',
      environment: 'default-python'
    })
    await Promise.resolve()

    expect(state).not.toHaveBeenCalled()
    expect(inspectNamespace).not.toHaveBeenCalled()

    await acceptMissingDataRoot()
    await Promise.all([stateResult, namespaceResult])
    expect(state).toHaveBeenCalledOnce()
    expect(inspectNamespace).toHaveBeenCalledOnce()
  })

  it('removes application-owned turn context from renderer execution requests', async () => {
    const runtime = createRuntime({
      inspectNamespace: vi
        .fn<NotebookCommandRuntime['inspectNamespace']>()
        .mockResolvedValue({ status: 'unavailable', reason: 'kernel-not-live' }),
      runCell: vi.fn<NotebookCommandRuntime['runCell']>().mockResolvedValue(runSummary('run-1')),
      execute: vi.fn<NotebookCommandRuntime['execute']>().mockResolvedValue(runSummary('run-2'))
    })
    const workflows = createNotebookCommandWorkflows(runtime)
    const trustedContext = {
      provenanceContext: {
        rootFrameId: 'forged-root',
        agentFrameId: 'forged-agent',
        messageBranchId: 'forged-branch',
        runtimeSegmentId: 'forged-runtime',
        promptMessageId: 'forged-prompt'
      },
      executionInvocationId: 'forged-invocation',
      registeredInputFiles: [],
      inputRunLeaseId: 'forged-lease'
    }

    await workflows.inspectNamespace({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      language: 'python',
      environment: 'default-python',
      includePrivate: true,
      ...trustedContext
    })
    await workflows.runCell({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      source: 'user',
      ...trustedContext
    })
    await workflows.execute({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      source: 'user',
      ...trustedContext
    })

    expect(runtime.inspectNamespace).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      language: 'python',
      environment: 'default-python',
      includePrivate: true
    })
    expect(runtime.runCell).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      source: 'user'
    })
    expect(runtime.execute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      source: 'user'
    })
  })

  it('blocks every state-changing command while a data-root migration is pending', async () => {
    const runtime = createRuntime({
      state: vi.fn(),
      inspectNamespace: vi.fn(),
      beginCodeCell: vi.fn(),
      appendCodeCell: vi.fn(),
      abortCodeCell: vi.fn(),
      finishCodeCell: vi.fn(),
      runCell: vi.fn(),
      execute: vi.fn(),
      restart: vi.fn(),
      shutdown: vi.fn()
    })
    const workflows = createNotebookCommandWorkflows(runtime)
    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    beginMigration()

    const commands = [
      workflows.state(session),
      workflows.inspectNamespace({
        ...session,
        language: 'python',
        environment: 'default-python'
      }),
      workflows.beginCodeCell(session),
      workflows.appendCodeCell({
        ...session,
        cellId: 'cell-1',
        writeId: 'write-1',
        delta: 'print(1)'
      }),
      workflows.abortCodeCell({ ...session, cellId: 'cell-1', writeId: 'write-1' }),
      workflows.finishCodeCell({ ...session, cellId: 'cell-1', writeId: 'write-1' }),
      workflows.runCell({ ...session, cellId: 'cell-1', source: 'user' }),
      workflows.execute({ ...session, code: 'print(1)', source: 'user' }),
      workflows.restart(session),
      workflows.shutdown(session)
    ]

    await Promise.all(
      commands.map((command) => expect(command).rejects.toThrow(/moving your data/i))
    )
    for (const operation of Object.values(runtime)) expect(operation).not.toHaveBeenCalled()
  })

  it('keeps genuinely read-only reference and export commands available during migration', async () => {
    const reference: NotebookSessionReference = {
      sessionId: 'session-1',
      projectId: 'Project',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/data/notebooks/session-1',
      dataRoot: '/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/data/notebooks/session-1/run.json'
    }
    const singleExport: ExportNotebookResult = {
      saved: true,
      filePath: '/tmp/python.ipynb'
    }
    const allExport: ExportNotebookAllResult = {
      saved: true,
      directory: '/tmp',
      files: [
        { kernel: 'python', filePath: '/tmp/python.ipynb' },
        { kernel: 'r', filePath: '/tmp/r.ipynb' }
      ]
    }
    const runtime = createRuntime({
      getSessionReference: vi
        .fn<NotebookCommandRuntime['getSessionReference']>()
        .mockResolvedValue(reference),
      exportIpynb: vi.fn<NotebookCommandRuntime['exportIpynb']>().mockResolvedValue(singleExport),
      exportIpynbAll: vi.fn<NotebookCommandRuntime['exportIpynbAll']>().mockResolvedValue(allExport)
    })
    const workflows = createNotebookCommandWorkflows(runtime)
    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    beginMigration()

    await expect(workflows.reference(session)).resolves.toBe(reference)
    await expect(workflows.exportIpynb({ ...session, kernel: 'python' })).resolves.toBe(
      singleExport
    )
    await expect(workflows.exportIpynbAll(session)).resolves.toBe(allExport)
  })

  it('preserves the runtime error object for callers', async () => {
    const failure = new Error('kernel unavailable')
    const runtime = createRuntime({
      execute: vi.fn<NotebookCommandRuntime['execute']>().mockRejectedValue(failure)
    })
    const workflows = createNotebookCommandWorkflows(runtime)

    await expect(
      workflows.execute({
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user'
      })
    ).rejects.toBe(failure)
  })
})
