import { SettingsDocumentStore } from '../settings/document-store'
import { NotebookRunRepository, getNotebookRunJsonPath } from '../notebook/repository'
import { createFrameNotebookLane, createRootNotebookLane } from '../notebook/lane-identity'
import { SessionRepository } from '../session-persistence/repository'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { initDataRoot } from '../storage-root'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { exportDiagnosticFiles } from '../diagnostics/integration-test-helpers'
import { RUNTIME_SCHEMA_TABLE_DDLS } from '../database/generated/runtime-schema'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('exports the current application schema through the package without changing the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-schema-compatibility-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  await Promise.all([configRoot, dataRoot].map((path) => mkdir(path)))
  const path = join(configRoot, 'open-science.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN')
    for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) db.exec(ddl)
    db.exec("INSERT INTO Project(id, name, updatedAt) VALUES ('p', 'private project', 1)")
    db.exec(
      "INSERT INTO Session(id, projectId, number, title, status, presentedStatus, createdAtMs, updatedAtMs) VALUES ('s', 'p', 1, 'private title', 'idle', 'idle', 1, 1)"
    )
    db.exec("INSERT INTO SessionRun(sessionId, messageId, createdAtMs) VALUES ('s', 'message', 1)")
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  const before = await readFile(path)
  const files = await exportDiagnosticFiles(
    { configRoot, dataRoot, appVersion: 'schema-contract' },
    { projectId: 'p', sessionId: 's', selectedItems: ['database'] }
  )
  expect(await readFile(path)).toEqual(before)
  expect(JSON.parse(files['db/SessionRun.json'])).toEqual([
    expect.objectContaining({ sessionId: 's', messageId: 'message' })
  ])
  const sessions = files['db/Session.json']
  expect(sessions).not.toContain('private title')
})

it.each(['root', 'frame'] as const)(
  'exports current Session, Settings and %s Notebook writer formats',
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), 'diagnostic-storage-contract-'))
    roots.push(root)
    const configRoot = join(root, 'config'),
      dataRoot = join(root, 'data')
    await Promise.all([configRoot, dataRoot].map((path) => mkdir(path)))
    initDataRoot(dataRoot)
    await new SettingsDocumentStore(configRoot).mutate((settings) => ({
      ...settings,
      agentFrameworkId: 'codex',
      activeModel: 'contract-model',
      reasoningEffort: 'high'
    }))
    await new SessionRepository(configRoot).saveSession(
      materializeSessionConversationGraph({
        id: 's',
        projectId: 'p',
        title: 'PRIVATE_SESSION_TITLE',
        cwd: dataRoot,
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      })
    )
    const lane =
      scope === 'root'
        ? createRootNotebookLane('p', 's', 'root-frame-s')
        : createFrameNotebookLane('p', 's', 'frame-1')
    const notebook = new NotebookRunRepository(dataRoot)
    await notebook.loadOrCreate({ projectId: 'p', sessionId: 's', workspaceCwd: dataRoot, lane })
    await notebook.appendRun({
      projectId: 'p',
      sessionId: 's',
      lane,
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'user',
        kernelKind: 'python',
        script: 'PRIVATE_EXECUTION_CODE',
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      }
    })
    const sourcePaths = [
      join(configRoot, 'settings.json'),
      join(configRoot, 'sessions/p/s.json'),
      getNotebookRunJsonPath(dataRoot, 'p', 's', lane)
    ]
    const before = await Promise.all(sourcePaths.map((path) => readFile(path)))
    const files = await exportDiagnosticFiles(
      { configRoot, dataRoot, appVersion: 'storage-contract' },
      {
        projectId: 'p',
        sessionId: 's',
        selectedItems: [
          'session',
          'environment',
          scope === 'root' ? 'notebook' : 'notebook:frame:frame-1'
        ]
      }
    )
    expect(JSON.parse(files['session.json'])).toMatchObject({
      format: 'diagnostic-session-projection'
    })
    expect(JSON.parse(files['environment.json'])).toMatchObject({
      storedDefaults: {
        frameworkId: 'codex',
        model: 'contract-model',
        reasoningEffort: 'high'
      }
    })
    const runPath = scope === 'root' ? 'notebook/run.json' : 'notebook/frames/frame-1/run.json'
    expect(JSON.parse(files[runPath])).toMatchObject({
      projectId: 'p',
      sessionId: 's',
      runs: [expect.objectContaining({ runId: 'run-1', status: 'completed' })]
    })
    expect(JSON.stringify(files)).not.toMatch(/PRIVATE_SESSION_TITLE|PRIVATE_EXECUTION_CODE/)
    expect(await Promise.all(sourcePaths.map((path) => readFile(path)))).toEqual(before)
  }
)
