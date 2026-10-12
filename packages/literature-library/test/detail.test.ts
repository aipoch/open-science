import { createLiteratureDetailController } from '@aipoch/literature-library/client'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { describe, expect, it, vi } from 'vitest'

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
    try {
      const controller = createLiteratureDetailController(get)
      const pending = controller.read(older.id)
      expect(await controller.read(older.id)).toEqual(newer)
      finish(older)
      expect(await pending).toEqual(newer)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
