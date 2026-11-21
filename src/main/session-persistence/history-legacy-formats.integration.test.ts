import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createSessionFile,
  normalizeSessionFile,
  SESSION_FILE_VERSION,
  type PersistedChatSession
} from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'

let root: string
let client: PrismaClient
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
const reopen = (): SessionRepository =>
  new SessionRepository(root, {}, new SessionProjectionRepository(async () => client))
const setup = async (): Promise<SessionRepository> => {
  root = await mkdtemp(join(tmpdir(), 'session-history-legacy-formats-'))
  initDataRoot(root)
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  await mkdir(join(root, 'sessions', 'project'), { recursive: true })
  return reopen()
}
const request = { projectId: 'project', sessionId: 'session' }
const logicalPath = (): string => join(root, 'sessions', 'project', 'session.json')
const fixture = (): PersistedChatSession => ({
  id: 'session',
  projectId: 'project',
  title: 'Historical evidence',
  cwd: '',
  revision: 12,
  status: 'idle',
  createdAt: 1,
  updatedAt: 4,
  messages: [
    {
      id: 'prompt',
      role: 'user',
      content: 'Compare α and β',
      status: 'complete',
      eventIds: ['prompt-event'],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      responseToMessageId: 'prompt',
      content: 'Evidence:\nα < β',
      status: 'complete',
      eventIds: ['answer-event'],
      createdAt: 4,
      updatedAt: 4
    }
  ],
  activities: [
    {
      id: 'tool',
      kind: 'tool',
      title: 'Read evidence',
      status: 'completed',
      promptMessageId: 'prompt',
      activityGroupId: 'group',
      sortIndex: 0,
      eventIds: ['tool-event'],
      rawInput: { query: 'α β' },
      rawOutput: { values: [1, 2], text: 'Original evidence' },
      createdAt: 2,
      updatedAt: 3
    }
  ],
  activityGroups: [
    {
      id: 'group',
      title: 'Evidence gathering',
      sortIndex: 0,
      activityIds: ['tool'],
      promptMessageId: 'prompt',
      createdAt: 2,
      updatedAt: 3,
      completedAt: 3
    }
  ]
})

it.each([
  { format: 'bare', revision: 12 },
  { format: 'v1', revision: 12 },
  { format: 'bare', revision: null },
  { format: 'v1', revision: null },
  { format: 'v2', revision: null }
])(
  'opens $format revision $revision read-only and keeps all content in JSON on save',
  async ({ format, revision }) => {
    const repository = await setup()
    const session = { ...fixture(), revision }
    const legacy = format === 'bare' ? session : { version: format === 'v1' ? 1 : 2, session }
    const raw = JSON.stringify(legacy, null, 2) + '\n'
    await writeFile(logicalPath(), raw)
    const expected = normalizeSessionFile(legacy)!
    expect(expected.revision).toBe(revision ?? 0)

    const page = (await repository.loadSessionHistoryPage({ ...request, limit: 1 }))!
    expect(page).toEqual({
      ...request,
      revision: expected.revision,
      complete: true,
      session: expected,
      hasMore: false,
      totalItems: 3
    })
    expect((await reopen().loadSessionHistoryPage(request))!.session).toEqual(expected)
    expect(await client.sessionHistoryIndex.count()).toBe(0)
    expect(await client.sessionHistoryItem.count()).toBe(0)
    expect(await readFile(logicalPath(), 'utf8')).toBe(raw)
    expect(await readdir(join(root, 'sessions', 'project'))).toEqual(['session.json'])

    const saved = await repository.saveSession(
      { ...expected, title: 'Continued research' },
      expected.revision
    )
    expect(saved.revision).toBe((revision ?? 0) + 1)
    expect(normalizeSessionFile(JSON.parse(await readFile(logicalPath(), 'utf8')))).toEqual(
      normalizeSessionFile(createSessionFile(saved))
    )
    expect(await readdir(join(root, 'sessions', 'project'))).toEqual(['session.json'])
    const cold = await reopen().loadSession(request.projectId, request.sessionId)
    expect(cold).toEqual(normalizeSessionFile(createSessionFile(saved)))
    // Saving historical flat activities materializes them into the canonical graph.
    const canonicalBeforeSave = normalizeSessionFile(createSessionFile(expected))!
    expect(cold).toMatchObject({
      messages: expected.messages,
      activities: expected.activities,
      activityGroups: expected.activityGroups,
      conversationGraph: canonicalBeforeSave.conversationGraph
    })
    expect(await reopen().loadSessionHistoryPage(request)).toMatchObject({
      complete: true,
      hasMore: false,
      session: cold
    })
    expect(await client.sessionHistoryIndex.count()).toBe(0)
    expect(await client.sessionHistoryItem.count()).toBe(0)
  }
)

it('refuses to overwrite an unsupported future envelope through the compatibility path', async () => {
  const repository = await setup()
  const raw = JSON.stringify({ version: SESSION_FILE_VERSION + 1, session: fixture() }, null, 2)
  await writeFile(logicalPath(), raw)
  expect(await repository.loadSessionHistoryPage(request)).toBeUndefined()
  await expect(repository.loadSessionHistoryPage(request, true)).rejects.toMatchObject({
    code: 'session-file-unsupported-version'
  })
  expect(
    await repository.loadSessionWithDiagnostics(request.projectId, request.sessionId, {
      mode: 'read-only'
    })
  ).toEqual({ status: 'unreadable' })
  await expect(repository.saveSession(fixture(), 12)).rejects.toThrow('unreadable')
  expect(await readFile(logicalPath(), 'utf8')).toBe(raw)
  expect(await readdir(join(root, 'sessions', 'project'))).toEqual(['session.json'])
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
})

it('distinguishes a missing file from a quarantined conversation on reopen', async () => {
  const repository = await setup()
  await expect(repository.loadSessionHistoryPage(request, true)).rejects.toMatchObject({
    code: 'session-file-missing'
  })
  await writeFile(logicalPath(), '{')
  await expect(repository.loadSessionHistoryPage(request, true)).rejects.toMatchObject({
    code: 'session-file-corrupt'
  })
  await expect(reopen().loadSessionHistoryPage(request, true)).rejects.toMatchObject({
    code: 'session-file-corrupt'
  })
})
