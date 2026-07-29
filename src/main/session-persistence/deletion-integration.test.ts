import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { SessionPersistenceCoordinator } from './coordinator'
import { SessionRepository } from './repository'

const PROJECT_ID = 'project-a'
const SESSION_ID = 'session-a'

describe('managed-file deletion integration', () => {
  let storageRoot: string
  let client: PrismaClient
  let sessions: SessionRepository
  let files: ManagedFileIndexRepository
  let coordinator: SessionPersistenceCoordinator
  let uploadPath: string
  let artifactPath: string

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-file-deletion-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    sessions = new SessionRepository(storageRoot)
    files = new ManagedFileIndexRepository(() => Promise.resolve(client), storageRoot)
    coordinator = new SessionPersistenceCoordinator(sessions, files)
    uploadPath = join(
      storageRoot,
      'uploads',
      PROJECT_ID,
      SESSION_ID,
      'upload-1',
      'versions',
      'upload-version-1',
      'content'
    )
    artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-agent',
      'result.txt'
    )

    await Promise.all([
      writeManagedFile(uploadPath, 'upload bytes'),
      writeManagedFile(artifactPath, 'artifact bytes')
    ])
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'input.csv',
        originalFilename: 'input.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: relativeStorageKey(storageRoot, uploadPath),
            filename: 'input.csv',
            originalFilename: 'input.csv',
            sizeBytes: BigInt('upload bytes'.length),
            checksum: createHash('sha256').update('upload bytes').digest('hex'),
            createdAt: new Date(100)
          }
        }
      }
    })
    await sessions.saveSession(createSession(uploadPath, artifactPath))
    await coordinator.loadAll()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 2 })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('soft-deletes indexed rows but retains upload and artifact bytes after session deletion', async () => {
    await coordinator.deleteSession(PROJECT_ID, SESSION_ID)

    await expect(sessions.loadAll()).resolves.toMatchObject({ sessions: [] })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(readFile(uploadPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe('artifact bytes')
  })

  it('soft-deletes project rows but retains upload and artifact bytes after project deletion', async () => {
    await coordinator.deleteProjectSessions(PROJECT_ID)

    await expect(sessions.loadAll()).resolves.toMatchObject({ sessions: [] })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(readFile(uploadPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe('artifact bytes')
  })
})

const createSession = (_uploadPath: string, artifactPath: string): PersistedChatSession => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'Deletion integration',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-user',
      role: 'user',
      content: 'Analyze the upload',
      status: 'complete',
      eventIds: [],
      uploads: [
        {
          id: 'upload-1',
          versionId: 'upload-version-1',
          versionNumber: 1,
          sessionId: SESSION_ID,
          name: 'input.csv',
          originalName: 'input.csv',
          size: 'upload bytes'.length,
          sha256: createHash('sha256').update('upload bytes').digest('hex')
        }
      ],
      createdAt: 100,
      updatedAt: 100
    }
  ],
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'managed-file',
      path: artifactPath,
      name: 'result.txt'
    }
  ],
  filesRevision: 1,
  createdAt: 100,
  updatedAt: 200
})

const writeManagedFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

const relativeStorageKey = (root: string, path: string): string =>
  path
    .slice(root.length + 1)
    .split('/')
    .join('/')
