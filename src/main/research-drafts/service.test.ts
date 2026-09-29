import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { ResearchDraftPayload, SaveResearchDraftRequest } from '../../shared/research-draft'
import type { UploadedAttachment } from '../../shared/uploads'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ResearchDraftService } from './service'

const scope = { projectId: 'project', sourceSessionId: 'import-source' }
const payload = (text = 'Unsent question'): ResearchDraftPayload => ({
  doc: { nodes: [{ type: 'text', text }] },
  annotations: [],
  attachments: [],
  transfers: [],
  automaticReadingEnabled: true,
  editRevision: 1,
  intentId: 'send-intent'
})
const request = (overrides: Partial<SaveResearchDraftRequest> = {}): SaveResearchDraftRequest => ({
  ...scope,
  id: 'draft',
  editorId: 'window-1',
  expectedRevision: 0,
  payload: payload(),
  ...overrides
})
const staged: UploadedAttachment = {
  id: 'upload',
  sessionId: '.pending',
  name: 'input.csv',
  originalName: 'input.csv',
  path: '/staged/input.csv',
  size: 12
}

describe('durable research drafts', () => {
  let directory: string
  let client: PrismaClient
  let service: ResearchDraftService
  let preserve: ReturnType<
    typeof vi.fn<
      (
        projectId: string,
        ownerId: string,
        files: UploadedAttachment[]
      ) => Promise<UploadedAttachment[]>
    >
  >
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'research-drafts-'))
    client = createProjectDbClient(directory)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: scope.projectId, name: 'Project' } })
    preserve = vi.fn(async (_projectId, _ownerId, files) =>
      files.map((file) => ({
        ...file,
        versionId: file.versionId ?? `version-${file.id}`,
        path: '/managed/input.csv'
      }))
    )
    service = new ResearchDraftService(
      async () => client,
      preserve,
      async (operation) => operation()
    )
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('persists a normal local draft without creating any source or discussion Session', async () => {
    const saved = await service.save(request())
    expect(saved).toMatchObject({
      status: 'saved',
      draft: { ...scope, revision: 1, payload: payload() }
    })
    const restarted = new ResearchDraftService(
      async () => client,
      preserve,
      async (operation) => operation()
    )
    expect(await restarted.list(scope)).toHaveLength(1)
    expect(await client.session.count()).toBe(0)
    expect(await client.researchWorkspace.count()).toBe(0)
  })
  it('finalizes attachments before acknowledging storage and retries the exact request idempotently', async () => {
    const first = request({ payload: { ...payload(), attachments: [staged] } })
    const saved = await service.save(first)
    expect(saved).toMatchObject({
      status: 'saved',
      draft: { payload: { attachments: [{ versionId: 'version-upload' }] } }
    })
    expect(preserve).toHaveBeenCalledWith(scope.projectId, 'research-draft-draft', [staged])
    expect(await service.save(first)).toEqual(saved)
    expect(preserve).toHaveBeenCalledTimes(1)
    preserve.mockResolvedValueOnce([staged])
    await expect(
      service.save(
        request({ id: 'bad-attachment', payload: { ...payload(), attachments: [staged] } })
      )
    ).rejects.toThrow('could not be preserved')
    expect(await client.researchDraft.findUnique({ where: { id: 'bad-attachment' } })).toBeNull()
  })
  it('isolates windows and rejects stale edits after explicit recovery claims', async () => {
    await service.save(request())
    await service.save(request({ id: 'draft-2', editorId: 'window-2' }))
    expect(await service.list(scope)).toHaveLength(2)
    const claimed = await service.act({
      ...scope,
      id: 'draft',
      editorId: 'window-3',
      expectedRevision: 1,
      action: 'claim'
    })
    expect(claimed).toMatchObject({ status: 'saved', draft: { revision: 2, editorId: 'window-3' } })
    expect(
      await service.save(request({ expectedRevision: 1, payload: payload('stale') }))
    ).toMatchObject({ status: 'conflict' })
    expect(
      await service.save(
        request({ editorId: 'window-3', expectedRevision: 2, payload: payload('recovered') })
      )
    ).toMatchObject({ status: 'saved', draft: { revision: 3 } })
  })
  it('discards with CAS and never resurrects an acknowledged old draft', async () => {
    await service.save(request())
    expect(
      await service.act({
        ...scope,
        id: 'draft',
        editorId: 'window-2',
        expectedRevision: 1,
        action: 'discard'
      })
    ).toMatchObject({ status: 'conflict' })
    expect(
      await service.act({
        ...scope,
        id: 'draft',
        editorId: 'window-1',
        expectedRevision: 1,
        action: 'discard'
      })
    ).toMatchObject({ status: 'saved' })
    expect(await service.list(scope)).toEqual([])
    expect(await service.save(request())).toMatchObject({
      status: 'conflict',
      draft: { state: 'discarded' }
    })
  })
  it('retains missing-source drafts until Project deletion and gates late writes after deletion', async () => {
    await service.save(request())
    await client.project.update({
      where: { id: scope.projectId },
      data: { archivedAt: new Date() }
    })
    expect(await service.list(scope)).toHaveLength(1)
    await client.project.update({ where: { id: scope.projectId }, data: { deletedAt: new Date() } })
    expect(await service.list(scope)).toEqual([])
    await expect(service.save(request({ expectedRevision: 1 }))).rejects.toThrow('unavailable')
    await client.project.delete({ where: { id: scope.projectId } })
    expect(await client.researchDraft.count()).toBe(0)
  })
  it('does not recover an admitted send after a crash and preserves a newer unsent revision', async () => {
    await service.save(request())
    await client.researchSubmission.create({
      data: {
        id: 'send-intent',
        ...scope,
        messageId: 'message',
        requestHash: 'hash',
        payloadJson: '{}',
        state: 'queued'
      }
    })
    const restarted = new ResearchDraftService(
      async () => client,
      preserve,
      async (operation) => operation()
    )
    expect(await restarted.list(scope)).toEqual([])
    expect(
      await restarted.act({
        ...scope,
        id: 'draft',
        editorId: 'restarted-window',
        expectedRevision: 1,
        action: 'claim'
      })
    ).toMatchObject({ status: 'conflict' })
    await service.save(
      request({
        expectedRevision: 1,
        payload: { ...payload('newer unsent question'), intentId: 'new-intent', editRevision: 2 }
      })
    )
    expect(await restarted.list(scope)).toMatchObject([{ payload: { intentId: 'new-intent' } }])
    expect(await client.researchSubmission.count()).toBe(1)
  })
  it('releases exclusively owned attachments only after a successful discard CAS', async () => {
    const release = vi.fn(async () => undefined)
    const gated = new ResearchDraftService(
      async () => client,
      preserve,
      async (operation) => operation(),
      async (_projectId, operation) => operation(),
      release
    )
    const saved = await gated.save(request({ payload: { ...payload(), attachments: [staged] } }))
    expect(saved.status).toBe('saved')
    await gated.act({
      ...scope,
      id: 'draft',
      editorId: 'window-1',
      expectedRevision: 1,
      action: 'discard',
      releaseAttachments: true
    })
    expect(release).toHaveBeenCalledWith(scope.projectId, 'draft', [
      expect.objectContaining({ versionId: 'version-upload' })
    ])
    await gated.act({
      ...scope,
      id: 'draft',
      editorId: 'window-1',
      expectedRevision: 1,
      action: 'discard',
      releaseAttachments: true
    })
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('checks data-root admission before finalizing or saving attachments', async () => {
    const gated = new ResearchDraftService(
      async () => client,
      preserve,
      async () => {
        throw new Error('Data root changing')
      }
    )
    await expect(gated.save(request())).rejects.toThrow('Data root changing')
    expect(preserve).not.toHaveBeenCalled()
    expect(await client.researchDraft.count()).toBe(0)
  })
})
