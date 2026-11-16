import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { createProjectDbClient } from './prisma-client'
import { initDataRoot } from '../storage-root'
import { NotebookRunRepository } from '../notebook/repository'
import { createRootNotebookLane } from '../notebook/lane-identity'
import { SessionRepository } from '../session-persistence/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { initializeProjectRecordStorage } from './record-storage'
import { restoreProjectRecordSessions } from './restore-record-sessions'

const database = registerDatabaseFixture()
let root: string
let storageRoot: string
let configRoot: string
let folder: string
let client: ReturnType<typeof createProjectDbClient>
let sessions: SessionRepository
let notebooks: NotebookRunRepository
const projectId = 'project-1'
const sessionId = 'session-1'
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'restore-project-record-sessions-')))
  storageRoot = join(root, 'managed')
  configRoot = join(root, 'config')
  folder = join(root, 'research')
  await Promise.all([storageRoot, configRoot, folder].map((path) => mkdir(path)))
  initDataRoot(storageRoot)
  client = await database(configRoot)
  await client.project.create({ data: { id: projectId, name: 'Retained research' } })
  sessions = new SessionRepository(
    configRoot,
    {},
    new SessionProjectionRepository(async () => client)
  )
  notebooks = new NotebookRunRepository(storageRoot)
  await initializeProjectRecordStorage(storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId,
    name: 'Retained research',
    createdAt: 1
  })
  const lane = createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
  await notebooks.loadOrCreate({ projectId, sessionId, lane, workspaceCwd: folder })
  await notebooks.appendRun({
    projectId,
    sessionId,
    lane,
    run: {
      runId: 'run-1',
      submissionIdentity: 'submission-1',
      submissionFingerprint: 'a'.repeat(64),
      cellId: 'cell-1',
      source: 'agent',
      kernelKind: 'python',
      script: 'print("retained")',
      status: 'completed',
      startedAt: 10,
      endedAt: 20,
      text: { stdout: 'retained\n', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
  })
})
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
const restore = (): Promise<string[]> =>
  restoreProjectRecordSessions({
    storageRoot,
    projectId,
    sessions,
    notebooks,
    workspaces: createManagedSessionWorkspaceCapability({ resolveRoot: () => storageRoot })
  })

it('restores missing Sessions through real JSON/projection and preserves browseable Notebook records', async () => {
  await sessions.saveSession({
    id: sessionId,
    projectId,
    title: 'Prior provider conversation',
    cwd: '/prior/provider-workspace',
    status: 'idle',
    providerSessionId: 'prior-provider-id',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await sessions.deleteProjectSessions(projectId)
  await sessions.completeProjectSessionDeletion(projectId)
  // Restarted services carry no memory of the removed chat or provider runtime.
  sessions = new SessionRepository(
    configRoot,
    {},
    new SessionProjectionRepository(async () => client)
  )
  notebooks = new NotebookRunRepository(storageRoot)
  const before = await notebooks.readSessionDocuments(projectId, sessionId)
  const runFile = join(folder, '.open-science/notebooks', projectId, sessionId, 'run.json')
  const bytes = await readFile(runFile, 'utf8')
  expect(await restore()).toEqual([sessionId])
  const saved = await sessions.loadSession(projectId, sessionId)
  expect(saved).toMatchObject({
    id: sessionId,
    projectId,
    title: 'Notebook',
    status: 'idle',
    messages: []
  })
  expect(dirname(saved!.cwd)).toBe(join(storageRoot, 'workspaces'))
  expect((await stat(saved!.cwd)).isDirectory()).toBe(true)
  expect(saved?.providerSessionId).toBeUndefined()
  expect(saved?.packageOrigin).toBeUndefined()
  expect(saved?.forkOrigin).toBeUndefined()
  expect(saved?.permissionProfile).toBe('ask')
  expect(await client.session.findUnique({ where: { id: sessionId } })).toMatchObject({
    projectId,
    title: 'Notebook'
  })
  expect((await notebooks.readSessionRuns(projectId, sessionId)).map((run) => run.script)).toEqual([
    'print("retained")'
  ])
  expect(await notebooks.readSessionDocuments(projectId, sessionId)).toEqual(before)
  expect(await readFile(runFile, 'utf8')).toBe(bytes)
  expect(await restore()).toEqual([])
  expect((await sessions.loadSession(projectId, sessionId))?.cwd).toBe(saved?.cwd)
})

it('preserves ordinary existing Session identity and provider state on repeat/restart', async () => {
  const original = await sessions.saveSession({
    id: sessionId,
    projectId,
    title: 'Original chat',
    cwd: '/original/workspace',
    status: 'idle',
    providerSessionId: 'provider-original',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  expect(await restore()).toEqual([])
  expect(await sessions.loadSession(projectId, sessionId)).toMatchObject(original)
})

it('refuses unreadable Session JSON and never overwrites it with an empty shell', async () => {
  const directory = join(configRoot, 'sessions', projectId)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${sessionId}.json`)
  await writeFile(path, '{broken')
  await expect(restore()).rejects.toThrow('unreadable history')
  expect(await readFile(path, 'utf8')).toBe('{broken')
  expect(await client.session.count()).toBe(0)
})
