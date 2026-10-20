import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { capturePackageLiterature, validatePackageLiterature } from './literature'
import type { PackageLiteratureSource, PackageLiteratureVersion } from './literature-source'
import { COLUMNS, type NativeRow, type PackageRecords } from './records-contract'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Paper',
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: []
}
const records = (): PackageRecords => ({
  schemaVersion: 1,
  tables: Object.fromEntries(
    Object.keys(COLUMNS).map((key) => [key, [] as NativeRow[]])
  ) as PackageRecords['tables']
})
const version: PackageLiteratureVersion = {
  id: 'version-1',
  attachmentId: 'attachment-1',
  itemId: 'item-1',
  versionNumber: 1,
  filename: 'paper.pdf',
  contentType: 'application/pdf',
  sizeBytes: 5n,
  checksum: 'a'.repeat(64),
  storageKey: 'content/paper',
  createdAt: new Date(1)
}
const metadata = {
  itemId: 'item-1',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' })
}
const source = (): PackageLiteratureSource => ({
  readVersions: vi.fn(async () => [version]),
  readItem: vi.fn(async () => metadata)
})

describe('session package literature source', () => {
  it('captures a snapshot through the read-only port and retains it without the live source', async () => {
    const port = source()
    const snapshot = records()
    const files = await capturePackageLiterature(port, session, snapshot, [version.id])
    expect(port.readVersions).toHaveBeenCalledWith([version.id])
    expect(port.readItem).toHaveBeenCalledWith(version.itemId)
    expect([...files]).toEqual([
      ['uploads/project-1/session-1/attachment-1/versions/version-1/content', 'content/paper']
    ])
    expect(snapshot.literature).toEqual({
      items: [metadata],
      attachments: [
        { versionId: version.id, attachmentId: version.attachmentId, itemId: version.itemId }
      ]
    })
    expect(() => validatePackageLiterature(snapshot)).not.toThrow()
    const archived = structuredClone(snapshot)
    await expect(
      capturePackageLiterature(undefined, session, snapshot, [version.id])
    ).resolves.toEqual(new Map())
    expect(snapshot).toEqual(archived)
  })

  it('supports ordinary sessions without a literature source', async () => {
    const snapshot = records()
    await expect(capturePackageLiterature(undefined, session, snapshot)).resolves.toEqual(new Map())
    expect(snapshot).toEqual(records())
  })

  it('fails closed before writing records when live references have no source', async () => {
    const snapshot = records()
    await expect(
      capturePackageLiterature(undefined, session, snapshot, [version.id])
    ).rejects.toThrow('Literature source is unavailable')
    expect(snapshot).toEqual(records())
  })

  it.each([
    { ids: ['version-1'], rows: [] },
    { ids: ['version-1'], rows: [{ ...version, id: 'wrong-version' }] },
    { ids: ['version-1', 'version-2'], rows: [version, version] }
  ])('rejects incomplete or substituted version identities: $ids', async ({ ids, rows }) => {
    const port = source()
    port.readVersions = async () => rows
    const snapshot = records()
    await expect(capturePackageLiterature(port, session, snapshot, ids)).rejects.toThrow(
      'Literature PDF Version is unavailable'
    )
    expect(snapshot).toEqual(records())
    expect(port.readItem).not.toHaveBeenCalled()
  })

  it.each([undefined, { ...metadata, itemId: 'wrong-item' }])(
    'rejects missing or substituted item metadata',
    async (item) => {
      const port = source()
      port.readItem = async () => item
      await expect(
        capturePackageLiterature(port, session, records(), [version.id])
      ).rejects.toThrow('Literature metadata is unavailable')
    }
  )

  it('propagates source failures without exporting an incomplete snapshot', async () => {
    const port = source()
    port.readVersions = async () => {
      throw new Error('source offline')
    }
    const snapshot = records()
    await expect(capturePackageLiterature(port, session, snapshot, [version.id])).rejects.toThrow(
      'source offline'
    )
    expect(snapshot).toEqual(records())
  })
})
