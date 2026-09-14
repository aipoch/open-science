import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProjectDbClient, migrateApplicationDatabase } from './projects/prisma-client'
import { PendingInputOwner } from './pending-input-owner'
import { pendingInputCommandContract, type PendingInputContent } from '../shared/pending-input'
import { toRuntimeUploadedAttachment, type UploadedAttachment } from '../shared/uploads'
import type { ApplicationCallerLease } from './application-command-router'

const content = (id = 'message-1'): PendingInputContent => ({
  schemaVersion: 1,
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  text: 'Keep this input',
  forcedSkillIds: [],
  permissionProfile: 'ask',
  snapshot: {
    draftKey: 'session-1',
    version: 1,
    doc: { nodes: [{ type: 'text', text: 'Keep this input' }] },
    annotations: [],
    attachments: []
  }
})
const caller = (): { lease: ApplicationCallerLease; abort: () => void } => {
  const controller = new AbortController()
  return {
    lease: {
      leaseId: crypto.randomUUID(),
      generation: 1,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted
    },
    abort: () => controller.abort()
  }
}
let root: string
let client: PrismaClient
let owner: PendingInputOwner
const changed = vi.fn()
const validate = vi.fn(async () => {})
const publishAttachments = vi.fn(
  async (input: PendingInputContent): Promise<UploadedAttachment[]> => input.snapshot.attachments
)
const makeOwner = (): PendingInputOwner =>
  new PendingInputOwner({
    withWrite: (operation) => operation(),
    getClient: async () => client,
    withSessionMutation: async (_project, _session, operation) => operation(),
    validateSession: validate,
    publishAttachments,
    changed
  })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pending-input-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project-1', name: 'Test' } })
  changed.mockClear()
  publishAttachments.mockReset().mockImplementation(async (input) => input.snapshot.attachments)
  validate.mockReset().mockResolvedValue()
  owner = makeOwner()
})
afterEach(async () => {
  await owner.dispose()
  await client.$disconnect()
  await rm(root, { recursive: true, force: true })
})

it('preserves input across owner restart and requires explicit resume', async () => {
  const { lease } = caller()
  await owner.execute({ operation: 'enqueue', content: content() }, lease)
  await owner.dispose()
  owner = makeOwner()
  const recovered = (await owner.execute({ operation: 'list' }, lease)).items[0]
  expect(recovered.phase).toBe('recovery-required')
  expect(recovered.snapshot.doc).toEqual(content().snapshot.doc)
  await expect(
    owner.execute(
      {
        operation: 'claim',
        claimId: crypto.randomUUID(),
        id: recovered.id,
        revision: recovered.revision
      },
      lease
    )
  ).rejects.toThrow('Review')
  const resumed = await owner.execute(
    { operation: 'resume', id: recovered.id, revision: recovered.revision },
    lease
  )
  expect(resumed.item?.phase).toBe('queued')
})

it('allows only one client to claim a message and rejects stale edits and foreign settlements', async () => {
  const first = caller(),
    second = caller()
  const enqueued = await owner.execute({ operation: 'enqueue', content: content() }, first.lease)
  const requests = await Promise.allSettled(
    [first, second].map(({ lease }) =>
      owner.execute(
        {
          operation: 'claim',
          claimId: crypto.randomUUID(),
          id: enqueued.item!.id,
          revision: enqueued.item!.revision
        },
        lease
      )
    )
  )
  expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const claimed = (await owner.execute({ operation: 'list' }, first.lease)).items[0]
  await expect(
    owner.execute(
      { operation: 'remove', id: claimed.id, revision: enqueued.item!.revision },
      second.lease
    )
  ).rejects.toThrow('changed')
  await expect(
    owner.execute(
      { operation: 'settle', id: claimed.id, revision: claimed.revision, outcome: 'sent' },
      second.lease
    )
  ).rejects.toThrow('owned')
  first.abort()
  await vi.waitFor(async () =>
    expect((await owner.execute({ operation: 'list' }, second.lease)).items[0].phase).toBe(
      'recovery-required'
    )
  )
})

it('keeps a live claim on subscription reads and removes it only after the dispatch receipt', async () => {
  const { lease } = caller()
  const enqueued = await owner.execute({ operation: 'enqueue', content: content() }, lease)
  const claimed = await owner.execute(
    {
      operation: 'claim',
      claimId: crypto.randomUUID(),
      id: enqueued.item!.id,
      revision: enqueued.item!.revision
    },
    lease
  )
  expect((await owner.execute({ operation: 'list' }, lease)).items[0].phase).toBe('sending')
  const result = await owner.execute(
    {
      operation: 'settle',
      id: claimed.item!.id,
      revision: claimed.item!.revision,
      outcome: 'sent'
    },
    lease
  )
  expect(result.items).toEqual([])
})

it('does not save input when publication or branch validation fails', async () => {
  const { lease } = caller()
  validate.mockRejectedValueOnce(new Error('branch changed'))
  await expect(owner.execute({ operation: 'enqueue', content: content() }, lease)).rejects.toThrow(
    'branch changed'
  )
  expect((await owner.execute({ operation: 'list' }, lease)).items).toEqual([])
})

it('reorders with revision checks and cleans only the deleted Session', async () => {
  const { lease } = caller()
  const first = await owner.execute({ operation: 'enqueue', content: content() }, lease)
  await owner.execute({ operation: 'enqueue', content: content('message-2') }, lease)
  const moved = await owner.execute(
    {
      operation: 'move',
      id: first.item!.id,
      revision: first.item!.revision,
      targetId: 'message-2',
      edge: 'after'
    },
    lease
  )
  expect(moved.items.map((item) => item.id)).toEqual(['message-2', 'message-1'])
  await owner.deleteSession('project-1', 'session-1')
  expect((await owner.execute({ operation: 'list' }, lease)).items).toEqual([])
})

it('does not strand a claim when its caller disconnects during validation', async () => {
  const first = caller(),
    reader = caller()
  const enqueued = await owner.execute({ operation: 'enqueue', content: content() }, first.lease)
  validate.mockImplementationOnce(async () => first.abort())
  await expect(
    owner.execute(
      {
        operation: 'claim',
        claimId: crypto.randomUUID(),
        id: enqueued.item!.id,
        revision: enqueued.item!.revision
      },
      first.lease
    )
  ).rejects.toThrow('unavailable')
  expect((await owner.execute({ operation: 'list' }, reader.lease)).items[0].phase).toBe('queued')
})

it('keeps the dispatch revision valid when another item is reordered', async () => {
  const { lease } = caller()
  const first = await owner.execute({ operation: 'enqueue', content: content() }, lease)
  const second = await owner.execute({ operation: 'enqueue', content: content('message-2') }, lease)
  const claimed = await owner.execute(
    {
      operation: 'claim',
      claimId: crypto.randomUUID(),
      id: first.item!.id,
      revision: first.item!.revision
    },
    lease
  )
  await owner.execute(
    {
      operation: 'move',
      id: second.item!.id,
      revision: second.item!.revision,
      targetId: first.item!.id,
      edge: 'before'
    },
    lease
  )
  const result = await owner.execute(
    { operation: 'settle', id: first.item!.id, revision: claimed.item!.revision, outcome: 'sent' },
    lease
  )
  expect(result.items.map((item) => item.id)).toEqual(['message-2'])
})

it('reserves editing without removing durable input and rejects a stale replacement', async () => {
  const first = caller(),
    second = caller()
  const enqueued = await owner.execute({ operation: 'enqueue', content: content() }, first.lease)
  const editing = await owner.execute(
    { operation: 'edit', id: enqueued.item!.id, revision: enqueued.item!.revision },
    first.lease
  )
  expect(editing.item?.phase).toBe('recovery-required')
  await expect(
    owner.execute(
      {
        operation: 'claim',
        claimId: crypto.randomUUID(),
        id: enqueued.item!.id,
        revision: enqueued.item!.revision
      },
      second.lease
    )
  ).rejects.toThrow('changed')
  const replaced = await owner.execute(
    {
      operation: 'enqueue',
      content: { ...content(), text: 'Revised input' },
      expectedRevision: editing.item!.revision
    },
    first.lease
  )
  await expect(
    owner.execute(
      { operation: 'enqueue', content: content(), expectedRevision: editing.item!.revision },
      second.lease
    )
  ).rejects.toThrow('changed')
  expect(replaced.items).toHaveLength(1)
  expect(replaced.item?.text).toBe('Revised input')
})

it('keeps committed input when a subscriber throws and removes soft-deleted project input', async () => {
  const { lease } = caller()
  changed.mockImplementationOnce(() => {
    throw new Error('dead renderer')
  })
  await expect(
    owner.execute({ operation: 'enqueue', content: content() }, lease)
  ).resolves.toMatchObject({ item: { id: 'message-1' } })
  await client.project.update({ where: { id: 'project-1' }, data: { deletedAt: new Date() } })
  await owner.deleteProject('project-1')
  expect((await owner.execute({ operation: 'list' }, lease)).items).toEqual([])
})

it('pauses automatic dispatch after changed Session validation', async () => {
  const { lease } = caller()
  const enqueued = await owner.execute({ operation: 'enqueue', content: content() }, lease)
  validate.mockRejectedValueOnce(new Error('branch changed'))
  await expect(
    owner.execute(
      { operation: 'claim', claimId: 'claim-1', id: enqueued.item!.id, revision: 1 },
      lease
    )
  ).rejects.toThrow('branch changed')
  expect((await owner.execute({ operation: 'list' }, lease)).items[0].phase).toBe(
    'recovery-required'
  )
})

it('atomically prioritizes an explicitly resumed item and rejects a different claim identity', async () => {
  const { lease } = caller()
  await owner.execute({ operation: 'enqueue', content: content() }, lease)
  await owner.execute({ operation: 'enqueue', content: content('message-2') }, lease)
  const claimed = await owner.execute(
    { operation: 'claim', claimId: 'claim-2', id: 'message-2', revision: 1, prioritize: true },
    lease
  )
  expect(claimed.items[0].id).toBe('message-2')
  await expect(
    owner.execute(
      {
        operation: 'settle',
        claimId: 'claim-1',
        id: 'message-2',
        revision: claimed.item!.revision,
        outcome: 'uncertain'
      },
      lease
    )
  ).rejects.toThrow('owned')
  const settled = await owner.execute(
    { operation: 'settle', id: 'message-2', revision: claimed.item!.revision, outcome: 'deferred' },
    lease
  )
  expect(settled.items[0].id).toBe('message-2')
})

it('rejects replacement across Session ownership before publishing attachments', async () => {
  const { lease } = caller()
  await owner.execute({ operation: 'enqueue', content: content() }, lease)
  await expect(
    owner.execute(
      {
        operation: 'enqueue',
        content: { ...content(), sessionId: 'other-session' },
        expectedRevision: 1
      },
      lease
    )
  ).rejects.toThrow('another Session')
  expect((await owner.execute({ operation: 'list' }, lease)).items[0].sessionId).toBe('session-1')
})

it('cleans explicit deletion tombstones on restart without relying on projection existence', async () => {
  const { lease } = caller()
  await owner.execute({ operation: 'enqueue', content: content() }, lease)
  await client.$executeRaw`INSERT INTO "Session" ("id", "number", "projectId", "title", "status", "presentedStatus", "createdAtMs", "updatedAtMs", "deletedAtMs") VALUES ('session-1', 1, 'project-1', 'Deleted', 'idle', 'idle', 1, 1, 2)`
  await owner.dispose()
  owner = makeOwner()
  expect((await owner.execute({ operation: 'list' }, lease)).items).toEqual([])
})

it.each(['/private/data/uploads/attachment.txt', 'C:\\data\\uploads\\attachment.txt'])(
  'persists and publishes attachment identity without the runtime path %s',
  async (path) => {
    const attachment: UploadedAttachment = {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: 'session-1',
      name: 'attachment.txt',
      originalName: 'attachment.txt',
      size: 5,
      path,
      checksum: 'sha256-test',
      draftReceipt: 'runtime-only'
    }
    publishAttachments.mockResolvedValueOnce([attachment])
    const submitted = { ...attachment }
    delete submitted.draftReceipt
    const { lease } = caller()
    const result = await owner.execute(
      {
        operation: 'enqueue',
        content: {
          ...content(),
          snapshot: { ...content().snapshot, attachments: [submitted] }
        }
      },
      lease
    )
    const expected = {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: 'session-1',
      name: 'attachment.txt',
      originalName: 'attachment.txt',
      size: 5,
      sha256: 'sha256-test'
    }
    expect(result.item?.snapshot.attachments).toEqual([expected])
    expect(pendingInputCommandContract.result.parse(result)).toBe(result)
    expect(() =>
      pendingInputCommandContract.result.parse({
        ...result,
        items: [
          {
            ...result.items[0],
            snapshot: { ...result.items[0].snapshot, attachments: [{ ...expected, path }] }
          }
        ]
      })
    ).toThrow()
    expect(() =>
      pendingInputCommandContract.result.parse({
        ...result,
        items: [
          {
            ...result.items[0],
            snapshot: {
              ...result.items[0].snapshot,
              attachments: [{ ...expected, versionId: undefined }]
            }
          }
        ]
      })
    ).toThrow()
    expect(changed.mock.lastCall?.[0].items[0].snapshot.attachments).toEqual([expected])
    const rows = await client.$queryRaw<
      Array<{ content: string }>
    >`SELECT "content" FROM "PendingInput"`
    expect(JSON.parse(rows[0].content).snapshot.attachments).toEqual([expected])
    await owner.dispose()
    owner = makeOwner()
    const recovered = await owner.execute({ operation: 'list' }, lease)
    expect(recovered.items[0].snapshot.attachments).toEqual([expected])
    expect(recovered.items[0].phase).toBe('recovery-required')
  }
)

it('replaces an edited input using its durable version reference without persisting runtime fields', async () => {
  const { lease } = caller()
  const input = content()
  input.snapshot.attachments = [
    {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: input.sessionId,
      name: 'notes.txt',
      originalName: 'notes.txt',
      size: 5,
      path: '/private/data/notes.txt',
      checksum: 'sha256-test'
    }
  ]
  const admitted = await owner.execute({ operation: 'enqueue', content: input }, lease)
  const editing = await owner.execute(
    { operation: 'edit', id: input.id, revision: admitted.item!.revision },
    lease
  )
  const saved = editing.item!
  const replacement: PendingInputContent = {
    ...input,
    text: 'Revised input',
    snapshot: {
      ...input.snapshot,
      attachments: saved.snapshot.attachments.map((file) =>
        toRuntimeUploadedAttachment(file, saved.projectId)
      )
    }
  }
  expect(replacement.snapshot.attachments[0].path).toBe(
    'upload-version:project-1/session-1/upload-1/version-1'
  )
  const replaced = await owner.execute(
    { operation: 'enqueue', content: replacement, expectedRevision: saved.revision },
    lease
  )
  expect(replaced.item?.text).toBe('Revised input')
  expect(replaced.item?.snapshot.attachments).toEqual(saved.snapshot.attachments)
  expect(replaced.item?.revision).toBe(saved.revision + 1)
  const rows = await client.$queryRaw<
    Array<{ content: string }>
  >`SELECT "content" FROM "PendingInput"`
  expect(JSON.parse(rows[0].content).snapshot.attachments).toEqual(saved.snapshot.attachments)
})

it.each(['/obsolete/data/notes.txt', 'Z:\\obsolete\\notes.txt'])(
  'reads an earlier queue record through version identity instead of its obsolete path %s',
  async (path) => {
    const { lease } = caller()
    const legacy = content()
    legacy.snapshot.attachments = [
      {
        id: 'upload-1',
        versionId: 'version-1',
        versionNumber: 1,
        sessionId: legacy.sessionId,
        name: 'notes.txt',
        originalName: 'notes.txt',
        size: 5,
        path,
        checksum: 'sha256-test'
      }
    ]
    await client.$executeRaw`INSERT INTO "PendingInput" ("id", "projectId", "sessionId", "position", "revision", "phase", "content") VALUES (${legacy.id}, ${legacy.projectId}, ${legacy.sessionId}, 1, 1, 'queued', ${JSON.stringify(legacy)})`
    const recovered = (await owner.execute({ operation: 'list' }, lease)).items[0]
    expect(recovered).toMatchObject({
      id: legacy.id,
      text: legacy.text,
      phase: 'recovery-required',
      revision: 2
    })
    expect(recovered.snapshot.attachments).toEqual([
      {
        id: 'upload-1',
        versionId: 'version-1',
        versionNumber: 1,
        sessionId: legacy.sessionId,
        name: 'notes.txt',
        originalName: 'notes.txt',
        size: 5,
        sha256: 'sha256-test'
      }
    ])
    expect(publishAttachments).not.toHaveBeenCalled()
    const resumed = await owner.execute(
      { operation: 'resume', id: recovered.id, revision: recovered.revision },
      lease
    )
    expect(resumed.item?.snapshot.attachments).toEqual(recovered.snapshot.attachments)
    expect(changed.mock.lastCall?.[0].items[0].snapshot.attachments).toEqual(
      recovered.snapshot.attachments
    )
    const editing = await owner.execute(
      { operation: 'edit', id: recovered.id, revision: resumed.item!.revision },
      lease
    )
    await owner.execute(
      {
        operation: 'enqueue',
        expectedRevision: editing.item!.revision,
        content: {
          ...legacy,
          snapshot: {
            ...legacy.snapshot,
            attachments: recovered.snapshot.attachments.map((file) =>
              toRuntimeUploadedAttachment(file, legacy.projectId)
            )
          }
        }
      },
      lease
    )
    const rows = await client.$queryRaw<
      Array<{ content: string }>
    >`SELECT "content" FROM "PendingInput"`
    expect(JSON.parse(rows[0].content).snapshot.attachments).toEqual(recovered.snapshot.attachments)
  }
)

it('does not recover an earlier attachment through a path when version identity is missing', async () => {
  const legacy = content()
  legacy.snapshot.attachments = [
    {
      id: 'upload-1',
      sessionId: legacy.sessionId,
      name: 'notes.txt',
      originalName: 'notes.txt',
      size: 5,
      path: '/obsolete/data/notes.txt'
    }
  ]
  await client.$executeRaw`INSERT INTO "PendingInput" ("id", "projectId", "sessionId", "position", "revision", "phase", "content") VALUES (${legacy.id}, ${legacy.projectId}, ${legacy.sessionId}, 1, 1, 'queued', ${JSON.stringify(legacy)})`
  await expect(owner.execute({ operation: 'list' }, caller().lease)).rejects.toThrow()
  expect(publishAttachments).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  const rows = await client.$queryRaw<
    Array<{ content: string }>
  >`SELECT "content" FROM "PendingInput"`
  expect(JSON.parse(rows[0].content)).toEqual(legacy)
})
