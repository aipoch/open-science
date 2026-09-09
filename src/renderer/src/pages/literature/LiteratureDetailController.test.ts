import { describe, expect, it, vi } from 'vitest'
import type { LiteratureItemView } from '../../../../shared/literature'
import { createLiteratureDetailController } from './LiteratureDetailController'

describe('Literature detail reads', () => {
  it('does not return an older relationship snapshot after a newer read has completed', async () => {
    const older = {
      id: 'item',
      metadataRevision: 1,
      collectionIds: []
    } as unknown as LiteratureItemView
    const newer = { ...older, collectionIds: ['collection'] }
    let finish!: (item: LiteratureItemView) => void
    const get = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(newer)
    vi.stubGlobal('window', { api: { literature: { get } } })
    try {
      const controller = createLiteratureDetailController()
      const pending = controller.read(older.id)
      expect(await controller.read(older.id)).toEqual(newer)
      finish(older)
      expect(await pending).toEqual(newer)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
